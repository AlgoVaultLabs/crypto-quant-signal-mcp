// regime-challenge/challenge-r3-frame.ts — EDGE-REGIME-CHALLENGE-R3-W1 (T6, round 3): the alt panel's frame, clusters
// and weights, built on the pinned harness without editing it.
//
// Three things the pinned frame cannot say for round 3, said here:
//   1. More than 255 coins. The pinned frame's position index is one byte (`ePos: Uint8Array.from(...)`): a 256th
//      coin would wrap silently onto the first. So the frame is built in chunks of at most 255 coins — a chunk of 256
//      or more is refused, never built — and the chunks are merged here into one frame whose position index is wide.
//      Each chunk draws its entries under its own seed label (`<seed>|chunk-<k>`), so no two coins share a draw.
//   2. A panel that changes month by month. Every coin's entries are drawn over the whole window; an entry whose
//      coin is not in the panel in the entry's month takes no cluster and no weight.
//   3. Equal weights per coin-month and UTC-day clusters (ruling Q1). A row's weight is the census EXTERNAL lane's
//      timeframe weight over the number of panel coins that month; every coin on a UTC day sits in that day's one
//      cluster, all in one stratum. The coin × day variant exists only for the power gate's estimate of ρ (Q5).
// A5 reads each coin's per-closed-bar series inside its panel stints only (a stint: consecutive panel months), so no
// label sequence runs across a month the coin was out of the panel.
//
// Memory (review 1, F2). The pinned outcome table costs every entry 90 cell-sides × 33 B. So the outcomes are
// computed for the panel's entries only (an entry off the panel has no weight in any reading), and in batches of
// whole coins: each batch's rows are added, in the single pass's row order, into one set of cluster sums, and the
// readings are taken from those sums exactly as the pinned engine takes them. A5 reads the coins' bar series, not
// the outcome table, and is not batched. Between batches the collector runs (`collectGarbage`): measured, a batch's
// table let go but not yet collected keeps its memory, and several of them outgrow the budget.
import v8 from 'node:v8';
import vm from 'node:vm';
import { barSeq, type BarSeq, type Run } from '../regime-diag/bars.js';
import { L_RANGING, L_VOLATILE, MIN_MS, REGIME_AGAINST_MIN_CONFIDENCE, TFS, type Span, type Win } from '../regime-diag/diag-spec.js';
import { bootstrap, type Acc, type Ctx, type Stat } from '../regime-diag/engine.js';
import { N_TF, buildFrames, dayOf, isTrending, withOutcomes, type Census, type CoinPart, type Frame, type FrameOpts, type Lab, type Loaded } from '../regime-diag/frame.js';
import { boundsOf, kishOf } from '../regime-diag/prims.js';
import { mulberry32 } from '../regime-diag/rng.js';
import { a4, delta1 } from '../regime-diag/stats.js';
import { pairOf, pairedStat, sameDial, type Pair, type PairedOpts, type PairedReading, type RunBy } from './paired-stats.js';
import { C3_TF, SERVED_TF, type Candidate } from './challenge-spec.js';
import type { ChallengerCols } from './challenger-replay.js';

/** The most coins one pinned frame holds: its position index is one byte. */
export const MAX_CHUNK = 255;
/** Why a chunk of `n` coins may not be built, or null. */
export const chunkRefusal = (n: number): string | null =>
  (n > MAX_CHUNK ? `a chunk of ${n} coins: the pinned frame indexes positions in one byte, so a chunk holds at most ${MAX_CHUNK} coins and is never built with more` : null);

/** `xs` in chunks of `size` (at most MAX_CHUNK), in order. */
export function chunked<T>(xs: readonly T[], size = MAX_CHUNK): T[][] {
  const why = chunkRefusal(size);
  if (why || !(size >= 1)) throw new Error(`regime-challenge r3: ${why ?? 'a chunk holds at least one coin'}`);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * One chunk's frame: the pinned `buildFrames` on at most MAX_CHUNK coins, always bare (review 1, F6): outcomes are
 * computed later, for the panel's entries only, whatever the caller asks. A larger chunk throws before any load.
 */
export function buildChunk(span: Span, win: Win, coins: readonly string[], wTf: readonly number[], load: (i: number) => Loaded, opts: FrameOpts): Frame {
  const why = chunkRefusal(coins.length);
  if (why) throw new Error(`regime-challenge r3: ${why}`);
  const census: Census = { panel: [...coins], wCoin: coins.map(() => 1), wTf: [...wTf] };
  return buildFrames(span, [win], census, load, { ...opts, outcomes: false })[0];
}

type Typed = Uint8Array | Int32Array | Float64Array;
const ROW_FIELDS = ['has', 'phase', 'volLeg', 'adx', 'adxSlope', 'plusDI', 'minusDI', 'vol', 'slope', 'structure', 'age'] as const;
const LAB_FIELDS = ['S', 'B', 'B7', 'B28'] as const;
/** Every key of a bare frame, and how the merge treats it: the merge refuses a frame with a key it does not know. */
export const FRAME_KEYS: readonly string[] = Object.freeze(['win', 'span', 'census', 'outcomes', 'nE', 'ePos', 'eM', 'cells', ...ROW_FIELDS, ...LAB_FIELDS, 'drops', 'coins']);

function cat<T extends Typed>(parts: readonly T[], make: (n: number) => T): T {
  const out = make(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p as never, at); at += p.length; }
  return out;
}

