// regime-diag/labeler.ts — EDGE-REGIME-DIAG-W1: the entry draw (§4.2), the 1 m path label (§4.4) and the
// baselines (a) and (b) of every entry × cell × side (§4.7). Labels come from the path only; no PnL anywhere.
import { noEdgeOdds } from '../../lib/pre-trade-calc.js';
import { noGap, type Grid } from './archive.js';
import { MUTATE } from './mutate.js';
import { rngFor, sampleWithoutReplacement } from './rng.js';
import { ENTRIES_PER_DAY, FEE_PCT, HISTORY_MIN, HOLDS_H, N_CS, N_HOLDS, N_SHAPES, PATH_MIN, SHAPES, cellOf, csOf, type Win } from './diag-spec.js';

/** §4.2: the 1 m opens of a window with 10,080 unbroken minutes of history, an unbroken 72 h path, and t + 72 h inside the window. */
export function eligibleMinutes(g: Grid, win: Win): Int32Array {
  const out: number[] = [];
  for (let m = win.lo; m + PATH_MIN <= win.hi; m++) if (noGap(g, m - HISTORY_MIN, m + PATH_MIN)) out.push(m);
  return Int32Array.from(out);
}

/** §4.2: one seeded draw per window × position — 24 entries per eligible coin-day, uniform, without replacement. `seed` is the study's label. */
export function drawEntries(g: Grid, win: Win, pos: string, seed: string): { eligible: number; picks: Int32Array } {
  const e = eligibleMinutes(g, win);
  const n = Math.round((ENTRIES_PER_DAY * e.length) / 1440);
  return { eligible: e.length, picks: sampleWithoutReplacement(e, n, rngFor(`${seed}|${win.name}|${pos}`)) };
}

export const OUT_TIMEOUT = 0;
export const OUT_TARGET = 1;
export const OUT_STOP = 2;
/** The deciding bar touches both barriers: excluded and counted (`both_touch`). */
export const OUT_BOTH = 3;
/** A null in the odds: dropped and counted (`null_odds`). */
export const OUT_NULL = 4;

/** Per entry, 90 cell-sides: the path label, and the four baseline values. */
export interface CellTable { n: number; out: Uint8Array; aT: Float64Array; aS: Float64Array; bT: Float64Array; bS: Float64Array }
export const newCellTable = (n: number): CellTable =>
  ({ n, out: new Uint8Array(n * N_CS), aT: new Float64Array(n * N_CS), aS: new Float64Array(n * N_CS), bT: new Float64Array(n * N_CS), bS: new Float64Array(n * N_CS) });

export function countOutcomes(t: CellTable): number[] {
  const c = [0, 0, 0, 0, 0];
  for (let i = 0; i < t.out.length; i++) c[t.out[i]]++;
  return c;
}

const HOLD_BARS = HOLDS_H.map((h) => Math.round(h * 60));
// Distinct barrier distances of one entry: the fixed percentages, then per hold the sigma multiples.
const FIXED = [...new Set(SHAPES.filter((s) => !s.sigma).flatMap((s) => [s.stop, s.target]))].sort((a, b) => a - b);
const MULTS = [...new Set(SHAPES.filter((s) => s.sigma).flatMap((s) => [s.stop, s.target]))].sort((a, b) => a - b);
const N_SLOTS = FIXED.length + N_HOLDS * MULTS.length;
const slotOf = (shape: number, hold: number, which: 'stop' | 'target'): number => {
  const s = SHAPES[shape];
  return s.sigma ? FIXED.length + hold * MULTS.length + MULTS.indexOf(s[which]) : FIXED.indexOf(s[which]);
};
const STOP_SLOT = new Int32Array(N_SHAPES * N_HOLDS);
const TARGET_SLOT = new Int32Array(N_SHAPES * N_HOLDS);
for (let s = 0; s < N_SHAPES; s++) for (let h = 0; h < N_HOLDS; h++) { STOP_SLOT[cellOf(s, h)] = slotOf(s, h, 'stop'); TARGET_SLOT[cellOf(s, h)] = slotOf(s, h, 'target'); }

const frac = new Float64Array(N_SLOTS);
const order = new Int32Array(N_SLOTS);
const upAt = new Int32Array(N_SLOTS);
const dnAt = new Int32Array(N_SLOTS);

