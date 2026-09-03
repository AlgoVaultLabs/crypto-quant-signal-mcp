/**
 * OPS-RATCHET-BASELINE-RETIRE-W1 Ch1 — the SIGNAL-PATH default-deny contract.
 *
 * SEC-40's ratchet (`scripts/check-adapter-numeric-guard.mjs`) counts raw parse sites; it
 * cannot see whether the surviving ones are the harmless kind. This file pins the BEHAVIOUR
 * the sweep bought, per adapter, so a future refactor that quietly reverts an adapter to
 * `parseFloat` fails here and not only in the count.
 *
 * THE HAZARD, stated concretely. `parseFloat` is a PREFIX parser:
 *   parseFloat('12abc') === 12      ← a plausible-looking, wrong, FINITE price
 *   parseFloat('0x1')   === 0       ← a zero price; `Number('0x1')` is 1 instead
 * All three pass `Number.isFinite`, so every downstream guard keyed on finiteness waves them
 * through and the number reaches a scoring term and then a paid verdict. `safeUpstreamNum`
 * applies a strict decimal/scientific regex and returns `null`, so the caller default-denies.
 *
 * The contract, matching the aster/edgex reference adapters:
 *   - kline OHLC   → the candle is DROPPED (never a NaN/truncated bar in the series)
 *   - mark price   → getAssetContext THROWS, so the 3-tier fallback fires
 *   - getCurrentPrice → returns null rather than a wrong-but-finite number
 *
 * EVERY case carries a VALID control asserted alongside the poisoned one. Without it a broken
 * fixture (wrong envelope shape, wrong symbol) would make the poisoned assertion pass for the
 * wrong reason — the test would be green while proving nothing, which is the exact failure
 * mode this repo's verdict-token law exists to prevent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BinanceAdapter } from '../../src/lib/adapters/binance.js';
import { BingxAdapter } from '../../src/lib/adapters/bingx.js';
import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';
import { BitmartAdapter } from '../../src/lib/adapters/bitmart.js';
import { BybitAdapter } from '../../src/lib/adapters/bybit.js';
import { GateAdapter } from '../../src/lib/adapters/gateio.js';
import { HTXAdapter } from '../../src/lib/adapters/htx.js';
import { OKXAdapter } from '../../src/lib/adapters/okx.js';
import { PhemexAdapter } from '../../src/lib/adapters/phemex.js';
import { WeexAdapter } from '../../src/lib/adapters/weex.js';
import { WhitebitAdapter } from '../../src/lib/adapters/whitebit.js';
import { XtAdapter } from '../../src/lib/adapters/xt.js';
import { safeUpstreamNum } from '../../src/lib/adapters/_upstream-fetch.js';

// ── Test-double fetch (same idiom as the per-adapter suites) ─────────────

interface MockResponse { status?: number; statusText?: string; body?: unknown }

let mockResponses: Map<string, MockResponse>;
let originalFetch: typeof fetch;

function setMock(urlSubstring: string, body: unknown, status = 200): void {
  mockResponses.set(urlSubstring, { status, body });
}

beforeEach(() => {
  mockResponses = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [substr, resp] of mockResponses.entries()) {
      if (url.includes(substr)) {
        const status = resp.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: resp.statusText ?? 'OK',
          headers: { get: () => null },
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as unknown as Response;
      }
    }
    throw new Error(`[mock-fetch] unhandled URL: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

/** The two shapes that silently survive `parseFloat` + `Number.isFinite`. */
const POISON = ['12abc', '0x1'] as const;

// ── The premise the whole sweep rests on ─────────────────────────────────

describe('the hazard is real (premise check)', () => {
  it('parseFloat accepts a truncating prefix and a hex literal; safeUpstreamNum refuses both', () => {
    // If these ever stop holding, every assertion below is testing nothing.
    expect(parseFloat('12abc')).toBe(12);
    expect(Number.isFinite(parseFloat('12abc'))).toBe(true);
    expect(parseFloat('0x1')).toBe(0);
    expect(Number('0x1')).toBe(1);
    for (const bad of POISON) expect(safeUpstreamNum(bad)).toBeNull();
    expect(safeUpstreamNum('77318.1')).toBeCloseTo(77318.1);
  });
});

// ── getCurrentPrice: the uniform per-adapter signal-path surface ─────────

