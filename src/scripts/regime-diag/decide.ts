// regime-diag/decide.ts — EDGE-REGIME-DIAG-W1: the decision rule. Pure functions over numbers already computed.
//
// Registration §6 (the three fit-window states, the hold-out states, the two result lines), §4.8 (A3's selection),
// §4.11 (the secondary families and the sensitivity flags) and the answer-key ladder (PROCEDURE §4d). Nothing here
// reads a row: every function takes point values, interval bounds, shuffle tails and effective-cluster counts.
// Every comparison is written so that an undefined number (NaN) can satisfy neither `works` nor `broken`.
import type { Reading } from './engine.js';
import { FLOOR_RATIO, type Read } from './diag-spec.js';

export type FitState = 'works' | 'broken' | 'too_little_data';
export type HoldState = 'CONFIRMED' | 'NOT_CONFIRMED' | 'NOT_IDENTIFIABLE';
export interface Decision { state: FitState; cause: string }

export interface Bound { point: number; lb: number; ub: number }
export interface Excess extends Bound { name: string }
/** What §6 reads of one statistic: `S`, its paired excesses over the applicable comparators (a), (b), (d), the shuffle (c). */
export interface Evidence {
  s: Bound;
  excess: Excess[];
  shuffle: { mean: number; pUpper: number; pLower: number } | null;
  /** Kish effective clusters of the statistic's rows. */
  eff: number;
  /** False when the §4c bound of an arm is below the floor. */
  identifiable: boolean;
  undefinedReplicates: number;
}
/** `F` the floor, `alpha` the one-sided level of the bounds and of the shuffle, `floorClusters` = FLOOR_CLUSTERS. */
export interface DecideOpts { F: number; alpha: number; floorClusters: number }

const tooLittle = (cause: string): Decision => ({ state: 'too_little_data', cause });

/** The reasons a statistic cannot be read at all, in the order they are checked. */
function unreadable(e: Evidence, o: DecideOpts): string | null {
  if (!e.identifiable) return 'NOT_IDENTIFIABLE';
  if (!(e.eff >= o.floorClusters)) return `fewer than ${o.floorClusters} effective clusters`;
  if (!Number.isFinite(e.s.point)) return 'the statistic is undefined (a cell with no defined row)';
  if (e.undefinedReplicates > 0) return `the statistic is undefined on ${e.undefinedReplicates} resamples`;
  if (!Number.isFinite(e.s.lb) || !Number.isFinite(e.s.ub)) return 'no interval was computed';
  if (e.shuffle === null) return 'no shuffle was run';
  return null;
}

/** §6 works: the point clears the floor, every paired excess is above 0, the shuffle is beaten and its mean lies below the interval. */
function worksOf(e: Evidence, o: DecideOpts): boolean {
  return e.s.point >= o.F && e.excess.every((x) => x.lb > 0) && e.shuffle !== null && e.shuffle.pUpper <= o.alpha && e.shuffle.mean < e.s.lb;
}

/** §6: the fit-window state of a primary (A1, A2, A4) and of each of their key readings. */
export function fitState(e: Evidence, o: DecideOpts): Decision {
  const why = unreadable(e, o);
  if (why !== null) return tooLittle(why);
  const works = worksOf(e, o);
  let broken: string | null = null;
  const under = e.excess.find((x) => x.ub < 0);
  if (e.s.ub < o.F) broken = 'the interval is wholly below the floor';
  else if (under) broken = `reliably below baseline ${under.name}`;
  else if (e.shuffle !== null && e.s.ub < e.shuffle.mean) broken = 'the interval is wholly below the shuffle mean';
  if (works && broken !== null) return tooLittle('works and broken at once');
  if (works) return { state: 'works', cause: 'point at or above the floor; every comparator and the shuffle beaten' };
  if (broken !== null) return { state: 'broken', cause: broken };
  return tooLittle('the interval reaches the floor while a criterion for works is unmet');
}

