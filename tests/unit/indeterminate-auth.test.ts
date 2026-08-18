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

  it('an unreachable Stripe returns indeterminate, not a bare invalid', () => {
    const c = src.slice(src.indexOf('catch (err)'));
    expect(c).toMatch(/return \{ valid: false, indeterminate: true \}/);
  });

  it('an unconfigured Stripe is also indeterminate — not-configured is not "invalid"', () => {
    expect(src).toMatch(/if \(!stripe\) return \{ valid: false, indeterminate: true \}/);
  });

  it('a genuinely rejected key still returns a plain invalid (the distinction must cut BOTH ways)', () => {
    // If everything became indeterminate the signal would be worthless.
    expect(src).toMatch(/return \{ valid: false \}/);
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
