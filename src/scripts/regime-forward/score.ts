// regime-forward/score.ts — EDGE-REGIME-FORWARD-W1: T3's answers 4 and 5 on the served series of one venue.
//
// Every statistic is T3's, called from T3's modules unmodified (src/scripts/regime-diag/**): key A (`buildKeyA`),
// A4's statistic (`a4`), the cluster bootstrap (`bootstrap`), the block shuffle (`blocksOf`, `shuffleBlocks`, `tail`),
// A5 (`a5`), lag and flip-flops (`lagOf`, `flipFlops`), the decision rule (`fitState`, `fitStateA5`, `evidenceOf`) and
// the Python primitives (`boundsOf`, `kishOf`, `attainableOf`, `prims` perm). What is T5's own is the INPUT: the
// served label series built from regime_snapshots rows instead of a replay, on each venue's own bar grid, and the
// rows of A4 being bar closes instead of drawn entries (registration §4).
import { a4 } from '../regime-diag/stats.js';
import { a5, a5Eff, barSeq, flipFlops, lagOf, runsOf, type A5Reading, type BarFrame } from '../regime-diag/bars.js';
import { bootstrap, blocksOf, shuffleBlocks, tail, type Acc, type Blocks, type Ctx, type Reading, type Stat } from '../regime-diag/engine.js';
import { evidenceOf, fitState, fitStateA5, type Decision } from '../regime-diag/decide.js';
import { buildKeyA, type KeyA } from '../regime-diag/keys.js';
import { confBin, type Census, type Frame } from '../regime-diag/frame.js';
import { attainableOf, boundsOf, kishOf, prims } from '../regime-diag/prims.js';
import { mulberry32 } from '../regime-diag/rng.js';
import type { Series } from '../regime-diag/replay.js';
import type { Bars } from '../regime-diag/archive.js';
import { L_DOWN, L_RANGING, L_UP, L_VOLATILE } from '../regime-diag/diag-spec.js';
import { ALPHA, DAY_VARIANT_CLUSTERS_NEEDED, FLOOR_PP, TFS, gridWin, keyWin, originMs, scoreWin, tfMs, windowEndMs, W0_MS, W1_MS, type Venue } from './forward-spec.js';
import type { SnapRow } from './snapshot.js';

export type T5State = 'PASS' | 'FAIL' | 'INDETERMINATE';
/** T3 §6's three states, under the names the T5 registration gives them (§6). */
export const stateOf = (d: Decision): T5State => (d.state === 'works' ? 'PASS' : d.state === 'broken' ? 'FAIL' : 'INDETERMINATE');

/** An empty T3 series of `nb` bars. */
export function emptySeries(t: number, nb: number): Series {
  return { tf: TFS[t], nb, ok: new Uint8Array(nb + 1), label: new Uint8Array(nb + 1), conf: new Uint8Array(nb + 1), vol: new Float64Array(nb + 1).fill(NaN),
    close: new Float64Array(nb + 1).fill(NaN), age: new Int32Array(nb + 1), calls: 0, refusals: 0 };
}

/** The served series of one coin × timeframe: the snapshot label at close j (= origin + j·I), the venue's close of bar j − 1. */
export function servedSeries(v: Venue, t: number, rows: readonly SnapRow[], b: Bars): Series {
  const s = emptySeries(t, b.nb), I = tfMs(TFS[t]), o = originMs(v);
  for (let j = 1; j <= b.nb; j++) if (b.cnt[j - 1] === TFS[t].min) s.close[j] = b.C[j - 1];
  for (const r of rows) {
    const j = (r.bar - o) / I;
    if (!Number.isInteger(j) || j < 1 || j > b.nb) continue;
    s.ok[j] = 1; s.label[j] = r.label; s.conf[j] = r.conf; s.vol[j] = r.vol; s.calls++;
  }
  for (let j = 1; j <= b.nb; j++) if (s.ok[j]) s.age[j] = s.ok[j - 1] && s.label[j - 1] === s.label[j] ? s.age[j - 1] + 1 : 1;
  return s;
}

