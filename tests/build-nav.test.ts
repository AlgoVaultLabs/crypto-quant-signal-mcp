// NAV-PLATFORM-GENERATOR-W1 CH2 — injector + desktop/mobile parity canary.
//
// Authored as a vitest .ts (not the spec's .mjs) ON PURPOSE: the pre-push baseline gate runs
// `node --test` over every tests/**/*.test.mjs, so a vitest-authored .mjs would be double-run
// under node:test and false-fail. `.ts` is vitest-only (node --test never globs it) — no trap.
// Requires `npm run build` first (renderNavRegion imports the compiled dist renderer).
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { readdirSync } from 'node:fs';
import { applyRegion, renderNavRegion, run, listHtml, REPO_ROOT, NAV_START, NAV_END } from '../scripts/build_nav.mjs';

const region = (): string => renderNavRegion();

// Primary label of an anchor: the first <span>'s text (desktop mega/dropdown items wrap the
// label in a span + an optional blurb span) or the anchor's own text (mobile items + plain
// links). Normalized (trim, collapse ws, drop the desktop-only arrow) so the parity canary
// compares NAVIGATION content (label + href), not desktop-only blurb/arrow presentation.
function primaryLabel(a: Element): string {
  const span = a.querySelector('span');
  return (span?.textContent ?? a.textContent ?? '').trim().replace(/\s+/g, ' ').replace(/\s*→\s*$/, '');
}
function itemSet(root: Element | Document): string {
  const pairs = [...root.querySelectorAll('a[href]')].map((a) => `${primaryLabel(a)} | ${a.getAttribute('href')}`);
  return [...new Set(pairs)].sort().join('\n');
}
function hrefSet(root: Element | Document): string {
  return [...new Set([...root.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!))].sort().join('\n');
}

describe('CH2 — applyRegion is a pure, idempotent marker replace', () => {
  const wrap = (inner: string) => `<html><body>${NAV_START}\n${inner}\n${NAV_END}</body></html>`;
  it('replaces the marked region with the canonical nav', () => {
    const r = applyRegion(wrap('<nav>OLD</nav>'), '<nav>NEW</nav>');
    expect(r.marked).toBe(true);
    expect(r.html).toContain('<nav>NEW</nav>');
    expect(r.html).not.toContain('OLD');
    expect(r.html).toContain(NAV_START);
    expect(r.html).toContain(NAV_END);
  });
  it('is idempotent — applying twice yields byte-identical output', () => {
    const once = applyRegion(wrap('OLD'), region()).html;
    const twice = applyRegion(once, region()).html;
    expect(twice).toBe(once);
  });
  it('returns marked=false (no-op) when the file has no markers', () => {
    const r = applyRegion('<html><body>no markers here</body></html>', region());
    expect(r.marked).toBe(false);
    expect(r.html).toBe('<html><body>no markers here</body></html>');
  });
});

describe('CH2 AC — desktop/mobile parity (single-derivation): same targets + same labels', () => {
  const dom = () => new JSDOM(`<!doctype html><html><body>${region()}</body></html>`).window.document;
  it('the desktop bar and the mobile drawer expose the SAME set of hrefs', () => {
    const doc = dom();
    const desktop = doc.querySelector('.hidden.sm\\:flex')!;
    const mobile = doc.querySelector('#mobile-menu')!;
    expect(desktop).toBeTruthy();
    expect(mobile).toBeTruthy();
    expect(hrefSet(mobile)).toBe(hrefSet(desktop));
  });
  it('the desktop bar and the mobile drawer expose the SAME (label, href) set', () => {
    const doc = dom();
    expect(itemSet(doc.querySelector('#mobile-menu')!)).toBe(itemSet(doc.querySelector('.hidden.sm\\:flex')!));
  });
  it('both carry the Platform mega tools, the 4 channels, and the Signup CTA', () => {
    const s = region();
    for (const anchor of ['/tools#get-trade-call', '/tools#scan-trade-calls', '/tools']) expect(s).toContain(anchor);
    for (const ch of ['#connect-mcp', '#testing-with-curl', '#webhooks', 't.me/algovaultofficialbot']) expect(s).toContain(ch);
    expect(s).toContain('https://api.algovault.com/welcome');
  });
});

