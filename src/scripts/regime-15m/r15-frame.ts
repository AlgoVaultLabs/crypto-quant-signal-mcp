// regime-15m/r15-frame.ts — EDGE-REGIME-15M-BACKTEST-W1: the 15m rows beside T3's (item 1–2).
//
// T3's fit frame (1h, 4h, 1d) is built by T3's `buildFrames`, unchanged, on T3's grid, entries, seed and census.
// This module adds 15m from the same grids with T3's own building blocks — `aggregate`, `buildSeries`, `served`,
// `buildKeyA`, `phaseAt`, `keyBAt` — called with the 15m timeframe `TF15` (window `REGIME_15M_WINDOW_BARS`):
//   - per coin: the per-closed-bar series and key A over 15m bars;
//   - per T3 entry: the served 15m label (the window ending at the entry, closed-candle basis, as T3 §4.1 calls the
//     core), key A's phase at the entry's last closed 15m bar, and key B's label 14 bars later.
// It then lays rows out as VIEWS: frames whose first two row slots hold two of the four timeframes, so T3's engine
// and statistics read a 15m row exactly as they read a T3 row. A row's weight is its coin's census weight times its
// timeframe's census weight (T3 §4.5); 15m has no census weight, so its factor is 1. A per-timeframe statistic is a
// ratio of sums over one timeframe's rows, so that constant factor cancels in it.
import { aggregate, noGap, type Grid } from '../regime-diag/archive.js';
import { NO_LABEL, type Span, type Win } from '../regime-diag/diag-spec.js';
import { N_TF, buildFrames, type Census, type CoinPart, type Frame, type Lab, type Loaded } from '../regime-diag/frame.js';
import { PHASE_NONE, buildKeyA, keyBAt, phaseAt, type KeyA } from '../regime-diag/keys.js';
import { buildSeries, quietly, served, type Series } from '../regime-diag/replay.js';
import { STUDY_SEED, TF15, asT3Tf, type Tf4 } from './r15-spec.js';

/** The 15m part of a frame: one row per T3 entry, and every coin's 15m series and key A, in the frame's coin order. */
export interface Rows15 {
  has: Uint8Array; S: Lab; B: Lab; phase: Uint8Array;
  coins: Array<{ pos: number; series: Series; keyA: KeyA }>;
  drops: Record<string, number>;
}
const newLab = (n: number): Lab => ({ lab: new Uint8Array(n).fill(NO_LABEL), conf: new Uint8Array(n) });

/** T3's frame of one window, label-only: T3's `buildFrames` with T3's seed label (the entries are T3's entries). */
export function frameOf(span: Span, win: Win, census: Census, load: (pos: number) => Loaded, log?: (line: string) => void): Frame {
  return buildFrames(span, [win], census, load, { outcomes: false, seed: STUDY_SEED, log })[0];
}

/**
 * The 15m rows of a frame. Each coin's grid is loaded again (the frame keeps none). A 15m row exists when the 1 m
 * grid is unbroken over the window's 100 bars before the entry and the core answers (T3's `has` rule at 15m).
 */
export function build15(f: Frame, load: (pos: number) => Loaded, log?: (line: string) => void): Rows15 {
  const tf = asT3Tf(TF15), n = f.nE;
  const r: Rows15 = { has: new Uint8Array(n), S: newLab(n), B: newLab(n), phase: new Uint8Array(n), coins: [], drops: {} };
  const inc = (k: string): void => { r.drops[k] = (r.drops[k] ?? 0) + 1; };
  for (const c of f.coins) {
    const { g } = load(c.pos);
    if (!g) throw new Error(`regime-15m: position ${c.pos + 1} has no grid now, and had one when the frame was built`);
    const coin = f.census.panel[c.pos], b = aggregate(g, TF15.min);
    const series = quietly(() => buildSeries(g, b, tf, coin));
    const keyA = buildKeyA(b, tf, f.win);
    quietly(() => {
      for (let e = c.e0; e < c.e1; e++) {
        const m = f.eM[e];
        if (!noGap(g, m - TF15.n * TF15.min, m)) { inc('no_15m_history'); continue; }
        let s;
        try { s = served(g, b, tf, m, coin); } catch { inc('core_refusal_15m'); continue; }
        r.has[e] = 1; r.S.lab[e] = s.label; r.S.conf[e] = s.confidence;
        const kb = keyBAt(g, b, tf, f.win, m, coin);
        if (kb) { r.B.lab[e] = kb.label; r.B.conf[e] = kb.confidence; } else inc('key_b_beyond_window_15m');
        r.phase[e] = phaseAt(keyA, m);
        if (r.phase[e] === PHASE_NONE) inc('undated_15m');
      }
    });
    r.coins.push({ pos: c.pos, series, keyA });
    log?.(`P${String(c.pos + 1).padStart(2, '0')} 15m: ${series.calls} closes, ${c.e1 - c.e0} entries`);
  }
  return r;
}

