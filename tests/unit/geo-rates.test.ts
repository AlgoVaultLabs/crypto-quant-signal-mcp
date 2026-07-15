/**
 * OPS-GEO-PROBE-MULTI-RUN-W1 (C3) — geo-rates unit tests.
 *
 * Locks the C2 single-derivation contract: wilsonInterval (known fixtures), computeRates
 * (rate = cited/total over K; low_confidence = total < floor; legacy K=1 aggregates), and
 * rollupByEngine (pooled per-engine rate + pooled CI). getQueryRates' SQL/fail-open is covered
 * via a mocked performance-db.
 *
 * Boundary fixtures use INTEGER counts that divide exactly (no fp-rounding traps) — see the
 * floating-point-boundary-test-fixture skill; the low_confidence gate is an integer `<` compare.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: vi.fn(async () => []),
  dbExec: vi.fn(),
  dbRun: vi.fn(),
}));

import { dbQuery } from '../../src/lib/performance-db.js';
import {
  wilsonInterval,
  computeRates,
  rollupByEngine,
  rollupByQuery,
  computeAttributionRates,
  getQueryRates,
  DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES,
  type RateRow,
  type QueryEngineRate,
} from '../../src/lib/geo-rates.js';

const dbQueryMock = vi.mocked(dbQuery);
beforeEach(() => dbQueryMock.mockReset().mockResolvedValue([]));

describe('wilsonInterval (95% score interval)', () => {
  it('2 of 3 ≈ [0.208, 0.939]', () => {
    const { lo, hi } = wilsonInterval(2, 3);
    expect(lo).toBeCloseTo(0.208, 2);
    expect(hi).toBeCloseTo(0.939, 2);
  });
  it('0 of 3 ≈ [0, 0.562] (lower pinned at 0)', () => {
    const { lo, hi } = wilsonInterval(0, 3);
    expect(lo).toBeCloseTo(0, 5); // exactly 0 in theory; fp sqrt leaves a ~1e-17 residual (clamped ≥0)
    expect(hi).toBeCloseTo(0.562, 2);
  });
  it('3 of 3 ≈ [0.438, 1] (upper pinned at 1)', () => {
    const { lo, hi } = wilsonInterval(3, 3);
    expect(lo).toBeCloseTo(0.438, 2);
    expect(hi).toBe(1);
  });
  it('n=1 is WIDE (1/1 ≈ [0.207, 1]) — the honest tiny-sample signal', () => {
    const { lo, hi } = wilsonInterval(1, 1);
    expect(lo).toBeCloseTo(0.207, 2);
    expect(hi).toBe(1);
  });
  it('n=0 / non-finite → [0,0] (no data, never NaN)', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 0 });
    expect(wilsonInterval(NaN, 5)).toEqual({ lo: 0, hi: 0 });
  });
  it('clamps k>n to n (never a rate >1 or CI escaping [0,1])', () => {
    const { lo, hi } = wilsonInterval(9, 3);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
});

const ROWS: RateRow[] = [
  // claude: 2 cited of 3 successful → 0.667, full K → not low_confidence
  { query_id: 'q1', query_tier: 'head', model: 'claude-haiku-4-5', total_runs: 3, cited_count: 2, mention_count: 3, avg_sov: 0.4 },
  // gemini: 0 cited of 1 successful (the other 2 errored, not written) → partial-K → low_confidence
  { query_id: 'q1', query_tier: 'head', model: 'gemini-2.5-flash', total_runs: 1, cited_count: 0, mention_count: 1, avg_sov: 0.1 },
  // claude q2: 0 cited of 3
  { query_id: 'q2', query_tier: 'niche', model: 'claude-haiku-4-5', total_runs: 3, cited_count: 0, mention_count: 0, avg_sov: 0 },
];

describe('computeRates (rate + CI + low_confidence)', () => {
  it('rate = cited_count / total_runs over K', () => {
    const r = computeRates(ROWS, 3);
    const q1c = r.find((x) => x.query_id === 'q1' && x.model === 'claude-haiku-4-5')!;
    expect(q1c.cited_rate).toBeCloseTo(2 / 3, 5);
    expect(q1c.mention_rate).toBe(1);
    expect(q1c.cited_rate_lo).toBeCloseTo(0.208, 2);
    expect(q1c.cited_rate_hi).toBeCloseTo(0.939, 2);
  });
  it('low_confidence iff total_runs < floor (integer boundary; floor=3)', () => {
    const r = computeRates(ROWS, 3);
    expect(r.find((x) => x.model === 'claude-haiku-4-5' && x.query_id === 'q1')!.low_confidence).toBe(false); // 3 == 3
    expect(r.find((x) => x.model === 'gemini-2.5-flash')!.low_confidence).toBe(true); // 1 < 3
  });
  it('partial-K (gemini n=1): rate over j with a WIDE CI, never precise-but-wrong', () => {
    const g = computeRates(ROWS, 3).find((x) => x.model === 'gemini-2.5-flash')!;
    expect(g.total_runs).toBe(1);
    expect(g.cited_rate).toBe(0);
    expect(g.cited_rate_hi).toBeGreaterThan(0.7); // wide upper bound flags the uncertainty
    expect(g.low_confidence).toBe(true);
  });
  it('legacy K=1 cycle aggregates cleanly (rate = cited/1)', () => {
    const r = computeRates(
      [{ query_id: 'q', query_tier: 'head', model: 'sonar', total_runs: 1, cited_count: 1, mention_count: 1, avg_sov: 1 }],
      3,
    );
    expect(r[0].cited_rate).toBe(1);
    expect(r[0].low_confidence).toBe(true); // 1 < 3 → honestly flagged
  });
  it('coerces PG string numerics + null avg_sov', () => {
    const r = computeRates(
      [{ query_id: 'q', query_tier: 'head', model: 'sonar', total_runs: '4' as unknown as number, cited_count: '1' as unknown as number, mention_count: '2' as unknown as number, avg_sov: null }],
      3,
    );
    expect(r[0].total_runs).toBe(4);
    expect(r[0].cited_rate).toBeCloseTo(0.25, 5);
    expect(r[0].avg_sov).toBe(0);
    expect(r[0].low_confidence).toBe(false); // 4 >= 3
  });
});

describe('rollupByEngine (per-engine pooled rate + CI)', () => {
  it('pools cells across queries; pooled rate = Σcited / Σtotal', () => {
    const roll = rollupByEngine(computeRates(ROWS, 3), 3);
    const claude = roll.find((e) => e.model === 'claude-haiku-4-5')!;
    expect(claude.query_count).toBe(2);
    expect(claude.total_runs).toBe(6);
    expect(claude.cited_count).toBe(2);
    expect(claude.cited_rate).toBeCloseTo(2 / 6, 5);
    expect(claude.low_confidence).toBe(false); // pooled 6 >= 3
  });
  it('pooled gemini stays low_confidence when pooled total < floor', () => {
    const roll = rollupByEngine(computeRates(ROWS, 3), 3);
    expect(roll.find((e) => e.model === 'gemini-2.5-flash')!.low_confidence).toBe(true); // pooled 1 < 3
  });
  it('sorted by model (deterministic render order)', () => {
    const roll = rollupByEngine(computeRates(ROWS, 3), 3);
    expect(roll.map((e) => e.model)).toEqual([...roll.map((e) => e.model)].sort());
  });
});

describe('getQueryRates (DB wrapper)', () => {
  it('maps mocked rows through computeRates', async () => {
    dbQueryMock.mockResolvedValueOnce(ROWS as never);
    const r = await getQueryRates(1, 3);
    expect(r).toHaveLength(3);
    expect(r.find((x) => x.model === 'gemini-2.5-flash')!.low_confidence).toBe(true);
    // window weeks passed as the bound param
    expect(dbQueryMock.mock.calls[0][1]).toEqual([1]);
  });
  it('fail-open → [] on a DB error (never throws to the cron / gap-list)', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db down') as never);
    await expect(getQueryRates(4)).resolves.toEqual([]);
  });
  it('default low-confidence floor is exported + applied', async () => {
    expect(DEFAULT_LOW_CONFIDENCE_MIN_SAMPLES).toBe(3);
    dbQueryMock.mockResolvedValueOnce([{ query_id: 'q', query_tier: 'head', model: 'sonar', total_runs: 2, cited_count: 1, mention_count: 1, avg_sov: 0.5 }] as never);
    const r = await getQueryRates(1); // no floor arg → default 3
    expect(r[0].low_confidence).toBe(true); // 2 < 3
  });
});

/**
 * Single-derivation (CLAUDE.md LAW) structural canary — the NAMED consumers (digest cron +
 * scorer gap-list) project the per-(query,engine) rate from the ONE shared getQueryRates and no
 * longer re-derive it inline. (The admin dashboard's own per-model SQL is explicitly OUT of this
 * wave's scope — a tracked follow-up — so this canary targets the two named consumers only.)
 */
