/**
 * OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 · CH2 — the monthly-rate primitive.
 *
 * `subscriber_profiles.amount_usd` stores the CHARGE, so a $79 annual prepayment and a
 * hypothetical $79 monthly charge are the same stored number — **a stored amount without a
 * period is not a rate**. `planMonthlyRateUsd` is the ONE derivation that turns a (plan,
 * interval) pair into an MRR contribution, and it derives from the two architect-set prices in
 * `PLANS`, never from arithmetic on the charge.
 *
 * Two things here are load-bearing beyond ordinary coverage:
 *
 *   1. **The byte-identity proof.** `planAnnualMonthlyEquivalent` was refactored to FORMAT from
 *      the new primitive instead of re-dividing. That string is live buyer-facing copy on the
 *      pricing page ("$6.58/mo effective"), and the architect's condition for accepting the
 *      refactor was that no rendered byte moves. These tests compare the new output against the
 *      literal pre-refactor expression, so the guarantee is checked rather than asserted.
 *   2. **The divisor appears exactly once.** Architect ruling (2026-08-05) replacing the spec's
 *      AC 2.4: the property was never "no /12 literal" (that banned the mechanism where it meant
 *      to require the guard) but "derive from PLANS, refuse rather than fabricate, and divide in
 *      exactly one place". A `MONTHS_PER_YEAR` constant was explicitly rejected — naming the
 *      divisor at one of two adjacent call sites and not the other manufactures drift.
 *
 * Value-level coverage of the annual ladder itself lives in `tests/unit/plans-annual.test.ts`
 * and is deliberately not duplicated here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  PLANS,
  planMonthlyRateUsd,
  planAnnualMonthlyEquivalent,
  type PaidPlanId,
} from '../src/lib/plans.js';

const ALL_TIERS: PaidPlanId[] = ['starter', 'pro', 'enterprise'];
const ANNUAL_TIERS: PaidPlanId[] = ['starter', 'pro'];

describe('planMonthlyRateUsd — the single MRR derivation', () => {
  it('returns the monthly price verbatim for a monthly subscription, every tier', () => {
    for (const tier of ALL_TIERS) {
      expect(planMonthlyRateUsd(tier, 'month')).toBe(PLANS[tier].priceUsdMonthly);
    }
  });

  it('returns the annual price divided across the year for an annual subscription', () => {
    expect(planMonthlyRateUsd('starter', 'year')).toBe(79 / 12);
    expect(planMonthlyRateUsd('pro', 'year')).toBe(299 / 12);
  });

  it('returns the rate UNROUNDED — rounding is the caller’s presentation choice', () => {
    // 79/12 = 6.58333…  If the primitive rounded to cents this would be 6.58 and the
    // byte-identity guarantee below would be accidental rather than structural.
    const starter = planMonthlyRateUsd('starter', 'year')!;
    expect(starter).not.toBe(6.58);
    expect(starter).toBeCloseTo(6.5833, 4);
  });

  it('🛑 REFUSES for a plan sold monthly-only — null, never a fabricated annual rate', () => {
    // Enterprise has no priceUsdAnnual at all. Dividing a price nobody set would invent an
    // annual Enterprise tier that is not on sale.
    expect(PLANS.enterprise.priceUsdAnnual).toBeUndefined();
    expect(planMonthlyRateUsd('enterprise', 'year')).toBeNull();
  });

  it('🛑 null is a REFUSAL, not a zero — a plan we cannot price is not one worth nothing', () => {
    const rate = planMonthlyRateUsd('enterprise', 'year');
    expect(rate).toBeNull();
    expect(rate).not.toBe(0);
    // The distinction is the whole point: summing null-as-0 into MRR would silently report an
    // Enterprise annual subscriber as contributing $0/mo.
    expect([null, undefined]).toContain(rate ?? null);
  });

  it('the annual rate is always below the monthly price — otherwise "save" is a lie', () => {
    for (const tier of ANNUAL_TIERS) {
      expect(planMonthlyRateUsd(tier, 'year')!).toBeLessThan(planMonthlyRateUsd(tier, 'month')!);
    }
  });
});

describe('planAnnualMonthlyEquivalent — byte-identical after the refactor', () => {
  // The literal pre-refactor expression, reproduced here as the oracle. If the primitive ever
  // starts rounding, or the formatter stops using .toFixed(2), this diverges and fails.
  const preRefactor = (id: PaidPlanId): string | null => {
    const p = PLANS[id].priceUsdAnnual;
    if (typeof p !== 'number') return null;
    return `$${(p / 12).toFixed(2)}`;
  };

  it('renders exactly what the pre-refactor expression rendered, for EVERY tier', () => {
    for (const tier of ALL_TIERS) {
      expect(planAnnualMonthlyEquivalent(tier)).toBe(preRefactor(tier));
    }
  });

  it('still renders the live pricing-page strings to the cent', () => {
    expect(planAnnualMonthlyEquivalent('starter')).toBe('$6.58');
    expect(planAnnualMonthlyEquivalent('pro')).toBe('$24.92');
  });

  it('still returns null for the monthly-only tier — the null branch survived too', () => {
    expect(planAnnualMonthlyEquivalent('enterprise')).toBeNull();
    expect(preRefactor('enterprise')).toBeNull();
  });

  it('formats the primitive rather than re-dividing — the two agree to the cent', () => {
    for (const tier of ANNUAL_TIERS) {
      expect(planAnnualMonthlyEquivalent(tier)).toBe(`$${planMonthlyRateUsd(tier, 'year')!.toFixed(2)}`);
    }
  });
});

describe('the divisor appears exactly once (architect ruling on AC 2.4)', () => {
  /**
   * Strip comments before grepping for a construct, per CLAUDE.md: this file's own docblocks
   * discuss "/12" and "$79/12 = 6.5833…" in prose, and a naive count would demand deleting the
   * most valuable lines in the module. `check-canaries-wired.mjs` strips for the same reason —
   * a mention in a comment is not an occurrence.
   */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments, incl. every docblock
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))        // whole-line // comments
      .join('\n');

  const code = stripComments(readFileSync(path.resolve(process.cwd(), 'src/lib/plans.ts'), 'utf8'));

  it('divides by 12 in exactly ONE place in plans.ts', () => {
    const hits = code.match(/\/\s*12\b/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  it('that one place is planMonthlyRateUsd, not a formatter', () => {
    // The surviving divisor must sit in the primitive. If a future edit moves it back into
    // planAnnualMonthlyEquivalent, the single-derivation property is gone even though the
    // count above would still read 1.
    const fn = code.slice(code.indexOf('export function planMonthlyRateUsd'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/\/\s*12\b/);
    expect(body).toContain('priceUsdAnnual');
  });

  it('proves the strip is real — the raw source DOES mention /12 in prose', () => {
    // Vacuity guard: if stripComments ever returned '' or the file moved, the counts above
    // would pass trivially. This asserts the fixture is genuinely comment-bearing.
    const raw = readFileSync(path.resolve(process.cwd(), 'src/lib/plans.ts'), 'utf8');
    expect((raw.match(/\/\s*12\b/g) ?? []).length).toBeGreaterThan(1);
    expect(code.length).toBeGreaterThan(200);
  });

  it('does NOT introduce a MONTHS_PER_YEAR constant (explicitly rejected)', () => {
    expect(code).not.toMatch(/MONTHS_PER_YEAR/);
  });
});
