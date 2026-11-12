// sr-backtest/zones.ts — EDGE-SR-LEVEL-BACKTEST-W1: zone rule Z1, pure. Exported for the level-check tool (T2),
// which must serve exactly these zones: ops/sr-level-parity-fixture.json is this module's output on seeded windows.
//
// Level v0 is imported and never edited: `asOfBars` makes the as-of cut (closed bars, last 300), `pivotPrices`
// finds the swing points, `wilderAtr` gives ATR14 and `layerLevels` is the ONE clustering (single-link, gap
// <= 0.25 ATR). This module adds no second clustering: it reads each cluster's extent off the sorted pivot prices,
// using the touch counts `layerLevels` returned.
//
//   zone          the cluster's [min, max], widened about its centre to at least `minWidthAtr` ATR
//   qualifying    touches >= V0.minTouches
//   label         WEAK (2 touches) · MEDIUM (3) · STRONG (>= V0.strongMin) — the as-of touch count only
//   round flag    the zone holds a price with at most two significant digits
//   served set    the nearest <= `maxServed` qualifying zones wholly below the price (supports) and wholly above
//                 (resistances); a zone holding the price is reported as `at`
//   Super Strong  a served zone overlapping a qualifying zone of another chosen timeframe at the same instant:
//                 PAIR with one agreeing timeframe, TRIPLE with two or more
//
// No I/O, no clock, no randomness.
import { asOfBars, layerLevels, pivotPrices, wilderAtr, type Bar } from '../sr-probe/level-v0.js';
import { BT, type BtParams } from './spec.js';

export type Side = 'support' | 'resistance';
export type Label = 'WEAK' | 'MEDIUM' | 'STRONG';
export type SuperStrong = 'NONE' | 'PAIR' | 'TRIPLE';

export interface Zone {
  lo: number;
  hi: number;
  /** Level v0's price for the cluster: the median of its pivots. */
  level: number;
  touches: number;
  label: Label;
  round: boolean;
  /** The cluster's own extent, before the width floor. */
  rawLo: number;
  rawHi: number;
}

/** The qualifying zones of one timeframe at one instant, ascending, with that timeframe's ATR14 (null below 15 bars). */
export interface ZoneSet {
  atr: number | null;
  zones: Zone[];
}

export interface ServedZone extends Zone {
  side: Side | 'at';
  /** 1 = nearest. */
  rank: number;
  /** Gap between the price and the zone's near edge, in ATR (0 for `at`). */
  distanceAtr: number;
  distancePct: number;
  widthAtr: number;
  /** The other chosen timeframes holding an overlapping qualifying zone at this instant. */
  agree: string[];
  superStrong: SuperStrong;
}

export interface ServedFrame {
  key: string;
  atr: number | null;
  supports: ServedZone[];
  resistances: ServedZone[];
  at: ServedZone[];
}

export const labelOf = (touches: number, p: BtParams = BT): Label =>
  touches >= p.strongTouches ? 'STRONG' : touches >= p.mediumTouches ? 'MEDIUM' : 'WEAK';

/** Closed intervals: a shared edge is an overlap. */
export const overlaps = (a: { lo: number; hi: number }, b: { lo: number; hi: number }): boolean => a.lo <= b.hi && b.lo <= a.hi;

/** The spacing of prices with at most two significant digits around `x`: 10^(floor(log10 x) - 1). */
export function roundStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return NaN;
  let e = Math.floor(Math.log10(x));
  while (10 ** (e + 1) <= x) e++;
  while (10 ** e > x) e--;
  return 10 ** (e - 1);
}

/** True when [lo, hi] holds a multiple of `roundStep(ref)`. */
export function holdsRound(lo: number, hi: number, ref: number): boolean {
  const step = roundStep(ref);
  if (!Number.isFinite(step)) return false;
  const first = Math.ceil(lo / step - 1e-9) * step;
  return first <= hi + step * 1e-9;
}

