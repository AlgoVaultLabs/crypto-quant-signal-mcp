/**
 * PILOT-ADAPTERS-W2 / C3 — KuCoin Futures adapter unit tests.
 *
 * Asserts:
 *   - Symbol mapping with X-prefix override (BTC → XBT) + M-suffix (USDTM).
 *   - TRADFI_ALIASES (GOLD→XAUT, SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD).
 *   - 26 stocks route DIRECT (TSLA→TSLAUSDTM, NVDA→NVDAUSDTM, etc.).
 *   - SPX intentionally NOT in TRADFI_ALIASES (memecoin trap).
 *   - getCandles parses row-wise [t, o, h, l, c, v]; granularity is INTEGER minutes.
 *   - getAssetContext extracts from single contract endpoint with multiplier-aware OI.
 *   - Funding × 1095 (8h cadence).
 *   - 429 throws UpstreamRateLimitError with exchange="KuCoin".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  KuCoinAdapter,
  toKucoinSymbol,
  fromKucoinSymbol,
  TRADFI_ALIASES,
} from '../../src/lib/adapters/kucoin.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';

interface MockResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

let mockResponses: Map<string, MockResponse>;
let fetchCalls: { url: string }[];
let originalFetch: typeof fetch;

function setMock(urlSubstring: string, response: MockResponse): void {
  mockResponses.set(urlSubstring, response);
}

function buildFetchMock(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url });
    for (const [substr, resp] of mockResponses.entries()) {
      if (url.includes(substr)) {
        return {
          ok: (resp.status ?? 200) >= 200 && (resp.status ?? 200) < 300,
          status: resp.status ?? 200,
          statusText: resp.statusText ?? 'OK',
          headers: {
            get: (name: string) => resp.headers?.[name.toLowerCase()] ?? resp.headers?.[name] ?? null,
          },
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as unknown as Response;
      }
    }
    throw new Error(`[mock-fetch] unhandled URL: ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  mockResponses = new Map();
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

// ── Symbol mapping ───────────────────────────────────────────────────────

describe('toKucoinSymbol / fromKucoinSymbol — X-prefix + M-suffix + TRADFI_ALIASES', () => {
  it('BTC ⇄ XBTUSDTM (X-prefix replaces B per KuCoin legacy convention)', () => {
    expect(toKucoinSymbol('BTC')).toBe('XBTUSDTM');
    expect(fromKucoinSymbol('XBTUSDTM')).toBe('BTC');
  });

  it('ETH ⇄ ETHUSDTM (no X-prefix; M-suffix only)', () => {
    expect(toKucoinSymbol('ETH')).toBe('ETHUSDTM');
    expect(fromKucoinSymbol('ETHUSDTM')).toBe('ETH');
  });

  it('TradFi alias: GOLD ⇄ XAUTUSDTM (only XAUT exists on KuCoin)', () => {
    expect(toKucoinSymbol('GOLD')).toBe('XAUTUSDTM');
    expect(fromKucoinSymbol('XAUTUSDTM')).toBe('GOLD');
  });

  it('TradFi alias: SILVER/PLATINUM/PALLADIUM ⇄ XAG/XPT/XPD', () => {
    expect(toKucoinSymbol('SILVER')).toBe('XAGUSDTM');
    expect(toKucoinSymbol('PLATINUM')).toBe('XPTUSDTM');
    expect(toKucoinSymbol('PALLADIUM')).toBe('XPDUSDTM');
  });

  it('Stocks route DIRECT (TSLA, NVDA, AAPL, AMZN, GOOGL, META, MSTR, COIN, MSFT, TSM)', () => {
    expect(toKucoinSymbol('TSLA')).toBe('TSLAUSDTM');
    expect(toKucoinSymbol('NVDA')).toBe('NVDAUSDTM');
    expect(toKucoinSymbol('AAPL')).toBe('AAPLUSDTM');
    expect(toKucoinSymbol('AMZN')).toBe('AMZNUSDTM');
    expect(toKucoinSymbol('GOOGL')).toBe('GOOGLUSDTM');
    expect(toKucoinSymbol('META')).toBe('METAUSDTM');
    expect(toKucoinSymbol('MSTR')).toBe('MSTRUSDTM');
    expect(toKucoinSymbol('COIN')).toBe('COINUSDTM');
    expect(toKucoinSymbol('MSFT')).toBe('MSFTUSDTM');
    expect(toKucoinSymbol('TSM')).toBe('TSMUSDTM');
  });

  it('COPPER/CL/NATGAS route DIRECT (literal canonical names)', () => {
    expect(toKucoinSymbol('COPPER')).toBe('COPPERUSDTM');
    expect(toKucoinSymbol('CL')).toBe('CLUSDTM');
    expect(toKucoinSymbol('NATGAS')).toBe('NATGASUSDTM');
  });

  it('ETFs EWJ/EWY direct', () => {
    expect(toKucoinSymbol('EWJ')).toBe('EWJUSDTM');
    expect(toKucoinSymbol('EWY')).toBe('EWYUSDTM');
  });

  it('SPX intentionally NOT in TRADFI_ALIASES (memecoin trap per price-probe)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
  });
});

// ── getCandles — row-wise array-of-arrays ────────────────────────────────

describe('KuCoinAdapter.getCandles', () => {
  it('parses [t,o,h,l,c,v] row-wise; granularity is INTEGER minutes (60 for 1h)', async () => {
    setMock('/api/v1/kline/query', {
      status: 200,
      body: {
        code: '200000',
        data: [
          [1779166800000, 76914.7, 77000.0, 76626.1, 76910.6, 75484],
          [1779170400000, 76910.6, 77100, 76800, 77050, 32000],
        ],
      },
    });
    const candles = await new KuCoinAdapter().getCandles('BTC', '1h', 1779000000000);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: 1779166800000,
      open: 76914.7,
      high: 77000,
      low: 76626.1,
      close: 76910.6,
      volume: 75484,
    });
    const klineCall = fetchCalls.find(c => c.url.includes('/kline/query'));
    expect(klineCall?.url).toContain('symbol=XBTUSDTM');
    expect(klineCall?.url).toContain('granularity=60');
  });

  it('maps every canonical timeframe to KuCoin granularity (integer minutes)', async () => {
    setMock('/api/v1/kline/query', { status: 200, body: { code: '200000', data: [] } });
    const adapter = new KuCoinAdapter();
    const expected: [string, number][] = [
      ['1m', 1], ['3m', 3], ['5m', 5], ['15m', 15], ['30m', 30],
      ['1h', 60], ['2h', 120], ['4h', 240], ['8h', 480], ['12h', 720], ['1d', 1440],
    ];
    for (const [tf, gran] of expected) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 1779000000000);
      const call = fetchCalls.find(c => c.url.includes('/kline/query'));
      expect(call?.url, `tf=${tf}`).toContain(`granularity=${gran}`);
    }
  });
});

// ── getAssetContext ──────────────────────────────────────────────────────

describe('KuCoinAdapter.getAssetContext', () => {
  it('reads from single /contracts/{symbol} endpoint with multiplier-aware OI', async () => {
    setMock('/api/v1/contracts/XBTUSDTM', {
      status: 200,
      body: {
        code: '200000',
        data: {
          symbol: 'XBTUSDTM',
          baseCurrency: 'XBT',
          quoteCurrency: 'USDT',
          settleCurrency: 'USDT',
          type: 'FFWCSX',
          fundingFeeRate: -0.000010,
          predictedFundingFeeRate: null,
          nextFundingRateTime: 6361152,
          openInterest: '27608052',       // contracts
          markPrice: 76998.2,
          indexPrice: 77000,
          lastTradePrice: 76998,
          multiplier: 0.001,              // 1 contract = 0.001 BTC
          turnoverOf24h: 100000000,
          highPrice: 78000,
          lowPrice: 76000,
        },
      },
    });
    const ctx = await new KuCoinAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(-0.000010);
    expect(ctx.fundingAnnualized).toBeCloseTo(-0.000010 * 1095); // 8h × 1095
    // openInterest = 27608052 contracts × 0.001 multiplier = 27608.052 BTC
    expect(ctx.openInterest).toBeCloseTo(27608.052);
    expect(ctx.markPx).toBeCloseTo(76998.2);
    expect(ctx.oraclePx).toBeCloseTo(77000);
  });

  it('prevDayPx = 24h-open reconstructed from priceChgPct (FRACTION), NOT 24h-low/last [PREVDAYPX-FIX]', async () => {
    // priceChgPct is present in the LIVE /contracts/{symbol} payload (a FRACTION,
    // 0.0055 = 0.55%; verified live 2026-06-11) though absent from older docs.
    // Scenario: open=95, last=100, low=90, high=110.
    setMock('/api/v1/contracts/XBTUSDTM', {
      status: 200,
      body: {
        code: '200000',
        data: {
          symbol: 'XBTUSDTM', baseCurrency: 'XBT', quoteCurrency: 'USDT', settleCurrency: 'USDT',
          type: 'FFWCSX', fundingFeeRate: 0, nextFundingRateTime: 0,
          openInterest: '0', markPrice: 100, indexPrice: 100, lastTradePrice: 100,
          multiplier: 1, highPrice: 110, lowPrice: 90, priceChgPct: 0.0526316,
        },
      },
    });
    const ctx = await new KuCoinAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo(95, 1);       // lastTradePrice / (1 + priceChgPct)
    expect(ctx.prevDayPx).not.toBeCloseTo(90, 1);   // NOT lowPrice (the bug)
    expect(ctx.prevDayPx).not.toBeCloseTo(100, 1);  // NOT last
  });

  it('routes GOLD via TRADFI_ALIASES → XAUTUSDTM', async () => {
    setMock('/api/v1/contracts/XAUTUSDTM', {
      status: 200,
      body: {
        code: '200000',
        data: { symbol: 'XAUTUSDTM', baseCurrency: 'XAUT', quoteCurrency: 'USDT', settleCurrency: 'USDT', type: 'FFWCSX', fundingFeeRate: 0, nextFundingRateTime: 0, openInterest: '0', markPrice: 4548.69, multiplier: 1 },
      },
    });
    const ctx = await new KuCoinAdapter().getAssetContext('GOLD');
    expect(ctx.markPx).toBeCloseTo(4548.69);
    expect(ctx.coin).toBe('GOLD');
    const call = fetchCalls.find(c => c.url.includes('/contracts/XAUTUSDTM'));
    expect(call).toBeDefined();
  });

  it('throws on empty contract payload', async () => {
    setMock('/api/v1/contracts/UNKNOWNUSDTM', { status: 200, body: { code: '200000', data: null } });
    await expect(new KuCoinAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/empty contract/);
  });
});

// ── getCurrentPrice ──────────────────────────────────────────────────────

describe('KuCoinAdapter.getCurrentPrice', () => {
  it('returns markPrice from contract endpoint', async () => {
    setMock('/api/v1/contracts/XBTUSDTM', {
      status: 200,
      body: { code: '200000', data: { symbol: 'XBTUSDTM', markPrice: 76998.2, fundingFeeRate: 0, openInterest: '0', multiplier: 0.001 } },
    });
    expect(await new KuCoinAdapter().getCurrentPrice('BTC')).toBeCloseTo(76998.2);
  });

  it('returns null on fetch error', async () => {
    setMock('/api/v1/contracts/', { status: 500, statusText: 'Server Error' });
    expect(await new KuCoinAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

// ── 429 rate-limit ───────────────────────────────────────────────────────

describe('KuCoinAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="KuCoin"', async () => {
    setMock('/api/v1/kline/query', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new KuCoinAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('KuCoin');
    }
  }, 10000);
});

// ── Adapter identity ─────────────────────────────────────────────────────

describe('KuCoinAdapter.getName', () => {
  it('returns "KuCoin"', () => {
    expect(new KuCoinAdapter().getName()).toBe('KuCoin');
  });
});
