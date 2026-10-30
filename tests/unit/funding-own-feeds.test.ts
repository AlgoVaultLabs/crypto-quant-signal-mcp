/**
 * DECISION-CALL-V1-W1 R3 + R4 — funding rows corrected at the source.
 *
 * Each adapter is driven through the shared transport with fixtures of the real wire shapes
 * (field names and value types sampled from each venue on 2026-10-30): every row carries its
 * contract's interval and next funding time, a rate `safeUpstreamNum` cannot read drops the row,
 * and a real 0 rate stays.
 *   BINANCE  /fapi/v1/premiumIndex + /fapi/v1/fundingInfo (`fundingIntervalHours`; absent = 8 h; one
 *            fundingInfo call per hour, stale-ok)
 *   BYBIT    /v5/market/tickers?category=linear (`fundingIntervalHour`, a string)
 *   OKX      ONE /api/v5/public/funding-rate?instId=ANY; next time = `fundingTime`, interval = the gap
 *   BITGET   /api/v2/mix/market/current-fund-rate (`fundingRateInterval`, `nextUpdate`)
 *   HL       predictedFundings `fundingIntervalHours` passed through as `intervalHours` (R4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BinanceAdapter, _resetBinanceAdapterCaches } from '../../src/lib/adapters/binance.js';
import { BybitAdapter } from '../../src/lib/adapters/bybit.js';
import { OKXAdapter } from '../../src/lib/adapters/okx.js';
import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';
import { HyperliquidAdapter, _resetHyperliquidPredictedFundingsCache } from '../../src/lib/adapters/hyperliquid.js';
import { normalizeVenueFunding } from '../../src/lib/venue-market-state.js';
import type { FundingData } from '../../src/types.js';

const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const H = 3_600_000;
const NEXT = T0 + 2 * H;

type Route = (url: URL, init?: RequestInit) => unknown;
const calls: string[] = [];

function route(r: Route): void {
  vi.spyOn(global, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const body = r(url, init);
    if (body instanceof Error) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
}

const venue = (rows: FundingData[], coin: string) => rows.find((r) => r.coin === coin)?.venues[0];

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  _resetBinanceAdapterCaches();
  _resetHyperliquidPredictedFundingsCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _resetBinanceAdapterCaches();
  _resetHyperliquidPredictedFundingsCache();
});

// ── BINANCE ─────────────────────────────────────────────────────────────────────────────────────

const PREMIUM_INDEX = [
  { symbol: 'BTCUSDT', markPrice: '76867.4', indexPrice: '76887.4', lastFundingRate: '0.00010000', interestRate: '0.00010000', nextFundingTime: NEXT, time: T0 },
  { symbol: 'EIGENUSDT', markPrice: '1.2', indexPrice: '1.2', lastFundingRate: '0.00030000', interestRate: '0.0001', nextFundingTime: T0 + H, time: T0 },
  { symbol: 'HOTUSDT', markPrice: '0.001', indexPrice: '0.001', lastFundingRate: '-0.00050000', interestRate: '0.0001', nextFundingTime: T0 + H / 2, time: T0 },
  { symbol: 'ZEROUSDT', markPrice: '1', indexPrice: '1', lastFundingRate: '0.00000000', interestRate: '0.0001', nextFundingTime: NEXT, time: T0 },
  { symbol: 'BADUSDT', markPrice: '1', indexPrice: '1', lastFundingRate: '0x1', interestRate: '0.0001', nextFundingTime: NEXT, time: T0 },
  { symbol: 'BTCUSDC', markPrice: '76867.4', indexPrice: '76887.4', lastFundingRate: '0.0001', interestRate: '0.0001', nextFundingTime: NEXT, time: T0 },
];
const FUNDING_INFO = [
  { symbol: 'EIGENUSDT', adjustedFundingRateCap: '0.02', adjustedFundingRateFloor: '-0.02', fundingIntervalHours: 4, disclaimer: false, updateTime: T0 - H },
  { symbol: 'HOTUSDT', adjustedFundingRateCap: '0.02', adjustedFundingRateFloor: '-0.02', fundingIntervalHours: 1, disclaimer: false, updateTime: T0 - H },
];

function binanceRoutes(fundingInfo: () => unknown = () => FUNDING_INFO): void {
  route((url) => {
    if (url.pathname === '/fapi/v1/premiumIndex') return PREMIUM_INDEX;
    if (url.pathname === '/fapi/v1/fundingInfo') return fundingInfo();
    return {};
  });
}
const fundingInfoCalls = () => calls.filter((c) => c.startsWith('/fapi/v1/fundingInfo')).length;

describe('BINANCE — premiumIndex + fundingInfo', () => {
  it('each USDT row carries its contract interval (fundingInfo, absent = 8 h) and next funding time', async () => {
    binanceRoutes();
    const rows = await new BinanceAdapter().getPredictedFundings();
    expect(venue(rows, 'BTC')).toEqual({ venue: 'BinPerp', fundingRate: 0.0001, nextFundingTime: NEXT, intervalHours: 8 });
    expect(venue(rows, 'EIGEN')).toEqual({ venue: 'BinPerp', fundingRate: 0.0003, nextFundingTime: T0 + H, intervalHours: 4 });
    expect(venue(rows, 'HOT')?.intervalHours).toBe(1);
    expect(rows.map((r) => r.coin)).not.toContain('BTCUSDC');
  });

  it('an unreadable rate drops the row; a 0 rate stays', async () => {
    binanceRoutes();
    const rows = await new BinanceAdapter().getPredictedFundings();
    expect(venue(rows, 'BAD')).toBeUndefined();
    expect(venue(rows, 'ZERO')?.fundingRate).toBe(0);
  });

  it('one fundingInfo call per hour across many reads', async () => {
    binanceRoutes();
    const a = new BinanceAdapter();
    for (let m = 0; m < 60; m += 10) {
      vi.setSystemTime(new Date(T0 + m * 60_000));
      await a.getPredictedFundings();
    }
    expect(fundingInfoCalls()).toBe(1);
    vi.setSystemTime(new Date(T0 + H));
    await a.getPredictedFundings();
    expect(fundingInfoCalls()).toBe(2);
  });

  it('a fundingInfo failure after a success serves the stale intervals', async () => {
    let fail = false;
    binanceRoutes(() => (fail ? new Error('down') : FUNDING_INFO));
    const a = new BinanceAdapter();
    await a.getPredictedFundings();
    fail = true;
    vi.setSystemTime(new Date(T0 + H + 1));
    const rows = await a.getPredictedFundings();
    expect(venue(rows, 'EIGEN')?.intervalHours).toBe(4);
  });

  it('a cold fundingInfo failure fails the feed — never a guessed interval', async () => {
    binanceRoutes(() => new Error('down'));
    await expect(new BinanceAdapter().getPredictedFundings()).rejects.toThrow();
  });

  it('a 4 h row normalizes to twice the declared-8 h hourly rate', async () => {
    binanceRoutes();
    const eigen = venue(await new BinanceAdapter().getPredictedFundings(), 'EIGEN')!;
    const n = normalizeVenueFunding(eigen)!;
    expect(n.intervalBasis).toBe('contract');
    expect(n.hourlyRate).toBeCloseTo(0.0003 / 4, 15);
    expect(n.hourlyRate / normalizeVenueFunding({ ...eigen, intervalHours: undefined })!.hourlyRate).toBeCloseTo(2, 12);
  });
});

// ── BYBIT ───────────────────────────────────────────────────────────────────────────────────────

const BYBIT_TICKERS = {
  retCode: 0, retMsg: 'OK', time: T0,
  result: {
    category: 'linear',
    list: [
      { symbol: 'BTCUSDT', lastPrice: '76800', markPrice: '76800', fundingRate: '0.0001', nextFundingTime: String(NEXT), fundingIntervalHour: '8', volume24h: '1', turnover24h: '1', prevPrice24h: '76000' },
      { symbol: 'AVAXUSDT', lastPrice: '20', markPrice: '20', fundingRate: '-0.0002', nextFundingTime: String(T0 + H), fundingIntervalHour: '4', volume24h: '1', turnover24h: '1', prevPrice24h: '20' },
      { symbol: 'ODDUSDT', lastPrice: '1', markPrice: '1', fundingRate: '0.0001', nextFundingTime: String(NEXT), fundingIntervalHour: '', volume24h: '1', turnover24h: '1', prevPrice24h: '1' },
      { symbol: 'ZEROUSDT', lastPrice: '1', markPrice: '1', fundingRate: '0', nextFundingTime: String(NEXT), fundingIntervalHour: '8', volume24h: '1', turnover24h: '1', prevPrice24h: '1' },
      { symbol: 'BADUSDT', lastPrice: '1', markPrice: '1', fundingRate: '', nextFundingTime: String(NEXT), fundingIntervalHour: '8', volume24h: '1', turnover24h: '1', prevPrice24h: '1' },
      { symbol: 'BTCUSDT-06NOV26', lastPrice: '76800', markPrice: '76800', fundingRate: '', nextFundingTime: '0', fundingIntervalHour: '', volume24h: '1', turnover24h: '1', prevPrice24h: '1' },
    ],
  },
};

describe('BYBIT — linear tickers', () => {
  it('rows carry fundingIntervalHour and nextFundingTime; dated futures are excluded', async () => {
    route(() => BYBIT_TICKERS);
    const rows = await new BybitAdapter().getPredictedFundings();
    expect(calls).toEqual(['/v5/market/tickers?category=linear']);
    expect(venue(rows, 'BTC')).toEqual({ venue: 'BybitPerp', fundingRate: 0.0001, nextFundingTime: NEXT, intervalHours: 8 });
    expect(venue(rows, 'AVAX')).toEqual({ venue: 'BybitPerp', fundingRate: -0.0002, nextFundingTime: T0 + H, intervalHours: 4 });
    expect(rows.some((r) => r.coin.includes('-'))).toBe(false);
  });

  it('a present-but-empty interval is NaN, so the row self-skips downstream', async () => {
    route(() => BYBIT_TICKERS);
    const odd = venue(await new BybitAdapter().getPredictedFundings(), 'ODD')!;
    expect(odd.intervalHours).toBeNaN();
    expect(normalizeVenueFunding(odd)).toBeNull();
  });

  it('an unreadable rate drops the row; a 0 rate stays', async () => {
    route(() => BYBIT_TICKERS);
    const rows = await new BybitAdapter().getPredictedFundings();
    expect(venue(rows, 'BAD')).toBeUndefined();
    expect(venue(rows, 'ZERO')?.fundingRate).toBe(0);
  });
});

// ── OKX ─────────────────────────────────────────────────────────────────────────────────────────

const okxRow = (instId: string, fundingRate: string, fundingTime: number, nextFundingTime: number) => ({
  formulaType: 'withRate', fundingRate, fundingTime: String(fundingTime), impactValue: '20000', instId, instType: 'SWAP',
  interestRate: '0.0001', maxFundingRate: '0.00375', method: 'current_period', minFundingRate: '-0.00375', nextFundingRate: '',
  nextFundingTime: String(nextFundingTime), premium: '-0.0001', prevFundingTime: String(fundingTime - 8 * H), settFundingRate: '0.00005',
  settState: 'settled', ts: String(T0),
});
const OKX_ANY = {
  code: '0', msg: '',
  data: [
    okxRow('BTC-USDT-SWAP', '0.0001000000000000', NEXT, NEXT + 8 * H),
    okxRow('SOL-USDT-SWAP', '-0.0002', T0 + H, T0 + 5 * H),
    okxRow('ZERO-USDT-SWAP', '0', NEXT, NEXT + 8 * H),
    okxRow('BAD-USDT-SWAP', 'NaN', NEXT, NEXT + 8 * H),
    okxRow('BTC-USD-SWAP', '0.0001', NEXT, NEXT + 8 * H),
    okxRow('BTC-USD_UM_XPERP-310926', '0.0001', NEXT, NEXT + 8 * H),
  ],
};

describe('OKX — one whole-book funding-rate call', () => {
  it('ONE request with instId=ANY; next time = fundingTime (not one period late); interval = the gap', async () => {
    route(() => OKX_ANY);
    const rows = await new OKXAdapter().getPredictedFundings();
    expect(calls).toEqual(['/api/v5/public/funding-rate?instId=ANY']);
    expect(venue(rows, 'BTC')).toEqual({ venue: 'OKXPerp', fundingRate: 0.0001, nextFundingTime: NEXT, intervalHours: 8 });
    expect(venue(rows, 'SOL')).toEqual({ venue: 'OKXPerp', fundingRate: -0.0002, nextFundingTime: T0 + H, intervalHours: 4 });
  });

  it('only USDT swaps; an unreadable rate drops the row; a 0 rate stays', async () => {
    route(() => OKX_ANY);
    const rows = await new OKXAdapter().getPredictedFundings();
    expect(rows.map((r) => r.coin).sort()).toEqual(['BTC', 'SOL', 'ZERO']);
    expect(venue(rows, 'ZERO')?.fundingRate).toBe(0);
  });
});

// ── BITGET ──────────────────────────────────────────────────────────────────────────────────────

const BITGET_RATES = {
  code: '00000', msg: 'success', requestTime: T0,
  data: [
    { symbol: 'BTCUSDT', fundingRate: '0.0001', fundingRateInterval: '8', nextUpdate: String(NEXT), minFundingRate: '-0.003', maxFundingRate: '0.003' },
    { symbol: 'DOGEUSDT', fundingRate: '0.0004', fundingRateInterval: '4', nextUpdate: String(T0 + H), minFundingRate: '-0.003', maxFundingRate: '0.003' },
    { symbol: 'ZEROUSDT', fundingRate: '0', fundingRateInterval: '1', nextUpdate: String(T0 + H), minFundingRate: '-0.003', maxFundingRate: '0.003' },
    { symbol: 'BADUSDT', fundingRate: '-', fundingRateInterval: '8', nextUpdate: String(NEXT), minFundingRate: '-0.003', maxFundingRate: '0.003' },
  ],
};

describe('BITGET — current-fund-rate', () => {
  it('rows carry fundingRateInterval and nextUpdate (the tickers source had no next time)', async () => {
    route(() => BITGET_RATES);
    const rows = await new BitgetAdapter().getPredictedFundings();
    expect(calls).toEqual(['/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES']);
    expect(venue(rows, 'BTC')).toEqual({ venue: 'BitgetPerp', fundingRate: 0.0001, nextFundingTime: NEXT, intervalHours: 8 });
    expect(venue(rows, 'DOGE')).toEqual({ venue: 'BitgetPerp', fundingRate: 0.0004, nextFundingTime: T0 + H, intervalHours: 4 });
    expect(normalizeVenueFunding(venue(rows, 'DOGE')!)!.exchangeId).toBe('BITGET');
  });

  it('an unreadable rate drops the row; a 0 rate stays', async () => {
    route(() => BITGET_RATES);
    const rows = await new BitgetAdapter().getPredictedFundings();
    expect(venue(rows, 'BAD')).toBeUndefined();
    expect(venue(rows, 'ZERO')).toEqual({ venue: 'BitgetPerp', fundingRate: 0, nextFundingTime: T0 + H, intervalHours: 1 });
  });
});
