// tests/unit/regime-15m-measures.test.ts — EDGE-REGIME-15M-BACKTEST-W1 CH1: the 15m rows and the measures end to end
// on synthetic bars (test b), the function-level differential against T3's statistics, and the mutation proofs
// (test c): a 99-bar 15m window, swapped timeframe keys, pooled rows instead of day clusters, a flipped margin sign
// and a dropped baseline each turn a check red. Synthetic data only.
import '../fixtures/regime-15m/isolate.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aggregate, noGap } from '../../src/scripts/regime-diag/archive.js';
import { a5, flipFlops } from '../../src/scripts/regime-diag/bars.js';
import { ALPHA, REGIME_AGAINST_MIN_CONFIDENCE, TFS } from '../../src/scripts/regime-diag/diag-spec.js';
import { compute, context } from '../../src/scripts/regime-diag/engine.js';
import { N_TF, dayOf } from '../../src/scripts/regime-diag/frame.js';
import { served } from '../../src/scripts/regime-diag/replay.js';
import { a4, delta1, trendDir } from '../../src/scripts/regime-diag/stats.js';
import * as decide15 from '../../src/scripts/regime-15m/r15-decide.js';
import * as frame15 from '../../src/scripts/regime-15m/r15-frame.js';
import { recomputeT3Labels } from '../../src/scripts/regime-15m/r15-parity.js';
import * as spec15 from '../../src/scripts/regime-15m/r15-spec.js';
import * as stats15 from '../../src/scripts/regime-15m/r15-stats.js';
import { BASE, madeMeasures, madePre } from '../fixtures/regime-15m/made.js';
import { W_CENSUS, wLoad, world, type Built } from '../fixtures/regime-15m/world.js';

// Most tests here block the worker (the replay, the resamples, the bridge); one setImmediate per test lets vitest's
// RPC replies drain (the same hook, and the reason, as tests/unit/regime-diag-guard.test.ts).
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));

const B = 60, F = 5;
interface Mods { spec: typeof spec15; frame: typeof frame15; stats: typeof stats15; decide: typeof decide15 }
const NORMAL: Mods = { spec: spec15, frame: frame15, stats: stats15, decide: decide15 };
/** The sibling's modules loaded fresh with the mutation lever set, for one check; the lever is cleared after. */
async function under<T>(lever: string, fn: (m: Mods) => T): Promise<T> {
  process.env.REGIME_15M_MUTATE = lever;
  vi.resetModules();
  try {
    const m: Mods = {
      spec: await import('../../src/scripts/regime-15m/r15-spec.js'), frame: await import('../../src/scripts/regime-15m/r15-frame.js'),
      stats: await import('../../src/scripts/regime-15m/r15-stats.js'), decide: await import('../../src/scripts/regime-15m/r15-decide.js'),
    };
    expect(m.spec.MUTATE).toBe(lever);
    return fn(m);
  } finally {
    delete process.env.REGIME_15M_MUTATE;
    vi.resetModules();
  }
}
const opts = (m: Mods, run = 'main') => ({ B, alpha: ALPHA, seeds: m.stats.seedsOf(run), run });
const json = (x: unknown): string => JSON.stringify(x);

let w: Built;
beforeAll(() => { w = world(); }, 300_000);

// ── the checks the mutation proofs break, each green on the sibling as written ─────────────────────────────────

