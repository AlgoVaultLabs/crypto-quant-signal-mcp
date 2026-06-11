/**
 * PILOT-ADAPTERS-W2 / C2 — MEXC adapter unit tests.
 *
 * Asserts:
 *   - Symbol round-trip + TRADFI_ALIASES (GOLD→XAUT, CL→USOIL, BRENTOIL→UKOIL, PLATINUM→XPT, PALLADIUM→XPD).
 *   - SILVER/COPPER NOT aliased (MEXC uses literal canonical names).
 *   - SPX NOT in alias map (price-probe inconclusive; safer to skip).
 *   - getCandles transposes column-wise {time:[], open:[], ...} response into Candle[].
 *   - getAssetContext bundles 5 capabilities from single ticker call (`fairPrice`=mark, `holdVol`=OI).
 *   - Funding × 1095 annualization (8h cadence, verified collectCycle=8).
 *   - 429 throws UpstreamRateLimitError with exchange="MEXC".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  MEXCAdapter,
  toMexcSymbol,
  fromMexcSymbol,
  TRADFI_ALIASES,
} from '../../src/lib/adapters/mexc.js';
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

describe('toMexcSymbol / fromMexcSymbol — symbol round-trip', () => {
  it('crypto: BTC ⇄ BTC_USDT', () => {
    expect(toMexcSymbol('BTC')).toBe('BTC_USDT');
    expect(fromMexcSymbol('BTC_USDT')).toBe('BTC');
  });

  it('TradFi alias: GOLD ⇄ XAUT_USDT (MEXC has only XAUT, no XAU; gold-tracking verified)', () => {
    expect(toMexcSymbol('GOLD')).toBe('XAUT_USDT');
    expect(fromMexcSymbol('XAUT_USDT')).toBe('GOLD');
  });

  it('TradFi alias: CL ⇄ USOIL_USDT (MEXC uses descriptive name)', () => {
    expect(toMexcSymbol('CL')).toBe('USOIL_USDT');
    expect(fromMexcSymbol('USOIL_USDT')).toBe('CL');
  });

  it('TradFi alias: BRENTOIL ⇄ UKOIL_USDT (MEXC uses descriptive name)', () => {
    expect(toMexcSymbol('BRENTOIL')).toBe('UKOIL_USDT');
    expect(fromMexcSymbol('UKOIL_USDT')).toBe('BRENTOIL');
  });

  it('TradFi alias: PLATINUM/PALLADIUM ⇄ XPT/XPD', () => {
    expect(toMexcSymbol('PLATINUM')).toBe('XPT_USDT');
    expect(toMexcSymbol('PALLADIUM')).toBe('XPD_USDT');
  });

  it('TradFi literal direct (MEXC uses canonical English names): SILVER, COPPER', () => {
    expect(toMexcSymbol('SILVER')).toBe('SILVER_USDT');
    expect(toMexcSymbol('COPPER')).toBe('COPPER_USDT');
  });

  it('FX + Index direct: EUR/GBP/JPY/JP225', () => {
    expect(toMexcSymbol('EUR')).toBe('EUR_USDT');
    expect(toMexcSymbol('GBP')).toBe('GBP_USDT');
    expect(toMexcSymbol('JPY')).toBe('JPY_USDT');
    expect(toMexcSymbol('JP225')).toBe('JP225_USDT');
  });

  it('SPX intentionally NOT in TRADFI_ALIASES (price-probe inconclusive)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
  });
});

// ── getCandles — COLUMN-WISE transpose ──────────────────────────────────

describe('MEXCAdapter.getCandles — column-wise transpose to row-wise Candle[]', () => {
  it('transposes {time:[], open:[], high:[], low:[], close:[], vol:[]} into Candle[]', async () => {
    setMock('/api/v1/contract/kline/', {
      status: 200,
      body: {
        success: true, code: 0,
        data: {
          time:   [1779166800, 1779170400],
          open:   [76889.3, 76870],
          high:   [76974.4, 77000],
          low:    [76592.4, 76800],
          close:  [76870.1, 76950],
          vol:    [14481859, 5000],
          amount: [111243132, 385000000],
        },
      },
    });
    const candles = await new MEXCAdapter().getCandles('BTC', '1h', 1779000000000);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      time: 1779166800000,   // sec × 1000 = ms
      open: 76889.3,
      high: 76974.4,
      low: 76592.4,
      close: 76870.1,
      volume: 14481859,
    });
    expect(candles[1].close).toBeCloseTo(76950);
  });

  it('returns [] on empty data array (graceful, not throws)', async () => {
    setMock('/api/v1/contract/kline/', {
      status: 200,
      body: { success: true, code: 0, data: { time: [], open: [], high: [], low: [], close: [], vol: [], amount: [] } },
    });
    expect(await new MEXCAdapter().getCandles('UNKNOWN', '1h', 0)).toEqual([]);
  });

  it('passes Min60 / Hour4 / Day1 / etc. for canonical timeframes', async () => {
    setMock('/api/v1/contract/kline/', { status: 200, body: { success: true, code: 0, data: { time: [] } } });
    const adapter = new MEXCAdapter();
    const expected: [string, string][] = [
      ['1m', 'Min1'], ['5m', 'Min5'], ['15m', 'Min15'], ['30m', 'Min30'],
      ['1h', 'Min60'], ['4h', 'Hour4'], ['8h', 'Hour8'], ['1d', 'Day1'],
    ];
    for (const [tf, mexcInt] of expected) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 1779000000000);
      const call = fetchCalls.find(c => c.url.includes('/kline/'));
      expect(call?.url, `tf=${tf}`).toContain(`interval=${mexcInt}`);
    }
  });

  it('falls back to nearest for unsupported 3m/2h/12h', async () => {
    setMock('/api/v1/contract/kline/', { status: 200, body: { success: true, code: 0, data: { time: [] } } });
    const adapter = new MEXCAdapter();
    for (const [tf, expected] of [['3m', 'Min5'], ['2h', 'Min60'], ['12h', 'Hour8']] as const) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 0);
      const call = fetchCalls.find(c => c.url.includes('/kline/'));
      expect(call?.url, `tf=${tf}`).toContain(`interval=${expected}`);
    }
  });
});

// ── getAssetContext (all-in-one ticker) ──────────────────────────────────

describe('MEXCAdapter.getAssetContext', () => {
  it('bundles 5 capabilities from single ticker call (fairPrice=mark, holdVol=OI)', async () => {
    setMock('/api/v1/contract/ticker', {
      status: 200,
      body: {
        success: true, code: 0,
        data: {
          symbol: 'BTC_USDT',
          lastPrice: 76967.5,
          indexPrice: 77001.7,
          fairPrice: 76967.5,
          holdVol: 635897655,
          fundingRate: 0.000056,
          volume24: 719832205,
          amount24: 5529327475.27553,
          high24Price: 77750.8,
          lower24Price: 76019.5,
        },
      },
    });
    const ctx = await new MEXCAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(0.000056);
    expect(ctx.fundingAnnualized).toBeCloseTo(0.000056 * 1095); // 8h × 1095
    expect(ctx.openInterest).toBeCloseTo(635897655);
    expect(ctx.markPx).toBeCloseTo(76967.5);
    expect(ctx.oraclePx).toBeCloseTo(77001.7);
    expect(ctx.volume24h).toBeCloseTo(5529327475.27553);
  });

  it('prevDayPx = 24h-open reconstructed from riseFallRate (FRACTION), NOT 24h-low/last [PREVDAYPX-FIX]', async () => {
    // riseFallRate is present in the LIVE /contract/ticker payload (a FRACTION,
    // -0.0074 = -0.74%; verified live 2026-06-11) though absent from the prior interface.
    // Scenario: open=95, last=100, lower24Price=90, high24Price=110.
    setMock('/api/v1/contract/ticker', {
      status: 200,
      body: {
        success: true, code: 0,
        data: {
          symbol: 'BTC_USDT', lastPrice: 100, indexPrice: 100, fairPrice: 100,
          holdVol: 0, fundingRate: 0, volume24: 0, amount24: 0,
          high24Price: 110, lower24Price: 90, riseFallRate: 0.0526316,
        },
      },
    });
    const ctx = await new MEXCAdapter().getAssetContext('BTC');
    expect(ctx.prevDayPx).toBeCloseTo(95, 1);       // lastPrice / (1 + riseFallRate)
    expect(ctx.prevDayPx).not.toBeCloseTo(90, 1);   // NOT lower24Price (the bug)
    expect(ctx.prevDayPx).not.toBeCloseTo(100, 1);  // NOT last
  });

  it('routes GOLD via TRADFI_ALIASES → XAUT_USDT (Tether Gold, NOT XAU)', async () => {
    setMock('/api/v1/contract/ticker', {
      status: 200,
      body: {
        success: true, code: 0,
        data: { symbol: 'XAUT_USDT', lastPrice: 4546.5, fairPrice: 4546.5, indexPrice: 4546.5, holdVol: 0, fundingRate: 0, volume24: 0, amount24: 0, high24Price: 0, lower24Price: 0 },
      },
    });
    const ctx = await new MEXCAdapter().getAssetContext('GOLD');
    expect(ctx.markPx).toBeCloseTo(4546.5);
    expect(ctx.coin).toBe('GOLD');
    const call = fetchCalls.find(c => c.url.includes('/ticker'));
    expect(call?.url).toContain('symbol=XAUT_USDT');
  });

  it('throws on empty ticker payload (not silent null)', async () => {
    setMock('/api/v1/contract/ticker', { status: 200, body: { success: false, code: -1, data: null } });
    await expect(new MEXCAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/empty ticker/);
  });
});

// ── getCurrentPrice ──────────────────────────────────────────────────────

describe('MEXCAdapter.getCurrentPrice', () => {
  it('returns fairPrice from ticker', async () => {
    setMock('/api/v1/contract/ticker', {
      status: 200,
      body: { success: true, code: 0, data: { symbol: 'BTC_USDT', fairPrice: 76967.5, lastPrice: 0, indexPrice: 0, holdVol: 0, fundingRate: 0, volume24: 0, amount24: 0, high24Price: 0, lower24Price: 0 } },
    });
    expect(await new MEXCAdapter().getCurrentPrice('BTC')).toBeCloseTo(76967.5);
  });

  it('returns null on failed fetch', async () => {
    setMock('/api/v1/contract/ticker', { status: 500, statusText: 'Server Error' });
    expect(await new MEXCAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

// ── 429 rate-limit error ─────────────────────────────────────────────────

describe('MEXCAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="MEXC"', async () => {
    setMock('/api/v1/contract/kline/', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new MEXCAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('MEXC');
    }
  }, 10000);
});

// ── Adapter identity ─────────────────────────────────────────────────────

describe('MEXCAdapter.getName', () => {
  it('returns "MEXC"', () => {
    expect(new MEXCAdapter().getName()).toBe('MEXC');
  });
});
