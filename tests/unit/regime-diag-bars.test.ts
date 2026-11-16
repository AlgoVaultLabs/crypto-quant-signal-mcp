// EDGE-REGIME-DIAG-W1 CH2 — the bar-level statistics (A5, lag, flip-flops) on hand-built per-closed-bar series.
import { describe, expect, it } from 'vitest';
import { ATR_RANGE_PER_SIGMA } from '../../src/lib/pre-trade-calc.js';
import { a5, a5Eff, barSeq, flipFlops, lagOf, runsOf, type BarFrame } from '../../src/scripts/regime-diag/bars.js';
import { blocksOf, shuffleBlocks } from '../../src/scripts/regime-diag/engine.js';
import type { KeyA } from '../../src/scripts/regime-diag/keys.js';
import type { Series } from '../../src/scripts/regime-diag/replay.js';
import { mulberry32 } from '../../src/scripts/regime-diag/rng.js';
import { KEY_B_LEAD, L_DOWN, L_RANGING, L_UP, L_VOLATILE, TFS, type Win } from '../../src/scripts/regime-diag/diag-spec.js';

const SPAWN = 60_000;
const H1 = TFS[0];
const R = L_RANGING, U = L_UP, D = L_DOWN, V = L_VOLATILE;

/** A series from per-close labels (−1: no call at that close), closes and volatility ratios. Index 0 is unused. */
function series(tf: typeof H1, labels: number[], close?: number[], vol?: number[]): Series {
  const nb = labels.length - 1;
  const s: Series = { tf, nb, ok: new Uint8Array(nb + 1), label: new Uint8Array(nb + 1), conf: new Uint8Array(nb + 1), vol: new Float64Array(nb + 1).fill(NaN),
    close: new Float64Array(nb + 1).fill(NaN), age: new Int32Array(nb + 1), calls: 0, refusals: 0 };
  for (let j = 1; j <= nb; j++) {
    s.close[j] = close ? close[j] : 100 + j;
    if (labels[j] < 0) continue;
    s.ok[j] = 1; s.label[j] = labels[j]; s.vol[j] = vol ? vol[j] : 0.02;
  }
  return s;
}
const win = (lo: number, hi: number, tf = H1): Win => ({ name: 'fit', lo: lo * tf.min, hi: hi * tf.min });
const sig = (v: number): number => v / ATR_RANGE_PER_SIGMA;

describe('regime-diag: the per-closed-bar sequence of a window', () => {
  it('holds the closes inside the window that have a call; key B reads the label 14 bars later and needs that call inside the window', () => {
    const labels = [-1, R, U, U, -1, D, D, R, V, V, U];
    const s = series(H1, labels);
    const q = barSeq(s, win(2, 10), 0, 0, 0);
    expect([Array.from(q.j), Array.from(q.label)]).toEqual([[2, 3, 5, 6, 7, 8, 9], [U, U, D, D, R, V, V]]);
    expect([q.close[0], q.sig[2]]).toEqual([102, sig(0.02)]);
    const long = Array.from({ length: 41 }, (_, j) => (j === 0 || j === 20 ? -1 : j % 4));
    const b = barSeq(series(H1, long), win(1, 38), 0, 0, KEY_B_LEAD);
    // j needs its own call (for the close and σ), the call at j + 14, and (j + 14)·I inside the window
    expect(Array.from(b.j)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1).filter((j) => j !== 20 - KEY_B_LEAD && j !== 20));
    expect(Array.from(b.label)).toEqual(Array.from(b.j, (j) => long[j + KEY_B_LEAD]));
    expect(Array.from(b.close)).toEqual(Array.from(b.j, (j) => 100 + j));
  });
});

