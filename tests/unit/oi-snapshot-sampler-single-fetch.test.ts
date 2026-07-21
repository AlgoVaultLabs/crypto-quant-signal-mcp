/**
 * tests/unit/oi-snapshot-sampler-single-fetch.test.ts — OPS-STRUCTURAL-FEATURE-ACCRUAL-W1
 *
 * Regression guard for a bug this wave introduced and then caught in live verification:
 * `buildVenueRows` fetched the venue universe AND called `fetchCurrentOiUsd`, which fetched it
 * AGAIN. Two consequences, both real:
 *   1. Doubled upstream load — the exact failure mode this wave rejected the spec's design for.
 *   2. Non-determinism — the two fetches see a LIVE-REORDERING ranking, so their top-N slices
 *      differ and the union exceeds the pool. A same-bucket re-run then inserted genuinely-new
 *      rows (measured on prod 2026-07-21: ASTER + MEXC each landed a 61st row for bucket 10:00Z).
 *
 * ON CONFLICT DO NOTHING cannot save you here: the extra rows have DIFFERENT primary keys.
 * Idempotency of the WRITE is not idempotency of the RUN — the pool has to be decided once.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fetchVenueUniverse, fetchCurrentOiUsd, fetchStructuralGaps, recordOiSnapshots } = vi.hoisted(() => ({
  fetchVenueUniverse: vi.fn(),
  fetchCurrentOiUsd: vi.fn(),
  fetchStructuralGaps: vi.fn(),
  recordOiSnapshots: vi.fn(),
}));

vi.mock('../../src/lib/exchange-universe.js', () => ({ fetchVenueUniverse, OI_PROXY_VENUES: new Set() }));
vi.mock('../../src/lib/oi-sources.js', () => ({ fetchCurrentOiUsd }));
vi.mock('../../src/lib/structural-sources.js', () => ({ fetchStructuralGaps, STRUCTURAL_INLINE_VENUES: new Set() }));
vi.mock('../../src/lib/oi-snapshots.js', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/oi-snapshots.js')>();
  return { ...actual, recordOiSnapshots, pruneOiSnapshots: vi.fn() };
});
vi.mock('../../src/lib/capabilities.js', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/capabilities.js')>();
  return { ...actual, PROMOTED_VENUE_IDS: ['HL'] };
});

import { runOiSnapshotSampler } from '../../src/scripts/oi-snapshot-sampler.js';

const asset = (coin: string, oiUsd: number) => ({
  coin, notionalOI_usd: oiUsd, volume24h_usd: 0, markPx: 101, indexPx: 100, bidPx: 99.5, askPx: 100.5,
});

beforeEach(() => {
  vi.clearAllMocks();
  recordOiSnapshots.mockResolvedValue(0);
  fetchStructuralGaps.mockResolvedValue(new Map());
});

describe('oi-snapshot-sampler — ONE universe fetch per venue per run', () => {
  it('fetches the universe exactly once and threads it into fetchCurrentOiUsd', async () => {
    fetchVenueUniverse.mockResolvedValue([asset('BTC', 3), asset('ETH', 2)]);
    fetchCurrentOiUsd.mockResolvedValue([{ coin: 'BTC', oi: 3 }, { coin: 'ETH', oi: 2 }]);

    await runOiSnapshotSampler(1_784_628_000_000);

    expect(fetchVenueUniverse).toHaveBeenCalledTimes(1);
    // The universe object is PASSED THROUGH — not re-fetched inside fetchCurrentOiUsd.
    const [, , passedUniverse] = fetchCurrentOiUsd.mock.calls[0];
    expect(passedUniverse).toBe(await fetchVenueUniverse.mock.results[0].value);
  });

  it('row set is exactly the pool even when the OI fetcher reports a coin the pool does not hold', async () => {
    // Simulates the live failure: a stale/divergent OI snapshot naming a coin outside this run's
    // ranked pool. The pool is the ONE authority — the stray coin must NOT become a row, because
    // its (venue, symbol, ts) is a NEW primary key that a re-run would happily insert.
    fetchVenueUniverse.mockResolvedValue([asset('BTC', 3), asset('ETH', 2)]);
    fetchCurrentOiUsd.mockResolvedValue([
      { coin: 'BTC', oi: 3 },
      { coin: 'DOGE', oi: 99 }, // not in the pool
    ]);

    await runOiSnapshotSampler(1_784_628_000_000);

    const rows = recordOiSnapshots.mock.calls[0][1] as Array<{ symbol: string }>;
    expect(rows.map((r) => r.symbol).sort()).toEqual(['BTC', 'ETH']);
    expect(rows.map((r) => r.symbol)).not.toContain('DOGE');
  });

  it('two runs over an UNCHANGED universe produce byte-identical row keys (bucket idempotency)', async () => {
    fetchVenueUniverse.mockResolvedValue([asset('BTC', 3), asset('ETH', 2)]);
    fetchCurrentOiUsd.mockResolvedValue([{ coin: 'BTC', oi: 3 }, { coin: 'ETH', oi: 2 }]);

    await runOiSnapshotSampler(1_784_628_000_000);
    await runOiSnapshotSampler(1_784_628_000_000);

    const keys = (i: number) =>
      (recordOiSnapshots.mock.calls[i][1] as Array<{ symbol: string; ts: number }>)
        .map((r) => `${r.symbol}@${r.ts}`).sort();
    expect(keys(1)).toEqual(keys(0));
  });
});
