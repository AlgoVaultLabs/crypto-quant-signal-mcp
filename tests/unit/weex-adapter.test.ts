/**
 * PILOT-ADAPTERS-W3B / C1 — WEEX adapter unit tests.
 * Symbol cmt_<coin>usdt; funding cadence 4h (x2190); no public funding/OI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  WeexAdapter,
  toWeexSymbol,
  fromWeexSymbol,
  TRADFI_ALIASES,
} from '../../src/lib/adapters/weex.js';
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

describe('toWeexSymbol / fromWeexSymbol — WEEX cmt_<coin>usdt convention', () => {
  it('crypto: BTC ⇄ cmt_btcusdt (lowercase + cmt_ prefix)', () => {
    expect(toWeexSymbol('BTC')).toBe('cmt_btcusdt');
    expect(fromWeexSymbol('cmt_btcusdt')).toBe('BTC');
  });

  it('crypto: ETH ⇄ cmt_ethusdt', () => {
    expect(toWeexSymbol('ETH')).toBe('cmt_ethusdt');
    expect(fromWeexSymbol('cmt_ethusdt')).toBe('ETH');
  });

  it('TradFi alias: SILVER ⇄ cmt_xagusdt (WEEX has NO GOLD/XAU)', () => {
    expect(toWeexSymbol('SILVER')).toBe('cmt_xagusdt');
    expect(fromWeexSymbol('cmt_xagusdt')).toBe('SILVER');
  });

  it('TradFi alias: PLATINUM ⇄ cmt_xptusdt, PALLADIUM ⇄ cmt_xpdusdt, USOIL ⇄ cmt_clusdt', () => {
    expect(toWeexSymbol('PLATINUM')).toBe('cmt_xptusdt');
    expect(toWeexSymbol('PALLADIUM')).toBe('cmt_xpdusdt');
    expect(toWeexSymbol('USOIL')).toBe('cmt_clusdt');
    expect(fromWeexSymbol('cmt_xptusdt')).toBe('PLATINUM');
    expect(fromWeexSymbol('cmt_xpdusdt')).toBe('PALLADIUM');
    expect(fromWeexSymbol('cmt_clusdt')).toBe('USOIL');
  });

  it('TradFi direct (no alias needed): TSLA/NVDA/MSFT/COPPER/NATGAS', () => {
    expect(toWeexSymbol('TSLA')).toBe('cmt_tslausdt');
    expect(toWeexSymbol('NVDA')).toBe('cmt_nvdausdt');
    expect(toWeexSymbol('MSFT')).toBe('cmt_msftusdt');
    expect(toWeexSymbol('COPPER')).toBe('cmt_copperusdt');
    expect(toWeexSymbol('NATGAS')).toBe('cmt_natgasusdt');
  });

  it('SPX intentionally NOT aliased (5th-sighting memecoin trap; cmt_spxusdt = $0.37 verified)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    // SPX input routes via identity-lowercase → cmt_spxusdt = $0.37 SPX6900 memecoin.
    // WEEX does NOT list real S&P 500.
    expect(toWeexSymbol('SPX')).toBe('cmt_spxusdt');
  });

  it('TRADFI_ALIASES has exactly 4 entries (SILVER/PLATINUM/PALLADIUM/USOIL)', () => {
    expect(Object.keys(TRADFI_ALIASES).sort()).toEqual(['PALLADIUM', 'PLATINUM', 'SILVER', 'USOIL']);
  });
});

describe('WeexAdapter.getCandles', () => {
  it('parses WEEX direct-array row [ts_ms, open, high, low, close, base_vol, quote_vol]', async () => {
    setMock('/capi/v2/market/candles', {
      status: 200,
      body: [
        ['1779287000000', '77174.6', '77389.0', '77103.0', '77316.5', '54.61', '4220842.16'],
        ['1779283400000', '77287.5', '77394.7', '77140.6', '77174.6', '189.18', '14607985.41'],
      ],
    });
    const candles = await new WeexAdapter().getCandles('BTC', '1h', 1779200000000);
    expect(candles).toHaveLength(2);
    // Oldest-first sort
    expect(candles[0]).toEqual({
      time: 1779283400000,
      open: 77287.5, high: 77394.7, low: 77140.6, close: 77174.6, volume: 189.18,
    });
    expect(candles[1].time).toBe(1779287000000);
  });

  it('passes symbol=cmt_btcusdt, granularity=1h, limit=1000', async () => {
    setMock('/capi/v2/market/candles', { status: 200, body: [] });
    await new WeexAdapter().getCandles('BTC', '1h', 0);
    const call = fetchCalls.find(c => c.url.includes('candles'));
    expect(call?.url).toContain('symbol=cmt_btcusdt');
    expect(call?.url).toContain('granularity=1h');
    expect(call?.url).toContain('limit=1000');
  });

  it('falls back to nearest available granularity for unsupported (30m → 15m, 8h → 4h)', async () => {
    setMock('/capi/v2/market/candles', { status: 200, body: [] });
    const adapter = new WeexAdapter();
    for (const [tf, expected] of [['30m', '15m'], ['8h', '4h'], ['12h', '4h']] as const) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 0);
      const call = fetchCalls.find(c => c.url.includes('candles'));
      expect(call?.url, `tf=${tf}`).toContain(`granularity=${expected}`);
    }
  });

  it('throws on non-array shape', async () => {
    setMock('/capi/v2/market/candles', {
      status: 200,
      body: { code: '40020', msg: 'granularity error', data: null },
    });
    await expect(new WeexAdapter().getCandles('BTC', '1h', 0)).rejects.toThrow(/non-array shape/);
  });
});

describe('WeexAdapter.getAssetContext (4h cadence × 2190 annualization; funding=0)', () => {
  it('bundles markPrice + indexPrice + 24h vol; funding=0 + fundingAnnualized=0 (no public endpoint)', async () => {
    setMock('/capi/v2/market/ticker', {
      status: 200,
      body: {
        symbol: 'cmt_btcusdt',
        last: '77318.1', best_ask: '77318.1', best_bid: '77318.0',
        high_24h: '77725.1', low_24h: '76110.0', volume_24h: '2418166907.98',
        timestamp: '1779287066843',
        priceChangePercent: '0.009532', base_volume: '31434.7297',
        markPrice: '77327.8', indexPrice: '77359.15',
      },
    });
    const ctx = await new WeexAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBe(0);
    expect(ctx.fundingAnnualized).toBe(0);   // 0 × 2190 = 0; first non-8h venue
    expect(ctx.openInterest).toBe(0);        // no public OI endpoint
    expect(ctx.markPx).toBeCloseTo(77327.8);
    expect(ctx.oraclePx).toBeCloseTo(77359.15);
    expect(ctx.volume24h).toBeCloseTo(2418166907.98);
  });

  it('prevDayPx = 24h-open reconstructed from priceChangePercent (FRACTION), NOT 24h-low/last [PREVDAYPX-FIX]', async () => {
    // Scenario: price rose +5.263% over 24h → open=95, last=100; low=90, high=110.
    // WEEX priceChangePercent is a FRACTION (0.0055 = 0.55%) — verified live 2026-06-11;
    // do NOT divide by 100 (that is Gate's percent-number convention).
    setMock('/capi/v2/market/ticker', {
      status: 200,
      body: {
        symbol: 'cmt_btcusdt', last: '100', best_ask: '100', best_bid: '100',
        high_24h: '110', low_24h: '90', volume_24h: '1', timestamp: '0',
        priceChangePercent: '0.0526316', base_volume: '1',
        markPrice: '100', indexPrice: '100',
      },
    });
    const ctx = await new WeexAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo(95, 1);       // last / (1 + 0.0526316)
    expect(ctx.prevDayPx).not.toBeCloseTo(90, 1);   // NOT the 24h-low (the bug)
    expect(ctx.prevDayPx).not.toBeCloseTo(100, 1);  // NOT the current/last price
  });

  it('4h cadence × 2190 annualization is unique to WEEX (first non-8h venue in adapter fleet)', () => {
    // Documentation-style test: confirms the magic number 2190 (4h × 2190 = 8760 = 1 year).
    const fundingRaw = 0.0001;  // hypothetical funding rate
    const annualized = fundingRaw * 2190;
    expect(annualized).toBeCloseTo(0.219);   // 0.0001 × 2190 = 0.219 = 21.9% annualized
    // vs other CEXes (8h × 1095): 0.0001 × 1095 = 0.1095 = 10.95% — ½ of WEEX's annualized rate
    expect(0.0001 * 1095).toBeCloseTo(0.1095);
  });

  it('routes SILVER via TRADFI_ALIASES → cmt_xagusdt', async () => {
    setMock('/capi/v2/market/ticker', {
      status: 200,
      body: {
        symbol: 'cmt_xagusdt',
        last: '75.81', best_ask: '75.82', best_bid: '75.80',
        high_24h: '76.0', low_24h: '75.5', volume_24h: '1000', timestamp: '0',
        priceChangePercent: '0', base_volume: '100',
        markPrice: '75.83', indexPrice: '75.81',
      },
    });
    const ctx = await new WeexAdapter().getAssetContext('SILVER');
    expect(ctx.markPx).toBeCloseTo(75.83);   // real silver spot
    expect(ctx.coin).toBe('SILVER');
    const tickerCall = fetchCalls.find(c => c.url.includes('ticker'));
    expect(tickerCall?.url).toContain('symbol=cmt_xagusdt');
  });

  it('throws on empty ticker payload', async () => {
    setMock('/capi/v2/market/ticker', { status: 200, body: {} });
    await expect(new WeexAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/empty ticker/);
  });
});

describe('WeexAdapter.getCurrentPrice', () => {
  it('returns markPrice from ticker', async () => {
    setMock('/capi/v2/market/ticker', {
      status: 200,
      body: {
        symbol: 'cmt_btcusdt',
        last: '77318.1', best_ask: '77318.1', best_bid: '77318.0',
        high_24h: '0', low_24h: '0', volume_24h: '0', timestamp: '0',
        priceChangePercent: '0', base_volume: '0',
        markPrice: '77327.8', indexPrice: '77359.15',
      },
    });
    expect(await new WeexAdapter().getCurrentPrice('BTC')).toBeCloseTo(77327.8);
  });

  it('returns null on fetch error', async () => {
    setMock('/capi/v2/market/ticker', { status: 500, statusText: 'Server Error' });
    expect(await new WeexAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

describe('WeexAdapter.getPredictedFundings + getFundingHistory', () => {
  it('getPredictedFundings returns [] (no public funding endpoint surfaced)', async () => {
    expect(await new WeexAdapter().getPredictedFundings()).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('getFundingHistory returns [] (no public funding-history endpoint)', async () => {
    expect(await new WeexAdapter().getFundingHistory('BTC', 0)).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('WeexAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="WEEX"', async () => {
    setMock('/capi/v2/market/candles', {
      status: 429, statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new WeexAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('WEEX');
    }
  }, 10000);
});

describe('WeexAdapter.getName', () => {
  it('returns "WEEX"', () => {
    expect(new WeexAdapter().getName()).toBe('WEEX');
  });
});