describe('single-derivation: consumers project from getQueryRates (no inline rate re-derivation)', () => {
  // Strip // and /* */ comments so the canary tests CODE, not prose (a doc-comment that mentions
  // the old pattern must not trip it). HTML-comment-strip-before-grep discipline, TS edition.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const read = (rel: string) => stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf-8'));
  const cron = read('src/scripts/geo-weekly-cron.ts');
  const gapList = read('src/lib/geo-gap-list.ts');

  it('cron digest sources per-engine rate from rollupByEngine(getQueryRates)', () => {
    expect(cron).toContain('getQueryRates(');
    expect(cron).toContain('rollupByEngine(');
    // the removed inline per-model citation-RATE re-derivation (count(*) FILTER(cited)/NULLIF) is gone
    expect(cron).not.toMatch(/FILTER \(WHERE cited\)\s*\/\s*NULLIF/);
  });

  it('scorer gap-list sources SoV from getQueryRates (no inline AVG(share_of_voice))', () => {
    expect(gapList).toContain('getQueryRates(');
    expect(gapList).not.toContain('AVG(share_of_voice)');
  });

  // GEO-TARGET-DIGEST-REDESIGN-W1 — the digest's per-query trend (our-action) + the full-funnel
  // attribution also project from the shared geo-rates helpers, never an inline rate/CI.
  it('cron sources the per-query trend + attribution from rollupByQuery + computeAttributionRates', () => {
    expect(cron).toContain('rollupByQuery(');
    expect(cron).toContain('computeAttributionRates(');
    // no hand-rolled Wilson interval in the cron — the CI math stays in geo-rates.
    expect(cron).not.toContain('wilsonInterval(');
  });
});

