// regime-diag/keys.ts — EDGE-REGIME-DIAG-W1: the two answer keys (PROCEDURE §4d).
//
// Key A (CEILING, §4.9): the trend dated in hindsight — Pagan–Sossounov turning points with a Lunde–Timmermann
// filter on the log closes of full closed bars, per coin × timeframe, inside each window separately; and its
// volatility leg, the served rule's own quantity read forward.
// Key B (NO_LAG, §4.10): the pinned core, unchanged, on a window that ends 14 bars after the call.
import { type Bars, type Grid } from './archive.js';
import { MUTATE } from './mutate.js';
import { servable, served, type Served } from './replay.js';
import { KEY_A, KEY_A_VOL_BARS, KEY_B_LEAD, type Tf, type Win } from './diag-spec.js';

export interface Turns { idx: number[]; kind: number[]; theta: number }

/** Turning points of the series `x`: `kind` +1 a peak, −1 a trough; `theta = lambda·σ` of the one-bar differences. */
export function keyATurns(x: Float64Array, w: number, lambda: number): Turns {
  const n = x.length;
  if (n < 2 * w + 2) return { idx: [], kind: [], theta: NaN };
  let s1 = 0, s2 = 0;
  for (let k = 1; k < n; k++) { const r = x[k] - x[k - 1]; s1 += r; s2 += r * r; }
  const theta = lambda * Math.sqrt(Math.max(0, (s2 - (s1 * s1) / (n - 1)) / (n - 2)));
  const idx: number[] = [], kind: number[] = [];
  for (let k = w; k <= n - 1 - w; k++) {
    let mx = -Infinity, mn = Infinity, firstMx = -1, firstMn = -1;
    for (let j = k - w; j <= k + w; j++) {
      if (x[j] > mx) { mx = x[j]; firstMx = j; }
      if (x[j] < mn) { mn = x[j]; firstMn = j; }
    }
    if (mx === mn) continue; // a flat stretch has no candidate
    const kd = firstMx === k ? 1 : firstMn === k ? -1 : 0; // the first bar wins a tie
    if (kd === 0) continue;
    const last = idx.length - 1;
    // alternation: of two neighbours of the same kind, the more extreme stays
    if (last >= 0 && kind[last] === kd) { if (kd * (x[k] - x[idx[last]]) > 0) idx[last] = k; }
    else { idx.push(k); kind.push(kd); }
  }
  // the smallest swing goes while it is under the threshold: an end swing drops its end point, an interior one both
  for (;;) {
    if (idx.length < 2) break;
    let best = -1, amp = Infinity;
    for (let i = 0; i + 1 < idx.length; i++) { const a = Math.abs(x[idx[i]] - x[idx[i + 1]]); if (a < amp) { amp = a; best = i; } }
    if (!(amp < theta)) break;
    if (best === 0) { idx.shift(); kind.shift(); }
    else if (best + 1 === idx.length - 1) { idx.pop(); kind.pop(); }
    else { idx.splice(best, 2); kind.splice(best, 2); }
  }
  return { idx, kind, theta };
}

export const PHASE_NONE = 0;
export const PHASE_UP = 1;
export const PHASE_DOWN = 2;

/** Key A of one coin × timeframe × window. `phase` is indexed by the grid's bar number. */
export interface KeyA {
  tf: Tf; win: Win;
  /** Grid bar of each bar of the series (full bars of the window, in time order; a bar short of a minute is left out). */
  bars: Int32Array;
  turns: Turns;
  phase: Uint8Array;
  nBars: number; holes: number; dated: number; up: number;
}

export function buildKeyA(b: Bars, tf: Tf, win: Win): KeyA {
  const at: number[] = [], xs: number[] = [];
  let holes = 0;
  for (let k = Math.ceil(win.lo / tf.min); (k + 1) * tf.min <= win.hi && k < b.nb; k++) {
    if (b.cnt[k] === tf.min) { at.push(k); xs.push(Math.log(b.C[k])); } else if (at.length > 0) holes++;
  }
  const turns = keyATurns(Float64Array.from(xs), KEY_A.w, KEY_A.lambda);
  const phase = new Uint8Array(b.nb);
  let up = 0;
  for (let i = 0; i + 1 < turns.idx.length; i++) {
    const p = turns.kind[i] === -1 ? PHASE_UP : PHASE_DOWN;
    for (let s = turns.idx[i]; s < turns.idx[i + 1]; s++) phase[at[s]] = p;
    if (p === PHASE_UP) up += turns.idx[i + 1] - turns.idx[i];
  }
  const dated = turns.idx.length >= 2 ? turns.idx[turns.idx.length - 1] - turns.idx[0] : 0;
  return { tf, win, bars: Int32Array.from(at), turns, phase, nBars: at.length, holes, dated, up };
}

/** An entry takes the phase of its last closed bar (§4.9). */
export const phaseAt = (a: KeyA, m: number): number => {
  const k = Math.floor(m / a.tf.min) - 1;
  return k >= 0 && k < a.phase.length ? a.phase[k] : PHASE_NONE;
};

/**
 * Key A's volatility leg at grid minute `m`: the mean true range of the 14 bars that open at or after `m`, over
 * the entry price. NaN when one of those bars, or the bar before them, is short of a minute or runs past the window.
 */
export function volLeg(b: Bars, win: Win, m: number, entryPrice: number): number {
  const k1 = Math.ceil(m / b.min);
  if (k1 < 1 || (k1 + KEY_A_VOL_BARS) * b.min > win.hi || k1 + KEY_A_VOL_BARS > b.nb) return NaN;
  let sum = 0;
  for (let k = k1 - 1; k < k1 + KEY_A_VOL_BARS; k++) {
    if (b.cnt[k] !== b.min) return NaN;
    if (k === k1 - 1) continue;
    const pc = b.C[k - 1];
    sum += Math.max(b.H[k] - b.L[k], Math.abs(b.H[k] - pc), Math.abs(b.L[k] - pc));
  }
  return sum / KEY_A_VOL_BARS / entryPrice;
}

/** Key B's lead in bars. */
export const keyBLead = (): number => (MUTATE === 'keyb' ? 0 : KEY_B_LEAD);

/**
 * keyB(c, τ, t) = served(c, τ, t + lead·I_τ). Null when `t + lead·I_τ` is not inside the window, when that
 * window is broken, or when the core refuses.
 */
export function keyBAt(g: Grid, b: Bars, tf: Tf, win: Win, m: number, coin: string, lead = keyBLead()): Served | null {
  const m2 = m + lead * tf.min;
  if (m2 >= win.hi || m2 >= g.span.n || !servable(g, tf, m2)) return null;
  try {
    return served(g, b, tf, m2, coin);
  } catch {
    return null;
  }
}
