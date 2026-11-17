// regime-diag/challenge/paired-stats.ts — EDGE-REGIME-CHALLENGE-R1-W1: the paired statistics.
//
// Every quantity here compares two arms on the SAME entries — the challenger's rows and the served rule's — and
// both arms are recomputed on every coin × UTC-day cluster-bootstrap resample (T3 §4.6). A reading built with
// `arms: false` holds the paired quantity alone: the judge's result is written from such readings only.
//
//   ΔΔ1   Δ1(challenger) − Δ1(served), T3's A1 statistic (§4.8) under each arm's own label and confidence
//   A4    S4(challenger) − S4(served)                                    fails when the interval is wholly below −3.0 pp
//   A5    R5(challenger) ÷ R5(served), on the per-closed-bar series       fails when the interval is wholly below 1/1.10
//   cov   the challenger's TRENDING ≥ 60 row share over the served's      fails below 0.5
import { runsOf, barSeq, type BarSeq, type Runs } from '../bars.js';
import { ALPHA, FLOOR_PP, REGIME_AGAINST_MIN_CONFIDENCE, TFS } from '../diag-spec.js';
import { bootstrap, compute, contrast, cwOfRows, effOfCw, shuffleBlocks, type Acc, type Ctx, type Stat } from '../engine.js';
import { N_TF, dayOf, type Census, type Frame, type Lab } from '../frame.js';
import { attainableOf, boundsOf, kishOf } from '../prims.js';
import { mulberry32 } from '../rng.js';
import { a4, delta1, trendDir } from '../stats.js';
import type { ChallengerCols } from './challenger-replay.js';
import { A4_GUARD_PP, A5_GUARD_RATIO, C3_TF, COVERAGE_FLOOR, HALF_WIDTH_Z, POWER_Z, SERVED_TF, type Candidate, type Dial } from './challenge-spec.js';

// ── a pair: the two arms of one challenger on one frame ─────────────────────────────────────────────────────────

export interface Pair {
  id: string;
  /** Per frame row: the direction each arm reads at confidence ≥ 60 (0 none, 1 up, 2 down) — the primary's rows. */
  chal60: Uint8Array; serv60: Uint8Array;
  /** The same at any confidence — A4's rows. */
  chalAny: Uint8Array; servAny: Uint8Array;
  /** Per row: 1 where the arm has a call at all — the denominator of its row share. */
  chalRows: Uint8Array; servRows: Uint8Array;
  /** The label column each arm reads (the statistic's sequence; nothing here shuffles it). */
  chalLab: Lab; servLab: Lab;
  /** The per-closed-bar sequences of each arm, inside the window (A5). */
  chalSeqs: BarSeq[]; servSeqs: BarSeq[];
}

export const sameDial = (a: Dial, b: Dial): boolean => a.adxPeriod === b.adxPeriod && a.direction === b.direction;

/**
 * The pair of a candidate. C1 and C2: every row, the challenger's column against the served column. C3: the
 * entries that have a call at all three timeframes (T3's M12 rows) — the 1h rows against the 4h rows.
 */
