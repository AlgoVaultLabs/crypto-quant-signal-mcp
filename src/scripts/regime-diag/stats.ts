// regime-diag/stats.ts — EDGE-REGIME-DIAG-W1: the registered statistics (§4.8), their key readings (§4.9, §4.10)
// and the component-map slices, as sums the engine can resample and shuffle.
//
// Every value is in percentage points (A5's ratio aside). Output 0 of a statistic is the statistic; the other
// outputs are its paired excesses over the baselines (a), (b) and (d), or the arms of a contrast.
import { contrast, joint, type Stat } from './engine.js';
import { N_TF, isTrending, phaseLab, type Frame, type Lab } from './frame.js';
import { A3_GROUPS, L_RANGING, L_UP, L_VOLATILE, NO_LABEL, N_CELLS, N_CS, N_HOLDS, N_SHAPES, REGIME_AGAINST_MIN_CONFIDENCE, VOLATILE_MIN_CONFIDENCE,
  VOL_LINE, VOL_LINE_CONF70, YOUNG_BARS, cellOf, type Key } from './diag-spec.js';

const T = 1, S = 2; // OUT_TARGET, OUT_STOP; 3 and 4 are the excluded outcomes

/** Per row: 1 (up) or 2 (down) where the row is TRENDING under `lab` with lo ≤ confidence < hi and `also`; else 0. */
export function trendDir(f: Frame, lab: Lab, lo = 0, hi = 101, also?: (r: number) => boolean): Uint8Array {
  const d = new Uint8Array(f.has.length);
  for (let r = 0; r < d.length; r++) {
    if (f.has[r] && isTrending(lab.lab[r]) && lab.conf[r] >= lo && lab.conf[r] < hi && (!also || also(r))) d[r] = lab.lab[r] === L_UP ? 1 : 2;
  }
  return d;
}
/** Per row: 1 where the row carries `label` under `lab` with lo ≤ confidence < hi and `also`. */
export function pick(f: Frame, lab: Lab, label: number, lo = 0, hi = 101, also?: (r: number) => boolean): Uint8Array {
  const s = new Uint8Array(f.has.length);
  for (let r = 0; r < s.length; r++) if (f.has[r] && lab.lab[r] === label && lab.conf[r] >= lo && lab.conf[r] < hi && (!also || also(r))) s[r] = 1;
  return s;
}
/** Key A's volatility leg as a label: VOLATILE above the line (confidence 100 above the 0.03475 line, else 0). */
export function volLab(f: Frame): Lab {
  const n = f.has.length, lab = new Uint8Array(n).fill(NO_LABEL), conf = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    if (!f.has[r] || !Number.isFinite(f.volLeg[r])) continue;
    lab[r] = f.volLeg[r] > VOL_LINE ? L_VOLATILE : L_RANGING;
    conf[r] = f.volLeg[r] > VOL_LINE_CONF70 ? 100 : 0;
  }
  return { lab, conf };
}

const cellsOf = (f: Frame) => {
  if (!f.cells) throw new Error('regime-diag: this frame was built without outcomes');
  return f.cells;
};
const nan = (out: Float64Array, o: number, n: number): void => { for (let i = 0; i < n; i++) out[o + i] = NaN; };

/**
 * A1 — Δ1: per cell, the ω-weighted mean of x1 = I_T(with) − I_T(against) over rows where neither side is
 * excluded; then the plain mean over the 45 cells. Δ1 = U + D. Outputs: Δ1, U, D, Δ1 − Δ1(a), Δ1 − Δ1(b).
 * Against the fixed sides and the random side the paired excesses are 2D, 2U and Δ1, so U, D and Δ1 are the (d) reads.
 */