/** The 15m row of an entry is the served rule over the REGIME_15M_WINDOW_BARS 15m bars that end at the entry. */
function window15Holds(m: Mods): boolean {
  const r = m.frame.build15(w.f0, wLoad);
  const tf = { key: '15m', min: 15, n: spec15.REGIME_15M_WINDOW_BARS } as unknown as (typeof TFS)[number];
  let checked = 0, same = 0;
  for (const c of w.f0.coins) {
    const g = wLoad(c.pos).g as NonNullable<ReturnType<typeof wLoad>['g']>, b = aggregate(g, 15);
    for (let e = c.e0; e < c.e1; e += 7) {
      const at = w.f0.eM[e];
      if (!noGap(g, at - 100 * 15, at)) { if (r.has[e]) return false; continue; }
      let s;
      try { s = served(g, b, tf, at, W_CENSUS.panel[c.pos]); } catch { if (r.has[e]) return false; continue; }
      checked++;
      if (r.has[e] && r.S.lab[e] === s.label && r.S.conf[e] === s.confidence) same++;
    }
  }
  return checked > 50 && same === checked;
}
/** Every timeframe's measures are filed under their own key. */
function keysHold(m: Mods): boolean {
  const all = m.stats.measures(w.f, w.r15, w.keep, F, opts(m));
  return m.spec.TIMEFRAMES.every((t) => json(all.tfs.find((x) => x.tf === t.key)) === json(m.stats.tfMeasures(w.f, w.r15, w.keep, t, opts(m))));
}
/** A reading's clusters are coin × UTC day: one per coin-day that holds an entry. */
function clustersAreDays(m: Mods): boolean {
  const days = new Set<number>();
  for (let e = 0; e < w.f.nE; e++) days.add(w.f.ePos[e] * 100_000 + dayOf(w.f.eM[e]));
  return m.stats.ctxOf(w.f).nCl === days.size && days.size < w.f.nE;
}
/** A lower bound inside −δ holds: LB(θ) = −0.6 δ for A4 and Δ1, every other criterion met. */
function marginSignHolds(m: Mods): boolean {
  const d = m.decide.decide(madeMeasures({ ...BASE, a4Theta: { point: 0, lb: -3 }, d1Theta: { point: 0, lb: -2.4 } }), madePre(), true);
  return d.state === 'PASS' && d.criteria.slice(0, 2).every((c) => c.holds);
}
/** Every rate sits beside its three naive baselines on the same rows. */
function baselinesHold(m: Mods): boolean {
  const all = m.stats.measures(w.f, w.r15, w.keep, F, opts(m));
  return all.tfs.every((t) => [t.a4.baselines, t.d1.baselines, t.flip_flops.baselines].every((b) => json(Object.keys(b)) === json(['always_up', 'always_down', 'coin'])));
}

