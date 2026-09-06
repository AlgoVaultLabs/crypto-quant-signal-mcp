/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH2 — the reciprocal gate for a deliberate duplication.
 *
 * The analytics region markers exist in TWO places, and that is a sanctioned exception rather
 * than an oversight:
 *
 *   - `scripts/build_analytics.mjs` — injects them into the ~54 STATIC `landing/**` pages.
 *   - `src/lib/analytics-snippet.ts` — used by the seven FUNCTION-RENDERED surfaces, which are
 *     built in TypeScript at request time and which no injector can reach.
 *
 * A `.mjs` build script and the compiled TS runtime cannot share one static constant without
 * making `build_analytics.mjs` `require()` `dist/` at module load — breaking its own `--check` on
 * a cold checkout, in a file whose header asks not to be restructured. CLAUDE.md permits two
 * same-shaped constants exactly when they are paired with a reciprocal cross-check; this file is
 * that check. Without it the duplication is just a fact going stale, and the failure would be
 * silent: `served-region-check.mjs` locates the region by literal marker string, so a drifted
 * marker makes seven pages report `missing-marker` — indistinguishable from an untagged page.
 *
 * It also asserts the DECLARED route list is honest, since that list is the one thing in the
 * checker that a file-tree derivation cannot verify for itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANALYTICS_START,
  ANALYTICS_END,
  renderAnalyticsSnippet,
  renderAnalyticsRegion,
} from '../../src/lib/analytics-snippet.js';
import {
  ANALYTICS_START as INJECTOR_START,
  ANALYTICS_END as INJECTOR_END,
  applyRegion,
} from '../../scripts/build_analytics.mjs';
import { FUNCTION_RENDERED_ROUTES } from '../../ops/monitoring/served-region-check.mjs';

const REPO = join(__dirname, '..', '..');

describe('analytics markers — the two declarations must be byte-identical', () => {
  it('START matches the injector', () => {
    expect(ANALYTICS_START).toBe(INJECTOR_START);
  });

  it('END matches the injector', () => {
    expect(ANALYTICS_END).toBe(INJECTOR_END);
  });

  it('neither is empty (a vacuous parity check would pass on two empty strings)', () => {
    expect(ANALYTICS_START.length).toBeGreaterThan(0);
    expect(ANALYTICS_END.length).toBeGreaterThan(0);
  });
});

describe('renderAnalyticsRegion — byte-identical to what the injector writes', () => {
  it('produces exactly what applyRegion() puts between the markers of a static page', () => {
    // This is the property the whole design rests on: one canonical render, one comparison, both
    // page families. `served-region-check.mjs` byte-compares the extracted region against
    // `renderAnalyticsSnippet()`, so a function-rendered page whose region differs by even a
    // newline reads as DRIFTED.
    const page = `<html><head>\n${ANALYTICS_START}\nSTALE\n${ANALYTICS_END}\n</head></html>`;
    const { marked, html } = applyRegion(page, renderAnalyticsSnippet());
    expect(marked).toBe(true);
    expect(html).toContain(renderAnalyticsRegion());
  });

  it('is idempotent — re-rendering yields the same bytes', () => {
    expect(renderAnalyticsRegion()).toBe(renderAnalyticsRegion());
  });

  it('wraps the snippet with a newline on each side, exactly as applyRegion does', () => {
    expect(renderAnalyticsRegion()).toBe(`${ANALYTICS_START}\n${renderAnalyticsSnippet()}\n${ANALYTICS_END}`);
  });
});

describe('the seven function-rendered surfaces actually emit the region', () => {
  // Asserted in SOURCE rather than by rendering: three of these renderers need a request, a
  // license or a DB handle to call, and stubbing all of that would test the stub. What matters is
  // that each renderer interpolates the ONE shared function — never a second copy of the snippet.
  const files: Array<[string, string, number]> = [
    ['src/lib/referral-pages.ts', '/referral + /referral-terms + /join (one shared shell)', 1],
    ['src/lib/welcome-page.ts', '/welcome', 1],
    ['src/lib/account-handlers.ts', '/account', 1],
    ['src/index.ts', '/track-record + bare /signup', 2],
  ];

  for (const [rel, routes, expected] of files) {
    it(`${rel} interpolates renderAnalyticsRegion() for ${routes}`, () => {
      const src = readFileSync(join(REPO, rel), 'utf8');
      // Match on the module, not a fixed relative prefix — `src/index.ts` reaches it as
      // `./lib/analytics-snippet.js` while the `src/lib/*` renderers use `./analytics-snippet.js`.
      expect(src).toMatch(/from '\.[./a-z-]*analytics-snippet\.js'/);
      const calls = src.match(/\$\{renderAnalyticsRegion\(\)\}/g) ?? [];
      expect(calls.length).toBe(expected);
    });

    it(`${rel} does NOT hand-copy the snippet (single-derivation)`, () => {
      const src = readFileSync(join(REPO, rel), 'utf8');
      // A second literal `<script async src="/js/insights.js">` anywhere is the drift this whole
      // arc exists to retire — OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 found the tag hand-duplicated
      // across ~26 surfaces and missing from 4.
      expect(src).not.toContain('<script async src="/js/insights.js">');
    });
  }
});

describe('FUNCTION_RENDERED_ROUTES is honest about what the repo serves', () => {
  const index = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8');

  it('is non-empty (an empty route list would make the widened coverage vacuous)', () => {
    expect(FUNCTION_RENDERED_ROUTES.length).toBeGreaterThan(0);
  });

  it('every declared route is registered as a GET in src/index.ts', () => {
    // The declared list is the one part of the checker no file-tree derivation validates, so a
    // stale row must FAIL here rather than silently skip a page at runtime.
    for (const r of FUNCTION_RENDERED_ROUTES) {
      expect(index, `no app.get('${r.path}') found`).toContain(`app.get('${r.path}'`);
    }
  });

  it('declares a host for every route, and only the two that exist', () => {
    for (const r of FUNCTION_RENDERED_ROUTES) {
      expect(['apex', 'api']).toContain(r.host);
    }
  });

  it('routes are unique', () => {
    const keys = FUNCTION_RENDERED_ROUTES.map((r) => `${r.host}${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the api-origin set is exactly the three routes that 404 on the apex', () => {
    // Measured 2026-09-06: apex /welcome, /account and /signup all return 404 — they are
    // api-canonical. If one of them ever becomes apex-proxied, this row must move with it, or the
    // canary checks a URL nobody visits.
    const api = FUNCTION_RENDERED_ROUTES.filter((r) => r.host === 'api').map((r) => r.path).sort();
    expect(api).toEqual(['/account', '/signup', '/welcome']);
  });
});