export function delta1(f: Frame, id: string, dir: Uint8Array, seq: Uint8Array): Stat {
  const c = cellsOf(f), M = 5;
  return {
    id, m: N_CELLS * M, names: ['S', 'U', 'D', 'e_a', 'e_b'], seq,
    add(src, place, w, acc, off) {
      const d = dir[src];
      if (!d) return false;
      const base = Math.floor(place / N_TF) * N_CS, ws = d === 1 ? 0 : 1;
      for (let cell = 0; cell < N_CELLS; cell++) {
        const kW = base + cell * 2 + ws, kA = base + cell * 2 + 1 - ws, oW = c.out[kW], oA = c.out[kA];
        if (oW >= 3 || oA >= 3) continue;
        const o = off + cell * M;
        acc[o] += w;
        acc[o + d] += w * ((oW === T ? 1 : 0) - (oA === T ? 1 : 0));
        acc[o + 3] += w * (c.aT[kW] - c.aT[kA]);
        acc[o + 4] += w * (c.bT[kW] - c.bT[kA]);
      }
      return true;
    },
    evaluate(tot, off, out, o) {
      let U = 0, D = 0, A = 0, B = 0;
      for (let cell = 0; cell < N_CELLS; cell++) {
        const k = off + cell * M, den = tot[k];
        if (!(den > 0)) { nan(out, o, 5); return; }
        U += tot[k + 1] / den; D += tot[k + 2] / den; A += tot[k + 3] / den; B += tot[k + 4] / den;
      }
      const q = 100 / N_CELLS;
      out[o] = (U + D) * q; out[o + 1] = U * q; out[o + 2] = D * q; out[o + 3] = (U + D - A) * q; out[o + 4] = (U + D - B) * q;
    },
  };
}

/** Δ1 of each cell (pp), for the by-hold table of map row 12. NaN where a cell has no defined row. */
export function delta1Cells(tot: Float64Array): number[] {
  return Array.from({ length: N_CELLS }, (_, cell) => (tot[cell * 5] > 0 ? (100 * (tot[cell * 5 + 1] + tot[cell * 5 + 2])) / tot[cell * 5] : NaN));
}
/** Δ1 by hold (pp): the plain mean of the hold's cells over the shapes. NaN for a hold with an undefined cell. */
export function delta1ByHold(tot: Float64Array): number[] {
  const d = delta1Cells(tot);
  return Array.from({ length: N_HOLDS }, (_, h) => { let x = 0; for (let sh = 0; sh < N_SHAPES; sh++) x += d[cellOf(sh, h)]; return x / N_SHAPES; });
}

/**
 * A2 — S2: per cell-side, the ω-weighted mean of x2 = I_S − b_S; then the plain mean over the 90 cell-sides.
 * Outputs: S2 (its own reference is (b)), the same mean of I_S − a_S, and S2 on the long and on the short sides.
 */
export function s2(f: Frame, id: string, sel: Uint8Array, seq: Uint8Array): Stat {
  const c = cellsOf(f), M = 3;
  return {
    id, m: N_CS * M, names: ['S', 'e_a', 'e_long', 'e_short'], seq,
    add(src, place, w, acc, off) {
      if (!sel[src]) return false;
      const base = Math.floor(place / N_TF) * N_CS;
      for (let cs = 0; cs < N_CS; cs++) {
        const k = base + cs, oc = c.out[k];
        if (oc >= 3) continue;
        const o = off + cs * M, iS = oc === S ? 1 : 0;
        acc[o] += w; acc[o + 1] += w * (iS - c.bS[k]); acc[o + 2] += w * (iS - c.aS[k]);
      }
      return true;
    },
    evaluate(tot, off, out, o) {
      let b = 0, a = 0, lg = 0, sh = 0;
      for (let cs = 0; cs < N_CS; cs++) {
        const k = off + cs * M, den = tot[k];
        if (!(den > 0)) { nan(out, o, 4); return; }
        const v = tot[k + 1] / den;
        b += v; a += tot[k + 2] / den;
        if (cs % 2 === 0) lg += v; else sh += v;
      }
      out[o] = (100 * b) / N_CS; out[o + 1] = (100 * a) / N_CS; out[o + 2] = (100 * lg) / N_CELLS; out[o + 3] = (100 * sh) / N_CELLS;
    },
  };
}

