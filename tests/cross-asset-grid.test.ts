import { describe, it, expect, beforeEach } from 'vitest';

import {
  GRID_ASSETS,
  GRID_TIMEFRAMES,
  getGridSnapshot,
  getClosestTradeable,
  getTryNext,
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
