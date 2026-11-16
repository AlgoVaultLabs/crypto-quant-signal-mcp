// EDGE-REGIME-DIAG-W1 CH2 — the decision rule (§6), the ladder (§4d), the secondary families (§4.11), on hand-made numbers.
import { describe, expect, it } from 'vitest';
import { a3State, evidenceOf, fitState, fitStateA5, flagsOf, holdoutState, ladder, pTail, resultLine, secondaryFamily, selectA3, type Evidence, type SecondaryCell } from '../../src/scripts/regime-diag/decide.js';
import type { Reading } from '../../src/scripts/regime-diag/engine.js';

const O = { F: 3.0, alpha: 0.025, floorClusters: 50 };
const ev = (p: Partial<Evidence> = {}): Evidence => ({ s: { point: 5, lb: 3.5, ub: 6.5 }, excess: [{ name: 'e_a', point: 4, lb: 1, ub: 7 }, { name: 'e_b', point: 4, lb: 0.5, ub: 7 }],
  shuffle: { mean: 0.1, pUpper: 0.001, pLower: 1 }, eff: 80, identifiable: true, undefinedReplicates: 0, ...p });
/** A plain BH step-up, standing in for the pinned one (which the run passes in). */
const bh = (p: number[], q: number): boolean[] => {
  const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  let k = -1;
  idx.forEach((i, r) => { if (p[i] <= ((r + 1) * q) / p.length) k = r; });
  return p.map((_, i) => idx.indexOf(i) <= k);
};

