/**
 * PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH2) — the enforcement ladder is a PROJECTION of the
 * plan SoT, and the 6-month prepay figures are COMPUTED.
 *
 * WHY THIS TEST EXISTS, AND WHY IT IS NOT THE TEST THE SPEC ASKED FOR.
 *
 * The wave spec justified this chapter with "plans.ts documents a projection into
 * getMonthlyQuota that DOES NOT EXIST — they agree today by coincidence", and gated it with
 * `grep -cE '3_000|15_000|100_000|...' src/lib/license.ts` → 0.
 *
 * Both were false on live `main`. `OPS-QUOTA-EXHAUSTION-NOTICE-W1` (2026-08-02) had ALREADY made
 * `getMonthlyQuota` project from `PLANS`, so that grep returned **0 before any work was done** —
 * a gate that passes whether or not the chapter happens. Architect ratified dropping it (Q1-a,
 * 2026-08-08) and replacing it with this: an EQUIVALENCE test that can only pass while the
 * projection actually holds.
 *
 * PROVEN ABLE TO FAIL — this is the property the grep gate lacked. Change one `PLANS` value
 * (e.g. `starter.monthlyCalls: 10_000` → `9_999`) and `projects the monthly ladder` goes red,
 * because it compares the enforcement function against the SoT rather than against a literal.
 * Verified red-then-green during CH2; a literal-free assertion is the whole point, so do NOT
 * "improve" these by inlining the expected numbers.
 *
 * The daily half is new surface (R-B), so its projection is asserted the same way from day one
 * rather than being left to agree by coincidence the way the monthly half did.
 */
import { describe, it, expect } from 'vitest';
import {
  PLANS,
  FREE_MONTHLY_CALLS,
  FREE_DAILY_CALLS,
  INTERVAL_MONTHS,
  PREPAY_6MONTH_MONTHS,
  planPrepayTotalUsd,
  planPrepayMonthlyEquivalent,
  planPrepaySavingsPct,
  planPrepayPriceLabel,
  planHasSixMonth,
  planMonthlyRateUsd,
  planAnnualMonthlyEquivalent,
  planAnnualSavingsPct,
  type PaidPlanId,
} from '../../src/lib/plans.js';
import { getMonthlyQuota, getDailyCap } from '../../src/lib/license.js';

const PAID = Object.keys(PLANS) as PaidPlanId[];

describe('enforcement projects the plan SoT (never a second copy of the ladder)', () => {
  it('vacuity guard — there is a ladder to project', () => {
    expect(PAID.length).toBeGreaterThanOrEqual(3);
    expect(FREE_MONTHLY_CALLS).toBeGreaterThan(0);
    expect(FREE_DAILY_CALLS).toBeGreaterThan(0);
  });

  it('projects the monthly ladder for every paid tier', () => {
    for (const tier of PAID) {
      expect(getMonthlyQuota(tier), tier).toBe(PLANS[tier].monthlyCalls);
    }
  });

  it('projects the daily ladder for every paid tier, null meaning no ceiling', () => {
    for (const tier of PAID) {
      const declared = PLANS[tier].dailyCalls;
      expect(getDailyCap(tier), tier).toBe(declared === null ? Infinity : declared);
    }
  });

  it('projects the free allowances', () => {
    expect(getMonthlyQuota('free')).toBe(FREE_MONTHLY_CALLS);
    expect(getDailyCap('free')).toBe(FREE_DAILY_CALLS);
  });

  it('exempts x402 and internal on BOTH meters', () => {
    for (const tier of ['x402', 'internal'] as const) {
      expect(getMonthlyQuota(tier), tier).toBe(Infinity);
      expect(getDailyCap(tier), tier).toBe(Infinity);
    }
  });

  it('a null daily cap is "no ceiling", never zero', () => {
    // Enterprise is contact-us: its pacing is whatever a real deal sets. Collapsing null to 0
    // would refuse every call on the tier that pays the most.
    expect(PLANS.enterprise.dailyCalls).toBeNull();
    expect(getDailyCap('enterprise')).toBe(Infinity);
    expect(getDailyCap('enterprise')).not.toBe(0);
  });

  it('the two meters are independent, not nested', () => {
    // If daily were a sub-limit of monthly, dailyCalls*31 would be <= monthlyCalls. It is not,
    // by design (R-B) — a Starter may spend its whole month in ten days.
    for (const tier of PAID) {
      const d = PLANS[tier].dailyCalls;
      if (d === null) continue;
      expect(d).toBeLessThan(PLANS[tier].monthlyCalls);
    }
    expect((PLANS.starter.dailyCalls as number) * 31).toBeGreaterThan(PLANS.starter.monthlyCalls);
  });
});

