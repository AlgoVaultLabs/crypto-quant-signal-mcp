/**
 * OPS-BITMART-ENUM-RECONCILE-W1 CH4-B — the force floor, both directions.
 *
 * Before this, `--force` promoted past ANY failure including `pfe_wr === null`, and the "floor"
 * that was supposed to stop that existed only as prose in a prior wave's endpoint-truth doc — so a
 * dispatching spec built its ONLY abort condition on a gate that did not exist. A suppression-only
 * test would let the promote path rot dark, so BOTH directions are asserted here.
 */
import { describe, it, expect } from 'vitest';
import { forceFloorBreaches } from '../../src/scripts/promote-venue.js';

describe('force floor — --force buys the SOFT criteria, never these', () => {
  it('CLEARS for a below-bar-but-above-floor venue (the WEEX shape: sample-short, WR strong)', () => {
    // 70.35% of the sample bar and 83 days, WR 93.4% — early, but evidenced.
    expect(forceFloorBreaches({ days_since: 83, pfe_wr: 0.9343 })).toEqual([]);
  });

  it('REFUSES a null pfe_wr even with --force — unevidenced, not merely early', () => {
    const tripped = forceFloorBreaches({ days_since: 400, pfe_wr: null });
    expect(tripped).toHaveLength(1);
    expect(tripped[0]).toMatch(/pfe_wr=null/);
    expect(tripped[0]).toMatch(/nothing to judge/);
  });

  it('REFUSES a win rate below the 0.70 floor, and NAMES the measured value', () => {
    const tripped = forceFloorBreaches({ days_since: 400, pfe_wr: 0.6999 });
    expect(tripped).toHaveLength(1);
    expect(tripped[0]).toMatch(/70\.0%/);
    expect(tripped[0]).toMatch(/floor 70%/);
  });

  it('REFUSES a venue younger than the 7-day floor', () => {
    const tripped = forceFloorBreaches({ days_since: 6, pfe_wr: 0.99 });
    expect(tripped).toHaveLength(1);
    expect(tripped[0]).toMatch(/days_since=6/);
  });

  it('reports EVERY tripped condition, not just the first', () => {
    const tripped = forceFloorBreaches({ days_since: 2, pfe_wr: null });
    expect(tripped).toHaveLength(2);
  });

  it('the floor is a FLOOR, not the promotion bar — 0.70 exactly clears, 0.80 is the soft bar', () => {
    expect(forceFloorBreaches({ days_since: 7, pfe_wr: 0.70 })).toEqual([]);
    // A venue between the floor and the bar is exactly what --force exists for.
    expect(forceFloorBreaches({ days_since: 7, pfe_wr: 0.75 })).toEqual([]);
  });
});
