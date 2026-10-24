/**
 * OPS-SERVED-CANDLE-TRUTH-W1 CH3a / Q11 — the live price (src/lib/live-price.ts; Cowork Q8 / Q11, Mr.1 Q10 = C).
 * A non-declared venue's price is its newest close, byte-identical to the pre-wave `closes[length - 1]`, whatever the
 * window or the ticker. A declared ticker-priced venue is priced from its ticker's last trade ALWAYS — never a candle
 * close, even with a forming bar present — when the ticker passes its kind's check, else refused.
 */
import { describe, it, expect } from 'vitest';
import {
  CLOSED_ONLY_KLINE_VENUES, LIVE_TICKER_MAX_AGE_MS, TICKER_PRICED_VENUES, TRADE_GATED_KLINE_VENUES, isClosedOnlyKlineVenue, isTickerPricedVenue,
  isTradeGatedKlineVenue, livePriceOf, tickerPricedKind,
} from '../../src/lib/live-price.js';
import { StaleUpstreamWindowError } from '../../src/lib/errors.js';
import { PROMOTED_VENUE_IDS } from '../../src/lib/capabilities.js';
import type { Candle, ExchangeId } from '../../src/types.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 23, 9, 30, 12);
const FORMING = Math.floor(NOW / H) * H;
const bars = (newestOpen: number, n = 5): Candle[] =>
  Array.from({ length: n }, (_, k) => {
    const t = newestOpen - (n - 1 - k) * H;
    return { time: t, open: 100 + k, high: 102 + k, low: 99 + k, close: 100.5 + k, volume: 10 };
  });
const w = (candles: Candle[], servedStepMs: number | null = H) => ({ coin: 'BTC', timeframe: '1h', candles, servedStepMs });
const fresh = { lastTrade: { price: 123.4, atMs: NOW - 2_000 } };

describe('the declaration (Q11: ONE kind map)', () => {
  it('is exactly PHEMEX CLOSED_ONLY and ASTER SNAPSHOT_KLINE, frozen, every entry a promoted venue', () => {
    expect({ ...TICKER_PRICED_VENUES }).toEqual({ PHEMEX: 'CLOSED_ONLY', ASTER: 'SNAPSHOT_KLINE' });
    expect(Object.isFrozen(TICKER_PRICED_VENUES)).toBe(true);
    for (const v of Object.keys(TICKER_PRICED_VENUES)) expect(PROMOTED_VENUE_IDS).toContain(v);
  });
  it('the closed-only list and every predicate derive from it', () => {
    expect([...CLOSED_ONLY_KLINE_VENUES]).toEqual(['PHEMEX']);
    expect(Object.isFrozen(CLOSED_ONLY_KLINE_VENUES)).toBe(true);
    expect(isClosedOnlyKlineVenue('PHEMEX')).toBe(true);
    expect(isClosedOnlyKlineVenue('ASTER')).toBe(false);
    expect(isClosedOnlyKlineVenue('BITGET')).toBe(false);
    expect([tickerPricedKind('PHEMEX'), tickerPricedKind('ASTER'), tickerPricedKind('BINANCE')]).toEqual(['CLOSED_ONLY', 'SNAPSHOT_KLINE', null]);
    expect(isTickerPricedVenue('ASTER')).toBe(true);
    // an inherited key is not a declaration
    for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(tickerPricedKind(k)).toBeNull();
      expect(isTickerPricedVenue(k)).toBe(false);
    }
  });
});

describe('a non-declared venue: the newest close, byte-identical, on every window (Q10 = C)', () => {
  const others = (PROMOTED_VENUE_IDS as readonly ExchangeId[]).filter((v) => !isTickerPricedVenue(v));
  it.each([
    ['a window through the forming bar', bars(FORMING)],
    ['a window one bar short (thin book / boundary)', bars(FORMING - H)],
    ['a window 30 bars stale', bars(FORMING - 30 * H)],
  ])('%s', (_why, c) => {
    for (const v of others) {
      for (const ctx of [fresh, {}, { lastTrade: { price: 1, atMs: 0 } }]) {
        expect(livePriceOf(w(c), ctx, v, NOW)).toBe(c[c.length - 1].close);
      }
    }
    expect(others.length).toBe(PROMOTED_VENUE_IDS.length - Object.keys(TICKER_PRICED_VENUES).length);
  });
});