describe('regime-diag: the fit-window state of a statistic (§6)', () => {
  it('works: the point clears the floor, every paired excess is above 0, the shuffle is beaten and its mean is outside the interval', () => {
    expect(fitState(ev(), O)).toEqual({ state: 'works', cause: 'point at or above the floor; every comparator and the shuffle beaten' });
    // each criterion alone withholds works without making it broken
    for (const p of [{ s: { point: 2.9, lb: 1, ub: 4 } }, { excess: [{ name: 'e_a', point: 1, lb: -0.1, ub: 3 }] }, { shuffle: { mean: 0.1, pUpper: 0.026, pLower: 1 } }, { shuffle: { mean: 3.6, pUpper: 0.001, pLower: 1 } }]) {
      expect(fitState(ev(p), O).state).toBe('too_little_data');
    }
    expect(fitState(ev({ shuffle: { mean: 0.1, pUpper: 0.025, pLower: 1 } }), O).state).toBe('works');
    expect(fitState(ev({ s: { point: 3.0, lb: 0.2, ub: 6 } }), O).state).toBe('works');
  });

  it('broken: the interval excludes the floor, or the label is reliably no better than a baseline; a null needs the interval', () => {
    expect(fitState(ev({ s: { point: 1, lb: -1, ub: 2.99 } }), O)).toEqual({ state: 'broken', cause: 'the interval is wholly below the floor' });
    expect(fitState(ev({ s: { point: 1, lb: -1, ub: 3.0 } }), O).state).toBe('too_little_data'); // reaches the floor
    expect(fitState(ev({ excess: [{ name: 'e_a', point: 4, lb: 1, ub: 7 }, { name: 'U', point: -2, lb: -4, ub: -0.1 }] }), O)).toEqual({ state: 'broken', cause: 'reliably below baseline U' });
    expect(fitState(ev({ s: { point: 5, lb: 3.5, ub: 6.5 }, shuffle: { mean: 7, pUpper: 0.9, pLower: 0.2 } }), O)).toEqual({ state: 'broken', cause: 'the interval is wholly below the shuffle mean' });
  });

  it('too little data: fewer than 50 effective clusters, an arm that cannot attain the floor, an undefined statistic', () => {
    expect(fitState(ev({ eff: 49.9 }), O)).toEqual({ state: 'too_little_data', cause: 'fewer than 50 effective clusters' });
    expect(fitState(ev({ identifiable: false }), O)).toEqual({ state: 'too_little_data', cause: 'NOT_IDENTIFIABLE' });
    expect(fitState(ev({ s: { point: NaN, lb: NaN, ub: NaN } }), O)).toEqual({ state: 'too_little_data', cause: 'the statistic is undefined (a cell with no defined row)' });
    expect(fitState(ev({ undefinedReplicates: 3 }), O).cause).toBe('the statistic is undefined on 3 resamples');
    expect(fitState(ev({ shuffle: null }), O).cause).toBe('no shuffle was run');
    // works and broken at once cannot be read
    expect(fitState(ev({ s: { point: 5, lb: 3.5, ub: 2 } }), O).state).toBe('too_little_data');
  });

  it('A5: the reference is 1 and the floor a ratio of 1.10', () => {
    const r = { point: 1.3, lb: 1.05, ub: 1.6, eff: 60, shuffle: { pUpper: 0.01 } };
    expect(fitStateA5(r, O).state).toBe('works');
    expect(fitStateA5({ ...r, lb: 1.0 }, O).state).toBe('too_little_data');
    expect(fitStateA5({ ...r, point: 1.09 }, O).state).toBe('too_little_data');
    expect(fitStateA5({ ...r, shuffle: { pUpper: 0.03 } }, O).state).toBe('too_little_data');
    expect(fitStateA5({ ...r, point: 1.0, lb: 0.9, ub: 1.099 }, O)).toEqual({ state: 'broken', cause: 'the interval is wholly below 1.10' });
    expect(fitStateA5({ ...r, eff: 12 }, O).cause).toBe('fewer than 50 effective clusters');
    expect(fitStateA5({ ...r, point: NaN, lb: NaN, ub: NaN }, O).state).toBe('too_little_data');
  });

  it('the evidence of a reading: the paired excesses each answer names', () => {
    const r = (names: string[]): Reading => ({ id: 'x', names, rows: 10, clusters: 5, eff: 77, point: names.map((_, i) => i + 1), lb: names.map((_, i) => i), ub: names.map((_, i) => i + 2), alpha: 0.025, B: 100, undefinedReplicates: 0,
      shuffle: { n: 10, mean: 0.5, pUpper: 0.01, pLower: 0.99 }, reps: new Float64Array(0) });
    const names = (a: 'A1' | 'A2' | 'A3' | 'A4', n: string[]): string[] => evidenceOf(a, r(n)).excess.map((x) => x.name);
    expect(names('A1', ['S', 'U', 'D', 'e_a', 'e_b'])).toEqual(['e_a', 'e_b', 'D', 'U', 'S']);
    expect(names('A2', ['S', 'e_a', 'e_long', 'e_short'])).toEqual(['e_a', 'S', 'e_long', 'e_short']);
    expect(names('A3', ['S', 'e_b', 'e_long', 'e_short', 'e_both'])).toEqual(['S', 'e_b', 'e_long', 'e_short', 'e_both']);
    expect(names('A3', ['S', 'e_b', 'e_long', 'e_short'])).toEqual(['S', 'e_b', 'e_long', 'e_short']);
    expect(names('A4', ['S', 'e_always_up', 'e_always_down', 'e_coin'])).toEqual(['e_always_up', 'e_always_down', 'e_coin']);
    const e = evidenceOf('A1', r(['S', 'U', 'D', 'e_a', 'e_b']), false);
    expect([e.s, e.excess[2], e.eff, e.identifiable, e.shuffle]).toEqual([{ point: 1, lb: 0, ub: 2 }, { name: 'D', point: 3, lb: 2, ub: 4 }, 77, false, { mean: 0.5, pUpper: 0.01, pLower: 0.99 }]);
    expect(() => evidenceOf('A2', r(['S', 'U']))).toThrow(/e_a/);
  });
});