/**
 * The chunks' bare frames as one frame over the whole coin list (`census`): entries and rows in chunk order, each
 * coin's position its index in `census.panel` (`off` + its index in its chunk), held in a 32-bit index.
 */
export function mergeFrames(parts: ReadonlyArray<{ f: Frame; off: number }>, census: Census): Frame {
  if (!parts.length) throw new Error('regime-challenge r3: no chunk to merge');
  for (const { f } of parts) {
    if (f.outcomes || f.cells) throw new Error('regime-challenge r3: the merge takes bare frames only');
    const unknown = Object.keys(f).filter((k) => !FRAME_KEYS.includes(k));
    if (unknown.length) throw new Error(`regime-challenge r3: the frame has keys the merge does not know: ${unknown.join(', ')}`);
  }
  const fs0 = parts.map((p) => p.f);
  const ePos = new Int32Array(fs0.reduce((n, f) => n + f.nE, 0));
  const coins: CoinPart[] = [];
  const drops: Record<string, number> = {};
  let e = 0;
  for (const { f, off } of parts) {
    for (let i = 0; i < f.nE; i++) ePos[e + i] = off + f.ePos[i];
    for (const c of f.coins) coins.push({ ...c, pos: off + c.pos, e0: e + c.e0, e1: e + c.e1 });
    for (const [k, v] of Object.entries(f.drops)) drops[k] = (drops[k] ?? 0) + v;
    e += f.nE;
  }
  const u8 = (n: number): Uint8Array => new Uint8Array(n), f64 = (n: number): Float64Array => new Float64Array(n), i32 = (n: number): Int32Array => new Int32Array(n);
  const rows = Object.fromEntries(ROW_FIELDS.map((k) => {
    const first = fs0[0][k] as Typed;
    const make = first instanceof Float64Array ? f64 : first instanceof Int32Array ? i32 : u8;
    return [k, cat(fs0.map((f) => f[k] as Typed), make as (n: number) => Typed)];
  }));
  const labs = Object.fromEntries(LAB_FIELDS.map((k) => [k, { lab: cat(fs0.map((f) => f[k].lab), u8), conf: cat(fs0.map((f) => f[k].conf), u8) } satisfies Lab]));
  return {
    win: fs0[0].win, span: fs0[0].span, census, outcomes: false, nE: ePos.length,
    // the frame's type says one byte; round 3's index is 32-bit, and every reader indexes it as a number
    ePos: ePos as unknown as Uint8Array, eM: cat(fs0.map((f) => f.eM), i32), cells: null,
    ...(rows as Pick<Frame, (typeof ROW_FIELDS)[number]>), ...(labs as Pick<Frame, (typeof LAB_FIELDS)[number]>),
    drops, coins,
  };
}

/** The frame of `coins` over `win`, built in chunks of at most `size` coins and merged. `load(pos)` takes the global index. */
export function chunkedFrame(span: Span, win: Win, coins: readonly string[], wTf: readonly number[], load: (pos: number) => Loaded, opts: FrameOpts, size = MAX_CHUNK): Frame {
  const census: Census = { panel: [...coins], wCoin: coins.map(() => 1), wTf: [...wTf] };
  const parts = chunked(coins.map((_, i) => i), size).map((idx, k) => ({
    off: idx[0], f: buildChunk(span, win, idx.map((i) => coins[i]), wTf, (i) => load(idx[i]), { ...opts, seed: `${opts.seed}|chunk-${k}` }),
  }));
  return mergeFrames(parts, census);
}

// ── the panel, its clusters and its weights ───────────────────────────────────────────────────────────────────────

