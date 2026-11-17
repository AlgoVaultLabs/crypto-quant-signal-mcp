// tests/unit/regime-challenge-stats.test.ts — EDGE-REGIME-CHALLENGE-R1-W1 CH1: the paired statistics, the guards,
// Holm, the power arithmetic, the selection rule and the decision rule. Both arms of a pair are recomputed on
// every resample; a paired-only reading holds neither arm. Synthetic series only: nothing here reads an archive.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { a5 } from '../../src/scripts/regime-diag/bars.js';
import { TFS } from '../../src/scripts/regime-diag/diag-spec.js';
import { compute, context, contrast, cwOfRows, effOfCw, type Ctx } from '../../src/scripts/regime-diag/engine.js';
import { buildFrames, parseCensus, type Frame } from '../../src/scripts/regime-diag/frame.js';
import { delta1 } from '../../src/scripts/regime-diag/stats.js';
import { decisionOf, selectionOf, type PrescoreRow } from '../../src/scripts/regime-challenge/challenge-run.js';
import { C3_TF, CANDIDATES, SERVED_DIAL, SERVED_TF, coinDaysOf, JUDGE, PRESCORE, type Candidate, type Dial } from '../../src/scripts/regime-challenge/challenge-spec.js';
import { challengerColumns, type ChallengerCols } from '../../src/scripts/regime-challenge/challenger-replay.js';
import {
  a4Difference, a4Guard, a5Guard, a5Ratio, armSums, coverageGuard, coverageRatio, deltaDelta1, holm, pairOf, powerAt, supportOf,
  type Pair, type PairedReading,
} from '../../src/scripts/regime-challenge/paired-stats.js';
import { SYN_CENSUS_TEXT, SYN_HOLD, SYN_SPAN, synFullLoad } from '../fixtures/regime-challenge/synth-challenge.js';

const N_TF = TFS.length;
const cand = (id: Candidate['id']): Candidate => CANDIDATES.find((c) => c.id === id) as Candidate;
const C1_7 = cand('C1.7'), C2 = cand('C2'), C3 = cand('C3');
/** A candidate whose dial is the served rule's: its challenger arm IS the served arm. */
const SAME: Candidate = { ...C1_7, dial: SERVED_DIAL };
const OPTS = { B: 200, alpha: 0.025, seed: 20_261_117 };
const reading = (over: Partial<PairedReading>): PairedReading => ({ point: 0, lb: 0, ub: 0, alpha: 0.025, rows: 1, clusters: 1, eff: 1, B: 1, undefinedReplicates: 0, arms: null, reps: [], ...over });
/** 1,000 replicates, `neg` of them −1 and the rest +1: at one-sided level a, the bound is the ceil(1000·a)-th smallest. */
const repsWith = (neg: number): number[] => Array.from({ length: 1000 }, (_, i) => (i < neg ? -1 : 1));
// One setImmediate per test lets the worker answer vitest between long synchronous tests (the measurement behind
// this hook is in tests/unit/regime-diag-guard.test.ts).
afterEach(() => new Promise<void>((done) => { setImmediate(done); }));