/**
 * The series A5 reads (registration §4.3): closes from W0 to the first close after W1 at which the label changes —
 * the close that ends the run crossing W1 — and none after it. That close carries a non-trending label different
 * from the one before it, so it ends the run and opens no run of its own; a run that has not ended within the
 * 14-bar look-ahead stays censored. Runs that start at or after W1 are therefore never counted. The closes after
 * W1 up to the cut stay in A5's sequence, so baseline (c)'s block shuffle and the reference `c` read them as well
 * (registration §3, §4.3: the look-ahead's uses, CH3 F10).
 */
export function truncateForRuns(s: Series, v: Venue): Series {
  const c: Series = { ...s, ok: s.ok.slice(), label: s.label.slice() };
  const min = s.tf.min, hiJ = Math.ceil(scoreWin(v).hi / min), lastJ = Math.ceil(gridWin(v, W1_MS, windowEndMs(s.tf)).hi / min) - 1;
  let cut = Math.min(lastJ, s.nb);
  for (let j = hiJ; j <= Math.min(lastJ, s.nb); j++) {
    if (!c.ok[j] || !c.ok[j - 1]) { cut = j - 1; break; }
    if (c.label[j] !== c.label[j - 1]) { c.label[j] = c.label[j - 1] === L_RANGING ? L_VOLATILE : L_RANGING; cut = j; break; }
  }
  for (let j = cut + 1; j <= s.nb; j++) c.ok[j] = 0;
  return c;
}

/** One venue's inputs: its coins (position = index), the served rows and the bars per coin × timeframe. */
export interface VenueData { venue: Venue; coins: string[]; series: Series[][]; bars: Array<Array<Bars | null>> }

export const t5Census = (coins: readonly string[], wTf: readonly number[]): Census => ({ panel: [...coins], wCoin: coins.map(() => 1 / coins.length), wTf: [...wTf] });

/** A4's rows: the labelled closes in [W0, W1) of every coin × timeframe, with their key-A phase. */
export interface A4Rows {
  n: number; pos: Int32Array; t: Int32Array; j: Int32Array; label: Uint8Array; conf: Uint8Array; dir: Uint8Array; phase: Uint8Array;
  w: Float64Array; cl: Int32Array; nCl: number; strata: Int32Array; dayCl: number;
  /** Row ranges of each coin × timeframe sequence, in time order, and their blocks (a block also ends at a hole). */
  seqs: Array<{ from: number; to: number; blocks: Blocks }>;
}

export function a4Rows(d: VenueData, keys: Array<Array<KeyA | null>>, census: Census): A4Rows {
  const win = scoreWin(d.venue);
  const acc = { pos: [] as number[], t: [] as number[], j: [] as number[], label: [] as number[], conf: [] as number[], dir: [] as number[], phase: [] as number[], w: [] as number[], cl: [] as number[] };
  const ids = new Map<number, number>(), strata: number[] = [], days = new Set<number>();
  const seqs: A4Rows['seqs'] = [];
  d.series.forEach((perTf, pos) => perTf.forEach((s, t) => {
    const from = acc.j.length, ka = keys[pos][t];
    for (let j = Math.max(1, Math.ceil(win.lo / s.tf.min)); j * s.tf.min < win.hi && j <= s.nb; j++) {
      if (!s.ok[j]) continue;
      const day = Math.floor((j * s.tf.min) / 1440), key = pos * 100_000 + day;
      let id = ids.get(key);
      if (id === undefined) { id = ids.size; ids.set(key, id); strata.push(pos); }
      days.add(day);
      acc.pos.push(pos); acc.t.push(t); acc.j.push(j); acc.label.push(s.label[j]); acc.conf.push(s.conf[j]);
      acc.dir.push(s.label[j] === L_UP ? 1 : s.label[j] === L_DOWN ? 2 : 0);
      acc.phase.push(ka ? ka.phase[j - 1] ?? 0 : 0);
      acc.w.push(census.wCoin[pos] * census.wTf[t]); acc.cl.push(id);
    }
    const to = acc.j.length;
    if (to > from) seqs.push({ from, to, blocks: blocksOf(to - from, (i) => acc.label[from + i], (i) => acc.j[from + i] !== acc.j[from + i - 1] + 1) });
  }));
  return { n: acc.j.length, pos: Int32Array.from(acc.pos), t: Int32Array.from(acc.t), j: Int32Array.from(acc.j), label: Uint8Array.from(acc.label),
    conf: Uint8Array.from(acc.conf), dir: Uint8Array.from(acc.dir), phase: Uint8Array.from(acc.phase), w: Float64Array.from(acc.w), cl: Int32Array.from(acc.cl),
    nCl: ids.size, strata: Int32Array.from(strata), dayCl: days.size, seqs };
}

