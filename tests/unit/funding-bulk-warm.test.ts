/**
 * Unit tests for OPTIMIZE-FUNDING-CACHE-CRON-W1 — `bulkWarmFundingCache`.
 *
 * The bulk-warm path issues ONE batched query (or grouped JS aggregation
 * for SQLite) to populate the in-process cache for N coins at once. Cron
 * processes call this at process startup so the per-coin `getFundingZScore`
 * loop hits a warm cache (zero DB roundtrips per coin in the steady state).
 *
 *   1. Empty input → no-op
 *   2. All-cold → 1 DB query, all coins cached
 *   3. After bulk-warm, getFundingZScore returns from cache (no DB hit)
 *   4. **Math equivalence**: bulk-warm output equals per-coin loadFundingStats output
 *   5. Mixed (cached + cold) → only cold coins re-fetched
 *   6. <20 rows → cached as negative entry; getFundingZScore returns null without DB
 *   7. Zero rows → cached as negative entry (sampleCount: 0)
 *   8. TTL expiry → next bulk-warm re-fetches everything
 *
 * Coin names are suffixed with a per-run `RUN_ID` (timestamp + random) so
 * the persistent SQLite test DB doesn't cross-pollute between runs — same
 * pattern as `funding-zscore-cache.test.ts` from W1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  bulkWarmFundingCache,
  getFundingZScore,
  recordFunding,
  _clearFundingStatsCache,
  _setFundingStatsForTest,
  _getFundingStatsCacheSize,
} from '../../src/lib/performance-db.js';

const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function uniq(name: string): string {
  return `${name}_${RUN_ID}`;
}

function makeRows(n: number, base: number = 0.0001, jitter: number = 0.00005): { funding_rate: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    funding_rate: base + (i % 2 === 0 ? jitter : -jitter),
  }));
}

describe('OPTIMIZE-FUNDING-CACHE-CRON-W1: bulkWarmFundingCache', () => {
  beforeEach(() => {
    _clearFundingStatsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: Empty input → no-op ──
  it('empty input is a no-op (no DB query, cache unchanged)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(_getFundingStatsCacheSize()).toBe(0);
    await bulkWarmFundingCache([]);
    expect(_getFundingStatsCacheSize()).toBe(0);
    // No bulk-warm summary log fires for empty input
    const bulkLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[funding-cache] bulk-warm'),
    ).length;
    expect(bulkLogs).toBe(0);
  });

  // ── Test 2: All-cold → 1 DB query, all coins cached ──
  it('all-cold input warms entire batch in one query', async () => {
    const a = uniq('BULK_A');
    const b = uniq('BULK_B');
    const c = uniq('BULK_C');
    // Seed enough rows for each to pass the 20-sample threshold
    for (const r of makeRows(50)) {
      recordFunding(a, r.funding_rate);
      recordFunding(b, r.funding_rate);
      recordFunding(c, r.funding_rate);
    }
    expect(_getFundingStatsCacheSize()).toBe(0);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await bulkWarmFundingCache([a, b, c]);

    expect(_getFundingStatsCacheSize()).toBe(3);

    // Exactly one bulk-warm summary log
    const bulkLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[funding-cache] bulk-warm n_in=3'),
    ).length;
    expect(bulkLogs).toBe(1);

    // No per-coin miss logs fired (the cache was warmed in bulk, not via loadFundingStats)
    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[funding-cache] miss coin='),
    ).length;
    expect(missLogs).toBe(0);
  });

  // ── Test 3: Post bulk-warm, getFundingZScore returns from cache ──
  it('after bulk-warm, getFundingZScore is served from cache', async () => {
    const a = uniq('CACHED_AFTER_WARM');
    for (const r of makeRows(50)) recordFunding(a, r.funding_rate);
    await bulkWarmFundingCache([a]);
    expect(_getFundingStatsCacheSize()).toBe(1);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const z = await getFundingZScore(a, 0.0002);
    expect(typeof z).toBe('number');
    expect(Number.isFinite(z!)).toBe(true);

    // No miss log because the cache was already populated by bulk-warm
    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[funding-cache] miss coin='),
    ).length;
    expect(missLogs).toBe(0);
  });

  // ── Test 4: Math equivalence — bulk vs per-coin ──
  it('math equivalence: bulk-warm output matches per-coin path byte-for-byte', async () => {
    // Seed one coin with non-trivial variance
    const a = uniq('MATH_EQUIV_A');
    const rates = [0.0001, 0.00015, 0.00008, 0.00012, 0.00009, 0.00011, 0.00013,
                   0.00014, 0.00010, 0.00007, 0.00016, 0.00006, 0.00018, 0.00004,
                   0.00020, 0.00002, 0.00022, 0.00005, 0.00017, 0.00003,
                   0.00019, 0.00021, 0.00023, 0.00024, 0.00025];
    for (const r of rates) recordFunding(a, r);

    // Path 1: per-coin via getFundingZScore — populates cache via loadFundingStats
    const zPerCoin = await getFundingZScore(a, 0.0001);
    // Capture stats from the cache (mean + stdDev are what matter)
    const perCoinMean = (
      // We can't directly read FundingStats from the public API, so use a
      // canonical reference: zPerCoin = (currentFunding - mean) / stdDev,
      // and for currentFunding === mean → z === 0. Solve for mean by binary
      // search? Simpler: clear cache, populate via bulk, compute the same
      // z-score, assert equality.
      0
    );
    void perCoinMean;

    // Path 2: clear cache, bulk-warm same coin, compute z-score via cache
    _clearFundingStatsCache();
    await bulkWarmFundingCache([a]);
    const zBulk = await getFundingZScore(a, 0.0001);

    // The two z-scores must be IDENTICAL (within float tolerance) because
    // both paths read the same N rows + use the same formulas.
    expect(zBulk).not.toBeNull();
    expect(zPerCoin).not.toBeNull();
    expect(zBulk!).toBeCloseTo(zPerCoin!, 10);

    // Sanity: a different currentFunding should also produce identical
    // z-scores between the two paths.
    _clearFundingStatsCache();
    const zPerCoin2 = await getFundingZScore(a, 0.00018);
    _clearFundingStatsCache();
    await bulkWarmFundingCache([a]);
    const zBulk2 = await getFundingZScore(a, 0.00018);
    expect(zBulk2).not.toBeNull();
    expect(zPerCoin2).not.toBeNull();
    expect(zBulk2!).toBeCloseTo(zPerCoin2!, 10);
  });

  // ── Test 5: Mixed (cached + cold) → only cold coins re-fetched ──
  it('mixed input: pre-cached coins skipped; only cold coins re-fetched', async () => {
    const cachedA = uniq('MIXED_CACHED_A');
    const cachedB = uniq('MIXED_CACHED_B');
    const coldA = uniq('MIXED_COLD_A');
    const coldB = uniq('MIXED_COLD_B');

    // Pre-populate two via test seam (no DB)
    _setFundingStatsForTest(cachedA, {
      mean: 0.0001, stdDev: 0.00005, sampleCount: 50, computedAt: Date.now(),
    });
    _setFundingStatsForTest(cachedB, {
      mean: 0.0002, stdDev: 0.00008, sampleCount: 60, computedAt: Date.now(),
    });
    expect(_getFundingStatsCacheSize()).toBe(2);

    // Add real rows for the cold pair
    for (const r of makeRows(50)) {
      recordFunding(coldA, r.funding_rate);
      recordFunding(coldB, r.funding_rate);
    }

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await bulkWarmFundingCache([cachedA, cachedB, coldA, coldB]);

    expect(_getFundingStatsCacheSize()).toBe(4);

    // Bulk-warm summary should report n_in=4, n_warmed=2, n_cached=2
    const bulkLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' &&
      args[0].includes('[funding-cache] bulk-warm') &&
      args[0].includes('n_in=4') &&
      args[0].includes('n_warmed=2') &&
      args[0].includes('n_cached=2'),
    ).length;
    expect(bulkLogs).toBe(1);
  });

  // ── Test 6: <20 rows → cached as negative entry; getFundingZScore returns null ──
  it('coin with <20 rows is cached as negative entry (sampleCount<20)', async () => {
    const a = uniq('THIN_BULK');
    for (const r of makeRows(5)) recordFunding(a, r.funding_rate);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await bulkWarmFundingCache([a]);
    expect(_getFundingStatsCacheSize()).toBe(1);

    // Subsequent getFundingZScore must return null AND not fire a per-coin DB miss
    const z = await getFundingZScore(a, 0.0001);
    expect(z).toBeNull();

    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[funding-cache] miss coin='),
    ).length;
    expect(missLogs).toBe(0);
  });

  // ── Test 7: Zero rows → negative entry (sampleCount: 0) ──
  it('coin with zero rows in window gets a negative-entry cache (sampleCount=0)', async () => {
    const a = uniq('ZERO_ROWS_BULK');
    // Do NOT recordFunding for `a` — it has no rows
    expect(_getFundingStatsCacheSize()).toBe(0);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await bulkWarmFundingCache([a]);

    // Negative entry MUST be cached so per-coin path doesn't re-query
    expect(_getFundingStatsCacheSize()).toBe(1);

    const z = await getFundingZScore(a, 0.0001);
    expect(z).toBeNull();

    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[funding-cache] miss coin='),
    ).length;
    expect(missLogs).toBe(0);
  });

  // ── Test 8: TTL expiry → next bulk-warm re-fetches everything ──
  it('TTL-expired entries are re-fetched by next bulk-warm', async () => {
    const a = uniq('TTL_BULK_A');
    const b = uniq('TTL_BULK_B');

    // Seed cache with stale entries (>5 min old)
    _setFundingStatsForTest(a, {
      mean: 0.0001, stdDev: 0.00005, sampleCount: 50,
      computedAt: Date.now() - 6 * 60 * 1000,
    });
    _setFundingStatsForTest(b, {
      mean: 0.0002, stdDev: 0.00008, sampleCount: 60,
      computedAt: Date.now() - 6 * 60 * 1000,
    });
    expect(_getFundingStatsCacheSize()).toBe(2);

    // Add real rows so bulk-warm finds data
    for (const r of makeRows(50, 0.0003, 0.00009)) {
      recordFunding(a, r.funding_rate);
      recordFunding(b, r.funding_rate);
    }

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await bulkWarmFundingCache([a, b]);

    // Both stale entries replaced — n_warmed=2, n_cached=0
    const bulkLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' &&
      args[0].includes('[funding-cache] bulk-warm') &&
      args[0].includes('n_warmed=2') &&
      args[0].includes('n_cached=0'),
    ).length;
    expect(bulkLogs).toBe(1);
    expect(_getFundingStatsCacheSize()).toBe(2);
  });
});