describe('CH2 — nav chrome + a11y hooks present (parity canary signatures preserved)', () => {
  it('carries the desktop signature + mobile hamburger/#mobile-menu + dropdown/accordion hooks', () => {
    const s = region();
    expect(s).toContain('hidden sm:flex items-center gap-6'); // check_mobile_nav_parity.sh signature
    expect(s).toContain('data-mobile-nav-toggle');
    expect(s).toContain('id="mobile-menu"');
    expect(s).toContain('data-mobile-nav-panel');
    expect(s).toContain('data-nav-dropdown-toggle');
    expect(s).toContain('data-nav-accordion-toggle');
    expect(s).toMatch(/aria-expanded="false"/);
    expect(s).toMatch(/aria-controls="nav-platform-panel"/);
  });
  it('dropdown opens via the controller (jsdom behavior)', () => {
    const { window } = new JSDOM(`<!doctype html><html><body>${region()}</body></html>`, { runScripts: 'dangerously' });
    const doc = window.document;
    const toggle = doc.querySelector('[data-nav-dropdown-toggle]') as HTMLButtonElement;
    const panel = doc.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel.classList.contains('hidden')).toBe(true);
    toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(panel.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('CH2 AC — build_nav --check bites on drift and is idempotent on write', () => {
  function scratchRepo(fileContent: string) {
    const root = mkdtempSync(join(tmpdir(), 'navcheck-'));
    mkdirSync(join(root, 'landing'), { recursive: true });
    writeFileSync(join(root, 'landing', 'page.html'), fileContent);
    return root;
  }
  const marked = (inner: string) => `<html><body>${NAV_START}\n${inner}\n${NAV_END}</body></html>`;

  it('--check reports a marked page whose region was hand-edited as drifted', () => {
    const root = scratchRepo(marked('<nav>hand-edited stale nav</nav>'));
    const { drifted } = run({ check: true, root });
    expect(drifted).toEqual(['landing/page.html']);
  });
  it('write mode syncs the region, then a second --check is a no-op (idempotent)', () => {
    const root = scratchRepo(marked('<nav>stale</nav>'));
    const first = run({ check: false, root });
    expect(first.changed).toEqual(['landing/page.html']);
    const recheck = run({ check: true, root });
    expect(recheck.drifted).toEqual([]);
    expect(readFileSync(join(root, 'landing', 'page.html'), 'utf8')).toContain('data-nav-dropdown-toggle');
  });
  it('--check flags a nav-bearing page (desktop signature) that LACKS the markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'navmiss-'));
    mkdirSync(join(root, 'landing'), { recursive: true });
    writeFileSync(
      join(root, 'landing', 'orphan.html'),
      '<html><body><div class="hidden sm:flex items-center gap-6">nav</div></body></html>',
    );
    const { missingMarker } = run({ check: true, root });
    expect(missingMarker).toEqual(['landing/orphan.html']);
  });
});

describe('CH5 — the committed repo is fully covered + in sync (surface-count lock, A3)', () => {
  const landing = join(REPO_ROOT, 'landing');
  it('every marked landing page is in sync and NO nav-bearing page lacks the markers', () => {
    const { drifted, missingMarker } = run({ check: true }); // real REPO_ROOT
    expect(drifted).toEqual([]);
    expect(missingMarker).toEqual([]);
  });
  it('the NAV:START marker count == the injected-page count (a new page missing the region fails)', () => {
    const files = listHtml(landing);
    const marked = files.filter((f) => readFileSync(f, 'utf8').includes(NAV_START));
    // one START per marked page (no page double-marked); at least the 24 migrated + /tools.
    for (const f of marked) {
      const n = (readFileSync(f, 'utf8').match(/<!-- NAV:START -->/g) || []).length;
      expect(n).toBe(1);
    }
    expect(marked.length).toBeGreaterThanOrEqual(25);
  });
});
