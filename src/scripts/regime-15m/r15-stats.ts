// regime-15m/r15-stats.ts — EDGE-REGIME-15M-BACKTEST-W1: the measures (item 3) and the paired comparisons (item 4).
//
// Every statistic is T3's, read through T3's engine on a view (r15-frame.ts): A4 is `a4`, Δ1 is `delta1`, the key
// readings are T3's A1.A and A1.B constructions, lag is `lagOf`, flip-flops `flipFlops`, the runs `runsOf` over
// `barSeq`. Clusters are T3's (coin × UTC day, resampled inside each coin); the bootstrap is T3's, `B_BOOT` resamples
// seeded by `arm_seed(SEED, …)`, bounds at one-sided `ALPHA`. Item 4's comparisons are paired: both arms are read
// from ONE resample of the same clusters, so their difference is a paired quantity.
//
// Naive baselines on the same rows (item 3): always-up, always-down and a coin flip.
//   A4: their agreement rates are p_K (the up-phase share), 1 − p_K and 50 %; a4's outputs are A minus each.
//   Δ1: their Δ1 is U − D, D − U and 0; the measure's excess over them is 2D, 2U and Δ1 (T3 §4.7).
//   flip-flops: a constant label never changes (0); a fair coin at every labelled close has the expectation
//   ½·(1 − ½^k) per change-eligible close, k the consecutive labelled closes after it up to N_FF (exact, no draw).
import { barSeq, flipFlops, lagOf, runsOf } from '../regime-diag/bars.js';
import { N_FF, type Win } from '../regime-diag/diag-spec.js';
import { accumulate, compute, context, cwOfRows, effOfCw, joint, type Ctx, type Reading, type Stat } from '../regime-diag/engine.js';
import { N_TF, dayOf, phaseLab, type Frame } from '../regime-diag/frame.js';
import type { KeyA } from '../regime-diag/keys.js';
import { seedsFor } from '../regime-diag/prims.js';
import type { Series } from '../regime-diag/replay.js';
import { a4, delta1, delta1ByHold, trendDir } from '../regime-diag/stats.js';
import { barsAt, t3Slot, viewOf, type Rows15 } from './r15-frame.js';
import { D1_MIN_CONFIDENCE, KEY_FLOOR_PP, MUTATE, STUDY_ALPHA, STUDY_SEED, TIMEFRAMES, TF15, armOf, type Tf4 } from './r15-spec.js';

/** The clusters of a reading: T3's context. The mutation `pooled` makes every entry its own cluster (rows, not days). */
export function ctxOf(f: Frame): Ctx {
  const c = context(f);
  if (MUTATE !== 'pooled') return c;
  const clOf = new Int32Array(f.nE), strata = new Int32Array(f.nE);
  for (let e = 0; e < f.nE; e++) { clOf[e] = e; strata[e] = f.ePos[e]; }
  return { ...c, nCl: f.nE, clOf, strata };
}

/** θ = output `ka` of `a` minus output `kb` of `b`, both read from one resample. Outputs: θ, then every output of a and of b. */
export function paired(id: string, a: Stat, ka: number, b: Stat, kb: number): Stat {
  const j = joint(id, [a, b]), na = a.names.length, tmp = new Float64Array(na + b.names.length);
  return {
    id, m: j.m, names: ['theta', ...a.names.map((x) => `a:${x}`), ...b.names.map((x) => `b:${x}`)], seq: a.seq, add: j.add,
    evaluate(tot, off, out, o) { j.evaluate(tot, off, tmp, 0); out[o] = tmp[ka] - tmp[na + kb]; for (let i = 0; i < tmp.length; i++) out[o + 1 + i] = tmp[i]; },
  };
}

