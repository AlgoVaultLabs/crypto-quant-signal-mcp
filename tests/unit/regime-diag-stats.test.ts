// EDGE-REGIME-DIAG-W1 CH2 — the estimation engine and the registered statistics, against independent arithmetic
// on a hand-built frame. Nothing here reads an archive.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as engine from '../../src/scripts/regime-diag/engine.js';
import { accumulate, blocksOf, bootstrap, compute, context, contrast, cwOfRows, effOfCw, joint, sequences, shuffleBlocks, shuffles, tail, type Ctx, type Stat } from '../../src/scripts/regime-diag/engine.js';
import { phaseLab, type Frame, type Lab } from '../../src/scripts/regime-diag/frame.js';
import { attainableOf, bhOf, boundsOf, floorClusters, kishOf, prims, seedsFor } from '../../src/scripts/regime-diag/prims.js';
import { mulberry32, type Rnd } from '../../src/scripts/regime-diag/rng.js';
import * as spec from '../../src/scripts/regime-diag/diag-spec.js';
import { A3_CELLS, a3CellId, a4, delta1, delta1ByHold, delta1Cells, e3, minorityShare, pick, primaryRows, registered, s2, trendDir, volLab, type A3Cell } from '../../src/scripts/regime-diag/stats.js';

const N_TF = 3, N_CS = spec.N_CS, { L_RANGING, L_UP, L_DOWN, L_VOLATILE, NO_LABEL } = spec;
const SPAWN = 60_000;

/** A random frame with runs of labels: 3 positions, 8 entries a day, every indicator independent of the label. */
function tiny(seed = 7, perPos = [240, 200, 160]): Frame {
  const rnd = mulberry32(seed), int = (n: number): number => Math.floor(rnd() * n);
  const nE = perPos.reduce((a, b) => a + b, 0), R = nE * N_TF;
  const ePos = new Uint8Array(nE), eM = new Int32Array(nE);
  const coins: Frame['coins'] = [];
  let e = 0;
  perPos.forEach((n, pos) => { const e0 = e; for (let i = 0; i < n; i++, e++) { ePos[e] = pos; eM[e] = i * 180 + int(170); } coins.push({ pos, series: [], keyA: [], eligible: 0, e0, e1: e }); });
  const has = new Uint8Array(R);
  for (let r = 0; r < R; r++) has[r] = rnd() < (r % N_TF === 2 ? 0.75 : 0.95) ? 1 : 0;
  const lab = (tailless: number): Lab => {
    const l: Lab = { lab: new Uint8Array(R).fill(NO_LABEL), conf: new Uint8Array(R) };
    for (const c of coins) for (let t = 0; t < N_TF; t++) {
      let cur = int(4), left = 1 + int(6);
      for (let en = c.e0; en < c.e1 - tailless; en++) {
        if (left === 0) { cur = (cur + 1 + int(3)) % 4; left = 1 + int(6); }
        left--;
        if (has[en * N_TF + t]) { l.lab[en * N_TF + t] = cur; l.conf[en * N_TF + t] = 35 + int(60); }
      }
    }
    return l;
  };
  const S = lab(0), B = lab(9), B7 = lab(4), B28 = lab(20);
  const phase = new Uint8Array(R);
  for (const c of coins) for (let t = 0; t < N_TF; t++) {
    let cur = int(3), left = 4 + int(20);
    for (let en = c.e0; en < c.e1; en++) { if (left-- === 0) { cur = (cur + 1 + int(2)) % 3; left = 4 + int(20); } if (has[en * N_TF + t]) phase[en * N_TF + t] = cur; }
  }
  const f64 = (fn: (r: number) => number): Float64Array => Float64Array.from({ length: R }, (_, r) => (has[r] ? fn(r) : NaN));
  const u8 = (fn: () => number): Uint8Array => Uint8Array.from({ length: R }, fn);
  const adx = f64(() => 15 + 35 * rnd()), adxSlope = f64(() => -3 + 6 * rnd()), slope = u8(() => int(3));
  for (let r = 0; r < R; r++) if (has[r] && S.lab[r] === L_RANGING && rnd() < 0.5) { adx[r] = 25.5 + 4 * rnd(); slope[r] = 0; adxSlope[r] = -1.5 - rnd(); }
  const out = new Uint8Array(nE * N_CS), odds = (): Float64Array => new Float64Array(nE * N_CS);
  const cells = { n: nE, out, aT: odds(), aS: odds(), bT: odds(), bS: odds() };
  for (let k = 0; k < out.length; k++) {
    const u = rnd();
    out[k] = u < 0.4 ? 0 : u < 0.65 ? 1 : u < 0.9 ? 2 : u < 0.97 ? 3 : 4;
    for (const a of [cells.aT, cells.aS, cells.bT, cells.bS]) a[k] = out[k] === 4 ? NaN : rnd();
  }
  return { win: { name: 'fit', lo: 0, hi: 60 * 1440 }, span: { t0Ms: 0, n: 60 * 1440 }, census: { panel: ['TA', 'TB', 'TC'], wCoin: [0.5, 0.3, 0.2], wTf: [0.2, 0.5, 0.3] }, outcomes: true,
    nE, ePos, eM, cells, has, S, B, B7, B28, phase, volLeg: f64(() => (rnd() < 0.05 ? NaN : 0.01 + 0.05 * rnd())), adx, adxSlope,
    plusDI: f64(() => 10 + int(12)), minusDI: f64(() => 10 + int(12)), vol: f64(() => 0.005 + 0.055 * rnd()), slope, structure: u8(() => int(3)), age: Int32Array.from({ length: R }, () => int(40)),
    drops: {}, coins };
}

const f = tiny();
const ctx = context(f);
const C = f.cells!;
const rowsOf = (keep: (r: number) => boolean): number[] => Array.from({ length: f.nE * N_TF }, (_, r) => r).filter((r) => f.has[r] === 1 && keep(r));
const close = (got: ArrayLike<number>, want: number[]): void => { expect(got.length).toBe(want.length); want.forEach((w, i) => { if (Number.isNaN(w)) expect(got[i]).toBeNaN(); else expect(got[i]).toBeCloseTo(w, 9); }); };

