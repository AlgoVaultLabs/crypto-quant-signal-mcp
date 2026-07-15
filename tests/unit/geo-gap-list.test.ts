/**
 * GEO-MEASUREMENT-W2 (C4) — geo-gap-list unit tests.
 *
 *   - computeGapList ranks lowest-SoV × highest-tier × competitor-on-domain first.
 *   - persistGapBriefs caps at GEO_GAP_MAX_PER_WEEK; second call same ISO-week = no-op.
 *   - isoWeek labelling; no Telegram from this module (C6 owns the veto DM).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: vi.fn(async () => []),
  dbExec: vi.fn(),
  dbRun: vi.fn(),
}));

import { dbQuery, dbExec, dbRun } from '../../src/lib/performance-db.js';
import {
  computeGapList,
  persistGapBriefs,
  isoWeek,
  GAP_SOURCE_COLUMN_VALUE,
  type GapBrief,
} from '../../src/lib/geo-gap-list.js';
import { loadObjective, productFitOf } from '../../src/lib/geo-decide.js';

const dbQueryMock = vi.mocked(dbQuery);
const dbExecMock = vi.mocked(dbExec);
const dbRunMock = vi.mocked(dbRun);

beforeEach(() => {
  dbQueryMock.mockReset();
  dbExecMock.mockClear();
  dbRunMock.mockClear();
});

describe('computeGapList', () => {
  it('ranks lowest-SoV × highest-tier × competitor-on-trusted-domain first', async () => {
    // OPS-GEO-PROBE-MULTI-RUN-W1 — computeGapList now sources SoV from the shared getQueryRates,
    // so the first dbQuery (QUERY_RATES_SQL) returns RateRow shape (avg_sov → sov, total_runs →
    // samples). SoV drives gap severity (1 - sov); head-low (sov 0.1) must outrank branded-high.
    dbQueryMock
      .mockResolvedValueOnce([
        { query_id: 'head-low', query_tier: 'head', model: 'sonar', total_runs: 3, cited_count: 0, mention_count: 1, avg_sov: 0.1 },
        { query_id: 'branded-high', query_tier: 'branded', model: 'sonar', total_runs: 3, cited_count: 3, mention_count: 3, avg_sov: 0.9 },
        { query_id: 'niche-mid', query_tier: 'niche', model: 'sonar', total_runs: 3, cited_count: 1, mention_count: 2, avg_sov: 0.5 },
      ] as never)
      .mockResolvedValueOnce([
        { query_id: 'head-low', source_domain: 'github.com', competitor_name: 'vectorbt', cites: 5 },
        { query_id: 'niche-mid', source_domain: 'reddit.com', competitor_name: 'ccxt', cites: 1 },
      ] as never);

    const briefs = await computeGapList(4);
    expect(briefs[0].query_id).toBe('head-low');
    expect(briefs[0].top_competitor).toBe('vectorbt');
    expect(briefs[0].top_competitor_domain).toBe('github.com');
    expect(briefs[0].recommended_action).toContain('github.com');
    // branded-high (high SoV, low tier weight, no competitor) ranks last
    expect(briefs[briefs.length - 1].query_id).toBe('branded-high');
    expect(briefs[0].rank_score).toBeGreaterThan(briefs[briefs.length - 1].rank_score);
  });

  it('fails open to [] if the query throws', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db down') as never);
    expect(await computeGapList()).toEqual([]);
  });
});

const SAMPLE: GapBrief[] = [
  { query_id: 'head-low', query_tier: 'head', model: 'sonar', sov: 0.1, top_competitor: 'vectorbt', top_competitor_domain: 'github.com', recommended_action: 'x', rank_score: 1.8 },
  { query_id: 'niche-mid', query_tier: 'niche', model: 'sonar', sov: 0.5, top_competitor: 'ccxt', top_competitor_domain: 'reddit.com', recommended_action: 'y', rank_score: 0.36 },
];

describe('persistGapBriefs', () => {
  it('persists top `max` briefs when the week is empty', async () => {
    dbQueryMock.mockResolvedValueOnce([{ n: 0 }] as never); // existing count
    const persisted = await persistGapBriefs(SAMPLE, 1, new Date('2026-06-02T00:00:00Z'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].query_id).toBe('head-low'); // highest rank_score
    expect(dbRunMock).toHaveBeenCalledTimes(1);
    const sql = String(dbRunMock.mock.calls[0][0]);
    expect(sql).toContain('INTO geo_content_gaps');
    expect(sql).toContain('ON CONFLICT');
    expect(dbExecMock).toHaveBeenCalled(); // ensureGeoGapSchema
  });

  it('is a no-op when the weekly cap is already reached (dedup)', async () => {
    dbQueryMock.mockResolvedValueOnce([{ n: 1 }] as never); // already 1 this week, max 1
    const persisted = await persistGapBriefs(SAMPLE, 1, new Date('2026-06-02T00:00:00Z'));
    expect(persisted).toEqual([]);
    expect(dbRunMock).not.toHaveBeenCalled();
  });

  it('returns [] for empty input without touching the db', async () => {
    const persisted = await persistGapBriefs([], 1);
    expect(persisted).toEqual([]);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });
});

describe('persistGapBriefs — product_fit + injectable single-derivation canary (OPS-GEO-GAP-INJECTOR-PRODUCT-FIT-W1)', () => {
  // INSERT arg order: dbRun(sql, week, query_id, query_tier, model, sov, top_competitor,
  // top_competitor_domain, recommended_action, rank_score, product_fit, injectable)
  const PF_IDX = 10; // product_fit position in the dbRun call array (call[0] = sql)
  const INJ_IDX = 11; // injectable position

  // GEO-TARGET-DIGEST-REDESIGN-W1 — best-python-backtester is DROPPED from geo-queries.yaml + its
  // product_fit entry removed, so this formerly-misfit id now defaults to on-fit (1.0). Kept as a
  // fixture to prove the write-side still projects product_fit/injectable from the ONE SoT helper.
  const FORMER_MISFIT: GapBrief = { query_id: 'best-python-backtester', query_tier: 'head', model: 'sonar', sov: 0, top_competitor: 'vectorbt', top_competitor_domain: 'vectorbt.dev', recommended_action: 'x', rank_score: 1.0 };
  const ONFIT: GapBrief = { query_id: 'ai-agent-trade-signals', query_tier: 'head', model: 'sonar', sov: 0, top_competitor: null, top_competitor_domain: null, recommended_action: 'y', rank_score: 1.0 };

  it('(a) GEO-TARGET-DIGEST-REDESIGN-W1 — the dropped misfit now writes on-fit (product_fit 1.0 · injectable true)', async () => {
    dbQueryMock.mockResolvedValueOnce([{ n: 0 }] as never);
    const persisted = await persistGapBriefs([FORMER_MISFIT], 1, new Date('2026-06-02T00:00:00Z'));
    expect(persisted).toHaveLength(1); // Data Integrity: gaps are always WRITTEN (never dropped)
    const sql = String(dbRunMock.mock.calls[0][0]);
    expect(sql).toContain('product_fit');
    expect(sql).toContain('injectable');
    const call = dbRunMock.mock.calls[0];
    // product_fit map is now empty in the live SoT → default 1.0 → injectable=true. (A real misfit,
    // if one were re-added, would still write injectable=false; there are none in the SoT today.)
    expect(call[PF_IDX]).toBeCloseTo(1.0);
    expect(call[INJ_IDX]).toBe(true);
  });

  it('(a2) an on-fit OPEN gap persists injectable=true (default product_fit 1.0)', async () => {
    dbQueryMock.mockResolvedValueOnce([{ n: 0 }] as never);
    await persistGapBriefs([ONFIT], 1, new Date('2026-06-02T00:00:00Z'));
    const call = dbRunMock.mock.calls[0];
    expect(call[PF_IDX]).toBeCloseTo(1.0);
    expect(call[INJ_IDX]).toBe(true);
  });

  it('(c) write-side product_fit == the scorer’s productFitOf for the same query (ONE SoT, identical projection)', async () => {
    const obj = loadObjective();
    dbQueryMock.mockResolvedValueOnce([{ n: 0 }] as never);
    await persistGapBriefs([FORMER_MISFIT], 1, new Date('2026-06-02T00:00:00Z'));
    const call = dbRunMock.mock.calls[0];
    expect(call[PF_IDX]).toBe(productFitOf(obj, 'best-python-backtester'));
  });

  it('invariant: inject_threshold >= open_query.product_fit_threshold (autopub never LOOSER than the scorer surface)', () => {
    const obj = loadObjective();
    expect(typeof obj.inject_threshold).toBe('number');
    expect(obj.inject_threshold!).toBeGreaterThanOrEqual(obj.open_query!.product_fit_threshold);
  });
});

describe('isoWeek + constants', () => {
  it('labels ISO weeks: same week matches, adjacent weeks differ', () => {
    expect(isoWeek(new Date('2026-06-02T00:00:00Z'))).toMatch(/^2026-W\d{2}$/);
    // Mon 2026-06-01 .. Sun 2026-06-07 = same ISO week
    expect(isoWeek(new Date('2026-06-01T00:00:00Z'))).toBe(isoWeek(new Date('2026-06-07T23:00:00Z')));
    // next Monday = different week
    expect(isoWeek(new Date('2026-06-08T00:00:00Z'))).not.toBe(isoWeek(new Date('2026-06-01T00:00:00Z')));
  });

  it('exposes the geo-gap Source column value for C6', () => {
    expect(GAP_SOURCE_COLUMN_VALUE).toBe('geo-gap');
  });
});
