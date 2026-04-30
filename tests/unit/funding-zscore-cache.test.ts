/**
 * Unit tests for OPTIMIZE-FUNDING-CACHE-W1.
 *
 * The cache is a 5-min TTL `Map<coin, FundingStats>` with stampede
 * protection via an in-flight promise map. These tests verify:
 *
 *   1. First call (cache miss) hits DB, returns z-score, populates cache
 *   2. Second call within TTL (cache hit) does NOT hit DB
 *   3. Call after TTL expires re-fetches
 *   4. 10 parallel cache-miss callers for the same coin → 1 DB query
 *   5. rows.length < 20 → returns null + caches negative result
 *   6. stdDev === 0 (all rates identical) → returns 0, cached
 *   7. Different coins cache independently
 *   8. `_clearFundingStatsCache()` resets to clean slate
 *
 * Strategy: mock the SQLite backend's `all()` method via `vi.spyOn` after
 * the first `getBackend()` call. Use `_setFundingStatsForTest` for cache-hit
 * scenarios that don't need a DB hit at all. Use vitest fake timers for the
 * TTL-expiry test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getFundingZScore,
  _clearFundingStatsCache,
  _setFundingStatsForTest,
  _getFundingStatsCacheSize,
  recordFunding,
} from '../../src/lib/performance-db.js';

// Build N synthetic funding rows with controlled mean + stdDev properties.
function makeRows(n: number, base: number = 0.0001, jitter: number = 0.00005): { funding_rate: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    funding_rate: base + (i % 2 === 0 ? jitter : -jitter),
  }));
}

// Run-unique suffix so tests are isolated from leftover rows in the
// persistent SQLite DB at ~/.crypto-quant-signal/performance.db. Each
// `npm test` run gets fresh coin names.
const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function uniq(name: string): string {
  return `${name}_${RUN_ID}`;
}

describe('OPTIMIZE-FUNDING-CACHE-W1: getFundingZScore cache', () => {
  beforeEach(() => {
    _clearFundingStatsCache();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Test 1: First call (cache miss) hits DB, returns z-score, populates cache ──
  it('first call hits DB and populates cache', async () => {
    // Seed via the public recordFunding API (uses real backend)
    const rows = makeRows(50, 0.0001, 0.00005);
    for (const r of rows) recordFunding(uniq('TEST_COIN_1'), r.funding_rate);

    expect(_getFundingStatsCacheSize()).toBe(0);

    const result = await getFundingZScore(uniq('TEST_COIN_1'), 0.0002);
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result!)).toBe(true);
    expect(_getFundingStatsCacheSize()).toBe(1);
  });

  // ── Test 2: Second call within TTL (cache hit) does NOT hit DB ──
  it('second call within TTL is cache hit (no DB roundtrip)', async () => {
    // Seed cache directly via the test seam — pretends we've already loaded.
    _setFundingStatsForTest(uniq('CACHED_COIN'), {
      mean: 0.0001,
      stdDev: 0.00005,
      sampleCount: 50,
      computedAt: Date.now(),
    });
    expect(_getFundingStatsCacheSize()).toBe(1);

    // Spy on console.debug to detect any cache-miss log (which would indicate
    // the DB path executed). With the cache hit, NO miss log fires.
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const z1 = await getFundingZScore(uniq('CACHED_COIN'), 0.0002);
    const z2 = await getFundingZScore(uniq('CACHED_COIN'), 0.0003);
    const z3 = await getFundingZScore(uniq('CACHED_COIN'), 0.0001);

    // Same cached stats → deterministic z-scores
    expect(z1).toBeCloseTo((0.0002 - 0.0001) / 0.00005, 10);
    expect(z2).toBeCloseTo((0.0003 - 0.0001) / 0.00005, 10);
    expect(z3).toBeCloseTo((0.0001 - 0.0001) / 0.00005, 10);

    // No `[funding-cache] miss` calls — cache served all 3 reads
    const missCallCount = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[funding-cache] miss'),
    ).length;
    expect(missCallCount).toBe(0);
  });

  // ── Test 3: Call after TTL expires re-fetches ──
  it('call after TTL expires triggers re-fetch', async () => {
    // Seed cache with a stale entry (computedAt > 5min ago)
    _setFundingStatsForTest(uniq('TTL_COIN'), {
      mean: 0.0001,
      stdDev: 0.00005,
      sampleCount: 50,
      computedAt: Date.now() - 6 * 60 * 1000, // 6 min ago — stale
    });
    expect(_getFundingStatsCacheSize()).toBe(1);

    // Add real funding rows via recordFunding so the re-fetch finds data
    const rows = makeRows(50, 0.0002, 0.00005); // different mean to detect re-load
    for (const r of rows) recordFunding(uniq('TTL_COIN'), r.funding_rate);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const result = await getFundingZScore(uniq('TTL_COIN'), 0.0003);
    expect(typeof result).toBe('number');

    // The miss log MUST have fired because the stale entry triggered re-load
    const missCallCount = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes(`[funding-cache] miss coin=${uniq('TTL_COIN')}`),
    ).length;
    expect(missCallCount).toBe(1);
  });

  // ── Test 4: 10 parallel cache-miss callers for SAME coin → 1 DB query ──
  it('parallel cache-miss callers coalesce into a single DB query', async () => {
    const rows = makeRows(50);
    for (const r of rows) recordFunding(uniq('PARALLEL_COIN'), r.funding_rate);
    expect(_getFundingStatsCacheSize()).toBe(0);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // Fire 10 parallel cache-miss calls
    const results = await Promise.all([
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0001),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0002),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0003),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0001),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0002),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0003),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0001),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0002),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0003),
      getFundingZScore(uniq('PARALLEL_COIN'), 0.0001),
    ]);

    // All 10 receive valid numbers
    for (const r of results) expect(typeof r).toBe('number');

    // Despite 10 parallel callers, exactly ONE DB miss fired (the rest
    // attached to the in-flight promise via fundingStatsInflight).
    const missCallCount = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes(`[funding-cache] miss coin=${uniq('PARALLEL_COIN')}`),
    ).length;
    expect(missCallCount).toBe(1);

    expect(_getFundingStatsCacheSize()).toBe(1);
  });

  // ── Test 5: rows.length < 20 → returns null + caches negative result ──
  it('insufficient samples returns null AND caches the negative result', async () => {
    // Only 5 rows — well below the 20-sample minimum
    const rows = makeRows(5);
    for (const r of rows) recordFunding(uniq('THIN_COIN'), r.funding_rate);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const r1 = await getFundingZScore(uniq('THIN_COIN'), 0.0001);
    expect(r1).toBeNull();
    expect(_getFundingStatsCacheSize()).toBe(1);

    // Second call within TTL must NOT fire another DB query
    const r2 = await getFundingZScore(uniq('THIN_COIN'), 0.0002);
    expect(r2).toBeNull();

    const missCallCount = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes(`[funding-cache] miss coin=${uniq('THIN_COIN')}`),
    ).length;
    // Exactly 1 DB miss (the first call); the second hit the cached negative
    expect(missCallCount).toBe(1);
  });

  // ── Test 6: stdDev === 0 (all funding rates identical) → returns 0, cached ──
  it('stdDev === 0 returns 0 and caches', async () => {
    // 50 identical funding rates → stdDev = 0
    for (let i = 0; i < 50; i++) recordFunding(uniq('FLAT_COIN'), 0.0001);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const r1 = await getFundingZScore(uniq('FLAT_COIN'), 0.0005);
    expect(r1).toBe(0);
    expect(_getFundingStatsCacheSize()).toBe(1);

    // Second call within TTL stays cached → still 0, no DB hit
    const r2 = await getFundingZScore(uniq('FLAT_COIN'), 0.0009);
    expect(r2).toBe(0);

    const missCallCount = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes(`[funding-cache] miss coin=${uniq('FLAT_COIN')}`),
    ).length;
    expect(missCallCount).toBe(1);
  });

  // ── Test 7: Different coins cache independently ──
  it('different coins cache independently', async () => {
    const btcRows = makeRows(50, 0.0001, 0.00005);
    const ethRows = makeRows(50, 0.0002, 0.00008);
    for (const r of btcRows) recordFunding(uniq('BTC_TEST'), r.funding_rate);
    for (const r of ethRows) recordFunding(uniq('ETH_TEST'), r.funding_rate);

    expect(_getFundingStatsCacheSize()).toBe(0);

    const btcZ = await getFundingZScore(uniq('BTC_TEST'), 0.0001);
    expect(_getFundingStatsCacheSize()).toBe(1);
    const ethZ = await getFundingZScore(uniq('ETH_TEST'), 0.0002);
    expect(_getFundingStatsCacheSize()).toBe(2);

    expect(typeof btcZ).toBe('number');
    expect(typeof ethZ).toBe('number');
    // Coins have different bases; their z-scores from the same query should
    // differ.
    expect(btcZ).not.toBe(ethZ);

    // Querying BTC_TEST again is a cache hit — size stays at 2
    await getFundingZScore(uniq('BTC_TEST'), 0.0005);
    expect(_getFundingStatsCacheSize()).toBe(2);
  });

  // ── Test 8: _clearFundingStatsCache() resets to clean slate ──
  it('_clearFundingStatsCache() empties cache + inflight maps', async () => {
    _setFundingStatsForTest(uniq('CLEAR_TEST_A'), {
      mean: 0.0001, stdDev: 0.00005, sampleCount: 50, computedAt: Date.now(),
    });
    _setFundingStatsForTest(uniq('CLEAR_TEST_B'), {
      mean: 0.0002, stdDev: 0.00008, sampleCount: 60, computedAt: Date.now(),
    });
    expect(_getFundingStatsCacheSize()).toBe(2);

    _clearFundingStatsCache();
    expect(_getFundingStatsCacheSize()).toBe(0);

    // Next call for a previously-cached coin must be a true cache miss
    // (i.e. fall through to loadFundingStats).
    const rows = makeRows(50);
    for (const r of rows) recordFunding(uniq('CLEAR_TEST_A'), r.funding_rate);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await getFundingZScore(uniq('CLEAR_TEST_A'), 0.0001);
    const missCallCount = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes(`[funding-cache] miss coin=${uniq('CLEAR_TEST_A')}`),
    ).length;
    expect(missCallCount).toBe(1);
    expect(_getFundingStatsCacheSize()).toBe(1);
  });
});