const inSlot = (s: number) => (r: number): boolean => r % N_TF === s;
/** A4's rows in slot `s`: TRENDING at any confidence with a dated key-A phase (T3's A4.S rows). */
export const a4Rows = (v: Frame, s: number): Uint8Array => trendDir(v, v.S, 0, 101, (r) => r % N_TF === s && v.phase[r] !== 0);
/** Δ1's rows in slot `s`: TRENDING at confidence ≥ 60 (T3's A1.S and map-row-12 rows). */
export const d1Rows = (v: Frame, s: number): Uint8Array => trendDir(v, v.S, D1_MIN_CONFIDENCE, 101, inSlot(s));
export const a4Stat = (v: Frame, id: string, s: number): Stat => a4(v, id, trendDir(v, v.S, 0, 101, inSlot(s)), v.S.lab);
export const d1Stat = (v: Frame, id: string, s: number): Stat => delta1(v, id, d1Rows(v, s), v.S.lab);
/** Key A (CEILING): Δ1 with key A's phase as the direction, every dated row (T3's A1.A). */
export const ceilingStat = (v: Frame, id: string, s: number): Stat => { const l = phaseLab(v); return delta1(v, id, trendDir(v, l, 0, 101, inSlot(s)), l.lab); };
/** Key B (NO_LAG): Δ1 under key B's label at confidence ≥ 60 (T3's A1.B). */
export const noLagStat = (v: Frame, id: string, s: number): Stat => delta1(v, id, trendDir(v, v.B, D1_MIN_CONFIDENCE, 101, inSlot(s)), v.B.lab);

// ── before any outcome: the floors and the side mix ──────────────────────────────────────────────────────────

export interface PreTf { tf: string; a4_rows: number; a4_eff: number; d1_rows: number; d1_eff: number; ff_coin_days: number; served_minority: number | null; phase_minority: number | null }
export interface Pre { entries: number; comparison_entries: number; coins: number; F: number; tfs: PreTf[]; floor_ok: boolean; floor_failures: string[] }

const count = (sel: Uint8Array): number => { let n = 0; for (let i = 0; i < sel.length; i++) if (sel[i]) n++; return n; };
/** The minority share (design weights) of a direction among selected rows; null when no row is selected. */
function minority(sel: Uint8Array, dirOf: (r: number) => number, w: Float64Array): number | null {
  let up = 0, all = 0;
  for (let r = 0; r < sel.length; r++) { if (!sel[r]) continue; all += w[r]; if (dirOf(r) === 1) up += w[r]; }
  return all > 0 ? Math.min(up, all - up) / all : null;
}
/** Coin-days that carry at least one labelled close inside the window, at one timeframe. */
export function labelledCoinDays(items: ReadonlyArray<{ pos: number; series: Series }>, win: Win): number {
  const days = new Set<number>();
  for (const { pos, series: s } of items) {
    const min = s.tf.min;
    for (let j = Math.max(1, Math.ceil(win.lo / min)); j * min < win.hi && j <= s.nb; j++) if (s.ok[j]) days.add(pos * 100_000 + dayOf(j * min));
  }
  return days.size;
}

/** Label-only: no outcome is read. The effective clusters of every row set a criterion reads, at every timeframe. */
export function preOf(f: Frame, r: Rows15, keep: Uint8Array, F: number): Pre {
  const tfs: PreTf[] = [], failures: string[] = [];
  const cws: Float64Array[] = [], rowsets: Array<{ a4: Uint8Array; d1: Uint8Array; v: Frame; ctx: Ctx }> = [];
  for (const t of TIMEFRAMES) {
    const v = viewOf(f, r, t.key, null, keep), ctx = ctxOf(v), a4s = a4Rows(v, 0), d1s = d1Rows(v, 0);
    cws.push(cwOfRows(v, ctx, a4s), cwOfRows(v, ctx, d1s));
    rowsets.push({ a4: a4s, d1: d1s, v, ctx });
  }
  const eff = effOfCw(cws);
  TIMEFRAMES.forEach((t, i) => {
    const { a4: a4s, d1: d1s, v, ctx } = rowsets[i];
    const trend = trendDir(v, v.S, 0, 101, inSlot(0));
    const row: PreTf = {
      tf: t.key, a4_rows: count(a4s), a4_eff: eff[2 * i], d1_rows: count(d1s), d1_eff: eff[2 * i + 1], ff_coin_days: labelledCoinDays(barsAt(f, r, t.key), f.win),
      served_minority: minority(trend, (x) => trend[x], ctx.w), phase_minority: minority(a4s, (x) => v.phase[x], ctx.w),
    };
    for (const [k, n] of [['A4', row.a4_eff], ['Δ1', row.d1_eff], ['flip-flops', row.ff_coin_days]] as Array<[string, number]>) {
      if (!(Number.isFinite(n) && n >= F)) failures.push(`${t.key} ${k}: ${n} below the floor of ${F}`);
    }
    tfs.push(row);
  });
  return { entries: f.nE, comparison_entries: count(keep), coins: f.coins.length, F, tfs, floor_ok: failures.length === 0, floor_failures: failures };
}