/** Each row poisons EVERY field the adapter's price fallback chain can reach. */
const PRICE_CASES: {
  name: string;
  run: () => Promise<number | null>;
  mock: (px: string) => void;
}[] = [
  {
    name: 'binance',
    mock: px => setMock('/fapi/v1/premiumIndex', { symbol: 'BTCUSDT', markPrice: px }),
    run: () => new BinanceAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'bingx',
    mock: px => setMock('/openApi/swap/v2/quote/premiumIndex', { code: 0, msg: '', data: { symbol: 'BTC-USDT', markPrice: px } }),
    run: () => new BingxAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'bitget',
    mock: px => setMock('market/ticker?', { code: '00000', msg: 'success', data: [{ symbol: 'BTCUSDT', markPrice: px, lastPr: px, open24h: px }] }),
    run: () => new BitgetAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'bitmart',
    mock: px => setMock('/contract/public/details', { data: { symbols: [{ symbol: 'BTCUSDT', mark_price: px, index_price: px, last_price: px }] } }),
    run: () => new BitmartAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'bybit',
    mock: px => setMock('/v5/market/tickers', { retCode: 0, retMsg: '', result: { list: [{ symbol: 'BTCUSDT', markPrice: px }] } }),
    run: () => new BybitAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'gateio',
    mock: px => setMock('/api/v4/futures/usdt/tickers', [{ contract: 'BTC_USDT', mark_price: px }]),
    run: () => new GateAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'htx',
    mock: px => setMock('/linear-swap-ex/market/detail/merged', { ch: '', status: 'ok', tick: { close: px }, ts: 0 }),
    run: () => new HTXAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'okx',
    mock: px => setMock('/api/v5/public/mark-price', { code: '0', msg: '', data: [{ instId: 'BTC-USDT-SWAP', markPx: px }] }),
    run: () => new OKXAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'phemex',
    mock: px => setMock('/md/v2/ticker/24hr', { error: null, id: 0, result: { markPriceRp: px } }),
    run: () => new PhemexAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'weex',
    // V3: one-element array, uppercase symbol, lastPrice (was V2's bare object + `last`).
    mock: px => setMock('/capi/v3/market/ticker/24hr', [{ symbol: 'BTCUSDT', markPrice: px, indexPrice: px, lastPrice: px }]),
    run: () => new WeexAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'whitebit',
    mock: px => setMock('/api/v4/public/futures', {
      message: null, success: true,
      result: [{ ticker_id: 'BTC_PERP', money_currency: 'USDT', last_price: px, index_price: px }],
    }),
    run: () => new WhitebitAdapter().getCurrentPrice('BTC'),
  },
  {
    name: 'xt',
    mock: px => setMock('/future/market/v1/public/q/agg-ticker', { returnCode: 0, result: { s: 'btc_usdt', m: px, i: px } }),
    run: () => new XtAdapter().getCurrentPrice('BTC'),
  },
];

describe('getCurrentPrice default-denies a wrong-but-finite upstream price', () => {
  for (const c of PRICE_CASES) {
    it(`${c.name}: parses a valid price, and returns null for a truncating/hex one`, async () => {
      // CONTROL — proves the fixture actually reaches the parse (no vacuous pass below).
      c.mock('77318.1');
      expect(await c.run()).toBeCloseTo(77318.1);

      for (const bad of POISON) {
        mockResponses = new Map();
        c.mock(bad);
        // Pre-sweep this returned 12 (or 0) — finite, plausible, and wrong.
        expect(await c.run(), `${c.name} accepted ${bad}`).toBeNull();
      }
    });
  }
});

// ── getAssetContext: an unusable mark price must THROW, not score a 0 ────

