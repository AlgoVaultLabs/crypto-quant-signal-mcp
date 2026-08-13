/**
 * EDGE-CARRY-SCOREBOARD-W1 — the public tracker's allow-list, page copy and apex routing.
 *
 * The properties pinned here are the ones whose failure would be SILENT: a leaked internal
 * field, a re-derived statistic, a wrong provenance date, a public claim the product does not
 * implement, and a missing Caddy handle (which 404s only on the apex).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatCarryTrackerPublic,
  TRACKER_SCOPE,
} from '../../src/lib/carry-tracker-public.js';
import {
  renderCarryTrackerPage,
  SCOPE_BANNER,
  REFUSAL_EXHIBIT,
} from '../../src/lib/carry-tracker-page.js';

const ROOT = join(__dirname, '..', '..');

const WEEKLY = [
  { iso_week: '2026W31', lift_mean: 0.00057799, n: 168, n_deviating: 168, partial: false, window_start: '2026-07-21', computed_at: '2026-08-13T08:20:00.000Z' },
  { iso_week: '2026W30', lift_mean: 0.00046304, n: 144, n_deviating: 142, partial: true, window_start: '2026-07-21', computed_at: '2026-08-13T08:20:00.000Z' },
  { iso_week: '2026W33', lift_mean: 0.00033592, n: 75, n_deviating: 75, partial: true, window_start: '2026-07-21', computed_at: '2026-08-13T08:20:00.000Z' },
  { iso_week: '2026W32', lift_mean: 0.00042236, n: 168, n_deviating: 166, partial: false, window_start: '2026-07-21', computed_at: '2026-08-13T08:20:00.000Z' },
];
const POOLED = {
  lift_mean: 0.00046834, ci_lb: 0.0004, ci_ub: 0.0005, n: 555, n_deviating: 551,
  blocks: 4, window_start: '2026-07-21', computed_at: '2026-08-13T08:20:00.000Z',
};
const NOW = Date.parse('2026-08-13T09:00:00.000Z');

describe('carry-tracker allow-list', () => {
  it('emits exactly the allowed keys and nothing else', () => {
    const out = formatCarryTrackerPublic(WEEKLY, POOLED, NOW);
    expect(Object.keys(out).sort()).toEqual(
      ['pooled', 'scope', 'since', 'stale', 'updated_at', 'weeks'],
    );
    expect(Object.keys(out.weeks[0]).sort()).toEqual(
      ['iso_week', 'lift_mean', 'n', 'n_deviating', 'partial'],
    );
    expect(Object.keys(out.pooled!).sort()).toEqual(
      ['blocks', 'ci_lb', 'ci_ub', 'lift_mean', 'n', 'n_deviating'],
    );
  });

  it('drops columns the rows carry but the public body must not', () => {
    // window_start/computed_at are PROVENANCE inputs — projected into `since`/`updated_at`,
    // never passed through. A row column added later cannot reach the body by default.
    const body = JSON.stringify(formatCarryTrackerPublic(WEEKLY, POOLED, NOW));
    expect(body).not.toContain('window_start');
    expect(body).not.toContain('computed_at');
    expect(body).not.toContain('status');
  });

  it('never leaks an INTERNAL absolute-value field name', () => {
    const body = JSON.stringify(formatCarryTrackerPublic(WEEKLY, POOLED, NOW));
    for (const banned of ['portfolio_net_carry', 'net_carry', 'outcome_return_pct', 'outcome_price', 'apr_at_pick', 'score']) {
      expect(body).not.toContain(banned);
    }
  });

  it('stamps `since` from the publisher window, not the flip-bar constant', () => {
    // readiness.LIVE_FORWARD_START is 2026-07-05 (the RANKER go-live), 16 days before the HL
    // flip this page reports on. Echoing it would misdate the entire claim.
    const out = formatCarryTrackerPublic(WEEKLY, POOLED, NOW);
    expect(out.since).toBe('2026-07-21');
    expect(JSON.stringify(out)).not.toContain('2026-07-05');
  });

  it('sorts weeks chronologically regardless of row order', () => {
    const out = formatCarryTrackerPublic(WEEKLY, POOLED, NOW);
    expect(out.weeks.map((w) => w.iso_week)).toEqual(['2026W30', '2026W31', '2026W32', '2026W33']);
  });

  it('carries no per-week confidence interval', () => {
    // A block bootstrap over ISO-week clusters has ONE cluster inside a single week, so a
    // per-week band would be a confidence-shaped decoration with no sampling behind it.
    for (const w of formatCarryTrackerPublic(WEEKLY, POOLED, NOW).weeks) {
      expect(w).not.toHaveProperty('ci_lb');
      expect(w).not.toHaveProperty('ci_ub');
    }
  });

  it('reports stale on an empty read and on an old computed_at, fresh otherwise', () => {
    expect(formatCarryTrackerPublic([], null, NOW).stale).toBe(true);
    expect(formatCarryTrackerPublic(WEEKLY, POOLED, NOW).stale).toBe(false);
    const old = Date.parse('2026-08-15T09:00:00.000Z'); // ~49h after computed_at
    expect(formatCarryTrackerPublic(WEEKLY, POOLED, old).stale).toBe(true);
  });

  it('degrades to an empty payload rather than throwing when there are no rows', () => {
    const out = formatCarryTrackerPublic([], null, NOW);
    expect(out.scope).toBe(TRACKER_SCOPE);
    expect(out.weeks).toEqual([]);
    expect(out.pooled).toBeNull();
  });
});

describe('carry-tracker page copy', () => {
  const html = renderCarryTrackerPage(formatCarryTrackerPublic(WEEKLY, POOLED, NOW));

  it('is noindex', () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it('renders the decay honestly — every measured week, in order, including the falling one', () => {
    // The product IS the honest series. A tracker that renders only favourable weeks is not
    // evidence of anything, so the weakest week must be present.
    for (const [wk, bps] of [['2026W30', '+4.63'], ['2026W31', '+5.78'], ['2026W32', '+4.22'], ['2026W33', '+3.36']]) {
      expect(html).toContain(wk);
      expect(html).toContain(bps);
    }
    expect(html.indexOf('2026W30')).toBeLessThan(html.indexOf('2026W33'));
  });

  it('flags both structurally partial weeks', () => {
    // W30 is measured from a Tuesday flip; W33 is still in progress. 144 and 75 intervals
    // against 168 in a full week — unflagged, they would misstate the trend.
    expect(html).toContain('partial');
    expect(html).toContain('n=144');
    expect(html).toContain('n=75');
  });

  it('states the unit as per-interval basis points and never annualises', () => {
    expect(html).toContain('bps / funding interval');
    expect(html.toLowerCase()).not.toContain('annualis');
    expect(html.toLowerCase()).not.toContain('annualiz');
    expect(html).not.toContain('APR');
    expect(html).not.toContain('APY');
  });

  it('carries the copy-locked scope banner verbatim', () => {
    expect(html).toContain('Live-forward since 2026-07-21');
    expect(SCOPE_BANNER).toContain('Hyperliquid only');
    expect(SCOPE_BANNER).toContain('venues flip only when their own bar clears');
  });

  it('makes the paper-lift framing explicit and never claims served-traffic P&L', () => {
    expect(html).toContain('paper');
    expect(html).toContain('served traffic has no counterfactual');
    expect(html.toLowerCase()).not.toContain('realised trading profit');
    expect(html.toLowerCase()).not.toContain('returns you would have made');
  });

  it('claims no uptime and no anchoring', () => {
    expect(html).toContain('Not claimed');
    expect(html.toLowerCase()).not.toContain('99.9');
    // The page must DENY anchoring, so a bare "merkle-anchored" substring ban would forbid the
    // denial itself. Ban the AFFIRMATIVE forms and require the denial.
    expect(html).toContain('not Merkle-anchored today');
    expect(html).not.toMatch(/\b(are|is|fully)\s+Merkle-anchored/i);
    expect(html).not.toMatch(/anchored\s+on\s+Base/i);
  });

  it('uses no edge/alpha/premium language', () => {
    for (const banned of [/\balpha\b/i, /\bedge\b/i, /\bpremium\b/i, /\boutperform/i]) {
      expect(html).not.toMatch(banned);
    }
  });

  it('states the refusal exhibit WITHOUT claiming automatic demotion', () => {
    // Measured 2026-08-13: nothing auto-demotes. carry_serving_state.DECAY_CONSECUTIVE_FAILS
    // changes a digest render string and points at the runbook; rollback is an operator
    // removing three env lines. "The system demotes on decay" would be a false product claim.
    expect(html).toContain(REFUSAL_EXHIBIT);
    expect(REFUSAL_EXHIBIT).toContain('escalates to the operator');
    expect(html).not.toMatch(/system\s+(automatically\s+)?demotes/i);
    expect(html).not.toMatch(/auto(matically)?[- ]roll(s|ed)?[- ]?back/i);
  });

  it('renders a labelled stale banner instead of silently serving old numbers', () => {
    const stale = renderCarryTrackerPage(formatCarryTrackerPublic(WEEKLY, POOLED, Date.parse('2026-08-20T00:00:00Z')));
    expect(stale).toContain('out of date');
    expect(stale).toContain('stale');
  });

  it('survives an empty payload without throwing', () => {
    expect(() => renderCarryTrackerPage(formatCarryTrackerPublic([], null, NOW))).not.toThrow();
  });
});

describe('carry-tracker is DARK', () => {
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

  it('appears in no discovery surface', () => {
    // indexnow-ping.mjs submits ONLY the <loc> set parsed from sitemap.xml, so absence there
    // keeps the page out of IndexNow as well — verified at the producer, not assumed.
    for (const f of ['landing/sitemap.xml', 'landing/llms.txt', 'landing/llms-full.txt', 'landing/index.html']) {
      expect(read(f)).not.toContain('carry-tracker');
    }
  });

  it('is linked from no landing page', () => {
    const { globSync } = require('node:fs') as typeof import('node:fs');
    const pages = globSync('landing/**/*.html', { cwd: ROOT });
    expect(pages.length).toBeGreaterThan(10); // vacuity guard: a zero-page sweep proves nothing
    for (const p of pages) {
      expect(read(p), `${p} links to the dark page`).not.toContain('/carry-tracker');
    }
  });
});

describe('apex Caddy routing for the dark page', () => {
  it('both paths have an apex handle block', async () => {
    // The apex serves an ALLOWLIST and falls through to a static file_server, so a missing
    // handle 404s on algovault.com while working fine on api.algovault.com. The existing
    // route-parity guard scans landing/**, which cannot see a function-rendered page — hence
    // this explicit assertion. Widening that guard's corpus to function-rendered pages is
    // OPS-CADDY-PARITY-FUNCTION-RENDERED-W{NEXT}.
    const { apexProxyHandles, handleMatches } = await import('../../scripts/check-caddy-route-parity.mjs');
    const handles = apexProxyHandles(readFileSync(join(ROOT, 'Caddyfile'), 'utf8'));
    expect(handles.length).toBeGreaterThan(5); // vacuity guard on the parser
    for (const path of ['/carry-tracker', '/api/carry-tracker-public']) {
      expect(handles.some((h: string) => handleMatches(h, path)), `no apex handle for ${path}`).toBe(true);
    }
  });
});
