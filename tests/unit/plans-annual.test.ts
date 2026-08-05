/**
 * PRICING-ANNUAL-AND-HOLD-PROMISE-W1 (C3) — annual prepay in the plan SoT.
 *
 * The point of putting annual in `plans.ts` is that a surface can never hand-type a price, an
 * effective monthly rate, or a discount badge. Those three numbers must move together when a
 * price moves, because a page advertising "Save 49%" next to a price that only saves 30% is a
 * Numerical-citation failure, not a cosmetic one.
 *
 * So these tests pin the VALUES the architect approved (Starter $79 / Pro $299) and, separately,
 * pin the INVARIANT that every derived figure is recomputed from the two prices rather than
 * asserted independently — the savings test would still fail if someone edited the badge to a
 * flattering number without moving the price.
 */
import { describe, it, expect } from 'vitest';
import {
  PLANS,
  planHasAnnual,
  planAnnualPriceLabel,
  planAnnualMonthlyEquivalent,
  planAnnualSavingsPct,
  planPriceLabel,
  type PaidPlanId,
} from '../../src/lib/plans.js';

const ANNUAL_PLANS: PaidPlanId[] = ['starter', 'pro'];

describe('plans.ts — annual prepay', () => {
  it('sells Starter and Pro annually; Enterprise is contact-us and has NO annual price', () => {
    expect(planHasAnnual('starter')).toBe(true);
    expect(planHasAnnual('pro')).toBe(true);
    expect(planHasAnnual('enterprise')).toBe(false);
    expect(PLANS.enterprise.priceUsdAnnual).toBeUndefined();
  });

  it('carries the architect-approved annual prices (Mr.1, 2026-08-05)', () => {
    expect(PLANS.starter.priceUsdAnnual).toBe(79);
    expect(PLANS.pro.priceUsdAnnual).toBe(299);
  });

  it('renders annual price labels without a trailing .00', () => {
    expect(planAnnualPriceLabel('starter')).toBe('$79');
    expect(planAnnualPriceLabel('pro')).toBe('$299');
    expect(planAnnualPriceLabel('enterprise')).toBeNull();
  });

  it('renders the effective monthly rate to the cent', () => {
    expect(planAnnualMonthlyEquivalent('starter')).toBe('$6.58'); // 79 / 12
    expect(planAnnualMonthlyEquivalent('pro')).toBe('$24.92'); // 299 / 12
    expect(planAnnualMonthlyEquivalent('enterprise')).toBeNull();
  });

  it('computes the savings the architect stated: Starter 34%, Pro 49%', () => {
    expect(planAnnualSavingsPct('starter')).toBe(34);
    expect(planAnnualSavingsPct('pro')).toBe(49);
    expect(planAnnualSavingsPct('enterprise')).toBeNull();
  });
});

describe('plans.ts — annual figures are DERIVED, never asserted independently', () => {
  it('every displayed savings % is exactly what the two prices support', () => {
    expect(ANNUAL_PLANS.length).toBeGreaterThan(0); // vacuity guard
    for (const id of ANNUAL_PLANS) {
      const spec = PLANS[id];
      const annual = spec.priceUsdAnnual as number;
      const expected = Math.round((1 - annual / (spec.priceUsdMonthly * 12)) * 100);
      expect(planAnnualSavingsPct(id), id).toBe(expected);
    }
  });

  it('never overstates the discount — the badge is <= the true saving', () => {
    // A rounded badge may overstate by at most half a point; it must never round UP past that,
    // which is what a hand-typed marketing number does.
    for (const id of ANNUAL_PLANS) {
      const spec = PLANS[id];
      const annual = spec.priceUsdAnnual as number;
      const truePct = (1 - annual / (spec.priceUsdMonthly * 12)) * 100;
      const shown = planAnnualSavingsPct(id) as number;
      expect(shown - truePct, `${id}: shown ${shown} vs true ${truePct}`).toBeLessThanOrEqual(0.5);
    }
  });

  it('annual always costs less than 12× monthly — otherwise "save" is a lie', () => {
    for (const id of ANNUAL_PLANS) {
      const spec = PLANS[id];
      expect(spec.priceUsdAnnual as number, id).toBeLessThan(spec.priceUsdMonthly * 12);
    }
  });

  it('the effective monthly rate is below the monthly price for every annual plan', () => {
    for (const id of ANNUAL_PLANS) {
      const eff = Number((planAnnualMonthlyEquivalent(id) as string).replace('$', ''));
      const monthly = Number((planPriceLabel(id) as string).replace('$', ''));
      expect(eff, id).toBeLessThan(monthly);
    }
  });

  it('interval is a billing cadence, never an entitlement — allowance is unchanged', () => {
    // A regression here would mean annual buyers silently get a different quota.
    expect(PLANS.starter.monthlyCalls).toBe(3_000);
    expect(PLANS.pro.monthlyCalls).toBe(15_000);
  });
});
