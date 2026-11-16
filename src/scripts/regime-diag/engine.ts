// regime-diag/engine.ts — EDGE-REGIME-DIAG-W1: the estimation engine (§4.5–§4.7).
//
// A statistic is a function of ω-weighted column sums. The cluster bootstrap resamples whole clusters inside each
// stratum (a coin) and re-evaluates the statistic and its paired comparators on the same resample. The block
// shuffle (baseline (c)) permutes the maximal runs of equal label inside each coin × timeframe: the label and
// everything decided with it travel, the outcomes, σ, comparators, weights and clusters stay in place.
import { N_TF, dayOf, type Frame } from './frame.js';
import { boundsOf, kishOf } from './prims.js';
import { mulberry32, type Rnd } from './rng.js';
import { type Variant } from './diag-spec.js';

/** Clusters, strata and row weights of one reading. Variants of §4.11 change exactly these. */
export interface Ctx {
  nCl: number;
  /** Per entry: its cluster, or −1 when the entry is outside this reading (PANEL_SENSITIVE). */
  clOf: Int32Array;
  /** Per cluster: its stratum. */
  strata: Int32Array;
  nStrata: number;
  /** Per row: ω = w_coin · w_timeframe (1 under the unit variant). */
  w: Float64Array;
}

/**
 * The default: cluster = coin × UTC day of the entry, resampled inside each coin, ω from the census.
 * `day`: UTC days pooled across coins (one stratum). `week`: coin × 7-day blocks counted from the grid origin.
 * `unit`: every row weight 1. `panel13`: only the positions of `keep`.
 */
export function context(f: Frame, variant?: Variant, keep?: ReadonlySet<number>): Ctx {
  const ids = new Map<number, number>();
  const strata: number[] = [];
  const clOf = new Int32Array(f.nE);
  for (let e = 0; e < f.nE; e++) {
    const pos = f.ePos[e], day = dayOf(f.eM[e]);
    if (variant === 'panel13' && !keep?.has(pos)) { clOf[e] = -1; continue; }
    const key = variant === 'day' ? day : pos * 100_000 + (variant === 'week' ? Math.floor(day / 7) : day);
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); strata.push(variant === 'day' ? 0 : pos); }
    clOf[e] = id;
  }
  const w = new Float64Array(f.nE * N_TF);
  for (let r = 0; r < w.length; r++) w[r] = variant === 'unit' ? 1 : f.census.wCoin[f.ePos[Math.floor(r / N_TF)]] * f.census.wTf[r % N_TF];
  return { nCl: ids.size, clOf, strata: Int32Array.from(strata), nStrata: variant === 'day' ? 1 : f.census.panel.length, w };
}

export interface Stat {
  id: string;
  /** Columns of the sum vector, and the names of the outputs. Output 0 is the statistic itself. */
  m: number;
  names: string[];
  /** Per row: the label sequence the block shuffle permutes for this statistic (its own answer key). */
  seq: Uint8Array;
  /**
   * Adds row `place` (its outcomes and comparators), read under the label of row `src`, with weight `w`, into
   * `acc` at `off`. Returns whether the row belongs to the statistic. Outside a shuffle `src === place`.
   */
  add(src: number, place: number, w: number, acc: Float64Array, off: number): boolean;
  /** The outputs from a sum vector; NaN where undefined (a cell with no defined row). */
  evaluate(tot: Float64Array, off: number, out: Float64Array, o: number): void;
}

export interface Acc { sums: Float64Array; cw: Float64Array; rows: number; clusters: number; tot: Float64Array; point: Float64Array }

/** Column sums per cluster, the Σω of the statistic's rows per cluster, and the point values. */
export function accumulate(f: Frame, ctx: Ctx, s: Stat): Acc {
  const sums = new Float64Array(ctx.nCl * s.m), cw = new Float64Array(ctx.nCl);
  let rows = 0;
  for (let r = 0; r < f.has.length; r++) {
    if (!f.has[r]) continue;
    const cl = ctx.clOf[Math.floor(r / N_TF)];
    if (cl < 0) continue;
    if (s.add(r, r, ctx.w[r], sums, cl * s.m)) { cw[cl] += ctx.w[r]; rows++; }
  }
  const tot = new Float64Array(s.m);
  let clusters = 0;
  for (let c = 0; c < ctx.nCl; c++) {
    if (!(cw[c] > 0)) continue;
    clusters++;
    for (let k = 0; k < s.m; k++) tot[k] += sums[c * s.m + k];
  }
  const point = new Float64Array(s.names.length).fill(NaN);
  if (rows > 0) s.evaluate(tot, 0, point, 0);
  return { sums, cw, rows, clusters, tot, point };
}