// ── independent arithmetic: plain weighted means, cell by cell ──────────────────────────────────────────────────
interface Obs { w: number; v: number[] }
/** Per output: Σ w·v / Σ w over the observations; NaN when there is none. */
const wmean = (o: Obs[], n: number): number[] => { const d = o.reduce((s, x) => s + x.w, 0); return Array.from({ length: n }, (_, i) => (o.length && d > 0 ? o.reduce((s, x) => s + x.w * x.v[i], 0) / d : NaN)); };
const avg = (cells: number[][], i: number): number => cells.reduce((s, c) => s + c[i], 0) / cells.length;
/** `dirAt(r)` is the direction read at row r; `mult(r)` the multiplicity of r's cluster. */
function bruteDelta1(dirAt: (r: number) => number, w: Float64Array, mult: (r: number) => number = () => 1): number[] {
  const cells: number[][] = [];
  for (let cell = 0; cell < spec.N_CELLS; cell++) {
    const obs: Obs[] = [];
    for (let r = 0; r < f.nE * N_TF; r++) {
      const d = f.has[r] ? dirAt(r) : 0;
      if (!d || mult(r) === 0) continue;
      const kL = Math.floor(r / N_TF) * N_CS + cell * 2, kW = d === 1 ? kL : kL + 1, kA = d === 1 ? kL + 1 : kL;
      if (C.out[kW] >= 3 || C.out[kA] >= 3) continue;
      const x = (C.out[kW] === 1 ? 1 : 0) - (C.out[kA] === 1 ? 1 : 0);
      obs.push({ w: w[r] * mult(r), v: [x, d === 1 ? x : 0, d === 2 ? x : 0, C.aT[kW] - C.aT[kA], C.bT[kW] - C.bT[kA]] });
    }
    cells.push(wmean(obs, 5));
  }
  const [S, U, D, A, B] = [0, 1, 2, 3, 4].map((i) => 100 * avg(cells, i));
  return [S, U, D, S - A, S - B];
}
function bruteS2(sel: (r: number) => boolean, w: Float64Array): number[] {
  const cs: number[][] = [];
  for (let k = 0; k < N_CS; k++) {
    const obs: Obs[] = [];
    for (const r of rowsOf(sel)) { const i = Math.floor(r / N_TF) * N_CS + k; if (C.out[i] < 3) obs.push({ w: w[r], v: [(C.out[i] === 2 ? 1 : 0) - C.bS[i], (C.out[i] === 2 ? 1 : 0) - C.aS[i]] }); }
    cs.push(wmean(obs, 2));
  }
  return [100 * avg(cs, 0), 100 * avg(cs, 1), 100 * avg(cs.filter((_, k) => k % 2 === 0), 0), 100 * avg(cs.filter((_, k) => k % 2 === 1), 0)];
}
/** E over the five holds of one shape, reading `sides(r)` of each selected row; value = I_T − line. */
function bruteE(shape: number, sel: (r: number) => boolean, sides: (r: number) => number[], w: Float64Array, line: Float64Array, perSide = false): number {
  const parts: number[][] = [];
  for (let h = 0; h < spec.N_HOLDS; h++) {
    for (const group of perSide ? [[0], [1]] : [[0, 1]]) {
      const obs: Obs[] = [];
      for (const r of rowsOf(sel)) for (const side of sides(r)) {
        if (!group.includes(side)) continue;
        const i = Math.floor(r / N_TF) * N_CS + spec.cellOf(shape, h) * 2 + side;
        if (C.out[i] < 3) obs.push({ w: w[r], v: [(C.out[i] === 1 ? 1 : 0) - line[i]] });
      }
      parts.push(wmean(obs, 1));
    }
  }
  return 100 * avg(parts, 0);
}

describe('regime-diag: the block shuffle (AC2.2)', () => {
  it('keeps label frequencies and run lengths exactly, moves every run whole, and destroys timing', () => {
    const rnd = mulberry32(11);
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rnd() * 300);
      const seq = new Uint8Array(n);
      for (let i = 0, cur = 0; i < n; i++) { if (i === 0 || rnd() < 0.3) cur = Math.floor(rnd() * 4); seq[i] = cur; }
      const bl = blocksOf(n, (i) => seq[i]);
      // the blocks are the maximal runs: they tile the sequence and neighbours differ
      expect(Array.from(bl.len).reduce((a, b) => a + b, 0)).toBe(n);
      for (let b = 0; b < bl.start.length; b++) {
        for (let d = 1; d < bl.len[b]; d++) expect(seq[bl.start[b] + d]).toBe(seq[bl.start[b]]);
        if (b > 0) expect(seq[bl.start[b]]).not.toBe(seq[bl.start[b] - 1]);
      }
      const order = new Int32Array(n), src = new Int32Array(n), landing = new Int32Array(bl.start.length);
      shuffleBlocks(bl, rnd, order, src, landing);
      const moved = Array.from(src, (i) => seq[i]);
      // a permutation of the places: frequencies kept exactly
      expect(Array.from(src).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      // every run lands whole, at `landing`, and the multiset of (label, run length) is unchanged
      const runs = (at: (b: number) => number): string[] => Array.from(bl.start, (_, b) => `${at(b)}x${bl.len[b]}`).sort();
      for (let b = 0; b < bl.start.length; b++) for (let d = 0; d < bl.len[b]; d++) expect(src[landing[b] + d]).toBe(bl.start[b] + d);
      expect(runs((b) => moved[landing[b]])).toEqual(runs((b) => seq[bl.start[b]]));
      expect(Array.from(landing).sort((a, b) => a - b)).toEqual(Array.from(bl.start, (_, k) => Array.from(order).slice(0, k).reduce((s, b) => s + bl.len[b], 0)));
    }
    // timing is destroyed: over many shuffles a run starts at many different places
    const seq = Uint8Array.from({ length: 60 }, (_, i) => Math.floor(i / 5) % 4), bl = blocksOf(60, (i) => seq[i]);
    const order = new Int32Array(60), src = new Int32Array(60), landing = new Int32Array(12), seen = new Set<number>();
    for (let b = 0; b < 200; b++) { shuffleBlocks(bl, rnd, order, src, landing); seen.add(landing[0]); }
    expect(seen.size).toBe(12);
    // a break splits a run of equal labels
    expect(Array.from(blocksOf(6, () => 1, (i) => i === 4).len)).toEqual([4, 2]);
  });
});

