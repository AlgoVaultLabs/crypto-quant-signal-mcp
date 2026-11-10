// sr-probe/level-v0.ts — EDGE-SR-LEVEL-PROBE-W1 CH1: the frozen multi-timeframe support/resistance definition
// ("Level v0"), as pure functions. Internal META research: nothing here is imported by a serving path.
//
// The definition is registered verbatim in audits/sr-level-probe-preregistration-*.md and is not tuned after any
// label is read. Every constant below is that registration's; a change is a new study, never an edit.
//
//   layer bars   : closed candles whose CLOSE time (open + served step) is <= the call's created_at, the last 300
//                  (fewer available -> all of them)
//   pivot (k = 3): swing high at i  <=>  high_i >= every high in i-3 … i+3   (swing low symmetric, on lows);
//                  a pivot needs its full window on both sides, so it is usable once bar i+3 has closed
//   level        : per layer, ALL pivot prices (highs and lows together) sorted, single-link merged while the gap
//                  is <= 0.25 x ATR14 (Wilder, as-of); price = member median; touches = member count
//   qualifying   : touches >= 2
//   strength     : sum of member weights (L1 = 1, L2 = 2, L3 = 3); strong >= 4
//   OPPOSING     : a qualifying level strictly between the entry and the target barrier; otherwise CLEAR
//   f            : nearest opposing level's distance from the entry / barrier distance, in (0, 1)
//   BEHIND       : a qualifying level on the stop side within 0.25 x barrier distance of the entry
//   NAIVE        : the L1 50-bar highest high (BUY) / lowest low (SELL) strictly inside the target
//
// Prices enter as plain numbers and the barrier as an ABSOLUTE distance, so the definition is exactly symmetric
// under the reflection p -> K - p with highs <-> lows and BUY <-> SELL swapped (tests/unit/sr-level-v0.test.ts).

export interface Bar {
  /** Open time, epoch ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface V0Params {
  /** Bars on each side a pivot must dominate. */
  pivotK: number;
  /** Closed bars kept per layer, ending at the call. */
  lookbackBars: number;
  atrPeriod: number;
  /** Merge gap, in ATRs. */
  mergeAtrMult: number;
  minTouches: number;
  strongMin: number;
  /** BEHIND band, in barrier distances. */
  behindFrac: number;
  naiveBars: number;
  /** Bars admitted PAST the call's created_at. 0 in the registered definition; the mutation tests set 1. */
  lookaheadBars: number;
}

export const V0: Readonly<V0Params> = Object.freeze({
  pivotK: 3,
  lookbackBars: 300,
  atrPeriod: 14,
  mergeAtrMult: 0.25,
  minTouches: 2,
  strongMin: 4,
  behindFrac: 0.25,
  naiveBars: 50,
  lookaheadBars: 0,
});

/** Layer weights: L1 = 1, L2 = 2, L3 = 3 (index 0-based). */
export const LAYER_WEIGHTS: readonly number[] = Object.freeze([1, 2, 3]);

export type Side = 'BUY' | 'SELL';

export interface Level {
  price: number;
  touches: number;
  /** 1, 2 or 3. */
  layer: number;
  strength: number;
  /** The layer's ATR14 the level was merged under. */
  atr: number;
}

/**
 * The bars a call may see on one layer: ascending, de-duplicated by open time, closed at or before `createdAtMs`,
 * the last `lookbackBars`. `stepMs` is the SERVED step of the series (a bar closes at open + step).
 */
export function asOfBars(bars: readonly Bar[], stepMs: number, createdAtMs: number, p: V0Params = V0): Bar[] {
  const limit = createdAtMs + p.lookaheadBars * stepMs;
  const seen = new Map<number, Bar>();
  for (const b of bars) if (b.time + stepMs <= limit) seen.set(b.time, b);
  const asc = [...seen.values()].sort((a, b) => a.time - b.time);
  return asc.length > p.lookbackBars ? asc.slice(asc.length - p.lookbackBars) : asc;
}

/** Every pivot price in `bars` (ascending): swing highs' highs and swing lows' lows, full ±k window required. */
export function pivotPrices(bars: readonly Bar[], k: number = V0.pivotK): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = k; i + k < bars.length; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k && (isHigh || isLow); j++) {
      if (bars[j].high > bars[i].high) isHigh = false;
      if (bars[j].low < bars[i].low) isLow = false;
    }
    if (isHigh) highs.push(bars[i].high);
    if (isLow) lows.push(bars[i].low);
  }
  return { highs, lows };
}

/** Wilder ATR over `bars` (ascending), as of the last bar. Null below period + 1 bars. */
export function wilderAtr(bars: readonly Bar[], period: number = V0.atrPeriod): number | null {
  if (bars.length < period + 1) return null;
  const tr = (i: number): number => {
    const pc = bars[i - 1].close;
    return Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  };
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr(i);
  atr /= period;
  for (let i = period + 1; i < bars.length; i++) atr = (atr * (period - 1) + tr(i)) / period;
  return atr;
}

