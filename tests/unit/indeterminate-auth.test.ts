/**
 * OPS-ZERO-VS-UNKNOWN-W1 · Ch1 (auth path).
 *
 * `stripe.validateApiKey` returned `{valid:false}` for BOTH "Stripe says this key is invalid" and
 * "we could not reach Stripe". `license.ts` turned `valid:false` into `{tier:'free', key:null}`,
 * so a transient Stripe fault SILENTLY DEMOTED A PAYING CUSTOMER: a Pro caller was metered into
 * `free:<ipHash>`, burned a 100-call ceiling they never bought, and was then refused — having
 * paid. Customer harm, not a metrics defect, which is why the architect ranked it above the
 * claim-path work.
 *
 * These assert the two halves that matter: the distinction EXISTS, and the caller no longer
 * throws away the key identity (which is what caused the wrong metering).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { recordIndeterminate, getIndeterminateSnapshot, _resetIndeterminateCounters } from '../../src/lib/indeterminate-counter.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
/** Comments are stripped before matching: twice now a text op has mistaken a comment for code. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('the indeterminate counter is observable', () => {
  beforeEach(() => _resetIndeterminateCounters());

  it('counts per site and stamps recency', () => {
    recordIndeterminate('x402_claim');
    recordIndeterminate('x402_claim');
    recordIndeterminate('stripe_validate_api_key');
    const s = getIndeterminateSnapshot();
    expect(s.counts.x402_claim).toBe(2);
    expect(s.counts.stripe_validate_api_key).toBe(1);
    expect(s.lastAt.x402_claim).toBeGreaterThan(0);
  });

  it('never throws — an instrument must not break the path it instruments', () => {
    // @ts-expect-error deliberately hostile input from a catch block
    expect(() => recordIndeterminate(undefined)).not.toThrow();
  });

  it('exposes `since`, so a reader can compute a WINDOW rather than trust a lifetime total', () => {
    // A lifetime average already hid a 3-day burst on the quota canary and never alerted.
    expect(getIndeterminateSnapshot().since).toBeGreaterThan(0);
  });
});

describe('stripe.validateApiKey distinguishes "cannot determine" from "invalid"', () => {
  const src = code(read('../../src/lib/stripe.ts'));

  // OPS-VALIDATE-KEY-INDETERMINATE-W1 CH1 RE-ANCHORED THESE THREE, AND STRENGTHENED THEM.
  //
  // They were source-text greps for the LITERAL returns (`return { valid: false, indeterminate:
  // true }`). CH1 routes every return through the one `project({ state })` projection so the
  // legacy booleans cannot drift from the state they summarise — which is the same guarantee
  // these tests exist for, expressed once instead of five times. Grepping for the old literals
  // would now fail against a STRONGER implementation, so the two that CAN be driven behaviourally
  // now are, and the one that cannot (the catch block needs an unreachable Stripe) is re-anchored
  // to the mechanism that replaced it.

  it('an unreachable Stripe returns indeterminate, not a bare invalid', () => {
    const c = src.slice(src.indexOf('catch (err)'));
    expect(c).toMatch(/return project\(\{ state: 'INDETERMINATE' \}\)/);
  });

  it('an unconfigured Stripe is also indeterminate — not-configured is not "invalid"', () => {
    expect(src).toMatch(/if \(!stripe\) return project\(\{ state: 'INDETERMINATE' \}\)/);
  });

  it('a genuinely rejected key still returns a determined invalid (the distinction cuts BOTH ways)', async () => {
    // If everything became indeterminate the signal would be worthless, so this is asserted
    // BEHAVIOURALLY rather than by grepping for a literal.
    //
    // 🛑 Driven through `classifyCustomerSubscriptions`, NOT `validateApiKey`, and the reason is
    // an ordering this wave deliberately did NOT touch: `validateApiKey` answers INDETERMINATE on
    // `!stripe` BEFORE it ever reaches the shape check, so in a test environment with no Stripe
    // configured EVERY key — malformed included — is indeterminate. That ordering is load-bearing:
    // `license.ts`'s indeterminate branch re-classifies shape itself and returns
    // `{tier:'free', key, outcome:'MALFORMED'}` with the KEY PRESERVED, which is what keeps an
    // unexpanded-`${env:AV_API_KEY}` caller out of the anonymous `free:<ipHash>` bucket
    // (pinned by tests/credential-outcome.test.ts). Reordering to satisfy this test would have
    // moved a live metering bucket to make an assertion prettier.
    const { classifyCustomerSubscriptions } = await import('../../src/lib/stripe.js');
    const r = classifyCustomerSubscriptions('cus_gone', []);
    expect(r.valid).toBe(false);
    expect(r.indeterminate, 'a customer with no subscription is DETERMINED, not unknown').toBeUndefined();
    expect(r.entitlementState).toBe('NOT_ENTITLED');
    expect(r.reason).toBe('no_subscription');
  });

  it('PROJECTS the legacy booleans from the state — they cannot disagree', async () => {
    // The single-derivation pin. `valid` is ENTITLED-only and `indeterminate` is
    // INDETERMINATE-only BY CONSTRUCTION, so a future state that needs to grant changes one line.
    const { classifyCustomerSubscriptions } = await import('../../src/lib/stripe.js');
    const price = process.env.STARTER_PRICE_ID ?? 'price_unknown_to_this_build';
    const sub = (status: string) => ({ id: 'sub_x', status, items: { data: [{ price: { id: price } }] } });

    for (const [status, expected] of [['canceled', 'NOT_ENTITLED'], ['unpaid', 'NOT_ENTITLED'],
                                      ['incomplete', 'NOT_ENTITLED'], ['past_due', null]] as const) {
      const r = classifyCustomerSubscriptions('cus_x', [sub(status)]);
      // `past_due` resolves to DUNNING only when the Price is recognised; in a build with no
      // price env vars it degrades to NOT_ENTITLED, which is the safe direction. Either way it is
      // NEVER `valid`, and that is what this loop pins.
      if (expected) expect(r.entitlementState).toBe(expected);
      expect(r.valid).toBe(false);
      expect(r.indeterminate).toBeUndefined();
    }

    // An unlisted status neither grants nor revokes — it is an outage, not a verdict.
    const unknown = classifyCustomerSubscriptions('cus_x', [sub('some_future_stripe_status')]);
    expect(unknown.entitlementState).toBe('INDETERMINATE');
    expect(unknown.valid).toBe(false);
    expect(unknown.indeterminate).toBe(true);
  });

  it('the indeterminate branch is COUNTED, not merely logged', () => {
    // The 25-hour outage DID log to console.error. A line nothing counts is not observable.
    expect(src).toMatch(/recordIndeterminate\('stripe_validate_api_key'\)/);
  });
});

describe('license resolution no longer silently demotes a paying caller', () => {
  const src = code(read('../../src/lib/license.ts'));

  it('handles indeterminate BEFORE falling through to the free default-deny', () => {
    const iIndet = src.indexOf('stripeResult.indeterminate');
    // AUTH-THREE-STATE-W1 CH1 re-anchored this literal ONLY. The default-deny now carries an
    // explicit `outcome:` member, so the trailing `};` moved; the ORDERING invariant this test
    // exists for is unchanged and still asserted below.
    const iFree = src.lastIndexOf("return { tier: 'free', key: null");
    expect(iIndet).toBeGreaterThan(-1);
    expect(iIndet, 'the indeterminate branch must precede the default-deny or it is unreachable').toBeLessThan(iFree);
  });

  /** The `if (stripeResult.indeterminate) { … }` body ONLY — the default-deny that follows it is
   *  a different branch and must not bleed into these assertions. */
  const indeterminateBranch = (() => {
    const i = src.indexOf('stripeResult.indeterminate');
    const open = src.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
    }
    return '';
  })();

  it('PRESERVES the key on indeterminate — this is what stops the wrong metering', () => {
    // AUTH-THREE-STATE-W1 CH1 relaxed the CLOSING delimiter only (`}` → `[,}]`): the return now
    // also carries `outcome: 'INDETERMINATE', retryable: true`. Everything this test guards is
    // intact — `key` is still preserved, and the `not.toMatch(/key: null/)` below still holds
    // across the whole branch, including the MALFORMED early-return this wave added inside it.
    expect(indeterminateBranch).toMatch(/return \{ tier: 'free', key, indeterminate: true[,}]/);
    expect(indeterminateBranch, 'dropping the key is what metered a paying caller into free:<ipHash>')
      .not.toMatch(/key: null/);
  });

  it('runs AFTER the ALLOW_DEV_KEY_PREFIX escape hatch, which exists for the unconfigured-Stripe case', () => {
    // Placing it before that check bypassed the dev-only prefix resolution and silently metered a
    // starter key at the free ceiling — caught by tests/webhook-api.test.ts on the first run.
    expect(src.indexOf('ALLOW_DEV_KEY_PREFIX ===')).toBeLessThan(src.indexOf('stripeResult.indeterminate'));
  });

  it('does NOT escalate the tier — we never grant what we cannot prove', () => {
    expect(indeterminateBranch).not.toMatch(/tier: '(pro|starter|enterprise)'/);
  });

  it('counts the event', () => {
    expect(src).toMatch(/recordIndeterminate\('stripe_validate_api_key'/);
  });
});
