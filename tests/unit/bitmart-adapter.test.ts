/**
 * PILOT-ADAPTERS-W3B / C2 — Bitmart adapter unit tests.
 * Symbol BTCUSDT (Binance-style); 8h cadence x1095; step is MINUTES ENUM
 * {1,3,5,15,30,60,120,240,720}; limit not honored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  BitmartAdapter,
  toBitmartSymbol,
  fromBitmartSymbol,
  TRADFI_ALIASES,
} from '../../src/lib/adapters/bitmart.js';
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
  // getAssetContext now derives the 24h-open from the kline; default to an empty
  // kline so tests not asserting prevDayPx don't hit an unmocked URL (the fix then
  // falls back to hi/lo-midpoint / last). prevDayPx tests override this mock.
  setMock('/contract/public/kline', { status: 200, body: { code: 1000, message: '', data: [] } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('toBitmartSymbol / fromBitmartSymbol — Binance-style no-separator', () => {
  it('crypto: BTC ⇄ BTCUSDT', () => {
    expect(toBitmartSymbol('BTC')).toBe('BTCUSDT');
    expect(fromBitmartSymbol('BTCUSDT')).toBe('BTC');
  });

  it('TradFi GOLD ⇄ XAUUSDT (prefer XAU spot; Bitmart has BOTH XAU + XAUT)', () => {
    expect(toBitmartSymbol('GOLD')).toBe('XAUUSDT');
    expect(fromBitmartSymbol('XAUUSDT')).toBe('GOLD');
  });

  it('TradFi aliases: SILVER/PLATINUM/PALLADIUM/USOIL', () => {
    expect(toBitmartSymbol('SILVER')).toBe('XAGUSDT');
    expect(toBitmartSymbol('PLATINUM')).toBe('XPTUSDT');
    expect(toBitmartSymbol('PALLADIUM')).toBe('XPDUSDT');
    expect(toBitmartSymbol('USOIL')).toBe('CLUSDT');
  });

  it('SPX NOT aliased (memecoin trap; SPXUSDT = $0.37)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    expect(toBitmartSymbol('SPX')).toBe('SPXUSDT');
  });

  it('TRADFI_ALIASES has exactly 5 entries', () => {
    expect(Object.keys(TRADFI_ALIASES).sort()).toEqual(['GOLD', 'PALLADIUM', 'PLATINUM', 'SILVER', 'USOIL']);
  });
});

describe('BitmartAdapter.getCandles (step ENUM + time window)', () => {
  it('parses Bitmart kline rows with sec→ms time conversion', async () => {
    setMock('/contract/public/kline', {
      status: 200,
      body: {
        code: 1000, message: 'Ok',
        data: [
          { low_price: '78015', high_price: '78172.1', open_price: '78071.6', close_price: '78137.2', volume: '495460', timestamp: 1779001200 },
          { low_price: '77992.1', high_price: '78155.3', open_price: '78137.3', close_price: '78050.7', volume: '477060', timestamp: 1779004800 },
        ],
      },
    });
    const candles = await new BitmartAdapter().getCandles('BTC', '1h', 0);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: 1779001200000,    // sec × 1000 = ms
      open: 78071.6, high: 78172.1, low: 78015, close: 78137.2, volume: 495460,
    });
  });

  it('passes step=60 for 1h (MINUTES, not seconds — ENUM {1,3,5,15,30,60,120,240,720})', async () => {
    setMock('/contract/public/kline', { status: 200, body: { code: 1000, data: [] } });
    await new BitmartAdapter().getCandles('BTC', '1h', 1779000000000);
    const call = fetchCalls.find(c => c.url.includes('kline'));
    expect(call?.url).toContain('symbol=BTCUSDT');
    expect(call?.url).toContain('step=60');     // 1h = 60 minutes
    expect(call?.url).toContain('start_time=');
    expect(call?.url).toContain('end_time=');
  });

  it('falls back to nearest enum step for unsupported (8h→240=4h, 1d→720=12h)', async () => {
    setMock('/contract/public/kline', { status: 200, body: { code: 1000, data: [] } });
    const adapter = new BitmartAdapter();
    for (const [tf, expected] of [['8h', '240'], ['1d', '720'], ['12h', '720']] as const) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 0);
      const call = fetchCalls.find(c => c.url.includes('kline'));
      expect(call?.url, `tf=${tf}`).toContain(`step=${expected}`);
    }
  });

  it('throws on non-OK envelope (code != 1000)', async () => {
    setMock('/contract/public/kline', { status: 200, body: { code: 30000, message: 'fail', data: null } });
    await expect(new BitmartAdapter().getCandles('BTC', '1h', 0)).rejects.toThrow(/non-OK envelope/);
  });
});

describe('BitmartAdapter.getAssetContext (single /contract/public/details call)', () => {
  it('finds symbol record + bundles funding + OI + mark + 24h vol', async () => {
    setMock('/contract/public/details', {
      status: 200,
      body: {
        data: {
          symbols: [
            { symbol: 'ETHUSDT', base_currency: 'ETH', quote_currency: 'USDT', product_type: 1, last_price: '4500', mark_price: '4500', index_price: '4500', funding_rate: '0.0001', open_interest: '500000', contract_size: '0.01', vol_24h: '1000' },
            { symbol: 'BTCUSDT', base_currency: 'BTC', quote_currency: 'USDT', product_type: 1, last_price: '77481.2', mark_price: '77500.0', index_price: '77504.98', funding_rate: '0.0000298', open_interest: '2299707', contract_size: '0.001', vol_24h: '5000' },
          ],
        },
      },
    });
    const ctx = await new BitmartAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(0.0000298);
    expect(ctx.fundingAnnualized).toBeCloseTo(0.0000298 * 1095);    // 8h × 1095
    expect(ctx.openInterest).toBeCloseTo(2299707);
    expect(ctx.markPx).toBeCloseTo(77500);
    expect(ctx.oraclePx).toBeCloseTo(77504.98);
    expect(ctx.volume24h).toBeCloseTo(5000);
  });

  it('prevDayPx = 24h-open from kline (/details has no open/change field), NOT last_price [PREVDAYPX-FIX]', async () => {
    // /contract/public/details exposes only last/index/mark + high_24h/low_24h —
    // no 24h-open or change field (verified live 2026-06-11). Derive the 24h-prior
    // price from the hourly kline (open of the earliest candle in the window = 95);
    // last_price (100) was the bug → priceChange ≈ 0 always.
    setMock('/contract/public/details', {
      status: 200,
      body: { data: { symbols: [
        { symbol: 'BTCUSDT', base_currency: 'BTC', quote_currency: 'USDT', product_type: 1,
          last_price: '100', mark_price: '100', index_price: '100', funding_rate: '0',
          open_interest: '0', contract_size: '0.001', vol_24h: '1', high_24h: '110', low_24h: '90' },
      ] } },
    });
    setMock('/contract/public/kline', {
      status: 200,
      body: { code: 1000, message: '', data: [
        { open_price: '95', high_price: '96', low_price: '94', close_price: '100', volume: '1', timestamp: Math.floor(Date.now() / 1000) - 86400 },
      ] },
    });
    const ctx = await new BitmartAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo(95, 1);       // kline 24h-open
    expect(ctx.prevDayPx).not.toBeCloseTo(100, 1);  // NOT last_price (the bug)
  });

  it('falls back through mark_price → index_price → last_price (when mark_price null)', async () => {
    setMock('/contract/public/details', {
      status: 200,
      body: {
        data: {
          symbols: [
            { symbol: 'BTCUSDT', base_currency: 'BTC', quote_currency: 'USDT', product_type: 1, last_price: '77481', mark_price: null, index_price: '77504', funding_rate: '0', open_interest: '0', contract_size: '0.001', vol_24h: null },
          ],
        },
      },
    });
    const ctx = await new BitmartAdapter().getAssetContext('BTC');
    expect(ctx.markPx).toBeCloseTo(77504);   // falls back to index_price
  });

  it('throws when symbol not found in details', async () => {
    setMock('/contract/public/details', { status: 200, body: { data: { symbols: [] } } });
    await expect(new BitmartAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/not found/);
  });

  it('routes GOLD via TRADFI_ALIASES → XAUUSDT', async () => {
    setMock('/contract/public/details', {
      status: 200,
      body: {
        data: {
          symbols: [
            { symbol: 'XAUUSDT', base_currency: 'XAU', quote_currency: 'USDT', product_type: 1, last_price: '4510', mark_price: '4510.5', index_price: '4508.6', funding_rate: '0', open_interest: '0', contract_size: '1', vol_24h: '0' },
          ],
        },
      },
    });
    const ctx = await new BitmartAdapter().getAssetContext('GOLD');
    expect(ctx.markPx).toBeCloseTo(4510.5);
    expect(ctx.coin).toBe('GOLD');
  });
});

describe('BitmartAdapter.getCurrentPrice', () => {
  it('returns mark_price from details', async () => {
    setMock('/contract/public/details', {
      status: 200,
      body: { data: { symbols: [{ symbol: 'BTCUSDT', base_currency: 'BTC', quote_currency: 'USDT', product_type: 1, last_price: '77481', mark_price: '77500', index_price: '77504', funding_rate: '0', open_interest: '0', contract_size: '0.001', vol_24h: null }] } },
    });
    expect(await new BitmartAdapter().getCurrentPrice('BTC')).toBeCloseTo(77500);
  });

  it('returns null on fetch error', async () => {
    setMock('/contract/public/details', { status: 500, statusText: 'Server Error' });
    expect(await new BitmartAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

describe('BitmartAdapter.getPredictedFundings', () => {
  it('returns [] for shadow venue (W3B Q-3 fail-soft)', async () => {
    expect(await new BitmartAdapter().getPredictedFundings()).toEqual([]);
  });
});

describe('BitmartAdapter.getFundingHistory (current-only single-record)', () => {
  it('returns single-record list from /contract/public/funding-rate', async () => {
    setMock('/contract/public/funding-rate', {
      status: 200,
      body: { code: 1000, message: 'Ok', data: { symbol: 'BTCUSDT', expected_rate: '0.0000188', rate_value: '0.000028608', funding_time: 1779292800000, funding_upper_limit: '0.0375', funding_lower_limit: '-0.0375', timestamp: 1779286978024 } },
    });
    const hist = await new BitmartAdapter().getFundingHistory('BTC', 0);
    expect(hist).toHaveLength(1);
    expect(hist[0].time).toBe(1779292800000);
    expect(hist[0].fundingRate).toBeCloseTo(0.000028608);
  });

  it('returns [] on error', async () => {
    setMock('/contract/public/funding-rate', { status: 500, statusText: 'Server Error' });
    expect(await new BitmartAdapter().getFundingHistory('BTC', 0)).toEqual([]);
  });
});

describe('BitmartAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="Bitmart"', async () => {
    setMock('/contract/public/kline', {
      status: 429, statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new BitmartAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('Bitmart');
    }
  }, 10000);
});

describe('BitmartAdapter.getName', () => {
  it('returns "Bitmart"', () => {
    expect(new BitmartAdapter().getName()).toBe('Bitmart');
  });
});