describe('regime-diag: A3 — selection and state', () => {
  it('selects the cell with the largest adjusted lower bound among those with 50 effective clusters; ties go to the earlier cell', () => {
    expect(selectA3([{ eff: 80, lb: 1 }, { eff: 49, lb: 9 }, { eff: 60, lb: 2 }, { eff: 60, lb: 2 }, { eff: 70, lb: NaN }], 50)).toBe(2);
    expect(selectA3([{ eff: 10, lb: 1 }, { eff: 49, lb: 9 }], 50)).toBe(-1);
    expect(selectA3([{ eff: 80, lb: -5 }], 50)).toBe(0);
  });
  it('works in the selected cell at the family level; broken only when no eligible cell can hold the floor', () => {
    const o = { ...O, alpha: 0.025 / 36 };
    const cells = [{ eff: 80, ub: 2.5 }, { eff: 20, ub: 9 }, { eff: 90, ub: 2.9 }];
    const open = [...cells, { eff: 55, ub: 6.5 }];
    const strong = { mean: 0.1, pUpper: 0.0005, pLower: 1 };
    expect(a3State(ev({ shuffle: strong }), open, o)).toEqual({ state: 'works', cause: 'the selected cell clears the floor; every comparator and the shuffle beaten at the family level' });
    expect(a3State(ev({ shuffle: { mean: 0.1, pUpper: 0.001, pLower: 1 } }), open, o).state).toBe('too_little_data'); // 0.001 > 0.025/36
    expect(a3State(ev({ shuffle: strong, excess: [{ name: 'e_b', point: 1, lb: 0, ub: 2 }] }), open, o).state).toBe('too_little_data');
    expect(a3State(ev({ shuffle: strong, s: { point: 2.9, lb: 1, ub: 6.5 } }), open, o).state).toBe('too_little_data');
    expect(a3State(ev({ shuffle: { ...strong, mean: 4 } }), open, o).state).toBe('too_little_data'); // the shuffle mean is inside the interval
    expect(a3State(ev({ s: { point: 1, lb: -1, ub: 2 }, shuffle: { mean: 0, pUpper: 0.5, pLower: 0.5 } }), cells, o)).toEqual({ state: 'broken', cause: 'every cell with 50 effective clusters has its adjusted interval wholly below the floor' });
    expect(a3State(ev({ s: { point: 1, lb: -1, ub: 2 } }), [...cells, { eff: 55, ub: 3.0 }], o).state).toBe('too_little_data');
    expect(a3State(ev({ shuffle: strong }), cells, o).state).toBe('too_little_data'); // works and broken at once cannot be read
    expect(a3State(null, [{ eff: 20, ub: 1 }], o)).toEqual({ state: 'too_little_data', cause: 'no cell has 50 effective clusters' });
    expect(a3State(null, open, o).state).toBe('too_little_data');
    expect(a3State(ev({ shuffle: strong, undefinedReplicates: 2 }), open, o).state).toBe('too_little_data');
  });
});

describe('regime-diag: the ladder (§4d)', () => {
  it('reads the keys top down', () => {
    const L = (ceiling: Parameters<typeof ladder>[0]['ceiling'], noLag: string, served: string) => ladder({ ceiling, noLag: noLag as never, served: served as never });
    expect(L('broken', 'broken', 'broken')).toEqual({ diagnosis: 'NO_ROOM', at: 'CEILING' });
    expect(L('works', 'broken', 'broken')).toEqual({ diagnosis: 'INPUTS', at: 'NO_LAG' });
    expect(L('works', 'works', 'broken')).toEqual({ diagnosis: 'LAG', at: 'SERVED' });
    expect(L('works', 'works', 'works')).toEqual({ diagnosis: 'NO_DEFECT', at: null });
    expect(L('by_construction', 'works', 'broken')).toEqual({ diagnosis: 'LAG', at: 'SERVED' });
    expect(L('by_construction', 'broken', 'too_little_data')).toEqual({ diagnosis: 'INPUTS', at: 'NO_LAG' });
    // too little data is reported at the key where it occurs, and the ladder stops there
    expect(L('too_little_data', 'works', 'broken')).toEqual({ diagnosis: 'TOO_LITTLE_DATA', at: 'CEILING' });
    expect(L('works', 'too_little_data', 'broken')).toEqual({ diagnosis: 'TOO_LITTLE_DATA', at: 'NO_LAG' });
    expect(L('works', 'works', 'too_little_data')).toEqual({ diagnosis: 'TOO_LITTLE_DATA', at: 'SERVED' });
    // a key that works below one that does not
    expect(L('broken', 'works', 'broken')).toEqual({ diagnosis: 'INCONSISTENT', at: 'CEILING' });
    expect(L('broken', 'broken', 'works')).toEqual({ diagnosis: 'INCONSISTENT', at: 'CEILING' });
    expect(L('works', 'broken', 'works')).toEqual({ diagnosis: 'INCONSISTENT', at: 'NO_LAG' });
    // a RANGING cell has no CEILING
    expect(L(null, 'broken', 'broken')).toEqual({ diagnosis: 'NOT_SEPARABLE: NO_ROOM or INPUTS', at: 'NO_LAG' });
    expect(L(null, 'works', 'broken')).toEqual({ diagnosis: 'LAG', at: 'SERVED' });
  });
});

