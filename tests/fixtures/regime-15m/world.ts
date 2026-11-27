// tests/fixtures/regime-15m/world.ts — EDGE-REGIME-15M-BACKTEST-W1: a small synthetic world for the 15m suites.
// No real market data: T3's seeded synthetic walk (synth.ts), two positions with grids and one without, on a grid
// long enough for a 1d window (100 days of history before an entry) so the four timeframes share rows.
import { aggregate, type Grid } from '../../../src/scripts/regime-diag/archive.js';
import { MIN_MS, type Span, type Win } from '../../../src/scripts/regime-diag/diag-spec.js';
import { parseCensus, withOutcomes, type Census, type Frame, type Loaded } from '../../../src/scripts/regime-diag/frame.js';
import { SEGMENTS, synthCsv, synthGrid, type Segment } from '../../../src/scripts/regime-diag/synth.js';
import { build15, comparisonRows, frameOf, type Rows15 } from '../../../src/scripts/regime-15m/r15-frame.js';

export const D = 1440;
/** 120 days from 2021-01-01: January to April, whole months. */
export const W_SPAN: Span = Object.freeze({ t0Ms: Date.UTC(2021, 0, 1), n: 120 * D });
export const W_WIN: Win = Object.freeze({ name: 'fit', lo: 0, hi: 120 * D });
export const W_MONTHS = Object.freeze({ first: '2021-01', last: '2021-04' });
/** T3's synthetic census: three positions, census weights for the three T3 timeframes. */
export const W_CENSUS_TEXT = JSON.stringify({ t3_weights: { panel: ['SYNA', 'SYNB', 'SYNC'], coins: { SYNA: 0.5, SYNB: 0.3, SYNC: 0.2 }, timeframes: { '1h': 0.2, '4h': 0.5, '1d': 0.3 } } });
export const W_CENSUS: Census = parseCensus(W_CENSUS_TEXT);
/**
 * T3's segments three times over (every label at 1h), then a long trend, up for the first position and down for the
 * second, so the 1d window (100 daily bars) also reads TRENDING on the days it exists.
 */
export const W_SEGMENTS_UP: readonly Segment[] = Object.freeze([...SEGMENTS, ...SEGMENTS, ...SEGMENTS, { minutes: 80 * D, drift: 0.00002, vol: 0.0006 }]);
export const W_SEGMENTS_DOWN: readonly Segment[] = Object.freeze([...SEGMENTS, ...SEGMENTS, ...SEGMENTS, { minutes: 80 * D, drift: -0.00002, vol: 0.0006 }]);
/** The second position starts on day 3 and lacks one minute; the third has no grid. */
export const W_HOLE = 150_000;
export const W_OPTS: ReadonlyArray<Parameters<typeof synthCsv>[2] | null> = Object.freeze([
  { segments: W_SEGMENTS_UP }, { segments: W_SEGMENTS_DOWN, from: 3 * D, holes: new Set([W_HOLE]), p0: 40 }, null,
]);
export const W_KEYS = Object.freeze(['study|A', 'study|B', 'study|C']);

const grids = new Map<number, Grid | null>();
/** The world's 1 m grid of a position (built once per process). */
export function wLoad(pos: number): Loaded {
  if (!grids.has(pos)) { const o = W_OPTS[pos]; grids.set(pos, o ? synthGrid(W_SPAN, W_KEYS[pos], o) : null); }
  return { g: grids.get(pos) as Grid | null, noArchive: grids.get(pos) ? 0 : 4 };
}
/** The world's rows of one month of one position as venue-format kline text (open time in ms), for archives. */
export function wMonthCsv(pos: number, ym: string): string | null {
  const o = W_OPTS[pos];
  if (!o) return null;
  const [y, m] = ym.split('-').map(Number), a = (Date.UTC(y, m - 1, 1) - W_SPAN.t0Ms) / MIN_MS, b = (Date.UTC(y, m, 1) - W_SPAN.t0Ms) / MIN_MS;
  return synthCsv(W_SPAN, W_KEYS[pos], { ...o, from: Math.max(a, o.from ?? 0), to: Math.min(b, W_SPAN.n) });
}
/** Bars of `minutes` from a synthetic walk of its own (a check venue's): CSV as the fetcher stores it. */
export function venueCsv(key: string, minutes: number, from = 0, p0 = 100): string {
  const g = synthGrid(W_SPAN, key, { from, p0 }), b = aggregate(g, minutes), lines = ['open_time,open,high,low,close,volume'];
  for (let k = 0; k < b.nb; k++) if (b.cnt[k] === minutes) lines.push([W_SPAN.t0Ms + k * minutes * MIN_MS, b.O[k].toFixed(8), b.H[k].toFixed(8), b.L[k].toFixed(8), b.C[k].toFixed(8), b.V[k].toFixed(5)].join(','));
  return `${lines.join('\n')}\n`;
}

export interface Built { f0: Frame; f: Frame; r15: Rows15; keep: Uint8Array }
let built: Built | null = null;
/** The world's bare frame, its outcomes, its 15m rows and comparison rows (built once per process). */
export function world(): Built {
  if (!built) {
    const f0 = frameOf(W_SPAN, W_WIN, W_CENSUS, wLoad);
    const r15 = build15(f0, wLoad);
    built = { f0, f: withOutcomes(f0, wLoad), r15, keep: comparisonRows(f0, r15) };
  }
  return built;
}