describe('CH3a-R2 (Q14): a trade-gated kline venue (HL, KUCOIN) is a canary declaration, never a pricing kind', () => {
  it('is exactly HL and KUCOIN, frozen, promoted, and in no TICKER_PRICED_VENUES kind', () => {
    expect([...TRADE_GATED_KLINE_VENUES]).toEqual(['HL', 'KUCOIN']);
    expect(Object.isFrozen(TRADE_GATED_KLINE_VENUES)).toBe(true);
    for (const v of TRADE_GATED_KLINE_VENUES) {
      expect(PROMOTED_VENUE_IDS).toContain(v);
      expect(isTradeGatedKlineVenue(v)).toBe(true);
      expect(tickerPricedKind(v)).toBeNull();
      expect(isTickerPricedVenue(v)).toBe(false);
    }
    for (const k of ['BINANCE', 'PHEMEX', 'ASTER', 'toString', 'hl']) expect(isTradeGatedKlineVenue(k)).toBe(false);
  });
  it('livePriceOf on HL and KUCOIN is the newest close, whatever the head or the last trade', () => {
    for (const v of TRADE_GATED_KLINE_VENUES) {
      for (const c of [bars(FORMING), bars(FORMING - H), bars(FORMING - 2 * H)]) {
        for (const ctx of [fresh, {}, { lastTrade: { price: 1, atMs: NOW - 20_000 } }, { lastTrade: { price: 999, atMs: 0 } }]) {
          expect(livePriceOf(w(c), ctx, v, NOW)).toBe(c[c.length - 1].close);
        }
      }
    }
  });
});

describe('a declared venue: the ticker\'s last trade, always (Q11)', () => {
  it.each(['PHEMEX', 'ASTER'] as const)('%s: the ticker on every window — a forming bar, forming - 1, an unknown step — never a candle close', (v) => {
    for (const c of [bars(FORMING), bars(FORMING - H), bars(FORMING - 2 * H)]) {
      expect(livePriceOf(w(c), fresh, v, NOW)).toBe(123.4);
      expect(livePriceOf(w(c, null), fresh, v, NOW)).toBe(123.4);
    }
  });
  it.each(['PHEMEX', 'ASTER'] as const)('%s: no ticker, a zero or a NaN price → refused, naming the kind', (v) => {
    for (const ctx of [{}, { lastTrade: { price: 0, atMs: NOW } }, { lastTrade: { price: -1, atMs: NOW } }, { lastTrade: { price: Number.NaN, atMs: NOW } }]) {
      let err: unknown;
      try { livePriceOf(w(bars(FORMING)), ctx, v, NOW); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(StaleUpstreamWindowError);
      expect((err as Error).message).toContain(v === 'ASTER' ? 'serves a lagging candle snapshot' : 'serves closed candles only');
    }
  });
});

describe('SNAPSHOT_KLINE (ASTER): a positive last price, NO age bound', () => {
  it('a last trade hours old still prices the call (a thin book\'s last trade is its live price)', () => {
    expect(livePriceOf(w(bars(FORMING)), { lastTrade: { price: 9, atMs: NOW - 6 * H } }, 'ASTER', NOW)).toBe(9);
    expect(livePriceOf(w(bars(FORMING)), { lastTrade: { price: 9, atMs: Number.NaN } }, 'ASTER', NOW)).toBe(9);
  });
});

describe('CLOSED_ONLY (PHEMEX): a ticker snapshot at most 60 s from now, else refused', () => {
  it('a ticker at most 60 s old: the ticker last, never the last close', () => {
    const c = bars(FORMING - H);
    expect(livePriceOf(w(c), fresh, 'PHEMEX', NOW)).toBe(123.4);
    expect(livePriceOf(w(c), { lastTrade: { price: 9, atMs: NOW - LIVE_TICKER_MAX_AGE_MS } }, 'PHEMEX', NOW)).toBe(9);
    expect(livePriceOf(w(c), { lastTrade: { price: 9, atMs: NOW + 1_000 } }, 'PHEMEX', NOW)).toBe(9);
  });
  it.each([
    ['no ticker', {}],
    ['a ticker 1 ms past the ceiling', { lastTrade: { price: 9, atMs: NOW - LIVE_TICKER_MAX_AGE_MS - 1 } }],
    ['a ticker more than 60 s in the future', { lastTrade: { price: 9, atMs: NOW + LIVE_TICKER_MAX_AGE_MS + 1 } }],
    ['a zero price', { lastTrade: { price: 0, atMs: NOW } }],
    ['a NaN price', { lastTrade: { price: Number.NaN, atMs: NOW } }],
    ['a NaN timestamp', { lastTrade: { price: 9, atMs: Number.NaN } }],
  ])('%s → StaleUpstreamWindowError, typed, naming the venue', (_why, ctx) => {
    let err: unknown;
    try { livePriceOf(w(bars(FORMING - H)), ctx, 'PHEMEX', NOW); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StaleUpstreamWindowError);
    expect(err).toMatchObject({ code: 'STALE_UPSTREAM_WINDOW', coin: 'BTC', exchange: 'PHEMEX', timeframe: '1h', newestBarAt: FORMING - H, headGapBars: 0, headStaleBars: 0 });
    expect((err as Error).message).toContain('there is no live price');
  });
});

describe('an empty window is refused on every venue', () => {
  it.each(['BINANCE', 'PHEMEX', 'ASTER'] as const)('%s', (v) => {
    expect(() => livePriceOf(w([]), fresh, v, NOW)).toThrow(StaleUpstreamWindowError);
  });
});