/**
 * A3 — E(shape, group): the hold-averaged ω-weighted mean of I_T − a_T.
 * TRENDING-with / TRENDING-against read one side per row (`sel` is a direction, 1 or 2). Outputs: E, the same mean
 * of I_T − b_T, and E's excess over the same statistic with the side fixed long, fixed short, and averaged over both.
 * RANGING / VOLATILE read both sides (`sel` is 0/1; the mean runs over 10 cell-sides). Outputs: E, the mean of
 * I_T − b_T, and E on the long and on the short sides.
 */
export function e3(f: Frame, id: string, shape: number, group: number, sel: Uint8Array, seq: Uint8Array): Stat {
  const c = cellsOf(f);
  if (group < 2) {
    const M = 7;
    return {
      id, m: N_HOLDS * M, names: ['S', 'e_b', 'e_long', 'e_short', 'e_both'], seq,
      add(src, place, w, acc, off) {
        const d = sel[src];
        if (!d) return false;
        const base = Math.floor(place / N_TF) * N_CS;
        for (let h = 0; h < N_HOLDS; h++) {
          const kL = base + cellOf(shape, h) * 2, kS = kL + 1, kG = (d === 1) === (group === 0) ? kL : kS, o = off + h * M;
          if (c.out[kG] < 3) { const i = c.out[kG] === T ? 1 : 0; acc[o] += w; acc[o + 1] += w * (i - c.aT[kG]); acc[o + 2] += w * (i - c.bT[kG]); }
          if (c.out[kL] < 3) { acc[o + 3] += w; acc[o + 4] += w * ((c.out[kL] === T ? 1 : 0) - c.aT[kL]); }
          if (c.out[kS] < 3) { acc[o + 5] += w; acc[o + 6] += w * ((c.out[kS] === T ? 1 : 0) - c.aT[kS]); }
        }
        return true;
      },
      evaluate(tot, off, out, o) {
        let e = 0, b = 0, lg = 0, sh = 0;
        for (let h = 0; h < N_HOLDS; h++) {
          const k = off + h * M;
          if (!(tot[k] > 0) || !(tot[k + 3] > 0) || !(tot[k + 5] > 0)) { nan(out, o, 5); return; }
          e += tot[k + 1] / tot[k]; b += tot[k + 2] / tot[k]; lg += tot[k + 4] / tot[k + 3]; sh += tot[k + 6] / tot[k + 5];
        }
        const q = 100 / N_HOLDS;
        out[o] = e * q; out[o + 1] = b * q; out[o + 2] = (e - lg) * q; out[o + 3] = (e - sh) * q; out[o + 4] = (e - (lg + sh) / 2) * q;
      },
    };
  }
  const M = 3;
  return {
    id, m: N_HOLDS * 2 * M, names: ['S', 'e_b', 'e_long', 'e_short'], seq,
    add(src, place, w, acc, off) {
      if (!sel[src]) return false;
      const base = Math.floor(place / N_TF) * N_CS;
      for (let h = 0; h < N_HOLDS; h++) {
        for (let side = 0; side < 2; side++) {
          const k = base + cellOf(shape, h) * 2 + side;
          if (c.out[k] >= 3) continue;
          const o = off + (h * 2 + side) * M, i = c.out[k] === T ? 1 : 0;
          acc[o] += w; acc[o + 1] += w * (i - c.aT[k]); acc[o + 2] += w * (i - c.bT[k]);
        }
      }
      return true;
    },
    evaluate(tot, off, out, o) {
      let a = 0, b = 0, lg = 0, sh = 0;
      for (let i = 0; i < N_HOLDS * 2; i++) {
        const k = off + i * M;
        if (!(tot[k] > 0)) { nan(out, o, 4); return; }
        const v = tot[k + 1] / tot[k];
        a += v; b += tot[k + 2] / tot[k];
        if (i % 2 === 0) lg += v; else sh += v;
      }
      out[o] = (100 * a) / (N_HOLDS * 2); out[o + 1] = (100 * b) / (N_HOLDS * 2); out[o + 2] = (100 * lg) / N_HOLDS; out[o + 3] = (100 * sh) / N_HOLDS;
    },
  };
}