describe('regime-diag: clusters, weights and the cluster bootstrap', () => {
  it('clusters are coin × UTC day inside the coin; the variants change exactly clusters, strata or weights', () => {
    const key = (e: number): string => `${f.ePos[e]}|${Math.floor(f.eM[e] / 1440)}`;
    const groups = (c: Ctx, of: (e: number) => string): void => {
      const m = new Map<string, number>();
      for (let e = 0; e < f.nE; e++) { if (c.clOf[e] < 0) continue; if (!m.has(of(e))) m.set(of(e), c.clOf[e]); expect(c.clOf[e]).toBe(m.get(of(e))); }
      expect(new Set(m.values()).size).toBe(m.size);
      expect(c.nCl).toBe(m.size);
    };
    groups(ctx, key);
    expect([ctx.nCl, ctx.nStrata]).toEqual([30 + 25 + 20, 3]);
    for (let e = 0; e < f.nE; e++) expect(ctx.strata[ctx.clOf[e]]).toBe(f.ePos[e]);
    for (let r = 0; r < f.nE * N_TF; r++) expect(ctx.w[r]).toBe(f.census.wCoin[f.ePos[Math.floor(r / N_TF)]] * f.census.wTf[r % N_TF]);
    const day = context(f, 'day'), week = context(f, 'week'), unit = context(f, 'unit'), p13 = context(f, 'panel13', new Set([0, 2]));
    groups(day, (e) => String(Math.floor(f.eM[e] / 1440)));
    expect([day.nCl, day.nStrata, Array.from(new Set(day.strata))]).toEqual([30, 1, [0]]);
    groups(week, (e) => `${f.ePos[e]}|${Math.floor(f.eM[e] / 10_080)}`);
    expect(week.nCl).toBe(5 + 4 + 3);
    expect([Array.from(new Set(unit.w)), unit.nCl, Array.from(unit.clOf)]).toEqual([[1], ctx.nCl, Array.from(ctx.clOf)]);
    expect(Array.from(day.w)).toEqual(Array.from(ctx.w));
    for (let e = 0; e < f.nE; e++) expect(p13.clOf[e] >= 0).toBe(f.ePos[e] !== 1);
    expect(p13.nCl).toBe(30 + 20);
  });

  it('a resample re-evaluates the statistic on the resampled clusters: equal to recomputing from the rows', () => {
    const dir = trendDir(f, f.S, 60), s = delta1(f, 'A1.S', dir, f.S.lab);
    const acc = accumulate(f, ctx, s);
    close(acc.point, bruteDelta1((r) => dir[r], ctx.w));
    expect(acc.rows).toBe(rowsOf((r) => dir[r] > 0).length);
    const B = 6, reps = bootstrap(ctx, s, acc, B, mulberry32(99));
    // the same stream, replayed here: for each coin, as many draws as it has clusters carrying a row
    const rnd = mulberry32(99);
    for (let b = 0; b < B; b++) {
      const count = new Int32Array(ctx.nCl);
      for (let st = 0; st < ctx.nStrata; st++) {
        const list = Array.from({ length: ctx.nCl }, (_, c) => c).filter((c) => ctx.strata[c] === st && acc.cw[c] > 0);
        for (let i = 0; i < list.length; i++) count[list[Math.floor(rnd() * list.length)]]++;
        // each coin keeps its number of clusters
        expect(list.reduce((n, c) => n + count[c], 0)).toBe(list.length);
      }
      close(reps.subarray(b * 5, b * 5 + 5), bruteDelta1((r) => dir[r], ctx.w, (r) => count[ctx.clOf[Math.floor(r / N_TF)]]));
    }
    expect(acc.clusters).toBe(Array.from(acc.cw).filter((x) => x > 0).length);
  });

  it('a shuffle moves the label and what was decided with it; outcomes, weights and phases stay in place', () => {
    const dir = trendDir(f, f.S, 60), s = delta1(f, 'A1.S', dir, f.S.lab), g = a4(f, 'A4.S', trendDir(f, f.S), f.S.lab);
    for (const [stat, check] of [[s, (at: (r: number) => number) => bruteDelta1(at, ctx.w)], [g, null]] as Array<[Stat, ((at: (r: number) => number) => number[]) | null]>) {
      const B = 4, reps = shuffles(f, ctx, stat, B, mulberry32(5));
      const rnd = mulberry32(5), seqs = sequences(f, ctx);
      expect(seqs.length).toBe(9);
      for (let b = 0; b < B; b++) {
        const from = new Int32Array(f.nE * N_TF).fill(-1);
        for (const rows of seqs) {
          const bl = blocksOf(rows.length, (i) => stat.seq[rows[i]]), order = new Int32Array(rows.length), src = new Int32Array(rows.length);
          shuffleBlocks(bl, rnd, order, src);
          rows.forEach((r, i) => { from[r] = rows[src[i]]; expect(from[r] % N_TF).toBe(r % N_TF); expect(f.ePos[Math.floor(from[r] / N_TF)]).toBe(f.ePos[Math.floor(r / N_TF)]); });
        }
        if (check) close(reps.subarray(b * 5, b * 5 + 5), check((r) => (from[r] < 0 ? 0 : dir[from[r]])));
        else {
          // A4: the label direction travels, the phase is read where the row stands
          const d = trendDir(f, f.S);
          let W = 0, G = 0, L = 0, K = 0;
          for (const r of rowsOf((r) => d[from[r]] > 0 && f.phase[r] > 0)) { W += ctx.w[r]; if (d[from[r]] === f.phase[r]) G += ctx.w[r]; if (d[from[r]] === 1) L += ctx.w[r]; if (f.phase[r] === 1) K += ctx.w[r]; }
          const A = G / W, pL = L / W, pK = K / W;
          close(reps.subarray(b * 4, b * 4 + 4), [100 * (A - (pL * pK + (1 - pL) * (1 - pK))), 100 * (A - pK), 100 * (A - (1 - pK)), 100 * (A - 0.5)]);
        }
      }
    }
  });

  it('the shuffle tail counts the null values at or beyond the statistic, and an undefined shuffle against it', () => {
    expect(tail(Float64Array.from([1, 9, 2, 9, 3, 9, 4, 9]), 2, 3)).toEqual({ n: 4, mean: 2.5, pUpper: 3 / 5, pLower: 4 / 5 });
    expect(tail(Float64Array.from([1, NaN, 5]), 1, 3)).toEqual({ n: 3, mean: 3, pUpper: 3 / 4, pLower: 3 / 4 });
    expect(tail(new Float64Array(0), 1, 3).pUpper).toBe(1);
  });

  it('compute: bounds from the pinned primitives, effective clusters by Kish, the shuffle null, undefined replicates', { timeout: SPAWN }, () => {
    const s = delta1(f, 'A1.S', trendDir(f, f.S, 60), f.S.lab);
    const r = compute(f, ctx, s, { B: 200, alpha: 0.025, bootSeed: 3, shuffle: { B: 50, seed: 4 } });
    const acc = accumulate(f, ctx, s), reps = bootstrap(ctx, s, acc, 200, mulberry32(3));
    expect(Array.from(r.reps)).toEqual(Array.from(reps));
    for (let k = 0; k < 5; k++) {
      const col = Array.from({ length: 200 }, (_, b) => reps[b * 5 + k]).sort((a, b) => a - b);
      expect([r.lb[k], r.ub[k]]).toEqual([col[4], col[195]]); // nearest rank: the 5th smallest and the 5th largest of 200
    }
    const cw = Array.from(acc.cw).filter((x) => x > 0);
    expect(r.eff).toBeCloseTo(cw.reduce((a, b) => a + b, 0) ** 2 / cw.reduce((a, b) => a + b * b, 0), 9);
    expect([r.rows, r.clusters, r.B, r.undefinedReplicates, r.alpha, r.names]).toEqual([acc.rows, acc.clusters, 200, 0, 0.025, ['S', 'U', 'D', 'e_a', 'e_b']]);
    expect(r.shuffle).toEqual(tail(shuffles(f, ctx, s, 50, mulberry32(4)), 5, acc.point[0]));
    // under the shuffle the label carries no timing: the null centres near 0 while the bootstrap centres on the point
    expect(Math.abs(r.shuffle!.mean)).toBeLessThan(Math.abs(r.ub[0] - r.lb[0]));
    // a statistic with an empty cell on some resamples has no bounds
    const few = new Uint8Array(f.nE * N_TF);
    rowsOf((r2) => f.S.lab[r2] === L_UP).slice(0, 3).forEach((r2) => { few[r2] = 1; });
    const thin = compute(f, ctx, delta1(f, 'thin', few, f.S.lab), { B: 50, alpha: 0.025, bootSeed: 3 });
    expect([thin.rows, thin.shuffle]).toEqual([3, null]);
    expect(thin.lb.every((x) => Number.isNaN(x)) && thin.ub.every((x) => Number.isNaN(x))).toBe(true);
    const none = compute(f, ctx, delta1(f, 'none', new Uint8Array(f.nE * N_TF), f.S.lab), { B: 50, alpha: 0.025, bootSeed: 3, shuffle: { B: 5, seed: 1 } });
    expect([none.rows, none.clusters, none.eff, none.B, none.shuffle, none.point.every((x) => Number.isNaN(x))]).toEqual([0, 0, 0, 0, null, true]);
  });

  it('joint and contrast evaluate their parts on one resample', () => {
    const a = delta1(f, 'hi', trendDir(f, f.S, 60), f.S.lab), b = delta1(f, 'lo', trendDir(f, f.S, 0, 60), f.S.lab);
    const j = joint('J', [a, b]), c = contrast('C', a, b);
    expect(j.names).toEqual(['hi:S', 'hi:U', 'hi:D', 'hi:e_a', 'hi:e_b', 'lo:S', 'lo:U', 'lo:D', 'lo:e_a', 'lo:e_b']);
    const pa = accumulate(f, ctx, a), pb = accumulate(f, ctx, b), pj = accumulate(f, ctx, j), pc = accumulate(f, ctx, c);
    expect(Array.from(pj.point)).toEqual([...pa.point, ...pb.point]);
    expect(Array.from(pc.point)).toEqual([pa.point[0] - pb.point[0], pa.point[0], pb.point[0]]);
    expect(pj.rows).toBe(rowsOf((r) => spec.LABELS[f.S.lab[r]]?.startsWith('TRENDING') ?? false).length);
    const rj = bootstrap(ctx, j, pj, 3, mulberry32(8)), rc = bootstrap(ctx, c, pc, 3, mulberry32(8));
    for (let b2 = 0; b2 < 3; b2++) expect([rc[b2 * 3], rc[b2 * 3 + 1], rc[b2 * 3 + 2]]).toEqual([rj[b2 * 10] - rj[b2 * 10 + 5], rj[b2 * 10], rj[b2 * 10 + 5]]);
  });
});

