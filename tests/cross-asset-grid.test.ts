import { describe, it, expect, beforeEach } from 'vitest';

import {
  GRID_ASSETS,
  GRID_TIMEFRAMES,
  getGridSnapshot,
  getClosestTradeable,
  getTryNext,
  refreshGridIfStale,
  _setSnapshotForTest,
  _clearCache,
  _setScorerOverride,
} from '../src/lib/cross-asset-grid.js';
import type { GridCell } from '../src/types.js';

// ── Synthetic scorer factories ────────────────────────────────────────────
//
// All tests bypass the real `getTradeSignal` (which hits live exchange APIs)
// by injecting a synthetic scorer via `_setScorerOverride`. Each factory
// returns both the scorer and a counter so we can assert call counts.

interface OverrideHandle {
  scorer: (coin: string, timeframe: string) => Promise<GridCell | null>;
  callCount: () => number;
}

function makeBuyScorer(confidence = 70): OverrideHandle {
  let count = 0;
  return {
    scorer: async (coin, timeframe) => {
      count++;
      return {
        coin,
        timeframe,
        signal: 'BUY',
        confidence,
        exchange: 'HL',
        regime: 'TRENDING_UP',
      };
    },
    callCount: () => count,
  };
}

describe('cross-asset-grid', () => {
  beforeEach(() => {
    _clearCache();
    _setScorerOverride(null);
  });

  // ── Test 1: Grid shape ─────────────────────────────────────────────────
  it('refreshes a full 6×4 grid and returns one cell per (asset, timeframe)', async () => {
    const handle = makeBuyScorer();
    _setScorerOverride(handle.scorer);

    const snapshot = await getGridSnapshot();

    expect(snapshot).toHaveLength(GRID_ASSETS.length * GRID_TIMEFRAMES.length);
    expect(snapshot).toHaveLength(24);

    for (const coin of GRID_ASSETS) {
      for (const timeframe of GRID_TIMEFRAMES) {
        const cell = snapshot.find(
          (c) => c.coin === coin && c.timeframe === timeframe
        );
        expect(cell, `missing cell ${coin}/${timeframe}`).toBeDefined();
        expect(cell?.signal).toBe('BUY');
      }
    }
  });

  // ── Test 2: TTL behavior — no refresh within 60s ───────────────────────
  it('does not refresh on a second call within the TTL window', async () => {
    const handle = makeBuyScorer();
    _setScorerOverride(handle.scorer);

    const first = await getGridSnapshot();
    const second = await getGridSnapshot();

    expect(handle.callCount()).toBe(24);
    // Same array reference: the cached snapshot is returned, not re-built.
    expect(second).toBe(first);
  });

  // ── Test 3: TTL behavior — refresh after TTL expires ───────────────────
  it('refreshes the grid after the TTL window has elapsed', async () => {
    const handle = makeBuyScorer();
    _setScorerOverride(handle.scorer);

    const first = await getGridSnapshot();
    expect(handle.callCount()).toBe(24);

    // Backdate the cached snapshot so it appears stale (>60s old).
    _setSnapshotForTest(first, Date.now() - 61_000);

    await getGridSnapshot();
    expect(handle.callCount()).toBe(48);
  });

  // ── Test 4: Promise coalescing ─────────────────────────────────────────
  it('coalesces parallel snapshot requests into a single refresh', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let count = 0;
    const slowScorer = async (coin: string, timeframe: string): Promise<GridCell> => {
      count++;
      await gate;
      return {
        coin,
        timeframe,
        signal: 'BUY',
        confidence: 70,
        exchange: 'HL',
        regime: 'TRENDING_UP',
      };
    };
    _setScorerOverride(slowScorer);

    // Kick off 5 parallel snapshot requests. They should all coalesce into
    // a single in-flight refresh and share its result.
    const calls = [
      getGridSnapshot(),
      getGridSnapshot(),
      getGridSnapshot(),
      getGridSnapshot(),
      getGridSnapshot(),
    ];

    // Yield to let the first refresh enter its for-loop and call the scorer
    // on the first cell, then release the gate so the loop can finish.
    await Promise.resolve();
    releaseGate();

    const results = await Promise.all(calls);

    // Exactly one full refresh — 24 scorer invocations, not 5 × 24 = 120.
    expect(count).toBe(24);
    // All five callers received the same coalesced snapshot.
    for (const result of results) {
      expect(result).toHaveLength(24);
      expect(result).toBe(results[0]);
    }
  });

  // ── Test 5: Cell failure isolation ─────────────────────────────────────
  it('skips a single failing cell without crashing the entire refresh', async () => {
    const failingScorer = async (coin: string, timeframe: string): Promise<GridCell> => {
      if (coin === 'ETH' && timeframe === '1h') {
        throw new Error('synthetic scorer failure');
      }
      return {
        coin,
        timeframe,
        signal: 'BUY',
        confidence: 70,
        exchange: 'HL',
        regime: 'TRENDING_UP',
      };
    };
    _setScorerOverride(failingScorer);

    const snapshot = await getGridSnapshot();

    expect(snapshot).toHaveLength(23);
    expect(
      snapshot.find((c) => c.coin === 'ETH' && c.timeframe === '1h')
    ).toBeUndefined();
  });

  // ── Test 6: getClosestTradeable + getTryNext ───────────────────────────
  it('selects the highest-confidence non-HOLD cell (excluding the requested key)', async () => {
    // Deterministic snapshot covering all 24 (coin, tf) slots:
    //   • A handful of mixed signals at known confidences
    //   • Remaining slots filled with low-confidence HOLDs
    const seeded: GridCell[] = [];
    for (const coin of GRID_ASSETS) {
      for (const timeframe of GRID_TIMEFRAMES) {
        seeded.push({
          coin,
          timeframe,
          signal: 'HOLD',
          confidence: 30,
          exchange: 'HL',
          regime: 'RANGING',
        });
      }
    }
    const setCell = (coin: string, tf: string, patch: Partial<GridCell>) => {
      const idx = seeded.findIndex((c) => c.coin === coin && c.timeframe === tf);
      seeded[idx] = { ...seeded[idx], ...patch };
    };
    setCell('BTC', '1h', { signal: 'HOLD', confidence: 50, regime: 'RANGING' });
    setCell('ETH', '1h', { signal: 'BUY', confidence: 80, regime: 'TRENDING_UP' });
    setCell('SOL', '15m', { signal: 'SELL', confidence: 75, regime: 'TRENDING_DOWN' });
    setCell('DOGE', '5m', { signal: 'BUY', confidence: 65, regime: 'TRENDING_UP' });
    setCell('XRP', '4h', { signal: 'HOLD', confidence: 40, regime: 'RANGING' });

    _setSnapshotForTest(seeded);

    const closest = await getClosestTradeable({ coin: 'BTC', timeframe: '1h' });
    expect(closest).not.toBeNull();
    expect(closest?.coin).toBe('ETH');
    expect(closest?.timeframe).toBe('1h');
    expect(closest?.signal).toBe('BUY');
    expect(closest?.confidence).toBe(80);

    const next = await getTryNext({ coin: 'BTC', timeframe: '1h' }, 3);
    expect(next).toHaveLength(3);
    expect(next[0]).toMatchObject({ coin: 'ETH', timeframe: '1h', signal: 'BUY', confidence: 80 });
    expect(next[1]).toMatchObject({ coin: 'SOL', timeframe: '15m', signal: 'SELL', confidence: 75 });
    expect(next[2]).toMatchObject({ coin: 'DOGE', timeframe: '5m', signal: 'BUY', confidence: 65 });
  });
});