/**
 * A4 — S4 = A − A_0 on rows that are TRENDING under the key and have a dated key-A phase. A = Σω·g / Σω;
 * A_0 = p_L·p_K + (1 − p_L)(1 − p_K), from the same sums, so it is recomputed on every resample.
 * Outputs: S4, A − p_K, A − (1 − p_K), A − 0.5. Under the shuffle the label travels and the phase stays.
 */
export function a4(f: Frame, id: string, dir: Uint8Array, seq: Uint8Array): Stat {
  return {
    id, m: 4, names: ['S', 'e_always_up', 'e_always_down', 'e_coin'], seq,
    add(src, place, w, acc, off) {
      const d = dir[src], ph = f.phase[place];
      if (!d || !ph) return false;
      acc[off] += w;
      if (d === ph) acc[off + 1] += w;
      if (d === 1) acc[off + 2] += w;
      if (ph === 1) acc[off + 3] += w;
      return true;
    },
    evaluate(tot, off, out, o) {
      const W = tot[off];
      if (!(W > 0)) { nan(out, o, 4); return; }
      const A = tot[off + 1] / W, pL = tot[off + 2] / W, pK = tot[off + 3] / W;
      out[o] = 100 * (A - (pL * pK + (1 - pL) * (1 - pK))); out[o + 1] = 100 * (A - pK); out[o + 2] = 100 * (A - (1 - pK)); out[o + 3] = 100 * (A - 0.5);
    },
  };
}

export interface A3Cell { shape: number; group: number }
export const a3CellId = (c: A3Cell): string => `S${c.shape + 1}|${A3_GROUPS[c.group]}`;
export const A3_CELLS: readonly A3Cell[] = Object.freeze(Array.from({ length: N_SHAPES * A3_GROUPS.length }, (_, i) => ({ shape: Math.floor(i / A3_GROUPS.length), group: i % A3_GROUPS.length })));

/** The label a key gives each row, for the trend reads and for the volatility reads. */
const keyLab = (f: Frame, key: Key, vol: boolean): Lab => (key === 'S' ? f.S : key === 'B' ? f.B : vol ? volLab(f) : phaseLab(f));

/** One A3 cell under a key (§4.9: the TRENDING groups keyed as A1 at any confidence, VOLATILE as A2 at the 0.03 line). Null: RANGING has no CEILING. */
export function a3Stat(f: Frame, id: string, cell: A3Cell, key: Key): Stat | null {
  if (cell.group < 2) { const l = keyLab(f, key, false); return e3(f, id, cell.shape, cell.group, trendDir(f, l), l.lab); }
  if (cell.group === 2) { if (key === 'A') return null; const l = keyLab(f, key, false); return e3(f, id, cell.shape, 2, pick(f, l, L_RANGING), l.lab); }
  const l = keyLab(f, key, true);
  return e3(f, id, cell.shape, 3, pick(f, l, L_VOLATILE), l.lab);
}

export interface Built {
  stat: Stat;
  /** The arms whose effective clusters gate the reading (§4.11). */
  arms: Stat[];
  counts: Record<string, number>;
}
const one = (stat: Stat, counts: Record<string, number> = {}): Built => ({ stat, arms: [stat], counts });

/**
 * The statistic of a registry id (without a variant suffix). `cell` is the fit-selected A3 cell, needed by
 * A3.S, A3.B and A3.A. Null when the reading does not exist (A3.A in a RANGING cell).
 */