export function pairOf(f: Frame, cand: Candidate, cols: ChallengerCols | null): Pair {
  const c60 = REGIME_AGAINST_MIN_CONFIDENCE;
  if (cand.dial) {
    const dial = cand.dial;
    const d = cols ? cols.dials.findIndex((x) => sameDial(x, dial)) : -1;
    if (!cols || d < 0) throw new Error(`regime-challenge: ${cand.id} has no challenger column`);
    const lab = cols.labs[d];
    return {
      id: cand.id,
      chal60: trendDir(f, lab, c60), serv60: trendDir(f, f.S, c60), chalAny: trendDir(f, lab), servAny: trendDir(f, f.S),
      chalRows: Uint8Array.from(f.has), servRows: Uint8Array.from(f.has), chalLab: lab, servLab: f.S,
      chalSeqs: f.coins.flatMap((c, i) => cols.series[d][i].map((s, t) => barSeq(s, f.win, c.pos, t, 0))),
      servSeqs: f.coins.flatMap((c) => c.series.map((s, t) => barSeq(s, f.win, c.pos, t, 0))),
    };
  }
  const all3 = (r: number): boolean => { const e = Math.floor(r / N_TF) * N_TF; return f.has[e] === 1 && f.has[e + 1] === 1 && f.has[e + 2] === 1; };
  const at = (t: number) => (r: number): boolean => r % N_TF === t && all3(r);
  const rowsAt = (t: number): Uint8Array => Uint8Array.from(f.has, (_, r) => (at(t)(r) ? 1 : 0));
  return {
    id: cand.id,
    chal60: trendDir(f, f.S, c60, 101, at(C3_TF)), serv60: trendDir(f, f.S, c60, 101, at(SERVED_TF)),
    chalAny: trendDir(f, f.S, 0, 101, at(C3_TF)), servAny: trendDir(f, f.S, 0, 101, at(SERVED_TF)),
    chalRows: rowsAt(C3_TF), servRows: rowsAt(SERVED_TF), chalLab: f.S, servLab: f.S,
    chalSeqs: f.coins.map((c) => barSeq(c.series[C3_TF], f.win, c.pos, C3_TF, 0)),
    servSeqs: f.coins.map((c) => barSeq(c.series[SERVED_TF], f.win, c.pos, SERVED_TF, 0)),
  };
}

// ── readings ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PairedReading {
  /** The paired quantity (a difference, or a ratio), and its one-sided bounds at `alpha`. NaN where undefined. */
  point: number; lb: number; ub: number; alpha: number;
  /** Rows, clusters and Kish-effective clusters of the union of the two arms. */
  rows: number; clusters: number; eff: number;
  B: number; undefinedReplicates: number;
  /** Each arm's own value — in-sample readings only; null in a paired-only reading. */
  arms: { challenger: number; served: number } | null;
  /** The bootstrap replicates of the paired quantity (kept in memory for Holm; never written out). */
  reps: number[];
}
export interface PairedOpts { B: number; alpha: number; seed: number; arms: boolean }

/** θ = a − b on one resample. With `arms: false` the statistic has ONE output: neither arm's value exists in a reading. */
export function pairedStat(id: string, a: Stat, b: Stat, arms: boolean): Stat {
  const c = contrast(id, a, b);
  if (arms) return c;
  const tmp = new Float64Array(3);
  return { id, m: c.m, names: ['theta'], seq: c.seq, add: c.add, evaluate(tot, off, out, o) { c.evaluate(tot, off, tmp, 0); out[o] = tmp[0]; } };
}

function read(f: Frame, ctx: Ctx, s: Stat, o: PairedOpts): PairedReading {
  const r = compute(f, ctx, s, { B: o.B, alpha: o.alpha, bootSeed: o.seed });
  const nOut = r.names.length, reps: number[] = [];
  for (let b = 0; b < r.B; b++) reps.push(r.reps[b * nOut]);
  return { point: r.point[0], lb: r.lb[0], ub: r.ub[0], alpha: o.alpha, rows: r.rows, clusters: r.clusters, eff: r.eff, B: r.B, undefinedReplicates: r.undefinedReplicates,
    arms: nOut === 3 ? { challenger: r.point[1], served: r.point[2] } : null, reps };
}

/** The primary: ΔΔ1 = Δ1(challenger) − Δ1(served), in pp. Needs the frame's outcomes. */
export const deltaDelta1 = (f: Frame, ctx: Ctx, p: Pair, o: PairedOpts): PairedReading =>
  read(f, ctx, pairedStat(`${p.id}.ddelta1`, delta1(f, 'challenger', p.chal60, p.chalLab.lab), delta1(f, 'served', p.serv60, p.servLab.lab), o.arms), o);

