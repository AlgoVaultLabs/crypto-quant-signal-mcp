/**
 * OPS-VALIDATE-KEY-INDETERMINATE-W1 CH2 — the ONE projection from entitlement state to HTTP.
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────────────────────────
 * Three routes each carried their own copy of
 *
 *     if (!result.valid || !result.tier) return res.status(404).json({ valid: false });
 *
 * which collapsed FOUR states into one bare 404 — including `indeterminate:true`, a flag
 * `validateApiKey` had been setting correctly since OPS-ZERO-VS-UNKNOWN-W1 and which every one of
 * these routes then threw away. `link_validator.py`'s module docstring has documented this exact
 * ambiguity since 2026-08-21 and named its retirement `OPS-VALIDATE-KEY-INDETERMINATE-W{NEXT}`.
 * This is that wave.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────────────────────────
 *   ENTITLED       200  { valid: true,  entitlement_state: 'ENTITLED', tier, customer_id }
 *   DUNNING        200  { valid: false, entitlement_state: 'DUNNING', dunning: {...}, customer_id }
 *   NOT_ENTITLED   404  { valid: false, entitlement_state: 'NOT_ENTITLED', reason }
 *   INDETERMINATE  503  { valid: false, entitlement_state: 'INDETERMINATE', retryable: true }
 *
 * 🛑 ENTITLED AND DUNNING SHARE 200 ON PURPOSE, AND THE STATUS IS THEREFORE NOT THE DISCRIMINANT.
 * `entitlement_state` is, and it is present on EVERY response. A caller that branches on the
 * status code alone would still be collapsing two states — which is why
 * `scripts/check-entitlement-state-collapse.mjs` asserts the four `(status, entitlement_state)`
 * PAIRS are distinct rather than asserting four distinct statuses.
 *
 * ── WHY DUNNING IS 200 ────────────────────────────────────────────────────────────────────────
 * A 404 is terminal to `entitlement_drain.py`: it stamps `key_invalid_404` and the debit is never
 * charged, never retried. That is how a `past_due` customer came to receive 2,025 alerts across
 * nine days for free. A 200 lets the debit CHARGE, so a customer Stripe is still collecting from
 * is METERED rather than served for nothing.
 *
 * 🛑 `valid` STAYS FALSE ON DUNNING. It is the field four incumbent consumers read as "granted",
 * and the estate RATIFIED active-only API entitlement in `resolveCustomerByApiKey`'s docstring.
 * Flipping it here would silently hand `/mcp` access to every dunning customer as a side effect
 * of a metering fix. The bot reads `entitlement_state` instead, which is a field it can act on
 * with its own predicate — the architecture `resolveCustomerByApiKey` established.
 *
 * ── BACKWARD COMPATIBILITY, MEASURED AGAINST THE LIVE BOT ─────────────────────────────────────
 * `link_validator.validate_api_key` (algovault-bot @ a770f56) already maps: 200-with-`valid:false`
 * → INVALID, 404 → INVALID, any 5xx → INDETERMINATE. So this contract is safe to deploy BEFORE
 * any bot change and strictly improves behaviour on the old code:
 *   · a Stripe outage stops presenting as a determined-invalid (503 → INDETERMINATE), and
 *   · a DUNNING debit stops being stamped terminal and starts CHARGING (200 → outcome path),
 * while DUNNING on validate-key reads exactly as it does today (INVALID). Nothing regresses if
 * CH3 never ships; CH3 makes it correct rather than merely better.
 */
import type { EntitlementState, NotEntitledReason, StripeValidation } from './stripe.js';

export type PaidTier = 'starter' | 'pro' | 'enterprise';

/** THE status map. One entry per state; adding a state without an entry is a `tsc` error. */
export const ENTITLEMENT_STATE_HTTP_STATUS: Readonly<Record<EntitlementState, number>> = Object.freeze({
  ENTITLED: 200,
  DUNNING: 200,
  NOT_ENTITLED: 404,
  INDETERMINATE: 503,
});

export interface EntitlementHttpProjection {
  readonly status: number;
  readonly state: EntitlementState;
  /** The identity half of the response body. Route-specific fields are merged on top. */
  readonly body: Record<string, unknown>;
  /**
   * The tier to METER this call against, or null when the caller must not be metered.
   *
   * Non-null for ENTITLED and DUNNING — and DUNNING is the entire revenue fix, so this is
   * deliberately NOT derived from `valid`. Deriving it from `valid` is what produced the leak.
   */
  readonly chargeableTier: PaidTier | null;
}

/**
 * `StripeValidation` → the wire. The single derivation: every route projects from THIS, so a
 * fourth route added tomorrow cannot reintroduce its own `if (!valid) 404`.
 *
 * A validation carrying no `entitlementState` at all can only come from a stub or a build that
 * predates CH1. It is INDETERMINATE — never silently treated as a determined negative.
 */
export function projectEntitlementHttp(result: StripeValidation): EntitlementHttpProjection {
  const state: EntitlementState = result.entitlementState ?? 'INDETERMINATE';
  const status = ENTITLEMENT_STATE_HTTP_STATUS[state] ?? 503;
  const body: Record<string, unknown> = {
    valid: state === 'ENTITLED',
    entitlement_state: state,
  };
  if (result.customerId) body.customer_id = result.customerId;

  switch (state) {
    case 'ENTITLED':
      body.tier = result.tier;
      return { status, state, body, chargeableTier: (result.tier ?? null) as PaidTier | null };
    case 'DUNNING':
      // The plan they hold and are being dunned on. `since` may be null — best-effort, never
      // fabricated — and no consumer is permitted to gate on it.
      body.dunning = result.dunning
        ? { tier: result.dunning.tier, since: result.dunning.since, subscription_id: result.dunning.subscriptionId }
        : null;
      body.subscription_status = result.subscriptionStatus ?? 'past_due';
      return { status, state, body, chargeableTier: (result.dunning?.tier ?? null) as PaidTier | null };
    case 'NOT_ENTITLED':
      body.reason = (result.reason ?? 'no_subscription') satisfies NotEntitledReason;
      if (result.subscriptionStatus) body.subscription_status = result.subscriptionStatus;
      return { status, state, body, chargeableTier: null };
    default:
      // 🛑 RETRYABLE. This is the flag whose absence made a Stripe outage look like a cancelled
      // subscription to every downstream consumer for months.
      body.retryable = true;
      return { status, state, body, chargeableTier: null };
  }
}
