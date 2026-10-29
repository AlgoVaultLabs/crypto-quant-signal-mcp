/**
 * serving-window-consumers.test.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH1: the two batch consumers of get_trade_call keep
 * working when the `getAdapter` seam refuses a stale window (StaleUpstreamWindowError).
 *
 *   - scan_trade_calls: the refused cell is isolated and tallied in `errors`; every other cell is served.
 *   - the seeder: the refused coin is a SKIP with one line naming the coin and how stale its window is, never an
 *     ERROR, and the rest of the venue seeds.
 * Each is paired with an ordinary failure on the same coin, which keeps its own accounting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getTradeSignal, recordSeedHeartbeat } = vi.hoisted(() => ({
  getTradeSignal: vi.fn(),
  recordSeedHeartbeat: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/tools/get-trade-call.js', () => ({ getTradeSignal }));
vi.mock('../../src/lib/seed-heartbeats.js', () => ({ recordSeedHeartbeat }));
vi.mock('../../src/lib/performance-db.js', () => ({
  hasRecentSignalAsync: vi.fn().mockResolvedValue(false),
  bulkWarmFundingCache: vi.fn().mockResolvedValue(undefined),
  closeDb: vi.fn(),
  isShortLivedScript: () => false,
}));
vi.mock('../../src/lib/venue-store.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/venue-store.js')>()),
  stampSeedingStarted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/exchange-universe.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/exchange-universe.js')>()),
  getExchangeTopAssetsWithVolume: vi.fn(),
}));

import { StaleUpstreamWindowError, VenueMarketClosedError } from '../../src/lib/errors.js';
import { getExchangeTopAssetsWithVolume } from '../../src/lib/exchange-universe.js';
import { scanTradeCalls, _setScanScorerForTest, _clearScanCaches, type ScanScore } from '../../src/lib/trade-call-scanner.js';
import { runVenueSeed } from '../../src/scripts/seed-signals.js';

const NEWEST = Date.UTC(2026, 9, 21, 4);
const refusal = (coin: string, exchange: string, timeframe: string) =>
  new StaleUpstreamWindowError({ coin, exchange, timeframe, newestBarAt: NEWEST, headGapBars: 29, headStaleBars: 17 });

describe('scan_trade_calls isolates a refused cell', () => {
  beforeEach(() => {
    _clearScanCaches();
    vi.mocked(getExchangeTopAssetsWithVolume).mockImplementation((_ex, n: number) =>
      Promise.resolve(Array.from({ length: n }, (_, i) => ({ coin: `COIN${i}`, notionalOI_usd: (n - i) * 1e6, volume24h_usd: (n - i) * 5e5 }))));
  });

  const scorer = (fail: (coin: string) => Error | null) => async (coin: string, timeframe: string): Promise<ScanScore> => {
    const e = fail(coin);
    if (e) throw e;
    return { coin, timeframe, call: 'BUY', confidence: 80 - Number(coin.slice(4)), regime: 'TRENDING_UP' };
  };

  it('the refused cell is tallied in errors; every other cell is served', async () => {
    _setScanScorerForTest(scorer((c) => (c === 'COIN1' ? refusal(c, 'BITGET', '1d') : null)));
    const r = await scanTradeCalls({ topN: 5, timeframe: '1d', exchange: 'BITGET', limit: 10 });
    expect(r).toMatchObject({ scanned: 5, errors: 1, partial: false });
    expect(r.calls.map((c) => c.coin)).toEqual(['COIN0', 'COIN2', 'COIN3', 'COIN4']);
    _setScanScorerForTest(null);
  });

  it('control: no refusal, no error — every cell is served', async () => {
    _setScanScorerForTest(scorer(() => null));
    const r = await scanTradeCalls({ topN: 5, timeframe: '1d', exchange: 'BITGET', limit: 10 });
    expect(r).toMatchObject({ scanned: 5, errors: 0 });
    expect(r.calls).toHaveLength(5);
    _setScanScorerForTest(null);
  });
});

describe('the seeder skips a refused coin with one line, and seeds the rest', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    getTradeSignal.mockReset();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  const seed = () => runVenueSeed('BYBIT', { timeframe: '1h', top: 0, idempotencyWindow: 0, restrictedCoins: ['BTC', 'ETH'] });
  const lines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0]));

  it('a refused coin is a SKIP naming the head gap and the newest bar — never an ERROR', async () => {
    getTradeSignal.mockImplementation(async ({ coin }: { coin: string }) => {
      if (coin === 'BTC') throw refusal('BTC', 'BYBIT', '1h');
      return { call: 'BUY', confidence: 70, price: 100 };
    });
    const res = await seed();
    expect(res).toMatchObject({ seeded: 1, skipped: 1, errors: 0, failed: false });
    expect(lines(log).filter((l) => l.includes('BTC -> SKIP STALE_UPSTREAM_WINDOW'))).toEqual([
      expect.stringMatching(/\[BYBIT\] BTC -> SKIP STALE_UPSTREAM_WINDOW: head gap 29 bars, newest bar 2026-10-21T04:00:00\.000Z$/),
    ]);
    expect(lines(error).filter((l) => l.includes('BTC'))).toEqual([]);
  });

  it('OPS-VENUE-MARKET-CLOSED-W1: a closed market is a SKIP VENUE_MARKET_CLOSED quoting the venue — never an ERROR', async () => {
    getTradeSignal.mockImplementation(async ({ coin }: { coin: string }) => {
      if (coin === 'BTC') {
        throw new VenueMarketClosedError({ venue: 'BINGX', coin: 'BTC', symbol: 'BTC-USDT', source: 'in_band', venueCode: 109415, venueMessage: 'BTC-USDT is pause currently' });
      }
      return { call: 'BUY', confidence: 70, price: 100 };
    });
    const res = await seed();
    expect(res).toMatchObject({ seeded: 1, skipped: 1, errors: 0, failed: false });
    expect(lines(log).filter((l) => l.includes('BTC -> SKIP VENUE_MARKET_CLOSED'))).toEqual([
      expect.stringMatching(/\] BTC -> SKIP VENUE_MARKET_CLOSED: in_band BTC-USDT code 109415 "BTC-USDT is pause currently"$/),
    ]);
    expect(lines(error).filter((l) => l.includes('BTC'))).toEqual([]);
  });

  it('control: an ordinary failure on the same coin is still an ERROR', async () => {
    getTradeSignal.mockImplementation(async ({ coin }: { coin: string }) => {
      if (coin === 'BTC') throw new Error('upstream 500');
      return { call: 'BUY', confidence: 70, price: 100 };
    });
    const res = await seed();
    expect(res).toMatchObject({ seeded: 1, skipped: 0, errors: 1 });
    expect(lines(error).some((l) => l.includes('BTC -> ERROR: upstream 500'))).toBe(true);
  });
});
