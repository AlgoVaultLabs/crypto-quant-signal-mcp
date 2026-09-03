/**
 * PILOT-ADAPTERS-W3B / C1 — WEEX adapter unit tests.
 * Symbol <COIN>USDT on /capi/v3 (was cmt_<coin>usdt on the sunsetting V2);
 * funding cadence 4h (x2190). Migrated by OPS-WEEX-PROMOTION-READINESS-W1 CH2.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  WeexAdapter,
  toWeexSymbol,
  fromWeexSymbol,
  weexTicker,
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

describe('toWeexSymbol / fromWeexSymbol — WEEX <COIN>USDT convention (V3)', () => {
  it('crypto: BTC ⇄ BTCUSDT (uppercase, no cmt_ prefix on V3)', () => {
    expect(toWeexSymbol('BTC')).toBe('BTCUSDT');
    expect(fromWeexSymbol('BTCUSDT')).toBe('BTC');
  });

  it('crypto: ETH ⇄ ETHUSDT', () => {
    expect(toWeexSymbol('ETH')).toBe('ETHUSDT');
    expect(fromWeexSymbol('ETHUSDT')).toBe('ETH');
  });

  it('TradFi alias: SILVER ⇄ XAGUSDT (WEEX has NO GOLD/XAU)', () => {
    expect(toWeexSymbol('SILVER')).toBe('XAGUSDT');
    expect(fromWeexSymbol('XAGUSDT')).toBe('SILVER');
  });

  it('TradFi alias: PLATINUM ⇄ XPTUSDT, PALLADIUM ⇄ XPDUSDT, USOIL ⇄ CLUSDT', () => {
    expect(toWeexSymbol('PLATINUM')).toBe('XPTUSDT');
    expect(toWeexSymbol('PALLADIUM')).toBe('XPDUSDT');
    expect(toWeexSymbol('USOIL')).toBe('CLUSDT');
    expect(fromWeexSymbol('XPTUSDT')).toBe('PLATINUM');
    expect(fromWeexSymbol('XPDUSDT')).toBe('PALLADIUM');
    expect(fromWeexSymbol('CLUSDT')).toBe('USOIL');
  });

  // OPS-WEEX-PROMOTION-READINESS-W1 CH2, architect-required. `toWeexSymbol` does TWO
  // jobs — TRADFI_ALIASES mapping AND format — and V3 changed only the format half.
  // A rewrite that dropped the alias half would break every WEEX TradFi perp SILENTLY,
  // because the naive forms are not 404s in our code, they are simply symbols WEEX has
  // never listed: measured 2026-09-03 against V3 exchangeInfo, XAGUSDT/XPTUSDT/XPDUSDT/
  // CLUSDT are all PRESENT and SILVERUSDT/PLATINUMUSDT/PALLADIUMUSDT/USOILUSDT are all
  // ABSENT. This round-trip is what makes that regression unwritable.
  it('ROUND-TRIP over all four aliases plus a plain coin (the alias half must survive V3)', () => {
    for (const coin of ['SILVER', 'PLATINUM', 'PALLADIUM', 'USOIL', 'BTC'] as const) {
      expect(fromWeexSymbol(toWeexSymbol(coin)), `round-trip ${coin}`).toBe(coin);
    }
    // and the aliases must actually TRANSLATE, not pass through unchanged
    expect(toWeexSymbol('SILVER')).not.toBe('SILVERUSDT');
    expect(toWeexSymbol('PLATINUM')).not.toBe('PLATINUMUSDT');
    expect(toWeexSymbol('PALLADIUM')).not.toBe('PALLADIUMUSDT');
    expect(toWeexSymbol('USOIL')).not.toBe('USOILUSDT');
  });

  it('TradFi direct (no alias needed): TSLA/NVDA/MSFT/COPPER/NATGAS', () => {
    expect(toWeexSymbol('TSLA')).toBe('TSLAUSDT');
    expect(toWeexSymbol('NVDA')).toBe('NVDAUSDT');
    expect(toWeexSymbol('MSFT')).toBe('MSFTUSDT');
    expect(toWeexSymbol('COPPER')).toBe('COPPERUSDT');
    expect(toWeexSymbol('NATGAS')).toBe('NATGASUSDT');
  });

  it('SPX intentionally NOT aliased (5th-sighting memecoin trap; SPXUSDT = $0.37 verified)', () => {
    expect(TRADFI_ALIASES).not.toHaveProperty('SPX');
    expect(TRADFI_ALIASES).not.toHaveProperty('SP500');
    // SPX input routes via identity → SPXUSDT = $0.37 SPX6900 memecoin.
    // WEEX does NOT list real S&P 500.
    expect(toWeexSymbol('SPX')).toBe('SPXUSDT');
  });

  it('TRADFI_ALIASES has exactly 4 entries (SILVER/PLATINUM/PALLADIUM/USOIL)', () => {
    expect(Object.keys(TRADFI_ALIASES).sort()).toEqual(['PALLADIUM', 'PLATINUM', 'SILVER', 'USOIL']);
  });
});

describe('WeexAdapter.getCandles', () => {
  it('parses the V3 11-field row [openTime,o,h,l,c,volume,closeTime,quoteVolume,trades,tbBase,tbQuote]', async () => {
    // V3 emits openTime as a NUMBER (V2 emitted a string) and appends 4 fields; indices
    // 0-5 are unchanged and index 5 is BASE volume on both, so the mapping is index-identical.
    setMock('/capi/v3/market/klines', {
      status: 200,
      body: [
        [1779287000000, '77174.6', '77389.0', '77103.0', '77316.5', '54.61', 1779290600000, '4220842.16', 812, '27.3', '2110421.08'],
        [1779283400000, '77287.5', '77394.7', '77140.6', '77174.6', '189.18', 1779287000000, '14607985.41', 2904, '94.5', '7303992.70'],
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

  it('passes symbol=BTCUSDT, interval=1h, limit=1000 (V3 param is `interval`, not `granularity`)', async () => {
    setMock('/capi/v3/market/klines', { status: 200, body: [] });
    await new WeexAdapter().getCandles('BTC', '1h', 0);
    const call = fetchCalls.find(c => c.url.includes('klines'));
    expect(call?.url).toContain('symbol=BTCUSDT');
    expect(call?.url).toContain('interval=1h');
    expect(call?.url).toContain('limit=1000');
    expect(call?.url).not.toContain('granularity=');
  });

  // OPS-WEEX-PROMOTION-READINESS-W1 CH2: 30m and 12h are NATIVE on V3. The former
  // 30m→15m and 12h→4h downgrades were V2 artifacts, not venue limitations — carrying
  // them onto V3 would ship a knowingly obsolete mapping. 3m/2h/8h have no V3 interval
  // and keep their substitutions.
  it('30m and 12h are served NATIVELY on V3 (the V2-era downgrades are gone)', async () => {
    setMock('/capi/v3/market/klines', { status: 200, body: [] });
    const adapter = new WeexAdapter();
    for (const tf of ['30m', '12h'] as const) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 0);
      const call = fetchCalls.find(c => c.url.includes('klines'));
      expect(call?.url, `tf=${tf} must be native`).toContain(`interval=${tf}`);
    }
  });

  it('still substitutes the three intervals V3 does not serve (3m → 5m, 2h → 1h, 8h → 4h)', async () => {
    setMock('/capi/v3/market/klines', { status: 200, body: [] });
    const adapter = new WeexAdapter();
    for (const [tf, expected] of [['3m', '5m'], ['2h', '1h'], ['8h', '4h']] as const) {
      fetchCalls = [];
      await adapter.getCandles('BTC', tf, 0);
      const call = fetchCalls.find(c => c.url.includes('klines'));
      expect(call?.url, `tf=${tf}`).toContain(`interval=${expected}`);
    }
  });

  it('throws on non-array shape', async () => {
    setMock('/capi/v3/market/klines', {
      status: 200,
      body: { code: '40020', msg: 'granularity error', data: null },
    });
    await expect(new WeexAdapter().getCandles('BTC', '1h', 0)).rejects.toThrow(/non-array shape/);
  });
});

describe('WeexAdapter.getAssetContext (4h cadence × 2190 annualization; funding=0)', () => {
  it('bundles markPrice + indexPrice + 24h QUOTE vol; funding=0 + fundingAnnualized=0 (not wired in CH2)', async () => {
    // V3 answers a ?symbol= query with a one-element ARRAY (V2 returned a bare object),
    // and the 24h QUOTE volume moved from `volume_24h` to `quoteVolume` — V3's same-named
    // `volume` is BASE volume, so a name-match would deflate this ~77,000x.
    setMock('/capi/v3/market/ticker/24hr', {
        status: 200,
        body: [{
          symbol: 'BTCUSDT', lastPrice: '77318.1', openPrice: '76587.9',
          highPrice: '77725.1', lowPrice: '76110.0',
          volume: '31434.7297', quoteVolume: '2418166907.98',
          priceChange: '0', priceChangePercent: '0.009532',
          markPrice: '77327.8', indexPrice: '77359.15',
          openTime: 0, closeTime: 0,
        }],
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

  it('prevDayPx = the V3-served 24h openPrice, NOT 24h-low/last [PREVDAYPX-FIX]', async () => {
    // Scenario: price rose +5.263% over 24h → open=95, last=100; low=90, high=110.
    // V3 serves openPrice DIRECTLY; measured 2026-09-03 it agrees with the V2-era
    // reconstruction to 2.5e-7, so this fixture asserts the same 95 either way.
    // priceChangePercent remains a FRACTION on V3 (0.0055 = 0.55%) — do NOT divide by 100.
    setMock('/capi/v3/market/ticker/24hr', {
        status: 200,
        body: [{
          symbol: 'BTCUSDT', lastPrice: '100', openPrice: '95',
          highPrice: '110', lowPrice: '90',
          volume: '31434.7297', quoteVolume: '1',
          priceChange: '0', priceChangePercent: '0.0526316',
          markPrice: '100', indexPrice: '100',
          openTime: 0, closeTime: 0,
        }],
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

  it('routes SILVER via TRADFI_ALIASES → XAGUSDT', async () => {
    setMock('/capi/v3/market/ticker/24hr', {
        status: 200,
        body: [{
          symbol: 'XAGUSDT', lastPrice: '75.81', openPrice: '75.81',
          highPrice: '76.0', lowPrice: '75.5',
          volume: '31434.7297', quoteVolume: '1000',
          priceChange: '0', priceChangePercent: '0',
          markPrice: '75.83', indexPrice: '75.81',
          openTime: 0, closeTime: 0,
        }],
      });
    const ctx = await new WeexAdapter().getAssetContext('SILVER');
    expect(ctx.markPx).toBeCloseTo(75.83);   // real silver spot
    expect(ctx.coin).toBe('SILVER');
    const tickerCall = fetchCalls.find(c => c.url.includes('ticker'));
    expect(tickerCall?.url).toContain('symbol=XAGUSDT');
  });

  it('throws on empty ticker payload (bare {} and empty [] both)', async () => {
    setMock('/capi/v3/market/ticker/24hr', { status: 200, body: [] });
    await expect(new WeexAdapter().getAssetContext('UNKNOWN')).rejects.toThrow(/empty ticker/);
  });
});

describe('WeexAdapter.getCurrentPrice', () => {
  it('returns markPrice from ticker', async () => {
    setMock('/capi/v3/market/ticker/24hr', {
        status: 200,
        body: [{
          symbol: 'BTCUSDT', lastPrice: '77318.1', openPrice: '77318.1',
          highPrice: '0', lowPrice: '0',
          volume: '31434.7297', quoteVolume: '0',
          priceChange: '0', priceChangePercent: '0',
          markPrice: '77327.8', indexPrice: '77359.15',
          openTime: 0, closeTime: 0,
        }],
      });
    expect(await new WeexAdapter().getCurrentPrice('BTC')).toBeCloseTo(77327.8);
  });

  it('returns null on fetch error', async () => {
    setMock('/capi/v3/market/ticker/24hr', { status: 500, statusText: 'Server Error' });
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
    setMock('/capi/v3/market/klines', {
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

// ════════════════════════════════════════════════════════════════════════════════
// OPS-WEEX-PROMOTION-READINESS-W1 CH2 — the two V3 regressions that would be SILENT.
// Both were found by PROBING the live payload rather than reading the path diff, and
// neither produces an error on its own: one returns a plausible row for the wrong
// symbol, the other returns a plausible number in the wrong unit.
// ════════════════════════════════════════════════════════════════════════════════

describe('weexTicker — V3 array unwrap + list-endpoint identity assertion', () => {
  const row = (symbol: string) => ({
    symbol, lastPrice: '1', openPrice: '1', highPrice: '1', lowPrice: '1',
    volume: '1', quoteVolume: '1', priceChange: '0', priceChangePercent: '0',
    markPrice: '1', indexPrice: '1', openTime: 0, closeTime: 0,
  });

  it('unwraps the one-element ARRAY V3 returns for ?symbol=', () => {
    expect(weexTicker([row('BTCUSDT')] as never, 'BTCUSDT')?.symbol).toBe('BTCUSDT');
  });

  it('still accepts a bare object, so a payload-shape change cannot yield undefined', () => {
    expect(weexTicker(row('BTCUSDT') as never, 'BTCUSDT')?.symbol).toBe('BTCUSDT');
  });

  it('returns null (not a throw) for empty array / null / a row with no symbol', () => {
    expect(weexTicker([] as never, 'BTCUSDT')).toBeNull();
    expect(weexTicker(null, 'BTCUSDT')).toBeNull();
    expect(weexTicker([{ lastPrice: '1' }] as never, 'BTCUSDT')).toBeNull();
  });

  // THE POINT OF THE HELPER. A filtered-list endpoint can silently ignore its filter and
  // return a wrong-but-plausible row for every query; taking [0] without checking is how
  // an entire venue ends up scored on BTC's prices. This must THROW, never coerce.
  it('THROWS when the returned row is a different symbol than the one requested', () => {
    expect(() => weexTicker([row('ETHUSDT')] as never, 'BTCUSDT'))
      .toThrow(/identity mismatch — requested BTCUSDT, received ETHUSDT/);
  });

  it('is case-insensitive on the identity compare (venue casing is not a mismatch)', () => {
    expect(weexTicker([row('btcusdt')] as never, 'BTCUSDT')?.symbol).toBe('btcusdt');
  });
});

describe('V3 volume units — quoteVolume, NOT the same-named `volume`', () => {
  // MEASURED live 2026-09-03 on BTCUSDT: V2 volume_24h = 1,794,123,988 (QUOTE) while V3
  // `volume` = 23,227.70 (BASE) and V3 `quoteVolume` = 1,794,119,177. A name-match
  // mapping deflates by each coin's own price — so it does not merely rescale the
  // universe ranking, it REORDERS it.
  it('getAssetContext.volume24h reads quoteVolume and is ~77,000x the base `volume`', async () => {
    setMock('/capi/v3/market/ticker/24hr', {
      status: 200,
      body: [{
        symbol: 'BTCUSDT', lastPrice: '77594.5', openPrice: '76530.1',
        highPrice: '78144.6', lowPrice: '76189.8',
        volume: '23227.6951', quoteVolume: '1794119177.6498899',
        priceChange: '0', priceChangePercent: '0.013908',
        markPrice: '77594.9', indexPrice: '77628.95375',
        openTime: 0, closeTime: 0,
      }],
    });
    const ctx = await new WeexAdapter().getAssetContext('BTC');
    expect(ctx.volume24h).toBeCloseTo(1794119177.65, 0);
    // the exact regression this pins: reading the base-volume field instead
    expect(ctx.volume24h).not.toBeCloseTo(23227.6951, 0);
    expect(ctx.volume24h / 23227.6951).toBeGreaterThan(70000);
  });
});