// ── the measures ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Interval { point: number; lb: number; ub: number }
const iv = (r: Reading, k: number, shift = 0, scale = 1): Interval => ({ point: scale * r.point[k] + shift, lb: scale * r.lb[k] + shift, ub: scale * r.ub[k] + shift });
export interface A4Measure { rows: number; clusters: number; eff: number; agreement: Interval; baselines: { always_up: number; always_down: number; coin: number }; excess: { always_up: Interval; always_down: Interval; coin: Interval } }
export interface D1Measure { rows: number; clusters: number; eff: number; delta1: Interval; U: Interval; D: Interval; baselines: { always_up: number; always_down: number; coin: number }; excess: { always_up: Interval; always_down: Interval; coin: Interval }; by_hold: number[] }
export interface FFMeasure { bars: number; changes: number; flipflops: number; per_1000: number; baselines: { always_up: number; always_down: number; coin: number } }
export interface LagMeasure { turns: number; censored: number; median_bars: number | null; median_hours: number | null }
export interface RunMeasure { runs: number; meanLen: number; medianLen: number; signed: number }
export interface TfMeasures { tf: string; a4: A4Measure; d1: D1Measure; flip_flops: FFMeasure; lag: LagMeasure; runs: RunMeasure }

/** A4 from a4's outputs (pp): A = e_coin + 50; p_K = A − e_always_up. */
export function a4Measure(r: Reading): A4Measure {
  const A = r.point[3] + 50, pK = A - r.point[1];
  const baselines = { always_up: pK, always_down: 100 - pK, coin: 50 };
  if (MUTATE === 'baseline') delete (baselines as Partial<typeof baselines>).always_down;
  return { rows: r.rows, clusters: r.clusters, eff: r.eff, agreement: iv(r, 3, 50), baselines, excess: { always_up: iv(r, 1), always_down: iv(r, 2), coin: iv(r, 3) } };
}
/** Δ1 from delta1's outputs (pp), and its by-hold points from the reading's sums. */
export function d1Measure(r: Reading, byHold: number[]): D1Measure {
  const U = r.point[1], D = r.point[2];
  const baselines = { always_up: U - D, always_down: D - U, coin: 0 };
  if (MUTATE === 'baseline') delete (baselines as Partial<typeof baselines>).always_down;
  return { rows: r.rows, clusters: r.clusters, eff: r.eff, delta1: iv(r, 0), U: iv(r, 1), D: iv(r, 2), baselines, excess: { always_up: iv(r, 2, 0, 2), always_down: iv(r, 1, 0, 2), coin: iv(r, 0) }, by_hold: byHold };
}

/** The expected flip-flops of a fair two-sided coin drawn at every labelled close of a window (T3's flip-flop rule). */
export function coinFlipFlops(s: Series, win: Win): number {
  const min = s.tf.min, inside = (j: number): boolean => j >= 1 && j <= s.nb && j * min >= win.lo && j * min < win.hi && s.ok[j] === 1;
  let e = 0;
  for (let j = Math.max(1, Math.ceil(win.lo / min)); j * min < win.hi && j <= s.nb; j++) {
    if (!s.ok[j] || !inside(j - 1)) continue;
    let k = 0;
    while (k < N_FF && inside(j + k + 1)) k++;
    e += 0.5 * (1 - 0.5 ** k);
  }
  return e;
}
export function ffMeasure(items: ReadonlyArray<{ series: Series }>, win: Win): FFMeasure {
  let bars = 0, changes = 0, flipflops = 0, coin = 0;
  for (const { series } of items) { const x = flipFlops(series, win); bars += x.bars; changes += x.changes; flipflops += x.flipflops; coin += coinFlipFlops(series, win); }
  const baselines = { always_up: 0, always_down: 0, coin: bars ? (1000 * coin) / bars : NaN };
  if (MUTATE === 'baseline') delete (baselines as Partial<typeof baselines>).always_down;
  return { bars, changes, flipflops, per_1000: bars ? (1000 * flipflops) / bars : NaN, baselines };
}
/** T3's lag table at one timeframe, the median also in hours. */
export function lagMeasure(items: ReadonlyArray<{ series: Series; keyA: KeyA }>, tfMin: number): LagMeasure {
  let turns = 0, censored = 0;
  const lags: number[] = [];
  for (const c of items) { const l = lagOf(c.keyA, c.series); turns += l.turns; censored += l.censored; for (const x of l.lags) lags.push(x); }
  lags.sort((a, b) => a - b);
  const n = lags.length, median = n ? (n % 2 ? lags[(n - 1) / 2] : (lags[n / 2 - 1] + lags[n / 2]) / 2) : null;
  return { turns, censored, median_bars: median, median_hours: median === null ? null : (median * tfMin) / 60 };
}
/**
 * The TRENDING runs of one timeframe's served series, as T3's A5 `perTf` reads them: run length in bars (ω-weighted
 * mean, and the median at half the weight), and the signed move ÷ σ. ω = coin weight × `wTf` (T3's timeframe weight; 1 at 15m).
 */