/** T3's A4 statistic on these rows: `a4` reads nothing of its frame but the per-row phase. */
export const a4Stat = (r: A4Rows): Stat => a4({ phase: r.phase } as unknown as Frame, 'A4.S', r.dir, r.label);

export function accumulateRows(r: A4Rows, s: Stat): Acc {
  const m = s.m, sums = new Float64Array(r.nCl * m), cw = new Float64Array(r.nCl), tot = new Float64Array(m);
  let rows = 0;
  for (let i = 0; i < r.n; i++) if (s.add(i, i, r.w[i], sums, r.cl[i] * m)) { cw[r.cl[i]] += r.w[i]; rows++; }
  for (let c = 0; c < r.nCl; c++) for (let k = 0; k < m; k++) tot[k] += sums[c * m + k];
  const point = new Float64Array(s.names.length);
  s.evaluate(tot, 0, point, 0);
  let clusters = 0;
  for (let c = 0; c < r.nCl; c++) if (cw[c] > 0) clusters++;
  return { sums, cw, rows, clusters, tot, point };
}

/** Baseline (c) on bar closes: the runs of equal label of each coin × timeframe are permuted; phases and weights stay. */
function shufflesRows(r: A4Rows, s: Stat, B: number, seed: number): Float64Array {
  const rnd = mulberry32(seed), nOut = s.names.length, sh = new Float64Array(B * nOut).fill(NaN), tot = new Float64Array(s.m);
  const maxN = r.seqs.reduce((n, q) => Math.max(n, q.to - q.from), 0), order = new Int32Array(maxN), src = new Int32Array(maxN);
  for (let b = 0; b < B; b++) {
    tot.fill(0);
    for (const q of r.seqs) {
      shuffleBlocks(q.blocks, rnd, order, src);
      for (let i = 0; i < q.to - q.from; i++) s.add(q.from + src[i], q.from + i, r.w[q.from + i], tot, 0);
    }
    s.evaluate(tot, 0, sh, b * nOut);
  }
  return sh;
}

