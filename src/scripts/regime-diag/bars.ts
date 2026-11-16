// regime-diag/bars.ts — EDGE-REGIME-DIAG-W1: the bar-level statistics, on the per-closed-bar series (§4.1).
//
// A5 (persistence and swing size, §4.8) and the two descriptive tables of A4 that live on bars (lag, flip-flops).
// The shuffle here is baseline (c) on the per-closed-bar series of a coin × timeframe × window: the runs of equal
// label are permuted, a run moves whole, and closes and volatility ratios stay where they are.
import { ATR_RANGE_PER_SIGMA } from '../../lib/pre-trade-calc.js';
import { blocksOf, bootstrap, shuffleBlocks, type Acc, type Blocks, type Ctx, type Stat } from './engine.js';
import { dayOf, isTrending, type Census } from './frame.js';
import type { KeyA } from './keys.js';
import { boundsOf, kishOf } from './prims.js';
import type { Series } from './replay.js';
import { mulberry32 } from './rng.js';
import { L_UP, N_FF, TFS, type Variant, type Win } from './diag-spec.js';

/** The closes of one coin × timeframe inside a window that carry a label, in time order. */
export interface BarSeq {
  pos: number; t: number; n: number;
  /** Close index (grid minute `j · I`). */
  j: Int32Array;
  label: Uint8Array;
  /** The close at `j`, and σ_bar(j) = volatilityRatio(j) ÷ ATR_RANGE_PER_SIGMA (served series). */
  close: Float64Array; sig: Float64Array;
}

/**
 * `lead = 0`: the served series. `lead = 14`: key B's series, the served label read 14 bars later (§4.10); a
 * close then needs its own call (for the close and σ), the call at `j + lead`, and `(j + lead)·I` inside the window.
 */
export function barSeq(s: Series, win: Win, pos: number, t: number, lead: number): BarSeq {
  const min = s.tf.min, js: number[] = [];
  for (let j = Math.max(1, Math.ceil(win.lo / min)); (j + lead) * min < win.hi && j + lead <= s.nb; j++) if (s.ok[j] && s.ok[j + lead]) js.push(j);
  const n = js.length;
  const q: BarSeq = { pos, t, n, j: Int32Array.from(js), label: new Uint8Array(n), close: new Float64Array(n), sig: new Float64Array(n) };
  for (let i = 0; i < n; i++) { q.label[i] = s.label[js[i] + lead]; q.close[i] = s.close[js[i]]; q.sig[i] = s.vol[js[i]] / ATR_RANGE_PER_SIGMA; }
  return q;
}

export interface Run {
  /** Sequence and block (the block shuffle moves blocks), first close, length in bars. */
  seq: number; block: number; i0: number; j0: number; len: number;
  pos: number; t: number; up: boolean;
  /** y = |ln(C_j1 / C_j0)| ÷ σ_bar(j0), and the same move signed in the label's direction. */
  y: number; signed: number;
}
export interface Runs { seqs: BarSeq[]; blocks: Blocks[]; runs: Run[]; censored: number }

const move = (q: BarSeq, i: number, len: number): number => Math.log(q.close[i + len] / q.close[i]) / q.sig[i];
const consecutive = (q: BarSeq, i: number, len: number): boolean => i >= 0 && i + len < q.n && q.j[i + len] === q.j[i] + len;

/**
 * The TRENDING runs of each sequence. A block is a maximal run of equal label over consecutive closes (a missing
 * close ends it). A run is a TRENDING block with a block before it and a block after it over consecutive closes:
 * the close its label first appears, and the close a different label first appears. Anything else is cut.
 */