export function registered(f: Frame, id: string, cell?: A3Cell): Built | null {
  const S_ = f.S, c60 = REGIME_AGAINST_MIN_CONFIDENCE, c70 = VOLATILE_MIN_CONFIDENCE;
  const d1 = (sid: string, lab: Lab, lo = 0, hi = 101, also?: (r: number) => boolean): Stat => delta1(f, sid, trendDir(f, lab, lo, hi, also), lab.lab);
  const v2 = (sid: string, lab: Lab, lo = 0, hi = 101, also?: (r: number) => boolean): Stat => s2(f, sid, pick(f, lab, L_VOLATILE, lo, hi, also), lab.lab);
  const two = (a: Stat, b: Stat): Built => ({ stat: contrast(id, a, b), arms: [a, b], counts: {} });
  const adx = (lo: number, hi: number) => (r: number): boolean => f.adx[r] > lo && f.adx[r] <= hi;
  const m = /^A([1-5])\.([SBA])$/.exec(id);
  if (m) {
    const key = m[2] as Key;
    if (m[1] === '1') return one(key === 'A' ? d1(id, phaseLab(f)) : d1(id, keyLab(f, key, false), c60));
    if (m[1] === '2') return one(v2(id, keyLab(f, key, true), c70));
    if (m[1] === '3') { if (!cell) throw new Error(`regime-diag: ${id} needs the fit-selected cell`); const s = a3Stat(f, id, cell, key); return s ? one(s) : null; }
    if (m[1] === '4' && key !== 'A') { const l = keyLab(f, key, false); return one(a4(f, id, trendDir(f, l), l.lab)); }
    throw new Error(`regime-diag: ${id} is not a row statistic`);
  }
  switch (id) {
    case 'A3.cells': { const parts = A3_CELLS.map((c) => a3Stat(f, a3CellId(c), c, 'S')!); return { stat: joint(id, parts), arms: parts, counts: {} }; }
    case 'A1.all': return one(d1(id, S_));
    case 'A2.all': return one(v2(id, S_));
    case 'M01': {
      const young = d1('young', S_, 0, 101, (r) => f.age[r] <= YOUNG_BARS), older = d1('older', S_, 0, 101, (r) => f.age[r] > YOUNG_BARS);
      return { stat: joint(id, [young, older]), arms: [young], counts: {} };
    }
    case 'M02': return one(d1(id, S_, 0, 101, adx(18, 25)));
    case 'M03': return one(d1(id, S_, 0, 101, adx(25, 30)));
    case 'M04': return one(d1(id, S_, 0, 101, adx(30, 40)));
    case 'M05': return one(d1(id, S_, 0, 101, adx(40, Infinity)));
    case 'M06': return two(d1('rising', S_, 0, 101, (r) => f.slope[r] === 2), d1('falling', S_, 0, 101, (r) => f.slope[r] === 0));
    case 'M07': {
      const dir = new Uint8Array(f.has.length);
      let tie = 0;
      for (let r = 0; r < dir.length; r++) {
        if (!f.has[r] || S_.lab[r] !== L_RANGING || !(f.adx[r] > 25 && f.adx[r] < 30) || f.slope[r] !== 0 || !(f.adxSlope[r] < -1.0)) continue;
        if (f.structure[r] === 1) dir[r] = 1;
        else if (f.structure[r] === 2) dir[r] = 2;
        else if (f.plusDI[r] > f.minusDI[r]) dir[r] = 1;
        else if (f.plusDI[r] < f.minusDI[r]) dir[r] = 2;
        else tie++;
      }
      return one(delta1(f, id, dir, S_.lab), { di_tie: tie });
    }
    case 'M08': return one(d1(id, S_, 0, 101, (r) => f.adx[r] > 25 && f.structure[r] !== 0 && (f.structure[r] === 1) === (S_.lab[r] === L_UP)
      && (S_.lab[r] === L_UP ? f.plusDI[r] < f.minusDI[r] : f.plusDI[r] > f.minusDI[r])));
    case 'M09': {
      // non-trending rows: the fixed line's rows, and per coin × timeframe the same share of rows by largest ratio
      const fixed = new Uint8Array(f.has.length), pct = new Uint8Array(f.has.length);
      for (let t = 0; t < N_TF; t++) {
        let n = 0, over = 0;
        const non = (r: number): boolean => f.has[r] === 1 && !isTrending(S_.lab[r]);
        for (let e = 0; e < f.nE; e++) { const r = e * N_TF + t; if (!non(r)) continue; n++; if (f.vol[r] > VOL_LINE) { over++; fixed[r] = 1; } }
        const q = n ? over / n : 0;
        for (const c of f.coins) {
          const rows: number[] = [];
          for (let e = c.e0; e < c.e1; e++) if (non(e * N_TF + t)) rows.push(e * N_TF + t);
          rows.sort((a, b) => f.vol[b] - f.vol[a] || a - b);
          for (let i = 0; i < Math.round(q * rows.length); i++) pct[rows[i]] = 1;
        }
      }
      return two(s2(f, 'fixed', fixed, S_.lab), s2(f, 'percentile', pct, S_.lab));
    }
    case 'M10': return two(d1('conf>=60', S_, c60), d1('conf<60', S_, 0, c60));
    case 'M11': return two(v2('conf>=70', S_, c70), v2('conf<70', S_, 0, c70));
    case 'M12': {
      const all3 = (r: number): boolean => { const e = Math.floor(r / N_TF) * N_TF; return f.has[e] === 1 && f.has[e + 1] === 1 && f.has[e + 2] === 1; };
      const at = (t: number): Stat => d1(['1h', '4h', '1d'][t], S_, c60, 101, (r) => r % N_TF === t && all3(r));
      const arms = [at(1), at(0), at(2)];
      const j = joint(id, arms), tmp = new Float64Array(15);
      const stat: Stat = { id, m: j.m, names: ['theta_4h_1h', 'theta_4h_1d', '4h', '1h', '1d'], seq: S_.lab, add: j.add,
        evaluate(tot, off, out, o) { j.evaluate(tot, off, tmp, 0); out[o] = tmp[0] - tmp[5]; out[o + 1] = tmp[0] - tmp[10]; out[o + 2] = tmp[0]; out[o + 3] = tmp[5]; out[o + 4] = tmp[10]; } };
      return { stat, arms, counts: {} };
    }
    default: throw new Error(`regime-diag: ${id} has no row statistic`);
  }
}