describe('regime-diag: the secondary families (§4.11)', () => {
  const reps = (xs: number[][]): { reps: Float64Array; nOut: number } => ({ reps: Float64Array.from(xs.flat()), nOut: xs[0].length });
  it('tail counts over the resamples, an undefined resample counting against', () => {
    const r = reps([[1], [-1], [0], [4], [NaN]]);
    expect(pTail(r.reps, 1, 0, (v) => v <= 0)).toBe((1 + 3) / 6);
    expect(pTail(r.reps, 1, 0, (v) => v >= 3)).toBe((1 + 2) / 6);
    expect(pTail(new Float64Array(0), 1, 0, () => true)).toBe(1);
  });
  it('general rows, the suppression row, the sign rows and the two-contrast row', () => {
    const many = (v: number, n = 199): number[][] => Array.from({ length: n }, () => [v]);
    const cell = (p: Partial<SecondaryCell>): SecondaryCell => ({ id: 'M02', kind: 'general', point: [5], nOut: 1, reps: Float64Array.from(many(5).flat()), eff: 80, undefinedReplicates: 0, ...p });
    const fam = (cells: SecondaryCell[]) => secondaryFamily(cells, O.F, 0.1, O.floorClusters, bh).map((x) => x.state);
    // θ* all 5: p_works = 1/200, p_broken = 1 → works. θ* all 1: p_works = 1/200 but the point is under the floor; p_broken = 1/200 → broken.
    expect(fam([cell({}), cell({ id: 'M03', point: [1], reps: Float64Array.from(many(1).flat()) }), cell({ id: 'M04', point: [5], reps: Float64Array.from(many(5).map((x, i) => (i % 2 ? x : [-1])).flat()) })])).toEqual(['works', 'broken', 'too_little_data']);
    const out = secondaryFamily([cell({})], O.F, 0.1, O.floorClusters, bh)[0];
    expect([out.pWorks, out.pBroken, out.bhWorks, out.bhBroken]).toEqual([1 / 200, 1, true, false]);
    // row 7 tests a suppression: the names are exchanged
    expect(fam([cell({ id: 'M07', kind: 'suppression' }), cell({ id: 'M07', kind: 'suppression', point: [1], reps: Float64Array.from(many(1).flat()) })])).toEqual(['broken', 'works']);
    // rows 8 and 9 are sign tests: the floor is 0
    expect(fam([cell({ id: 'M08', kind: 'sign', point: [1], reps: Float64Array.from(many(1).flat()) }), cell({ id: 'M09', kind: 'sign', point: [-1], reps: Float64Array.from(many(-1).flat()) })])).toEqual(['works', 'broken']);
    // row 12: works when both contrasts are at least 0 and both above −3.0 after BH; broken when a contrast is below 0 after BH
    const two = (a: number, b: number): Partial<SecondaryCell> => ({ id: 'M12', kind: 'timeframe', point: [a, b], nOut: 2, reps: Float64Array.from(Array.from({ length: 199 }, () => [a, b]).flat()) });
    expect(fam([cell(two(1, 0.5))])).toEqual(['works']);
    expect(fam([cell(two(1, -2))])).toEqual(['broken']);
    expect(fam([cell(two(-0.5, -4))])).toEqual(['broken']);
    const m12 = secondaryFamily([cell(two(1, -2))], O.F, 0.1, O.floorClusters, bh)[0];
    expect([m12.pBroken, m12.pWorks]).toEqual([Math.min(1, 2 * (1 / 200)), 1 / 200]);
    // below 50 effective clusters, or an undefined resample: too little data whatever the p-values
    expect(fam([cell({ eff: 49 }), cell({ undefinedReplicates: 1 }), cell({ point: [NaN] })])).toEqual(['too_little_data', 'too_little_data', 'too_little_data']);
    // BH runs over the whole family: one strong cell among many nulls keeps its state, a marginal one loses it
    const marginal = cell({ id: 'M05', reps: Float64Array.from(many(5).map((x, i) => (i < 12 ? [-1] : x)).flat()) }); // p_works = 13/200 = 0.065
    expect(fam([marginal])).toEqual(['works']);
    expect(fam([marginal, ...Array.from({ length: 13 }, (_, i) => cell({ id: `n${i}`, point: [5], reps: Float64Array.from(many(5).map((x, k) => (k % 2 ? x : [-1])).flat()) }))])[0]).toBe('too_little_data');
  });
});

