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

/**
 * Billing cadence.
 *
 * Declared HERE, in the plan SoT, for exactly the reason `PaidPlanId` is: an interval must not
 * be able to exist in billing that the plan ladder does not know how to price. `stripe.ts`
 * re-exports it, so every existing import site is unchanged (verified: it had no external
 * importers when this moved — OPS-STRIPE-SUBSCRIPTION-TRUTH-W1).
 *
 * `unknown` is deliberately NOT a member. It is a property of a stored RECORD ("we have not
 * established which cadence this row was sold on"), never of a plan, so it lives with the
 * record — see `StoredBillingInterval` in `subscriber-attribution.ts`.
 */
export type BillingInterval = 'month' | '6month';

export interface PlanSpec {
  /** Display name as it appears in public copy. */
  readonly label: string;
  /** Monthly call allowance. The SoT `getMonthlyQuota` projects from. */
  readonly monthlyCalls: number;
  /**
   * Per-UTC-day call allowance, or `null` when the plan has no daily ceiling
   * (PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1, R-B). The SoT `getDailyCap` projects from.
   *
   * TWO METERS, REFUSING INDEPENDENTLY. Monthly caps the budget; daily shapes the pacing. A
   * call is refused when EITHER is exhausted, so this is not a sub-limit of `monthlyCalls` and
   * `dailyCalls * 31` is deliberately not equal to it.
   *
   * `null` is "no daily ceiling", never "zero" — Enterprise is a contact-us tier whose pacing
   * is whatever a real deal sets, so it must not be fabricated here.
   */
  readonly dailyCalls: number | null;
  /** Monthly subscription price in USD. */
  readonly priceUsdMonthly: number;
  /**
   * Annual prepay price in USD, or `undefined` when the plan is not sold annually
   * (PRICING-ANNUAL-AND-HOLD-PROMISE-W1). Enterprise is deliberately absent — it is a
   * contact-us tier with no self-serve price at all.
   *
   * The allowance does NOT change with interval: an annual Starter still gets
   * `monthlyCalls` per month. Interval is a billing cadence, never an entitlement.
   *
   * ⚠️ RETIRED BY CH6 of PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-C): 6-month prepay
   * REPLACES annual. It survives this chapter only so `plans.ts` and its consumers move in
   * separate, individually-green commits — CH6 removes the field, the `'year'` interval and
   * every annual delegate together with `signup-flow.ts` and the annual suites.
   */
  readonly priceUsdAnnual?: number;
  /**
   * Six-month prepay price in USD, or `undefined` when the plan is not sold on it.
   * Architect-set (Mr.1, R-C): Starter $39.90, Pro $129. Standing prices — no scarcity framing.
   */
  readonly priceUsd6Month?: number;
}

/**
 * The paid ladder. Free (500/mo + 100/day) is not a plan — it is the absence of one.
 *
 * Prepay prices are architect-set, NOT derived from a discount rate: the two discounts differ
 * because they were chosen per-tier. Every *displayed* discount is computed back off these
 * numbers by `planPrepaySavingsPct`, so the page can never claim a percentage the price does
 * not support.
 */
export const PLANS: Readonly<Record<PaidPlanId, PlanSpec>> = {
  starter: { label: 'Starter', monthlyCalls: 10_000, dailyCalls: 1_000, priceUsdMonthly: 9.99, priceUsdAnnual: 79, priceUsd6Month: 39.90 },
  pro: { label: 'Pro', monthlyCalls: 100_000, dailyCalls: 10_000, priceUsdMonthly: 49, priceUsdAnnual: 299, priceUsd6Month: 129 },
  enterprise: { label: 'Enterprise', monthlyCalls: 100_000, dailyCalls: null, priceUsdMonthly: 299 },
};

/**
 * Free-tier monthly call allowance. Operator-FROZEN at 500 (Mr.1, 2026-08-08, R-B).
 *
 * Raised 100 → 500 in the same deploy that made EVERY verdict chargeable (R-A), so no existing
 * tracker is newly walled at cutover. Note the ceiling rises 5x while the measured hold rate
 * (98.6%) means consumption accelerates ~72x — the new ladder is deliberately tighter per
 * actionable verdict, which is the point, not an oversight.
 */
export const FREE_MONTHLY_CALLS = 500;

