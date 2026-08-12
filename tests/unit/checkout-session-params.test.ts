/**
 * PAY-UNIONPAY-ATTRIBUTION-W1 (R8 / AC6-AC7) — Checkout Session create-param guard.
 *
 * 🛑 THE HIGHEST-RISK EDIT IN THE WAVE IS ONE NOBODY WOULD FLAG IN REVIEW.
 *
 * Adding `payment_method_types: ['card']` to `checkout.sessions.create` looks like a
 * clarification. It is not. Setting that key explicitly **disables the Dashboard Payment
 * Method Configuration** and freezes the method list at whatever is typed — silently dropping
 * `link` (7 of the account's 10 lifetime charges) and every method added in future. And it
 * would be invisible: the session still creates, checkout still works, and the loss shows up
 * only as methods quietly missing from the payment page.
 *
 * The live method list resolves from `pmc_1TKIywKGleoEgU2HL7OGuMeS` (ON: apple_pay, card,
 * link). That indirection is the feature, and this test is what keeps it.
 *
 * The probe that opened this wave found **no existing test asserted on Checkout Session create
 * params at all** — so this closes a genuine hole rather than adding a redundant belt.
 *
 * TWO INDEPENDENT LAYERS, because either alone is escapable:
 *   1. BEHAVIOURAL — mock the Stripe SDK, call the real `createCheckoutSession`, inspect the
 *      params object actually handed to Stripe. Catches the key arriving via a spread, a
 *      conditional, or a helper — forms a source grep cannot see.
 *   2. SOURCE — assert the literal is absent from `src/lib/stripe.ts`. Catches a params object
 *      built somewhere the behavioural test does not reach.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Captured create-params. `vi.hoisted` so the mock factory (hoisted above imports) can close
// over it, and so the env is set before `stripe.ts` builds its module-level client.
const captured = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_guard_fake';
  process.env.STRIPE_PRO_PRICE_ID = 'price_pro_guard';
  return { calls: [] as Record<string, unknown>[] };
});

vi.mock('stripe', () => {
  class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          captured.calls.push(params);
          return { id: 'cs_test_guard', url: 'https://checkout.stripe.test/c/guard' };
        },
      },
    };
    constructor(_key: string) { /* no network */ }
  }
  return { default: FakeStripe };
});

import { createCheckoutSession } from '../../src/lib/stripe.js';

beforeEach(() => { captured.calls.length = 0; });

describe('🛑 payment_method_types must never appear in Checkout Session create params', () => {
  it('is absent from the params actually sent to Stripe', async () => {
    const url = await createCheckoutSession('pro', 'https://api.algovault.com');
    expect(url).toBe('https://checkout.stripe.test/c/guard');
    expect(captured.calls).toHaveLength(1);

    const params = captured.calls[0];
    // Own-key check: the method list must come from the Dashboard PMC, not from code.
    expect(Object.keys(params)).not.toContain('payment_method_types');
    expect(params.payment_method_types).toBeUndefined();
    // Deep check — catches the key nested anywhere (e.g. under subscription_data).
    expect(JSON.stringify(params)).not.toContain('payment_method_types');
  });

  it('still sends the params it is supposed to (the guard is not vacuous)', async () => {
    // A test that only asserts an ABSENCE passes just as happily when the function does
    // nothing at all. These positives prove the subject really ran.
    await createCheckoutSession('pro', 'https://api.algovault.com');
    const params = captured.calls[0];
    expect(params.mode).toBe('subscription');
    expect(params.line_items).toEqual([{ price: 'price_pro_guard', quantity: 1 }]);
    expect(params.metadata).toMatchObject({ tier: 'pro', billing_interval: 'month' });
  });

  it('stays absent when optional attribution params are supplied', async () => {
    await createCheckoutSession('pro', 'https://api.algovault.com', {
      utmSource: 'devto', utmCampaign: 'launch', refCode: 'abc123', clientReferenceId: 'sess_1',
    });
    expect(JSON.stringify(captured.calls[0])).not.toContain('payment_method_types');
  });
});

describe('source-level guard (AC6)', () => {
  it('the literal does not appear in src/lib/stripe.ts', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/stripe.ts'), 'utf8');
    // Strip the comment lines that DOCUMENT the prohibition — a ban-grep that trips on its
    // own explanatory prose demands the deletion of the most valuable line in the file.
    // (Same reasoning as `check-canaries-wired.mjs`: a mention in a comment is not a use.)
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toContain('payment_method_types');
  });
});