describe('regime-diag: A5 — TRENDING runs', () => {
  //            j: 0   1  2  3  4  5  6  7  8   9  10 11 12 13 14 15 16
  const labels = [-1, U, U, R, U, U, U, D, R, -1, D, D, R, U, R, V, U];
  const close = [0, 100, 101, 102, 104, 103, 108, 110, 107, 0, 100, 99, 97, 98, 99, 101, 100];
  const vol = Array.from({ length: 17 }, (_, j) => 0.01 + j / 1000);

  it('a run goes from the close a TRENDING label first appears to the close a different label first appears; cut runs are excluded and counted', () => {
    const r = runsOf([barSeq(series(H1, labels, close, vol), win(1, 17), 2, 0, 0)]);
    // segments 1..8 and 10..16. First and last block of a segment are cut: UU@1, DD@10, U@16 are censored.
    expect(r.censored).toBe(3);
    expect(r.runs.map((x) => [x.j0, x.len, x.up, x.pos, x.t])).toEqual([[4, 3, true, 2, 0], [7, 1, false, 2, 0], [13, 1, true, 2, 0]]);
    const y = (j0: number, j1: number): number => Math.abs(Math.log(close[j1] / close[j0])) / sig(vol[j0]);
    expect(r.runs.map((x) => x.y)).toEqual([y(4, 7), y(7, 8), y(13, 14)]);
    // signed: in the label's direction
    expect(r.runs.map((x) => x.signed)).toEqual([Math.log(110 / 104) / sig(vol[4]), -Math.log(107 / 110) / sig(vol[7]), Math.log(99 / 98) / sig(vol[13])]);
    // a run that starts where the volatility ratio is not positive has no σ: excluded and counted
    const flat = vol.slice(); flat[7] = 0;
    const r0 = runsOf([barSeq(series(H1, labels, close, flat), win(1, 17), 2, 0, 0)]);
    expect([r0.censored, r0.runs.map((x) => x.j0)]).toEqual([4, [4, 13]]);
    // a window edge cuts a run
    expect(runsOf([barSeq(series(H1, labels, close, vol), win(5, 17), 2, 0, 0)]).runs.map((x) => x.j0)).toEqual([7, 13]);
  });

  /** A coin whose TRENDING runs are (or are not) the stretches where price moves. */
  function coin(seed: number, n: number, real: boolean): Series {
    const rnd = mulberry32(seed), labels = [-1], cl = [0];
    let px = 100, cur = R, left = 0, drift = 0;
    for (let j = 1; j <= n; j++) {
      if (left === 0) { cur = [R, U, D, V][Math.floor(rnd() * 4)]; left = 2 + Math.floor(rnd() * 9); drift = cur === U ? 0.004 : cur === D ? -0.004 : 0; }
      left--;
      px *= Math.exp((real ? drift : 0) + 0.002 * (rnd() - 0.5));
      labels.push(j % 97 === 0 ? -1 : cur); cl.push(px);
    }
    return series(H1, labels, cl);
  }
  const frame = (real: boolean, coins = 3, n = 900): BarFrame => ({ win: win(1, n + 1), census: { panel: ['TA', 'TB', 'TC'].slice(0, coins), wCoin: [0.5, 0.3, 0.2].slice(0, coins), wTf: [0.2, 0.5, 0.3] },
    coins: Array.from({ length: coins }, (_, p) => ({ pos: p, series: [coin(40 + p, n, real), coin(50 + p, Math.floor(n / 4), real), coin(60 + p, Math.floor(n / 24), real)] })) });
  const opts = { B: 300, alpha: 0.025, bootSeed: 21, shuffleB: 200, shuffleSeed: 22 };

  it('R5 is the ω-weighted move of the runs over the same move where each run lands under the shuffle', { timeout: SPAWN }, () => {
    const f = frame(true), got = a5(f, 'A5.S', 0, opts);
    // the same stream, replayed here from the labels alone
    const seqs = f.coins.flatMap((c) => c.series.map((s, t) => barSeq(s, f.win, c.pos, t, 0)));
    const rnd = mulberry32(22);
    interface Rn { q: number; b: number; len: number; w: number; y: number; refs: number[]; cl: string; pos: number }
    const runs: Rn[] = [];
    const blocks = seqs.map((q) => blocksOf(q.n, (i) => q.label[i], (i) => q.j[i] !== q.j[i - 1] + 1));
    seqs.forEach((q, qi) => {
      const bl = blocks[qi];
      for (let b = 1; b + 1 < bl.start.length; b++) {
        const i0 = bl.start[b], len = bl.len[b];
        if ((q.label[i0] !== U && q.label[i0] !== D) || q.j[i0 - 1] !== q.j[i0] - 1 || q.j[i0 + len] !== q.j[i0] + len) continue;
        runs.push({ q: qi, b, len, w: f.census.wCoin[q.pos] * f.census.wTf[q.t], y: Math.abs(Math.log(q.close[i0 + len] / q.close[i0])) / q.sig[i0], refs: [], pos: q.pos,
          cl: `${q.pos}|${Math.floor((q.j[i0] * TFS[q.t].min) / 1440)}` });
      }
    });
    expect(got.runs).toBe(runs.length);
    expect(runs.length).toBeGreaterThan(150);
    for (let d = 0; d < opts.shuffleB; d++) {
      seqs.forEach((q, qi) => {
        const bl = blocks[qi], order = new Int32Array(q.n), src = new Int32Array(q.n), landing = new Int32Array(bl.start.length);
        shuffleBlocks(bl, rnd, order, src, landing);
        for (const r of runs) {
          if (r.q !== qi) continue;
          const p = landing[r.b];
          r.refs.push(p + r.len < q.n && q.j[p + r.len] === q.j[p] + r.len ? Math.abs(Math.log(q.close[p + r.len] / q.close[p])) / q.sig[p] : NaN);
        }
      });
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const c = runs.map((r) => mean(r.refs.filter((x) => !Number.isNaN(x))));
    const sum = (v: (r: Rn, i: number) => number, keep: (r: Rn, i: number) => boolean = () => true): number => runs.reduce((s, r, i) => s + (keep(r, i) ? v(r, i) : 0), 0);
    const R5 = sum((r) => r.w * r.y) / sum((r, i) => r.w * c[i]);
    expect(got.point).toBeCloseTo(R5, 10);
    const nulls = Array.from({ length: opts.shuffleB }, (_, d) => sum((r) => r.w * r.refs[d], (r) => !Number.isNaN(r.refs[d])) / sum((r, i) => r.w * c[i], (r) => !Number.isNaN(r.refs[d])));
    expect(got.shuffle.pUpper).toBe((1 + nulls.filter((x) => x >= R5).length) / (1 + opts.shuffleB));
    // the other tail, for a fit-window ratio below 1 that the hold-out is asked to confirm
    expect(got.shuffle.pLower).toBe((1 + nulls.filter((x) => x <= R5).length) / (1 + opts.shuffleB));
    expect(got.shuffle.pLower).toBe(1);
    expect(got.shuffle.mean).toBeCloseTo(mean(nulls), 10);
    expect(got.shuffle.n).toBe(opts.shuffleB);
    // clusters: coin × UTC day of the run's first close; Kish over their Σω
    const cw = new Map<string, number>();
    runs.forEach((r) => cw.set(r.cl, (cw.get(r.cl) ?? 0) + r.w));
    const sizes = [...cw.values()];
    expect(got.clusters).toBe(sizes.length);
    expect(got.eff).toBeCloseTo(sizes.reduce((a, b) => a + b, 0) ** 2 / sizes.reduce((a, b) => a + b * b, 0), 9);
    // the same count before any move is read (the hold-out's floor check): every run, referenced or not
    expect(got.unreferenced).toBe(0);
    expect(a5Eff(f, 0)).toBeCloseTo(got.eff, 9);
    expect(a5Eff(f, 0, 'panel13', new Set([0, 2]))).toBeCloseTo(a5({ ...f, coins: f.coins.filter((x) => x.pos !== 1) }, 'A5.S', 0, opts).eff, 9);
    expect(a5Eff(f, 0, 'day')).toBeLessThan(a5Eff(f, 0));
    expect(got.lb).toBeLessThan(got.point);
    expect(got.ub).toBeGreaterThan(got.point);
    // the labels date the moves: the ratio is far above 1 and no shuffle reaches it
    expect(got.point).toBeGreaterThan(1.5);
    expect(got.lb).toBeGreaterThan(1.1);
    expect(got.shuffle.pUpper).toBe(1 / (1 + opts.shuffleB));
    // the sensitivity variants: unit weights, pooled days, 7-day blocks, a subset of positions
    const unit = a5(f, 'A5.S', 0, { ...opts, variant: 'unit' });
    expect(unit.point).toBeCloseTo(sum((r) => r.y) / sum((_, i) => c[i]), 10);
    const day = a5(f, 'A5.S', 0, { ...opts, variant: 'day' }), week = a5(f, 'A5.S', 0, { ...opts, variant: 'week' });
    expect([day.point, week.point]).toEqual([got.point, got.point]);
    expect(day.clusters).toBe(new Set(runs.map((r) => r.cl.split('|')[1])).size);
    expect(week.clusters).toBe(new Set(runs.map((r) => `${r.pos}|${Math.floor(Number(r.cl.split('|')[1]) / 7)}`)).size);
    const p13 = a5(f, 'A5.S', 0, { ...opts, variant: 'panel13', keep: new Set([0, 2]) });
    expect(p13.runs).toBe(runs.filter((r) => r.pos !== 1).length);
    // the 13-position reading is the reading on those positions alone: its own shuffles, the full panel's weights
    expect(p13).toEqual(a5({ ...f, coins: f.coins.filter((x) => x.pos !== 1) }, 'A5.S', 0, opts));
    expect(p13.point).not.toBe(got.point);
    // per timeframe: run length (weighted mean and median) and the signed move
    expect(got.perTf.map((x) => x.runs)).toEqual([0, 1, 2].map((t) => runs.filter((r) => seqs[r.q].t === t).length));
    const at0 = runs.filter((r) => seqs[r.q].t === 0);
    expect(got.perTf[0].meanLen).toBeCloseTo(at0.reduce((s, r) => s + r.w * r.len, 0) / at0.reduce((s, r) => s + r.w, 0), 10);
    const sorted = at0.slice().sort((a, b) => a.len - b.len), half = at0.reduce((s, r) => s + r.w, 0) / 2;
    let cum = 0, med = NaN;
    for (const r of sorted) { cum += r.w; if (cum >= half) { med = r.len; break; } }
    expect(got.perTf[0].medianLen).toBe(med);
    expect(got.perTf[0].signed).toBeGreaterThan(1);
  });

  it('labels that do not date the moves score near 1 and the shuffle is not beaten; key B reads the series 14 bars later', { timeout: SPAWN }, () => {
    const noise = a5(frame(false), 'A5.S', 0, opts);
    expect(noise.point).toBeGreaterThan(0.8);
    expect(noise.point).toBeLessThan(1.2);
    expect(noise.shuffle.pUpper).toBeGreaterThan(0.025);
    expect(Math.abs(noise.perTf[0].signed)).toBeLessThan(0.5);
    // read 14 bars later, the dated labels of the real coin no longer cover the moves
    const late = a5(frame(true), 'A5.B', KEY_B_LEAD, opts), now = a5(frame(true), 'A5.S', 0, opts);
    expect(late.point).toBeLessThan(now.point - 0.5);
    // too little to read: no run at all
    const none = a5({ win: win(1, 6), census: { panel: ['TA'], wCoin: [1], wTf: [0.2, 0.5, 0.3] }, coins: [{ pos: 0, series: [series(H1, [-1, U, U, U, U, U]), series(H1, [-1]), series(H1, [-1])] }] }, 'A5.S', 0, opts);
    expect([none.runs, none.censored, none.clusters, none.eff, Number.isNaN(none.point), Number.isNaN(none.lb), Number.isNaN(none.ub)]).toEqual([0, 1, 0, 0, true, true, true]);
  });
});

describe('regime-diag: lag and flip-flops (descriptive)', () => {
  it('lag: closed bars from a turn to the first close whose label points the new way, censored at the next turn', () => {
    // bars 10..29 of the grid; a trough at bar 12, a peak at bar 20, a trough at bar 26
    const a = { tf: H1, win: win(10, 30), bars: Int32Array.from({ length: 20 }, (_, i) => 10 + i), turns: { idx: [2, 10, 16], kind: [-1, 1, -1], theta: 0 } } as unknown as KeyA;
    const labels = Array.from({ length: 31 }, () => R);
    labels[16] = U;            // first UP close after the trough at bar 12: close 16 = the close of bar 15 → 3 bars after the turn bar
    labels[21] = D;            // the close of the peak bar itself: lag 0
    labels[28] = -1;           // after the last turn: no UP label before the window ends → censored
    expect(lagOf(a, series(H1, labels))).toEqual({ turns: 3, censored: 1, lags: [3, 0] });
    // an UP label only after the next turn is censored, not a late lag
    const late = labels.slice(); late[16] = R; late[22] = U;
    expect(lagOf(a, series(H1, late))).toEqual({ turns: 3, censored: 2, lags: [0] });
    // the last turn reads up to the last close inside the window
    const end = labels.slice(); end[29] = U;
    expect(lagOf(a, series(H1, end)).lags).toEqual([3, 0, 2]);
  });

  it('flip-flops: a label that changes and changes back within 3 bars, per 1,000 bars', () => {
    //              j: 0  1  2  3  4  5  6  7  8  9  10 11 12 13 14  15 16
    const labels = [-1, R, U, R, R, U, U, U, U, R, V, D, R, R, U, -1, R];
    // changes at 2 (R→U, R is back at 3: yes), 3 (U→R, U is back at 5: yes), 5 (R→U, R is back only at 9: no), 9 (U→R: no),
    // 10 (R→V, R is back at 12: yes), 11 (V→D: no), 12 (D→R: no), 14 (R→U, then a close with no call: no)
    const got = flipFlops(series(H1, labels), win(1, 17));
    expect(got).toEqual({ bars: 15, changes: 8, flipflops: 3 });
    expect(flipFlops(series(H1, labels), win(1, 3))).toEqual({ bars: 2, changes: 1, flipflops: 0 });
  });
});