/**
 * Free-tier per-UTC-day call allowance (R-B). Resets at 00:00 UTC (R-D) — a calendar boundary
 * that can be STATED in copy, unlike the rolling monthly window which starts at each caller's
 * own first call and therefore resets on a date nobody can be told in advance.
 */
export const FREE_DAILY_CALLS = 100;

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
 * The MONTHLY RATE in USD that a subscription on (`plan`, `interval`) contributes to MRR, or
 * null when that pair has no price. UNROUNDED.
 *
 * THE single derivation of "what is this subscription worth per month", and the reason
 * OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 exists. `subscriber_profiles.amount_usd` stores the CHARGE:
 * an annual Starter writes $79 on one day and nothing for eleven months, so `SUM(amount_usd)`
 * is not MRR and never can be. Worse, a $79 annual prepayment and a hypothetical $79 monthly
 * charge are the same number — **a stored amount without a period is not a rate**. The rate is
 * therefore derived HERE from the two architect-set prices and materialised onto the row beside
 * the charge; it is never arithmetic on the charge, which cannot tell those two cases apart.
 *
 * Rounding is the caller's presentation choice. `planAnnualMonthlyEquivalent` formats from this
 * exact unrounded value, so the buyer-facing "$6.58/mo effective" label on the pricing page and
 * the MRR arithmetic can never disagree about what an annual Starter is worth.
 *
 * 🛑 **null is a REFUSAL, not a zero.** Enterprise is sold monthly-only (`priceUsdAnnual`
 * absent), so an Enterprise annual rate does not exist and must not be fabricated by dividing a
 * price nobody set. Callers EXCLUDE a null from MRR rather than adding 0 — a plan we cannot
 * price is not a plan worth nothing.
 *
 * _(Architect ruling 2026-08-05: this replaces the spec's AC 2.4 "no `/12` literal", which
 * banned the mechanism where it meant to require the guard. The property is (a) derive from
 * `PLANS`, never from the charge; (b) refuse rather than fabricate; (c) the divisor appears
 * ONCE. A `MONTHS_PER_YEAR` constant was explicitly rejected: naming the divisor at one
 * of two adjacent call sites and not the other manufactures the drift class this arc retired.)_
 *
 * 🔄 **THAT REJECTION IS DELIBERATELY OVERTURNED** by PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1
 * (CH2), and the reasoning is worth keeping because both rulings were right at the time. With
 * exactly TWO intervals and ONE divisor, naming `12` bought nothing and split the derivation
 * across a constant and its only use. With THREE (`month`, `6month`, `year` mid-migration) the
 * divisor becomes a per-interval FACT, and a fact that varies by case belongs in a table the
 * type system can force you to complete — `INTERVAL_MONTHS` below. The property the original
 * ruling protected (the divisor appears ONCE) is strengthened, not weakened: it now appears
 * once PER INTERVAL, in one exhaustive `Record`, and `tsc` fails the build if a new interval
 * forgets its months.
 */
export function planMonthlyRateUsd(id: PaidPlanId, interval: BillingInterval): number | null {
  return planPrepayMonthlyRateUsd(id, INTERVAL_MONTHS[interval]);
}

// ── Interval-neutral prepay derivation (PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 CH2) ──
//
// Everything below is parameterised by a MONTH COUNT rather than a `BillingInterval` token, so
// the 6-month prepay that CH6 introduces needs no second copy of this arithmetic. `BillingInterval`
// is the BILLING vocabulary (what Stripe sold); months are the UNIT the maths needs. Keeping them
// separate is what lets CH6 widen the union and drop `'year'` without touching a single formula.

/**
 * Months billed per interval. EXHAUSTIVE by construction: adding a member to `BillingInterval`
 * without adding its months here is a `tsc` error, which is the whole reason this is a `Record`
 * and not a lookup with a default.
 */
export const INTERVAL_MONTHS: Readonly<Record<BillingInterval, number>> = { month: 1, '6month': 6 };

/** Months in the six-month prepay term (R-C). Now also `INTERVAL_MONTHS['6month']`. */
export const PREPAY_6MONTH_MONTHS = 6;

/**
 * Months in the retired ANNUAL term. `'year'` left `BillingInterval` in CH6 (R-C: 6-month
 * prepay REPLACES annual), but the annual copy helpers below still render live on the pricing
 * page until CH7 takes them down, and `StoredBillingInterval` must keep reading `'year'` rows
 * forever. This names the divisor for those two survivors without re-admitting the token to the
 * billing vocabulary. CH7 removes it with the last annual helper.
 */
