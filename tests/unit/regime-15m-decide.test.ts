// tests/unit/regime-15m-decide.test.ts — EDGE-REGIME-15M-BACKTEST-W1 items 4–5: Bar A and its three states, on
// hand-made measures (every number below is the test's own).
import '../fixtures/regime-15m/isolate.js';
import { describe, expect, it } from 'vitest';
import { CAUSES, decide, lineOf, thrown } from '../../src/scripts/regime-15m/r15-decide.js';
import { TF_KEYS } from '../../src/scripts/regime-15m/r15-spec.js';
import type { Measures, Pre, TfMeasures } from '../../src/scripts/regime-15m/r15-stats.js';
import { BASE, madeMeasures, madePre, type Made } from '../fixtures/regime-15m/made.js';

const with_ = (o: Partial<Made>): Made => ({ ...BASE, ...o, ff: { ...BASE.ff, ...(o.ff ?? {}) } });
const state = (o: Partial<Made>, parity: boolean | null = true, pre = madePre()) => decide(madeMeasures(with_(o)), pre, parity);

describe('regime-15m: Bar A', () => {
  it('PASS when all three hold: A4 and Δ1 lower bounds above −δ, 15m flip-flops at most the highest of 1h, 4h, 1d', () => {
    const d = state({});
    expect([d.state, d.causes, d.line]).toEqual(['PASS', [], 'REGIME_15M_BACKTEST=PASS']);
    // δ_A4 = 0.5 × min(A4 − 50, A4 − always-up) on 1h; δ_Δ1 = 0.5 × Δ1₁ₕ; the flip-flop reference is the highest of the three
    expect(d.criteria.map((c) => [c.id, c.margin, c.reference, c.holds])).toEqual([['A4', 5, 10, true], ['D1', 4, 8, true], ['FF', 30, null, true]]);
  });

  it('each criterion alone fails it, and the bounds are strict: LB = −δ fails, a rate equal to the reference holds', () => {
    expect(state({ a4Theta: { point: 0, lb: -5 } }).state).toBe('FAIL');
    expect(state({ a4Theta: { point: 0, lb: -4.999 } }).state).toBe('PASS');
    expect(state({ d1Theta: { point: 0, lb: -4 } }).state).toBe('FAIL');
    expect(state({ d1Theta: { point: 0, lb: -3.999 } }).state).toBe('PASS');
    expect(state({ ff: { '15m': 30.001, '1h': 12, '4h': 30, '1d': 10 } }).state).toBe('FAIL');
    expect(state({ ff: { '15m': 30, '1h': 12, '4h': 30, '1d': 10 } }).state).toBe('PASS');
    // the reference is the highest of the three, whichever timeframe holds it
    expect(state({ ff: { '15m': 35, '1h': 12, '4h': 30, '1d': 40 } }).state).toBe('PASS');
    expect(state({ ff: { '15m': 35, '1h': 36, '4h': 30, '1d': 10 } }).state).toBe('PASS');
  });

  it('δ_A4 is half the 1h edge over the stronger fixed baseline: max(50 %, always-up)', () => {
    // always-up is the stronger baseline: A4 − always-up = 4 < A4 − 50 = 20, so δ_A4 = 2
    const d = state({ a4Up1h: 4, a4Theta: { point: 0, lb: -3 } });
    expect([d.state, d.criteria[0].margin]).toEqual(['FAIL', 2]);
    // the coin flip is the stronger baseline: δ_A4 = 0.5 × 6
    expect(state({ a4Coin1h: 6, a4Up1h: 30, a4Theta: { point: 0, lb: -2.9 } }).criteria[0]).toMatchObject({ margin: 3, holds: true });
  });

  it('NOT_IDENTIFIABLE: δ ≤ 0 is INDETERMINATE, never FAIL, even when the criterion would fail', () => {
    for (const o of [{ a4Up1h: 0 }, { a4Up1h: -3 }, { a4Coin1h: -1 }, { d1_1h: 0 }, { d1_1h: -2 }] as Array<Partial<Made>>) {
      const d = state({ ...o, a4Theta: { point: -9, lb: -20 }, d1Theta: { point: -9, lb: -20 } });
      expect([d.state, d.causes], JSON.stringify(o)).toEqual(['INDETERMINATE', ['not_identifiable']]);
      expect(d.line).toBe('REGIME_15M_BACKTEST=INDETERMINATE (not_identifiable)');
    }
  });

  it('parity red is INDETERMINATE (parity), never FAIL; a check row (no parity reference) is not', () => {
    expect(state({ a4Theta: { point: -9, lb: -20 } }, false)).toMatchObject({ state: 'INDETERMINATE', causes: ['parity'] });
    expect(state({}, false)).toMatchObject({ state: 'INDETERMINATE', causes: ['parity'] });
    expect(state({}, null).state).toBe('PASS');
  });

  it('a timeframe under the floor is INDETERMINATE (floor), read from the record written before the outcomes', () => {
    for (const k of ['15m', '1h', '4h', '1d'] as const) {
      for (const field of ['a4_eff', 'd1_eff', 'ff_coin_days'] as const) {
        const d = state({}, true, madePre(100, 50, { [k]: { [field]: 49.9 } }));
        expect([d.state, d.causes], `${k} ${field}`).toEqual(['INDETERMINATE', ['floor']]);
      }
    }
    expect(state({}, true, madePre(100, 50, { '1d': { a4_eff: 50 } })).state).toBe('PASS');
  });

  it('a non-finite input is INDETERMINATE (non_finite), never a criterion that holds or fails', () => {
    for (const o of [{ a4Theta: { point: 0, lb: Number.NaN } }, { d1Theta: { point: Number.NaN, lb: -1 } }, { d1_1h: Number.POSITIVE_INFINITY }, { ff: { '15m': 20, '1h': 12, '4h': Number.NaN, '1d': 10 } }] as Array<Partial<Made>>) {
      expect(state(o).causes, JSON.stringify(o)).toContain('non_finite');
      expect(state(o).state).toBe('INDETERMINATE');
    }
  });

  it('NaN, +∞ and −∞ planted in every input Bar A reads: INDETERMINATE (non_finite), every map row too little data', () => {
    const at = (m: Measures, k: string): TfMeasures => m.tfs.find((t) => t.tf === k) as TfMeasures;
    const pt = (p: Pre, k: string): Pre['tfs'][number] => p.tfs.find((t) => t.tf === k) as Pre['tfs'][number];
    const plants: Array<[string, (m: Measures, p: Pre, v: number) => void]> = [
      ['1h A4 excess over the coin flip', (m, _p, v) => { at(m, '1h').a4.excess.coin.point = v; }],
      ['1h A4 excess over always-up', (m, _p, v) => { at(m, '1h').a4.excess.always_up.point = v; }],
      ['1h Δ1', (m, _p, v) => { at(m, '1h').d1.delta1.point = v; }],
      ...TF_KEYS.map((k): [string, (m: Measures, p: Pre, v: number) => void] => [`${k} flip-flops per 1,000 bars`, (m, _p, v) => { at(m, k).flip_flops.per_1000 = v; }]),
      ['A4 pair estimate', (m, _p, v) => { m.a4_pair.theta.point = v; }],
      ['A4 pair lower bound', (m, _p, v) => { m.a4_pair.theta.lb = v; }],
      ['Δ1 pair estimate', (m, _p, v) => { m.d1_pair.theta.point = v; }],
      ['Δ1 pair lower bound', (m, _p, v) => { m.d1_pair.theta.lb = v; }],
      // the floor record's own verdict is left green: Bar A must refuse the value itself
      ...TF_KEYS.flatMap((k) => (['a4_eff', 'd1_eff', 'ff_coin_days'] as const).map((field): [string, (m: Measures, p: Pre, v: number) => void] => [`${k} ${field}`, (_m, p, v) => { pt(p, k)[field] = v; }])),
      ['the floor F', (_m, p, v) => { p.F = v; }],
    ];
    expect(plants).toHaveLength(3 + 4 + 4 + 12 + 1);
    for (const [name, plant] of plants) {
      for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const m = madeMeasures(BASE), p = madePre();
        plant(m, p, v);
        const d = decide(m, p, true);
        expect([d.state, d.causes.includes('non_finite')], `${name} = ${v}`).toEqual(['INDETERMINATE', true]);
        expect(d.line, `${name} = ${v}`).toMatch(/^REGIME_15M_BACKTEST=INDETERMINATE \((?:[a-z_]+, )*non_finite/);
        expect(d.map.map((r) => r.state), `${name} = ${v}`).toEqual(['too little data', 'too little data', 'too little data']);
      }
    }
    // the planting reached nothing else: the same measures, unplanted, PASS
    expect(decide(madeMeasures(BASE), madePre(), true).state).toBe('PASS');
  });

  it('names every cause, in the registered order', () => {
    expect(CAUSES).toEqual(['parity', 'not_identifiable', 'floor', 'non_finite', 'throw']);
    const d = state({ a4Up1h: 0, ff: { '15m': Number.NaN, '1h': 12, '4h': 30, '1d': 10 } }, false, madePre(10, 50));
    expect(d.causes).toEqual(['parity', 'not_identifiable', 'floor', 'non_finite']);
    expect(d.line).toBe('REGIME_15M_BACKTEST=INDETERMINATE (parity, not_identifiable, floor, non_finite)');
    expect(thrown()).toEqual({ state: 'INDETERMINATE', causes: ['throw'], line: 'REGIME_15M_BACKTEST=INDETERMINATE (throw)' });
    expect([lineOf('PASS', []), lineOf('FAIL', [])]).toEqual(['REGIME_15M_BACKTEST=PASS', 'REGIME_15M_BACKTEST=FAIL']);
  });

  it('the underpowered note never changes a state; a FAIL whose every failing criterion carries it reads FAIL (underpowered)', () => {
    const wide = state({ a4Theta: { point: 3, lb: -2 } });
    expect([wide.state, wide.criteria[0].underpowered, wide.line]).toEqual(['PASS', true, 'REGIME_15M_BACKTEST=PASS']);
    expect(state({ a4Theta: { point: 0, lb: -1 } }).criteria[0].underpowered).toBe(false);
    // δ_A4 = 5: an interval whose lower half is at least 5 wide cannot resolve δ — 15m equal to 1h would fail too
    const blind = state({ a4Theta: { point: 0, lb: -6 } });
    expect([blind.state, blind.causes, blind.criteria[0].underpowered, blind.line]).toEqual(['FAIL', [], true, 'REGIME_15M_BACKTEST=FAIL (underpowered)']);
    // a FAIL resolved at δ (the interval is narrower than δ and still below −δ) carries no annotation
    const worse = state({ a4Theta: { point: -8, lb: -9 } });
    expect([worse.state, worse.criteria[0].underpowered, worse.line]).toEqual(['FAIL', false, 'REGIME_15M_BACKTEST=FAIL']);
    // the annotation follows a FAILING criterion only: an underpowered criterion that holds beside a flip-flop failure does not carry it
    const ff = state({ a4Theta: { point: 3, lb: -2 }, ff: { '15m': 31, '1h': 12, '4h': 30, '1d': 10 } });
    expect([ff.state, ff.criteria[0].holds, ff.criteria[0].underpowered, ff.line]).toEqual(['FAIL', true, true, 'REGIME_15M_BACKTEST=FAIL']);
    // every failing criterion must carry it (ruling R2-F1): both A4 and Δ1 failing, both unresolved at δ
    const both = state({ a4Theta: { point: 0, lb: -6 }, d1Theta: { point: 0, lb: -5 } });
    expect([both.state, both.criteria.map((c) => [c.holds, c.underpowered]), both.line]).toEqual(['FAIL', [[false, true], [false, true], [true, null]], 'REGIME_15M_BACKTEST=FAIL (underpowered)']);
    // mixed: an unresolved A4 failure beside a flip-flop failure (no interval, so never underpowered) is plain FAIL
    const withFf = state({ a4Theta: { point: 0, lb: -6 }, ff: { '15m': 31, '1h': 12, '4h': 30, '1d': 10 } });
    expect([withFf.state, withFf.criteria.map((c) => [c.holds, c.underpowered]), withFf.line]).toEqual(['FAIL', [[false, true], [true, false], [false, null]], 'REGIME_15M_BACKTEST=FAIL']);
    // mixed: an unresolved A4 failure beside a Δ1 failure resolved at δ (δ_Δ1 = 4, interval 1 wide, LB −9) is plain FAIL
    const withD1 = state({ a4Theta: { point: 0, lb: -6 }, d1Theta: { point: -8, lb: -9 } });
    expect([withD1.state, withD1.criteria.map((c) => [c.holds, c.underpowered]), withD1.line]).toEqual(['FAIL', [[false, true], [false, false], [true, null]], 'REGIME_15M_BACKTEST=FAIL']);
    expect([lineOf('FAIL', [], true), lineOf('PASS', [], true), lineOf('INDETERMINATE', ['floor'], true)])
      .toEqual(['REGIME_15M_BACKTEST=FAIL (underpowered)', 'REGIME_15M_BACKTEST=PASS', 'REGIME_15M_BACKTEST=INDETERMINATE (floor)']);
  });

  it('the component map: one row per criterion, its dial, read on its own floor and its own δ', () => {
    const d = state({ d1Theta: { point: 0, lb: -9 } });
    expect(d.map.map((r) => [r.criterion, r.dial, r.state])).toEqual([['D1', 'REGIME_AGAINST_MIN_CONFIDENCE', 'broken'], ['A4', 'REGIME_15M_WINDOW_BARS', 'works'], ['FF', 'REGIME_15M_WINDOW_BARS', 'works']]);
    // A4 under its floor at 15m: its row alone has too little data
    const low = state({}, true, madePre(100, 50, { '15m': { a4_eff: 10 } }));
    expect(low.map.map((r) => r.state)).toEqual(['works', 'too little data', 'works']);
    // δ_A4 ≤ 0: the direction row cannot be read
    expect(state({ a4Up1h: 0 }).map.map((r) => r.state)).toEqual(['works', 'too little data', 'works']);
  });
});