/** Per month, the positions (indexes into the frame's coins) in the panel, and the month's design panel size. */
export interface PanelMonths { readonly [ym: string]: { readonly pos: ReadonlySet<number>; readonly n: number } }
const monthAt = (span: Span, m: number): string => new Date(span.t0Ms + m * MIN_MS).toISOString().slice(0, 7);
const minuteOf = (span: Span, ym: string): number => (Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1) - span.t0Ms) / MIN_MS;
const nextYm = (ym: string): string => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1)).toISOString().slice(0, 7);

/**
 * Round 3's context: `day` — every panel entry of a UTC day in that day's cluster, one stratum (ruling Q1); `coinday`
 * — round 1's coin × UTC-day clusters, stratified by coin (for the gate's estimate of ρ only). A row's weight is its
 * timeframe's census weight over the month's panel size; an entry out of the panel that month has no cluster (−1)
 * and weight 0. Cluster ids are given in entry order, as the pinned `context` gives them.
 */
export function r3Context(f: Frame, panel: PanelMonths, variant: 'day' | 'coinday'): Ctx {
  const ids = new Map<number, number>();
  const strata: number[] = [];
  const clOf = new Int32Array(f.nE);
  const w = new Float64Array(f.nE * N_TF);
  for (let e = 0; e < f.nE; e++) {
    const pos = f.ePos[e], ym = monthAt(f.span, f.eM[e]), p = panel[ym];
    if (!p || !p.pos.has(pos)) { clOf[e] = -1; continue; }
    const day = dayOf(f.eM[e]), key = variant === 'day' ? day : pos * 100_000 + day;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); strata.push(variant === 'day' ? 0 : pos); }
    clOf[e] = id;
    for (let t = 0; t < N_TF; t++) w[e * N_TF + t] = f.census.wTf[t] / p.n;
  }
  return { nCl: ids.size, clOf, strata: Int32Array.from(strata), nStrata: variant === 'day' ? 1 : f.census.panel.length, w };
}

/** A5's runs under round 3: the weight of the run's first close's month and timeframe, its UTC day as the cluster, one stratum. */
export function a5By(f: Frame, panel: PanelMonths): RunBy {
  const at = (r: Run): number => r.j0 * TFS[r.t].min;
  return {
    weight: (r) => { const p = panel[monthAt(f.span, at(r))]; return p && p.pos.has(r.pos) ? f.census.wTf[r.t] / p.n : 0; },
    key: (r) => dayOf(at(r)),
    stratum: () => 0,
  };
}

/** A coin's consecutive panel months, as grid minutes [lo, hi) inside the frame's window. */
export interface Stint { pos: number; lo: number; hi: number }
export function stintsOf(f: Frame, panel: PanelMonths): Stint[] {
  const yms = Object.keys(panel).sort();
  const out: Stint[] = [];
  for (const c of f.coins) {
    let open: string | null = null, last = '';
    const close = (): void => {
      if (open === null) return;
      const lo = Math.max(f.win.lo, minuteOf(f.span, open)), hi = Math.min(f.win.hi, minuteOf(f.span, nextYm(last)));
      if (hi > lo) out.push({ pos: c.pos, lo, hi });
      open = null;
    };
    for (const ym of yms) {
      const inside = panel[ym].pos.has(c.pos);
      if (inside && open !== null && ym !== nextYm(last)) close();
      if (inside) { if (open === null) open = ym; last = ym; } else close();
    }
    close();
  }
  return out;
}

/**
 * Round 3's pair of a candidate: `pairOf`'s rows and labels, with each arm's per-closed-bar sequences read inside the
 * coin's stints only (the same construction as `pairOf`, on each stint's window in place of the frame's).
 */
