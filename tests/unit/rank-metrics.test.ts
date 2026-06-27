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

import { fetchVenueUniverse } from '../../src/lib/exchange-universe.js';
import { getPremiumIndexBulkCoalesced } from '../../src/lib/adapters/binance.js';
import { upstreamFetch } from '../../src/lib/adapters/_upstream-fetch.js';
import { getRankedUniverse, _resetRankMetricsForTest } from '../../src/lib/rank-metrics.js';

const mockUniverse = vi.mocked(fetchVenueUniverse);
const mockPremium = vi.mocked(getPremiumIndexBulkCoalesced);
const mockUpstream = vi.mocked(upstreamFetch);

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

  it('funding ranks EXCLUDE coins with no resolvable funding', async () => {
    const u = [asset('BTC', 1000, 50, 1, -0.0001, 8), asset('ETH', 900, 80, -3, undefined, 8)];
    mockUniverse.mockResolvedValue(u);
    const r = await getRankedUniverse('BYBIT', 'funding_negative', 5);
    expect(r.map((a) => a.coin)).toEqual(['BTC']); // ETH dropped (no funding)
  });
});
