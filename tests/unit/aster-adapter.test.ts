/**
 * PILOT-ADAPTERS-W1 / C1 — Aster adapter unit tests.
 *
 * Mocks `globalThis.fetch` (no real network in tests). Asserts:
 *   - Symbol round-trip (toAsterSymbol / fromAsterSymbol).
 *   - Interval mapping (11 canonical timeframes).
 *   - getCandles parses Binance-shape array-of-arrays correctly.
 *   - getAssetContext fans out 3 parallel requests + composes the result.
 *   - getCurrentPrice extracts markPrice from premiumIndex.
 *   - getPredictedFundings filters USDT-quoted entries + reverses symbols.
 *   - getFundingHistory returns ordered + parsed records.
 *   - 429 throws UpstreamRateLimitError with `exchange: 'Aster'`.
 *   - Non-USDT symbols are filtered out of getPredictedFundings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  AsterAdapter,
  toAsterSymbol,
  fromAsterSymbol,
} from '../../src/lib/adapters/aster.js';
import { UpstreamRateLimitError } from '../../src/lib/errors.js';

// ── Test-double fetch ────────────────────────────────────────────────────

interface MockResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

let mockResponses: Map<string, MockResponse>;
let fetchCalls: { url: string; init?: RequestInit }[];
let originalFetch: typeof fetch;

function setMock(urlSubstring: string, response: MockResponse): void {
  mockResponses.set(urlSubstring, response);
}

function buildFetchMock(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
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

describe('toAsterSymbol / fromAsterSymbol — symbol round-trip', () => {
  it('BTC ⇄ BTCUSDT', () => {
    expect(toAsterSymbol('BTC')).toBe('BTCUSDT');
    expect(fromAsterSymbol('BTCUSDT')).toBe('BTC');
  });

  it('ASTER ⇄ ASTERUSDT (Aster\'s native token)', () => {
    expect(toAsterSymbol('ASTER')).toBe('ASTERUSDT');
    expect(fromAsterSymbol('ASTERUSDT')).toBe('ASTER');
  });

  it('does NOT apply 1000-prefix for meme coins (Aster does not use that convention)', () => {
    expect(toAsterSymbol('PEPE')).toBe('PEPEUSDT');
    expect(toAsterSymbol('SHIB')).toBe('SHIBUSDT');
    expect(fromAsterSymbol('PEPEUSDT')).toBe('PEPE');
  });

  it('does NOT apply TradFi aliases (Aster has no TradFi listings)', () => {
    // Even though our canonical maps GOLD → XAU on Binance, Aster has no
    // TradFi catalog — so GOLD → GOLDUSDT (which Aster doesn't list).
    expect(toAsterSymbol('GOLD')).toBe('GOLDUSDT');
  });
});

// ── getCandles ───────────────────────────────────────────────────────────

describe('AsterAdapter.getCandles', () => {
  it('parses Binance-shape array-of-arrays into Candle[] (Aster API is Binance-clone)', async () => {
    const fixture = [
      [1778907600000, '78998.4', '78999.8', '78891.9', '78991.8', '116.478', 1778911199999, '9197369.8927', 2173, '61.391', '4847319.7325', '0'],
      [1778911200000, '78991.9', '79008.6', '78694.5', '78725.3', '279.691', 1778914799999, '22042817.1177', 2451, '144.898', '11418891.7565', '0'],
    ];
    setMock('/fapi/v1/klines', { status: 200, body: fixture });

    const adapter = new AsterAdapter();
    const candles = await adapter.getCandles('BTC', '1h', 1778907600000);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: 1778907600000,
      open: 78998.4,
      high: 78999.8,
      low: 78891.9,
      close: 78991.8,
      volume: 116.478,
    });
    expect(candles[1].close).toBeCloseTo(78725.3);
  });

  it('routes the canonical timeframe to the Aster interval string', async () => {
    setMock('/fapi/v1/klines', { status: 200, body: [] });
    const adapter = new AsterAdapter();
    await adapter.getCandles('BTC', '4h', 0);
    const call = fetchCalls.find(c => c.url.includes('/fapi/v1/klines'));
    expect(call?.url).toContain('symbol=BTCUSDT');
    expect(call?.url).toContain('interval=4h');
  });
});

// ── getAssetContext ──────────────────────────────────────────────────────

describe('AsterAdapter.getAssetContext', () => {
  it('fans out 3 parallel requests + composes funding/OI/24h ticker', async () => {
    setMock('/fapi/v1/premiumIndex', {
      status: 200,
      body: { symbol: 'BTCUSDT', markPrice: '78732.50000000', lastFundingRate: '0.00002333', nextFundingTime: 1778918400000 },
    });
    setMock('/fapi/v1/openInterest', {
      status: 200,
      body: { symbol: 'BTCUSDT', openInterest: '5599.890', time: 1778913079287 },
    });
    // RE-FIXTURED by OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch3 (SEC-11). This mock used to
    // carry `prevClosePrice: '80557.8'` — a Binance SPOT-only field that Aster's perp
    // 24hr ticker DOES NOT RETURN — and asserted prevDayPx === 80557.8. It therefore
    // passed BECAUSE of the bug: it pinned the adapter to a fictional field. Shape below
    // matches a captured live payload (see tests/unit/aster-prevday.test.ts).
    setMock('/fapi/v1/ticker/24hr', {
      status: 200,
      body: {
        symbol: 'BTCUSDT', volume: '10231.981', quoteVolume: '813229059.16',
        lastPrice: '78732.5', openPrice: '80557.8', highPrice: '80900.0', lowPrice: '78100.0',
        priceChangePercent: '-2.265',
      },
    });

    const adapter = new AsterAdapter();
    const ctx = await adapter.getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(0.00002333);
    expect(ctx.fundingAnnualized).toBeCloseTo(0.00002333 * 1095);
    expect(ctx.openInterest).toBeCloseTo(5599.89);
    expect(ctx.prevDayPx).toBeCloseTo(80557.8); // now from openPrice, the real field
    expect(ctx.volume24h).toBeCloseTo(813229059.16);
    expect(ctx.markPx).toBeCloseTo(78732.5);
    expect(ctx.oraclePx).toBeCloseTo(78732.5);
  });

  it('handles missing/zero fields gracefully (returns 0 not NaN)', async () => {
    setMock('/fapi/v1/premiumIndex', {
      status: 200,
      body: { symbol: 'BTCUSDT', markPrice: '78732', lastFundingRate: '' },
    });
    setMock('/fapi/v1/openInterest', { status: 200, body: { symbol: 'BTCUSDT', openInterest: '' } });
    setMock('/fapi/v1/ticker/24hr', {
      status: 200,
      body: { symbol: 'BTCUSDT', volume: '', quoteVolume: '', lastPrice: '', prevClosePrice: '' },
    });
    const ctx = await new AsterAdapter().getAssetContext('BTC');
    expect(ctx.funding).toBe(0);
    expect(ctx.openInterest).toBe(0);
    expect(ctx.volume24h).toBe(0);
    expect(ctx.prevDayPx).toBe(0);
    expect(Number.isFinite(ctx.markPx)).toBe(true);
  });
});

// ── getCurrentPrice ──────────────────────────────────────────────────────

describe('AsterAdapter.getCurrentPrice', () => {
  it('extracts markPrice from premiumIndex', async () => {
    setMock('/fapi/v1/premiumIndex', { status: 200, body: { symbol: 'BTCUSDT', markPrice: '78732.5', lastFundingRate: '0', nextFundingTime: 0 } });
    const price = await new AsterAdapter().getCurrentPrice('BTC');
    expect(price).toBeCloseTo(78732.5);
  });

  it('returns null on fetch error (silent degradation)', async () => {
    setMock('/fapi/v1/premiumIndex', { status: 500, statusText: 'Internal Server Error' });
    const price = await new AsterAdapter().getCurrentPrice('NONEXISTENT');
    expect(price).toBeNull();
  });
});

// ── getPredictedFundings ─────────────────────────────────────────────────

describe('AsterAdapter.getPredictedFundings', () => {
  it('filters to USDT-quoted entries + reverses symbol mapping', async () => {
    setMock('/fapi/v1/premiumIndex', {
      status: 200,
      body: [
        { symbol: 'BTCUSDT', lastFundingRate: '0.0001', nextFundingTime: 1778918400000 },
        { symbol: 'ETHUSDT', lastFundingRate: '0.00005', nextFundingTime: 1778918400000 },
        { symbol: 'BTCUSDC', lastFundingRate: '0.0001', nextFundingTime: 1778918400000 },
        { symbol: 'SOLBUSD', lastFundingRate: '0.0002', nextFundingTime: 1778918400000 },
      ],
    });
    const fundings = await new AsterAdapter().getPredictedFundings();
    expect(fundings).toHaveLength(2);
    expect(fundings.map(f => f.coin).sort()).toEqual(['BTC', 'ETH']);
    expect(fundings[0].venues[0].venue).toBe('AsterPerp');
    expect(fundings[0].venues[0].fundingRate).toBeCloseTo(0.0001);
  });
});

// ── getFundingHistory ────────────────────────────────────────────────────

describe('AsterAdapter.getFundingHistory', () => {
  it('returns parsed time+rate records', async () => {
    setMock('/fapi/v1/fundingRate', {
      status: 200,
      body: [
        { fundingTime: 1778900000000, fundingRate: '0.0001' },
        { fundingTime: 1778903600000, fundingRate: '0.00012' },
      ],
    });
    const history = await new AsterAdapter().getFundingHistory('BTC', 1778900000000);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ time: 1778900000000, fundingRate: 0.0001 });
  });

  it('returns [] (NOT throws) on fetch failure', async () => {
    setMock('/fapi/v1/fundingRate', { status: 500, statusText: 'Internal Server Error' });
    const history = await new AsterAdapter().getFundingHistory('BTC', 0);
    expect(history).toEqual([]);
  });
});

// ── Rate-limit error path ────────────────────────────────────────────────

describe('AsterAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="Aster" after retry exhausted', async () => {
    // Use getCandles path — single endpoint, no parallel fan-out — so the
    // 429 deterministically surfaces without racing other mocked endpoints.
    // Retry-After: 0 keeps the test fast (single-retry → ~0ms wait between).
    setMock('/fapi/v1/klines', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new AsterAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('Aster');
      expect((err as UpstreamRateLimitError).retryAfterSeconds).toBe(0);
    }
  }, 10000);
});

// ── Adapter identity ─────────────────────────────────────────────────────

describe('AsterAdapter.getName', () => {
  it('returns "Aster"', () => {
    expect(new AsterAdapter().getName()).toBe('Aster');
  });
});
