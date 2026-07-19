/**
 * OPS-DIGEST-PAID-RAIL-SPLIT-W1 (2026-07-19): the ONE canonical tier→payment-rail
 * derivation. Every surface that reports "paid" traffic (Telegram daily digest,
 * /dashboard/funnel client-activity panel, /analytics) projects from THIS map —
 * per CLAUDE.md's single-derivation rule, so two surfaces can never disagree about
 * what "paid" means.
 *
 * Why this exists: the digest's 💳 bucket was labelled "Paid (x402 / a2mcp)" while
 * being computed as `license_tier NOT IN ('free','internal')` — a TIER test wearing
 * a payment-RAIL label. On 2026-07-19 it read 162 with the x402 rail at ZERO
 * settlements since 2026-06-30; 100% was a Stripe `starter` subscription. The label
 * named two rails that contributed nothing.
 *
 * `Record<LicenseTier, PaymentRail>` is deliberate: adding a tier to the union
 * without classifying it is a COMPILE error, not a silently-dropped bucket
 * (CLAUDE.md — exhaustive registry over parallel hardcoded dispatch).
 *
 * Type-only import of LicenseTier keeps this module a dependency-free leaf, so
 * analytics/scoreboard/digest can all import it without a cycle.
 */
import type { LicenseTier } from '../types.js';

/**
 * `subscription` — recurring Stripe plans (starter/pro/enterprise).
 * `x402`         — pay-per-call settlement. Base/USDC x402 AND OKX a2mcp (X Layer)
 *                  both resolve to `tier:'x402'` in `resolveLicense`, so they are
 *                  NOT separable from request_log alone; report them as one rail
 *                  rather than inventing a split the data cannot support.
 * `none`         — not a paying tier.
 */
export type PaymentRail = 'subscription' | 'x402' | 'none';

export const PAYMENT_RAIL_BY_TIER: Record<LicenseTier, PaymentRail> = {
  free: 'none',
  internal: 'none',
  starter: 'subscription',
  pro: 'subscription',
  enterprise: 'subscription',
  x402: 'x402',
};

export function paymentRailForTier(tier: LicenseTier): PaymentRail {
  return PAYMENT_RAIL_BY_TIER[tier] ?? 'none';
}

/** Tier lists are DERIVED from the map — never a parallel hand-maintained literal. */
function tiersForRail(rail: PaymentRail): LicenseTier[] {
  return (Object.keys(PAYMENT_RAIL_BY_TIER) as LicenseTier[]).filter(
    (t) => PAYMENT_RAIL_BY_TIER[t] === rail,
  );
}

export const SUBSCRIPTION_TIERS: readonly LicenseTier[] = tiersForRail('subscription');
export const X402_TIERS: readonly LicenseTier[] = tiersForRail('x402');
