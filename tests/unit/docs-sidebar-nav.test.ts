/**
 * DOCS-COMPLETENESS-AND-NAVIGATION-W1 CH3 — the sidebar holds position, and tracks the reader.
 *
 * TWO INDEPENDENT DEFECTS, both measured on the published page:
 *
 *   1. `<aside class="… sticky top-20 self-start">` set `sticky` with NO `max-h` and NO
 *      `overflow-y`. With 20 `sidebar-link`s the aside is taller than the viewport, and a sticky
 *      element taller than its viewport cannot hold position — it scrolls away with the page. That
 *      is the entire "the sidebar doesn't follow me" symptom, and it is a two-class fix.
 *   2. `IntersectionObserver` appeared NOWHERE in `landing/`, `scripts/` or `src/`. There was no
 *      scrollspy at all, so no link was ever marked current — the "show me where I am now" half.
 *
 * The aside's classes are STATIC (they depend on nothing) and live in `docs-src/template.html`.
 * The scrollspy is GENERATED, because its observed id list must derive from the outline — that is
 * the whole reason a new section joins the spy for free instead of by someone remembering.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { sidebarEntries, allAnchorIds } from '../../src/lib/docs-outline.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const DOCS_HTML = read('landing/docs.html');

/** The scrollspy's own `<script>` body — the one carrying the observer. */
const spyScript = (): string => {
  const blocks = [...DOCS_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = blocks.find((b) => b.includes('IntersectionObserver'));
  expect(found, 'no inline script carrying IntersectionObserver').toBeTruthy();
  return found!;
};

describe('1 — the aside can actually hold position', () => {
  const asideTag = (DOCS_HTML.match(/<aside[^>]*>/) ?? [''])[0];

  it('carries BOTH a max-height and internal scrolling — either alone leaves sticky broken', () => {
    expect(asideTag).toMatch(/max-h-/);
    expect(asideTag).toMatch(/overflow-y-/);
  });

  it('still carries the sticky positioning the cap exists to make effective', () => {
    expect(asideTag).toContain('sticky');
  });

  it('the cap is viewport-relative, not a fixed pixel height', () => {
    // A fixed px cap is wrong on every viewport but one, and silently clips on short screens.
    expect(asideTag).toMatch(/max-h-\[[^\]]*vh[^\]]*\]/);
  });

  it('is emitted from the template, never hand-edited into the generated page', () => {
    expect(read('docs-src/template.html')).toMatch(/<aside[^>]*max-h-[^>]*overflow-y-/);
  });
});

const doc = (): Document => new JSDOM(DOCS_HTML).window.document;