/** T3's row slot of a T3 timeframe; -1 for 15m. */
export const t3Slot = (k: Tf4['key']): number => ({ '15m': -1, '1h': 0, '4h': 1, '1d': 2 })[k];

/** Per entry: 1 when the entry has a served label at all four timeframes — the comparison rows (item 4, "the same rows"). */
export function comparisonRows(f: Frame, r: Rows15): Uint8Array {
  const keep = new Uint8Array(f.nE);
  for (let e = 0; e < f.nE; e++) keep[e] = r.has[e] && f.has[e * N_TF] && f.has[e * N_TF + 1] && f.has[e * N_TF + 2] ? 1 : 0;
  return keep;
}

/**
 * A view: a frame of the same entries, clusters and outcome table whose row slot 0 holds timeframe `a` and slot 1
 * timeframe `b` (slot 2 is empty), each only on the entries `keep` marks. A T3 timeframe's rows are copied from the
 * frame with its own census weight, so a statistic on them is the frame's own, bit for bit; 15m's weight factor is 1.
 */
export function viewOf(f: Frame, r: Rows15, a: Tf4['key'], b: Tf4['key'] | null, keep: Uint8Array): Frame {
  const rows = f.nE * N_TF;
  const has = new Uint8Array(rows), S = newLab(rows), B = newLab(rows), phase = new Uint8Array(rows);
  const nan = (): Float64Array => new Float64Array(rows).fill(NaN);
  const wTf = [1, 1, 1];
  [a, b].forEach((k, slot) => {
    if (k === null) return;
    const t = t3Slot(k);
    wTf[slot] = t < 0 ? 1 : f.census.wTf[t];
    for (let e = 0; e < f.nE; e++) {
      if (!keep[e]) continue;
      const to = e * N_TF + slot;
      if (t < 0) {
        if (!r.has[e]) continue;
        has[to] = 1; S.lab[to] = r.S.lab[e]; S.conf[to] = r.S.conf[e]; B.lab[to] = r.B.lab[e]; B.conf[to] = r.B.conf[e]; phase[to] = r.phase[e];
      } else {
        const from = e * N_TF + t;
        if (!f.has[from]) continue;
        has[to] = 1; S.lab[to] = f.S.lab[from]; S.conf[to] = f.S.conf[from]; B.lab[to] = f.B.lab[from]; B.conf[to] = f.B.conf[from]; phase[to] = f.phase[from];
      }
    }
  });
  const census: Census = { panel: f.census.panel, wCoin: f.census.wCoin, wTf };
  return {
    win: f.win, span: f.span, census, outcomes: f.outcomes, nE: f.nE, ePos: f.ePos, eM: f.eM, cells: f.cells,
    has, S, B, B7: newLab(rows), B28: newLab(rows), phase, volLeg: nan(), adx: nan(), adxSlope: nan(), plusDI: nan(), minusDI: nan(), vol: nan(),
    slope: new Uint8Array(rows), structure: new Uint8Array(rows), age: new Int32Array(rows), drops: f.drops, coins: f.coins as CoinPart[],
  };
}

/** The per-closed-bar series and key A of every coin at one timeframe: T3's for its three, this module's for 15m. */
export function barsAt(f: Frame, r: Rows15, k: Tf4['key']): Array<{ pos: number; series: Series; keyA: KeyA }> {
  const t = t3Slot(k);
  return t < 0 ? r.coins : f.coins.map((c) => ({ pos: c.pos, series: c.series[t], keyA: c.keyA[t] }));
}

/** The bytes a frame's arrays hold (per entry and per bar), for the memory plan. */
export function frameBytes(f: Frame): number {
  const view = (x: unknown): number => (ArrayBuffer.isView(x) ? x.byteLength : 0);
  let n = 0;
  for (const v of Object.values(f)) n += view(v);
  for (const k of ['S', 'B', 'B7', 'B28'] as const) n += view(f[k].lab) + view(f[k].conf);
  for (const c of f.coins) for (const part of [...c.series, ...c.keyA]) for (const v of Object.values(part as object)) n += view(v);
  return n;
}

/** The grid of a coin, or null: the loaders' common type. */
export type GridLoad = (pos: number) => Grid | null;