export const PREPAY_ANNUAL_MONTHS = 12;

/**
 * Total USD charged up-front for a `months`-long prepay term, or null when the plan is not sold
 * on that term. `months === 1` is the ordinary monthly subscription.
 *
 * 🛑 null is a REFUSAL, not a zero (see `planMonthlyRateUsd`) — a term nobody priced must never
 * be fabricated by scaling a term that was priced.
 */
export function planPrepayTotalUsd(id: PaidPlanId, months: number): number | null {
  const spec = PLANS[id];
  if (months === 1) return spec.priceUsdMonthly;
  if (months === PREPAY_6MONTH_MONTHS) return spec.priceUsd6Month ?? null;
  if (months === PREPAY_ANNUAL_MONTHS) return spec.priceUsdAnnual ?? null; // retired by CH7 with the copy
  return null;
}

/** UNROUNDED monthly rate a `months`-term prepay contributes to MRR, or null. */
export function planPrepayMonthlyRateUsd(id: PaidPlanId, months: number): number | null {
  const total = planPrepayTotalUsd(id, months);
  if (total === null || months <= 0) return null;
  return total / months;
}

/** Prepay total as it renders in copy (`$39.90`, `$129`), or null. */
export function planPrepayPriceLabel(id: PaidPlanId, months: number): string | null {
  const total = planPrepayTotalUsd(id, months);
  if (total === null) return null;
  return `$${Number.isInteger(total) ? total : total.toFixed(2)}`;
}

/** What a prepay term works out to per month (`$6.65`, `$21.50`), or null. */
export function planPrepayMonthlyEquivalent(id: PaidPlanId, months: number): string | null {
  const rate = planPrepayMonthlyRateUsd(id, months);
  if (rate === null) return null;
  return `$${rate.toFixed(2)}`;
}

/** Whole-percent saving of a prepay term vs paying monthly for the same span, or null. */
export function planPrepaySavingsPct(id: PaidPlanId, months: number): number | null {
  const total = planPrepayTotalUsd(id, months);
  const monthly = PLANS[id].priceUsdMonthly;
  if (total === null || monthly <= 0 || months <= 0) return null;
  return Math.round((1 - total / (monthly * months)) * 100);
}

/** True when the plan is sold on the six-month term. */
export function planHasSixMonth(id: PaidPlanId): boolean {
  return typeof PLANS[id].priceUsd6Month === 'number';
}

/**
 * What the annual price works out to per month (`$6.58`, `$24.92`), or null.
 *
 * This is the number a buyer actually compares against the monthly price, so it is always
 * shown alongside the annual total rather than instead of it — quoting only "$6.58/mo" for a
 * plan that bills $79 once a year would be the misleading framing the public-copy LAW forbids.
 *
 * FORMATS `planMonthlyRateUsd(id, 'year')` rather than re-dividing: one derivation, two
 * consumers (this label and the MRR materialisation). The refactor was gated on proving the
 * rendered bytes do not move — this string is live on the pricing page — which holds because
 * the primitive returns the quotient UNROUNDED and the `.toFixed(2)` here is unchanged. Pinned
 * both ways by `tests/plans.test.ts` ("byte-identical to the pre-refactor expression").
 */
export function planAnnualMonthlyEquivalent(id: PaidPlanId): string | null {
  return planPrepayMonthlyEquivalent(id, PREPAY_ANNUAL_MONTHS);
}

/**
 * Whole-percent saving of annual prepay vs paying monthly for a year, or null.
 *
 * Rounded to the nearest percent for copy. Starter → 34 (79 vs 119.88), Pro → 49 (299 vs 588).
 */
export function planAnnualSavingsPct(id: PaidPlanId): number | null {
  return planPrepaySavingsPct(id, PREPAY_ANNUAL_MONTHS);
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
 * PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-A) makes this comparison HONEST for the first
 * time. Previously the rail settled only on an actionable verdict while the subscription
 * metered only actionable verdicts too — but the caller RECEIVED (and the venues served)
 * every HOLD in between, so neither side of the ratio counted the same thing the customer
 * was actually consuming. Now both rails charge per verdict, so `monthly ÷ per-call` compares
 * like with like: N calls costs `N × perCall` on the rail and a flat `priceUsdMonthly` on the
 * plan, for the same N.
 *
 * ⚠️ At today's numbers the break-even (500) EXACTLY equals `FREE_MONTHLY_CALLS`. That is a
 * coincidence of $9.99 / $0.02 / 500, not a designed relationship — and it makes the
 * pay-per-call recommendation unreachable from the monthly wall, where `used === limit === 500`
 * always projects at or above break-even. Moving any one of those three numbers separates them
 * again; see `recommendPath` in quota-notice.ts, whose boundary is pinned by test.
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