describe('2 — the observed id set equals the rendered SIDEBAR LINK set, both directions', () => {
  const observed = (): string[] => {
    const m = /var IDS = (\[[^\]]*\]);/.exec(spyScript());
    expect(m, 'the emitted script carries no IDS array').toBeTruthy();
    return JSON.parse(m![1]);
  };

  // Compared against the LINKS the page actually rendered, not against the generator's own helper —
  // that would be tautological. It is also the correction this test forced: `sidebarEntries()`
  // includes GROUP nodes (`platform`, …) which render as a non-link `<div>` header, so the first
  // draft observed ids that could never be marked. The rendered link set is the real contract.
  const renderedLinks = (): string[] =>
    [...doc().querySelectorAll('aside a.sidebar-link')].map((a) => a.getAttribute('href')!.replace(/^#/, ''));

  it('observes every rendered sidebar link — a new section cannot be silently unobserved', () => {
    expect([...observed()].sort()).toEqual([...renderedLinks()].sort());
  });

  it('observes NOTHING the sidebar does not link — no unmarkable target', () => {
    for (const id of observed()) expect(renderedLinks()).toContain(id);
  });

  it('preserves render ORDER — `mark()` picks the first on-screen section, so order is semantic', () => {
    expect(observed()).toEqual(renderedLinks());
  });

  it('group headers are entries but NOT spy targets — they render as a div, not a link', () => {
    const groups = sidebarEntries().map((e) => e.anchor).filter((a) => !renderedLinks().includes(a));
    expect(groups.length, 'no group nodes found — this guard would be vacuous').toBeGreaterThan(0);
    for (const g of groups) expect(observed()).not.toContain(g);
  });

  // F6, as a standing guard rather than a one-off finding. `allAnchorIds()` also returns alias ids
  // and the four `sidebarHidden` nodes (tools-when-to-use / tools-worked-examples /
  // tools-rate-limits / tools-errors), none of which has a sidebar link. Observing them would give
  // the spy targets it can never mark, and would contradict the dead-target test below.
  it('is NOT sourced from allAnchorIds() — that set is strictly larger and half of it is unmarkable', () => {
    expect(allAnchorIds().length).toBeGreaterThan(sidebarEntries().length);
    const unlinkable = allAnchorIds().filter((a) => !sidebarEntries().some((e) => e.anchor === a));
    expect(unlinkable.length).toBeGreaterThan(0);
    for (const a of unlinkable) expect(observed()).not.toContain(a);
  });

  it('build_docs --check reads the id list through the SAME parser this test does', async () => {
    const { renderedScrollspyIds } = await import('../../scripts/build_docs.mjs');
    expect(renderedScrollspyIds(DOCS_HTML)).toEqual(observed());
  });
});

describe('3 — every spy target and every sidebar link resolves', () => {
  const d = doc();

  it('every sidebar-link href points at a real id in the body', () => {
    const dead: string[] = [];
    for (const a of d.querySelectorAll('aside a.sidebar-link')) {
      const id = (a.getAttribute('href') ?? '').replace(/^#/, '');
      if (!id || !d.getElementById(id)) dead.push(id || '(empty href)');
    }
    expect(dead).toEqual([]);
  });

  it('every observed id has BOTH a section and a link — an unmarkable target is a silent no-op', () => {
    const m = /var IDS = (\[[^\]]*\]);/.exec(spyScript())!;
    for (const id of JSON.parse(m[1]) as string[]) {
      expect(d.getElementById(id), `no section #${id}`).toBeTruthy();
      expect(d.querySelector(`aside a.sidebar-link[href="#${id}"]`), `no sidebar link for #${id}`).toBeTruthy();
    }
  });
});

describe('4 — feature-gated: a browser without IntersectionObserver is unaffected', () => {
  it('does not throw when the API is absent, and marks nothing', () => {
    // JSDOM does not implement IntersectionObserver, so this is the real absence case rather than a
    // simulation of one. A nav enhancement must never be able to break navigation.
    const dom = new JSDOM(DOCS_HTML, { runScripts: 'outside-only' });
    expect((dom.window as unknown as Record<string, unknown>).IntersectionObserver).toBeUndefined();
    expect(() => dom.window.eval(spyScript())).not.toThrow();
    expect(dom.window.document.querySelector('[aria-current]')).toBeNull();
    // and the links still navigate — the hrefs are untouched
    expect(dom.window.document.querySelectorAll('aside a.sidebar-link').length).toBeGreaterThan(0);
  });

  it('the guard is a real early return, not a try/catch swallowing a thrown error', () => {
    expect(spyScript()).toMatch(/typeof IntersectionObserver !== 'function'\)\s*return/);
  });
});

describe('5 — the active-marking path sets aria-current, not only a colour class', () => {
  /** Run the spy against a stub observer that reports exactly one section on screen. */
  const runWithVisible = (visibleId: string) => {
    const dom = new JSDOM(DOCS_HTML, { runScripts: 'outside-only' });
    const w = dom.window as unknown as Record<string, unknown>;
    w.IntersectionObserver = function (this: Record<string, unknown>, cb: (e: unknown[]) => void) {
      this.observe = (el: { id: string }) => cb([{ target: el, isIntersecting: el.id === visibleId }]);
      this.disconnect = () => {};
    };
    dom.window.eval(spyScript());
    return dom.window.document;
  };

  // A LINKED anchor, read off the page — sidebarEntries()[2] was a group header with no link.
  const target = () => doc().querySelectorAll('aside a.sidebar-link')[2].getAttribute('href')!.replace(/^#/, '');

  it('sets aria-current="true" on the link for the on-screen section', () => {
    const doc = runWithVisible(target());
    const link = doc.querySelector(`aside a.sidebar-link[href="#${target()}"]`)!;
    expect(link.getAttribute('aria-current')).toBe('true');
  });

  it('sets the colour class TOO — the visual echo, never instead of the accessible state', () => {
    const doc = runWithVisible(target());
    expect(doc.querySelector(`aside a.sidebar-link[href="#${target()}"]`)!.classList.contains('active')).toBe(true);
  });

  it('marks exactly ONE link current', () => {
    expect(runWithVisible(target()).querySelectorAll('[aria-current]').length).toBe(1);
  });

  it('marks nothing when no section is on screen', () => {
    expect(runWithVisible('__none__').querySelectorAll('[aria-current]').length).toBe(0);
  });
});