export function r3Pair(f: Frame, cand: Candidate, cols: ChallengerCols | null, stints: readonly Stint[]): Pair {
  const p = pairOf(f, cand, cols);
  const idx = new Map(f.coins.map((c, i) => [c.pos, i]));
  const winOf = (s: Stint): Win => ({ ...f.win, lo: s.lo, hi: s.hi });
  const each = (fn: (c: CoinPart, i: number, w: Win) => BarSeq[]): BarSeq[] => stints.flatMap((s) => { const i = idx.get(s.pos); return i === undefined ? [] : fn(f.coins[i], i, winOf(s)); });
  if (cand.arm) {
    const seqs = each((c, _i, w) => c.series.map((s, t) => barSeq(s, w, c.pos, t, 0)));
    return { ...p, chalSeqs: seqs, servSeqs: seqs };
  }
  if (cand.dial) {
    const dial = cand.dial, d = (cols as ChallengerCols).dials.findIndex((x) => sameDial(x, dial));
    return {
      ...p,
      chalSeqs: each((c, i, w) => (cols as ChallengerCols).series[d][i].map((s, t) => barSeq(s, w, c.pos, t, 0))),
      servSeqs: each((c, _i, w) => c.series.map((s, t) => barSeq(s, w, c.pos, t, 0))),
    };
  }
  return {
    ...p,
    chalSeqs: each((c, _i, w) => [barSeq(c.series[C3_TF], w, c.pos, C3_TF, 0)]),
    servSeqs: each((c, _i, w) => [barSeq(c.series[SERVED_TF], w, c.pos, SERVED_TF, 0)]),
  };
}

// ── the label-free strata tables (counts only) ──────────────────────────────────────────────────────────────────────

export interface StrataRow { coins: number; entries: number; rows: number[]; trending: number[]; trending60: number[]; ranging: number[]; volatile: number[] }
/**
 * Per month of the panel, label-free: the panel coins with an entry, the panel entries, and per timeframe the rows with
 * a served label, TRENDING, TRENDING at confidence ≥ 60, RANGING and VOLATILE. No outcome is read.
 */
export function strataOf(f: Frame, panel: PanelMonths): Record<string, StrataRow> {
  const out: Record<string, StrataRow> = {};
  const seen = new Map<string, Set<number>>();
  const zero = (): number[] => TFS.map(() => 0);
  for (const ym of Object.keys(panel).sort()) { out[ym] = { coins: 0, entries: 0, rows: zero(), trending: zero(), trending60: zero(), ranging: zero(), volatile: zero() }; seen.set(ym, new Set()); }
  for (let e = 0; e < f.nE; e++) {
    const ym = monthAt(f.span, f.eM[e]), p = panel[ym], pos = f.ePos[e];
    if (!p || !p.pos.has(pos)) continue;
    const row = out[ym];
    row.entries++; (seen.get(ym) as Set<number>).add(pos);
    for (let t = 0; t < N_TF; t++) {
      const r = e * N_TF + t;
      if (!f.has[r]) continue;
      const lab = f.S.lab[r], conf = f.S.conf[r];
      row.rows[t]++;
      if (isTrending(lab)) { row.trending[t]++; if (conf >= REGIME_AGAINST_MIN_CONFIDENCE) row.trending60[t]++; }
      if (lab === L_RANGING) row.ranging[t]++;
      if (lab === L_VOLATILE) row.volatile[t]++;
    }
  }
  for (const [ym, s] of seen) out[ym].coins = s.size;
  return out;
}

// ── the panel's entries, in batches (review 1, F2) ─────────────────────────────────────────────────────────────────

function knownBare(f: Frame): void {
  if (f.outcomes || f.cells) throw new Error('regime-challenge r3: a bare frame only');
  const unknown = Object.keys(f).filter((k) => !FRAME_KEYS.includes(k));
  if (unknown.length) throw new Error(`regime-challenge r3: the frame has keys this module does not know: ${unknown.join(', ')}`);
}

/** The bare frame of the entries `idx` (ascending): rows, labels, positions and months; every coin kept, re-indexed. */
function pick(f: Frame, idx: Int32Array, pre: (e: number) => number): Frame {
  knownBare(f);
  const n = idx.length;
  const ePos = new Int32Array(n), eM = new Int32Array(n);
  for (let i = 0; i < n; i++) { ePos[i] = f.ePos[idx[i]]; eM[i] = f.eM[idx[i]]; }
  const rowsOf = <T extends Typed>(src: T): T => {
    const out = new (src.constructor as new (k: number) => T)(n * N_TF);
    for (let i = 0; i < n; i++) for (let t = 0; t < N_TF; t++) out[i * N_TF + t] = src[idx[i] * N_TF + t];
    return out;
  };
  const rows = Object.fromEntries(ROW_FIELDS.map((k) => [k, rowsOf(f[k] as Typed)]));
  const labs = Object.fromEntries(LAB_FIELDS.map((k) => [k, { lab: rowsOf(f[k].lab), conf: rowsOf(f[k].conf) } satisfies Lab]));
  return {
    win: f.win, span: f.span, census: f.census, outcomes: false, nE: n, ePos: ePos as unknown as Uint8Array, eM, cells: null,
    ...(rows as Pick<Frame, (typeof ROW_FIELDS)[number]>), ...(labs as Pick<Frame, (typeof LAB_FIELDS)[number]>),
    drops: f.drops, coins: f.coins.map((c) => ({ ...c, e0: pre(c.e0), e1: pre(c.e1) })),
  };
}