/** The A4 guard: S4(challenger) − S4(served), in pp, on rows TRENDING under each arm with a dated key-A phase. */
export const a4Difference = (f: Frame, ctx: Ctx, p: Pair, o: PairedOpts): PairedReading =>
  read(f, ctx, pairedStat(`${p.id}.a4`, a4(f, 'challenger', p.chalAny, p.chalLab.lab), a4(f, 'served', p.servAny, p.servLab.lab), o.arms), o);

// ── A5, paired ─────────────────────────────────────────────────────────────────────────────────────────────────

const move = (q: BarSeq, i: number, len: number): number => Math.log(q.close[i + len] / q.close[i]) / q.sig[i];
const consecutive = (q: BarSeq, i: number, len: number): boolean => i >= 0 && i + len < q.n && q.j[i + len] === q.j[i] + len;

/**
 * The shuffle reference of every run (bars.ts, a5's first pass, restated: the pass is private there). The runs
 * of equal label of a sequence are permuted, a run moves whole, and the reference of a run is the same move over
 * a window of the same length where the run lands — averaged over the shuffles. NaN: no shuffle gave it one.
 */
function references(R: Runs, B: number, seed: number): Float64Array {
  const rnd = mulberry32(seed), n = R.runs.length;
  const maxN = R.seqs.reduce((k, q) => Math.max(k, q.n), 0);
  const order = new Int32Array(maxN), src = new Int32Array(maxN), landing = new Int32Array(maxN);
  const first: number[] = new Array(R.seqs.length + 1).fill(n);
  for (let r = n - 1; r >= 0; r--) first[R.runs[r].seq] = r;
  for (let q = R.seqs.length - 1; q >= 0; q--) first[q] = Math.min(first[q], first[q + 1]);
  const sum = new Float64Array(n), cnt = new Int32Array(n);
  for (let b = 0; b < B; b++) {
    for (let qi = 0; qi < R.seqs.length; qi++) {
      const q = R.seqs[qi];
      shuffleBlocks(R.blocks[qi], rnd, order, src, landing);
      for (let r = first[qi]; r < first[qi + 1]; r++) {
        const run = R.runs[r], p = landing[run.block];
        if (!consecutive(q, p, run.len) || !(q.sig[p] > 0)) continue;
        const ref = Math.abs(move(q, p, run.len));
        if (Number.isFinite(ref)) { sum[r] += ref; cnt[r]++; }
      }
    }
  }
  return Float64Array.from(sum, (s, r) => (cnt[r] > 0 ? s / cnt[r] : NaN));
}

/** One arm's A5 sums: per coin × UTC-day cluster of a run's first close, Σω·y, Σω·c and Σω; and R5 = Σω·y ÷ Σω·c. */
export interface ArmSums { runs: number; censored: number; unreferenced: number; clusters: Map<number, { pos: number; y: number; c: number; w: number }>; point: number }
export function armSums(census: Census, seqs: BarSeq[], shuffleB: number, shuffleSeed: number): ArmSums {
  const R = runsOf(seqs), c = references(R, shuffleB, shuffleSeed);
  const clusters = new Map<number, { pos: number; y: number; c: number; w: number }>();
  let N = 0, D = 0, unreferenced = 0;
  R.runs.forEach((r, i) => {
    if (!Number.isFinite(c[i])) { unreferenced++; return; }
    const w = census.wCoin[r.pos] * census.wTf[r.t], key = r.pos * 100_000 + dayOf(r.j0 * TFS[r.t].min);
    let cl = clusters.get(key);
    if (!cl) { cl = { pos: r.pos, y: 0, c: 0, w: 0 }; clusters.set(key, cl); }
    cl.y += w * r.y; cl.c += w * c[i]; cl.w += w;
    N += w * r.y; D += w * c[i];
  });
  return { runs: R.runs.length, censored: R.censored, unreferenced, clusters, point: D > 0 ? N / D : NaN };
}