// ── CH3 audit F1: a key reading's shuffle permutes that key's own label sequence (amendment 1, reading 16) ─────────
async function mutated<T>(lever: string, fn: (m: typeof engine) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-diag/engine.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}
const num = (a: number, b: number): number => a - b;
const bytes = (a: Float64Array): string => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
/** The rows of each coin × timeframe in time order, built here from the frame: every row, or only those `keep` admits. */
const seqsOf = (keep: (r: number) => boolean = () => true): number[][] =>
  f.coins.flatMap((c) => [0, 1, 2].map((t) => Array.from({ length: c.e1 - c.e0 }, (_, i) => (c.e0 + i) * N_TF + t).filter((r) => f.has[r] === 1 && ctx.clOf[Math.floor(r / N_TF)] >= 0 && keep(r))))
    .filter((rows) => rows.length > 0);
/** The block shuffle written out again: `B` draws over `seqs`, each cut into the maximal runs of the statistic's label. */
function reference(st: Stat, seqs: number[][], B: number, seed: number): Float64Array {
  const rnd = mulberry32(seed), nOut = st.names.length, reps = new Float64Array(B * nOut).fill(NaN), tot = new Float64Array(st.m);
  const bl = seqs.map((rows) => blocksOf(rows.length, (i) => st.seq[rows[i]]));
  for (let b = 0; b < B; b++) {
    tot.fill(0);
    seqs.forEach((rows, q) => {
      const order = new Int32Array(rows.length), src = new Int32Array(rows.length);
      shuffleBlocks(bl[q], rnd, order, src);
      for (let i = 0; i < rows.length; i++) st.add(rows[src[i]], rows[i], ctx.w[rows[i]], tot, 0);
    });
    st.evaluate(tot, 0, reps, b * nOut);
  }
  return reps;
}
/**
 * What reading 16 asks of one key reading: a draw places each row labelled under the key once and takes each once,
 * a row with no label under the key is never touched, and the null is the reference's on the key's own sequences.
 */
function ownSequence(shuffle: typeof shuffles, id: string, cell?: A3Cell): { unlabelled: number; labelled: number } {
  const st = registered(f, id, cell)!.stat;
  const all = seqsOf(), own = seqsOf((r) => st.seq[r] !== NO_LABEL), want = own.flat().sort(num);
  const B = 3, pairs: Array<[number, number]> = [];
  const spy: Stat = { ...st, add: (src, place, w, acc, off) => { pairs.push([src, place]); return st.add(src, place, w, acc, off); } };
  shuffle(f, ctx, spy, B, mulberry32(5));
  expect(pairs.filter(([src, place]) => st.seq[src] === NO_LABEL || st.seq[place] === NO_LABEL)).toEqual([]);
  expect(pairs.length).toBe(B * want.length);
  for (let b = 0; b < B; b++) {
    const draw = pairs.slice(b * want.length, (b + 1) * want.length);
    expect(draw.map(([, place]) => place).sort(num)).toEqual(want);
    expect(draw.map(([src]) => src).sort(num)).toEqual(want);
  }
  expect(bytes(shuffle(f, ctx, st, 40, mulberry32(9)))).toBe(bytes(reference(st, own, 40, 9)));
  return { unlabelled: all.flat().length - want.length, labelled: want.length };
}