describe('regime-challenge: the paired statistics', () => {
  let f: Frame, ctx: Ctx, cols: ChallengerCols, p7: Pair, p2: Pair, p3: Pair, same: Pair;
  beforeAll(() => {
    f = buildFrames(SYN_SPAN, [SYN_HOLD], parseCensus(SYN_CENSUS_TEXT), synFullLoad, { outcomes: true, seed: 'challenge-stats-test' })[0];
    cols = challengerColumns(f, synFullLoad, [SERVED_DIAL, C1_7.dial as Dial, C2.dial as Dial]);
    ctx = context(f);
    p7 = pairOf(f, C1_7, cols); p2 = pairOf(f, C2, cols); p3 = pairOf(f, C3, null); same = pairOf(f, SAME, cols);
  }, 300_000);

  it('a pair holds both arms on the same entries: C1 and C2 on every row, C3 on the entries with all three timeframes', { timeout: 60_000 }, () => {
    for (const p of [p7, p2]) {
      expect(Array.from(p.chalRows)).toEqual(Array.from(f.has));
      expect(Array.from(p.servRows)).toEqual(Array.from(f.has));
      expect(p.servLab).toBe(f.S);
      expect(p.chalLab).not.toBe(f.S);
      expect(p.chalSeqs.length).toBe(f.coins.length * N_TF);
      expect(p.servSeqs.length).toBe(f.coins.length * N_TF);
    }
    let both = 0, c60 = 0, s60 = 0;
    for (let r = 0; r < f.has.length; r++) {
      const e = Math.floor(r / N_TF) * N_TF, all3 = f.has[e] === 1 && f.has[e + 1] === 1 && f.has[e + 2] === 1;
      expect(p3.chalRows[r]).toBe(all3 && r % N_TF === C3_TF ? 1 : 0);
      expect(p3.servRows[r]).toBe(all3 && r % N_TF === SERVED_TF ? 1 : 0);
      if (p3.chal60[r]) { expect(r % N_TF).toBe(C3_TF); expect(all3).toBe(true); c60++; }
      if (p3.serv60[r]) { expect(r % N_TF).toBe(SERVED_TF); expect(all3).toBe(true); s60++; }
      if (all3 && r % N_TF === 0) both++;
    }
    expect(both).toBeGreaterThan(100);
    expect(c60).toBeGreaterThan(10);
    expect(s60).toBeGreaterThan(10);
    // the two arms of C3 are the same entries, one row each
    expect(p3.chalRows.reduce((a, b) => a + b, 0)).toBe(p3.servRows.reduce((a, b) => a + b, 0));
    expect(p3.chalSeqs.map((q) => q.t)).toEqual(f.coins.map(() => C3_TF));
    expect(p3.servSeqs.map((q) => q.t)).toEqual(f.coins.map(() => SERVED_TF));
    expect(() => pairOf(f, C1_7, null)).toThrow(/has no challenger column/);
    expect(() => pairOf(f, cand('C1.10'), cols)).toThrow(/has no challenger column/);
  });

  it('ΔΔ1 is Δ1(challenger) − Δ1(served), each arm the pinned A1 statistic under its own label and confidence', { timeout: 60_000 }, () => {
    const r = deltaDelta1(f, ctx, p7, { ...OPTS, arms: true });
    const one = (dir: Uint8Array, seq: Uint8Array): number => compute(f, ctx, delta1(f, 'x', dir, seq), { B: 0, alpha: 0.025, bootSeed: 1 }).point[0];
    const chal = one(p7.chal60, p7.chalLab.lab), serv = one(p7.serv60, p7.servLab.lab);
    expect(Number.isFinite(chal) && Number.isFinite(serv)).toBe(true);
    expect(chal).not.toBe(serv);
    expect(r.arms).toEqual({ challenger: chal, served: serv });
    expect(r.point).toBe(chal - serv);
    expect(r.B).toBe(OPTS.B);
    expect(r.reps.length).toBe(OPTS.B);
    expect(r.lb).toBeLessThanOrEqual(r.ub);
  });

  it('both arms are recomputed on every resample: each replicate is that resample\'s challenger minus that resample\'s served', { timeout: 60_000 }, () => {
    const s = contrast('x', delta1(f, 'challenger', p7.chal60, p7.chalLab.lab), delta1(f, 'served', p7.serv60, p7.servLab.lab));
    const full = compute(f, ctx, s, { B: OPTS.B, alpha: OPTS.alpha, bootSeed: OPTS.seed });
    const r = deltaDelta1(f, ctx, p7, { ...OPTS, arms: true });
    const a = new Set<number>(), b = new Set<number>();
    let finite = 0;
    for (let i = 0; i < OPTS.B; i++) {
      const theta = full.reps[i * 3], x = full.reps[i * 3 + 1], y = full.reps[i * 3 + 2];
      expect(r.reps[i]).toBe(theta);
      if (!Number.isFinite(theta)) continue;
      finite++;
      expect(theta).toBe(x - y);
      a.add(x); b.add(y);
    }
    expect(finite).toBeGreaterThan(OPTS.B / 2);
    // neither arm is a constant carried across the resamples
    expect(a.size).toBeGreaterThan(finite / 2);
    expect(b.size).toBeGreaterThan(finite / 2);
  });

  it('a paired-only reading holds the paired quantity and neither arm, and is the same quantity', { timeout: 60_000 }, () => {
    for (const read of [deltaDelta1, a4Difference]) {
      const withArms = read(f, ctx, p7, { ...OPTS, arms: true }), only = read(f, ctx, p7, { ...OPTS, arms: false });
      expect(only.arms).toBeNull();
      expect(withArms.arms).not.toBeNull();
      expect([only.point, only.lb, only.ub, only.rows, only.clusters, only.eff]).toEqual([withArms.point, withArms.lb, withArms.ub, withArms.rows, withArms.clusters, withArms.eff]);
      expect(only.reps).toEqual(withArms.reps);
    }
  });

  it('a challenger that is the served rule has a paired quantity of exactly 0 (ΔΔ1, A4) and 1 (A5), on every resample', { timeout: 60_000 }, () => {
    for (const read of [deltaDelta1, a4Difference]) {
      const r = read(f, ctx, same, { ...OPTS, arms: true });
      expect(r.point).toBe(0);
      expect(r.arms?.challenger).toBe(r.arms?.served);
      const finite = r.reps.filter(Number.isFinite);
      expect(finite.length).toBeGreaterThan(OPTS.B / 2);
      expect(finite.every((x) => x === 0)).toBe(true);
    }
    const arm = armSums(f.census, same.servSeqs, 50, 7);
    const r5 = a5Ratio(f.census, 'x', arm, arm, { ...OPTS, arms: true });
    expect([r5.point, r5.lb, r5.ub]).toEqual([1, 1, 1]);
    expect(r5.reps.every((x) => x === 1)).toBe(true);
    expect(r5.arms).toEqual({ challenger: arm.point, served: arm.point });
  });

  it('an arm\'s A5 sums are the pinned A5 statistic: the same runs, references and R5', { timeout: 60_000 }, () => {
    const arm = armSums(f.census, p7.servSeqs, 50, 7);
    const pinned = a5({ win: f.win, census: f.census, coins: f.coins }, 'x', 0, { B: 20, alpha: 0.025, bootSeed: 1, shuffleB: 50, shuffleSeed: 7 });
    expect(arm.runs).toBeGreaterThan(20);
    expect([arm.runs, arm.censored, arm.unreferenced, arm.clusters.size]).toEqual([pinned.runs, pinned.censored, pinned.unreferenced, pinned.clusters]);
    expect(arm.point).toBeCloseTo(pinned.point, 12);
    // the challenger's series is another series: its runs differ
    const chal = armSums(f.census, p7.chalSeqs, 50, 8);
    expect(chal.runs).not.toBe(arm.runs);
    const r = a5Ratio(f.census, 'x', chal, arm, { ...OPTS, arms: false });
    expect(r.point).toBeCloseTo(chal.point / arm.point, 12);
    expect(r.arms).toBeNull();
    expect(r.reps.length).toBe(OPTS.B);
    expect(r.clusters).toBe(new Set([...chal.clusters.keys(), ...arm.clusters.keys()]).size);
    expect(r.lb).toBeLessThanOrEqual(r.ub);
    // no run at all: nothing to read, and no bound
    const none = a5Ratio(f.census, 'x', armSums(f.census, [], 50, 8), arm, { ...OPTS, arms: false });
    expect([none.point, none.lb, none.ub].every(Number.isNaN)).toBe(true);
  });

  it('coverage is the challenger\'s TRENDING ≥ 60 row share over the served\'s, in design weights', { timeout: 60_000 }, () => {
    expect(coverageRatio(ctx.w, same)).toBe(1);
    const share = (sel: Uint8Array, of: Uint8Array): number => {
      let s = 0, all = 0;
      for (let r = 0; r < sel.length; r++) { if (of[r]) all += ctx.w[r]; if (sel[r]) s += ctx.w[r]; }
      return s / all;
    };
    for (const p of [p7, p2, p3]) {
      const want = share(p.chal60, p.chalRows) / share(p.serv60, p.servRows);
      expect(Number.isFinite(want)).toBe(true);
      expect(coverageRatio(ctx.w, p)).toBeCloseTo(want, 12);
    }
    // C2 moves the side of a row and never its confidence or whether it trends, but for an exact ±DI tie
    expect(coverageRatio(ctx.w, p2)).toBeLessThanOrEqual(1);
    const empty: Pair = { ...p7, serv60: new Uint8Array(f.has.length) };
    expect(coverageRatio(ctx.w, empty)).toBeNaN();
  });

  it('identifiability is read from the labels alone: effective clusters and the attainable range of each arm', { timeout: 60_000 }, () => {
    const s = supportOf(f, ctx, p7, 5);
    const eff = effOfCw([cwOfRows(f, ctx, p7.chal60), cwOfRows(f, ctx, p7.serv60)]);
    expect([s.challenger.eff, s.served.eff]).toEqual(eff);
    for (const arm of [s.challenger, s.served]) {
      expect(arm.share).toBeGreaterThan(0);
      expect(arm.share).toBeLessThanOrEqual(0.5);
      expect(arm.bound).toBeCloseTo(200 * arm.share, 9);
    }
    expect(s.identifiable).toBe(s.challenger.ok && s.served.ok);
    expect(s.identifiable).toBe(true);
    // a floor the arms do not reach
    const high = supportOf(f, ctx, p7, 1_000_000);
    expect([high.identifiable, high.challenger.ok, high.served.ok]).toEqual([false, false, false]);
    expect(high.challenger.cause).toBe('fewer than 1000000 effective clusters');
    // an arm with one side only has no attainable range
    const oneSide: Pair = { ...p7, chal60: p7.chal60.map((d) => (d ? 1 : 0)) };
    const narrow = supportOf(f, ctx, oneSide, 5);
    expect([narrow.challenger.share, narrow.challenger.bound, narrow.challenger.ok, narrow.identifiable]).toEqual([0, 0, false, false]);
    expect(narrow.challenger.cause).toBe('the attainable range is below 3 pp');
    expect(narrow.served.ok).toBe(true);
    // an arm with no row at all
    const noRows: Pair = { ...p7, chal60: new Uint8Array(f.has.length) };
    const none = supportOf(f, ctx, noRows, 5);
    expect([none.challenger.eff, none.challenger.bound, none.challenger.ok, none.identifiable]).toEqual([0, null, false, false]);
  });
});

