/**
 * PILOT-ADAPTERS-W3A / C2 — BingX adapter unit tests.
 *
 * Mocks `globalThis.fetch`. Asserts:
 *   - Symbol round-trip (toBingxSymbol / fromBingxSymbol) including TRADFI_ALIASES.
 *   - GOLD → XAUT alias (BingX has only XAUT, not XAU; mirrors MEXC + KuCoin).
 *   - SPX NOT in alias map (memecoin trap — 4th sighting; BingX SPX-USDT = $0.36).
 *   - getCandles parses BingX direct-float row {open, close, high, low, volume, time}
 *     with ms time (no conversion), filters by startTime, sorts oldest-first.
 *   - getAssetContext uses 3-call Binance-style fan-out via Promise.all
 *     (premiumIndex + openInterest + ticker).
 *   - Funding cadence × 1095 annualization (8h, fundingIntervalHours=8 verified).
 *   - getCurrentPrice extracts markPrice from premiumIndex.
 *   - getPredictedFundings returns [] for shadow venue.
 *   - 429 throws UpstreamRateLimitError with exchange="BingX".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  BingxAdapter,
  toBingxSymbol,
  fromBingxSymbol,
  TRADFI_ALIASES,
} from '../../src/lib/adapters/bingx.js';
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

// ── Symbol round-trip + TRADFI_ALIASES ───────────────────────────────────

describe('toBingxSymbol / fromBingxSymbol — BingX-native symbol mapping', () => {
  it('crypto: BTC ⇄ BTC-USDT (hyphen separator)', () => {
    expect(toBingxSymbol('BTC')).toBe('BTC-USDT');
    expect(fromBingxSymbol('BTC-USDT')).toBe('BTC');
  });

  it('crypto: ETH ⇄ ETH-USDT', () => {
    expect(toBingxSymbol('ETH')).toBe('ETH-USDT');
    expect(fromBingxSymbol('ETH-USDT')).toBe('ETH');
  });

  it('TradFi metal alias: GOLD ⇄ XAUT-USDT (BingX has only XAUT, not XAU — mirrors MEXC + KuCoin)', () => {
    expect(toBingxSymbol('GOLD')).toBe('XAUT-USDT');
    expect(fromBingxSymbol('XAUT-USDT')).toBe('GOLD');
  });

  it('SPX NOT in TRADFI_ALIASES (memecoin trap — 4th sighting; BingX SPX-USDT = $0.36)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    // SPX input → no alias → SPX-USDT (memecoin). Caller's choice; semantic-fingerprint
    // probe would catch if a caller expects S&P 500 from BingX. BingX does NOT list
    // a real S&P 500 perp.
    expect(toBingxSymbol('SPX')).toBe('SPX-USDT');
  });

  it('TRADFI_ALIASES has exactly 1 entry (BingX sparse TradFi catalog: only XAUT)', () => {
    expect(Object.keys(TRADFI_ALIASES).sort()).toEqual(['GOLD']);
  });
});

// ── getCandles ───────────────────────────────────────────────────────────

describe('BingxAdapter.getCandles', () => {
  it('parses BingX direct-float kline rows with ms time (no conversion needed)', async () => {
    setMock('/openApi/swap/v2/quote/klines', {
      status: 200,
      body: {
        code: 0,
        msg: '',
        data: [
          // newest-first per BingX convention
          { open: '76761.9', close: '76787.0', high: '76889.0', low: '76501.8', volume: '528.3867', time: 1779238800000 },
          { open: '76786.8', close: '76653.7', high: '76879.7', low: '76564.1', volume: '244.4026', time: 1779242400000 },
        ],
      },
    });
    const candles = await new BingxAdapter().getCandles('BTC', '1h', 1779000000000);
    expect(candles).toHaveLength(2);
    // Oldest-first sort (canonical AlgoVault ordering)
    expect(candles[0]).toEqual({
      time: 1779238800000,
      open: 76761.9,
      high: 76889.0,
      low: 76501.8,
      close: 76787.0,
      volume: 528.3867,
    });
    expect(candles[1].time).toBe(1779242400000);
  });

  it('filters candles by startTime (ms compare)', async () => {
    setMock('/openApi/swap/v2/quote/klines', {
      status: 200,
      body: {
        code: 0, msg: '',
        data: [
          { open: '76', close: '76.5', high: '77', low: '75', volume: '1', time: 1779000000000 },  // == startTime; included
          { open: '76.5', close: '77', high: '77.5', low: '76', volume: '2', time: 1779003600000 }, // > startTime; included
          { open: '75', close: '75.5', high: '76', low: '74', volume: '3', time: 1778996400000 },   // < startTime; dropped
        ],
      },
    });
    const candles = await new BingxAdapter().getCandles('BTC', '1h', 1779000000000);
    expect(candles).toHaveLength(2);
    expect(candles.map(c => c.time)).toEqual([1779000000000, 1779003600000]);
  });

  it('passes interval as string ("1h" not 3600), limit=1000', async () => {
    setMock('/openApi/swap/v2/quote/klines', { status: 200, body: { code: 0, data: [] } });
    await new BingxAdapter().getCandles('BTC', '1h', 0);
    const call = fetchCalls.find(c => c.url.includes('klines'));
    expect(call?.url).toContain('symbol=BTC-USDT');
    expect(call?.url).toContain('interval=1h');         // string family, not integer
    expect(call?.url).toContain('limit=1000');
  });

  it('throws on non-OK envelope (code != 0)', async () => {
    setMock('/openApi/swap/v2/quote/klines', {
      status: 200,
      body: { code: 100410, msg: 'rate-limit exceeded', data: null },
    });
    await expect(new BingxAdapter().getCandles('BTC', '1h', 0)).rejects.toThrow(/non-OK envelope/);
  });
});

// ── getAssetContext (3-call Binance-style fan-out) ───────────────────────

describe('BingxAdapter.getAssetContext', () => {
  it('combines premiumIndex (mark+funding) + openInterest (OI) + ticker (24h vol + openPrice) via Promise.all', async () => {
    setMock('/openApi/swap/v2/quote/premiumIndex', {
      status: 200,
      body: {
        code: 0, msg: '',
        data: {
          symbol: 'BTC-USDT',
          markPrice: '76627.5',
          indexPrice: '76658.9',
          lastFundingRate: '0.00010000',
          nextFundingTime: 1779264000000,
          fundingIntervalHours: 8,
          minFundingRate: '-0.003',
          maxFundingRate: '0.003',
          updateTime: 1779235200000,
        },
      },
    });
    setMock('/openApi/swap/v2/quote/openInterest', {
      status: 200,
      body: { code: 0, msg: '', data: { openInterest: '1089733411.2', symbol: 'BTC-USDT', time: 1779247215817 } },
    });
    setMock('/openApi/swap/v2/quote/ticker', {
      status: 200,
      body: {
        code: 0, msg: '',
        data: {
          symbol: 'BTC-USDT',
          priceChange: '-63.7',
          priceChangePercent: '-0.08',
          lastPrice: '76667.2',
          lastQty: '0.0054',
          highPrice: '77288.7',
          lowPrice: '76114.0',
          volume: '16668.08',
          quoteVolume: '1279776444.69',
          openPrice: '76730.9',
          openTime: 1779247049867,
          closeTime: 1779247259223,
          askPrice: '76667.2', askQty: '7.15', bidPrice: '76667.0', bidQty: '22.8',
        },
      },
    });
    const ctx = await new BingxAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(0.00010);
    expect(ctx.fundingAnnualized).toBeCloseTo(0.00010 * 1095); // 8h × 1095
    expect(ctx.openInterest).toBeCloseTo(1089733411.2);
    expect(ctx.markPx).toBeCloseTo(76627.5);
    expect(ctx.oraclePx).toBeCloseTo(76658.9);
    expect(ctx.volume24h).toBeCloseTo(1279776444.69);
    expect(ctx.prevDayPx).toBeCloseTo(76730.9);    // 24h openPrice
  });

  it('routes GOLD via TRADFI_ALIASES → XAUT-USDT (NOT memecoin route)', async () => {
    const tradFiBody = (sym: string, mp: string) => ({
      code: 0, msg: '',
      data: {
        symbol: sym, markPrice: mp, indexPrice: mp, lastFundingRate: '0', nextFundingTime: 0,
        fundingIntervalHours: 8, minFundingRate: '-0.003', maxFundingRate: '0.003', updateTime: 0,
      },
    });
    const tickerBody = (sym: string) => ({
      code: 0, msg: '',
      data: {
        symbol: sym, priceChange: '0', priceChangePercent: '0', lastPrice: '4464', lastQty: '0',
        highPrice: '4500', lowPrice: '4400', volume: '0', quoteVolume: '0', openPrice: '4460',
        openTime: 0, closeTime: 0, askPrice: '4465', askQty: '0', bidPrice: '4464', bidQty: '0',
      },
    });
    setMock('/openApi/swap/v2/quote/premiumIndex', { status: 200, body: tradFiBody('XAUT-USDT', '4464.81') });
    setMock('/openApi/swap/v2/quote/openInterest', { status: 200, body: { code: 0, data: { openInterest: '0', symbol: 'XAUT-USDT', time: 0 } } });
    setMock('/openApi/swap/v2/quote/ticker', { status: 200, body: tickerBody('XAUT-USDT') });

    const ctx = await new BingxAdapter().getAssetContext('GOLD');
    expect(ctx.markPx).toBeCloseTo(4464.81);
    expect(ctx.coin).toBe('GOLD');
    const tickerCall = fetchCalls.find(c => c.url.includes('premiumIndex'));
    expect(tickerCall?.url).toContain('symbol=XAUT-USDT');
  });

  it('throws when premiumIndex.data is empty', async () => {
    setMock('/openApi/swap/v2/quote/premiumIndex', { status: 200, body: { code: 0, msg: '', data: null } });
    setMock('/openApi/swap/v2/quote/openInterest', { status: 200, body: { code: 0, data: { openInterest: '0', symbol: 'X', time: 0 } } });
    setMock('/openApi/swap/v2/quote/ticker', { status: 200, body: { code: 0, data: { symbol: 'X', openPrice: '0', quoteVolume: '0', lastPrice: '0', priceChange:'0', priceChangePercent:'0', volume:'0', highPrice:'0', lowPrice:'0', openTime:0, closeTime:0, askPrice:'0', askQty:'0', bidPrice:'0', bidQty:'0', lastQty:'0' } } });
    await expect(new BingxAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/empty premiumIndex.ticker payload/);
  });
});

// ── getCurrentPrice ──────────────────────────────────────────────────────

describe('BingxAdapter.getCurrentPrice', () => {
  it('returns markPrice from premiumIndex', async () => {
    setMock('/openApi/swap/v2/quote/premiumIndex', {
      status: 200,
      body: {
        code: 0, msg: '',
        data: {
          symbol: 'BTC-USDT', markPrice: '76627.5', indexPrice: '76658.9', lastFundingRate: '0',
          nextFundingTime: 0, fundingIntervalHours: 8, minFundingRate: '0', maxFundingRate: '0', updateTime: 0,
        },
      },
    });
    expect(await new BingxAdapter().getCurrentPrice('BTC')).toBeCloseTo(76627.5);
  });

  it('returns null on fetch error (silent degradation)', async () => {
    setMock('/openApi/swap/v2/quote/premiumIndex', { status: 500, statusText: 'Server Error' });
    expect(await new BingxAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

// ── getPredictedFundings (shadow venue returns []) ───────────────────────

describe('BingxAdapter.getPredictedFundings', () => {
  it('returns [] for shadow venue (no batch enumeration; cross-venue fanout fires only for promoted)', async () => {
    const fundings = await new BingxAdapter().getPredictedFundings();
    expect(fundings).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── getFundingHistory (shadow returns [] — auth-gated upstream) ──────────

describe('BingxAdapter.getFundingHistory', () => {
  it('returns [] for shadow venue', async () => {
    const history = await new BingxAdapter().getFundingHistory('BTC', 0);
    expect(history).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── 429 rate-limit error ─────────────────────────────────────────────────

describe('BingxAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="BingX"', async () => {
    setMock('/openApi/swap/v2/quote/klines', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new BingxAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('BingX');
    }
  }, 10000);
});

// ── Adapter identity ─────────────────────────────────────────────────────

describe('BingxAdapter.getName', () => {
  it('returns "BingX"', () => {
    expect(new BingxAdapter().getName()).toBe('BingX');
  });
});