describe('regime-diag: a key reading shuffles the key\'s own label sequence (CH3 audit F1; amendment 1, reading 16)', () => {
  const cellOf = (shape: number, group: number): A3Cell => A3_CELLS.find((c) => c.shape === shape && c.group === group)!;
  const KEYED: Array<[string, A3Cell?]> = [['A1.A'], ['A1.B'], ['A2.A'], ['A2.B'], ['A4.B'],
    ['A3.B', cellOf(0, 0)], ['A3.A', cellOf(0, 0)], ['A3.B', cellOf(1, 1)], ['A3.A', cellOf(1, 1)], ['A3.B', cellOf(2, 2)], ['A3.B', cellOf(0, 3)], ['A3.A', cellOf(0, 3)]];
  const SERVED: Array<[string, A3Cell?]> = [['A1.S'], ['A2.S'], ['A4.S'], ['A3.S', cellOf(0, 0)], ['A3.S', cellOf(2, 2)], ['A3.S', cellOf(0, 3)], ['A1.all'], ['A2.all'], ['A3.cells'],
    ...['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'].map((id): [string] => [id])];

  it('sequences: every row of a coin × timeframe in time order, or only the rows that carry a label under the key', () => {
    expect(sequences(f, ctx).map((r) => Array.from(r))).toEqual(seqsOf());
    for (const lab of [f.B.lab, f.B28.lab, phaseLab(f).lab, volLab(f).lab]) {
      const own = seqsOf((r) => lab[r] !== NO_LABEL);
      expect(own.flat().length).toBeLessThan(seqsOf().flat().length);
      expect(sequences(f, ctx, lab).map((r) => Array.from(r))).toEqual(own);
    }
    // the served label is on every row the frame has: its own sequences are the full ones
    expect(sequences(f, ctx, f.S.lab).map((r) => Array.from(r))).toEqual(seqsOf());
    // a coin × timeframe with no labelled row has no sequence
    const none = new Uint8Array(f.has.length).fill(NO_LABEL);
    seqsOf()[4].forEach((r) => { none[r] = L_UP; });
    expect(sequences(f, ctx, none).map((r) => Array.from(r))).toEqual([seqsOf()[4]]);
  });

  for (const [id, cell] of KEYED) {
    it(`${id}${cell ? ` in ${a3CellId(cell)}` : ''}: no row without a label under the key enters a draw, and the null is the key's own`, () => {
      const got = ownSequence(shuffles, id, cell);
      // the fixture has rows the key does not label, and rows it does: the check is not vacuous
      expect(got.unlabelled).toBeGreaterThan(0);
      expect(got.labelled).toBeGreaterThan(0);
    });
  }

  it('a key sequence with fewer than two runs stays in place: nothing is drawn for it', () => {
    const st = registered(f, 'A1.B')!.stat, own = seqsOf((r) => st.seq[r] !== NO_LABEL);
    // one label on the whole first sequence: one block
    const flat = Uint8Array.from(st.seq);
    own[0].forEach((r) => { flat[r] = L_UP; });
    const one: Stat = { ...st, seq: flat }, pairs: Array<[number, number]> = [];
    const spy: Stat = { ...one, add: (src, place, w, acc, off) => { pairs.push([src, place]); return one.add(src, place, w, acc, off); } };
    shuffles(f, ctx, spy, 2, mulberry32(3));
    for (const [src, place] of pairs) if (own[0].includes(place)) expect(src).toBe(place);
    expect(bytes(shuffles(f, ctx, one, 20, mulberry32(3)))).toBe(bytes(reference(one, own, 20, 3)));
  });

  it('a served reading is untouched: byte for byte the draws over every row, as before the key sequences were cut', () => {
    const all = seqsOf(), digest = createHash('sha256');
    for (const [id, cell] of SERVED) {
      const st = registered(f, id, cell)!.stat;
      expect(all.flat().filter((r) => st.seq[r] === NO_LABEL)).toEqual([]);
      const got = shuffles(f, ctx, st, 25, mulberry32(21));
      expect(bytes(got)).toBe(bytes(reference(st, all, 25, 21)));
      digest.update(id).update(Buffer.from(got.buffer, got.byteOffset, got.byteLength));
    }
    // the digest of these draws as the engine stood at c7b0b2e9, before this fix
    expect(digest.digest('hex')).toBe('32271e5a06cdcb5035169d93073a74fdba2731c7185d3eabf6e5247d8078fd95');
  });

  it('the proof: with the sequence widened back to every row (REGIME_DIAG_MUTATE=keyseq) the check is red; restored, green', async () => {
    await expect(mutated('keyseq', (m) => ownSequence(m.shuffles, 'A1.B'))).rejects.toThrow(/to deeply equal/);
    await expect(mutated('keyseq', (m) => ownSequence(m.shuffles, 'A2.A'))).rejects.toThrow(/to deeply equal/);
    expect(ownSequence(shuffles, 'A1.B').unlabelled).toBeGreaterThan(0);
  });
});