describe('R-B ladder — the architect-set values', () => {
  // The ONE place literals are legitimate: pinning what Mr.1 actually ruled (2026-08-08).
  // Everything else in this file compares derived-vs-SoT so it cannot rot.
  it('is Free 500/100, Starter 10K/1K, Pro 100K/10K', () => {
    expect([FREE_MONTHLY_CALLS, FREE_DAILY_CALLS]).toEqual([500, 100]);
    expect([PLANS.starter.monthlyCalls, PLANS.starter.dailyCalls]).toEqual([10_000, 1_000]);
    expect([PLANS.pro.monthlyCalls, PLANS.pro.dailyCalls]).toEqual([100_000, 10_000]);
  });

  it('keeps Enterprise at 100K internal enforcement with no published daily cap (R-E)', () => {
    expect(PLANS.enterprise.monthlyCalls).toBe(100_000);
    expect(PLANS.enterprise.dailyCalls).toBeNull();
  });
});

describe('AC2.4 — 6-month figures are COMPUTED, and compute to the ratified numbers', () => {
  it('vacuity guard — both plans are actually sold on the 6-month term', () => {
    expect(planHasSixMonth('starter')).toBe(true);
    expect(planHasSixMonth('pro')).toBe(true);
    expect(planHasSixMonth('enterprise')).toBe(false);
  });

  it('Starter: $39.90 total → $6.65/mo · 33%', () => {
    expect(planPrepayTotalUsd('starter', PREPAY_6MONTH_MONTHS)).toBe(39.90);
    expect(planPrepayPriceLabel('starter', PREPAY_6MONTH_MONTHS)).toBe('$39.90');
    expect(planPrepayMonthlyEquivalent('starter', PREPAY_6MONTH_MONTHS)).toBe('$6.65');
    expect(planPrepaySavingsPct('starter', PREPAY_6MONTH_MONTHS)).toBe(33);
  });

  it('Pro: $129 total → $21.50/mo · 56%', () => {
    expect(planPrepayTotalUsd('pro', PREPAY_6MONTH_MONTHS)).toBe(129);
    expect(planPrepayPriceLabel('pro', PREPAY_6MONTH_MONTHS)).toBe('$129');
    expect(planPrepayMonthlyEquivalent('pro', PREPAY_6MONTH_MONTHS)).toBe('$21.50');
    expect(planPrepaySavingsPct('pro', PREPAY_6MONTH_MONTHS)).toBe(56);
  });

  it('derives the label from the price rather than agreeing with it by coincidence', () => {
    // The assertions above name the ratified figures. This one proves they are a FUNCTION of
    // the SoT: recompute independently and require the rendered strings to match.
    for (const id of ['starter', 'pro'] as const) {
      const total = PLANS[id].priceUsd6Month as number;
      expect(planPrepayMonthlyEquivalent(id, 6)).toBe(`$${(total / 6).toFixed(2)}`);
      expect(planPrepaySavingsPct(id, 6)).toBe(
        Math.round((1 - total / (PLANS[id].priceUsdMonthly * 6)) * 100),
      );
    }
  });

  it('refuses a term the plan is not sold on, rather than fabricating one', () => {
    expect(planPrepayTotalUsd('enterprise', PREPAY_6MONTH_MONTHS)).toBeNull();
    expect(planPrepayMonthlyEquivalent('enterprise', PREPAY_6MONTH_MONTHS)).toBeNull();
    expect(planPrepaySavingsPct('enterprise', PREPAY_6MONTH_MONTHS)).toBeNull();
    expect(planPrepayTotalUsd('starter', 3)).toBeNull(); // no 3-month term exists
  });
});

describe('INTERVAL_MONTHS — the divisor is a table, and the annual surface still projects it', () => {
  it('covers every BillingInterval member', () => {
    // Exhaustiveness is enforced by tsc on the Record type; this asserts the VALUES, which tsc
    // cannot. A wrong month count here silently misprices MRR for every subscription.
    // R-C: `'year'` left BillingInterval; `'6month'` replaced it.
    expect(INTERVAL_MONTHS).toEqual({ month: 1, '6month': 6 });
  });

  it('planMonthlyRateUsd is INTERVAL_MONTHS applied to the prepay total', () => {
    for (const tier of PAID) {
      expect(planMonthlyRateUsd(tier, 'month'), tier).toBe(PLANS[tier].priceUsdMonthly);
      const six = PLANS[tier].priceUsd6Month;
      expect(planMonthlyRateUsd(tier, '6month'), tier).toBe(
        typeof six === 'number' ? six / INTERVAL_MONTHS['6month'] : null,
      );
    }
  });

  it('the annual delegates render byte-identically to before the refactor', () => {
    // CH2 rewrote these as thin delegates over the months-parameterised helpers. These strings
    // are LIVE on the pricing page until CH6 removes annual, so the bytes may not move.
    expect(planAnnualMonthlyEquivalent('starter')).toBe('$6.58');
    expect(planAnnualMonthlyEquivalent('pro')).toBe('$24.92');
    expect(planAnnualMonthlyEquivalent('enterprise')).toBeNull();
    expect(planAnnualSavingsPct('starter')).toBe(34);
    expect(planAnnualSavingsPct('pro')).toBe(49);
    expect(planAnnualSavingsPct('enterprise')).toBeNull();
  });
});