/** The rows a primary reads, from the labels alone: what its effective clusters are counted on before any outcome. */
export function primaryRows(f: Frame, id: string, cell?: A3Cell): Uint8Array {
  if (id === 'A1.S') return trendDir(f, f.S, REGIME_AGAINST_MIN_CONFIDENCE);
  if (id === 'A2.S') return pick(f, f.S, L_VOLATILE, VOLATILE_MIN_CONFIDENCE);
  if (id === 'A3.S') {
    if (!cell) throw new Error('regime-diag: A3.S needs the fit-selected cell');
    return cell.group < 2 ? trendDir(f, f.S) : pick(f, f.S, cell.group === 2 ? L_RANGING : L_VOLATILE);
  }
  if (id === 'A4.S') return trendDir(f, f.S, 0, 101, (r) => f.phase[r] !== 0);
  throw new Error(`regime-diag: ${id} has no row set`);
}

/** The minority share (design weights) that bounds what an arm can attain (§4c). Null: 0.5 by construction, or none. */
export function minorityShare(f: Frame, w: Float64Array, id: string, cell?: A3Cell): number | null {
  const share = (dir: Uint8Array, phase: boolean): number => {
    let up = 0, all = 0;
    for (let r = 0; r < dir.length; r++) {
      if (!dir[r] || (phase && !f.phase[r])) continue;
      all += w[r];
      if ((phase ? f.phase[r] : dir[r]) === 1) up += w[r];
    }
    return all > 0 ? Math.min(up, all - up) / all : NaN;
  };
  if (id === 'A1.S') return share(trendDir(f, f.S, REGIME_AGAINST_MIN_CONFIDENCE), false);
  if (id === 'A1.all') return share(trendDir(f, f.S), false);
  if (id === 'A3.S') return cell && cell.group < 2 ? share(trendDir(f, f.S), false) : null;
  if (id === 'A4.S') return share(trendDir(f, f.S), true);
  return null;
}
