/**
 * OPS-DOCS-FOREIGN-MARKER-PRESERVE-W1 — build_docs must not clobber regions it does not own.
 *
 * THE BUG. `build_docs.mjs` writes landing/docs.html WHOLE-FILE from docs-src/template.html, so
 * running it ALONE used to destroy every downstream-owned marker region — measured on the real
 * page: 733 deletions across SIX regions. The two live ones failed in two DIFFERENT ways, which
 * is why a "only fill it if the generated region came out empty" fix would have been half a fix:
 *
 *   - ANALYTICS — the template's region is ZERO bytes, so the Plausible snippet was DELETED
 *     (`plausible.init` 2 -> 0) and the docs page shipped with no instrumentation.
 *   - NAV — the template carries a 15,922-byte HARDCODED nav whose links are `/docs.html`, so
 *     build_nav's canonical `/docs` links were REVERTED (3 -> 1, and `/docs.html` 1 -> 3).
 *     Not emptied. Silently replaced with a stale copy.
 *
 * WHY NO GATE CAUGHT IT. `build_docs --check` runs BOTH sides of its drift compare through
 * `blankMarkers`, so the regions it had just wrecked are precisely the ones it cannot see — it
 * printed `OK — sidebar === body === outline; no drift` over the wrecked page. The failure
 * surfaced downstream at `build_nav --check` / `build_analytics --check` in CI, where it reads as
 * an unrelated mystery. Measured 2026-08-10 during PRICING-BADGES-LIMITED-TIME-W1.
 *
 * READ-ONLY on the repo's landing/docs.html, for the reason build-docs.test.ts states: a parallel
 * worker (build-channel-pages.test.ts) READS that file, so regenerating it mid-suite would race.
 * The end-to-end case therefore runs the REAL entrypoint inside a temp SANDBOX.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DOCS = path.join(REPO, 'scripts', 'build_docs.mjs');

type Region = { name: string; owner: string; start: string; end: string };
let foreignMarkerRegions: (m: string[]) => Region[];
let blankMarkers: (html: string, m: string[]) => string;
let preserveForeignMarkers: (
  generated: string, existing: string, m: string[],
) => { html: string; preserved: string[]; skipped: string[] };

const MARKERS = ['connect-mcp-client', 'connect-ai-agent', 'connect-exchange-kit'];

beforeAll(async () => {
  // Importing the entrypoint must NOT run main() — that is what the invokedDirectly guard buys,
  // and if the guard ever regresses this import writes landing/docs.html and races the suite.
  const mod = await import(pathToFileURL(BUILD_DOCS).href);
  ({ foreignMarkerRegions, blankMarkers, preserveForeignMarkers } = mod);
});

describe('the foreign-region declaration is single-sourced', () => {
  it('exports a non-empty region set covering NAV, ANALYTICS and every build_landing marker', () => {
    const regions = foreignMarkerRegions(MARKERS);
    expect(regions.length).toBeGreaterThanOrEqual(6);   // vacuity guard
    const names = regions.map((r) => r.name);
    expect(names).toContain('NAV');
    expect(names).toContain('ANALYTICS');
    expect(names).toContain('BUILD:signup-flow');
    for (const m of MARKERS) expect(names).toContain(`BUILD:${m}`);
    // Every region names the builder that owns it — the whole point is that build_docs does not.
    for (const r of regions) expect(r.owner, r.name).toMatch(/^build_(nav|analytics|landing)$/);
  });

  it('EVERY blanked region is also a preserved region — the two sets cannot drift apart', () => {
    // This is the structural guarantee. A region blanked for the drift compare but NOT carried
    // over on write is invisible to --check and destroyed on disk: the exact original bug.
    for (const r of foreignMarkerRegions(MARKERS)) {
      const generated = `<head>${r.start}${r.end}</head>`;
      const existing = `<head>${r.start}OWNED-CONTENT${r.end}</head>`;
      expect(blankMarkers(existing, MARKERS), `${r.name} not blanked`).toBe(generated);
      const { html, preserved } = preserveForeignMarkers(generated, existing, MARKERS);
      expect(preserved, `${r.name} not preserved`).toContain(r.name);
      expect(html).toBe(existing);
    }
  });
});

describe('preserveForeignMarkers', () => {
  const wrap = (nav: string, analytics: string) =>
    `<html><head><!-- ANALYTICS:START -->${analytics}<!-- ANALYTICS:END --></head>`
    + `<body><!-- NAV:START -->${nav}<!-- NAV:END --></body></html>`;

  it('carries content into an EMPTY generated region (the ANALYTICS shape)', () => {
    const { html, preserved } = preserveForeignMarkers(
      wrap('', ''), wrap('', '<script>plausible.init()</script>'), MARKERS);
    expect(html).toContain('plausible.init()');
    expect(preserved).toContain('ANALYTICS');
  });

  it('carries content over a NON-EMPTY generated region (the NAV shape)', () => {
    // The trap: the template's NAV region is not empty, it holds a STALE hardcoded nav. A
    // "only fill when empty" guard reads as the careful choice and would leave build_nav's
    // canonical links being reverted on every run.
    const { html, preserved } = preserveForeignMarkers(
      wrap('<a href="https://algovault.com/docs.html">Docs</a>', ''),
      wrap('<a href="https://algovault.com/docs">Docs</a>', ''),
      MARKERS,
    );
    expect(html).toContain('algovault.com/docs"');
    expect(html).not.toContain('docs.html');
    expect(preserved).toContain('NAV');
  });

  it('is a no-op when the regions already agree', () => {
    const same = wrap('<nav/>', '<script/>');
    const { html, preserved } = preserveForeignMarkers(same, same, MARKERS);
    expect(html).toBe(same);
    expect(preserved).toEqual([]);
  });

  it('carries an EMPTY existing region too — absent instrumentation is a real state', () => {
    // If the live page genuinely has no analytics yet, the template must not smuggle one in.
    const { html } = preserveForeignMarkers(
      wrap('', '<script>STALE-FROM-TEMPLATE</script>'), wrap('', ''), MARKERS);
    expect(html).not.toContain('STALE-FROM-TEMPLATE');
  });

  it('SKIPS a region missing from either side rather than corrupting the page', () => {
    const generated = '<html><head></head></html>';                     // no markers at all
    const existing = wrap('<nav/>', '<script/>');
    const { html, preserved, skipped } = preserveForeignMarkers(generated, existing, MARKERS);
    expect(html).toBe(generated);
    expect(preserved).toEqual([]);
    expect(skipped).toContain('NAV');
    expect(skipped).toContain('ANALYTICS');
  });
});

describe('END-TO-END: running build_docs.mjs ALONE is non-destructive', () => {
  let sandbox: string;

  beforeAll(() => {
    // Sandbox so the real landing/docs.html is never written (parallel workers read it).
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'build-docs-sandbox-'));
    for (const d of ['scripts', 'docs-src', 'landing']) {
      fs.cpSync(path.join(REPO, d), path.join(sandbox, d), { recursive: true });
    }
    // dist is a read-only input (docs-outline + footer-content) — symlink, never copy.
    fs.symlinkSync(path.join(REPO, 'dist'), path.join(sandbox, 'dist'), 'dir');
  }, 120_000);

  const sandboxDocs = () => fs.readFileSync(path.join(sandbox, 'landing', 'docs.html'), 'utf8');
  const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;

  it('leaves the ANALYTICS region and the canonical /docs nav links intact', () => {
    const before = sandboxDocs();
    // Vacuity guard: if the fixture has no analytics/canonical links to begin with, the
    // assertions below would pass over nothing — the dark-guard shape this repo keeps meeting.
    expect(count(before, /plausible\.init/g), 'fixture must HAVE analytics to preserve')
      .toBeGreaterThan(0);
    expect(count(before, /algovault\.com\/docs"/g), 'fixture must HAVE canonical /docs links')
      .toBeGreaterThan(0);

    execFileSync('node', ['scripts/build_docs.mjs'], { cwd: sandbox, encoding: 'utf8' });

    const after = sandboxDocs();
    expect(count(after, /plausible\.init/g)).toBe(count(before, /plausible\.init/g));
    expect(count(after, /algovault\.com\/docs"/g)).toBe(count(before, /algovault\.com\/docs"/g));
    expect(count(after, /algovault\.com\/docs\.html"/g))
      .toBe(count(before, /algovault\.com\/docs\.html"/g));
  }, 120_000);

  it('is IDEMPOTENT — a second lone run changes nothing', () => {
    const before = sandboxDocs();
    execFileSync('node', ['scripts/build_docs.mjs'], { cwd: sandbox, encoding: 'utf8' });
    expect(sandboxDocs()).toBe(before);
  }, 120_000);

  it('reports which regions it carried over, so the behaviour is observable', () => {
    const out = execFileSync('node', ['scripts/build_docs.mjs'], { cwd: sandbox, encoding: 'utf8' });
    expect(out).toMatch(/carried over \d+ foreign marker region\(s\)|no foreign marker region needed/);
  }, 120_000);
});