describe('regime-diag: the hold-out state, the flags and the result lines', () => {
  const h = (p: Partial<Parameters<typeof holdoutState>[0]> = {}) => holdoutState({ identifiable: true, fitPoint: 4, ref: 0, alpha: 0.025, hold: ev(), ...p });
  it('NOT_IDENTIFIABLE first, then CONFIRMED on the fit-window sign, else NOT_CONFIRMED', () => {
    expect(h()).toBe('CONFIRMED');
    expect(h({ identifiable: false })).toBe('NOT_IDENTIFIABLE');
    expect(h({ hold: null })).toBe('NOT_IDENTIFIABLE');
    // the floor is not part of CONFIRMED
    expect(h({ hold: ev({ s: { point: 0.5, lb: 0.1, ub: 0.9 } }) })).toBe('CONFIRMED');
    expect(h({ hold: ev({ s: { point: -0.5, lb: -1, ub: 0.9 } }) })).toBe('NOT_CONFIRMED');
    expect(h({ hold: ev({ excess: [{ name: 'e_a', point: 1, lb: 0, ub: 2 }] }) })).toBe('NOT_CONFIRMED');
    expect(h({ hold: ev({ shuffle: { mean: 0, pUpper: 0.03, pLower: 1 } }) })).toBe('NOT_CONFIRMED');
    // an adverse fit-window finding is confirmed on its own side
    const adverse = ev({ s: { point: -4, lb: -6, ub: -2 }, excess: [{ name: 'e_a', point: -3, lb: -5, ub: -0.5 }], shuffle: { mean: 0, pUpper: 1, pLower: 0.002 } });
    expect(h({ fitPoint: -2, hold: adverse })).toBe('CONFIRMED');
    expect(h({ fitPoint: 2, hold: adverse })).toBe('NOT_CONFIRMED');
    expect(h({ fitPoint: NaN })).toBe('NOT_CONFIRMED');
    // A5: the sign of R5 − 1, the interval on that side of 1
    const a5 = (point: number, lb: number, ub: number, pUpper = 0.01, pLower = 1) => ev({ s: { point, lb, ub }, excess: [{ name: 'reference', point: point - 1, lb: lb - 1, ub: ub - 1 }], shuffle: { mean: 1, pUpper, pLower } });
    expect(h({ fitPoint: 1.3, ref: 1, hold: a5(1.2, 1.05, 1.4) })).toBe('CONFIRMED');
    expect(h({ fitPoint: 1.3, ref: 1, hold: a5(1.2, 0.99, 1.4) })).toBe('NOT_CONFIRMED');
    expect(h({ fitPoint: 0.9, ref: 1, hold: a5(0.8, 0.7, 0.95, 1, 0.01) })).toBe('CONFIRMED');
  });
  it('flags name the variants under which the state would change', () => {
    expect(flagsOf('works', { day: 'works', week: 'works', unit: 'works' })).toEqual([]);
    expect(flagsOf('works', { day: 'works', week: 'too_little_data', unit: 'broken' })).toEqual(['CLUSTER_SENSITIVE', 'WEIGHT_SENSITIVE']);
    expect(flagsOf('CONFIRMED', { day: 'NOT_CONFIRMED', week: 'CONFIRMED', unit: 'CONFIRMED', panel13: 'NOT_CONFIRMED' })).toEqual(['CLUSTER_SENSITIVE', 'PANEL_SENSITIVE']);
  });
  it('the two result lines', () => {
    expect(resultLine('REGIME_DIAG_FIT', ['works', 'broken', 'too_little_data', 'works', 'broken'])).toBe('REGIME_DIAG_FIT=A1:works;A2:broken;A3:too_little_data;A4:works;A5:broken');
    expect(resultLine('REGIME_DIAG_VERDICT', ['CONFIRMED', 'NOT_CONFIRMED', 'NOT_IDENTIFIABLE', 'CONFIRMED', 'CONFIRMED'])).toBe('REGIME_DIAG_VERDICT=A1:CONFIRMED;A2:NOT_CONFIRMED;A3:NOT_IDENTIFIABLE;A4:CONFIRMED;A5:CONFIRMED');
    expect(() => resultLine('REGIME_DIAG_FIT', ['works'])).toThrow(/five/);
  });
});