/** Z1 on bars that are already the as-of window. */
export function zoneSetOf(asOf: readonly Bar[], p: BtParams = BT): ZoneSet {
  const atr = wilderAtr(asOf, p.v0.atrPeriod);
  const levels = layerLevels(asOf, 1, p.v0);
  if (atr === null || levels.length === 0) return { atr, zones: [] };
  const { highs, lows } = pivotPrices(asOf, p.v0.pivotK);
  const prices = [...highs, ...lows].sort((a, b) => a - b);
  const zones: Zone[] = [];
  let at = 0;
  for (const lv of levels) {
    const rawLo = prices[at];
    const rawHi = prices[at + lv.touches - 1];
    at += lv.touches;
    if (lv.touches < p.v0.minTouches) continue;
    const centre = (rawLo + rawHi) / 2;
    const half = Math.max((rawHi - rawLo) / 2, (p.minWidthAtr * atr) / 2);
    zones.push({
      lo: centre - half, hi: centre + half, level: lv.price, touches: lv.touches, label: labelOf(lv.touches, p),
      round: holdsRound(centre - half, centre + half, lv.price), rawLo, rawHi,
    });
  }
  if (at !== prices.length) throw new Error('sr-backtest zones: level v0 clusters do not account for every pivot');
  return { atr, zones };
}

/** Z1 as of `instantMs`: only bars closed by then, the last `lookbackBars` of them. */
export function zoneSetAsOf(bars: readonly Bar[], stepMs: number, instantMs: number, p: BtParams = BT): ZoneSet {
  return zoneSetOf(asOfBars(bars, stepMs, instantMs, p.v0), p);
}

/** The served set of one timeframe at one price. Supports and resistances are nearest first. */
export function servedOf(set: ZoneSet, price: number, p: BtParams = BT): { supports: Zone[]; resistances: Zone[]; at: Zone[] } {
  const supports: Zone[] = [];
  const resistances: Zone[] = [];
  const at: Zone[] = [];
  for (const z of set.zones) {
    if (z.hi < price) supports.push(z);
    else if (z.lo > price) resistances.push(z);
    else at.push(z);
  }
  supports.reverse();
  return { supports: supports.slice(0, p.maxServed), resistances: resistances.slice(0, p.maxServed), at };
}

/** The other frames (by key) holding a qualifying zone that overlaps `zone`. */
export function agreeing(zone: { lo: number; hi: number }, others: ReadonlyArray<{ key: string; set: ZoneSet }>): string[] {
  return others.filter((o) => o.set.zones.some((z) => overlaps(zone, z))).map((o) => o.key);
}

export const superStrongOf = (agree: readonly string[]): SuperStrong => (agree.length >= 2 ? 'TRIPLE' : agree.length === 1 ? 'PAIR' : 'NONE');

/** The level check on already-built zone sets: per frame, the served zones with labels, flags and distances. */
export function serveFrames(price: number, frames: ReadonlyArray<{ key: string; set: ZoneSet }>, p: BtParams = BT): ServedFrame[] {
  return frames.map((f) => {
    const others = frames.filter((o) => o.key !== f.key);
    const s = servedOf(f.set, price, p);
    const atr = f.set.atr;
    const dress = (z: Zone, side: Side | 'at', rank: number): ServedZone => {
      const gap = side === 'support' ? price - z.hi : side === 'resistance' ? z.lo - price : 0;
      const agree = agreeing(z, others);
      return {
        ...z, side, rank, distanceAtr: atr ? gap / atr : 0, distancePct: (gap / price) * 100, widthAtr: atr ? (z.hi - z.lo) / atr : 0,
        agree, superStrong: superStrongOf(agree),
      };
    };
    return {
      key: f.key, atr,
      supports: s.supports.map((z, i) => dress(z, 'support', i + 1)),
      resistances: s.resistances.map((z, i) => dress(z, 'resistance', i + 1)),
      at: s.at.map((z, i) => dress(z, 'at', i + 1)),
    };
  });
}

/** The level check from candles: one to three chosen timeframes, each with its own bars, at one instant and price. */
export function levelCheck(
  input: { price: number; instantMs: number; frames: ReadonlyArray<{ key: string; stepMs: number; bars: readonly Bar[] }> },
  p: BtParams = BT,
): ServedFrame[] {
  return serveFrames(input.price, input.frames.map((f) => ({ key: f.key, set: zoneSetAsOf(f.bars, f.stepMs, input.instantMs, p) })), p);
}
