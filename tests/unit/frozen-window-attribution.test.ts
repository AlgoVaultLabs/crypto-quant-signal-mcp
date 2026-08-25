/**
 * EDGE-SELL-RESOLUTION-ASYMMETRY-W1 R0 — the attribution instrument's own tests.
 *
 * This script produces the number the flip decision rests on, so its pure parts are tested
 * before its output is believed. The two that can quietly lie:
 *
 *  1. `classifyEvalWindow` — confusing "the venue would not serve me these bars" with "the book
 *     was dead" inflates the frozen share, which is the wave's headline.
 *  2. `clusterBootstrapCI` — resampling ROWS instead of BOOKS would report a tight interval over
 *     what is really a handful of independent observations (the EDGE-CARRY-SERVING-W2 defect:
 *     n 347 → 1020, t −2.0 → −3.2).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyEvalWindow,
  clusterBootstrapCI,
  frozenAttributableShare,
  mulberry32,
  timeoutRate,
  type Classified,
} from '../../src/scripts/frozen-window-attribution.js';
import type { Candle } from '../../src/types.js';

const bar = (time: number, volume: number): Candle =>
  ({ time, open: 1, high: 1, low: 1, close: 1, volume }) as Candle;

const row = (over: Partial<Classified>): Classified => ({
  id: 1, created_at: 0, signal: 'SELL', exchange: 'XT', coin: 'D', timeframe: '4h',
  label: 0, mfe_return_pct: 0, mae_return_pct: 0,
  evalClass: 'ALL_ZERO_VOL', barsExamined: 6, zeroVolBars: 6, preBars: 24,
  wouldSuppress: true, genuineBarsPre: 0, ...over,
});

describe('classifyEvalWindow', () => {
  it('every bar traded ⇒ REAL', () => {
    const w = classifyEvalWindow([bar(0, 5), bar(1, 5), bar(2, 5)], 3);
    expect(w).toEqual({ evalClass: 'REAL', barsExamined: 3, zeroVolBars: 0 });
  });

  it('no bar traded ⇒ ALL_ZERO_VOL', () => {
    const w = classifyEvalWindow([bar(0, 0), bar(1, 0), bar(2, 0)], 3);
    expect(w).toEqual({ evalClass: 'ALL_ZERO_VOL', barsExamined: 3, zeroVolBars: 3 });
  });

  it('some bars traded ⇒ PARTIAL, carrying j of W', () => {
    const w = classifyEvalWindow([bar(0, 5), bar(1, 0), bar(2, 0)], 3);
    expect(w).toEqual({ evalClass: 'PARTIAL', barsExamined: 3, zeroVolBars: 2 });
  });

  it('a SHORT window is NO_CANDLES, never ALL_ZERO_VOL', () => {
    // The distinction the whole classification exists to protect: an unreachable window is an
    // instrument limit. Calling it frozen would manufacture the wave's own conclusion.
    const w = classifyEvalWindow([bar(0, 0), bar(1, 0)], 6);
    expect(w.evalClass).toBe('NO_CANDLES');
    expect(w.barsExamined).toBe(2);
  });

  it('an EMPTY window is NO_CANDLES', () => {
    expect(classifyEvalWindow([], 6).evalClass).toBe('NO_CANDLES');
  });

  it('examines only the FIRST W bars, ignoring anything fetched beyond the window', () => {
    // The fetch is padded; classifying the padding would score bars the barrier never raced.
    const w = classifyEvalWindow([bar(0, 5), bar(1, 5), bar(2, 0), bar(3, 0)], 2);
    expect(w).toEqual({ evalClass: 'REAL', barsExamined: 2, zeroVolBars: 0 });
  });

  it('treats a non-numeric or negative volume as NOT genuine (matches `volume > 0`)', () => {
    const junk = [
      { ...bar(0, 0), volume: NaN } as Candle,
      { ...bar(1, 0), volume: null as unknown as number } as Candle,
      bar(2, -1),
    ];
    expect(classifyEvalWindow(junk, 3).evalClass).toBe('ALL_ZERO_VOL');
  });
});

describe('mulberry32 — the bootstrap must be re-runnable to the same interval', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42), b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('differs across seeds (it is not a constant dressed as a PRNG)', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('clusterBootstrapCI — resamples BOOKS, not rows', () => {
  it('a one-book sample yields NO interval, however many rows it has', () => {
    // 200 rows off one frozen book is ONE observation. Reporting ±0.1pp here is the fake
    // precision this function exists to refuse.
    const rows = Array.from({ length: 200 }, (_, i) => row({ id: i, label: 0 }));
    const ci = clusterBootstrapCI(rows, timeoutRate);
    expect(ci.clusters).toBe(1);
    expect(ci.lo).toBeNaN();
    expect(ci.hi).toBeNaN();
  });

  it('counts distinct (venue, coin) books, not rows and not venues', () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => row({ id: i, coin: 'D' })),
      ...Array.from({ length: 50 }, (_, i) => row({ id: 100 + i, coin: 'EPT' })),
      ...Array.from({ length: 50 }, (_, i) => row({ id: 200 + i, exchange: 'HTX', coin: 'D' })),
    ];
    expect(clusterBootstrapCI(rows, timeoutRate).clusters).toBe(3);
  });

  it('brackets the point estimate and widens when books disagree', () => {
    const agree = [
      ...Array.from({ length: 20 }, (_, i) => row({ id: i, coin: 'A', label: 0 })),
      ...Array.from({ length: 20 }, (_, i) => row({ id: 100 + i, coin: 'B', label: 0 })),
      ...Array.from({ length: 20 }, (_, i) => row({ id: 200 + i, coin: 'C', label: 0 })),
    ];
    const split = [
      ...Array.from({ length: 20 }, (_, i) => row({ id: i, coin: 'A', label: 0 })),
      ...Array.from({ length: 20 }, (_, i) => row({ id: 100 + i, coin: 'B', label: 1 })),
      ...Array.from({ length: 20 }, (_, i) => row({ id: 200 + i, coin: 'C', label: 0 })),
    ];
    const a = clusterBootstrapCI(agree, timeoutRate);
    const s = clusterBootstrapCI(split, timeoutRate);
    expect(a.hi - a.lo).toBe(0);                       // unanimous books ⇒ no spread
    expect(s.hi - s.lo).toBeGreaterThan(0.3);          // one dissenting book of three
    expect(s.lo).toBeLessThanOrEqual(timeoutRate(split));
    expect(s.hi).toBeGreaterThanOrEqual(timeoutRate(split));
  });

  it('is reproducible across calls with the same seed', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row({ id: i, coin: 'A', label: 0 })),
      ...Array.from({ length: 10 }, (_, i) => row({ id: 50 + i, coin: 'B', label: 1 })),
      ...Array.from({ length: 10 }, (_, i) => row({ id: 90 + i, coin: 'C', label: -1 })),
    ];
    expect(clusterBootstrapCI(rows, timeoutRate)).toEqual(clusterBootstrapCI(rows, timeoutRate));
  });
});

describe('frozenAttributableShare', () => {
  const sell = (over: Partial<Classified>) => row({ signal: 'SELL', ...over });
  const buy = (over: Partial<Classified>) => row({ signal: 'BUY', coin: 'BTC', ...over });

  it('is 100% when removing suppressible emissions erases the whole excess', () => {
    const sells = [
      ...Array.from({ length: 8 }, (_, i) => sell({ id: i, label: 0, wouldSuppress: true })),
      ...Array.from({ length: 2 }, (_, i) => sell({ id: 50 + i, label: 1, wouldSuppress: false })),
    ];
    const buys = Array.from({ length: 10 }, (_, i) => buy({ id: 100 + i, label: 1, wouldSuppress: false }));
    // SELL 80% vs BUY 0% before; both 0% among survivors.
    expect(frozenAttributableShare(sells, buys)).toBeCloseTo(1, 6);
  });

  it('is 0% when the excess survives suppression untouched', () => {
    const sells = Array.from({ length: 10 }, (_, i) => sell({ id: i, label: 0, wouldSuppress: false }));
    const buys = Array.from({ length: 10 }, (_, i) => buy({ id: 100 + i, label: 1, wouldSuppress: false }));
    expect(frozenAttributableShare(sells, buys)).toBeCloseTo(0, 6);
  });

  it('is NaN — never 0 or 1 — when no survivors remain to compare', () => {
    // "Everything was suppressed" is not evidence of attribution; it is absence of a control.
    const sells = Array.from({ length: 5 }, (_, i) => sell({ id: i, label: 0, wouldSuppress: true }));
    const buys = Array.from({ length: 5 }, (_, i) => buy({ id: 100 + i, label: 1, wouldSuppress: true }));
    expect(frozenAttributableShare(sells, buys)).toBeNaN();
  });
});