describe('regime-diag: the registered statistics', () => {
  const point = (id: string, cell?: (typeof A3_CELLS)[number]): { v: number[]; rows: number; names: string[] } => {
    const b = registered(f, id, cell)!;
    const a = accumulate(f, ctx, b.stat);
    return { v: Array.from(a.point), rows: a.rows, names: b.stat.names };
  };
  const tr = (r: number): number => (f.S.lab[r] === L_UP ? 1 : f.S.lab[r] === L_DOWN ? 2 : 0);
  const d1 = (keep: (r: number) => boolean): number[] => bruteDelta1((r) => (keep(r) ? tr(r) : 0), ctx.w);

  it('A1: Δ1 = U + D on TRENDING rows at confidence ≥ 60, with the paired deltas of the two lines; the keys change the label', () => {
    const a1 = point('A1.S');
    close(a1.v, d1((r) => f.S.conf[r] >= 60));
    expect(a1.v[0]).toBeCloseTo(a1.v[1] + a1.v[2], 9);
    expect(a1.rows).toBe(rowsOf((r) => tr(r) > 0 && f.S.conf[r] >= 60).length);
    close(point('A1.all').v, d1(() => true));
    close(point('A1.B').v, bruteDelta1((r) => (f.B.conf[r] >= 60 ? (f.B.lab[r] === L_UP ? 1 : f.B.lab[r] === L_DOWN ? 2 : 0) : 0), ctx.w));
    // CEILING: every row with a dated phase, the with-side is the phase, no confidence filter
    close(point('A1.A').v, bruteDelta1((r) => f.phase[r], ctx.w));
    expect(point('A1.A').rows).toBe(rowsOf((r) => f.phase[r] > 0).length);
    expect(Array.from(registered(f, 'A1.A')!.stat.seq)).toEqual(Array.from(phaseLab(f).lab));
    expect(registered(f, 'A1.B')!.stat.seq).toBe(f.B.lab);
    // by cell, for the timeframe × hold table
    const acc = accumulate(f, ctx, registered(f, 'A1.S')!.stat);
    expect(delta1Cells(acc.tot).reduce((s, x) => s + x, 0) / 45).toBeCloseTo(a1.v[0], 9);
    // by hold: the plain mean of the hold's nine cells; a hold with an undefined cell is undefined
    const tot = new Float64Array(spec.N_CELLS * 5);
    for (let sh = 0; sh < spec.N_SHAPES; sh++) for (let h = 0; h < spec.N_HOLDS; h++) {
      const o = spec.cellOf(sh, h) * 5;
      tot[o] = 2; tot[o + 1] = (2 * (10 * h + sh)) / 100 - 0.5; tot[o + 2] = 0.5; // Δ1 of the cell = 10·h + sh pp
    }
    const byHold = delta1ByHold(tot);
    expect(byHold).toHaveLength(5);
    byHold.forEach((x, h) => expect(x, `hold ${h}`).toBeCloseTo(10 * h + 4, 9));
    tot[spec.cellOf(3, 2) * 5] = 0;
    expect(delta1ByHold(tot).map((x) => Number.isNaN(x))).toEqual([false, false, true, false, false]);
    expect(delta1ByHold(acc.tot).reduce((s, x) => s + x, 0) / 5).toBeCloseTo(a1.v[0], 9);
  });

  it('A2: S2 over the 90 cell-sides on VOLATILE rows at confidence ≥ 70; CEILING reads the forward volatility leg', () => {
    close(point('A2.S').v, bruteS2((r) => f.S.lab[r] === L_VOLATILE && f.S.conf[r] >= 70, ctx.w));
    close(point('A2.all').v, bruteS2((r) => f.S.lab[r] === L_VOLATILE, ctx.w));
    close(point('A2.B').v, bruteS2((r) => f.B.lab[r] === L_VOLATILE && f.B.conf[r] >= 70, ctx.w));
    close(point('A2.A').v, bruteS2((r) => f.volLeg[r] > spec.VOL_LINE_CONF70, ctx.w));
    const v = volLab(f);
    for (const r of rowsOf(() => true)) expect([v.lab[r], v.conf[r]]).toEqual(Number.isNaN(f.volLeg[r]) ? [NO_LABEL, 0] : [f.volLeg[r] > 0.03 ? L_VOLATILE : L_RANGING, f.volLeg[r] > 0.03475 ? 100 : 0]);
    expect(point('A2.S').names).toEqual(['S', 'e_a', 'e_long', 'e_short']);
  });

  it('A3: E in each of the 36 cells, with its paired excesses; the keys of the selected cell', () => {
    expect(A3_CELLS.map(a3CellId).slice(0, 5)).toEqual(['S1|TRENDING-with', 'S1|TRENDING-against', 'S1|RANGING', 'S1|VOLATILE', 'S2|TRENDING-with']);
    expect(A3_CELLS).toHaveLength(spec.A3_FAMILY);
    const all = point('A3.cells');
    let o = 0;
    for (const cell of A3_CELLS) {
      const one = point('A3.S', cell);
      close(all.v.slice(o, o + one.v.length), one.v);
      expect(all.names.slice(o, o + one.v.length)).toEqual(one.names.map((n) => `${a3CellId(cell)}:${n}`));
      o += one.v.length;
      const s = cell.shape;
      if (cell.group < 2) {
        const side = (r: number): number[] => [(tr(r) === 1) === (cell.group === 0) ? 0 : 1];
        const E = bruteE(s, (r) => tr(r) > 0, side, ctx.w, C.aT), L = bruteE(s, (r) => tr(r) > 0, () => [0], ctx.w, C.aT), Sh = bruteE(s, (r) => tr(r) > 0, () => [1], ctx.w, C.aT);
        close(one.v, [E, bruteE(s, (r) => tr(r) > 0, side, ctx.w, C.bT), E - L, E - Sh, E - (L + Sh) / 2]);
      } else {
        const sel = (r: number): boolean => f.S.lab[r] === (cell.group === 2 ? L_RANGING : L_VOLATILE);
        const both = bruteE(s, sel, () => [0, 1], ctx.w, C.aT, true);
        close(one.v, [both, bruteE(s, sel, () => [0, 1], ctx.w, C.bT, true), bruteE(s, sel, () => [0], ctx.w, C.aT), bruteE(s, sel, () => [1], ctx.w, C.aT)]);
        expect(one.v[0]).toBeCloseTo((one.v[2] + one.v[3]) / 2, 9);
      }
    }
    expect(o).toBe(all.v.length);
    // the keys of a selected cell: TRENDING groups at any confidence, VOLATILE at the 0.03 line, RANGING has no CEILING
    const withCell = A3_CELLS[4], vol = A3_CELLS[7], rng = A3_CELLS[6];
    close(point('A3.A', withCell).v.slice(0, 1), [bruteE(1, (r) => f.phase[r] > 0, (r) => [f.phase[r] === 1 ? 0 : 1], ctx.w, C.aT)]);
    close(point('A3.B', withCell).v.slice(0, 1), [bruteE(1, (r) => f.B.lab[r] === L_UP || f.B.lab[r] === L_DOWN, (r) => [f.B.lab[r] === L_UP ? 0 : 1], ctx.w, C.aT)]);
    close(point('A3.A', vol).v.slice(0, 1), [bruteE(1, (r) => f.volLeg[r] > spec.VOL_LINE, () => [0, 1], ctx.w, C.aT, true)]);
    close(point('A3.B', rng).v.slice(0, 1), [bruteE(1, (r) => f.B.lab[r] === L_RANGING, () => [0, 1], ctx.w, C.aT, true)]);
    expect(registered(f, 'A3.A', rng)).toBeNull();
    expect(() => registered(f, 'A3.S')).toThrow(/fit-selected cell/);
  });

  it('A4: agreement with the phase minus chance agreement, on TRENDING rows with a dated phase', () => {
    for (const [id, lab] of [['A4.S', f.S], ['A4.B', f.B]] as Array<[string, Lab]>) {
      const d = (r: number): number => (lab.lab[r] === L_UP ? 1 : lab.lab[r] === L_DOWN ? 2 : 0);
      const rows = rowsOf((r) => d(r) > 0 && f.phase[r] > 0), W = rows.reduce((s, r) => s + ctx.w[r], 0);
      const share = (ok: (r: number) => boolean): number => rows.filter(ok).reduce((s, r) => s + ctx.w[r], 0) / W;
      const A = share((r) => d(r) === f.phase[r]), pL = share((r) => d(r) === 1), pK = share((r) => f.phase[r] === 1);
      const p = point(id);
      close(p.v, [100 * (A - (pL * pK + (1 - pL) * (1 - pK))), 100 * (A - pK), 100 * (A - (1 - pK)), 100 * (A - 0.5)]);
      expect(p.rows).toBe(rows.length);
    }
    expect(() => registered(f, 'A4.A')).toThrow(/not a row statistic/);
    expect(() => registered(f, 'A5.S')).toThrow(/not a row statistic/);
  });

  it('the component map: each row is its registered slice', () => {
    const young = point('M01');
    close(young.v, [...d1((r) => f.age[r] <= 14), ...d1((r) => f.age[r] > 14)]);
    expect(registered(f, 'M01')!.arms.map((a) => a.id)).toEqual(['young']);
    const buckets: Array<[string, number, number]> = [['M02', 18, 25], ['M03', 25, 30], ['M04', 30, 40], ['M05', 40, Infinity]];
    for (const [id, lo, hi] of buckets) {
      close(point(id).v, d1((r) => f.adx[r] > lo && f.adx[r] <= hi));
      expect(point(id).rows).toBe(rowsOf((r) => tr(r) > 0 && f.adx[r] > lo && f.adx[r] <= hi).length);
    }
    const two = (id: string, a: number[], b: number[]): void => { close(point(id).v, [a[0] - b[0], a[0], b[0]]); expect(registered(f, id)!.arms).toHaveLength(2); };
    two('M06', d1((r) => f.slope[r] === 2), d1((r) => f.slope[r] === 0));
    two('M10', d1((r) => f.S.conf[r] >= 60), d1((r) => f.S.conf[r] < 60));
    two('M11', bruteS2((r) => f.S.lab[r] === L_VOLATILE && f.S.conf[r] >= 70, ctx.w), bruteS2((r) => f.S.lab[r] === L_VOLATILE && f.S.conf[r] < 70, ctx.w));
    // row 7: the suppressed rows, with the direction the normal branch would give; an exact DI tie is excluded and counted
    const ex = (r: number): boolean => f.S.lab[r] === L_RANGING && f.adx[r] > 25 && f.adx[r] < 30 && f.slope[r] === 0 && f.adxSlope[r] < -1;
    const exDir = (r: number): number => (!ex(r) ? 0 : f.structure[r] === 1 ? 1 : f.structure[r] === 2 ? 2 : f.plusDI[r] > f.minusDI[r] ? 1 : f.plusDI[r] < f.minusDI[r] ? 2 : 0);
    const m07 = registered(f, 'M07')!;
    close(point('M07').v, bruteDelta1(exDir, ctx.w));
    expect(m07.counts.di_tie).toBe(rowsOf((r) => ex(r) && exDir(r) === 0).length);
    expect(m07.counts.di_tie).toBeGreaterThan(0);
    expect(point('M07').rows).toBe(rowsOf((r) => exDir(r) > 0).length);
    // row 8: direction from the structure, ±DI the other way
    const dis = (r: number): boolean => f.adx[r] > 25 && ((tr(r) === 1 && f.structure[r] === 1 && f.minusDI[r] > f.plusDI[r]) || (tr(r) === 2 && f.structure[r] === 2 && f.plusDI[r] > f.minusDI[r]));
    close(point('M08').v, d1(dis));
    expect(point('M08').rows).toBeGreaterThan(20);
    // row 9: the fixed line against a per coin × timeframe line that flags the same share at that timeframe
    const non = (r: number): boolean => f.S.lab[r] === L_RANGING || f.S.lab[r] === L_VOLATILE;
    const pct = new Set<number>();
    let fixedRows = 0;
    for (let t = 0; t < N_TF; t++) {
      const all = rowsOf((r) => r % N_TF === t && non(r)), q = all.filter((r) => f.vol[r] > 0.03).length / all.length;
      fixedRows += all.filter((r) => f.vol[r] > 0.03).length;
      for (let p = 0; p < 3; p++) {
        const mine = all.filter((r) => f.ePos[Math.floor(r / N_TF)] === p).sort((a, b) => f.vol[b] - f.vol[a] || a - b);
        mine.slice(0, Math.round(q * mine.length)).forEach((r) => pct.add(r));
      }
    }
    const m09 = registered(f, 'M09')!;
    two('M09', bruteS2((r) => non(r) && f.vol[r] > 0.03, ctx.w), bruteS2((r) => pct.has(r), ctx.w));
    expect(m09.arms.map((a) => accumulate(f, ctx, a).rows)).toEqual([fixedRows, pct.size]);
    expect(Math.abs(fixedRows - pct.size)).toBeLessThanOrEqual(9);
    // row 12: entries with a row at all three timeframes, TRENDING at confidence ≥ 60 at the timeframe read
    const all3 = (r: number): boolean => { const e = Math.floor(r / N_TF) * N_TF; return f.has[e] + f.has[e + 1] + f.has[e + 2] === 3; };
    const at = (t: number): number[] => d1((r) => r % N_TF === t && all3(r) && f.S.conf[r] >= 60);
    const m12 = point('M12');
    close(m12.v, [at(1)[0] - at(0)[0], at(1)[0] - at(2)[0], at(1)[0], at(0)[0], at(2)[0]]);
    expect(m12.names).toEqual(['theta_4h_1h', 'theta_4h_1d', '4h', '1h', '1d']);
    expect(registered(f, 'M12')!.arms.map((a) => a.id)).toEqual(['4h', '1h', '1d']);
    // every secondary id of the registry builds
    for (const id of spec.SECONDARY_IDS) expect(registered(f, id)!.stat.id).toBe(id);
    expect(() => registered(f, 'M13')).toThrow(/no row statistic/);
  });

  it('selection helpers and the minority share that bounds what an arm can attain', () => {
    expect(Array.from(trendDir(f, f.S, 60))).toEqual(Array.from({ length: f.nE * N_TF }, (_, r) => (f.has[r] && f.S.conf[r] >= 60 ? tr(r) : 0)));
    expect(Array.from(pick(f, f.S, L_VOLATILE, 0, 70))).toEqual(Array.from({ length: f.nE * N_TF }, (_, r) => (f.has[r] && f.S.lab[r] === L_VOLATILE && f.S.conf[r] < 70 ? 1 : 0)));
    const share = (rows: number[], up: (r: number) => boolean): number => { const W = rows.reduce((s, r) => s + ctx.w[r], 0), u = rows.filter(up).reduce((s, r) => s + ctx.w[r], 0); return Math.min(u, W - u) / W; };
    expect(minorityShare(f, ctx.w, 'A1.S')).toBeCloseTo(share(rowsOf((r) => tr(r) > 0 && f.S.conf[r] >= 60), (r) => tr(r) === 1), 12);
    expect(minorityShare(f, ctx.w, 'A1.all')).toBeCloseTo(share(rowsOf((r) => tr(r) > 0), (r) => tr(r) === 1), 12);
    expect(minorityShare(f, ctx.w, 'A3.S', A3_CELLS[1])).toBeCloseTo(share(rowsOf((r) => tr(r) > 0), (r) => tr(r) === 1), 12);
    expect(minorityShare(f, ctx.w, 'A4.S')).toBeCloseTo(share(rowsOf((r) => tr(r) > 0 && f.phase[r] > 0), (r) => f.phase[r] === 1), 12);
    expect([minorityShare(f, ctx.w, 'A2.S'), minorityShare(f, ctx.w, 'A3.S', A3_CELLS[2]), minorityShare(f, ctx.w, 'A5.S')]).toEqual([null, null, null]);
    const bare = { ...f, cells: null };
    expect(() => registered(bare, 'A1.S')).toThrow(/without outcomes/);
  });
});

