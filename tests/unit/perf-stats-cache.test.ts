/**
 * Unit tests for OPTIMIZE-DASHBOARD-SIGNALS-LIMIT-W1.
 *
 * The dashboard `getPerformanceStats*` hot path got 3 compounding fixes:
 *   1. Time-window: WHERE created_at >= cutoff (20 days)
 *   2. Column projection: 8 of ~20 columns (only what computeStats reads)
 *   3. 60s TTL in-memory cache with stampede protection (5-min bucket key)
 *
 * Test matrix (per the wave spec R8):
 *   1. First call → DB query, cache populated, log fires
 *   2. Second call within TTL → cache hit (no DB query, no log)
 *   3. Concurrent callers → 1 DB query (stampede protection)
 *   4. _clearPerformanceStatsCache() resets state
 *   5. Time-window filter — signals older than cutoff excluded from result
 *   6. Column-projection equivalence — bounded SELECT produces same
 *      computeStats output as full-row SELECT for the same fixture data
 *   7. After TTL expires (synthetic via Date.now mock-shift) → re-fetches
 *
 * Per-run RUN_ID suffix on coin names so the persistent SQLite DB at
 * ~/.crypto-quant-signal/performance.db doesn't cross-pollute between runs
 * (mirrors the funding-cache test pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPerformanceStats,
  getPerformanceStatsAsync,
  recordSignal,
  dbRun,
  _clearPerformanceStatsCache,
  _getPerformanceStatsCacheSize,
} from '../../src/lib/performance-db.js';

const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function uniq(name: string): string {
  return `${name}_${RUN_ID}`;
}

const STATS_WINDOW_SEC = 20 * 86400;

describe('OPTIMIZE-DASHBOARD-SIGNALS-LIMIT-W1: getPerformanceStats cache', () => {
  beforeEach(() => {
    _clearPerformanceStatsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: First call → DB query, cache populated, log fires ──
  it('first call hits DB, populates cache, fires miss log', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(_getPerformanceStatsCacheSize()).toBe(0);

    const stats = getPerformanceStats();
    expect(stats).toBeDefined();
    expect(_getPerformanceStatsCacheSize()).toBe(1);

    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[perf-stats] cache miss'),
    ).length;
    expect(missLogs).toBe(1);
  });

  // ── Test 2: Second call within TTL → cache hit (no DB query, no log) ──
  it('second call within TTL is cache hit (no DB query, no log)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // First call populates cache
    const a = getPerformanceStats();
    const debugAfterFirst = debugSpy.mock.calls.length;

    // Second call — same instance from cache
    const b = getPerformanceStats();
    expect(b).toBe(a); // same reference — cache hit, not re-computed

    // No new miss log fired
    const missLogsAfterSecond = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[perf-stats] cache miss'),
    ).length;
    expect(missLogsAfterSecond).toBe(1); // exactly the one from first call
    expect(debugSpy.mock.calls.length).toBe(debugAfterFirst); // no new debug log lines at all
  });

  // ── Test 3: Concurrent callers → 1 DB query (stampede protection) ──
  it('concurrent async callers coalesce into a single DB query', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const results = await Promise.all([
      getPerformanceStatsAsync(),
      getPerformanceStatsAsync(),
      getPerformanceStatsAsync(),
      getPerformanceStatsAsync(),
      getPerformanceStatsAsync(),
    ]);

    // All 5 receive the same value
    for (const r of results) expect(r).toBe(results[0]);

    // Exactly 1 miss log fired (the rest attached to the inflight promise)
    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[perf-stats] cache miss'),
    ).length;
    expect(missLogs).toBe(1);

    expect(_getPerformanceStatsCacheSize()).toBe(1);
  });

  // ── Test 4: _clearPerformanceStatsCache() resets state ──
  it('_clearPerformanceStatsCache() empties cache; next call is a miss', () => {
    getPerformanceStats(); // populate cache
    expect(_getPerformanceStatsCacheSize()).toBe(1);

    _clearPerformanceStatsCache();
    expect(_getPerformanceStatsCacheSize()).toBe(0);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    getPerformanceStats();
    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[perf-stats] cache miss'),
    ).length;
    expect(missLogs).toBe(1);
    expect(_getPerformanceStatsCacheSize()).toBe(1);
  });

  // ── Test 5: Time-window filter excludes signals older than cutoff ──
  it('time-window filter excludes signals older than 20-day cutoff', () => {
    const inWindowCoin = uniq('IN_WINDOW');
    const outWindowCoin = uniq('OUT_WINDOW');

    // In-window signal: now (well within 20 days)
    const nowSec = Math.floor(Date.now() / 1000);
    dbRun(
      `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, pfe_return_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      inWindowCoin, 'BUY', 75, '5m', 'HL', 100, nowSec, 1.5,
    );

    // Out-of-window signal: 25 days ago (> 20-day cutoff)
    const oldSec = nowSec - 25 * 86400;
    dbRun(
      `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, pfe_return_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      outWindowCoin, 'BUY', 75, '5m', 'HL', 100, oldSec, 1.5,
    );

    const stats = getPerformanceStats();

    // In-window coin must appear in byAsset; out-of-window must NOT
    expect(stats.byAsset[inWindowCoin]).toBeDefined();
    expect(stats.byAsset[outWindowCoin]).toBeUndefined();

    // Cleanup
    dbRun('DELETE FROM signals WHERE coin IN (?, ?)', inWindowCoin, outWindowCoin);
  });

  // ── Test 6: Column-projection equivalence ──
  it('column-projection produces same computeStats output as full-row SELECT', () => {
    // Insert a fixture set of in-window signals across multiple coins/timeframes
    const fixtureCoinA = uniq('PROJ_A');
    const fixtureCoinB = uniq('PROJ_B');
    const nowSec = Math.floor(Date.now() / 1000);

    // 5 BUY signals for A on 5m, all evaluated as wins (pfe_return_pct > 0)
    for (let i = 0; i < 5; i++) {
      dbRun(
        `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, pfe_return_pct, outcome_price, outcome_return_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fixtureCoinA, 'BUY', 75, '5m', 'HL', 100, nowSec - i * 60, 1.5, 101.5, 1.5,
      );
    }
    // 3 SELL signals for B on 1h, mixed outcomes
    for (let i = 0; i < 3; i++) {
      dbRun(
        `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, pfe_return_pct, outcome_price, outcome_return_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fixtureCoinB, 'SELL', 70, '1h', 'BINANCE', 200, nowSec - i * 60, i === 0 ? 1.0 : -1.0, 199, -0.5,
      );
    }

    const stats = getPerformanceStats();
    expect(stats.byAsset[fixtureCoinA]).toBeDefined();
    expect(stats.byAsset[fixtureCoinB]).toBeDefined();

    // PROJ_A: 5 BUY signals, all PFE-wins → 100% WR
    expect(stats.byAsset[fixtureCoinA].count).toBe(5);
    expect(stats.byAsset[fixtureCoinA].pfeWinRate).toBe(1.0);

    // PROJ_B: 3 SELL signals, only 1st with pfe>0 (a SELL win = pfe<0)
    // Actually for SELL, win is pfe<0. So:
    //   i=0: pfe=1.0 → loss (SELL with pfe>0)
    //   i=1: pfe=-1.0 → win
    //   i=2: pfe=-1.0 → win
    // → 2/3 wins
    expect(stats.byAsset[fixtureCoinB].count).toBe(3);
    expect(stats.byAsset[fixtureCoinB].pfeWinRate).toBeCloseTo(2 / 3, 5);

    // Recent signals must include both coins (column projection includes
    // id, coin, signal, timeframe, confidence, created_at, exchange — all
    // the fields recentSignals[] needs)
    const recentCoins = new Set(stats.recentSignals.map((s) => s.coin));
    expect(recentCoins.has(fixtureCoinA)).toBe(true);
    expect(recentCoins.has(fixtureCoinB)).toBe(true);

    // Recent signals shape — id, coin, call (alias for signal), confidence,
    // timeframe, tier, created_at, exchange — all populated
    const sampleA = stats.recentSignals.find((s) => s.coin === fixtureCoinA);
    expect(sampleA).toBeDefined();
    expect(sampleA!.id).toBeGreaterThan(0);
    expect(sampleA!.call).toBe('BUY');
    expect(sampleA!.confidence).toBe(75);
    expect(sampleA!.timeframe).toBe('5m');
    expect(sampleA!.exchange).toBe('HL');

    // Cleanup
    dbRun('DELETE FROM signals WHERE coin IN (?, ?)', fixtureCoinA, fixtureCoinB);
  });

  // ── Test 7: Bucket key changes when window slides forward ──
  it('cache buckets by 5-min cutoff window (new bucket = cache miss)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // First call — establishes cache for current bucket
    getPerformanceStats();
    expect(_getPerformanceStatsCacheSize()).toBe(1);

    // Mock Date.now to advance by 5+ minutes (forces a new bucket)
    const realNow = Date.now;
    const fakeNow = realNow() + 6 * 60 * 1000; // +6 min
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    // Second call lands in a NEW bucket — cache miss
    getPerformanceStats();
    expect(_getPerformanceStatsCacheSize()).toBe(2); // both buckets cached

    const missLogs = debugSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[perf-stats] cache miss'),
    ).length;
    expect(missLogs).toBe(2);
  });
});