// GEO-TARGET-DIGEST-REDESIGN-W1 — the new per-query rollup + full-funnel attribution helpers.
describe('rollupByQuery (pool per-(query,engine) → per-query, Wilson CI on cited AND mention)', () => {
  const cell = (query_id: string, model: string, total: number, cited: number, mention: number, sov: number): QueryEngineRate =>
    computeRates([{ query_id, query_tier: 'branded', model, total_runs: total, cited_count: cited, mention_count: mention, avg_sov: sov }])[0];

  it('sums cells across engines into one per-query row with pooled rates', () => {
    const rows = rollupByQuery([
      cell('composite-quant-signal', 'sonar', 3, 1, 2, 0.2),
      cell('composite-quant-signal', 'gemini-2.5-flash', 3, 2, 3, 0.4),
    ]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.query_id).toBe('composite-quant-signal');
    expect(r.engine_count).toBe(2);
    expect(r.total_runs).toBe(6);
    expect(r.cited_count).toBe(3);
    expect(r.cited_rate).toBeCloseTo(0.5); // 3/6
    expect(r.mention_count).toBe(5);
    expect(r.mention_rate).toBeCloseTo(5 / 6);
    expect(r.avg_sov).toBeCloseTo((0.2 * 3 + 0.4 * 3) / 6); // sample-weighted
    // Wilson CIs bracket both point rates
    expect(r.cited_rate_lo).toBeLessThanOrEqual(r.cited_rate);
    expect(r.cited_rate_hi).toBeGreaterThanOrEqual(r.cited_rate);
    expect(r.mention_rate_lo).toBeLessThanOrEqual(r.mention_rate);
    expect(r.mention_rate_hi).toBeGreaterThanOrEqual(r.mention_rate);
  });

  it('flags low_confidence when pooled successful samples < floor', () => {
    const [r] = rollupByQuery([cell('q', 'sonar', 2, 1, 1, 0.1)]);
    expect(r.low_confidence).toBe(true); // 2 < 3
  });
});

describe('computeAttributionRates (full-funnel before/after Δ + CI; the false-negative fix)', () => {
  it('mention lift with cited FLAT → positive mention_delta, ~zero cited_delta (worked on the leading indicator)', () => {
    const [a] = computeAttributionRates([
      { query_id: 'q', runs_before: 9, cited_before: 1, mention_before: 0, sov_before: 0.02, runs_after: 9, cited_after: 1, mention_after: 3, sov_after: 0.05 },
    ]);
    expect(a.before.mention_rate).toBeCloseTo(0);
    expect(a.after.mention_rate).toBeCloseTo(3 / 9);
    expect(a.mention_delta).toBeCloseTo(3 / 9); // leading indicator moved
    expect(a.cited_delta).toBeCloseTo(0); // cited flat
    expect(a.sov_delta).toBeCloseTo(0.03);
    // Wilson CI present on BOTH cited and mention (after side)
    expect(a.after.mention_rate_hi).toBeGreaterThan(a.after.mention_rate_lo);
    expect(a.after.cited_rate_hi).toBeGreaterThanOrEqual(a.after.cited_rate_lo);
  });

  it('zero post-move samples → after side is all-zero + low_confidence (renders too-early upstream)', () => {
    const [a] = computeAttributionRates([
      { query_id: 'q', runs_before: 9, cited_before: 1, mention_before: 1, sov_before: 0.03, runs_after: 0, cited_after: 0, mention_after: 0, sov_after: null },
    ]);
    expect(a.after.total_runs).toBe(0);
    expect(a.after.cited_rate).toBe(0);
    expect(a.after.low_confidence).toBe(true);
  });
});