function median(sortedAsc: readonly number[]): number {
  const n = sortedAsc.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/** One layer's levels (every cluster, qualifying or not) from its as-of bars. Empty when the ATR is undefined. */
export function layerLevels(asOf: readonly Bar[], layer: number, p: V0Params = V0): Level[] {
  const atr = wilderAtr(asOf, p.atrPeriod);
  if (atr === null) return [];
  const { highs, lows } = pivotPrices(asOf, p.pivotK);
  const prices = [...highs, ...lows].sort((a, b) => a - b);
  if (prices.length === 0) return [];
  const gap = p.mergeAtrMult * atr;
  const weight = LAYER_WEIGHTS[layer - 1];
  const out: Level[] = [];
  let members: number[] = [prices[0]];
  const flush = (): void => {
    out.push({ price: median(members), touches: members.length, layer, strength: members.length * weight, atr });
  };
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] - prices[i - 1] <= gap) members.push(prices[i]);
    else {
      flush();
      members = [prices[i]];
    }
  }
  flush();
  return out;
}

export type FBin = 'F1' | 'F2' | 'F3' | 'CLEAR';

export interface Stratum {
  /** A qualifying level strictly between the entry and the target barrier. */
  opposing: boolean;
  /** Nearest opposing level's distance / barrier distance; null when CLEAR. */
  f: number | null;
  /** (0,1/3] · (1/3,2/3] · (2/3,1) · CLEAR. */
  fBin: FBin;
  /** A qualifying level on the stop side within behindFrac x barrier distance. */
  behind: boolean;
  /** At least one opposing level is strong. */
  opposingStrong: boolean;
  nOpposing: number;
  nQualifying: number;
}

/** Signed distance of `price` from the entry toward the target: positive on the target side. */
function toward(side: Side, entry: number, price: number): number {
  return side === 'BUY' ? price - entry : entry - price;
}

/** The levels of `levels` that qualify and oppose the call. */
export function opposingLevels(side: Side, entry: number, barrierDist: number, levels: readonly Level[], p: V0Params = V0): Level[] {
  return levels.filter((l) => {
    if (l.touches < p.minTouches) return false;
    const d = toward(side, entry, l.price);
    return d > 0 && d < barrierDist;
  });
}

/** Classify one call against the levels of all its layers. `barrierDist` is the absolute target distance (> 0). */
export function classify(side: Side, entry: number, barrierDist: number, levels: readonly Level[], p: V0Params = V0): Stratum {
  const qualifying = levels.filter((l) => l.touches >= p.minTouches);
  const opp = opposingLevels(side, entry, barrierDist, levels, p);
  let nearest = Infinity;
  for (const l of opp) nearest = Math.min(nearest, toward(side, entry, l.price));
  const opposing = opp.length > 0;
  const f = opposing ? nearest / barrierDist : null;
  const fBin: FBin = f === null ? 'CLEAR' : f <= 1 / 3 ? 'F1' : f <= 2 / 3 ? 'F2' : 'F3';
  const behind = qualifying.some((l) => {
    const d = -toward(side, entry, l.price);
    return d > 0 && d <= p.behindFrac * barrierDist;
  });
  return {
    opposing,
    f,
    fBin,
    behind,
    opposingStrong: opp.some((l) => l.strength >= p.strongMin),
    nOpposing: opp.length,
    nQualifying: qualifying.length,
  };
}

/** NAIVE-OPPOSING: the L1 `naiveBars` highest high (BUY) / lowest low (SELL) strictly inside the target. */
export function naiveOpposing(side: Side, entry: number, barrierDist: number, l1AsOf: readonly Bar[], p: V0Params = V0): boolean {
  if (l1AsOf.length === 0) return false;
  const tail = l1AsOf.slice(Math.max(0, l1AsOf.length - p.naiveBars));
  const extreme = side === 'BUY' ? Math.max(...tail.map((b) => b.high)) : Math.min(...tail.map((b) => b.low));
  const d = toward(side, entry, extreme);
  return d > 0 && d < barrierDist;
}

export interface LayerSeries {
  /** 1, 2 or 3. */
  layer: number;
  /** The series' served step, ms. */
  stepMs: number;
  /** Every bar on hand for the series, any order. */
  bars: readonly Bar[];
}

export interface CallFeatures extends Stratum {
  naive: boolean;
  /** As-of bars seen per layer (index 0 = L1); 0 for an absent layer. */
  layerBars: number[];
  levels: Level[];
}

/** The whole definition for one call: as-of bars per layer -> levels -> stratum, plus the naive comparator. */
export function callFeatures(
  side: Side,
  entry: number,
  barrierDist: number,
  createdAtMs: number,
  layers: readonly LayerSeries[],
  p: V0Params = V0,
): CallFeatures {
  const levels: Level[] = [];
  const layerBars = [0, 0, 0];
  let l1: Bar[] = [];
  for (const s of layers) {
    const asOf = asOfBars(s.bars, s.stepMs, createdAtMs, p);
    layerBars[s.layer - 1] = asOf.length;
    if (s.layer === 1) l1 = asOf;
    levels.push(...layerLevels(asOf, s.layer, p));
  }
  return { ...classify(side, entry, barrierDist, levels, p), naive: naiveOpposing(side, entry, barrierDist, l1, p), layerBars, levels };
}