/** §6, A5: the reference is 1 and the floor the ratio 1.10. Works and broken are the registered three and one conditions. */
export function fitStateA5(r: { point: number; lb: number; ub: number; eff: number; undefinedReplicates?: number; shuffle: { pUpper: number } }, o: Pick<DecideOpts, 'alpha' | 'floorClusters'>): Decision {
  const floor = FLOOR_RATIO.toFixed(2);
  if (!(r.eff >= o.floorClusters)) return tooLittle(`fewer than ${o.floorClusters} effective clusters`);
  if (!Number.isFinite(r.point)) return tooLittle('the ratio is undefined (no run with a reference)');
  if ((r.undefinedReplicates ?? 0) > 0) return tooLittle(`the ratio is undefined on ${r.undefinedReplicates} resamples`);
  const works = r.point >= FLOOR_RATIO && r.lb > 1 && r.shuffle.pUpper <= o.alpha;
  const broken = r.ub < FLOOR_RATIO;
  if (works && broken) return tooLittle('works and broken at once');
  if (works) return { state: 'works', cause: `the ratio is at or above ${floor}, its interval above 1, the shuffle beaten` };
  if (broken) return { state: 'broken', cause: `the interval is wholly below ${floor}` };
  return tooLittle(`the interval reaches ${floor} while a criterion for works is unmet`);
}

/**
 * §4.8: the paired excesses each answer names, in the order (a), (b), (d). A1's (d) is `D` (always-long scores
 * `U − D`, so the excess is `2D`), `U` (always-short) and `Δ1` itself (a random side scores 0). A2's (b) is the
 * statistic's own reference. A3's `E` is itself the excess over (a), so every output of the reading is one.
 * A4 has no (a) or (b).
 */
const EXCESS: Record<'A1' | 'A2' | 'A4', readonly string[]> = {
  A1: ['e_a', 'e_b', 'D', 'U', 'S'],
  A2: ['e_a', 'S', 'e_long', 'e_short'],
  A4: ['e_always_up', 'e_always_down', 'e_coin'],
};

/** The evidence of a row-statistic reading (`engine.compute`), for answer A1–A4. */
export function evidenceOf(answer: 'A1' | 'A2' | 'A3' | 'A4', r: Reading, identifiable = true): Evidence {
  const at = (name: string): Excess => {
    const i = r.names.indexOf(name);
    if (i < 0) throw new Error(`regime-diag: reading ${r.id} has no output ${name} (${answer} needs it)`);
    return { name, point: r.point[i], lb: r.lb[i], ub: r.ub[i] };
  };
  const s = at('S');
  const names = answer === 'A3' ? r.names : EXCESS[answer];
  return { s: { point: s.point, lb: s.lb, ub: s.ub }, excess: names.map(at), eff: r.eff, identifiable, undefinedReplicates: r.undefinedReplicates,
    shuffle: r.shuffle ? { mean: r.shuffle.mean, pUpper: r.shuffle.pUpper, pLower: r.shuffle.pLower } : null };
}

/**
 * §4.8, A3's selection (fit window only): among cells with at least `floorClusters` effective clusters, the one with
 * the largest adjusted lower bound; ties go to the earlier cell (the cells come shape-major, groups in the registered
 * order). −1 when no cell qualifies.
 */
export function selectA3(cells: ReadonlyArray<{ eff: number; lb: number }>, floorClusters: number): number {
  let best = -1;
  cells.forEach((c, i) => {
    if (!(c.eff >= floorClusters) || !Number.isFinite(c.lb)) return;
    if (best < 0 || c.lb > cells[best].lb) best = i;
  });
  return best;
}

/**
 * §6, A3. `selected` is the evidence of the fit-selected cell at the family level (bounds and shuffle at
 * `o.alpha = 0.025 / 36`), null when no cell was selected. `cells` are all 36 with their adjusted upper bound.
 * Works is read in the selected cell; broken is every eligible cell's adjusted interval lying below the floor.
 */
export function a3State(selected: Evidence | null, cells: ReadonlyArray<{ eff: number; ub: number }>, o: DecideOpts): Decision {
  const eligible = cells.filter((c) => c.eff >= o.floorClusters);
  if (eligible.length === 0) return tooLittle(`no cell has ${o.floorClusters} effective clusters`);
  if (selected === null) return tooLittle('no cell was selected');
  const why = unreadable(selected, o);
  const works = why === null && worksOf(selected, o);
  const broken = eligible.every((c) => c.ub < o.F);
  if (works && broken) return tooLittle('works and broken at once');
  if (works) return { state: 'works', cause: 'the selected cell clears the floor; every comparator and the shuffle beaten at the family level' };
  if (broken) return { state: 'broken', cause: `every cell with ${o.floorClusters} effective clusters has its adjusted interval wholly below the floor` };
  return tooLittle(why ?? 'an eligible cell reaches the floor without the selected cell meeting works');
}

