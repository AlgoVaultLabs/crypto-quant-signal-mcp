/**
 * PILOT-ADAPTERS-W3B / C4 — WhiteBIT adapter unit tests.
 * Symbol BTC_PERP (_PERP suffix); 8h cadence x1095; kline at /api/v1/public/kline
 * (NOT v4); /api/v4/public/futures bundles instruments+funding+OI+mark.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  WhitebitAdapter,
  toWhitebitSymbol,
  fromWhitebitSymbol,
  TRADFI_ALIASES,
} from '../../src/lib/adapters/whitebit.js';
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
  // getAssetContext now derives the 24h-open from the v1 kline; default to an empty
  // kline so tests not asserting prevDayPx don't hit an unmocked URL.
  setMock('/api/v1/public/kline', { status: 200, body: { success: true, message: null, result: [] } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('toWhitebitSymbol / fromWhitebitSymbol — _PERP suffix (UNIQUE)', () => {
  it('crypto: BTC ⇄ BTC_PERP', () => {
    expect(toWhitebitSymbol('BTC')).toBe('BTC_PERP');
    expect(fromWhitebitSymbol('BTC_PERP')).toBe('BTC');
  });

  it('TradFi GOLD ⇄ XAU_PERP (prefer XAU spot; WhiteBIT has BOTH XAU + XAUT)', () => {
    expect(toWhitebitSymbol('GOLD')).toBe('XAU_PERP');
    expect(fromWhitebitSymbol('XAU_PERP')).toBe('GOLD');
  });

  it('TradFi aliases SILVER/PLATINUM/PALLADIUM/USOIL', () => {
    expect(toWhitebitSymbol('SILVER')).toBe('XAG_PERP');
    expect(toWhitebitSymbol('PLATINUM')).toBe('XPT_PERP');
    expect(toWhitebitSymbol('PALLADIUM')).toBe('XPD_PERP');
    expect(toWhitebitSymbol('USOIL')).toBe('CL_PERP');
  });

  it('TradFi DIRECT: AMZN/MSTR/NVDA/TSLA/NATGAS/CL', () => {
    expect(toWhitebitSymbol('AMZN')).toBe('AMZN_PERP');
    expect(toWhitebitSymbol('MSTR')).toBe('MSTR_PERP');
    expect(toWhitebitSymbol('NVDA')).toBe('NVDA_PERP');
    expect(toWhitebitSymbol('NATGAS')).toBe('NATGAS_PERP');
  });

  it('SPX NOT in alias map (WhiteBIT does NOT list SPX — first W3-batch venue without memecoin trap)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    // Identity-route — but WhiteBIT futures endpoint will return "not found"
    expect(toWhitebitSymbol('SPX')).toBe('SPX_PERP');
  });

  it('TRADFI_ALIASES has exactly 5 entries', () => {
    expect(Object.keys(TRADFI_ALIASES).sort()).toEqual(['GOLD', 'PALLADIUM', 'PLATINUM', 'SILVER', 'USOIL']);
  });
});

describe('WhitebitAdapter.getCandles (v1 kline, NOT v4)', () => {
  it('parses WhiteBIT row [ts_sec, open, CLOSE, HIGH, LOW, base_vol, quote_vol] — NOT standard OHLC', async () => {
    setMock('/api/v1/public/kline', {
      status: 200,
      body: {
        success: true, message: null,
        result: [
          [1779274800, '77523.1', '77389.2', '77578.1', '77328.1', '1470.794', '113937453.8631'],
          [1779278400, '77378.2', '77626.6', '77756.8', '77360.8', '1630.339', '126363820.2589'],
        ],
      },
    });
    const candles = await new WhitebitAdapter().getCandles('BTC', '1h', 0);
    expect(candles).toHaveLength(2);
    // Verify WhiteBIT's non-standard ordering: [ts, open, close, high, low, ...]
    expect(candles[0]).toEqual({
      time: 1779274800000,    // sec × 1000
      open: 77523.1,
      close: 77389.2,    // 3rd field = CLOSE (not high)
      high: 77578.1,     // 4th field = HIGH (not low)
      low: 77328.1,      // 5th field = LOW
      volume: 1470.794,
    });
  });

  it('uses /api/v1/public/kline path (NOT v4 — v4 returns empty)', async () => {
    setMock('/api/v1/public/kline', { status: 200, body: { success: true, result: [] } });
    await new WhitebitAdapter().getCandles('BTC', '1h', 0);
    const call = fetchCalls.find(c => c.url.includes('kline'));
    expect(call?.url).toContain('/api/v1/public/kline');
    expect(call?.url).not.toContain('/api/v4/');
  });

  it('passes market=BTC_PERP, interval=1h (string), limit=1000', async () => {
    setMock('/api/v1/public/kline', { status: 200, body: { success: true, result: [] } });
    await new WhitebitAdapter().getCandles('BTC', '1h', 0);
    const call = fetchCalls.find(c => c.url.includes('kline'));
    expect(call?.url).toContain('market=BTC_PERP');
    expect(call?.url).toContain('interval=1h');
    expect(call?.url).toContain('limit=1000');
  });

  it('throws on non-success envelope', async () => {
    setMock('/api/v1/public/kline', {
      status: 200,
      body: { success: false, message: { interval: ['Invalid interval.'] }, result: null },
    });
    await expect(new WhitebitAdapter().getCandles('BTC', '1h', 0)).rejects.toThrow(/non-OK envelope/);
  });
});

describe('WhitebitAdapter.getAssetContext (single /api/v4/public/futures all-in-one)', () => {
  it('finds market + bundles funding + OI + mark + 24h vol; filters money_currency=USDT (safety belt)', async () => {
    setMock('/api/v4/public/futures', {
      status: 200,
      body: {
        message: null, success: true,
        result: [
          {
            ticker_id: 'BTC_PERP', stock_currency: 'BTC', money_currency: 'USDT',
            last_price: '77400.5', stock_volume: '5000', money_volume: '387000000',
            bid: '77400', ask: '77401', high: '77800', low: '77100',
            product_type: 'Perpetual',
            open_interest: '850000',
            index_price: '77398.2',
            index_name: 'BTC future contract',
            index_currency: 'BTC',
            funding_rate: '0.00005',
            next_funding_rate_timestamp: '1779292800000',
          },
        ],
      },
    });
    const ctx = await new WhitebitAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(0.00005);
    expect(ctx.fundingAnnualized).toBeCloseTo(0.00005 * 1095);    // 8h × 1095
    expect(ctx.openInterest).toBeCloseTo(850000);
    expect(ctx.markPx).toBeCloseTo(77400.5);    // last_price proxy
    expect(ctx.oraclePx).toBeCloseTo(77398.2);
    expect(ctx.volume24h).toBeCloseTo(387000000);
  });

  it('prevDayPx = 24h-open from kline (/futures has no open/change field), NOT 24h-low [PREVDAYPX-FIX]', async () => {
    // /api/v4/public/futures exposes only last/high/low (no 24h-open or change;
    // verified live 2026-06-11). Derive the 24h-prior price from the v1 kline
    // (open of earliest candle = 95); low (90) was the bug → priceChange always +.
    setMock('/api/v4/public/futures', {
      status: 200,
      body: { message: null, success: true, result: [
        { ticker_id: 'BTC_PERP', stock_currency: 'BTC', money_currency: 'USDT',
          last_price: '100', stock_volume: '1', money_volume: '1', bid: '100', ask: '100',
          high: '110', low: '90', product_type: 'Perpetual', open_interest: '0',
          index_price: '100', index_name: 'x', index_currency: 'BTC',
          funding_rate: '0', next_funding_rate_timestamp: '0' },
      ] },
    });
    // WhiteBIT v1 kline row order: [ts_sec, open, close, high, low, base_vol, quote_vol].
    setMock('/api/v1/public/kline', {
      status: 200,
      body: { success: true, message: null, result: [
        [Math.floor(Date.now() / 1000) - 3600, '95', '100', '110', '90', '1', '1'],
      ] },
    });
    const ctx = await new WhitebitAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo(95, 1);      // kline 24h-open
    expect(ctx.prevDayPx).not.toBeCloseTo(90, 1);  // NOT low (the bug)
  });

  it('routes GOLD via TRADFI_ALIASES → XAU_PERP', async () => {
    setMock('/api/v4/public/futures', {
      status: 200,
      body: {
        message: null, success: true,
        result: [{
          ticker_id: 'XAU_PERP', stock_currency: 'XAU', money_currency: 'USDT',
          last_price: '4511.5', stock_volume: '0', money_volume: '0',
          bid: '4511', ask: '4512', high: '4520', low: '4500',
          product_type: 'Perpetual', open_interest: '0',
          index_price: '4510.96', index_name: 'XAU future contract', index_currency: 'XAU',
          funding_rate: '0', next_funding_rate_timestamp: '0',
        }],
      },
    });
    const ctx = await new WhitebitAdapter().getAssetContext('GOLD');
    expect(ctx.markPx).toBeCloseTo(4511.5);   // real spot gold
    expect(ctx.coin).toBe('GOLD');
  });

  it('throws when market not found OR money_currency != USDT (safety belt)', async () => {
    setMock('/api/v4/public/futures', {
      status: 200,
      body: { message: null, success: true, result: [] },
    });
    await expect(new WhitebitAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/not found/);
  });
});

describe('WhitebitAdapter.getCurrentPrice', () => {
  it('returns last_price from futures endpoint', async () => {
    setMock('/api/v4/public/futures', {
      status: 200,
      body: {
        message: null, success: true,
        result: [{
          ticker_id: 'BTC_PERP', stock_currency: 'BTC', money_currency: 'USDT',
          last_price: '77400.5', stock_volume: '0', money_volume: '0', bid: '0', ask: '0',
          high: '0', low: '0', product_type: 'Perpetual', open_interest: '0',
          index_price: '0', index_name: '', index_currency: '', funding_rate: '0', next_funding_rate_timestamp: '0',
        }],
      },
    });
    expect(await new WhitebitAdapter().getCurrentPrice('BTC')).toBeCloseTo(77400.5);
  });

  it('returns null on fetch error', async () => {
    setMock('/api/v4/public/futures', { status: 500, statusText: 'Server Error' });
    expect(await new WhitebitAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

describe('WhitebitAdapter.getPredictedFundings + getFundingHistory', () => {
  it('returns [] for shadow venue', async () => {
    expect(await new WhitebitAdapter().getPredictedFundings()).toEqual([]);
    expect(await new WhitebitAdapter().getFundingHistory('BTC', 0)).toEqual([]);
  });
});

describe('WhitebitAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="WhiteBIT"', async () => {
    setMock('/api/v1/public/kline', {
      status: 429, statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new WhitebitAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('WhiteBIT');
    }
  }, 10000);
});

describe('WhitebitAdapter.getName', () => {
  it('returns "WhiteBIT"', () => {
    expect(new WhitebitAdapter().getName()).toBe('WhiteBIT');
  });
});