/**
 * One entry at grid minute `m` into row `e` of the table. The path is the 1 m bars from `m` to the end of the
 * hold; the first bar whose high reaches the upper barrier or whose low reaches the lower one decides.
 */
export function labelEntry(g: Grid, m: number, sigma1h: number | null, t: CellTable, e: number): void {
  const off = e * N_CS;
  const P = g.O[m];
  const sigmaOk = sigma1h !== null && Number.isFinite(sigma1h) && sigma1h > 0;
  for (let i = 0; i < FIXED.length; i++) frac[i] = FIXED[i] / 100;
  for (let h = 0; h < N_HOLDS; h++) {
    // without a sigma the sigma brackets have no barrier (distance 0, never scanned) and no odds
    for (let k = 0; k < MULTS.length; k++) frac[FIXED.length + h * MULTS.length + k] = sigmaOk ? (MULTS[k] * (sigma1h * Math.sqrt(HOLDS_H[h]) * 100)) / 100 : 0;
  }
  // first touch of every distance, above and below, in one pass over the 72 h path (nearest barrier first)
  for (let i = 0; i < N_SLOTS; i++) order[i] = i;
  order.sort((a, b) => frac[a] - frac[b]);
  upAt.fill(-1); dnAt.fill(-1);
  let iu = 0, id = 0;
  while (iu < N_SLOTS && !(frac[order[iu]] > 0)) iu++;
  id = iu;
  for (let i = 0; i < PATH_MIN && (iu < N_SLOTS || id < N_SLOTS); i++) {
    const hi = g.H[m + i], lo = g.L[m + i];
    while (iu < N_SLOTS && hi >= P * (1 + frac[order[iu]])) upAt[order[iu++]] = i;
    while (id < N_SLOTS && lo <= P * (1 - frac[order[id]])) dnAt[order[id++]] = i;
  }
  for (let s = 0; s < N_SHAPES; s++) {
    const sh = SHAPES[s];
    for (let h = 0; h < N_HOLDS; h++) {
      const cell = cellOf(s, h);
      const sigmaHoldPct = sigmaOk ? sigma1h * Math.sqrt(HOLDS_H[h]) * 100 : null;
      const stopPct = sh.sigma ? (sigmaHoldPct === null ? null : sh.stop * sigmaHoldPct) : sh.stop;
      const targetPct = sh.sigma ? (sigmaHoldPct === null ? null : sh.target * sigmaHoldPct) : sh.target;
      const sSlot = STOP_SLOT[cell], tSlot = TARGET_SLOT[cell];
      for (let side = 0 as 0 | 1; side < 2; side++) {
        const k = off + csOf(cell, side as 0 | 1);
        const o = noEdgeOdds({ side: side === 0 ? 'long' : 'short', stopPct, targetPct, sigmaHoldPct, liqDistancePct: null });
        if (o.raw.targetFirst === null || o.raw.stopFirst === null || o.pTargetFirst === null || o.pStopFirst === null || stopPct === null || targetPct === null) {
          t.out[k] = OUT_NULL; t.aT[k] = NaN; t.aS[k] = NaN; t.bT[k] = NaN; t.bS[k] = NaN;
          continue;
        }
        t.aT[k] = Math.min(1, o.raw.targetFirst + ((o.raw.targetFirst + o.raw.stopFirst) * FEE_PCT) / (stopPct + targetPct));
        t.aS[k] = o.raw.stopFirst;
        t.bT[k] = o.pTargetFirst;
        t.bS[k] = o.pStopFirst;
        // a long's target is above and its stop below; a short's are mirrored
        let tgt = side === 0 ? upAt[tSlot] : dnAt[tSlot];
        let stp = side === 0 ? dnAt[sSlot] : upAt[sSlot];
        if (tgt >= HOLD_BARS[h]) tgt = -1;
        if (stp >= HOLD_BARS[h]) stp = -1;
        if (tgt < 0 && stp < 0) t.out[k] = OUT_TIMEOUT;
        else if (tgt >= 0 && stp >= 0 && tgt === stp) t.out[k] = MUTATE === 'bothtouch' ? OUT_TARGET : OUT_BOTH;
        else if (stp < 0 || (tgt >= 0 && tgt < stp)) t.out[k] = OUT_TARGET;
        else t.out[k] = OUT_STOP;
      }
    }
  }
}