export function runsOf(seqs: BarSeq[]): Runs {
  const blocks = seqs.map((q) => blocksOf(q.n, (i) => q.label[i], (i) => q.j[i] !== q.j[i - 1] + 1));
  const runs: Run[] = [];
  let censored = 0;
  seqs.forEach((q, qi) => {
    const bl = blocks[qi];
    for (let b = 0; b < bl.start.length; b++) {
      const i0 = bl.start[b], len = bl.len[b];
      if (!isTrending(q.label[i0])) continue;
      const whole = i0 > 0 && q.j[i0 - 1] === q.j[i0] - 1 && consecutive(q, i0, len);
      const y = whole ? move(q, i0, len) : NaN;
      if (!whole || !(q.sig[i0] > 0) || !Number.isFinite(y)) { censored++; continue; }
      const up = q.label[i0] === L_UP;
      runs.push({ seq: qi, block: b, i0, j0: q.j[i0], len, pos: q.pos, t: q.t, up, y: Math.abs(y), signed: up ? y : -y });
    }
  });
  return { seqs, blocks, runs, censored };
}

/** One pass over `B` shuffles: `visit(draw, run index, reference)` for every run whose landing place has a reference. */
function shufflePass(R: Runs, B: number, seed: number, visit: (b: number, r: number, ref: number) => void): void {
  const rnd = mulberry32(seed);
  const maxN = R.seqs.reduce((n, q) => Math.max(n, q.n), 0);
  const order = new Int32Array(maxN), src = new Int32Array(maxN), landing = new Int32Array(maxN);
  const first: number[] = new Array(R.seqs.length + 1).fill(R.runs.length);
  for (let r = R.runs.length - 1; r >= 0; r--) first[R.runs[r].seq] = r;
  for (let q = R.seqs.length - 1; q >= 0; q--) first[q] = Math.min(first[q], first[q + 1]);
  for (let b = 0; b < B; b++) {
    for (let qi = 0; qi < R.seqs.length; qi++) {
      const q = R.seqs[qi];
      shuffleBlocks(R.blocks[qi], rnd, order, src, landing);
      for (let r = first[qi]; r < first[qi + 1]; r++) {
        const run = R.runs[r], p = landing[run.block];
        if (!consecutive(q, p, run.len) || !(q.sig[p] > 0)) continue;
        const ref = Math.abs(move(q, p, run.len));
        if (Number.isFinite(ref)) visit(b, r, ref);
      }
    }
  }
}

/** What a5 needs of a frame: the window, the design weights, and each coin's per-closed-bar series. */
export interface BarFrame { win: Win; census: Census; coins: Array<{ pos: number; series: Series[] }> }

export interface A5Opts { B: number; alpha: number; bootSeed: number; shuffleB: number; shuffleSeed: number; variant?: Variant; keep?: ReadonlySet<number> }
export interface A5Reading {
  id: string;
  runs: number; censored: number;
  /** Runs with no reference in any shuffle (left out of the ratio). */
  unreferenced: number;
  clusters: number; eff: number;
  /** R5 = Σ ω·y / Σ ω·c, and its bounds. */
  point: number; lb: number; ub: number; alpha: number; B: number; undefinedReplicates: number;
  /** `pUpper = (1 + #{T* ≥ R5}) / (1 + B_c)`, `pLower` the other tail; a draw with no defined ratio counts in both. */
  shuffle: { n: number; mean: number; pUpper: number; pLower: number };
  /** Descriptive, per timeframe: run length in bars (ω-weighted mean and median) and the signed move ÷ σ. */
  perTf: Array<{ tf: string; runs: number; meanLen: number; medianLen: number; signed: number }>;
}

/** The runs of a reading: every coin × timeframe, or only the positions of `keep` under the panel13 variant. */
function runsIn(f: BarFrame, lead: number, variant?: Variant, keep?: ReadonlySet<number>): Runs {
  const seqs: BarSeq[] = [];
  for (const c of f.coins) {
    if (variant === 'panel13' && !keep?.has(c.pos)) continue;
    c.series.forEach((s, t) => seqs.push(barSeq(s, f.win, c.pos, t, lead)));
  }
  return runsOf(seqs);
}
const weightOf = (f: BarFrame, r: Run, variant?: Variant): number => (variant === 'unit' ? 1 : f.census.wCoin[r.pos] * f.census.wTf[r.t]);
/** A run's cluster: coin × UTC day of its first close (pooled days, or coin × 7-day blocks, under the variants). */
const clusterOf = (r: Run, variant?: Variant): number => {
  const day = dayOf(r.j0 * TFS[r.t].min);
  return variant === 'day' ? day : r.pos * 100_000 + (variant === 'week' ? Math.floor(day / 7) : day);
};