/**
 * The panel's entries only (review 1, F2a): an entry whose coin is out of the panel in the entry's month has no
 * cluster and no weight in any reading, so it is dropped before any outcome is computed. Every coin is kept with its
 * bar series (A5 and the challenger columns read the same coins); a coin's entries stay in time order.
 */
export function panelFrame(f: Frame, panel: PanelMonths): Frame {
  const prefix = new Int32Array(f.nE + 1), keep: number[] = [];
  for (let e = 0; e < f.nE; e++) {
    const p = panel[monthAt(f.span, f.eM[e])], on = !!p && p.pos.has(f.ePos[e]);
    if (on) keep.push(e);
    prefix[e + 1] = prefix[e] + (on ? 1 : 0);
  }
  return pick(f, Int32Array.from(keep), (e) => prefix[e]);
}

/** A batch: the coins [c0, c1) of a frame and their entries [e0, e1). */
export interface Batch { c0: number; c1: number; e0: number; e1: number }
/**
 * The frame's coins in batches, in order, each of at most `maxEntries` entries; a coin is never split, so a coin with
 * more entries than that is a batch of its own. The coins' entries must be contiguous and in coin order.
 */
export function entryBatches(f: Frame, maxEntries: number): Batch[] {
  if (!(maxEntries >= 1)) throw new Error('regime-challenge r3: a batch holds at least one entry');
  let at = 0;
  for (const c of f.coins) { if (c.e0 !== at || c.e1 < c.e0) throw new Error('regime-challenge r3: the coins\' entries are not contiguous in coin order'); at = c.e1; }
  if (at !== f.nE) throw new Error('regime-challenge r3: the coins do not hold every entry');
  const out: Batch[] = [];
  let c0 = 0;
  for (let c = 0; c < f.coins.length; c++) {
    const e0 = f.coins[c0].e0, e1 = f.coins[c].e1;
    if (c > c0 && e1 - e0 > maxEntries) { out.push({ c0, c1: c, e0, e1: f.coins[c - 1].e1 }); c0 = c; }
  }
  if (f.coins.length) out.push({ c0, c1: f.coins.length, e0: f.coins[c0].e0, e1: f.nE });
  return out.length ? out : [{ c0: 0, c1: 0, e0: 0, e1: 0 }];
}

/** The bare frame of one batch's entries (every coin kept; those outside the batch hold none). */
export function sliceFrame(f: Frame, b: Batch): Frame {
  const idx = new Int32Array(b.e1 - b.e0);
  for (let i = 0; i < idx.length; i++) idx[i] = b.e0 + i;
  return pick(f, idx, (e) => Math.min(Math.max(e, b.e0), b.e1) - b.e0);
}
/** The batch's part of a context: its entries' clusters and its rows' weights; the clusters and strata are the whole frame's. */
export const sliceCtx = (ctx: Ctx, b: Batch): Ctx => ({ nCl: ctx.nCl, clOf: ctx.clOf.subarray(b.e0, b.e1), strata: ctx.strata, nStrata: ctx.nStrata, w: ctx.w.subarray(b.e0 * N_TF, b.e1 * N_TF) });
/** The batch's part of a pair: its rows of each arm (the bar sequences are the coins', and A5 reads them unbatched). */
export function slicePair(p: Pair, b: Batch): Pair {
  const r0 = b.e0 * N_TF, r1 = b.e1 * N_TF, lab = (l: Lab): Lab => ({ lab: l.lab.subarray(r0, r1), conf: l.conf.subarray(r0, r1) });
  return {
    ...p, chal60: p.chal60.subarray(r0, r1), serv60: p.serv60.subarray(r0, r1), chalAny: p.chalAny.subarray(r0, r1), servAny: p.servAny.subarray(r0, r1),
    chalRows: p.chalRows.subarray(r0, r1), servRows: p.servRows.subarray(r0, r1), chalLab: lab(p.chalLab), servLab: lab(p.servLab),
  };
}

let gcFn: (() => void) | null | undefined;
/**
 * Runs a full collection now, so the arrays a finished step let go are freed before the next step allocates; false
 * when the runtime gives no collector (then nothing is forced). The flag is set on first use, never at import.
 */