/** The A5 guard: R5(challenger) ÷ R5(served), both arms resampled together on the union of their clusters. */
export function a5Ratio(census: Census, id: string, a: ArmSums, b: ArmSums, o: PairedOpts): PairedReading {
  const keys = [...new Set([...a.clusters.keys(), ...b.clusters.keys()])].sort((x, y) => x - y);
  const sums = new Float64Array(keys.length * 4), cw = new Float64Array(keys.length), strata = new Int32Array(keys.length), tot = new Float64Array(4);
  keys.forEach((k, i) => {
    const x = a.clusters.get(k), y = b.clusters.get(k);
    sums[i * 4] = x?.y ?? 0; sums[i * 4 + 1] = x?.c ?? 0; sums[i * 4 + 2] = y?.y ?? 0; sums[i * 4 + 3] = y?.c ?? 0;
    cw[i] = (x?.w ?? 0) + (y?.w ?? 0); strata[i] = (x ?? y)!.pos;
    for (let j = 0; j < 4; j++) tot[j] += sums[i * 4 + j];
  });
  const ratio = (t: Float64Array, off: number): number => (t[off + 1] > 0 && t[off + 3] > 0 && t[off + 2] > 0 ? t[off] / t[off + 1] / (t[off + 2] / t[off + 3]) : NaN);
  const stat: Stat = { id: `${id}.a5`, m: 4, names: ['theta'], seq: new Uint8Array(0), add: () => false, evaluate(t, off, out, at) { out[at] = ratio(t, off); } };
  const ctx: Ctx = { nCl: keys.length, clOf: new Int32Array(0), strata, nStrata: census.panel.length, w: new Float64Array(0) };
  const point = ratio(tot, 0);
  const acc: Acc = { sums, cw, rows: a.runs - a.unreferenced + b.runs - b.unreferenced, clusters: keys.length, tot, point: Float64Array.from([point]) };
  const reps = keys.length > 0 && o.B > 0 ? Array.from(bootstrap(ctx, stat, acc, o.B, mulberry32(o.seed))) : [];
  const bad = reps.filter((x) => !Number.isFinite(x)).length;
  const [lb, ub] = reps.length && bad === 0 ? boundsOf([reps], o.alpha)[0] : [NaN, NaN];
  const sizes = Array.from(cw).filter((x) => x > 0);
  return { point, lb, ub, alpha: o.alpha, rows: acc.rows, clusters: keys.length, eff: sizes.length ? kishOf([sizes])[0] : 0, B: reps.length, undefinedReplicates: bad,
    arms: o.arms ? { challenger: a.point, served: b.point } : null, reps };
}

// ── label-only: coverage and identifiability ─────────────────────────────────────────────────────────────────────

const sumW = (w: Float64Array, sel: Uint8Array): number => { let s = 0; for (let r = 0; r < sel.length; r++) if (sel[r]) s += w[r]; return s; };

/** The challenger's TRENDING ≥ 60 row share (design weights, of the rows its arm has) over the served arm's. Label-only. */
export function coverageRatio(w: Float64Array, p: Pair): number {
  const c = sumW(w, p.chal60) / sumW(w, p.chalRows), s = sumW(w, p.serv60) / sumW(w, p.servRows);
  return s > 0 ? c / s : NaN;
}

