/**
 * OPS-SERVED-CANDLE-TRUTH-W1 CH3a — the live-price ladder (src/lib/live-price.ts; Cowork Q8, Mr.1 Q10 = C).
 * A non-declared venue's price is its newest close, byte-identical to the pre-wave `closes[length - 1]`, whatever the
 * window or the ticker. A declared closed-only kline venue is priced from its forming bar, else its fresh ticker, else
 * refused; never from its last closed bar.
 */
import { describe, it, expect } from 'vitest';
import { CLOSED_ONLY_KLINE_VENUES, LIVE_TICKER_MAX_AGE_MS, isClosedOnlyKlineVenue, livePriceOf } from '../../src/lib/live-price.js';
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

describe('the declaration', () => {
  it('is exactly PHEMEX, frozen, and every entry is a promoted venue', () => {
    expect([...CLOSED_ONLY_KLINE_VENUES]).toEqual(['PHEMEX']);
    expect(Object.isFrozen(CLOSED_ONLY_KLINE_VENUES)).toBe(true);
    for (const v of CLOSED_ONLY_KLINE_VENUES) expect(PROMOTED_VENUE_IDS).toContain(v);
    expect(isClosedOnlyKlineVenue('PHEMEX')).toBe(true);
    expect(isClosedOnlyKlineVenue('BITGET')).toBe(false);
  });
});

describe('a non-declared venue: the newest close, byte-identical, on every window (Q10 = C)', () => {
  const others = (PROMOTED_VENUE_IDS as readonly ExchangeId[]).filter((v) => !isClosedOnlyKlineVenue(v));
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
    expect(others.length).toBe(PROMOTED_VENUE_IDS.length - 1);
  });
});

describe('a declared venue (PHEMEX): forming close, else a fresh ticker, else refused', () => {
  it('rung 1: the newest bar is forming (its interval holds now): its close', () => {
    const c = bars(FORMING);
    expect(livePriceOf(w(c), fresh, 'PHEMEX', NOW)).toBe(c[c.length - 1].close);
  });
  it('rung 2: forming - 1 with a ticker at most 60 s old: the ticker last, never the last close', () => {
    const c = bars(FORMING - H);
    expect(livePriceOf(w(c), fresh, 'PHEMEX', NOW)).toBe(123.4);
    expect(livePriceOf(w(c), { lastTrade: { price: 9, atMs: NOW - LIVE_TICKER_MAX_AGE_MS } }, 'PHEMEX', NOW)).toBe(9);
    expect(livePriceOf(w(c), { lastTrade: { price: 9, atMs: NOW + 1_000 } }, 'PHEMEX', NOW)).toBe(9);
  });
  it('rung 2 with an unknown step: never trusts the newest bar, uses the ticker', () => {
    expect(livePriceOf(w(bars(FORMING), null), fresh, 'PHEMEX', NOW)).toBe(123.4);
  });
  it.each([
    ['no ticker', {}],
    ['a ticker 1 ms past the ceiling', { lastTrade: { price: 9, atMs: NOW - LIVE_TICKER_MAX_AGE_MS - 1 } }],
    ['a ticker more than 60 s in the future', { lastTrade: { price: 9, atMs: NOW + LIVE_TICKER_MAX_AGE_MS + 1 } }],
    ['a zero price', { lastTrade: { price: 0, atMs: NOW } }],
    ['a NaN price', { lastTrade: { price: Number.NaN, atMs: NOW } }],
    ['a NaN timestamp', { lastTrade: { price: 9, atMs: Number.NaN } }],
  ])('rung 3: %s → StaleUpstreamWindowError, typed, naming the venue', (_why, ctx) => {
    let err: unknown;
    try { livePriceOf(w(bars(FORMING - H)), ctx, 'PHEMEX', NOW); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StaleUpstreamWindowError);
    expect(err).toMatchObject({ code: 'STALE_UPSTREAM_WINDOW', coin: 'BTC', exchange: 'PHEMEX', timeframe: '1h', newestBarAt: FORMING - H, headGapBars: 0, headStaleBars: 0 });
    expect((err as Error).message).toContain('there is no live price');
  });
});

describe('an empty window is refused on every venue', () => {
  it.each(['BINANCE', 'PHEMEX'] as const)('%s', (v) => {
    expect(() => livePriceOf(w([]), fresh, v, NOW)).toThrow(StaleUpstreamWindowError);
  });
});
