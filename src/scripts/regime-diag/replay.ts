// regime-diag/replay.ts — EDGE-REGIME-DIAG-W1: the replay. The landed rule is CALLED, never re-implemented (§4.1).
//
// served(c, τ, t) = computeMarketRegimeCore({ coin, exchange: 'BINANCE', timeframe: τ, candles, intervalMs,
//                                            startTime: t − n_τ·I_τ, nowMs: t, candleBasis: 'closed' })
// on the candle window the serving path holds at t: the bars covering [t − n_τ·I_τ, t) plus the bar in progress,
// whose close is the 1 m open at t.
import { computeMarketRegimeCore, computeRegimeIndicators } from '../../lib/market-regime-core.js';
import type { Candle } from '../../types.js';
import { noGap, type Bars, type Grid } from './archive.js';
import { MUTATE } from './mutate.js';
import { LABELS, MIN_MS, VENUE, type Tf } from './diag-spec.js';

export const SLOPES = ['FALLING', 'FLAT', 'RISING'] as const;
export const STRUCTURES = ['MIXED', 'HIGHER_HIGHS', 'LOWER_LOWS'] as const;

/** What the study reads from one call: the label, and the indicators the label was decided from. */
export interface Served {
  /** Index into LABELS. */
  label: number;
  confidence: number;
  /** Index into SLOPES. */
  slope: number;
  /** Unrounded volatilityRatio (§4.3). */
  vol: number;
  adx: number; adxSlope: number; plusDI: number; minusDI: number;
  /** Index into STRUCTURES. */
  structure: number;
}

export interface CandleWindow { candles: Candle[]; intervalMs: number; startTime: number; nowMs: number }

/** The candle window at grid minute `m`: the closed bars of [m − n·I, m), then the bar in progress (close = the 1 m open at m). */
export function candlesAt(g: Grid, b: Bars, tf: Tf, m: number): CandleWindow {
  const { min, n } = tf;
  const k = Math.floor(m / min);
  const k0 = k - n + (m - k * min > 0 ? 1 : 0);
  const candles: Candle[] = [];
  for (let j = k0; j < k; j++) candles.push({ open: b.O[j], high: b.H[j], low: b.L[j], close: b.C[j], volume: b.V[j], time: g.span.t0Ms + j * min * MIN_MS });
  const px = g.O[m];
  let hi = px, lo = px, vol = 0, o = px;
  for (let i = k * min; i < m; i++) {
    if (i === k * min) o = g.O[i];
    if (g.H[i] > hi) hi = g.H[i];
    if (g.L[i] < lo) lo = g.L[i];
    vol += g.V[i];
  }
  candles.push({ open: o, high: hi, low: lo, close: px, volume: vol, time: g.span.t0Ms + k * min * MIN_MS });
  const nowMs = g.span.t0Ms + m * MIN_MS;
  const intervalMs = min * MIN_MS;
  return { candles, intervalMs, startTime: nowMs - n * intervalMs, nowMs };
}

/** A call needs every 1 m row of [m − n·I, m), and the 1 m open at m. */
export const servable = (g: Grid, tf: Tf, m: number): boolean => noGap(g, m - tf.n * tf.min, m + 1);

const nz = (x: number | null): number => (x === null ? NaN : x);

/** One call of the pinned core at grid minute `m`. Throws what the core throws (its one refusal). */
export function served(g: Grid, b: Bars, tf: Tf, m: number, coin: string): Served {
  const w = candlesAt(g, b, tf, m);
  const closed = w.candles.slice(0, -1);
  const r = MUTATE === 'replay'
    ? computeMarketRegimeCore({ coin, exchange: VENUE, timeframe: tf.key, candles: w.candles, intervalMs: w.intervalMs, startTime: w.startTime, nowMs: w.nowMs, candleBasis: 'live' })
    : computeMarketRegimeCore({ coin, exchange: VENUE, timeframe: tf.key, candles: w.candles, intervalMs: w.intervalMs, startTime: w.startTime, nowMs: w.nowMs, candleBasis: 'closed' });
  const ind = computeRegimeIndicators(closed);
  return {
    label: LABELS.indexOf(r.regime),
    confidence: r.confidence,
    slope: SLOPES.indexOf(r.slopeCategory),
    vol: r.volatilityRatio,
    adx: nz(ind.adxVal), adxSlope: nz(ind.adxSlope), plusDI: nz(ind.plusDI), minusDI: nz(ind.minusDI),
    structure: STRUCTURES.indexOf(ind.structure.structure),
  };
}

/**
 * The per-closed-bar series of one coin × timeframe (§4.1): the same call at every bar close of the grid that has
 * an unbroken window. Index `j` is the close at grid minute `j·min` (the close of bar `j − 1`).
 * `ok[j] = 0` marks a close with no call (a broken window, or the core's refusal).
 */
export interface Series {
  tf: Tf; nb: number;
  ok: Uint8Array; label: Uint8Array; conf: Uint8Array;
  vol: Float64Array;
  /** Close of the bar that closes at `j` (NaN where that bar is not full). */
  close: Float64Array;
  /** Consecutive closes ending at `j` that carry label[j] (1 when the label first appears at `j`). */
  age: Int32Array;
  calls: number; refusals: number;
}

export function buildSeries(g: Grid, b: Bars, tf: Tf, coin: string): Series {
  const nb = b.nb;
  const s: Series = { tf, nb, ok: new Uint8Array(nb + 1), label: new Uint8Array(nb + 1), conf: new Uint8Array(nb + 1), vol: new Float64Array(nb + 1).fill(NaN),
    close: new Float64Array(nb + 1).fill(NaN), age: new Int32Array(nb + 1), calls: 0, refusals: 0 };
  for (let j = 1; j <= nb; j++) {
    if (b.cnt[j - 1] === tf.min) s.close[j] = b.C[j - 1];
    const m = j * tf.min;
    if (m >= g.span.n || !servable(g, tf, m)) continue;
    try {
      const r = served(g, b, tf, m, coin);
      s.calls++;
      s.ok[j] = 1; s.label[j] = r.label; s.conf[j] = r.confidence; s.vol[j] = r.vol;
      s.age[j] = s.ok[j - 1] && s.label[j - 1] === r.label ? s.age[j - 1] + 1 : 1;
    } catch {
      s.refusals++;
    }
  }
  return s;
}

/** The core logs to stderr on an underfed window; a replay makes a million calls, so the log is muted around it. */
export function quietly<T>(fn: () => T): T {
  const keep = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = keep; }
}
