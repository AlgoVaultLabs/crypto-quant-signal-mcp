/**
 * PILOT-ADAPTERS-W3A / C1 — Phemex adapter unit tests.
 *
 * Mocks `globalThis.fetch`. Asserts:
 *   - Symbol round-trip (toPhemexSymbol / fromPhemexSymbol) including TRADFI_ALIASES.
 *   - SPX NOT in alias map (memecoin trap per semantic-fingerprint probe).
 *   - SP500 IS routable via identity (no alias row needed) — Phemex uniquely
 *     lists real S&P 500 as SP500USDT alongside the SPX6900 memecoin SPXUSDT.
 *   - getCandles parses Phemex's NON-STANDARD 10-field row shape
 *     [ts_sec, interval_sec, last_close, open, high, low, close, volume, turnover, symbol]
 *     with time × 1000 (seconds → ms), filters by startTime, sorts oldest-first.
 *   - getAssetContext bundles all 5 capabilities from single /md/v2/ticker/24hr
 *     call (real-value Rp/Rv/Rr suffix decoding — NO decodeEv() needed).
 *   - Funding cadence × 1095 annualization (8h, Binance-compatible).
 *   - getCurrentPrice extracts markPriceRp.
 *   - getPredictedFundings returns [] for shadow venue (per W3A Q-4).
 *   - 429 throws UpstreamRateLimitError with exchange="Phemex".
 *
 * IMPORTANT: NO decodeEv() / scaled-integer tests. Phemex's V2 hedged USDT
 * perpetual family (perpProductsV2) uses Real values (Rp/Rv/Rr/Rq suffix,
 * priceScale=0, ratioScale=0). The spec's claimed "Ev/Rv scaling CRITICAL
 * bug class" applies to the LEGACY non-hedged inverse family (different
 * product), not to the W3A target. Plan-Mode probe 2026-05-20 confirmed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  PhemexAdapter,
  toPhemexSymbol,
  fromPhemexSymbol,
  TRADFI_ALIASES,
} from '../../src/lib/adapters/phemex.js';
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

describe('toPhemexSymbol / fromPhemexSymbol — Phemex-native symbol mapping', () => {
  it('crypto: BTC ⇄ BTCUSDT (no separator, no c-prefix for V2 hedged perp)', () => {
    expect(toPhemexSymbol('BTC')).toBe('BTCUSDT');
    expect(fromPhemexSymbol('BTCUSDT')).toBe('BTC');
  });

  it('crypto: ETH ⇄ ETHUSDT', () => {
    expect(toPhemexSymbol('ETH')).toBe('ETHUSDT');
    expect(fromPhemexSymbol('ETHUSDT')).toBe('ETH');
  });

  it('TradFi metal alias: GOLD ⇄ XAUUSDT (matches Gate canonical, NOT XAUT)', () => {
    expect(toPhemexSymbol('GOLD')).toBe('XAUUSDT');
    expect(fromPhemexSymbol('XAUUSDT')).toBe('GOLD');
  });

  it('TradFi metal aliases: SILVER ⇄ XAGUSDT, PLATINUM ⇄ XPTUSDT, PALLADIUM ⇄ XPDUSDT', () => {
    expect(toPhemexSymbol('SILVER')).toBe('XAGUSDT');
    expect(toPhemexSymbol('PLATINUM')).toBe('XPTUSDT');
    expect(toPhemexSymbol('PALLADIUM')).toBe('XPDUSDT');
    expect(fromPhemexSymbol('XAGUSDT')).toBe('SILVER');
    expect(fromPhemexSymbol('XPTUSDT')).toBe('PLATINUM');
    expect(fromPhemexSymbol('XPDUSDT')).toBe('PALLADIUM');
  });

  it('TradFi gas/oil aliases: NATGAS ⇄ NGUSDT, USOIL ⇄ CLOUSDT', () => {
    expect(toPhemexSymbol('NATGAS')).toBe('NGUSDT');
    expect(toPhemexSymbol('USOIL')).toBe('CLOUSDT');
    expect(fromPhemexSymbol('NGUSDT')).toBe('NATGAS');
    expect(fromPhemexSymbol('CLOUSDT')).toBe('USOIL');
  });

  it('TradFi direct (identity, no alias row): TSLA/NVDA/MSFT/COPPER/VIX/SP500/META/GOOGL', () => {
    expect(toPhemexSymbol('TSLA')).toBe('TSLAUSDT');
    expect(toPhemexSymbol('NVDA')).toBe('NVDAUSDT');
    expect(toPhemexSymbol('MSFT')).toBe('MSFTUSDT');
    expect(toPhemexSymbol('COPPER')).toBe('COPPERUSDT');
    expect(toPhemexSymbol('VIX')).toBe('VIXUSDT');
    expect(toPhemexSymbol('SP500')).toBe('SP500USDT');     // REAL S&P 500 — not aliased; canonical → native identity
    expect(toPhemexSymbol('META')).toBe('METAUSDT');
    expect(toPhemexSymbol('GOOGL')).toBe('GOOGLUSDT');
  });

  it('SPX intentionally NOT in TRADFI_ALIASES (memecoin trap — 4th sighting of SPX6900)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    // SPX input → no alias → becomes SPXUSDT = SPX6900 memecoin ($0.36 mark, NOT S&P 500).
    // Adapter routes it (caller's choice); semantic-fingerprint price probe would catch
    // if a caller accidentally requests SPX expecting S&P 500. SP500 (canonical for the
    // real S&P 500) routes to SP500USDT ($7338 mark).
    expect(toPhemexSymbol('SPX')).toBe('SPXUSDT');         // memecoin route (intentional pass-through)
    expect(toPhemexSymbol('SP500')).toBe('SP500USDT');     // real S&P 500 route
  });
});

// ── getCandles (10-field row shape) ──────────────────────────────────────

describe('PhemexAdapter.getCandles', () => {
  it('parses Phemex 10-field row shape [ts_sec, interval_sec, last_close, open, high, low, close, volume, turnover, symbol]', async () => {
    setMock('/exchange/public/md/v2/kline/last', {
      status: 200,
      body: {
        code: 0,
        msg: 'OK',
        data: {
          total: -1,
          rows: [
            // newest-first per Phemex convention
            [1779242400, 3600, '76787.5', '76787.5', '76876.8', '76563.5', '76654.4', '144.102', '11053429.7551', 'BTCUSDT'],
            [1779238800, 3600, '76751.7', '76755.5', '76897.4', '76505.7', '76787.5', '149.698', '11482721.5278', 'BTCUSDT'],
          ],
        },
      },
    });
    const candles = await new PhemexAdapter().getCandles('BTC', '1h', 1779000000000);
    expect(candles).toHaveLength(2);
    // Oldest-first sort (canonical AlgoVault ordering)
    expect(candles[0]).toEqual({
      time: 1779238800000,    // 1779238800 sec × 1000 = ms
      open: 76755.5,
      high: 76897.4,
      low: 76505.7,
      close: 76787.5,
      volume: 149.698,
    });
    expect(candles[1].time).toBe(1779242400000);
    expect(candles[1].close).toBe(76654.4);
  });

  it('filters candles by startTime (ms → sec compare; rows older than startTime dropped)', async () => {
    setMock('/exchange/public/md/v2/kline/last', {
      status: 200,
      body: {
        code: 0, msg: 'OK',
        data: {
          total: -1,
          rows: [
            [1779000000, 3600, '0', '76000', '76100', '75900', '76050', '100', '7600000', 'BTCUSDT'],   // == startTime (sec); included
            [1779003600, 3600, '76050', '76050', '76200', '75950', '76100', '120', '7610000', 'BTCUSDT'],  // > startTime; included
            [1778996400, 3600, '0', '75800', '76000', '75700', '76000', '80', '6080000', 'BTCUSDT'],   // < startTime; dropped
          ],
        },
      },
    });
    const candles = await new PhemexAdapter().getCandles('BTC', '1h', 1779000000000);
    expect(candles).toHaveLength(2);   // 1 dropped (older than startTime)
    expect(candles.map(c => c.time)).toEqual([1779000000000, 1779003600000]);
  });

  it('passes resolution as INTEGER SECONDS (Phemex convention), limit=200', async () => {
    setMock('/exchange/public/md/v2/kline/last', { status: 200, body: { code: 0, data: { rows: [] } } });
    await new PhemexAdapter().getCandles('BTC', '1h', 1779000000000);
    const call = fetchCalls.find(c => c.url.includes('kline'));
    expect(call?.url).toContain('symbol=BTCUSDT');
    expect(call?.url).toContain('resolution=3600');     // 1h = 3600 seconds (NOT '1h' string)
    expect(call?.url).toContain('limit=200');           // ≥10 minimum (probed); 200 is generous default
  });

  it('falls back to nearest available resolution for unsupported timeframes (3m → 5m=300, 2h → 1h=3600, 12h → 1d=86400)', async () => {
    setMock('/exchange/public/md/v2/kline/last', { status: 200, body: { code: 0, data: { rows: [] } } });
    const adapter = new PhemexAdapter();
    for (const [tf, expected] of [['3m', '300'], ['2h', '3600'], ['12h', '86400']] as const) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 0);
      const call = fetchCalls.find(c => c.url.includes('kline'));
      expect(call?.url, `tf=${tf}`).toContain(`resolution=${expected}`);
    }
  });

  it('throws on non-OK envelope (code != 0)', async () => {
    setMock('/exchange/public/md/v2/kline/last', {
      status: 200,
      body: { code: 30000, msg: 'Please double check input arguments', data: null },
    });
    await expect(new PhemexAdapter().getCandles('BTC', '1h', 0)).rejects.toThrow(/non-OK envelope/);
  });
});

// ── getAssetContext (all-in-one ticker, Rp/Rv/Rr real values) ────────────

describe('PhemexAdapter.getAssetContext', () => {
  it('bundles funding + mark + index + OI + 24h ticker from single /md/v2/ticker/24hr call (Rp/Rv/Rr REAL values, NO decoding)', async () => {
    setMock('/md/v2/ticker/24hr', {
      status: 200,
      body: {
        error: null,
        id: 0,
        result: {
          closeRp: '76646.9',
          markPriceRp: '76648.7',
          indexPriceRp: '76687.42',
          fundingRateRr: '0.00007873',
          predFundingRateRr: '0.00007873',
          openInterestRv: '2726.848',
          openRp: '76742.3',
          highRp: '77290.2',
          lowRp: '76111',
          turnoverRv: '246534779.0653',
          volumeRq: '3211.126',
          symbol: 'BTCUSDT',
          timestamp: 1779247159715624993,
        },
      },
    });
    const ctx = await new PhemexAdapter().getAssetContext('BTC');
    expect(ctx.coin).toBe('BTC');
    expect(ctx.funding).toBeCloseTo(0.00007873);
    expect(ctx.fundingAnnualized).toBeCloseTo(0.00007873 * 1095); // 8h × 1095
    expect(ctx.openInterest).toBeCloseTo(2726.848);
    expect(ctx.markPx).toBeCloseTo(76648.7);
    expect(ctx.oraclePx).toBeCloseTo(76687.42);
    expect(ctx.volume24h).toBeCloseTo(246534779.0653);     // turnoverRv is USDT volume
    expect(ctx.prevDayPx).toBeCloseTo(76742.3);            // 24h open
  });

  it('routes GOLD via TRADFI_ALIASES → XAUUSDT ticker (not memecoin)', async () => {
    setMock('/md/v2/ticker/24hr', {
      status: 200,
      body: {
        error: null, id: 0,
        result: {
          closeRp: '4465.26', markPriceRp: '4465.31', indexPriceRp: '4467.42', fundingRateRr: '0.00001',
          predFundingRateRr: '0.00001', openInterestRv: '0', openRp: '4460', highRp: '4470', lowRp: '4450',
          turnoverRv: '0', volumeRq: '0', symbol: 'XAUUSDT', timestamp: 0,
        },
      },
    });
    const ctx = await new PhemexAdapter().getAssetContext('GOLD');
    expect(ctx.markPx).toBeCloseTo(4465.31);
    expect(ctx.coin).toBe('GOLD');
    const tickerCall = fetchCalls.find(c => c.url.includes('ticker'));
    expect(tickerCall?.url).toContain('symbol=XAUUSDT');
  });

  it('routes SP500 (canonical real S&P 500) → SP500USDT identity (NOT SPX/memecoin)', async () => {
    setMock('/md/v2/ticker/24hr', {
      status: 200,
      body: {
        error: null, id: 0,
        result: {
          closeRp: '7338.7', markPriceRp: '7338.5', indexPriceRp: '7339.0', fundingRateRr: '0',
          predFundingRateRr: '0', openInterestRv: '0', openRp: '7330', highRp: '7350', lowRp: '7320',
          turnoverRv: '0', volumeRq: '0', symbol: 'SP500USDT', timestamp: 0,
        },
      },
    });
    const ctx = await new PhemexAdapter().getAssetContext('SP500');
    expect(ctx.markPx).toBeCloseTo(7338.5);       // confirms real S&P 500 magnitude ($7000+), NOT $0.36 SPX memecoin
    const tickerCall = fetchCalls.find(c => c.url.includes('ticker'));
    expect(tickerCall?.url).toContain('symbol=SP500USDT');
  });

  it('throws on empty ticker payload (envelope error or null result)', async () => {
    setMock('/md/v2/ticker/24hr', {
      status: 200,
      body: { error: { code: 39999, message: 'Unknown symbol' }, id: 0, result: null },
    });
    await expect(new PhemexAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/empty ticker payload/);
  });
});

// ── getCurrentPrice ──────────────────────────────────────────────────────

describe('PhemexAdapter.getCurrentPrice', () => {
  it('returns markPriceRp from /md/v2/ticker/24hr', async () => {
    setMock('/md/v2/ticker/24hr', {
      status: 200,
      body: {
        error: null, id: 0,
        result: {
          closeRp: '76646.9', markPriceRp: '76648.7', indexPriceRp: '0', fundingRateRr: '0',
          predFundingRateRr: '0', openInterestRv: '0', openRp: '0', highRp: '0', lowRp: '0',
          turnoverRv: '0', volumeRq: '0', symbol: 'BTCUSDT', timestamp: 0,
        },
      },
    });
    expect(await new PhemexAdapter().getCurrentPrice('BTC')).toBeCloseTo(76648.7);
  });

  it('returns null on fetch error (silent degradation)', async () => {
    setMock('/md/v2/ticker/24hr', { status: 500, statusText: 'Server Error' });
    expect(await new PhemexAdapter().getCurrentPrice('UNKNOWN')).toBeNull();
  });
});

// ── getPredictedFundings (shadow-venue returns [] per W3A Q-4) ───────────

describe('PhemexAdapter.getPredictedFundings', () => {
  it('returns [] for shadow venue (no batch-tickers endpoint; cross-venue fanout fires only for promoted venues)', async () => {
    // No fetch mock needed — getPredictedFundings is a no-op for Phemex shadow venue.
    const fundings = await new PhemexAdapter().getPredictedFundings();
    expect(fundings).toEqual([]);
    expect(fetchCalls).toHaveLength(0);    // confirm NO upstream call fired
  });
});

// ── getFundingHistory (shadow-venue returns [] — public endpoint requires auth) ──

describe('PhemexAdapter.getFundingHistory', () => {
  it('returns [] for shadow venue (Phemex funding history endpoint is auth-gated)', async () => {
    const history = await new PhemexAdapter().getFundingHistory('BTC', 0);
    expect(history).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── 429 rate-limit error ─────────────────────────────────────────────────

describe('PhemexAdapter — 429 handling', () => {
  it('throws UpstreamRateLimitError with exchange="Phemex"', async () => {
    setMock('/exchange/public/md/v2/kline/last', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': '0' },
    });
    try {
      await new PhemexAdapter().getCandles('BTC', '1h', 0);
      throw new Error('expected UpstreamRateLimitError');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamRateLimitError);
      expect((err as UpstreamRateLimitError).exchange).toBe('Phemex');
    }
  }, 10000);
});

// ── Adapter identity ─────────────────────────────────────────────────────

describe('PhemexAdapter.getName', () => {
  it('returns "Phemex"', () => {
    expect(new PhemexAdapter().getName()).toBe('Phemex');
  });
});