// ── LATENCY-W1 C2: parallel refresh w/ p-limit(6), AsyncLocalStorage preserved ──

describe('refreshGrid parallelism (LATENCY-W1 C2)', () => {
  beforeEach(() => {
    _clearCache();
    _setScorerOverride(null);
  });

  it('AC2.1: 24 cells × 200ms scorer completes in <1s with concurrency 6 (vs ~5s sequential)', async () => {
    let active = 0;
    let peak = 0;
    const scorer = async (coin: string, timeframe: string): Promise<GridCell | null> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 200));
      active -= 1;
      return { coin, timeframe, signal: 'HOLD', confidence: 50, exchange: 'HL', regime: 'RANGING' };
    };
    _setScorerOverride(scorer);

    const start = Date.now();
    await refreshGridIfStale();
    const elapsed = Date.now() - start;

    // 24 cells × 200ms / concurrency 6 ≈ 800ms perfect; allow 1500ms ceiling
    // for vitest jitter + p-limit scheduling overhead. Sequential would be ~4800ms.
    expect(elapsed).toBeLessThan(1500);
    // AC2.2: concurrency cap enforced — peak active count ≤ 6
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1); // sanity: actually parallel, not serial
  });

  it('AC2.3: re-entrancy preserved — scorer that calls getGridSnapshot() returns cache without recursion', async () => {
    // Simulate a cell whose scorer itself calls getGridSnapshot (mirrors the
    // real getTradeSignal → enrichment → getGridSnapshot causal chain).
    // The AsyncLocalStorage flag should propagate through p-limit so the
    // recursive call returns cachedSnapshot ?? [] WITHOUT re-triggering refresh.
    let cellsExecuted = 0;
    let recursiveCallCount = 0;
    let recursiveCallReturnedQuickly = true;

    const scorer = async (coin: string, timeframe: string): Promise<GridCell | null> => {
      cellsExecuted += 1;
      // Inside the scorer, call getGridSnapshot — this is the re-entry case.
      const t0 = Date.now();
      const snap = await getGridSnapshot();
      const recursionElapsed = Date.now() - t0;
      recursiveCallCount += 1;
      // If re-entry guard works, this returns near-instantly with empty/cached
      // snapshot (no recursive refresh). If broken, this would deadlock or
      // recurse — we'd see >>1ms.
      if (recursionElapsed > 50) recursiveCallReturnedQuickly = false;
      // Returned snapshot can be empty (mid-refresh) — that's expected re-entry behavior.
      void snap;
      return { coin, timeframe, signal: 'BUY', confidence: 60, exchange: 'HL', regime: 'TRENDING_UP' };
    };
    _setScorerOverride(scorer);

    await refreshGridIfStale();

    // All 24 cells must complete (no hang from recursive deadlock)
    expect(cellsExecuted).toBe(GRID_ASSETS.length * GRID_TIMEFRAMES.length);
    // Each cell did one re-entrant snapshot call
    expect(recursiveCallCount).toBe(GRID_ASSETS.length * GRID_TIMEFRAMES.length);
    // Re-entrancy guard returned synchronously (no deep recursion)
    expect(recursiveCallReturnedQuickly).toBe(true);
    // Final snapshot has all 24 cells
    const finalSnap = await getGridSnapshot();
    expect(finalSnap).toHaveLength(GRID_ASSETS.length * GRID_TIMEFRAMES.length);
  });

  it('refreshGridIfStale: returns immediately when cache fresh (no scorer call)', async () => {
    let scorerCalls = 0;
    _setScorerOverride(async () => {
      scorerCalls += 1;
      return { coin: 'X', timeframe: '1h', signal: 'HOLD', confidence: 0, exchange: 'HL', regime: 'RANGING' };
    });
    // Seed a fresh snapshot
    _setSnapshotForTest([{ coin: 'BTC', timeframe: '1h', signal: 'BUY', confidence: 80, exchange: 'HL', regime: 'TRENDING_UP' }]);

    const start = Date.now();
    await refreshGridIfStale();
    const elapsed = Date.now() - start;

    expect(scorerCalls).toBe(0); // no refresh triggered
    expect(elapsed).toBeLessThan(20); // returned synchronously
  });

  it('refreshGridIfStale: concurrent calls share one inflight refresh (no thundering herd)', async () => {
    let scorerCalls = 0;
    _setScorerOverride(async (coin, timeframe) => {
      scorerCalls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return { coin, timeframe, signal: 'HOLD', confidence: 50, exchange: 'HL', regime: 'RANGING' };
    });
    _clearCache();

    // Fire 5 concurrent refresh requests; only ONE should actually refresh
    await Promise.all([
      refreshGridIfStale(),
      refreshGridIfStale(),
      refreshGridIfStale(),
      refreshGridIfStale(),
      refreshGridIfStale(),
    ]);

    // Exactly 24 scorer calls (one full refresh), not 5 × 24 = 120
    expect(scorerCalls).toBe(GRID_ASSETS.length * GRID_TIMEFRAMES.length);
  });

  it('cell failure isolation preserved under parallel refresh', async () => {
    let cellNum = 0;
    const scorer = async (coin: string, timeframe: string): Promise<GridCell | null> => {
      cellNum += 1;
      // Throw on every 3rd cell
      if (cellNum % 3 === 0) throw new Error(`synthetic failure ${coin}/${timeframe}`);
      return { coin, timeframe, signal: 'BUY', confidence: 70, exchange: 'HL', regime: 'TRENDING_UP' };
    };
    _setScorerOverride(scorer);

    await refreshGridIfStale();
    const snap = await getGridSnapshot();

    // 24 cells total, 8 failed (every 3rd) → 16 should succeed
    expect(snap.length).toBeGreaterThan(0);
    expect(snap.length).toBeLessThan(GRID_ASSETS.length * GRID_TIMEFRAMES.length);
    // No cell with the failure marker leaks through
    expect(snap.every((c) => c.signal === 'BUY')).toBe(true);
  });
});