export function collectGarbage(): boolean {
  if (gcFn === undefined) {
    try { v8.setFlagsFromString('--expose-gc'); const g = vm.runInNewContext('gc') as unknown; gcFn = typeof g === 'function' ? (g as () => void) : null; } catch { gcFn = null; }
  }
  if (!gcFn) return false;
  gcFn();
  return true;
}

/** One outcome reading: ΔΔ1 or A4 of a pair, under a context, with its bootstrap options; `key` names it in the result map. */
export interface ReadSpec { key: string; kind: 'ddelta1' | 'a4'; ctx: Ctx; pair: Pair; o: PairedOpts }
/** The statistic `deltaDelta1` / `a4Difference` read, on the frame `fo` and the pair's rows of it. */
function statOf(fo: Frame, p: Pair, kind: ReadSpec['kind'], id: string, arms: boolean): Stat {
  return kind === 'ddelta1'
    ? pairedStat(`${id}.ddelta1`, delta1(fo, 'challenger', p.chal60, p.chalLab.lab), delta1(fo, 'served', p.serv60, p.servLab.lab), arms)
    : pairedStat(`${id}.a4`, a4(fo, 'challenger', p.chalAny, p.chalLab.lab), a4(fo, 'served', p.servAny, p.servLab.lab), arms);
}

/**
 * Every spec's reading with the outcomes computed one batch of coins at a time (`entryBatches(f, maxEntries)`), so no
 * more than one batch's outcome table is alive. Each batch's rows are added into the spec's one set of cluster sums
 * in the single pass's row order (the pinned `accumulate`'s loop, continued across batches), and the reading is the
 * pinned `compute`'s, from those sums: the result is the single pass's, bit for bit.
 */
export function batchedReadings(f: Frame, load: (pos: number) => Loaded, specs: readonly ReadSpec[], maxEntries: number): Map<string, PairedReading> {
  const st = specs.map(() => ({ sums: null as Float64Array | null, cw: null as Float64Array | null, rows: 0, s: null as Stat | null }));
  for (const b of entryBatches(f, maxEntries)) {
    collectGarbage();
    const fo = withOutcomes(sliceFrame(f, b), load);
    specs.forEach((spec, i) => {
      const x = st[i], s = statOf(fo, slicePair(spec.pair, b), spec.kind, spec.pair.id, spec.o.arms), ctx = sliceCtx(spec.ctx, b);
      x.sums ??= new Float64Array(spec.ctx.nCl * s.m);
      x.cw ??= new Float64Array(spec.ctx.nCl);
      for (let r = 0; r < fo.has.length; r++) {
        if (!fo.has[r]) continue;
        const cl = ctx.clOf[Math.floor(r / N_TF)];
        if (cl < 0) continue;
        if (s.add(r, r, ctx.w[r], x.sums, cl * s.m)) { x.cw[cl] += ctx.w[r]; x.rows++; }
      }
      x.s = s;
    });
  }
  collectGarbage();
  const out = new Map<string, PairedReading>();
  specs.forEach((spec, i) => {
    const { sums, cw, rows, s } = st[i] as { sums: Float64Array; cw: Float64Array; rows: number; s: Stat };
    const tot = new Float64Array(s.m);
    let clusters = 0;
    for (let c = 0; c < spec.ctx.nCl; c++) {
      if (!(cw[c] > 0)) continue;
      clusters++;
      for (let k = 0; k < s.m; k++) tot[k] += sums[c * s.m + k];
    }
    const point = new Float64Array(s.names.length).fill(NaN);
    if (rows > 0) s.evaluate(tot, 0, point, 0);
    out.set(spec.key, readingOf({ sums, cw, rows, clusters, tot, point }, spec.ctx, s, spec.o));
  });
  return out;
}

/** The pinned `compute` from an accumulation (no shuffle), as `paired-stats` projects it to a paired reading. */
function readingOf(acc: Acc, ctx: Ctx, s: Stat, o: PairedOpts): PairedReading {
  const nOut = s.names.length;
  const reps = acc.rows > 0 && o.B > 0 ? bootstrap(ctx, s, acc, o.B, mulberry32(o.seed)) : new Float64Array(0);
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
  const point = Array.from(acc.point), first: number[] = [];
  for (let b = 0; b < B; b++) first.push(reps[b * nOut]);
  return { point: point[0], lb: lb[0], ub: ub[0], alpha: o.alpha, rows: acc.rows, clusters: acc.clusters, eff, B, undefinedReplicates, arms: nOut === 3 ? { challenger: point[1], served: point[2] } : null, reps: first };
}