/** A Reading of `s` on the rows, as T3's `compute` builds it (bounds per output, Kish clusters, shuffle tail). */
export function readRows(r: A4Rows, s: Stat, o: { B: number; alpha: number; bootSeed: number; shuffleB: number; shuffleSeed: number }): Reading {
  const acc = accumulateRows(r, s), nOut = s.names.length;
  const ctx: Ctx = { nCl: r.nCl, clOf: r.cl, strata: r.strata, nStrata: r.strata.reduce((m, x) => Math.max(m, x + 1), 0), w: r.w };
  const reps = acc.rows > 0 && o.B > 0 ? bootstrap(ctx, s, acc, o.B, mulberry32(o.bootSeed)) : new Float64Array(0);
  const B = reps.length / nOut, lb = new Array<number>(nOut).fill(NaN), ub = new Array<number>(nOut).fill(NaN);
  const cols: number[][] = [], which: number[] = [];
  let undefinedReplicates = 0;
  for (let k = 0; k < nOut && B > 0; k++) {
    const col = Array.from({ length: B }, (_, b) => reps[b * nOut + k]), bad = col.filter((x) => !Number.isFinite(x)).length;
    if (k === 0) undefinedReplicates = bad;
    if (bad === 0) { cols.push(col); which.push(k); }
  }
  if (cols.length) boundsOf(cols, o.alpha).forEach(([lo, hi], i) => { lb[which[i]] = lo; ub[which[i]] = hi; });
  const sizes = Array.from(acc.cw).filter((x) => x > 0);
  const eff = sizes.length ? kishOf([sizes])[0] : 0;
  const shuffle = acc.rows > 0 && o.shuffleB > 0 ? tail(shufflesRows(r, s, o.shuffleB, o.shuffleSeed), nOut, acc.point[0]) : null;
  return { id: s.id, names: s.names, rows: acc.rows, clusters: acc.clusters, eff, point: Array.from(acc.point), lb, ub, alpha: o.alpha, B, undefinedReplicates, shuffle, reps };
}

/** The weighted minority share of a 0/1 column over the rows where `use` holds; NaN when no row. */
function minority(r: A4Rows, use: (i: number) => boolean, up: (i: number) => boolean): number {
  let W = 0, U = 0;
  for (let i = 0; i < r.n; i++) if (use(i)) { W += r.w[i]; if (up(i)) U += r.w[i]; }
  return W > 0 ? Math.min(U / W, 1 - U / W) : NaN;
}

export interface LabelFloors { a4TrendingRows: number; a4Eff: number; a5Runs: number; a5Eff: number; labelMinority: number; labelBound: number | null; dayClusters: number }

/**
 * A5's frame on one venue (registration §4.3): every kept coin's series cut by `truncateForRuns`, the window from W0
 * to the last look-ahead close, the venue's census. `close` maps a cut series to the one A5 reads.
 */
export function a5Frame(d: VenueData, census: Census, close: (s: Series) => Series = (s) => s): BarFrame {
  return { win: gridWin(d.venue, W0_MS, windowEndMs(TFS[2])), census, coins: d.series.map((perTf, pos) => ({ pos, series: perTf.map((s) => close(truncateForRuns(s, d.venue))) })) };
}

/** A series whose every labelled close has the price 1: T3's runs read from the labels alone, every bar taken as present. */
const labelPrices = (s: Series): Series => ({ ...s, close: Float64Array.from(s.close, (_, j) => (s.ok[j] ? 1 : NaN)) });

/**
 * Label-only floors, recorded before the seal (registration §5): A4's TRENDING closes (an upper bound on A4's rows,
 * which also need a dated phase) and the Kish-effective clusters of those closes; A5's runs (an upper bound: a run
 * whose bars are missing is censored at the read) and their effective clusters, by T3's own `runsOf` and `a5Eff`
 * with every bar taken as present; the label-direction minority share and its bound; and the day clusters. The
 * counts bound the read's; the effective clusters are a label-side estimate, not a bound — Kish's count is not
 * monotone in the rows (CH3 F12) — and the binding comparison with the floor is made at the read, before S4 and R5.
 */
export function labelFloors(d: VenueData, census: Census): LabelFloors {
  const none = d.series.map((perTf) => perTf.map(() => null));
  const r = a4Rows(d, none, census);
  const cw = new Map<number, number>();
  let trending = 0;
  for (let i = 0; i < r.n; i++) if (r.dir[i]) { trending++; cw.set(r.cl[i], (cw.get(r.cl[i]) ?? 0) + r.w[i]); }
  const f = a5Frame(d, census, labelPrices);
  const runs = runsOf(f.coins.flatMap((c) => c.series.map((s, t) => barSeq(s, f.win, c.pos, t, 0)))).runs.length;
  const lm = minority(r, (i) => r.dir[i] > 0, (i) => r.dir[i] === 1);
  return { a4TrendingRows: trending, a4Eff: cw.size ? kishOf([[...cw.values()]])[0] : 0, a5Runs: runs, a5Eff: a5Eff(f, 0), labelMinority: lm, labelBound: Number.isFinite(lm) ? attainableOf([lm])[0] : null, dayClusters: r.dayCl };
}