// ── Tier-claim evidence registry (CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1) ──
//
// THE GENERATOR FIX, mandated by CLAUDE.md after the THIRD instance of one bug class in a day:
// "public copy asserts a deliverable that does not exist".
//   1. "HOLD calls always free"  — false; equity HOLDs are charged (removed earlier today)
//   2. "Email support" / "Priority support" — neither exists
//   3. "$0.015/call overage"     — no overage billing exists; the wall REFUSES, it does not bill
//
// Deleting three bullets fixes today. What retires the class is requiring every public tier
// claim to name the thing that makes it true, and failing the build when one cannot.
//
// A claim is bound to EVIDENCE of one of three kinds:
//   `sot`         — projected from a source-of-truth symbol, so it cannot go stale by hand
//   `code`        — implemented by a named code path
//   `contractual` — a genuine human commitment, which needs a named approver and a note.
//                   Deliberately awkward: if a bullet needs this kind, someone has to own it.
//
// `match` is checked against the RENDERED bullet text on BOTH pricing surfaces — the
// function-rendered cards AND the baked landing artboards — because this wave exists precisely
// because a single-surface assumption missed 28 of 29 occurrences.
export type ClaimEvidence =
  | { readonly kind: 'sot'; readonly ref: string }
  | { readonly kind: 'code'; readonly ref: string }
  | { readonly kind: 'contractual'; readonly approvedBy: string; readonly note: string };

export interface TierClaim {
  readonly id: string;
  /** Matched against rendered bullet text. */
  readonly match: RegExp;
  readonly evidence: ClaimEvidence;
}

export const TIER_CLAIMS: readonly TierClaim[] = [
  {
    id: 'monthly-call-allowance',
    match: /^[\d,]+ (?:free )?calls\/month$/,
    evidence: { kind: 'sot', ref: 'src/lib/plans.ts#PLANS' },
  },
  {
    id: 'venue-count',
    match: /^\d+ exchanges$/,
    evidence: { kind: 'sot', ref: 'src/lib/capabilities.ts#EXCHANGE_COUNT' },
  },
  {
    id: 'asset-coverage',
    match: /^All (?:crypto \+ TradFi assets|assets \(crypto \+ TradFi\))$/,
    // NOT a count claim — a COVERAGE claim, so the evidence is the module that actually
    // routes both classes. `capabilities.ts#ASSET_COUNT` was the intuitive reference and does
    // NOT EXIST; the gate below caught that before this registry was even finished.
    evidence: { kind: 'code', ref: 'src/lib/asset-class-detection.ts#getTradFiClass' },
  },
  {
    id: 'timeframe-coverage',
    match: /^All (?:\d+ )?timeframes(?: \(1m\s*(?:to|[–—-])\s*1d\))?$/,
    evidence: { kind: 'sot', ref: 'src/lib/capabilities.ts#TIMEFRAME_COUNT' },
  },
  {
    id: 'funding-arb-top5',
    match: /^Top 5 funding arbs$/,
    evidence: { kind: 'code', ref: 'src/tools/scan-funding-arb.ts' },
  },
  {
    id: 'x402-per-call-price',
    match: /^(?:scan_funding_arb|get_trade_call|get_market_regime) — \$0\.0[12]\/call$/,
    evidence: { kind: 'code', ref: 'src/lib/feature-registry.ts' },
  },
  {
    id: 'x402-free-then-paid',
    match: /^100 free calls\/mo first, then pay-per-call$/,
    evidence: { kind: 'sot', ref: 'src/lib/plans.ts#FREE_MONTHLY_CALLS' },
  },
];

/** The claim covering a rendered bullet, or null when nothing vouches for it. */
export function claimFor(bullet: string): TierClaim | null {
  return TIER_CLAIMS.find((c) => c.match.test(bullet.trim())) ?? null;
}