describe('regime-diag: the label-free rows of a primary (the floor check made before any outcome)', () => {
  it('primaryRows are the rows the primary reads; their cluster weights and effective clusters are the reading\'s own', { timeout: SPAWN }, () => {
    const bare: Frame = { ...f, cells: null, outcomes: false };
    const tr = (r: number): boolean => f.S.lab[r] === L_UP || f.S.lab[r] === L_DOWN;
    const cases: Array<[string, A3Cell | undefined, (r: number) => boolean]> = [
      ['A1.S', undefined, (r) => tr(r) && f.S.conf[r] >= 60],
      ['A2.S', undefined, (r) => f.S.lab[r] === L_VOLATILE && f.S.conf[r] >= 70],
      ['A3.S', { shape: 2, group: 0 }, tr],
      ['A3.S', { shape: 2, group: 1 }, tr],
      ['A3.S', { shape: 4, group: 2 }, (r) => f.S.lab[r] === L_RANGING],
      ['A3.S', { shape: 0, group: 3 }, (r) => f.S.lab[r] === L_VOLATILE],
      ['A4.S', undefined, (r) => tr(r) && f.phase[r] !== 0],
    ];
    const cws = cases.map(([id, cell, keep]) => {
      const sel = primaryRows(bare, id, cell);
      expect(Array.from(sel, (x, r) => (x ? r : -1)).filter((r) => r >= 0)).toEqual(rowsOf(keep));
      return cwOfRows(bare, ctx, sel);
    });
    const effs = effOfCw(cws);
    cases.forEach(([id, cell], i) => {
      expect(Array.from(cws[i])).toEqual(Array.from(accumulate(f, ctx, registered(f, id, cell)!.stat).cw));
      const s = Array.from(cws[i]).filter((x) => x > 0);
      expect(effs[i]).toBeCloseTo(s.reduce((a, b) => a + b, 0) ** 2 / s.reduce((a, b) => a + b * b, 0), 9);
      expect(effs[i]).toBeGreaterThan(20);
    });
    // a reading that leaves positions out leaves their rows out of the clusters
    const p13 = context(f, 'panel13', new Set([0, 2]));
    expect(effOfCw([cwOfRows(bare, p13, primaryRows(bare, 'A1.S'))])[0]).toBeLessThan(effs[0]);
    expect(effOfCw([new Float64Array(4)])).toEqual([0]);
    expect(() => primaryRows(bare, 'A5.S')).toThrow(/no row set/);
    expect(() => primaryRows(bare, 'A3.S')).toThrow(/fit-selected cell/);
  });
});