export interface VenueResult {
  venue: Venue; coins: number;
  A4: { state: T5State; cause: string; identifiable: boolean; phaseMinority: number; phaseBound: number | null; eff: number; reading: Omit<Reading, 'reps'> | null };
  A5: { state: T5State; cause: string; eff: number; reading: A5Reading | null };
  cluster_sensitive: { state: 'UNDEFINED'; dayClusters: number; needed: number };
  descriptive: { lag: Array<{ tf: string; turns: number; censored: number; median: number | null }>; flipflops: Array<{ tf: string; bars: number; changes: number; per1000: number | null }>; mono: unknown };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Lag of the key-A turns whose bar closes in [W0, W1) (registration §4.4): T3's `lagOf`, unmodified, on the turns from
 * the first such turn onward, less its reading on the turns from the first one at or after W1. The later turns are
 * the tail of the same list with the same censoring points, so the difference is exactly the window's turns. A
 * window turn's lag runs to the first close pointing the new way, which may be a close of the look-ahead, before the
 * next turn and inside key A's span (registration §4.4: the look-ahead's third use, CH3 F10).
 */
export function windowLags(ka: KeyA, s: Series, v: Venue): { turns: number; censored: number; lags: number[] } {
  const w = scoreWin(v), min = ka.tf.min, close = (i: number): number => (ka.bars[ka.turns.idx[i]] + 1) * min;
  const from = (lo: number): KeyA => {
    let i = 0;
    while (i < ka.turns.idx.length && close(i) < lo) i++;
    return { ...ka, turns: { ...ka.turns, idx: ka.turns.idx.slice(i), kind: ka.turns.kind.slice(i) } };
  };
  const all = lagOf(from(w.lo), s), late = lagOf(from(w.hi), s);
  return { turns: all.turns - late.turns, censored: all.censored - late.censored, lags: all.lags.slice(0, all.lags.length - late.lags.length) };
}

export interface ScoreOpts { B: number; shuffleB: number; permB: number; seeds: { a4Boot: number; a4Shuffle: number; a5Boot: number; a5Shuffle: number; mono: number }; floorClusters: number }

/** Flip-flops per timeframe on the closes in [W0, W1) only (registration §4.4): never the history or the look-ahead. */
export function flipflopsOf(d: VenueData): VenueResult['descriptive']['flipflops'] {
  return TFS.map((tf, t) => {
    let bars = 0, changes = 0, ff = 0;
    for (const perTf of d.series) { const x = flipFlops(perTf[t], scoreWin(d.venue)); bars += x.bars; changes += x.changes; ff += x.flipflops; }
    return { tf: tf.key, bars, changes, per1000: bars ? (1000 * ff) / bars : null };
  });
}

/** Kish-effective clusters of the rows a statistic reads (cluster weights over the rows its `add` keeps). */
const effOf = (acc: Acc): number => { const sizes = Array.from(acc.cw).filter((x) => x > 0); return sizes.length ? kishOf([sizes])[0] : 0; };
const tooFew = (floor: number): string => `fewer than ${floor} effective clusters`;

/**
 * Answers 4 and 5 of one venue (registration §4, §6). Each statistic's effective clusters are compared with the
 * floor BEFORE it is computed (CH3 F7): below it the state is INDETERMINATE, the reading is null and no bootstrap,
 * shuffle or permutation runs for it; the confidence-monotonicity permutation reads A4's rows and waits on the same.
 */