/** Σω per cluster of the rows `sel` marks — what `accumulate` holds in `cw`, from the labels alone. */
export function cwOfRows(f: Frame, ctx: Ctx, sel: Uint8Array): Float64Array {
  const cw = new Float64Array(ctx.nCl);
  for (let r = 0; r < f.has.length; r++) {
    if (!f.has[r] || !sel[r]) continue;
    const cl = ctx.clOf[Math.floor(r / N_TF)];
    if (cl >= 0) cw[cl] += ctx.w[r];
  }
  return cw;
}
/** Kish effective clusters of each Σω vector; a cluster with no weight is not a cluster. One bridge call. */
export const effOfCw = (cws: readonly Float64Array[]): number[] => kishOf(cws.map((cw) => Array.from(cw).filter((x) => x > 0)));

/** `B` resamples of the statistic's clusters, with replacement, inside each stratum. Row-major: replicate × output. */
export function bootstrap(ctx: Ctx, s: Stat, acc: Acc, B: number, rnd: Rnd): Float64Array {
  const lists: number[][] = Array.from({ length: ctx.nStrata }, () => []);
  for (let c = 0; c < ctx.nCl; c++) if (acc.cw[c] > 0) lists[ctx.strata[c]].push(c);
  const active = lists.filter((l) => l.length > 0).map((l) => Int32Array.from(l));
  const nOut = s.names.length, m = s.m;
  const reps = new Float64Array(B * nOut).fill(NaN);
  const tot = new Float64Array(m);
  for (let b = 0; b < B; b++) {
    tot.fill(0);
    for (const l of active) {
      for (let i = 0; i < l.length; i++) {
        const off = l[Math.floor(rnd() * l.length)] * m;
        for (let k = 0; k < m; k++) tot[k] += acc.sums[off + k];
      }
    }
    s.evaluate(tot, 0, reps, b * nOut);
  }
  return reps;
}

/** Maximal runs of equal value in `seq[0..n)`; a run also ends where `breakBefore[i]` is set. */
export interface Blocks { n: number; start: Int32Array; len: Int32Array }
export function blocksOf(n: number, at: (i: number) => number, breakBefore?: (i: number) => boolean): Blocks {
  const start: number[] = [], len: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || at(i) !== at(i - 1) || breakBefore?.(i)) { start.push(i); len.push(1); } else len[len.length - 1]++;
  }
  return { n, start: Int32Array.from(start), len: Int32Array.from(len) };
}

/**
 * One block shuffle: a uniform permutation (Fisher–Yates) of the blocks. `src[i]` is the original index of the
 * element that lands at place `i`; `landing[b]` (when given) is the place where block `b` starts.
 */