describe('getAssetContext throws rather than scoring an unparseable mark price', () => {
  it('weex', async () => {
    setMock('/capi/v3/market/ticker/24hr', [{
      symbol: 'BTCUSDT', lastPrice: '77318.1', markPrice: '77327.8', indexPrice: '77359.15',
      openPrice: '77000', highPrice: '0', lowPrice: '0', volume: '0', quoteVolume: '0',
      priceChangePercent: '0',
    }]);
    await expect(new WeexAdapter().getAssetContext('BTC')).resolves.toMatchObject({ coin: 'BTC' });

    mockResponses = new Map();
    setMock('/capi/v3/market/ticker/24hr', [{
      symbol: 'BTCUSDT', lastPrice: '77318.1', markPrice: '12abc', indexPrice: '77359.15',
      openPrice: '77000', highPrice: '0', lowPrice: '0', volume: '0', quoteVolume: '0',
      priceChangePercent: '0',
    }]);
    await expect(new WeexAdapter().getAssetContext('BTC')).rejects.toThrow(/invalid markPrice/);
  });

  it('xt', async () => {
    const funding = { returnCode: 0, result: { symbol: 'btc_usdt', fundingRate: 0, nextCollectionTime: 0, collectionInternal: 8 } };
    setMock('/future/market/v1/public/q/funding-rate', funding);
    setMock('/future/market/v1/public/q/agg-ticker', { returnCode: 0, result: { s: 'btc_usdt', m: '77307.0', i: '77300.0', o: '0', v: '0' } });
    await expect(new XtAdapter().getAssetContext('BTC')).resolves.toMatchObject({ coin: 'BTC' });

    setMock('/future/market/v1/public/q/agg-ticker', { returnCode: 0, result: { s: 'btc_usdt', m: '0x1', i: '77300.0', o: '0', v: '0' } });
    await expect(new XtAdapter().getAssetContext('BTC')).rejects.toThrow(/invalid mark price/);
  });

  it('phemex', async () => {
    setMock('/md/v2/ticker/24hr', {
      error: null, id: 0,
      result: { markPriceRp: '7338.5', indexPriceRp: '7338.0', openRp: '7300', closeRp: '7330', turnoverRv: '0', openInterestRv: '0', fundingRateRr: '0' },
    });
    await expect(new PhemexAdapter().getAssetContext('BTC')).resolves.toMatchObject({ coin: 'BTC' });

    setMock('/md/v2/ticker/24hr', {
      error: null, id: 0,
      result: { markPriceRp: '12abc', indexPriceRp: '7338.0', openRp: '7300', closeRp: '7330', turnoverRv: '0', openInterestRv: '0', fundingRateRr: '0' },
    });
    await expect(new PhemexAdapter().getAssetContext('BTC')).rejects.toThrow(/invalid markPriceRp/);
  });
});

// ── getCandles: a bad bar is dropped, and ONLY the bad bar ───────────────

describe('getCandles drops an unparseable bar instead of emitting NaN into the series', () => {
  it('binance (array-of-arrays rows)', async () => {
    const bar = (t: number, o: string) => [t, o, '11', '9', '10.5', '100', t + 1, '0', 0, '0', '0', '0'];
    setMock('/fapi/v1/klines', [bar(1_000, '10'), bar(2_000, '12abc'), bar(3_000, '10')]);

    const out = await new BinanceAdapter().getCandles('BTC', '1h', 0);
    expect(out.map(c => c.time)).toEqual([1_000, 3_000]);   // the poisoned bar, and only it, is gone
    expect(out.every(c => Number.isFinite(c.open))).toBe(true);
  });

  it('gateio (object rows)', async () => {
    const bar = (t: number, o: string) => ({ t, o, h: '11', l: '9', c: '10.5', v: 100 });
    setMock('/api/v4/futures/usdt/candlesticks', [bar(1, '10'), bar(2, '0x1'), bar(3, '10')]);

    const out = await new GateAdapter().getCandles('BTC', '1h', 0);
    expect(out.map(c => c.time)).toEqual([1_000, 3_000]);
    expect(out.every(c => Number.isFinite(c.close))).toBe(true);
  });

  it('bybit (descending rows, reversed by the adapter)', async () => {
    const bar = (t: number, o: string) => [String(t), o, '11', '9', '10.5', '100'];
    // Bybit returns newest-first; the adapter reverses, so expect ascending output.
    setMock('/v5/market/kline', {
      retCode: 0, retMsg: '',
      result: { list: [bar(3_000, '10'), bar(2_000, '12abc'), bar(1_000, '10')] },
    });

    const out = await new BybitAdapter().getCandles('BTC', '1h', 0);
    expect(out.map(c => c.time)).toEqual([1_000, 3_000]);
    expect(out.every(c => Number.isFinite(c.high))).toBe(true);
  });
});