export function scoreVenue(d: VenueData, census: Census, o: ScoreOpts): VenueResult {
  const keys = d.bars.map((perTf) => perTf.map((b, t) => (b ? buildKeyA(b, TFS[t], keyWin(d.venue, TFS[t])) : null)));
  const r = a4Rows(d, keys, census);
  // identifiability (registration §4c): the phase mix and the label mix of A4's rows, before A4 is computed
  const dated = (i: number): boolean => r.dir[i] > 0 && r.phase[i] > 0;
  const pm = Math.min(minority(r, dated, (i) => r.phase[i] === 1), minority(r, dated, (i) => r.dir[i] === 1));
  const bound = Number.isFinite(pm) ? attainableOf([pm])[0] : null;
  const identifiable = bound !== null && bound >= FLOOR_PP;
  const stat = a4Stat(r), eff4 = effOf(accumulateRows(r, stat)), enough4 = eff4 >= o.floorClusters;
  let A4: VenueResult['A4'];
  if (!identifiable) {
    A4 = { state: 'INDETERMINATE', cause: 'NOT_IDENTIFIABLE', identifiable, phaseMinority: pm, phaseBound: bound, eff: eff4, reading: null };
  } else if (!enough4) {
    A4 = { state: 'INDETERMINATE', cause: tooFew(o.floorClusters), identifiable, phaseMinority: pm, phaseBound: bound, eff: eff4, reading: null };
  } else {
    const rd = readRows(r, stat, { B: o.B, alpha: ALPHA, bootSeed: o.seeds.a4Boot, shuffleB: o.shuffleB, shuffleSeed: o.seeds.a4Shuffle });
    const dec = fitState(evidenceOf('A4', rd, true), { F: FLOOR_PP, alpha: ALPHA, floorClusters: o.floorClusters });
    const { reps: _reps, ...reading } = rd;
    A4 = { state: stateOf(dec), cause: dec.cause, identifiable, phaseMinority: pm, phaseBound: bound, eff: eff4, reading };
  }
  const frame = a5Frame(d, census), eff5 = a5Eff(frame, 0);
  let A5: VenueResult['A5'];
  if (!(eff5 >= o.floorClusters)) {
    A5 = { state: 'INDETERMINATE', cause: tooFew(o.floorClusters), eff: eff5, reading: null };
  } else {
    const a5r = a5(frame, 'A5.S', 0, { B: o.B, alpha: ALPHA, bootSeed: o.seeds.a5Boot, shuffleB: o.shuffleB, shuffleSeed: o.seeds.a5Shuffle });
    const a5d = fitStateA5(a5r, { alpha: ALPHA, floorClusters: o.floorClusters });
    // a run with no reference in any shuffle leaves R5's clusters; below the floor there, too, the reading is withheld
    A5 = { state: stateOf(a5d), cause: a5d.cause, eff: a5r.eff, reading: a5d.cause === tooFew(o.floorClusters) ? null : a5r };
  }
  const lag = TFS.map((tf, t) => {
    let turns = 0, censored = 0;
    const lags: number[] = [];
    d.series.forEach((perTf, pos) => { const ka = keys[pos][t]; if (!ka) return; const x = windowLags(ka, perTf[t], d.venue); turns += x.turns; censored += x.censored; lags.push(...x.lags); });
    return { tf: tf.key, turns, censored, median: median(lags) };
  });
  const mi: number[] = [];
  for (let i = 0; i < r.n; i++) if (dated(i)) mi.push(i);
  const mono = mi.length && enough4 ? prims([{ op: 'perm', levels: mi.map((i) => confBin(r.conf[i])), wins: mi.map((i) => (r.dir[i] === r.phase[i] ? 1 : 0)), clusters: mi.map((i) => r.cl[i]), B: o.permB, seed: o.seeds.mono }])[0] : null;
  return {
    venue: d.venue, coins: d.coins.length, A4, A5,
    cluster_sensitive: { state: 'UNDEFINED', dayClusters: r.dayCl, needed: DAY_VARIANT_CLUSTERS_NEEDED },
    descriptive: { lag, flipflops: flipflopsOf(d), mono },
  };
}
