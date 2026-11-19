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
import { barSeq, type BarSeq, type Run } from '../regime-diag/bars.js';
import { L_RANGING, L_VOLATILE, MIN_MS, REGIME_AGAINST_MIN_CONFIDENCE, TFS, type Span, type Win } from '../regime-diag/diag-spec.js';
import type { Ctx } from '../regime-diag/engine.js';
import { N_TF, buildFrames, dayOf, isTrending, type Census, type CoinPart, type Frame, type FrameOpts, type Lab, type Loaded } from '../regime-diag/frame.js';
import { pairOf, sameDial, type Pair, type RunBy } from './paired-stats.js';
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

/** One chunk's frame: the pinned `buildFrames` on at most MAX_CHUNK coins. A larger chunk throws before any load. */
export function buildChunk(span: Span, win: Win, coins: readonly string[], wTf: readonly number[], load: (i: number) => Loaded, opts: FrameOpts): Frame {
  const why = chunkRefusal(coins.length);
  if (why) throw new Error(`regime-challenge r3: ${why}`);
  const census: Census = { panel: [...coins], wCoin: coins.map(() => 1), wTf: [...wTf] };
  return buildFrames(span, [win], census, load, opts)[0];
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