describe('regime-challenge: the guards, Holm, power, selection and decision', () => {
  it('the guards fail only when the interval lies wholly past the line, and an unreadable guard is not a pass', { timeout: 60_000 }, () => {
    expect(a4Guard(reading({ ub: -3.01 }))).toBe('fails');
    expect(a4Guard(reading({ ub: -3 }))).toBe('holds');
    expect(a4Guard(reading({ lb: -9, ub: -2.99 }))).toBe('holds');
    expect(a4Guard(reading({ ub: NaN }))).toBe('unreadable');
    expect(a5Guard(reading({ ub: 0.9 }))).toBe('fails');
    expect(a5Guard(reading({ ub: 1 / 1.1 }))).toBe('holds');
    expect(a5Guard(reading({ lb: 0.2, ub: 0.91 }))).toBe('holds');
    expect(a5Guard(reading({ ub: NaN }))).toBe('unreadable');
    expect(coverageGuard(0.49)).toBe('fails');
    expect(coverageGuard(0.5)).toBe('holds');
    expect(coverageGuard(3)).toBe('holds');
    expect(coverageGuard(NaN)).toBe('unreadable');
  });

  it('Holm steps down across the challengers judged: the smallest p at α/m, and the first that does not clear 0 stops the rest', { timeout: 60_000 }, () => {
    // 1,000 replicates: the bound at 0.0125 is the 13th smallest, at 0.025 the 25th smallest
    const both = holm([repsWith(15), repsWith(5)]);
    expect(both.map((x) => [x.rank, x.level, x.lb, x.rejects])).toEqual([[2, 0.025, 1, true], [1, 0.0125, 1, true]]);
    // the first tested has 14 replicates at or below 0: it does not clear 0 at 0.0125, and stops the second,
    // whose own bound at 0.025 is above 0
    const stopped = holm([repsWith(14), repsWith(15)]);
    expect(stopped.map((x) => [x.rank, x.level, x.lb, x.rejects])).toEqual([[1, 0.0125, -1, false], [2, 0.025, 1, false]]);
    // alone, the same replicates are tested at 0.025
    expect(holm([repsWith(20)]).map((x) => [x.rank, x.level, x.lb, x.rejects])).toEqual([[1, 0.025, 1, true]]);
    expect(holm([repsWith(25)])[0].rejects).toBe(false);
    // a challenger that could not be read stays in the family: the other is tested at α/2, and it clears nothing
    const withUnread = holm([[], repsWith(20)]);
    expect([withUnread[1].rank, withUnread[1].level, withUnread[1].lb, withUnread[1].rejects]).toEqual([1, 0.0125, -1, false]);
    expect([withUnread[0].rank, withUnread[0].rejects]).toEqual([2, false]);
    expect(withUnread[0].lb).toBeNaN();
    // a replicate that is not a number makes the member unreadable
    const nan = holm([[1, 1, NaN]]);
    expect(nan[0].rejects).toBe(false);
    expect(holm([])).toEqual([]);
  });

  it('power is T3 §5\'s instrument: SE = h/1.96, detectable = 2.80·SE, tested at the effect given', { timeout: 60_000 }, () => {
    const at = powerAt(1.96, 2.8);
    expect([at.se, at.detectable, at.effect, at.multiple, at.underpowered]).toEqual([1, 2.8, 2.8, 1, false]);
    const half = powerAt(1.96, 1.4);
    expect(half.multiple).toBeCloseTo(4, 12);
    expect(half.underpowered).toBe(true);
    // the judge window is smaller: the half-width grows by sqrt(coin-days here ÷ coin-days there)
    expect([coinDaysOf(PRESCORE), coinDaysOf(JUDGE)]).toEqual([10_800, 4_500]);
    const moved = powerAt(1.96, 2.8, Math.sqrt(coinDaysOf(PRESCORE) / coinDaysOf(JUDGE)));
    expect(moved.multiple).toBeCloseTo(2.4, 12);
    expect(moved.underpowered).toBe(true);
    expect(powerAt(1.96, -5.6).underpowered).toBe(false);
    expect(powerAt(1.96, -5.6).effect).toBe(5.6);
    expect([powerAt(1.96, 0).multiple, powerAt(1.96, 0).underpowered]).toEqual([Infinity, true]);
    expect(powerAt(NaN, 1).underpowered).toBe(true);
  });

  it('the selection rule: C1 takes the larger ΔΔ1 point; a challenger goes to the judge iff its point is above 0 and every guard holds', { timeout: 60_000 }, () => {
    const ok = ['holds', 'holds', 'holds'] as const;
    const row = (id: PrescoreRow['id'], point: number, over: Partial<PrescoreRow> = {}): PrescoreRow => ({ id, challenger: cand(id).challenger, identifiable: true, point, guards: ok, ...over });
    const sel = selectionOf([row('C1.7', 0.4), row('C1.10', 0.9), row('C2', -0.1), row('C3', 2)]);
    expect(sel.judged).toEqual(['C1.10', 'C3']);
    expect(sel.verdicts).toEqual({ C1: 'JUDGE', C2: 'KEEP (pre-score)', C3: 'JUDGE' });
    expect(sel.causes.C2).toBe('C2: the ΔΔ1 point is not above 0');
    expect(sel.causes.C1).toBe('C1.10 goes to the judge');
    // an exact tie takes the first listed; a point of exactly 0 is not above 0
    expect(selectionOf([row('C1.7', 0.5), row('C1.10', 0.5)]).judged).toEqual(['C1.7']);
    expect(selectionOf([row('C2', 0)]).verdicts).toEqual({ C2: 'KEEP (pre-score)' });
    // the period is picked on the point alone, before the guards: the larger point with a failing guard is a KEEP
    const failing = selectionOf([row('C1.7', 0.4), row('C1.10', 0.9, { guards: ['holds', 'fails', 'holds'] })]);
    expect([failing.judged, failing.verdicts.C1, failing.causes.C1]).toEqual([[], 'KEEP (pre-score)', 'C1.10: a guard fails in-sample']);
    // a guard that could not be read did not hold
    const unread = selectionOf([row('C3', 1, { guards: ['holds', 'unreadable', 'holds'] })]);
    expect([unread.judged, unread.causes.C3]).toEqual([[], 'C3: a guard could not be read in-sample']);
    // a candidate that could not be read in-sample is never picked; with none readable, the challenger is a KEEP
    expect(selectionOf([row('C1.7', NaN, { identifiable: false }), row('C1.10', 0.2)]).judged).toEqual(['C1.10']);
    const none = selectionOf([row('C1.7', 3, { identifiable: false }), row('C1.10', NaN)]);
    expect([none.judged, none.verdicts.C1, none.causes.C1]).toEqual([[], 'KEEP (pre-score)', 'no candidate could be read in-sample']);
    // every challenger a KEEP: nothing goes to the judge
    expect(selectionOf([row('C1.7', -1), row('C1.10', -2), row('C2', -1), row('C3', -1)]).judged).toEqual([]);
  });

  it('the decision rule, in its order: NOT_IDENTIFIABLE, then WINS, then KEEP — underpowered only when the interval reaches 0', { timeout: 60_000 }, () => {
    const ok = ['holds', 'holds', 'holds'] as const;
    const base = { identifiable: true, rejects: true, guards: ok, lb: 0.5, ub: 2.5, prescorePoint: 2 };
    expect(decisionOf(base).decision).toBe('WINS');
    // identifiability is asked first: nothing after it is read
    expect(decisionOf({ ...base, identifiable: false }).decision).toBe('NOT_IDENTIFIABLE');
    expect(decisionOf({ ...base, identifiable: false, lb: NaN, ub: NaN }).power).toBeNull();
    // a guard that fails, or could not be read, is not a WINS
    const failed = decisionOf({ ...base, guards: ['holds', 'fails', 'holds'] });
    expect([failed.decision, failed.cause]).toEqual(['KEEP', 'a guard fails']);
    const unread = decisionOf({ ...base, guards: ['unreadable', 'holds', 'holds'] });
    expect([unread.decision, unread.cause]).toEqual(['KEEP', 'a guard could not be read']);
    // Holm did not clear 0 although the plain interval lies above it: a KEEP, and not an underpowered one
    const holmStopped = decisionOf({ ...base, rejects: false });
    expect([holmStopped.decision, holmStopped.cause]).toEqual(['KEEP', 'the interval does not lie wholly above 0 under Holm']);
    // the interval reaches 0: underpowered iff 2.80·(h/1.96) is above half the pre-score point
    const wide = decisionOf({ ...base, rejects: false, lb: -1, ub: 3, prescorePoint: 2 });   // h = 2: detectable 2.857 > 1
    expect([wide.decision, wide.power?.underpowered]).toEqual(['KEEP — underpowered', true]);
    const tight = decisionOf({ ...base, rejects: false, lb: -0.1, ub: 0.3, prescorePoint: 2 }); // h = 0.2: detectable 0.286 < 1
    expect([tight.decision, tight.power?.underpowered]).toEqual(['KEEP', false]);
    // an interval wholly below 0 does not reach it: a KEEP, however wide
    expect(decisionOf({ ...base, rejects: false, lb: -9, ub: -1 }).decision).toBe('KEEP');
    // no interval at all: a KEEP, never a WINS
    expect(decisionOf({ ...base, rejects: false, lb: NaN, ub: NaN }).decision).toBe('KEEP');
  });
});
