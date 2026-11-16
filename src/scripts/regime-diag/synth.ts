// regime-diag/synth.ts — EDGE-REGIME-DIAG-W1: a synthetic 1 m series. No real market data.
//
// A seeded log walk through named segments (drift and volatility per minute), written as venue-format kline rows.
// The core-parity fixture (parity.ts) replays this series before any outcome is computed; the harness tests
// build their studies from it.
import { emptyGrid, finishGrid, putCsv, type Grid } from './archive.js';
import { rngFor } from './rng.js';
import { MIN_MS, type Span } from './diag-spec.js';

/** Per-minute log drift and log volatility, held for `minutes`. */
export interface Segment { minutes: number; drift: number; vol: number }

/** Segments that visit every label at the 1h timeframe: a rise, a quiet range, a fall, a violent range. */
export const SEGMENTS: readonly Segment[] = Object.freeze([
  { minutes: 6 * 1440, drift: 0.00004, vol: 0.0006 },
  { minutes: 5 * 1440, drift: 0, vol: 0.0004 },
  { minutes: 6 * 1440, drift: -0.00004, vol: 0.0006 },
  { minutes: 4 * 1440, drift: 0, vol: 0.006 },
]);

/** Venue-format kline rows (open time in ms) for grid minutes [from, to); `holes` are minutes left out. */
export function synthCsv(span: Span, key: string, opts: { segments?: readonly Segment[]; from?: number; to?: number; holes?: ReadonlySet<number>; p0?: number } = {}): string {
  const segs = opts.segments ?? SEGMENTS;
  const from = opts.from ?? 0;
  const to = opts.to ?? span.n;
  const rnd = rngFor(`synth|${key}`);
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const lines: string[] = [];
  let lp = Math.log(opts.p0 ?? 100);
  let si = 0, left = segs[0].minutes;
  // The walk always starts at grid minute 0, so a slice [from, to) is the same series as the whole.
  for (let i = 0; i < to; i++) {
    if (left === 0) { si = (si + 1) % segs.length; left = segs[si].minutes; }
    left--;
    const s = segs[si];
    const o = Math.exp(lp);
    lp += s.drift + s.vol * gauss();
    const c = Math.exp(lp);
    const hi = Math.max(o, c) * (1 + Math.abs(gauss()) * s.vol * 0.4);
    const lo = Math.min(o, c) * (1 - Math.abs(gauss()) * s.vol * 0.4);
    const v = 1 + rnd() * 9;
    if (i < from || opts.holes?.has(i)) continue;
    const t = span.t0Ms + i * MIN_MS;
    lines.push(`${t},${o.toFixed(8)},${hi.toFixed(8)},${lo.toFixed(8)},${c.toFixed(8)},${v.toFixed(5)},${t + MIN_MS - 1},0,0,0,0,0`);
  }
  return `${lines.join('\n')}\n`;
}

export function synthGrid(span: Span, key: string, opts: Parameters<typeof synthCsv>[2] = {}): Grid {
  const g = emptyGrid(span);
  putCsv(g, synthCsv(span, key, opts));
  return finishGrid(g);
}
