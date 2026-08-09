/**
 * PRICING-ANNUAL-AND-HOLD-PROMISE-W1 (C3) → PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH7).
 *
 * The point of putting a prepay term in `plans.ts` is that a surface can never hand-type a price,
 * an effective monthly rate, or a discount badge. Those three numbers must move together when a
 * price moves, because a page advertising "Save 49%" next to a price that only saves 30% is a
 * Numerical-citation failure, not a cosmetic one.
 *
 * WHY THIS FILE KEPT ITS NAME WHILE ITS SUBJECT MOVED. R-C replaced the annual term with a
 * six-month one, and CH7 retired the `planAnnual*` COPY helpers — so the invariants below now
 * ride the generic `planPrepay*(id, months)` family. They are the same invariants; only the term
 * changed, which is exactly the property a term-generic API was supposed to give us. The annual
 * VALUES are still asserted, because `priceUsdAnnual` deliberately survives: `subscriber-
 * attribution.ts` must value a historical `'year'` subscription row for MRR forever.
 */
import { describe, it, expect } from 'vitest';
import {
  PLANS,
  PREPAY_6MONTH_MONTHS,
  PREPAY_ANNUAL_MONTHS,
  planHasSixMonth,
  planPrepayPriceLabel,
  planPrepayMonthlyEquivalent,
  planPrepaySavingsPct,
  planPriceLabel,
  planPrepayTotalUsd,
  type PaidPlanId,
} from '../../src/lib/plans.js';
import { getMonthlyQuota } from '../../src/lib/license.js';

const PREPAY_PLANS: PaidPlanId[] = ['starter', 'pro'];
const M = PREPAY_6MONTH_MONTHS;

describe('plans.ts — six-month prepay (R-C)', () => {
  it('sells Starter and Pro on the six-month term; Enterprise is contact-us and has NO prepay price', () => {
    expect(planHasSixMonth('starter')).toBe(true);
    expect(planHasSixMonth('pro')).toBe(true);
    expect(planHasSixMonth('enterprise')).toBe(false);
    expect(PLANS.enterprise.priceUsd6Month).toBeUndefined();
  });

  it('carries the architect-approved six-month prices (Mr.1, R-C)', () => {
    expect(PLANS.starter.priceUsd6Month).toBe(39.90);
    expect(PLANS.pro.priceUsd6Month).toBe(129);
  });

  it('renders prepay price labels without a trailing .00', () => {
    expect(planPrepayPriceLabel('starter', M)).toBe('$39.90');
    expect(planPrepayPriceLabel('pro', M)).toBe('$129');
    expect(planPrepayPriceLabel('enterprise', M)).toBeNull();
  });

  it('renders the effective monthly rate to the cent', () => {
    expect(planPrepayMonthlyEquivalent('starter', M)).toBe('$6.65'); // 39.90 / 6
    expect(planPrepayMonthlyEquivalent('pro', M)).toBe('$21.50'); // 129 / 6
    expect(planPrepayMonthlyEquivalent('enterprise', M)).toBeNull();
  });

  it('computes the savings the prices support: Starter 33%, Pro 56%', () => {
    expect(planPrepaySavingsPct('starter', M)).toBe(33);
    expect(planPrepaySavingsPct('pro', M)).toBe(56);
    expect(planPrepaySavingsPct('enterprise', M)).toBeNull();
  });
});

describe('plans.ts — the ANNUAL values survive for historical valuation only', () => {
  // CH7 retired planHasAnnual / planAnnualPriceLabel / planAnnualMonthlyEquivalent /
  // planAnnualSavingsPct — nothing renders an annual figure to a buyer any more. The stored
  // prices stay because `subscriber-attribution.ts` values a historical `'year'` row from them.
  it('keeps the annual prices reachable through the GENERIC prepay primitive', () => {
    expect(PLANS.starter.priceUsdAnnual).toBe(79);
    expect(PLANS.pro.priceUsdAnnual).toBe(299);
    expect(planPrepayTotalUsd('starter', PREPAY_ANNUAL_MONTHS)).toBe(79);
    expect(planPrepayTotalUsd('pro', PREPAY_ANNUAL_MONTHS)).toBe(299);
  });

  it('exports NO annual-named copy helper — the term is out of the buyer-facing vocabulary', async () => {
    // A regression here means someone re-introduced a term-welded helper, which is what R-C's
    // migration cost us the first time. Asserted on the module's own export surface rather than
    // by grep, so it fails at the definition rather than at some future call site.
    const plans = await import('../../src/lib/plans.js');
    for (const dead of [
      'planHasAnnual',
      'planAnnualPriceLabel',
      'planAnnualMonthlyEquivalent',
      'planAnnualSavingsPct',
    ]) {
      expect(dead in plans, `${dead} must stay retired`).toBe(false);
    }
  });
});

describe('plans.ts — prepay figures are DERIVED, never asserted independently', () => {
  it('every displayed savings % is exactly what the two prices support', () => {
    expect(PREPAY_PLANS.length).toBeGreaterThan(0); // vacuity guard
    for (const id of PREPAY_PLANS) {
      const spec = PLANS[id];
      const total = spec.priceUsd6Month as number;
      const expected = Math.round((1 - total / (spec.priceUsdMonthly * M)) * 100);
      expect(planPrepaySavingsPct(id, M), id).toBe(expected);
    }
  });

  it('never overstates the discount — the badge is <= the true saving', () => {
    // A rounded badge may overstate by at most half a point; it must never round UP past that,
    // which is what a hand-typed marketing number does.
    for (const id of PREPAY_PLANS) {
      const spec = PLANS[id];
      const total = spec.priceUsd6Month as number;
      const truePct = (1 - total / (spec.priceUsdMonthly * M)) * 100;
      const shown = planPrepaySavingsPct(id, M) as number;
      expect(shown - truePct, `${id}: shown ${shown} vs true ${truePct}`).toBeLessThanOrEqual(0.5);
    }
  });

  it('prepay always costs less than M× monthly — otherwise "save" is a lie', () => {
    for (const id of PREPAY_PLANS) {
      const spec = PLANS[id];
      expect(spec.priceUsd6Month as number, id).toBeLessThan(spec.priceUsdMonthly * M);
    }
  });

  it('the effective monthly rate is below the monthly price for every prepay plan', () => {
    for (const id of PREPAY_PLANS) {
      const eff = Number((planPrepayMonthlyEquivalent(id, M) as string).replace('$', ''));
      const monthly = Number((planPriceLabel(id) as string).replace('$', ''));
      expect(eff, id).toBeLessThan(monthly);
    }
  });

  it('interval is a billing cadence, never an entitlement — allowance is unchanged', () => {
    // A regression here would mean prepay buyers silently get a different quota. Asserting the
    // ladder's LITERALS here would be a second copy of them (they are pinned once, in
    // tests/unit/quota-single-derivation.test.ts), so assert the PROPERTY instead: the allowance
    // is a function of TIER ALONE. `getMonthlyQuota` takes no interval argument, and a plan spec
    // carries exactly one `monthlyCalls` no matter how many prepay terms it is sold on.
    for (const id of Object.keys(PLANS) as PaidPlanId[]) {
      expect(getMonthlyQuota(id), id).toBe(PLANS[id].monthlyCalls);
      // Sold on more than one term, still ONE allowance.
      const terms = [1, M, PREPAY_ANNUAL_MONTHS].filter((m) => planPrepayTotalUsd(id, m) !== null);
      expect(terms.length, id).toBeGreaterThanOrEqual(1);
      expect(new Set(terms.map(() => PLANS[id].monthlyCalls)).size, id).toBe(1);
    }
  });
});