/** What is known of an arm's primary rows before any outcome: effective clusters, minority side share, the §4c bound. */
export interface ArmSupport { eff: number; share: number; bound: number | null; ok: boolean; cause: string }
/** T3 §4c and §4.11 on each arm of a pair: ≥ `floor` effective clusters, and an attainable range of ≥ 3.0 pp. Label-only. */
export function supportOf(f: Frame, ctx: Ctx, p: Pair, floor: number): { challenger: ArmSupport; served: ArmSupport; identifiable: boolean } {
  const dirs = [p.chal60, p.serv60];
  const effs = effOfCw(dirs.map((d) => cwOfRows(f, ctx, d)));
  const shares = dirs.map((d) => {
    let up = 0, all = 0;
    for (let r = 0; r < d.length; r++) { if (!d[r]) continue; all += ctx.w[r]; if (d[r] === 1) up += ctx.w[r]; }
    return all > 0 ? Math.min(up, all - up) / all : NaN;
  });
  const finite = shares.flatMap((s, i) => (Number.isFinite(s) ? [i] : []));
  const bounds = attainableOf(finite.map((i) => shares[i]));
  const arm = (i: number): ArmSupport => {
    const k = finite.indexOf(i), bound = k < 0 ? null : bounds[k];
    const wide = bound !== null && bound >= FLOOR_PP, many = effs[i] >= floor;
    return { eff: effs[i], share: shares[i], bound, ok: wide && many, cause: !many ? `fewer than ${floor} effective clusters` : !wide ? `the attainable range is below ${FLOOR_PP} pp` : 'ok' };
  };
  const challenger = arm(0), served = arm(1);
  return { challenger, served, identifiable: challenger.ok && served.ok };
}

// ── the guards, Holm, power ────────────────────────────────────────────────────────────────────────────────────

export type GuardState = 'holds' | 'fails' | 'unreadable';
/** A4 fails when the interval lies wholly below −3.0 pp; a reading with no interval is unreadable, and is not a pass. */
export const a4Guard = (r: PairedReading): GuardState => (!Number.isFinite(r.ub) ? 'unreadable' : r.ub < A4_GUARD_PP ? 'fails' : 'holds');
/** A5 fails when the interval lies wholly below 1/1.10. */
export const a5Guard = (r: PairedReading): GuardState => (!Number.isFinite(r.ub) ? 'unreadable' : r.ub < A5_GUARD_RATIO ? 'fails' : 'holds');
/** Coverage fails below 0.5. */
export const coverageGuard = (ratio: number): GuardState => (!Number.isFinite(ratio) ? 'unreadable' : ratio < COVERAGE_FLOOR ? 'fails' : 'holds');

/**
 * Holm's step-down over the challengers judged, on one-sided bootstrap bounds. Challenger `i` has replicates
 * `reps[i]` (none: it could not be read, and it still counts in the family). They are ordered by the share of
 * replicates at or below 0; the k-th (from 0) is tested at `alpha / (m − k)`, and the first that does not clear 0
 * stops the rest.
 */
export function holm(reps: ReadonlyArray<readonly number[]>, alpha = ALPHA): Array<{ rank: number; level: number; lb: number; rejects: boolean }> {
  const m = reps.length;
  const p = reps.map((r) => (r.length && r.every(Number.isFinite) ? (1 + r.filter((x) => x <= 0).length) / (1 + r.length) : Infinity));
  const order = reps.map((_, i) => i).sort((a, b) => p[a] - p[b] || a - b);
  const out = new Array<{ rank: number; level: number; lb: number; rejects: boolean }>(m);
  let open = true;
  order.forEach((i, k) => {
    const level = alpha / (m - k);
    const lb = Number.isFinite(p[i]) ? boundsOf([Array.from(reps[i])], level)[0][0] : NaN;
    open = open && lb > 0;
    out[i] = { rank: k + 1, level, lb, rejects: open };
  });
  return out;
}

/**
 * T3 §5's instrument on a half-width: SE = h / 1.96; the detectable effect at 80% power and a one-sided 2.5% level
 * is 2.80 · SE; `multiple` is how many times the coin-days would bring it down to `effect`. `scale` moves a
 * half-width from one window to another: sqrt(coin-days there ÷ coin-days here).
 */
export function powerAt(h: number, effect: number, scale = 1): { se: number; detectable: number; effect: number; multiple: number; underpowered: boolean } {
  const se = (h / HALF_WIDTH_Z) * scale, detectable = POWER_Z * se, e = Math.abs(effect);
  const multiple = e > 0 ? (detectable / e) ** 2 : Infinity;
  return { se, detectable, effect: e, multiple, underpowered: !(multiple <= 1) };
}
