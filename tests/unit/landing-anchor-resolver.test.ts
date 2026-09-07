// CONVERSION-SURFACES-W2 CH2 R0 — the hash-anchor resolver, and the invariant that produced it.
//
// THE DEFECT, measured 2026-09-07 on the live site and not inferred: every section id on `/`
// lives inside `.lp-rest-desktop`, which landing/_design/algovault-design.css sets to
// `display:none !important` below 768px. At 375px, https://algovault.com/#quickstart measured
// scrollY 0, offsetParent null and a 0x0 rect — a browser cannot scroll to an element that is
// not rendered. So the nav's Pricing link and the on-page "Start free" CTAs were dead on mobile,
// which is 156 of 193 /verify entrants.
//
// Two DIFFERENT things are asserted here, deliberately:
//   (1) STRUCTURE, over the committed artifact — every id inside the desktop artboard has a
//       data-anchor twin in BOTH artboards. This is the class-retiring guard: a future section
//       that adds an id and forgets the twin fails here rather than shipping dead on mobile.
//   (2) BEHAVIOUR, over the controller extracted FROM that same artifact — so the test cannot
//       pass against a controller that is not the one we ship.
//
// jsdom implements no layout, so `offsetParent` is undefined on every element and the
// resolver's own `visible()` would read EVERYTHING as visible — the test would then pass while
// asserting nothing. Visibility is therefore defined explicitly per element in each fixture.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const INDEX = readFileSync(join(process.cwd(), 'landing', 'index.html'), 'utf8');

/** The two dual-render artboards of the landing-rest block, as raw HTML. */
function artboards(): { desktop: string; mobile: string } {
  const d = INDEX.indexOf('<div class="lp-rest-desktop">');
  const m = INDEX.indexOf('<div class="lp-rest-mobile">');
  expect(d).toBeGreaterThan(-1);
  expect(m).toBeGreaterThan(d);
  return { desktop: INDEX.slice(d, m), mobile: INDEX.slice(m) };
}

const sectionOpenTags = (html: string): string[] => html.match(/<section\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

describe('landing hash anchors — every dual-rendered id has a data-anchor twin', () => {
  const { desktop, mobile } = artboards();

  it('every <section id> in lp-rest-desktop carries a matching data-anchor', () => {
    const offenders = sectionOpenTags(desktop)
      .filter((t) => attr(t, 'id') !== null)
      .filter((t) => attr(t, 'data-anchor') !== attr(t, 'id'))
      .map((t) => attr(t, 'id'));
    // when-to-use / vs-raw-exchange-apis come from v1-belowfold.jsx (BFSection), which is outside
    // this chapter's declared Scope, and nothing on the page links to either — recorded as a
    // named follow-up rather than silently exempted.
    expect(offenders).toEqual(['when-to-use', 'vs-raw-exchange-apis']);
  });

  it('every desktop data-anchor has a twin in the mobile artboard', () => {
    const names = (html: string) =>
      sectionOpenTags(html).map((t) => attr(t, 'data-anchor')).filter((v): v is string => !!v);
    const d = names(desktop);
    expect(d.length).toBeGreaterThanOrEqual(5);
    expect(names(mobile)).toEqual(d); // same set AND same order
  });

  it('the anchors the conversion band and the nav link to are among them', () => {
    for (const a of ['quickstart', 'pricing']) {
      expect((INDEX.match(new RegExp(`data-anchor="${a}"`, 'g')) ?? []).length).toBe(2);
    }
  });
});

/** Extract the shipped resolver IIFE from the committed page — never a copy typed here. */
function resolverSource(): string {
  const blocks = INDEX.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
  const hit = blocks.find((b) => b.includes('__avAnchorResolver'));
  expect(hit, 'the anchor-resolver controller must be present in landing/index.html').toBeTruthy();
  return (hit as string).replace(/^<script>/, '').replace(/<\/script>$/, '');
}

interface Harness { dom: JSDOM; calls: unknown[]; }

function mount(body: string, visibility: Record<string, boolean>): Harness {
  const dom = new JSDOM(`<!doctype html><html><body><nav></nav>${body}</body></html>`, {
    url: 'https://algovault.com/',
    runScripts: 'outside-only',
  });
  const w = dom.window as unknown as Record<string, any>;
  for (const [id, visible] of Object.entries(visibility)) {
    const el = dom.window.document.querySelector(`[data-fixture="${id}"]`);
    expect(el, `fixture ${id}`).toBeTruthy();
    Object.defineProperty(el as object, 'offsetParent', { get: () => (visible ? dom.window.document.body : null) });
    Object.defineProperty(el as object, 'getBoundingClientRect', { value: () => ({ top: 1000, height: visible ? 500 : 0 }) });
  }
  Object.defineProperty(dom.window.document.querySelector('nav') as object, 'offsetHeight', { get: () => 56 });
  const calls: unknown[] = [];
  w.scrollTo = (arg: unknown) => { calls.push(arg); };
  w.eval(resolverSource());
  return { dom, calls };
}

describe('landing hash anchors — the shipped resolver', () => {
  const twins = (name: string) =>
    `<section id="${name}" data-anchor="${name}" data-fixture="desk"></section>` +
    `<section data-anchor="${name}" data-fixture="mob"></section>`;

  it('scrolls to the VISIBLE twin when the natural target is display:none', () => {
    const h = mount(twins('quickstart'), { desk: false, mob: true });
    h.dom.window.location.hash = '#quickstart';
    h.dom.window.dispatchEvent(new h.dom.window.Event('hashchange'));
    expect(h.calls).toHaveLength(1);
    expect((h.calls[0] as { top: number }).top).toBe(1000 - 56);
  });

  it('does NOTHING when the natural target is visible — desktop keeps native behaviour', () => {
    const h = mount(twins('quickstart'), { desk: true, mob: false });
    h.dom.window.location.hash = '#quickstart';
    h.dom.window.dispatchEvent(new h.dom.window.Event('hashchange'));
    expect(h.calls).toHaveLength(0);
  });

  it('does NOTHING for a hash with no anchor at all (dangling #track, #verify-call)', () => {
    const h = mount(twins('quickstart'), { desk: false, mob: true });
    h.dom.window.location.hash = '#track';
    h.dom.window.dispatchEvent(new h.dom.window.Event('hashchange'));
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a hash that is not a plain identifier — the hash is attacker-controllable', () => {
    const h = mount(twins('quickstart'), { desk: false, mob: true });
    for (const bad of ['#a"],[data-anchor="quickstart', '#a b', '#', '#a.b']) {
      h.dom.window.location.hash = bad;
      h.dom.window.dispatchEvent(new h.dom.window.Event('hashchange'));
    }
    expect(h.calls).toHaveLength(0);
  });

  it('intercepts a same-page link click and preventDefaults ONLY when it resolved', () => {
    const body = twins('quickstart') + '<a href="#quickstart" id="hit">go</a><a href="#track" id="miss">go</a>';
    const h = mount(body, { desk: false, mob: true });
    const doc = h.dom.window.document;
    const fire = (id: string) => {
      const ev = new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      (doc.getElementById(id) as HTMLElement).dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(fire('hit')).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(fire('miss')).toBe(false);
    expect(h.calls).toHaveLength(1);
  });
});
