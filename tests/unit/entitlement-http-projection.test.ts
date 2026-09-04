/**
 * OPS-VALIDATE-KEY-INDETERMINATE-W1 CH2 — the state→HTTP projection, tested at the seam.
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT REDUNDANT WITH tests/entitlement-api.test.ts.
 *
 * RED-verification of that file found a hole: flipping `ENTITLEMENT_STATE_HTTP_STATUS.DUNNING`
 * from 200 to 404 broke NOTHING. The consume route reads `p.chargeableTier` and then answers with
 * `res.json(...)` — an unconditional 200 — so the DUNNING entry in the status map is simply not
 * on that path. It IS on `/api/bot/validate-key`'s path, and `index.ts` boots the server at
 * import, so that route cannot be mounted from a test at all.
 *
 * A map entry that no test reads is a map entry that can be edited to anything. Testing the
 * projection directly closes it, and does so at the level the contract actually lives: BOTH
 * routes project from this one function, so this is the single place the four states are decided.
 */
import { describe, it, expect } from 'vitest';
import {
  projectEntitlementHttp,
  ENTITLEMENT_STATE_HTTP_STATUS,
} from '../../src/lib/entitlement-http.js';
import type { StripeValidation } from '../../src/lib/stripe.js';

const ENTITLED: StripeValidation = {
  valid: true, entitlementState: 'ENTITLED', tier: 'pro', customerId: 'cus_a', subscriptionStatus: 'active',
};
const DUNNING: StripeValidation = {
  valid: false, entitlementState: 'DUNNING', customerId: 'cus_b', subscriptionStatus: 'past_due',
  dunning: { tier: 'starter', since: '2026-08-26T12:37:05.000Z', subscriptionId: 'sub_b' },
};
const NOT_ENTITLED: StripeValidation = {
  valid: false, entitlementState: 'NOT_ENTITLED', reason: 'subscription_ended', customerId: 'cus_c',
};
const INDETERMINATE: StripeValidation = { valid: false, entitlementState: 'INDETERMINATE', indeterminate: true };

describe('the four states are distinguishable, and each maps to exactly one status', () => {
  it('DUNNING is 200 — a 404 is TERMINAL to the drainer and forgives the debit', () => {
    // The single most consequential number in this wave. `entitlement_drain.py` stamps
    // `key_invalid_404` on a 404 and never charges or retries that row again; measured at 1,987
    // uncharged debits across nine days for one past_due customer.
    expect(ENTITLEMENT_STATE_HTTP_STATUS.DUNNING).toBe(200);
    expect(projectEntitlementHttp(DUNNING).status).toBe(200);
  });

  it('INDETERMINATE is 5xx — an outage must never read as a determined negative', () => {
    // `link_validator.validate_api_key` maps any 5xx to INDETERMINATE and 404 to INVALID. This
    // one number is what stops a Stripe outage from advancing a downgrade streak on a paying
    // customer, and it is why this contract is safe to deploy before any bot change.
    expect(ENTITLEMENT_STATE_HTTP_STATUS.INDETERMINATE).toBeGreaterThanOrEqual(500);
    const p = projectEntitlementHttp(INDETERMINATE);
    expect(p.status).toBe(503);
    expect(p.body.retryable).toBe(true);
  });

  it('NOT_ENTITLED is 404 and SAYS WHY', () => {
    const p = projectEntitlementHttp(NOT_ENTITLED);
    expect(p.status).toBe(404);
    expect(p.body.reason).toBe('subscription_ended');
  });

  it('every (status, entitlement_state) pair is unique — status alone is NOT the discriminant', () => {
    const pairs = [ENTITLED, DUNNING, NOT_ENTITLED, INDETERMINATE].map((v) => {
      const p = projectEntitlementHttp(v);
      expect(p.body.entitlement_state, 'every response must carry its state').toBeDefined();
      return `${p.status}:${String(p.body.entitlement_state)}`;
    });
    expect(new Set(pairs).size).toBe(4);
    // ENTITLED and DUNNING deliberately share 200, so this is the assertion that would catch a
    // consumer-visible collapse rather than merely a status change.
    expect(new Set(pairs.map((p) => p.split(':')[0])).size).toBe(3);
  });
});

describe('what may be METERED — the field that decides is not `valid`', () => {
  it('ENTITLED and DUNNING are both chargeable', () => {
    expect(projectEntitlementHttp(ENTITLED).chargeableTier).toBe('pro');
    // THE REVENUE FIX. A customer can be un-ENTITLED for API access and still owe us for every
    // alert delivered while Stripe retries their card.
    expect(projectEntitlementHttp(DUNNING).chargeableTier).toBe('starter');
  });

  it('NOT_ENTITLED and INDETERMINATE are never chargeable', () => {
    expect(projectEntitlementHttp(NOT_ENTITLED).chargeableTier).toBeNull();
    // Never charge on a measurement we could not take — the row stays pending and is retried.
    expect(projectEntitlementHttp(INDETERMINATE).chargeableTier).toBeNull();
  });

  it('a DUNNING result with no recognisable plan is NOT chargeable', () => {
    // We cannot meter against a tier we could not resolve. Refuse rather than pick a default —
    // guessing `starter` would bill the wrong plan.
    const p = projectEntitlementHttp({ valid: false, entitlementState: 'DUNNING', customerId: 'cus_x' });
    expect(p.chargeableTier).toBeNull();
    expect(p.status).toBe(200);
  });
});

describe('`valid` keeps its incumbent meaning', () => {
  it('is true ONLY for ENTITLED', () => {
    // Four production consumers read this field as "granted", and the estate ratified
    // active-only API entitlement in resolveCustomerByApiKey. A metering fix must not flip it.
    expect(projectEntitlementHttp(ENTITLED).body.valid).toBe(true);
    for (const v of [DUNNING, NOT_ENTITLED, INDETERMINATE]) {
      expect(projectEntitlementHttp(v).body.valid).toBe(false);
    }
  });

  it('a validation carrying NO state at all is INDETERMINATE, never a determined negative', () => {
    // Only reachable from a stub or a build predating CH1. Treating an unknown shape as
    // "determined invalid" is the precise class of collapse this wave retires.
    const p = projectEntitlementHttp({ valid: false } as StripeValidation);
    expect(p.state).toBe('INDETERMINATE');
    expect(p.status).toBe(503);
    expect(p.chargeableTier).toBeNull();
  });
});