export function runMeasure(f: Frame, items: ReadonlyArray<{ pos: number; series: Series }>, wTf: number): RunMeasure {
  const mine = runsOf(items.map((c) => barSeq(c.series, f.win, c.pos, 0, 0))).runs;
  const ws = mine.map((r) => f.census.wCoin[r.pos] * wTf), W = ws.reduce((a, b) => a + b, 0);
  const by = mine.map((r, i) => ({ len: r.len, w: ws[i] })).sort((a, b) => a.len - b.len);
  let cum = 0, medianLen = NaN;
  for (const x of by) { cum += x.w; if (cum >= W / 2) { medianLen = x.len; break; } }
  return { runs: mine.length, meanLen: W > 0 ? mine.reduce((s, r, i) => s + ws[i] * r.len, 0) / W : NaN, medianLen, signed: W > 0 ? mine.reduce((s, r, i) => s + ws[i] * r.signed, 0) / W : NaN };
}

export interface MeasureOpts { B: number; alpha: number; seeds: ReadonlyMap<string, number>; run: string }
export const RUN_STATS: readonly string[] = Object.freeze([
  ...TIMEFRAMES.flatMap((t) => [`A4.${t.key}`, `D1.${t.key}`]), 'A4.15m-1h', 'D1.15m-1h', 'key.CEILING.15m', 'key.NO_LAG.15m',
]);
/** Every seed one run's statistics need, in one bridge call. */
export function seedsOf(run: string): Map<string, number> {
  const arms = RUN_STATS.map((s) => armOf(run, s)), got = seedsFor(STUDY_SEED, arms);
  return new Map(RUN_STATS.map((s, i) => [s, got[i]]));
}
const readOf = (v: Frame, ctx: Ctx, stat: Stat, o: MeasureOpts, id: string): Reading => {
  const seed = o.seeds.get(id);
  if (seed === undefined) throw new Error(`regime-15m: no seed for ${id}`);
  const r = compute(v, ctx, stat, { B: o.B, alpha: o.alpha, bootSeed: seed });
  return { ...r, reps: new Float64Array(0) };
};

/** One timeframe's five measures on the comparison rows. */
export function tfMeasures(f: Frame, r: Rows15, keep: Uint8Array, t: Tf4, o: MeasureOpts): TfMeasures {
  const v = viewOf(f, r, t.key, null, keep), ctx = ctxOf(v), ts = t3Slot(t.key);
  const ra = readOf(v, ctx, a4Stat(v, `A4.${t.key}`, 0), o, `A4.${t.key}`);
  const d1 = d1Stat(v, `D1.${t.key}`, 0), rd = readOf(v, ctx, d1, o, `D1.${t.key}`);
  const items = barsAt(f, r, t.key);
  return {
    tf: t.key, a4: a4Measure(ra), d1: d1Measure(rd, delta1ByHold(accumulate(v, ctx, d1).tot)), flip_flops: ffMeasure(items, f.win),
    lag: lagMeasure(items, t.min), runs: runMeasure(f, items, ts < 0 ? 1 : f.census.wTf[ts]),
  };
}

