// regime-15m/r15-parity.ts — EDGE-REGIME-15M-BACKTEST-W1, item 5: the parity leg.
//
// The 1h, 4h and 1d figures T3's fit result printed, recomputed from THIS run's frame with T3's own definitions,
// seeds and counts, and compared at the result's printed precision: each value as the JSON prints it.
//   entries                 the fit frame's entry count
//   primaries.A4.reading    A4.S (T3's pooled A4): point, bounds, rows, clusters, effective clusters — seed arm fit|A4.S|bootstrap
//   descriptives.lag, .flip_flops, .runs                                     T3's describe() tables
//   secondary M12           map row 12 (Δ1 by timeframe on entries with all three labels): point, bounds, rows, effective clusters — fit|M12|bootstrap
//   descriptives.delta1_by_tf_hold                                          T3's describe() table of map row 12's arms
// The first five read no path label: they are recomputed from the label-only frame, before the seal, and a miss
// refuses the read before any outcome exists. The last two read the path labels: they are compared after the
// seal, and a miss fixes the verdict at INDETERMINATE (parity) without stopping the read.
import { ALPHA, B_BOOT, TFS, seedArm } from '../regime-diag/diag-spec.js';
import { a5, flipFlops, lagOf } from '../regime-diag/bars.js';
import { accumulate, compute, context, effOfCw } from '../regime-diag/engine.js';
import type { Frame } from '../regime-diag/frame.js';
import { seedsFor } from '../regime-diag/prims.js';
import { delta1ByHold, registered, type Built } from '../regime-diag/stats.js';
import { STUDY_SEED } from './r15-spec.js';

/** The figures that read no path label, shaped as T3's fit result prints them. */
export interface T3LabelFigures {
  entries: number;
  a4: { point: number[]; lb: number[]; ub: number[]; rows: number; clusters: number; eff: number };
  lag: Array<{ tf: string; turns: number; censored: number; median: number | null }>;
  flip_flops: Array<{ tf: string; bars: number; changes: number; flipflops: number; per_1000: number | null }>;
  runs: Array<{ tf: string; runs: number; meanLen: number; medianLen: number; signed: number }>;
}
/** The figures that read the path labels. */
export interface T3OutcomeFigures {
  m12: { point: number[]; lb: number[]; ub: number[]; rows: number; eff: number };
  delta1_by_tf_hold: Array<{ tf: string; eff: number; state: string; by_hold: number[] | null }>;
}
export type T3Figures = T3LabelFigures & T3OutcomeFigures;
export const labelPart = (t: T3Figures): T3LabelFigures => ({ entries: t.entries, a4: t.a4, lag: t.lag, flip_flops: t.flip_flops, runs: t.runs });
export const outcomePart = (t: T3Figures): T3OutcomeFigures => ({ m12: t.m12, delta1_by_tf_hold: t.delta1_by_tf_hold });

/** T3's label-only figures from a fit frame, with or without outcomes. `B` is T3's B_BOOT in a real read. */
export function recomputeT3Labels(f: Frame, B: number = B_BOOT): T3LabelFigures {
  const ctx = context(f);
  const [a4Seed] = seedsFor(STUDY_SEED, [seedArm('fit', 'A4.S', 'bootstrap')]);
  const a4 = registered(f, 'A4.S') as Built;
  const ra = compute(f, ctx, a4.stat, { B, alpha: ALPHA, bootSeed: a4Seed });
  const lag = TFS.map((tf, t) => {
    let turns = 0, censored = 0;
    const lags: number[] = [];
    for (const c of f.coins) { const l = lagOf(c.keyA[t], c.series[t]); turns += l.turns; censored += l.censored; for (const x of l.lags) lags.push(x); }
    lags.sort((x, y) => x - y);
    const n = lags.length;
    return { tf: tf.key, turns, censored, median: n ? (n % 2 ? lags[(n - 1) / 2] : (lags[n / 2 - 1] + lags[n / 2]) / 2) : null };
  });
  const flip_flops = TFS.map((tf, t) => {
    let bars = 0, changes = 0, flipflops = 0;
    for (const c of f.coins) { const x = flipFlops(c.series[t], f.win); bars += x.bars; changes += x.changes; flipflops += x.flipflops; }
    return { tf: tf.key, bars, changes, flipflops, per_1000: bars ? (1000 * flipflops) / bars : null };
  });
  // T3's runs table is A5's perTf: a property of the runs alone, so no resample and no shuffle is drawn for it here
  const runs = a5(f, 'A5.S', 0, { B: 0, alpha: ALPHA, bootSeed: 0, shuffleB: 0, shuffleSeed: 0 }).perTf;
  return { entries: f.nE, a4: { point: ra.point, lb: ra.lb, ub: ra.ub, rows: ra.rows, clusters: ra.clusters, eff: ra.eff }, lag, flip_flops, runs };
}

