/**
 * SCAN-RANKBY-W1 CH1 — getRankedUniverse: per-lens sorting + funding shortlist.
 *
 * fetchVenueUniverse + the funding sources are module-mocked; no live API is hit.
 * Funding correctness is exercised on a same-call venue (Bybit), the bulk-2nd-call
 * venue (Binance premiumIndex), and the per-instId+cache venue (OKX).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExchangeAsset } from '../../src/lib/exchange-universe.js';

vi.mock('../../src/lib/exchange-universe.js', () => ({
  fetchVenueUniverse: vi.fn(),
  getExchangeTopAssetsWithVolume: vi.fn(),
}));
vi.mock('../../src/lib/adapters/binance.js', () => ({
  getPremiumIndexBulkCoalesced: vi.fn(),
}));
vi.mock('../../src/lib/adapters/okx.js', () => ({
  toOKXInstId: (coin: string) => `${coin}-USDT-SWAP`,
}));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', () => ({
  upstreamFetch: vi.fn(),
  VENUE_FETCH_CONFIGS: { OKX: {}, BINANCE: {}, BYBIT: {}, BITGET: {}, HL: {} },
}));
// SCAN-RANKBY-W2: volatility uses getAdapter(ex).getCandles for ATRP.
vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

// SCAN-RANKBY-W3: oi_change reads computeOiDeltaForPool over the oi_snapshots store.
vi.mock('../../src/lib/oi-snapshots.js', () => ({
  computeOiDeltaForPool: vi.fn(),
  DEFAULT_OI_WINDOW_MS: 86_400_000,
  // SCAN-RANKBY-REFINEMENTS-W1 CH1: rank-metrics now imports these too — a partial
  // mock MUST list them or they resolve `undefined` (incomplete-partial-mock trap).
  OI_WINDOWS: { '1h': 3_600_000, '4h': 14_400_000, '24h': 86_400_000 },
  DEFAULT_OI_WINDOW: '24h',
}));
// SCAN-RANKBY-REFINEMENTS-W1 CH2: the full-universe OKX funding cache gates the funding branch.
vi.mock('../../src/lib/okx-funding-poller.js', () => ({ getOkxFullFundingIfWarm: vi.fn() }));

import { fetchVenueUniverse } from '../../src/lib/exchange-universe.js';
import { getPremiumIndexBulkCoalesced } from '../../src/lib/adapters/binance.js';
import { upstreamFetch } from '../../src/lib/adapters/_upstream-fetch.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { getRankedUniverse, _resetRankMetricsForTest } from '../../src/lib/rank-metrics.js';
import { computeOiDeltaForPool } from '../../src/lib/oi-snapshots.js';
import { getOkxFullFundingIfWarm } from '../../src/lib/okx-funding-poller.js';
import type { Candle } from '../../src/types.js';

const mockUniverse = vi.mocked(fetchVenueUniverse);
const mockPremium = vi.mocked(getPremiumIndexBulkCoalesced);
const mockUpstream = vi.mocked(upstreamFetch);
const mockGetAdapter = vi.mocked(getAdapter);
const mockOiDelta = vi.mocked(computeOiDeltaForPool);
const mockFullFunding = vi.mocked(getOkxFullFundingIfWarm);

function asset(
  coin: string,
  oi: number,
  vol: number,
  chg?: number,
  funding?: number,
  interval?: number,
): ExchangeAsset {
  return {
    coin,
    notionalOI_usd: oi,
    volume24h_usd: vol,
    changePct24h: chg,
    fundingRate: funding,
    fundingIntervalHours: interval,
  };
}

beforeEach(() => {
  _resetRankMetricsForTest();
  mockUniverse.mockReset();
  mockPremium.mockReset();
  mockUpstream.mockReset();
  mockGetAdapter.mockReset();
  mockFullFunding.mockReset();
  mockFullFunding.mockResolvedValue(null); // CH2: default cold → funding falls back to the shortlist
});
afterEach(() => _resetRankMetricsForTest());

// OI-desc fixture (as fetchVenueUniverse returns). chg = signed 24h %.
function uni(): ExchangeAsset[] {
  return [
    asset('BTC', 1000, 50, +1.0, -0.0001, 8),
    asset('ETH', 900, 80, -3.0, +0.0005, 8),
    asset('SOL', 800, 95, +12.0, -0.0009, 8),
    asset('XRP', 700, 60, -8.0, +0.0002, 8),
    asset('DOGE', 600, 40, +0.5, -0.0003, 8),
  ];
}

describe('getRankedUniverse — non-funding lenses (full universe)', () => {
  it('oi: OI-desc, rank_value = OI, no echo fields', async () => {
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'oi', 3);
    expect(r.map((a) => a.coin)).toEqual(['BTC', 'ETH', 'SOL']);
    expect(r[0].rank_value).toBe(1000);
    expect(r[0].change_24h_pct).toBeUndefined();
    expect(r[0].volume_24h).toBeUndefined();
    expect(r[0].funding_rate).toBeUndefined();
  });

  it('volume: volume-desc + volume_24h echo', async () => {
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'volume', 3);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'ETH', 'XRP']); // 95, 80, 60
    expect(r[0].rank_value).toBe(95);
    expect(r[0].volume_24h).toBe(95);
  });

  it('gainers: 24h%-desc + change_24h_pct echo', async () => {
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'gainers', 3);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'BTC', 'DOGE']); // +12, +1, +0.5
    expect(r[0].change_24h_pct).toBe(12);
  });

  it('losers: 24h%-asc (most negative first)', async () => {
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'losers', 3);
    expect(r.map((a) => a.coin)).toEqual(['XRP', 'ETH', 'DOGE']); // -8, -3, +0.5
    expect(r[0].change_24h_pct).toBe(-8);
  });

  it('movers: |24h%|-desc (biggest either direction)', async () => {
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'movers', 3);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'XRP', 'ETH']); // |12|, |8|, |3|
  });
});

describe('getRankedUniverse — funding lenses (uniform shortlist)', () => {
  it('Bybit funding_negative: same-call funding, asc, with APR', async () => {
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'funding_negative', 3);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'DOGE', 'BTC']); // -0.0009, -0.0003, -0.0001
    expect(r[0].funding_rate).toBe(-0.0009);
    expect(r[0].funding_apr).toBeCloseTo(-0.0009 * 3 * 365, 9); // 8h → ×1095
  });

  it('Bybit funding_positive: desc (most positive first)', async () => {
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'funding_positive', 2);
    expect(r.map((a) => a.coin)).toEqual(['ETH', 'XRP']); // +0.0005, +0.0002
  });

  it('Binance funding: joins the bulk premiumIndex (no funding on the ticker)', async () => {
    // Binance fetcher leaves fundingRate undefined → augment joins premiumIndex.
    const binUni = uni().map((a) => ({ ...a, fundingRate: undefined }));
    mockUniverse.mockResolvedValue(binUni);
    mockPremium.mockResolvedValue([
      { symbol: 'BTCUSDT', markPrice: '0', lastFundingRate: '-0.0001', nextFundingTime: 0 },
      { symbol: 'SOLUSDT', markPrice: '0', lastFundingRate: '-0.0009', nextFundingTime: 0 },
      { symbol: 'ETHUSDT', markPrice: '0', lastFundingRate: '0.0005', nextFundingTime: 0 },
    ] as never);
    const r = await getRankedUniverse('BINANCE', 'funding_negative', 2);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'BTC']); // only the 3 joined, asc
    expect(r[0].funding_rate).toBe(-0.0009);
    expect(mockPremium).toHaveBeenCalledTimes(1);
  });

  it('OKX funding: per-instId fetch over the pool, served via the cache', async () => {
    const okxUni = uni().map((a) => ({ ...a, fundingRate: undefined }));
    mockUniverse.mockResolvedValue(okxUni);
    const fundingByInst: Record<string, string> = {
      'BTC-USDT-SWAP': '-0.0001',
      'ETH-USDT-SWAP': '0.0005',
      'SOL-USDT-SWAP': '-0.0009',
      'XRP-USDT-SWAP': '0.0002',
      'DOGE-USDT-SWAP': '-0.0003',
    };
    mockUpstream.mockImplementation(async (_cfg: unknown, opts: unknown) => {
      const url = (opts as { url: string }).url;
      const inst = decodeURIComponent(url.split('instId=')[1] ?? '');
      return { data: [{ fundingRate: fundingByInst[inst] ?? '' }] } as never;
    });
    const r = await getRankedUniverse('OKX', 'funding_negative', 2);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'DOGE']); // -0.0009, -0.0003
    expect(r[0].funding_rate).toBe(-0.0009);
    expect(r[0].funding_apr).toBeCloseTo(-0.0009 * 3 * 365, 9);
  });

  // ── SCAN-RANKBY-REFINEMENTS-W1 CH2: OKX full-universe funding (warm) ──
  it('OKX funding ranks the FULL universe from the warm full cache (no shortlist fan-out)', async () => {
    mockUniverse.mockResolvedValue(uni()); // 5 coins
    mockFullFunding.mockResolvedValue(
      new Map([['BTC', 0.001], ['ETH', 0.002], ['SOL', -0.005], ['XRP', -0.004], ['DOGE', 0.003]]),
    );
    const r = await getRankedUniverse('OKX', 'funding_negative', 3);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'XRP', 'BTC']); // full-cache funding asc
    expect(r[0].funding_rate).toBe(-0.005);
    expect(mockUpstream).not.toHaveBeenCalled(); // full cache used → NO per-instId shortlist fan-out
  });

  it('OKX funding ignores the full cache for the OTHER 4 venues (BYBIT stays shortlist)', async () => {
    mockFullFunding.mockResolvedValue(new Map([['BTC', -0.99]])); // would distort if wrongly applied
    mockUniverse.mockResolvedValue(uni());
    const r = await getRankedUniverse('BYBIT', 'funding_negative', 1);
    expect(r[0].coin).toBe('SOL'); // BYBIT bulk funding (uni: SOL -0.0009 is most negative), NOT BTC -0.99
    expect(mockFullFunding).not.toHaveBeenCalled(); // only OKX consults the full cache
  });

  it('funding ranks EXCLUDE coins with no resolvable funding', async () => {
    const u = [asset('BTC', 1000, 50, 1, -0.0001, 8), asset('ETH', 900, 80, -3, undefined, 8)];
    mockUniverse.mockResolvedValue(u);
    const r = await getRankedUniverse('BYBIT', 'funding_negative', 5);
    expect(r.map((a) => a.coin)).toEqual(['BTC']); // ETH dropped (no funding)
  });
});

describe('getRankedUniverse — volatility (ATRP, SCAN-RANKBY-W2)', () => {
  // Flat constant-range candles → ATRP == atrpTarget (see rank-atr.test.ts).
  function flatCandles(atrpTarget: number, price = 100, n = 20): Candle[] {
    const d = (atrpTarget * price) / 200;
    return Array.from({ length: n }, (_, i) => ({ open: price, high: price + d, low: price - d, close: price, volume: 1, time: i }));
  }
  function setAtrpFixture(byCoin: Record<string, number>) {
    mockUniverse.mockResolvedValue(Object.keys(byCoin).map((coin, i) => asset(coin, (100 - i) * 1e6, 1e6)));
    mockGetAdapter.mockReturnValue({ getCandles: async (coin: string) => flatCandles(byCoin[coin]) } as never);
  }

  it('ranks the pool by ATRP desc + echoes atrp (not funding/change)', async () => {
    setAtrpFixture({ AAA: 1, BBB: 3, CCC: 2 });
    const r = await getRankedUniverse('BYBIT', 'volatility', 3, '15m');
    expect(r.map((a) => a.coin)).toEqual(['BBB', 'CCC', 'AAA']); // ATRP 3, 2, 1
    expect(r[0].atrp).toBeCloseTo(3, 6);
    expect(r[0].rank_value).toBeCloseTo(3, 6);
    expect(r[0]).not.toHaveProperty('funding_rate');
    expect(r[0]).not.toHaveProperty('change_24h_pct');
  });

  it('excludes coins with insufficient candles (null ATRP)', async () => {
    mockUniverse.mockResolvedValue([asset('AAA', 9e9, 1e6), asset('BBB', 8e9, 1e6)]);
    mockGetAdapter.mockReturnValue({
      getCandles: async (coin: string) => (coin === 'AAA' ? flatCandles(2) : flatCandles(2, 100, 5)),
    } as never);
    const r = await getRankedUniverse('BYBIT', 'volatility', 5, '15m');
    expect(r.map((a) => a.coin)).toEqual(['AAA']); // BBB dropped (5 candles < 15)
  });
});

describe('getRankedUniverse — oi_change (real OI delta, SCAN-RANKBY-W3)', () => {
  it('ranks the pool by OI %Δ desc + echoes oi_change_pct/window (the store is the universe — no fetch)', async () => {
    mockOiDelta.mockResolvedValue(
      new Map([
        ['BTC', { oi_change_pct: 2.1, oi_change_window: '24h' }],
        ['SOL', { oi_change_pct: 9.4, oi_change_window: '24h' }],
        ['ETH', { oi_change_pct: -3.0, oi_change_window: '24h' }],
      ]),
    );
    const r = await getRankedUniverse('BYBIT', 'oi_change', 2);
    expect(r.map((a) => a.coin)).toEqual(['SOL', 'BTC']); // desc by OI %Δ, top-2
    expect(r[0]).toMatchObject({ coin: 'SOL', rankBy: 'oi_change', rank_value: 9.4, oi_change_pct: 9.4, oi_change_window: '24h' });
    expect(r[0]).not.toHaveProperty('atrp');
    expect(mockOiDelta).toHaveBeenCalledWith('BYBIT', 86_400_000);
    expect(mockUniverse).not.toHaveBeenCalled(); // the store is the universe — no venue fetch
  });

  it('warming: an empty store → empty result (never blocks the scan)', async () => {
    mockOiDelta.mockResolvedValue(new Map());
    const r = await getRankedUniverse('OKX', 'oi_change', 20);
    expect(r).toEqual([]);
  });

  // ── SCAN-RANKBY-REFINEMENTS-W1 CH1: trader-selectable OI-delta window ──
  it('CH1: oiChangeWindow="4h" resolves to the 4h window-ms + echoes "4h"', async () => {
    mockOiDelta.mockResolvedValue(new Map([['BTC', { oi_change_pct: 1.2, oi_change_window: '4h' }]]));
    const r = await getRankedUniverse('BYBIT', 'oi_change', 5, '15m', { oiChangeWindow: '4h' });
    expect(r[0]).toMatchObject({ coin: 'BTC', oi_change_pct: 1.2, oi_change_window: '4h' });
    expect(mockOiDelta).toHaveBeenCalledWith('BYBIT', 14_400_000); // 4h in ms
  });

  it('CH1: omitted oiChangeWindow defaults to 24h (byte-identical)', async () => {
    mockOiDelta.mockResolvedValue(new Map([['BTC', { oi_change_pct: 2.1, oi_change_window: '24h' }]]));
    await getRankedUniverse('BYBIT', 'oi_change', 5);
    expect(mockOiDelta).toHaveBeenCalledWith('BYBIT', 86_400_000); // 24h default
  });

  it('CH1: distinct windows resolve to distinct store reads (no cross-serve)', async () => {
    // Keyed by the window-ms so the assertion is robust to the cache's internal
    // load-invocation count (TTL/loadTimeout implementation detail).
    mockOiDelta.mockImplementation(async (_ex: string, windowMs: number) =>
      windowMs === 3_600_000
        ? new Map([['BTC', { oi_change_pct: 0.3, oi_change_window: '1h' }]])
        : new Map([['BTC', { oi_change_pct: 2.1, oi_change_window: '24h' }]]),
    );
    const a = await getRankedUniverse('BYBIT', 'oi_change', 5, '15m', { oiChangeWindow: '1h' });
    const b = await getRankedUniverse('BYBIT', 'oi_change', 5, '15m', { oiChangeWindow: '24h' });
    expect(a[0].oi_change_window).toBe('1h');
    expect(b[0].oi_change_window).toBe('24h'); // distinct cache keys never cross-serve
    expect(mockOiDelta).toHaveBeenCalledWith('BYBIT', 3_600_000); // the 1h window-ms
    expect(mockOiDelta).toHaveBeenCalledWith('BYBIT', 86_400_000); // the 24h window-ms
  });
});