export type KeyState = FitState | 'by_construction';
export interface Ladder { diagnosis: 'NO_ROOM' | 'INPUTS' | 'LAG' | 'NO_DEFECT' | 'TOO_LITTLE_DATA' | 'INCONSISTENT' | 'NOT_SEPARABLE: NO_ROOM or INPUTS'; at: 'CEILING' | 'NO_LAG' | 'SERVED' | null }

/**
 * The answer-key ladder, read top down. `ceiling` is null where key A has no reading (a RANGING cell of A3) and
 * `by_construction` where it holds by construction (A4, A5); that counts as works. The first key that is too little
 * data stops the ladder there. The first broken key gives the diagnosis, unless a key below it works: that is
 * INCONSISTENT, with no diagnosis.
 */
export function ladder(k: { ceiling: KeyState | null; noLag: FitState; served: FitState }): Ladder {
  const keys: Array<{ at: 'CEILING' | 'NO_LAG' | 'SERVED'; state: KeyState }> = [];
  if (k.ceiling !== null) keys.push({ at: 'CEILING', state: k.ceiling });
  keys.push({ at: 'NO_LAG', state: k.noLag }, { at: 'SERVED', state: k.served });
  const works = (s: KeyState): boolean => s === 'works' || s === 'by_construction';
  for (let i = 0; i < keys.length; i++) {
    const { at, state } = keys[i];
    if (works(state)) continue;
    if (state === 'too_little_data') return { diagnosis: 'TOO_LITTLE_DATA', at };
    if (keys.slice(i + 1).some((x) => works(x.state))) return { diagnosis: 'INCONSISTENT', at };
    if (at === 'CEILING') return { diagnosis: 'NO_ROOM', at };
    if (at === 'NO_LAG') return { diagnosis: k.ceiling === null ? 'NOT_SEPARABLE: NO_ROOM or INPUTS' : 'INPUTS', at };
    return { diagnosis: 'LAG', at };
  }
  return { diagnosis: 'NO_DEFECT', at: null };
}

/**
 * §4.11: `(1 + #{θ* in the tail}) / (1 + B)` over the resamples of output `k` (`reps` holds `nOut` outputs per
 * resample). A resample on which the output is undefined counts in the tail.
 */
export function pTail(reps: Float64Array, nOut: number, k: number, inTail: (v: number) => boolean): number {
  const B = nOut > 0 ? Math.floor(reps.length / nOut) : 0;
  let n = 0;
  for (let b = 0; b < B; b++) {
    const v = reps[b * nOut + k];
    if (!Number.isFinite(v) || inTail(v)) n++;
  }
  return (1 + n) / (1 + B);
}

/**
 * One cell of a BH family. `general`: θ is output 0 and the floor is `F`. `suppression` (map row 7): the general
 * rule with the names exchanged. `sign` (rows 8, 9): `F` is replaced by 0. `timeframe` (row 12): outputs 0 and 1 are
 * the two contrasts against the default. `eff` is the smallest effective-cluster count over the cell's arms.
 */
export interface SecondaryCell { id: string; kind: 'general' | 'suppression' | 'sign' | 'timeframe'; point: number[]; nOut: number; reps: Float64Array; eff: number; undefinedReplicates: number }
export interface SecondaryState { id: string; state: FitState; cause: string; pWorks: number; pBroken: number; bhWorks: boolean; bhBroken: boolean }

/**
 * §4.11: the states of one family (the 14 secondary cells, or A3's 36 cells) — BH at `q` over the family's
 * `p_works` and, separately, over its `p_broken`. `bh` is the pinned `bh(pvals, q)`. A cell that is too little data
 * by the floor or by an undefined value enters both families with p = 1, so the family keeps its size.
 */