describe('regime-diag: the pinned primitives through the bridge', () => {
  it('seeds, bounds, effective clusters, BH and the attainable bound are the module\'s own functions', { timeout: SPAWN }, () => {
    const arm = spec.seedArm('fit', 'A1.S', 'bootstrap');
    expect(arm).toBe('fit|A1.S|bootstrap');
    expect(seedsFor(spec.SEED, [arm, 'x'])).toEqual([arm, 'x'].map((a) => parseInt(createHash('sha256').update(`${spec.SEED}:${a}`).digest('hex').slice(0, 8), 16)));
    expect(boundsOf([Array.from({ length: 100 }, (_, i) => 100 - i), [5]], 0.025)).toEqual([[3, 98], [5, 5]]);
    expect(boundsOf([Array.from({ length: 20_000 }, (_, i) => i + 1)], 0.025 / 36)).toEqual([[14, 19_987]]);
    expect(kishOf([[1, 1, 1, 1], [10, 1], [0]])).toEqual([4, 121 / 101, 0]);
    expect(bhOf([0.001, 0.5, 0.04, 0.2], 0.1)).toEqual([true, false, true, false]);
    expect(attainableOf([0.5, 0.01, 0.4555])).toEqual([100, 2, 100 * 2 * 0.4555]);
    expect(floorClusters()).toBe(50);
    expect([seedsFor(spec.SEED, []), boundsOf([], 0.025), kishOf([]), bhOf([], 0.1), attainableOf([])]).toEqual([[], [], [], [], []]);
  });

  it('the permutation test is the module\'s own: an ordered relation is found, a constant level has no rho and p = 1', { timeout: SPAWN }, () => {
    type Perm = { rho: number | null; p: number; s_obs: number; centre: number };
    // 40 clusters of 6 rows; inside each cluster the level rises and the higher levels win
    const levels: number[] = [], wins: number[] = [], clusters: number[] = [];
    for (let c = 0; c < 40; c++) for (let k = 0; k < 6; k++) { levels.push(k % 3); wins.push(k % 3 === 2 || (k % 3 === 1 && c % 2 === 0) ? 1 : 0); clusters.push(c); }
    const op = { op: 'perm' as const, levels, wins, clusters, B: 200, seed: 7 };
    const [a, b, flat] = prims([op, op, { ...op, levels: levels.map(() => 1) }]) as Perm[];
    expect(a.rho).toBeGreaterThan(0.5);
    expect(a.s_obs).toBeGreaterThan(a.centre);
    expect(a.p).toBe(1 / 201);
    expect(b).toEqual(a);
    // a constant level: no rank correlation exists, and every permutation ties the observed sum
    expect(flat.rho).toBeNull();
    expect(flat.p).toBe(1);
    expect(flat.s_obs).toBe(flat.centre);
  });

  it('a failed call throws: an undefined replicate, an empty series, a level outside (0, 0.5), an unknown op, a missing script', { timeout: SPAWN }, () => {
    expect(() => boundsOf([[1, NaN, 3]], 0.025)).toThrow();
    expect(() => boundsOf([[]], 0.025)).toThrow();
    expect(() => boundsOf([[1, 2]], 0.6)).toThrow();
    expect(() => prims([{ op: 'nope' } as never])).toThrow();
    expect(() => seedsFor(spec.SEED, ['a'], '/nonexistent-repo')).toThrow();
    expect(() => spec.seedArm('fit', 'A9.S', 'bootstrap')).toThrow(/not in the statistic registry/);
  });

  it('the A3 shuffle count can reach the family level; the entry-level count could not', () => {
    expect(1 / (1 + spec.B_SHUFFLE)).toBeGreaterThan(spec.ALPHA / spec.A3_FAMILY);
    expect(1 / (1 + spec.B_SHUFFLE_A3)).toBeLessThanOrEqual(spec.ALPHA / spec.A3_FAMILY);
    expect(spec.statDef('A3.S').shuffle).toBe(spec.B_SHUFFLE_A3);
    expect(spec.STAT_IDS).toHaveLength(new Set(spec.STAT_IDS).size);
  });
});
