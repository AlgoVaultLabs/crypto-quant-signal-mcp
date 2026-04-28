/**
 * Integration test (v1.10.0 C4): exercises full getTradeSignal() to confirm
 * `also_see` is populated with trimmed cells AND `try_next` (legacy) still
 * carries full GridCell shape during the dual-emit window.
 *
 * Asserts:
 *   - also_see is present with ≤3 cells (top-3 confidence)
 *   - every also_see cell has exactly the 3 keys {coin, timeframe, confidence}
 *   - also_see cells DO NOT carry signal/exchange/regime (the leak surface)
 *   - try_next continues to carry full GridCell shape (deprecation window)
 *   - closest_tradeable (verdict=HOLD) has trimmed shape too
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
}));

import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import {
  _setSnapshotForTest,
  _clearCache,
  _setScorerOverride,
} from '../../src/lib/cross-asset-grid.js';
import type { ExchangeAdapter, Candle, AssetContext, GridCell } from '../../src/types.js';

// Flat-price candles drive scorer to HOLD on BTC/1h (so closest_tradeable is populated).
const flatCandles = (count: number, basePrice = 3000): Candle[] =>
  Array.from({ length: count }, (_, i) => ({
    open: basePrice - 0.5,
    high: basePrice + 1,
    low: basePrice - 1,
    close: basePrice + Math.sin(i) * 5,
    volume: 1000,
    time: Date.now() - (count - i) * 3_600_000,
  }));

const ctx = (coin: string): AssetContext => ({
  coin,
  funding: 0.00001,
  fundingAnnualized: 0.00001 * 8760,
  openInterest: 5_000_000,
  prevDayPx: 3000,
  volume24h: 125_000_000,
  oraclePx: 3000,
  markPx: 3000,
});

const makeAdapter = (): ExchangeAdapter => ({
  getName: () => 'MockExchange',
  getCandles: vi.fn().mockResolvedValue(flatCandles(200)),
  getAssetContext: vi.fn().mockResolvedValue(ctx('BTC')),
  getPredictedFundings: vi.fn().mockResolvedValue([]),
  getFundingHistory: vi.fn().mockResolvedValue([]),
  getCurrentPrice: vi.fn().mockResolvedValue(3000),
});

// 5 non-HOLD cells of varying confidence + a HOLD on the requested (BTC,1h):
// top-3 by confidence: ETH/1h/BUY/80, SOL/15m/SELL/75, DOGE/5m/BUY/65.
const snapshot = (): GridCell[] => [
  { coin: 'BTC', timeframe: '1h', signal: 'HOLD', confidence: 50, exchange: 'HL', regime: 'RANGING' },
  { coin: 'ETH', timeframe: '1h', signal: 'BUY',  confidence: 80, exchange: 'HL', regime: 'TRENDING_UP' },
  { coin: 'SOL', timeframe: '15m', signal: 'SELL', confidence: 75, exchange: 'HL', regime: 'TRENDING_DOWN' },
  { coin: 'DOGE', timeframe: '5m', signal: 'BUY', confidence: 65, exchange: 'HL', regime: 'TRENDING_UP' },
  { coin: 'XRP', timeframe: '4h', signal: 'BUY', confidence: 60, exchange: 'HL', regime: 'TRENDING_UP' },
  { coin: 'BNB', timeframe: '4h', signal: 'SELL', confidence: 55, exchange: 'HL', regime: 'TRENDING_DOWN' },
];

describe('also_see — trimmed cells + dual-emit invariant with try_next', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest(snapshot());
    vi.mocked(getAdapter).mockReturnValue(makeAdapter());
  });

  it('also_see is present with len ≤ 3', async () => {
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    expect(result.also_see).toBeDefined();
    expect(Array.isArray(result.also_see)).toBe(true);
    expect(result.also_see!.length).toBeLessThanOrEqual(3);
    expect(result.also_see!.length).toBeGreaterThan(0);
  });

  it('every also_see cell has EXACTLY the 3 trimmed keys {coin, timeframe, confidence}', async () => {
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    for (const cell of result.also_see!) {
      const keys = Object.keys(cell).sort();
      expect(keys).toEqual(['coin', 'confidence', 'timeframe']);
    }
  });

  it('also_see cells do NOT contain signal/exchange/regime (leak prevention)', async () => {
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    for (const cell of result.also_see!) {
      expect((cell as unknown as { signal?: unknown }).signal).toBeUndefined();
      expect((cell as unknown as { exchange?: unknown }).exchange).toBeUndefined();
      expect((cell as unknown as { regime?: unknown }).regime).toBeUndefined();
    }
  });

  it('also_see content matches top-3 by confidence (ETH/1h, SOL/15m, DOGE/5m)', async () => {
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    expect(result.also_see).toEqual([
      { coin: 'ETH', timeframe: '1h', confidence: 80 },
      { coin: 'SOL', timeframe: '15m', confidence: 75 },
      { coin: 'DOGE', timeframe: '5m', confidence: 65 },
    ]);
  });

  it('try_next continues to carry FULL GridCell shape during dual-emit window', async () => {
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    expect(result.try_next).toBeDefined();
    expect(result.try_next!.length).toBeGreaterThan(0);
    for (const cell of result.try_next!) {
      // Full GridCell carries signal/exchange/regime
      expect(cell.signal).toBeDefined();
      expect(cell.exchange).toBeDefined();
      expect(cell.regime).toBeDefined();
      // Sanity: still has the trimmed-cell keys too
      expect(cell.coin).toBeDefined();
      expect(cell.timeframe).toBeDefined();
      expect(cell.confidence).toBeDefined();
    }
  });

  it('try_next.length === also_see.length (dual-emit from same source)', async () => {
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    expect(result.try_next!.length).toBe(result.also_see!.length);
  });

  it('closest_tradeable on HOLD verdict is trimmed to LeaderboardCell shape', async () => {
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    // Flat-price candles drive HOLD verdict on BTC/1h
    expect(result.signal).toBe('HOLD');
    expect(result.closest_tradeable).toBeDefined();
    const keys = Object.keys(result.closest_tradeable!).sort();
    expect(keys).toEqual(['coin', 'confidence', 'timeframe']);
    expect((result.closest_tradeable as unknown as { signal?: unknown }).signal).toBeUndefined();
    expect((result.closest_tradeable as unknown as { exchange?: unknown }).exchange).toBeUndefined();
    expect((result.closest_tradeable as unknown as { regime?: unknown }).regime).toBeUndefined();
    // Top non-HOLD cell is ETH/1h BUY 80
    expect(result.closest_tradeable).toEqual({ coin: 'ETH', timeframe: '1h', confidence: 80 });
  });
});