/** T3's path-label figures from a fit frame with outcomes. `B` and `F` are T3's (B_BOOT and its cluster floor) in a real read. */
export function recomputeT3Outcomes(f: Frame, F: number, B: number = B_BOOT): T3OutcomeFigures {
  if (!f.cells) throw new Error('regime-15m: the parity leg\'s path-label figures read outcomes; this frame has none');
  const ctx = context(f);
  const [m12Seed] = seedsFor(STUDY_SEED, [seedArm('fit', 'M12', 'bootstrap')]);
  const m12 = registered(f, 'M12') as Built;
  const r12 = compute(f, ctx, m12.stat, { B, alpha: ALPHA, bootSeed: m12Seed });
  const armAcc = m12.arms.map((arm) => accumulate(f, ctx, arm)), armEff = effOfCw(armAcc.map((a) => a.cw));
  return {
    m12: { point: r12.point, lb: r12.lb, ub: r12.ub, rows: r12.rows, eff: Math.min(...armEff) },
    delta1_by_tf_hold: m12.arms.map((arm, i) => (armEff[i] >= F ? { tf: arm.id, eff: armEff[i], state: 'reported', by_hold: delta1ByHold(armAcc[i].tot) } : { tf: arm.id, eff: armEff[i], state: 'too little data', by_hold: null })),
  };
}

/** Every figure the leg compares, from a fit frame with outcomes. */

/** The same figures, read from T3's fit result (its JSON). Throws when the result lacks one. */
export function t3FiguresOf(json: unknown): T3Figures {
  const d = json as {
    entries: number; primaries: { A4: { reading: T3Figures['a4'] } }; secondary: Array<{ id: string } & T3Figures['m12']>;
    descriptives: { delta1_by_tf_hold: T3Figures['delta1_by_tf_hold']; lag: T3Figures['lag']; flip_flops: T3Figures['flip_flops']; runs: T3Figures['runs'] };
  };
  const m12 = d.secondary?.find((s) => s.id === 'M12'), a4 = d.primaries?.A4?.reading;
  if (!m12 || !a4 || !d.descriptives || typeof d.entries !== 'number') throw new Error('regime-15m: the parity reference lacks a figure the leg compares');
  return {
    entries: d.entries,
    a4: { point: a4.point, lb: a4.lb, ub: a4.ub, rows: a4.rows, clusters: a4.clusters, eff: a4.eff },
    lag: d.descriptives.lag, flip_flops: d.descriptives.flip_flops, runs: d.descriptives.runs,
    m12: { point: m12.point, lb: m12.lb, ub: m12.ub, rows: m12.rows, eff: m12.eff },
    delta1_by_tf_hold: d.descriptives.delta1_by_tf_hold,
  };
}

export interface ParityItem { field: string; want: string; got: string }
export interface Parity { ok: boolean; compared: number; misses: ParityItem[] }

/** Every field, compared as its JSON text: the printed precision of the reference. */
export function parityOf<T extends object>(want: T, got: T): Parity {
  const misses: ParityItem[] = [];
  let compared = 0;
  const walk = (field: string, a: unknown, b: unknown): void => {
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) { a.forEach((x, i) => walk(`${field}[${i}]`, x, b[i])); return; }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) walk(`${field}.${k}`, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
      return;
    }
    compared++;
    const w = JSON.stringify(a) ?? 'undefined', g = JSON.stringify(b) ?? 'undefined';
    if (w !== g) misses.push({ field, want: w, got: g });
  };
  walk('t3', want, got);
  return { ok: misses.length === 0 && compared > 0, compared, misses };
}

/** Two legs of one parity: green only when both are. */
export const joinParity = (a: Parity, b: Parity): Parity => ({ ok: a.ok && b.ok, compared: a.compared + b.compared, misses: [...a.misses, ...b.misses] });