export function secondaryFamily(cells: readonly SecondaryCell[], F: number, q: number, floorClusters: number, bh: (pvals: number[], q: number) => boolean[]): SecondaryState[] {
  const thin = cells.map((c) => {
    if (!(c.eff >= floorClusters)) return `fewer than ${floorClusters} effective clusters`;
    const need = c.kind === 'timeframe' ? [0, 1] : [0];
    if (need.some((k) => !Number.isFinite(c.point[k]))) return 'the statistic is undefined';
    if (c.undefinedReplicates > 0) return `the statistic is undefined on ${c.undefinedReplicates} resamples`;
    if (c.reps.length === 0) return 'no resample was drawn';
    return null;
  });
  const ps = cells.map((c) => {
    if (c.kind === 'timeframe') {
      const pa = pTail(c.reps, c.nOut, 0, (v) => v >= 0), pb = pTail(c.reps, c.nOut, 1, (v) => v >= 0);
      const qa = pTail(c.reps, c.nOut, 0, (v) => v <= -F), qb = pTail(c.reps, c.nOut, 1, (v) => v <= -F);
      return { pWorks: Math.max(qa, qb), pBroken: Math.min(1, 2 * Math.min(pa, pb)) };
    }
    const f = c.kind === 'sign' ? 0 : F;
    return { pWorks: pTail(c.reps, c.nOut, 0, (v) => v <= 0), pBroken: pTail(c.reps, c.nOut, 0, (v) => v >= f) };
  });
  const bhWorks = bh(ps.map((p, i) => (thin[i] === null ? p.pWorks : 1)), q);
  const bhBroken = bh(ps.map((p, i) => (thin[i] === null ? p.pBroken : 1)), q);
  return cells.map((c, i) => {
    const base = { id: c.id, pWorks: ps[i].pWorks, pBroken: ps[i].pBroken, bhWorks: bhWorks[i], bhBroken: bhBroken[i] };
    if (thin[i] !== null) return { ...base, state: 'too_little_data' as const, cause: thin[i] as string };
    const pointOk = c.kind === 'timeframe' ? c.point[0] >= 0 && c.point[1] >= 0 : c.point[0] >= (c.kind === 'sign' ? 0 : F);
    let works = pointOk && bhWorks[i], broken = bhBroken[i];
    if (c.kind === 'suppression') [works, broken] = [broken, works];
    if (works && broken) return { ...base, state: 'too_little_data' as const, cause: 'works and broken at once' };
    if (works) return { ...base, state: 'works' as const, cause: 'criterion for works met after BH' };
    if (broken) return { ...base, state: 'broken' as const, cause: 'criterion for broken met after BH' };
    return { ...base, state: 'too_little_data' as const, cause: 'neither criterion met' };
  });
}

/**
 * §6, the hold-out, in the fixed order. `identifiable` is the check made on the realized hold-out skeleton before
 * any hold-out outcome exists; `hold` is null when the primary was therefore not computed (or A3 has no fit-selected
 * cell). `ref` is 0 for A1–A4 and 1 for A5; `hold.excess` are the paired excesses, each 0 at its baseline (for A5,
 * the ratio minus 1). The floor is not part of CONFIRMED.
 */
export function holdoutState(a: { identifiable: boolean; fitPoint: number; ref: number; alpha: number; hold: Evidence | null }): HoldState {
  if (!a.identifiable || a.hold === null) return 'NOT_IDENTIFIABLE';
  const sign = Math.sign(a.fitPoint - a.ref), h = a.hold;
  if (sign !== 1 && sign !== -1) return 'NOT_CONFIRMED';
  if (Math.sign(h.s.point - a.ref) !== sign) return 'NOT_CONFIRMED';
  if (!h.excess.every((x) => (sign > 0 ? x.lb > 0 : x.ub < 0))) return 'NOT_CONFIRMED';
  if (h.shuffle === null) return 'NOT_CONFIRMED';
  return (sign > 0 ? h.shuffle.pUpper : h.shuffle.pLower) <= a.alpha ? 'CONFIRMED' : 'NOT_CONFIRMED';
}

export type Flag = 'CLUSTER_SENSITIVE' | 'WEIGHT_SENSITIVE' | 'PANEL_SENSITIVE';
/** §4.11: the flags beside a primary — the variants under which its state would change. `panel13` is hold-out only. */
export function flagsOf(state: string, v: { day: string; week: string; unit: string; panel13?: string }): Flag[] {
  const out: Flag[] = [];
  if (v.day !== state || v.week !== state) out.push('CLUSTER_SENSITIVE');
  if (v.unit !== state) out.push('WEIGHT_SENSITIVE');
  if (v.panel13 !== undefined && v.panel13 !== state) out.push('PANEL_SENSITIVE');
  return out;
}

/** §6: `REGIME_DIAG_FIT=A1:…;…;A5:…` and `REGIME_DIAG_VERDICT=…`. */
export function resultLine(name: Read['line'], states: readonly string[]): string {
  if (states.length !== 5) throw new Error(`regime-diag: ${name} carries five states, got ${states.length}`);
  return `${name}=${states.map((s, i) => `A${i + 1}:${s}`).join(';')}`;
}