describe('regime-15m: the 15m rows and the measures on synthetic bars (test b)', () => {
  it('a 15m row is the served rule over the 100 15m bars that end at the entry, where the grid has them', { timeout: 120_000 }, () => {
    expect(window15Holds(NORMAL)).toBe(true);
    // a row exists only where the 1 m grid is unbroken over the window: never where it is not
    for (let e = 0; e < w.f0.nE; e++) if (w.r15.has[e]) expect(noGap(wLoad(w.f0.ePos[e]).g as never, w.f0.eM[e] - 1500, w.f0.eM[e])).toBe(true);
  });

  it('the comparison rows are the entries labelled at all four timeframes', () => {
    let n = 0;
    for (let e = 0; e < w.f0.nE; e++) {
      const all4 = w.r15.has[e] === 1 && [0, 1, 2].every((t) => w.f0.has[e * N_TF + t] === 1);
      expect(w.keep[e]).toBe(all4 ? 1 : 0);
      n += w.keep[e];
    }
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(w.f0.nE);
  });

  it('the floors are written from labels alone, before any outcome exists', () => {
    expect(w.f0.cells).toBeNull();
    const pre = stats15.preOf(w.f0, w.r15, w.keep, F);
    expect(pre.tfs.map((t) => t.tf)).toEqual(['15m', '1h', '4h', '1d']);
    expect(pre.comparison_entries).toBe(w.keep.reduce((s, x) => s + x, 0));
    // the world's 1d key A dates no phase on the comparison rows: A4 at 1d is under the floor, and named
    expect(pre.floor_ok).toBe(false);
    expect(pre.floor_failures).toEqual(['1d A4: 0 below the floor of 5']);
    expect(stats15.preOf(w.f0, w.r15, w.keep, 0).floor_ok).toBe(true);
  });

  it('every measure for all four timeframes, each rate beside always-up, always-down and a coin flip', { timeout: 120_000 }, () => {
    const m = stats15.measures(w.f, w.r15, w.keep, F, opts(NORMAL));
    expect(m.tfs.map((t) => t.tf)).toEqual(['15m', '1h', '4h', '1d']);
    for (const t of m.tfs) {
      expect(Object.keys(t), t.tf).toEqual(['tf', 'a4', 'd1', 'flip_flops', 'lag', 'runs']);
      for (const b of [t.a4.baselines, t.d1.baselines, t.flip_flops.baselines]) expect(Object.keys(b)).toEqual(['always_up', 'always_down', 'coin']);
      // A4's fixed baselines are p_K, 1 − p_K and 50 %; Δ1's are U − D, D − U and 0 (T3 §4.7)
      if (Number.isFinite(t.a4.agreement.point)) {
        expect(t.a4.baselines.always_up + t.a4.baselines.always_down).toBeCloseTo(100, 9);
        expect(t.a4.agreement.point - t.a4.excess.always_up.point).toBeCloseTo(t.a4.baselines.always_up, 9);
      }
      expect([t.d1.baselines.always_up, t.d1.baselines.coin]).toEqual([t.d1.U.point - t.d1.D.point, 0]);
      expect(t.d1.by_hold).toHaveLength(5);
      const min = spec15.TIMEFRAMES.find((x) => x.key === t.tf)?.min as number;
      if (t.lag.median_bars !== null) expect(t.lag.median_hours).toBeCloseTo((t.lag.median_bars * min) / 60, 12);
    }
    // 15m has finite measures on the world: A4, Δ1, flip-flops, a lag and a run length
    const q = m.tfs[0];
    expect([q.a4.agreement.point, q.d1.delta1.point, q.flip_flops.per_1000, q.lag.median_bars, q.runs.medianLen].every((x) => typeof x === 'number' && Number.isFinite(x))).toBe(true);
    // the three key readings and their diagnosis
    expect(m.keys.map((k) => k.key)).toEqual(['CEILING', 'NO_LAG', 'SERVED']);
    expect(['NO_ROOM', 'INPUTS', 'LAG', 'none']).toContain(m.diagnosis);
  });

  it('the paired readings: θ is the 15m arm minus the 1h arm of one resample, and each arm is that timeframe\'s own measure', { timeout: 120_000 }, () => {
    const m = stats15.measures(w.f, w.r15, w.keep, F, opts(NORMAL));
    const q = m.tfs[0], h = m.tfs[1];
    expect(m.a4_pair.arm15.point).toBe(q.a4.agreement.point);
    expect(m.a4_pair.arm1h.point).toBe(h.a4.agreement.point);
    expect(m.a4_pair.theta.point).toBeCloseTo(q.a4.agreement.point - h.a4.agreement.point, 9);
    expect(m.d1_pair.arm15.point).toBe(q.d1.delta1.point);
    expect(m.d1_pair.arm1h.point).toBe(h.d1.delta1.point);
    expect(m.d1_pair.theta.point).toBeCloseTo(q.d1.delta1.point - h.d1.delta1.point, 9);
    expect(m.a4_pair.theta.lb).toBeLessThanOrEqual(m.a4_pair.theta.point);
    // one resample of the clusters behind both arms: the pair's rows are both timeframes' rows
    expect(m.d1_pair.rows).toBe(q.d1.rows + h.d1.rows);
  });
});