/** Kish effective clusters of every run of a reading, from the labels alone: the floor check made before any move is read. */
export function a5Eff(f: BarFrame, lead: number, variant?: Variant, keep?: ReadonlySet<number>): number {
  const cw = new Map<number, number>();
  for (const r of runsIn(f, lead, variant, keep).runs) cw.set(clusterOf(r, variant), (cw.get(clusterOf(r, variant)) ?? 0) + weightOf(f, r, variant));
  return cw.size ? kishOf([[...cw.values()]])[0] : 0;
}

/**
 * A5 on the served series (`lead = 0`) or on key B's (`lead = 14`). The reference `c` of a run is the same
 * quantity for a window of the same length where the run lands under the shuffle, averaged over the shuffles;
 * the p-value comes from the same shuffles, each draw's ratio taken over the runs that have a reference in it.
 */
export function a5(f: BarFrame, id: string, lead: number, o: A5Opts): A5Reading {
  const R = runsIn(f, lead, o.variant, o.keep), n = R.runs.length;
  const w = Float64Array.from(R.runs, (r) => weightOf(f, r, o.variant));
  // pass 1: the reference of each run
  const sum = new Float64Array(n), cnt = new Int32Array(n);
  shufflePass(R, o.shuffleB, o.shuffleSeed, (_b, r, ref) => { sum[r] += ref; cnt[r]++; });
  const c = Float64Array.from(sum, (s, r) => (cnt[r] > 0 ? s / cnt[r] : NaN));
  // pass 2 (the same stream): each draw's ratio
  const num = new Float64Array(o.shuffleB), den = new Float64Array(o.shuffleB);
  shufflePass(R, o.shuffleB, o.shuffleSeed, (b, r, ref) => { num[b] += w[r] * ref; den[b] += w[r] * c[r]; });
  // clusters: coin × UTC day of the run's first close
  const ids = new Map<number, number>(), strata: number[] = [];
  const sums: number[] = [], cw: number[] = [];
  let N = 0, D = 0, unreferenced = 0;
  R.runs.forEach((r, i) => {
    if (!Number.isFinite(c[i])) { unreferenced++; return; }
    const key = clusterOf(r, o.variant);
    let cl = ids.get(key);
    if (cl === undefined) { cl = ids.size; ids.set(key, cl); strata.push(o.variant === 'day' ? 0 : r.pos); sums.push(0, 0); cw.push(0); }
    sums[cl * 2] += w[i] * r.y; sums[cl * 2 + 1] += w[i] * c[i]; cw[cl] += w[i];
    N += w[i] * r.y; D += w[i] * c[i];
  });
  const point = D > 0 ? N / D : NaN;
  const ratio: Stat = { id, m: 2, names: ['S'], seq: new Uint8Array(0), add: () => false, evaluate(tot, off, out, at) { out[at] = tot[off + 1] > 0 ? tot[off] / tot[off + 1] : NaN; } };
  const ctx: Ctx = { nCl: ids.size, clOf: new Int32Array(0), strata: Int32Array.from(strata), nStrata: o.variant === 'day' ? 1 : f.census.panel.length, w: new Float64Array(0) };
  const acc: Acc = { sums: Float64Array.from(sums), cw: Float64Array.from(cw), rows: n - unreferenced, clusters: ids.size, tot: Float64Array.from([N, D]), point: Float64Array.from([point]) };
  const reps = ids.size > 0 && o.B > 0 ? Array.from(bootstrap(ctx, ratio, acc, o.B, mulberry32(o.bootSeed))) : [];
  const bad = reps.filter((x) => !Number.isFinite(x)).length;
  const [lb, ub] = reps.length && bad === 0 ? boundsOf([reps], o.alpha)[0] : [NaN, NaN];
  let ge = 0, le = 0, fin = 0, tot = 0;
  for (let b = 0; b < o.shuffleB; b++) {
    const v = den[b] > 0 ? num[b] / den[b] : NaN;
    if (!Number.isFinite(v)) { ge++; le++; continue; }
    if (v >= point) ge++;
    if (v <= point) le++;
    tot += v; fin++;
  }
  const perTf = TFS.map((tf, t) => {
    const mine = R.runs.filter((r) => r.t === t), ws = mine.map((r) => (o.variant === 'unit' ? 1 : f.census.wCoin[r.pos] * f.census.wTf[t])), W = ws.reduce((a, b) => a + b, 0);
    const by = mine.map((r, i) => ({ len: r.len, w: ws[i] })).sort((a, b) => a.len - b.len);
    let cum = 0, medianLen = NaN;
    for (const x of by) { cum += x.w; if (cum >= W / 2) { medianLen = x.len; break; } }
    return { tf: tf.key, runs: mine.length, meanLen: W > 0 ? mine.reduce((s, r, i) => s + ws[i] * r.len, 0) / W : NaN, medianLen, signed: W > 0 ? mine.reduce((s, r, i) => s + ws[i] * r.signed, 0) / W : NaN };
  });
  return { id, runs: n, censored: R.censored, unreferenced, clusters: ids.size, eff: cw.length ? kishOf([cw])[0] : 0, point, lb, ub, alpha: o.alpha, B: reps.length, undefinedReplicates: bad,
    shuffle: { n: o.shuffleB, mean: fin ? tot / fin : NaN, pUpper: (1 + ge) / (1 + o.shuffleB), pLower: (1 + le) / (1 + o.shuffleB) }, perTf };
}

