// sr-backtest/synth.ts — EDGE-SR-LEVEL-BACKTEST-W1: seeded, driftless, integer-lattice random walks.
//
// The harness runs on these before it ever reads a real outcome: the known answers, the mirror property, the
// null calibration and the parity fixture. Integer prices keep p -> K - p exact, and the generator uses integer
// arithmetic only, so the same seed gives the same bars on every platform.
import type { Bar } from '../sr-probe/level-v0.js';
import type { CoinData } from './engine.js';
import { DAY, M15, TIMEFRAMES, rngOf } from './spec.js';

export interface WalkOpts {
  seed: number;
  key: string;
  /** Open time of the first bar; a 15-minute boundary. */
  firstMs: number;
  bars: number;
  startPrice?: number;
  /** A bar's close - open is uniform on [-body, body]; each wick uniform on [0, wick]. */
  body?: number;
  wick?: number;
}

/** A driftless 15-minute walk: symmetric integer bodies, independent integer wicks. */
export function walk15(o: WalkOpts): Bar[] {
  const rnd = rngOf(o.seed, o.key);
  const body = o.body ?? 500;
  const wick = o.wick ?? 300;
  const out: Bar[] = new Array(o.bars);
  let px = o.startPrice ?? 5_000_000;
  for (let i = 0; i < o.bars; i++) {
    const open = px;
    const close = open + Math.floor(rnd() * (2 * body + 1)) - body;
    const high = Math.max(open, close) + Math.floor(rnd() * (wick + 1));
    const low = Math.min(open, close) - Math.floor(rnd() * (wick + 1));
    out[i] = { time: o.firstMs + i * M15, open, high, low, close };
    px = close;
  }
  return out;
}

/** UTC-aligned bars of `stepMs` built from a contiguous 15-minute series; only complete bars. */
export function aggregate(base: readonly Bar[], stepMs: number): Bar[] {
  const units = stepMs / M15;
  const out: Bar[] = [];
  let i = 0;
  while (i < base.length && base[i].time % stepMs !== 0) i++;
  for (; i + units <= base.length; i += units) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i; j < i + units; j++) {
      if (base[j].high > high) high = base[j].high;
      if (base[j].low < low) low = base[j].low;
    }
    out.push({ time: base[i].time, open: base[i].open, high, low, close: base[i + units - 1].close });
  }
  return out;
}

/** One synthetic coin: a 15-minute walk and its 1h / 4h / 1d aggregates. */
export function synthCoin(coin: string, o: WalkOpts): CoinData {
  const base = walk15(o);
  const frames: Record<string, readonly Bar[]> = { '15m': base };
  for (const tf of TIMEFRAMES) if (tf.key !== '15m') frames[tf.key] = aggregate(base, tf.stepMs);
  return { coin, frames };
}

/** The null calibration's registered lengths: evaluation days per timeframe, after a 300-daily-bar warm-up. */
export const CALIBRATION = Object.freeze({
  replications: 100,
  walks: 50,
  warmupDays: 300,
  evalDays: Object.freeze({ '15m': 25, '1h': 25, '4h': 40, '1d': 240 }) as Readonly<Record<string, number>>,
  /** A fixed synthetic epoch (a UTC midnight); the calendar carries no meaning. */
  startMs: Date.UTC(2021, 0, 1),
  seed: 20261112,
});

export const calibrationBars = (horizonDays: number): number => (CALIBRATION.warmupDays + CALIBRATION.evalDays['1d'] + 1 + horizonDays) * (DAY / M15);
