/**
 * PAY-UNIONPAY-ATTRIBUTION-W1 (R8) — the payment-method resolver.
 *
 * Pins three properties:
 *   1. Every brand resolves, including `unionpay` — the cohort this wave was opened for.
 *   2. Missing data resolves to `null`, never a fabricated default. A guessed brand is a
 *      wrong brand that looks plausible and would poison the decline rate.
 *   3. 🛑 A PAN / last4 / fingerprint / cardholder name CANNOT reach the output — not because
 *      the resolver avoids reading those paths, but because no output field's shape admits
 *      them. That distinction is the whole security claim and is asserted directly.
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePaymentMethodAttribution,
  resolvePaymentFailureDetail,
  EMPTY_ATTRIBUTION,
} from '../../src/lib/payment-method-attribution.js';

const charge = (card: Record<string, unknown> | null, type = 'card') => ({
  id: 'ch_test',
  payment_method_details: card === null ? { type } : { type, card },
});

describe('resolvePaymentMethodAttribution — brands', () => {
  // The full brand vocabulary Stripe returns for `card.brand`.
  for (const brand of ['visa', 'mastercard', 'unionpay', 'amex', 'jcb', 'discover', 'diners', 'eftpos_au']) {
    it(`resolves ${brand}`, () => {
      const r = resolvePaymentMethodAttribution(charge({ brand, country: 'CN', funding: 'debit' }));
      expect(r).toEqual({ methodType: 'card', cardBrand: brand, cardCountry: 'CN', cardFunding: 'debit' });
    });
  }

  it('normalizes case: brand lowercased, ISO-2 country uppercased', () => {
    const r = resolvePaymentMethodAttribution(charge({ brand: 'UnionPay', country: 'cn', funding: 'DEBIT' }));
    expect(r.cardBrand).toBe('unionpay');
    expect(r.cardCountry).toBe('CN');
    expect(r.cardFunding).toBe('debit');
  });

  it('reads a bare PaymentMethod object (the subscription fallback path)', () => {
    const r = resolvePaymentMethodAttribution({ type: 'card', card: { brand: 'visa', country: 'US', funding: 'credit' } });
    expect(r.cardBrand).toBe('visa');
  });

  it('reads a failed PaymentIntent via last_payment_error.payment_method', () => {
    const r = resolvePaymentMethodAttribution({
      id: 'pi_x',
      last_payment_error: { payment_method: { type: 'card', card: { brand: 'unionpay', country: 'CN', funding: 'debit' } } },
    });
    expect(r).toEqual({ methodType: 'card', cardBrand: 'unionpay', cardCountry: 'CN', cardFunding: 'debit' });
  });
});

describe('resolvePaymentMethodAttribution — missing data is NULL, never defaulted', () => {
  it('a link payment has a method type but no card', () => {
    // Measured on the live account: 7 of 10 lifetime charges are `link` and carry no card
    // sub-object. Reporting `link` as a BRAND would be the fabrication this guards against.
    const r = resolvePaymentMethodAttribution(charge(null, 'link'));
    expect(r).toEqual({ methodType: 'link', cardBrand: null, cardCountry: null, cardFunding: null });
  });

  for (const [label, input] of [
    ['null', null], ['undefined', undefined], ['a string', 'ch_123'],
    ['a number', 42], ['an array', []], ['an empty object', {}],
  ] as const) {
    it(`${label} → all-null, no throw`, () => {
      expect(resolvePaymentMethodAttribution(input)).toEqual(EMPTY_ATTRIBUTION);
    });
  }

  it('partial card data fills only what is present', () => {
    const r = resolvePaymentMethodAttribution(charge({ brand: 'visa' }));
    expect(r).toEqual({ methodType: 'card', cardBrand: 'visa', cardCountry: null, cardFunding: null });
  });

  it('an unknown funding value is rejected rather than passed through', () => {
    expect(resolvePaymentMethodAttribution(charge({ brand: 'visa', funding: 'crypto' })).cardFunding).toBeNull();
  });

  it('a 3-letter country code is rejected — the column is ISO-2', () => {
    expect(resolvePaymentMethodAttribution(charge({ brand: 'visa', country: 'CHN' })).cardCountry).toBeNull();
  });
});

describe('🛑 PAN prohibition is STRUCTURAL', () => {
  const PAN = '4242424242424242';

  it('never emits last4, fingerprint, iin or cardholder name even when present', () => {
    const r = resolvePaymentMethodAttribution(
      charge({
        brand: 'visa', country: 'US', funding: 'credit',
        last4: '4242', fingerprint: 'Xt5EWLLDS7FJjR1c', iin: '424242', number: PAN,
      }),
    );
    expect(Object.keys(r).sort()).toEqual(['cardBrand', 'cardCountry', 'cardFunding', 'methodType']);
    const serialized = JSON.stringify(r);
    for (const secret of ['4242', 'Xt5EWLLDS7FJjR1c', '424242', PAN]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('a PAN placed INTO an allow-listed field still cannot survive — no field admits digits', () => {
    // This is the assertion that makes the guarantee structural rather than careful. Even if
    // a Stripe bug, a bad fixture, or a future refactor pointed the reader at the wrong path,
    // the value is digits and no output shape accepts digits.
    const r = resolvePaymentMethodAttribution(
      charge({ brand: PAN, country: PAN, funding: PAN }),
    );
    expect(r.cardBrand).toBeNull();
    expect(r.cardCountry).toBeNull();
    expect(r.cardFunding).toBeNull();
  });

  it('the failure detail path carries the same prohibition', () => {
    const d = resolvePaymentFailureDetail({
      id: 'ch_x',
      failure_code: 'card_declined',
      decline_code: 'do_not_honor',
      outcome: { type: 'issuer_declined', reason: 'do_not_honor', risk_level: 'normal', seller_message: 'The bank declined.' },
      payment_method_details: { type: 'card', card: { brand: 'unionpay', country: 'CN', funding: 'debit', last4: '4242', fingerprint: 'abc123', number: PAN } },
    });
    expect(JSON.stringify(d)).not.toContain(PAN);
    expect(JSON.stringify(d)).not.toContain('abc123');
    expect(d.cardBrand).toBe('unionpay');
  });
});

describe('resolvePaymentFailureDetail — the Radar tell', () => {
  it("surfaces outcome.type 'blocked', which is how Radar declares itself in the DATA", () => {
    // Stripe exposes NO rules-list API (`GET /v1/radar/rules` → 404), so Radar state is
    // otherwise a one-time manual Dashboard answer. This field turns it into a measurement
    // taken on every single failure.
    const d = resolvePaymentFailureDetail({
      outcome: { type: 'blocked', reason: 'highest_risk_level', risk_level: 'highest', seller_message: 'Stripe blocked this payment.' },
      payment_method_details: { type: 'card', card: { brand: 'unionpay', country: 'CN', funding: 'debit' } },
    });
    expect(d.outcomeType).toBe('blocked');
    expect(d.outcomeRiskLevel).toBe('highest');
    expect(d.cardCountry).toBe('CN');
  });

  it('delegates the four attribution fields rather than re-deriving them', () => {
    // Single-derivation: the failure path must return byte-identical attribution to the
    // success path for the same card. Two derivations would drift.
    const source = { payment_method_details: { type: 'card', card: { brand: 'jcb', country: 'JP', funding: 'credit' } } };
    const a = resolvePaymentMethodAttribution(source);
    const d = resolvePaymentFailureDetail(source);
    expect({ methodType: d.methodType, cardBrand: d.cardBrand, cardCountry: d.cardCountry, cardFunding: d.cardFunding }).toEqual(a);
  });

  it('caps free text and returns null for absent codes', () => {
    const d = resolvePaymentFailureDetail({ outcome: { seller_message: 'x'.repeat(9999) } });
    expect(d.outcomeSellerMessage!.length).toBe(512);
    expect(d.declineCode).toBeNull();
    expect(d.failureCode).toBeNull();
  });
});