/**
 * Lag (descriptive): for each key-A turn, the closed bars from the turn's bar to the first close of the series
 * whose label points the new way — 0 when the close of the turn's bar already does. Censored at the next turn;
 * the last turn of a window is censored at the window's end.
 */
export function lagOf(a: KeyA, s: Series): { turns: number; censored: number; lags: number[] } {
  const lags: number[] = [];
  let censored = 0;
  const T = a.turns.idx.length;
  for (let i = 0; i < T; i++) {
    const k = a.bars[a.turns.idx[i]], want = a.turns.kind[i] === -1 ? L_UP : L_UP + 1;
    const last = i + 1 < T ? a.bars[a.turns.idx[i + 1]] : Infinity;
    let lag = -1;
    for (let j = k + 1; j <= last && j <= s.nb && j * s.tf.min < a.win.hi; j++) if (s.ok[j] && s.label[j] === want) { lag = j - 1 - k; break; }
    if (lag < 0) censored++; else lags.push(lag);
  }
  return { turns: T, censored, lags };
}

/**
 * Flip-flops (descriptive): among the closes of a window, a label change at `j` whose previous label is back
 * within N_ff = 3 closes, over consecutive closes that all carry a label. `bars` is the closes that carry one.
 */
export function flipFlops(s: Series, win: Win): { bars: number; changes: number; flipflops: number } {
  const min = s.tf.min, inside = (j: number): boolean => j >= 1 && j <= s.nb && j * min >= win.lo && j * min < win.hi && s.ok[j] === 1;
  let bars = 0, changes = 0, flipflops = 0;
  for (let j = Math.max(1, Math.ceil(win.lo / min)); j * min < win.hi && j <= s.nb; j++) {
    if (!s.ok[j]) continue;
    bars++;
    if (!inside(j - 1) || s.label[j] === s.label[j - 1]) continue;
    changes++;
    for (let d = 1; d <= N_FF && inside(j + d); d++) if (s.label[j + d] === s.label[j - 1]) { flipflops++; break; }
  }
  return { bars, changes, flipflops };
}