export function shuffleBlocks(bl: Blocks, rnd: Rnd, order: Int32Array, src: Int32Array, landing?: Int32Array): void {
  const nb = bl.start.length;
  for (let i = 0; i < nb; i++) order[i] = i;
  for (let i = nb - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
  let at = 0;
  for (let k = 0; k < nb; k++) {
    const b = order[k], s0 = bl.start[b], L = bl.len[b];
    if (landing) landing[b] = at;
    for (let d = 0; d < L; d++) src[at++] = s0 + d;
  }
}

/** The rows of each coin × timeframe that a reading holds, in time order. */
export function sequences(f: Frame, ctx: Ctx): Int32Array[] {
  const out: Int32Array[] = [];
  for (const c of f.coins) {
    for (let t = 0; t < N_TF; t++) {
      const rows: number[] = [];
      for (let e = c.e0; e < c.e1; e++) if (f.has[e * N_TF + t] && ctx.clOf[e] >= 0) rows.push(e * N_TF + t);
      if (rows.length) out.push(Int32Array.from(rows));
    }
  }
  return out;
}

/** `B` block shuffles of the statistic's label sequence. Row-major: shuffle × output. */
export function shuffles(f: Frame, ctx: Ctx, s: Stat, B: number, rnd: Rnd): Float64Array {
  const seqs = sequences(f, ctx);
  const blocks = seqs.map((rows) => blocksOf(rows.length, (i) => s.seq[rows[i]]));
  const maxN = seqs.reduce((n, r) => Math.max(n, r.length), 0);
  const order = new Int32Array(maxN), src = new Int32Array(maxN);
  const nOut = s.names.length;
  const reps = new Float64Array(B * nOut).fill(NaN);
  const tot = new Float64Array(s.m);
  for (let b = 0; b < B; b++) {
    tot.fill(0);
    for (let q = 0; q < seqs.length; q++) {
      const rows = seqs[q];
      shuffleBlocks(blocks[q], rnd, order, src);
      for (let i = 0; i < rows.length; i++) s.add(rows[src[i]], rows[i], ctx.w[rows[i]], tot, 0);
    }
    s.evaluate(tot, 0, reps, b * nOut);
  }
  return reps;
}

export interface Reading {
  id: string; names: string[];
  rows: number; clusters: number;
  /** Kish effective clusters over the Σω of the statistic's rows per cluster. */
  eff: number;
  point: number[];
  /** One-sided bounds at `alpha` per output; NaN when a replicate is undefined. */
  lb: number[]; ub: number[]; alpha: number;
  B: number; undefinedReplicates: number;
  shuffle: { n: number; mean: number; pUpper: number; pLower: number } | null;
  /** The bootstrap replicates (replicate × output). Kept in memory for the secondary family; never written out. */
  reps: Float64Array;
}

export interface ComputeOpts { B: number; alpha: number; bootSeed: number; shuffle?: { B: number; seed: number } }

/** Point values, the cluster bootstrap with its bounds, the effective clusters, and (when asked) the shuffle null. */
export function compute(f: Frame, ctx: Ctx, s: Stat, o: ComputeOpts): Reading {
  const acc = accumulate(f, ctx, s);
  const nOut = s.names.length;
  const reps = acc.rows > 0 && o.B > 0 ? bootstrap(ctx, s, acc, o.B, mulberry32(o.bootSeed)) : new Float64Array(0);
  const B = reps.length / nOut;
  const lb = new Array<number>(nOut).fill(NaN), ub = new Array<number>(nOut).fill(NaN);
  const cols: number[][] = [], which: number[] = [];
  let undefinedReplicates = 0;
  for (let k = 0; k < nOut && B > 0; k++) {
    const col = new Array<number>(B);
    let bad = 0;
    for (let b = 0; b < B; b++) { col[b] = reps[b * nOut + k]; if (!Number.isFinite(col[b])) bad++; }
    if (k === 0) undefinedReplicates = bad;
    if (bad === 0) { cols.push(col); which.push(k); }
  }
  boundsOf(cols, o.alpha).forEach(([lo, hi], i) => { lb[which[i]] = lo; ub[which[i]] = hi; });
  const sizes: number[] = [];
  for (let c = 0; c < ctx.nCl; c++) if (acc.cw[c] > 0) sizes.push(acc.cw[c]);
  const eff = sizes.length ? kishOf([sizes])[0] : 0;
  let shuffle: Reading['shuffle'] = null;
  if (o.shuffle && acc.rows > 0) {
    const sh = shuffles(f, ctx, s, o.shuffle.B, mulberry32(o.shuffle.seed));
    shuffle = tail(sh, nOut, acc.point[0]);
  }
  return { id: s.id, names: s.names, rows: acc.rows, clusters: acc.clusters, eff, point: Array.from(acc.point), lb, ub, alpha: o.alpha, B, undefinedReplicates, shuffle, reps };
}

/**
 * The shuffle null of output 0: its mean, `p = (1 + #{T* ≥ S}) / (1 + B_c)` and the mirror tail. An undefined
 * shuffle counts against the statistic in both tails.
 */
export function tail(sh: Float64Array, nOut: number, s: number): { n: number; mean: number; pUpper: number; pLower: number } {
  const n = sh.length / nOut;
  let ge = 0, le = 0, sum = 0, fin = 0;
  for (let b = 0; b < n; b++) {
    const v = sh[b * nOut];
    if (!Number.isFinite(v)) { ge++; le++; continue; }
    if (v >= s) ge++;
    if (v <= s) le++;
    sum += v; fin++;
  }
  return { n, mean: fin ? sum / fin : NaN, pUpper: (1 + ge) / (1 + n), pLower: (1 + le) / (1 + n) };
}

// ── combinators ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Several statistics on one resample. Outputs are concatenated, each name prefixed with its statistic's id. */
export function joint(id: string, parts: readonly Stat[]): Stat {
  const offs: number[] = [], outs: number[] = [];
  let m = 0, n = 0;
  for (const p of parts) { offs.push(m); outs.push(n); m += p.m; n += p.names.length; }
  return {
    id, m, names: parts.flatMap((p) => p.names.map((x) => `${p.id}:${x}`)), seq: parts[0].seq,
    add(src, place, w, acc, off) { let any = false; for (let i = 0; i < parts.length; i++) if (parts[i].add(src, place, w, acc, off + offs[i])) any = true; return any; },
    evaluate(tot, off, out, o) { for (let i = 0; i < parts.length; i++) parts[i].evaluate(tot, off + offs[i], out, o + outs[i]); },
  };
}

/** θ = a − b on one resample. Outputs: `theta`, then the two arms. */
export function contrast(id: string, a: Stat, b: Stat): Stat {
  const j = joint(id, [a, b]);
  const na = a.names.length, tmp = new Float64Array(na + b.names.length);
  return {
    id, m: j.m, names: ['theta', 'a', 'b'], seq: a.seq, add: j.add,
    evaluate(tot, off, out, o) { j.evaluate(tot, off, tmp, 0); out[o] = tmp[0] - tmp[na]; out[o + 1] = tmp[0]; out[o + 2] = tmp[na]; },
  };
}
