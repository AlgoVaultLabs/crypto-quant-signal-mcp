// sr-backtest/spec.ts — EDGE-SR-LEVEL-BACKTEST-W1: every number the registration freezes, in one leaf.
//
// The harness, the parity fixture and the registration all read these values; none of them restates one. A change
// here after the registration has landed is a §8 deviation (audits/PREREGISTRATION-PROCEDURE.md).
import { V0, type V0Params } from '../sr-probe/level-v0.js';

export const WAVE = 'EDGE-SR-LEVEL-BACKTEST-W1';
export const M15 = 900_000;
export const DAY = 86_400_000;

export interface Timeframe {
  key: string;
  stepMs: number;
  /** 15-minute units per bar. */
  units: number;
  /** 15-minute units added to one entry window to make the grid stride (see `strideUnits`). */
  gridOffset: number;
}

/** The four timeframes of zone rule Z1. Each is a natively served BINANCE interval (src/lib/adapters/_interval.ts). */
export const TIMEFRAMES: readonly Timeframe[] = Object.freeze([
  Object.freeze({ key: '15m', stepMs: 900_000, units: 1, gridOffset: 1 }),
  Object.freeze({ key: '1h', stepMs: 3_600_000, units: 4, gridOffset: 1 }),
  Object.freeze({ key: '4h', stepMs: 14_400_000, units: 16, gridOffset: 29 }),
  Object.freeze({ key: '1d', stepMs: 86_400_000, units: 96, gridOffset: 29 }),
]);

export const tfOf = (key: string): Timeframe => {
  const tf = TIMEFRAMES.find((t) => t.key === key);
  if (!tf) throw new Error(`sr-backtest: unknown timeframe ${key}`);
  return tf;
};

export interface BtParams {
  /** Level v0, imported and never edited. `lookaheadBars` exists only so a test can break the as-of cut. */
  v0: V0Params;
  /** Zone width floor, in ATR14 of the zone's timeframe. */
  minWidthAtr: number;
  /** Served set: nearest zones per side. */
  maxServed: number;
  /** Label cut points on the cluster's touch count (as-of strength only). */
  mediumTouches: number;
  strongTouches: number;
  /** N: bars of the zone's timeframe in which the zone must first be entered. */
  entryBars: number;
  /** M: bars of the zone's timeframe, after the entry bar, in which the event must resolve. */
  resolveBars: number;
  /** k: a bounce leaves the zone back by k ATR. */
  bounceAtr: number;
  /** Closes beyond the zone that make a break (V1 uses 2; V5 compares 1). */
  breakCloses: number;
  /** V4: the take-profit sits this many ATR before the opposing zone; the stop this many ATR beyond the protecting one. */
  bufferAtr: number;
  /** V4: bars of the timeframe in which the take-profit / stop race is decided. */
  raceBars: number;
  /** The control's candidates are the served instant plus j bars of the zone's timeframe, j = controlLagBars + 1 …
   *  controlLagBars + controlWindow(tf): later than the served zone's own entry window, at the same position inside
   *  the timeframe's bar. They are tried in time order. */
  controlLagBars: number;
  /** The window's length in bars of the timeframe, at most `controlWindowDays` days. */
  controlWindowBars: number;
  controlWindowDays: number;
  /** Test-only switches. The registered values are true and 1. */
  controlDisjoint: boolean;
  controlWidthMult: number;
}

export const BT: Readonly<BtParams> = Object.freeze({
  v0: V0,
  minWidthAtr: 0.25,
  maxServed: 3,
  mediumTouches: 3,
  strongTouches: V0.strongMin,
  entryBars: 12,
  resolveBars: 12,
  bounceAtr: 1.0,
  breakCloses: 2,
  bufferAtr: 0.25,
  raceBars: 24,
  controlLagBars: 12,
  controlWindowBars: 96,
  controlWindowDays: 24,
  controlDisjoint: true,
  controlWidthMult: 1,
});

/** The control window of one timeframe, in its own bars. */
export const controlWindow = (tf: Timeframe, p: BtParams = BT): number =>
  Math.min(p.controlWindowBars, Math.floor((p.controlWindowDays * DAY) / tf.stepMs));

/** Grid stride in 15-minute units: one entry window plus the timeframe's offset, so entry windows never overlap.
 *  Every stride is coprime with 96 and with the timeframe's own units, so the instants rotate through the UTC day
 *  and through every position inside the timeframe's bar (the 29 spreads the few 4h and 1d instants across the day
 *  from the first lap on). */
export const strideUnits = (tf: Timeframe, p: BtParams = BT): number => p.entryBars * tf.units + tf.gridOffset;

/** The window, the panel and the estimator. */
export const STUDY = Object.freeze({
  windowDays: 365,
  holdoutDays: 92,
  warmupBars: 300,
  panelSize: 50,
  /** A cell-day (or a cell-coin) is present only when each arm holds at least this many scored events. */
  minArm: 30,
  minClusters: 20,
  bootstrapB: 2000,
  fdrQ: 0.10,
  floorV1: 3.0,
  floorV2: 2.0,
  floorV3: 1.0,
  floorV4: 3.0,
});

/** FNV-1a over a string, then mulberry32: one seeded stream per (seed, key). Integer-only, platform-independent. */
export function rngOf(seed: number, key: string): () => number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