describe('regime-15m: on a T3 timeframe the sibling reads T3\'s own statistics (function-level differential)', () => {
  it('A4 and Δ1 on a view are T3\'s a4 and delta1 on the frame\'s own rows, bit for bit: point, bounds, rows, clusters', { timeout: 120_000 }, () => {
    const ctx = context(w.f), seed = 12345;
    TFS.forEach((tf, t) => {
      const v = frame15.viewOf(w.f, w.r15, tf.key, null, w.keep), vctx = stats15.ctxOf(v);
      const onRows = (r: number): boolean => r % N_TF === t && w.keep[Math.floor(r / N_TF)] === 1;
      const pairs: Array<[unknown, unknown]> = [
        [compute(v, vctx, stats15.a4Stat(v, 'x', 0), { B, alpha: ALPHA, bootSeed: seed }), compute(w.f, ctx, a4(w.f, 'x', trendDir(w.f, w.f.S, 0, 101, onRows), w.f.S.lab), { B, alpha: ALPHA, bootSeed: seed })],
        [compute(v, vctx, stats15.d1Stat(v, 'x', 0), { B, alpha: ALPHA, bootSeed: seed }), compute(w.f, ctx, delta1(w.f, 'x', trendDir(w.f, w.f.S, REGIME_AGAINST_MIN_CONFIDENCE, 101, onRows), w.f.S.lab), { B, alpha: ALPHA, bootSeed: seed })],
      ];
      for (const [mine, t3] of pairs) {
        const pick = (r: unknown) => { const x = r as { point: number[]; lb: number[]; ub: number[]; rows: number; clusters: number; eff: number; undefinedReplicates: number }; return json([x.point, x.lb, x.ub, x.rows, x.clusters, x.eff, x.undefinedReplicates]); };
        expect(pick(mine), tf.key).toBe(pick(t3));
      }
    });
  });

  it('flip-flops, the lag and the runs of 1h, 4h and 1d are T3\'s tables (flipFlops, lagOf, A5\'s perTf)', { timeout: 120_000 }, () => {
    const m = stats15.measures(w.f, w.r15, w.keep, F, opts(NORMAL)), t3 = recomputeT3Labels(w.f, B);
    const perTf = a5(w.f, 'A5.S', 0, { B: 0, alpha: ALPHA, bootSeed: 0, shuffleB: 0, shuffleSeed: 0 }).perTf;
    TFS.forEach((tf, t) => {
      const mine = m.tfs.find((x) => x.tf === tf.key) as stats15.TfMeasures;
      let bars = 0, changes = 0, flipflops = 0;
      for (const c of w.f.coins) { const x = flipFlops(c.series[t], w.f.win); bars += x.bars; changes += x.changes; flipflops += x.flipflops; }
      expect(json([mine.flip_flops.bars, mine.flip_flops.changes, mine.flip_flops.flipflops, mine.flip_flops.per_1000]), tf.key).toBe(json([bars, changes, flipflops, (1000 * flipflops) / bars]));
      expect(json([mine.lag.turns, mine.lag.censored, mine.lag.median_bars]), tf.key).toBe(json([t3.lag[t].turns, t3.lag[t].censored, t3.lag[t].median]));
      const { tf: _k, ...runs } = perTf[t];
      void _k;
      expect(json(mine.runs), tf.key).toBe(json(runs));
    });
  });
});

describe('regime-15m: the mutation proofs (test c) — each break turns its check red', () => {
  it('a 99-bar 15m window', { timeout: 180_000 }, async () => {
    expect(window15Holds(NORMAL)).toBe(true);
    expect(await under('bars99', (m) => { expect(m.spec.TF15.n).toBe(99); return window15Holds(m); })).toBe(false);
  });

  it('swapped timeframe keys', { timeout: 180_000 }, async () => {
    expect(keysHold(NORMAL)).toBe(true);
    expect(await under('swap', keysHold)).toBe(false);
  });

  it('pooled rows instead of day clusters', { timeout: 60_000 }, async () => {
    expect(clustersAreDays(NORMAL)).toBe(true);
    expect(await under('pooled', clustersAreDays)).toBe(false);
  });

  it('a flipped margin sign', { timeout: 60_000 }, async () => {
    expect(marginSignHolds(NORMAL)).toBe(true);
    expect(await under('sign', marginSignHolds)).toBe(false);
  });

  it('a dropped baseline', { timeout: 180_000 }, async () => {
    expect(baselinesHold(NORMAL)).toBe(true);
    expect(await under('baseline', baselinesHold)).toBe(false);
  });

  it('the lever is test-only: each named break is registered, and an unknown one changes nothing', () => {
    expect(spec15.MUTATIONS).toEqual(['bars99', 'swap', 'pooled', 'sign', 'baseline']);
    expect(spec15.MUTATE).toBe('');
  });
});
