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
}

/** The paid ladder. Free (100/mo) is not a plan — it is the absence of one. */
export const PLANS: Readonly<Record<PaidPlanId, PlanSpec>> = {
  starter: { label: 'Starter', monthlyCalls: 3_000, priceUsdMonthly: 9.99 },
  pro: { label: 'Pro', monthlyCalls: 15_000, priceUsdMonthly: 49 },
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