export interface PairReading { theta: Interval; arm15: Interval; arm1h: Interval; rows: number; clusters: number; eff: number }
export interface KeyReading { key: 'CEILING' | 'NO_LAG' | 'SERVED'; rows: number; eff: number; delta1: Interval; state: 'works' | 'broken' | 'too little data' }
export interface Measures { tfs: TfMeasures[]; a4_pair: PairReading; d1_pair: PairReading; keys: KeyReading[]; diagnosis: 'NO_ROOM' | 'INPUTS' | 'LAG' | 'none' }

/** A key reading's state (descriptive; T3 §6's floor): works at ≥ 3.0 pp with LB > 0, broken when UB < 3.0 pp. */
export function keyState(x: Interval, eff: number, F: number): KeyReading['state'] {
  if (![x.point, x.lb, x.ub, eff].every(Number.isFinite) || eff < F) return 'too little data';
  if (x.point >= KEY_FLOOR_PP && x.lb > 0) return 'works';
  if (x.ub < KEY_FLOOR_PP) return 'broken';
  return 'too little data';
}
/** PROCEDURE §4d's ladder, read top down: nothing to find, then the inputs, then the lag. */
export function diagnosis(keys: readonly KeyReading[]): Measures['diagnosis'] {
  const s = (k: KeyReading['key']): string | undefined => keys.find((x) => x.key === k)?.state;
  if (s('CEILING') === 'broken') return 'NO_ROOM';
  if (s('CEILING') === 'works' && s('NO_LAG') === 'broken') return 'INPUTS';
  if (s('NO_LAG') === 'works' && s('SERVED') === 'broken') return 'LAG';
  return 'none';
}

/** Every measure of one run: the four timeframes, the two paired comparisons, the 15m key readings. Needs outcomes. */
export function measures(f: Frame, r: Rows15, keep: Uint8Array, F: number, o: MeasureOpts): Measures {
  if (!f.cells) throw new Error('regime-15m: the measures read outcomes; this frame has none');
  const byKey = new Map(TIMEFRAMES.map((t) => [t.key, tfMeasures(f, r, keep, t, o)]));
  // the mutation `swap` files the 15m measures under 1h and the 1h measures under 15m
  const order = TIMEFRAMES.map((t) => (MUTATE === 'swap' && t.key === '15m' ? '1h' : MUTATE === 'swap' && t.key === '1h' ? '15m' : t.key));
  const tfs = TIMEFRAMES.map((t, i) => ({ ...(byKey.get(order[i]) as TfMeasures), tf: t.key }));
  // the paired view: 15m in slot 0, 1h in slot 1, on the same entries, read from one resample
  const v = viewOf(f, r, TF15.key, '1h', keep), ctx = ctxOf(v);
  const pairOf = (id: string, a: Stat, b: Stat, k: number, shift: number): PairReading => {
    const x = readOf(v, ctx, paired(id, a, k, b, k), o, id), na = a.names.length;
    return { theta: iv(x, 0), arm15: iv(x, 1 + k, shift), arm1h: iv(x, 1 + na + k, shift), rows: x.rows, clusters: x.clusters, eff: x.eff };
  };
  const a4_pair = pairOf('A4.15m-1h', a4Stat(v, 'A4.15m', 0), a4Stat(v, 'A4.1h', 1), 3, 50);
  const d1_pair = pairOf('D1.15m-1h', d1Stat(v, 'D1.15m', 0), d1Stat(v, 'D1.1h', 1), 0, 0);
  const key = (k: KeyReading['key'], id: string, stat: Stat): KeyReading => {
    const x = readOf(v, ctx, stat, o, id), d = iv(x, 0);
    return { key: k, rows: x.rows, eff: x.eff, delta1: d, state: keyState(d, x.eff, F) };
  };
  const served15 = tfs.find((t) => t.tf === '15m') as TfMeasures;
  const keys: KeyReading[] = [
    key('CEILING', 'key.CEILING.15m', ceilingStat(v, 'key.CEILING.15m', 0)),
    key('NO_LAG', 'key.NO_LAG.15m', noLagStat(v, 'key.NO_LAG.15m', 0)),
    { key: 'SERVED', rows: served15.d1.rows, eff: served15.d1.eff, delta1: served15.d1.delta1, state: keyState(served15.d1.delta1, served15.d1.eff, F) },
  ];
  return { tfs, a4_pair, d1_pair, keys, diagnosis: diagnosis(keys) };
}
