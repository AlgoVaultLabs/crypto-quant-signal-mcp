/**
 * plans.ts — the ONE machine-readable source of truth for the paid plan ladder
 * (OPS-QUOTA-EXHAUSTION-NOTICE-W1, 2026-08-02).
 *
 * Why this module exists: before this wave the plan facts were derived THREE times and
 * nowhere machine-readably —
 *   - call allowances lived in `license.ts:getMonthlyQuota` (a switch of literals),
 *   - dollar prices lived ONLY as HTML literals in `signup-flow.ts:renderPlanCards`
 *     and `welcome-page.ts`,
 *   - the quota-exhaustion notice restated BOTH ("Starter, 3,000 calls/mo, $9.99") as a
 *     third copy inside a template string.
 * A price move therefore had to be found in three unrelated files, and the notice — the
 * single highest-intent surface the product has — was the copy most likely to rot.
 * Per the CLAUDE.md single-derivation rule: compute the fact ONCE, project everywhere.
 *
 * LEAF MODULE — imports nothing, so every consumer (the pure `quota-notice` formatter,
 * `license.ts`, the HTML renderers) can read it without an import cycle.
 *
 * PUBLIC-COPY NOTE: `priceUsdMonthly` is here so a RECOMMENDATION can be computed from it
 * (the x402 break-even), NOT so the notice can print it. The notice links to the plan page
 * rather than inlining a dollar figure — a link cannot go stale.
 */

export type PaidPlanId = 'starter' | 'pro' | 'enterprise';

export interface PlanSpec {
  /** Display name as it appears in public copy. */
  readonly label: string;
  /** Monthly call allowance. The SoT `getMonthlyQuota` projects from. */
  readonly monthlyCalls: number;
  /** Monthly subscription price in USD. */
  readonly priceUsdMonthly: number;
  /**
   * Annual prepay price in USD, or `undefined` when the plan is not sold annually
   * (PRICING-ANNUAL-AND-HOLD-PROMISE-W1). Enterprise is deliberately absent — it is a
   * contact-us tier with no self-serve price at all.
   *
   * The allowance does NOT change with interval: an annual Starter still gets
   * `monthlyCalls` per month. Interval is a billing cadence, never an entitlement.
   */
  readonly priceUsdAnnual?: number;
}

/**
 * The paid ladder. Free (100/mo) is not a plan — it is the absence of one.
 *
 * Annual prices are architect-set (Mr.1, 2026-08-05), NOT derived from a discount rate: the
 * two discounts differ (Starter 34%, Pro 49%) because they were chosen per-tier. Every
 * *displayed* discount is computed back off these two numbers by `planAnnualSavingsPct`, so
 * the page can never claim a percentage the price does not support.
 */
export const PLANS: Readonly<Record<PaidPlanId, PlanSpec>> = {
  starter: { label: 'Starter', monthlyCalls: 3_000, priceUsdMonthly: 9.99, priceUsdAnnual: 79 },
  pro: { label: 'Pro', monthlyCalls: 15_000, priceUsdMonthly: 49, priceUsdAnnual: 299 },
  enterprise: { label: 'Enterprise', monthlyCalls: 100_000, priceUsdMonthly: 299 },
};

/** Free-tier monthly call allowance. Operator-FROZEN at 100 (OPS-QUOTA-EXHAUSTION-NOTICE-W1). */
export const FREE_MONTHLY_CALLS = 100;

/** The plan a free caller is upsold to. Every free→paid CTA points here. */
export const DEFAULT_UPGRADE_PLAN: PaidPlanId = 'starter';

/** Locale-grouped allowance for copy (`3,000`). Never hand-typed at a call site. */
export function planCallsLabel(id: PaidPlanId): string {
  return PLANS[id].monthlyCalls.toLocaleString('en-US');
}

/** Price as it renders in copy (`$9.99`, `$49`). Trailing `.00` is never emitted. */
export function planPriceLabel(id: PaidPlanId): string {
  const p = PLANS[id].priceUsdMonthly;
  return `$${Number.isInteger(p) ? p : p.toFixed(2)}`;
}

// ── Annual prepay (PRICING-ANNUAL-AND-HOLD-PROMISE-W1) ──
//
// Every annual figure on every surface is COMPUTED from `priceUsdAnnual` + `priceUsdMonthly`.
// Nothing downstream may hand-type "$79", "$6.58/mo" or "Save 34%": the whole point of the
// single-derivation rule here is that moving a price moves the badge, the effective rate and
// the copy together, so the page cannot advertise a discount the price does not support.

/** True when the plan is sold annually. Enterprise is not — it is contact-us. */
export function planHasAnnual(id: PaidPlanId): boolean {
  return typeof PLANS[id].priceUsdAnnual === 'number';
}

/** Annual price as it renders in copy (`$79`, `$299`), or null when not sold annually. */
export function planAnnualPriceLabel(id: PaidPlanId): string | null {
  const p = PLANS[id].priceUsdAnnual;
  if (typeof p !== 'number') return null;
  return `$${Number.isInteger(p) ? p : p.toFixed(2)}`;
}

/**
 * What the annual price works out to per month (`$6.58`, `$24.92`), or null.
 *
 * This is the number a buyer actually compares against the monthly price, so it is always
 * shown alongside the annual total rather than instead of it — quoting only "$6.58/mo" for a
 * plan that bills $79 once a year would be the misleading framing the public-copy LAW forbids.
 */
export function planAnnualMonthlyEquivalent(id: PaidPlanId): string | null {
  const p = PLANS[id].priceUsdAnnual;
  if (typeof p !== 'number') return null;
  return `$${(p / 12).toFixed(2)}`;
}

/**
 * Whole-percent saving of annual prepay vs paying monthly for a year, or null.
 *
 * Rounded to the nearest percent for copy. Starter → 34 (79 vs 119.88), Pro → 49 (299 vs 588).
 */
export function planAnnualSavingsPct(id: PaidPlanId): number | null {
  const spec = PLANS[id];
  const annual = spec.priceUsdAnnual;
  if (typeof annual !== 'number' || spec.priceUsdMonthly <= 0) return null;
  return Math.round((1 - annual / (spec.priceUsdMonthly * 12)) * 100);
}

/**
 * Monthly call volume at which a subscription becomes cheaper than paying per call.
 *
 * Derived LIVE from the two prices — the plan's monthly price divided by the per-call
 * x402 price (which the caller supplies from the feature-registry `x402.basePriceUsd`
 * SoT). At Starter $9.99 and x402 $0.02 that is ~500 calls/month: below it an agent
 * should pay per call, above it the subscription wins. Nothing is hardcoded, so moving
 * either price moves the recommendation with zero code change.
 *
 * Returns `null` when no per-call price is available (no live x402 rail) — the caller
 * then has only one path to recommend and no comparison to make.
 */
export function subscriptionBreakEvenCalls(
  perCallUsd: number | undefined,
  plan: PaidPlanId = DEFAULT_UPGRADE_PLAN,
): number | null {
  if (typeof perCallUsd !== 'number' || !Number.isFinite(perCallUsd) || perCallUsd <= 0) return null;
  return Math.round(PLANS[plan].priceUsdMonthly / perCallUsd);
}
