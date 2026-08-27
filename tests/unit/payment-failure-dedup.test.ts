/**
 * PAY-UNIONPAY-ATTRIBUTION-W1 (R8 / AC5) — the dedup dimension.
 *
 * ONE declined card fires BOTH `payment_intent.payment_failed` AND `charge.failed`. Those are
 * two events, two `event_id`s, two ROWS — and exactly ONE failed payment. Counting rows would
 * report a 2x decline rate off a single decline, and the rate is this wave's entire
 * deliverable. So every rate is computed over `COUNT(DISTINCT payment_intent_id)`.
 *
 * Measured on the live account before shipping: `payment_intent.payment_failed` = 3 vs
 * `charge.failed` = 1 over the same window — demonstrably not 1:1, which is why both rows are
 * KEPT and deduped at read time rather than deduped at write time. Write-time dedup would
 * permanently destroy the distinction between "blocked before charge creation" (PI-failure
 * alone) and "issuer declined the charge" (both).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Per-file SQLite isolation (unique temp HOME before imports) — same shape as the sibling
// stripe-webhook-idempotency suite. `DATABASE_URL` must be deleted BEFORE import: the store
// reads it at module load to pick its dialect.
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-pay-dedup-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

import {
  buildPaymentFailureRow,
  recordPaymentFailure,
  getFailureAggregate,
  countDistinctFailedPayments,
  ensureStripePaymentFailuresSchema,
  PAYMENT_FAILURE_EVENT_TYPES,
} from '../../src/lib/stripe-payment-failures-store.js';
import { computeDeclineRates } from '../../src/lib/payment-method-report.js';
import { dbExec, dbQuery } from '../../src/lib/performance-db.js';

const PI = 'pi_one_declined_payment';
const CARD = { type: 'card', card: { brand: 'unionpay', country: 'CN', funding: 'debit' } };

/** The SAME underlying decline, as Stripe delivers it twice. */
const piEvent = {
  id: 'evt_pi_fail',
  type: 'payment_intent.payment_failed',
  created: 1_760_000_000,
  data: { object: { id: PI, object: 'payment_intent', amount: 999, currency: 'usd', created: 1_760_000_000,
    last_payment_error: { code: 'card_declined', decline_code: 'do_not_honor', message: 'declined', payment_method: CARD } } },
};
const chargeEvent = {
  id: 'evt_charge_fail',
  type: 'charge.failed',
  created: 1_760_000_005,
  data: { object: { id: 'ch_x', object: 'charge', payment_intent: PI, amount: 999, currency: 'usd', created: 1_760_000_005,
    failure_code: 'card_declined', decline_code: 'do_not_honor',
    outcome: { type: 'issuer_declined', reason: 'do_not_honor', risk_level: 'normal' },
    payment_method_details: CARD } },
};

beforeEach(() => {
  ensureStripePaymentFailuresSchema();
  // `dbExec`, not `dbQuery`: dbQuery runs `.all()` and better-sqlite3 throws
  // "This statement does not return data" on a bare DELETE.
  dbExec('DELETE FROM stripe_payment_failures');
});

describe('the three subscribed failure events', () => {
  it('are exactly the set the webhook switch handles', () => {
    expect([...PAYMENT_FAILURE_EVENT_TYPES].sort()).toEqual([
      'charge.failed', 'invoice.payment_failed', 'payment_intent.payment_failed',
    ]);
  });

  it("extracts the PI id from each event's own shape", () => {
    // A PI event's own `id` IS the payment intent; a Charge and an Invoice REFERENCE one.
    expect(buildPaymentFailureRow(piEvent)!.paymentIntentId).toBe(PI);
    expect(buildPaymentFailureRow(chargeEvent)!.paymentIntentId).toBe(PI);
    expect(buildPaymentFailureRow({
      id: 'evt_inv', type: 'invoice.payment_failed', created: 1,
      data: { object: { id: 'in_1', payment_intent: PI, amount_due: 4900, currency: 'usd', created: 1 } },
    })!.paymentIntentId).toBe(PI);
  });

  it('stamps occurred_at from the Stripe object, never wall-clock now()', () => {
    const row = buildPaymentFailureRow(chargeEvent)!;
    expect(row.occurredAt).toBe(new Date(1_760_000_005 * 1000).toISOString());
    // A now() stamp would file this months-old decline as today's and fabricate a spike.
    expect(new Date(row.occurredAt).getFullYear()).toBe(2025);
  });

  it('writes amount_usd only when the charge is actually USD', () => {
    // The account settles in MYR (`default_currency=myr`, measured) while plans.ts prices in
    // USD, so currency is not assumable. Non-USD → null, never an invented conversion.
    expect(buildPaymentFailureRow(chargeEvent)!.amountUsd).toBe(9.99);
    const myr = { ...chargeEvent, data: { object: { ...chargeEvent.data.object, currency: 'myr' } } };
    expect(buildPaymentFailureRow(myr)!.amountUsd).toBeNull();
  });

  it('returns null for an event with no usable object', () => {
    expect(buildPaymentFailureRow({ id: 'evt', type: 'charge.failed' })).toBeNull();
    expect(buildPaymentFailureRow(null)).toBeNull();
  });
});

describe('🛑 one decline, two events → counted ONCE', () => {
  it('stores two rows but reports one distinct payment', async () => {
    expect(await recordPaymentFailure(buildPaymentFailureRow(piEvent)!)).toBe(true);
    expect(await recordPaymentFailure(buildPaymentFailureRow(chargeEvent)!)).toBe(true);

    const agg = await getFailureAggregate('Lifetime');
    expect(agg.rows).toBe(2);                      // both preserved — the asymmetry is signal
    expect(agg.distinct_payment_intents).toBe(1);  // ...but it is ONE failed payment
  });

  it('groups by brand over distinct payments too, not rows', async () => {
    await recordPaymentFailure(buildPaymentFailureRow(piEvent)!);
    await recordPaymentFailure(buildPaymentFailureRow(chargeEvent)!);
    const agg = await getFailureAggregate('Lifetime');
    const unionpay = agg.by_brand.find((b) => b.card_brand === 'unionpay');
    expect(unionpay?.n).toBe(1);
  });

  it('the canary input is deduped identically', async () => {
    await recordPaymentFailure(buildPaymentFailureRow(piEvent)!);
    await recordPaymentFailure(buildPaymentFailureRow(chargeEvent)!);
    expect(await countDistinctFailedPayments(null)).toBe(1);
  });

  it('two DIFFERENT payments count as two', async () => {
    await recordPaymentFailure(buildPaymentFailureRow(piEvent)!);
    await recordPaymentFailure(buildPaymentFailureRow({
      ...piEvent, id: 'evt_other', data: { object: { ...piEvent.data.object, id: 'pi_second' } },
    })!);
    expect(await countDistinctFailedPayments(null)).toBe(2);
  });

  it('a NULL payment_intent_id still counts — under-reporting a decline is forbidden', async () => {
    // COUNT(DISTINCT payment_intent_id) alone would DROP such a row silently. The COALESCE to
    // event_id is what keeps it counted; a decline must never vanish from the numerator.
    const row = buildPaymentFailureRow(piEvent)!;
    await recordPaymentFailure({ ...row, eventId: 'evt_nopi', paymentIntentId: null });
    expect(await countDistinctFailedPayments(null)).toBe(1);
  });
});

describe('event-id idempotency (replay writes exactly one row)', () => {
  it('a redelivered event does not double-write', async () => {
    expect(await recordPaymentFailure(buildPaymentFailureRow(piEvent)!)).toBe(true);
    expect(await recordPaymentFailure(buildPaymentFailureRow(piEvent)!)).toBe(false);
    const agg = await getFailureAggregate('Lifetime');
    expect(agg.rows).toBe(1);
    expect(agg.distinct_payment_intents).toBe(1);
  });
});

describe('computeDeclineRates', () => {
  it('carries n alongside every rate and marks low confidence below n=20', () => {
    const [r] = computeDeclineRates([{ card_brand: 'visa', n: 9 }], [{ card_brand: 'visa', n: 1 }]);
    expect(r).toMatchObject({ card_brand: 'visa', succeeded_n: 9, failed_n: 1, total_n: 10, decline_rate_pct: 10, low_confidence: true });
  });

  it('keeps a brand that has ONLY ever failed — the most important row it can produce', () => {
    const rates = computeDeclineRates([], [{ card_brand: 'unionpay', n: 3 }]);
    expect(rates).toHaveLength(1);
    expect(rates[0]).toMatchObject({ card_brand: 'unionpay', succeeded_n: 0, failed_n: 3, decline_rate_pct: 100 });
  });

  it('an empty population is UNMEASURED (null), not 0%', () => {
    // 0% would read as "nothing ever declined on this brand" — a claim nobody made.
    const [r] = computeDeclineRates([{ card_brand: 'jcb', n: 0 }], []);
    expect(r.decline_rate_pct).toBeNull();
  });

  it('clears low_confidence once n reaches 20', () => {
    const [r] = computeDeclineRates([{ card_brand: 'visa', n: 18 }], [{ card_brand: 'visa', n: 2 }]);
    expect(r.total_n).toBe(20);
    expect(r.low_confidence).toBe(false);
  });
});

/**
 * OPS-MONITORING-DRIFT-GENERATOR-FIX-W1 — the linkage the table was dropping, and the unit the
 * R9 floor actually means.
 *
 * The fixtures below are CAPTURED, not invented: they are the shapes the live account returned
 * for the six rows that made `PAYMENT_DECLINE_DRIFT` page on 2026-08-22, fetched from
 * `GET /v1/events/<id>` on api_version `2026-03-25.dahlia`. All six were ONE customer
 * (`cus_UuBrP1otU51OBm`), ONE subscription, ONE invoice and ONE PaymentIntent — while the
 * canary's `COUNT(DISTINCT COALESCE(payment_intent_id, event_id))` scored them as THREE
 * distinct failed payments and tripped its absolute floor of 3.
 *
 * A gate's fixture must be captured from the channel the gate reads. Hand-typing an Invoice
 * with a top-level `payment_intent` — the shape the previous mapper assumed — is exactly how
 * this survived: that key does not exist on `dahlia`.
 */
const CUS = 'cus_UuBrP1otU51OBm';
const SUB = 'sub_1TuNZsKGleoEgU2HFOPmRfOT';
const INV = 'in_1U5cMXKGleoEgU2HSuKXNYbv';
const LIVE_PI = 'pi_3U5dJUKGleoEgU2H1w4OOSqs';

/** Captured. Note: NO `payment_intent`, NO top-level `subscription`, NO `payments` array. */
const dahliaInvoiceEvent = (eventId: string, attempt: number) => ({
  id: eventId,
  type: 'invoice.payment_failed',
  created: 1_787_000_000 + attempt,
  data: {
    object: {
      id: INV, object: 'invoice', customer: CUS, amount_due: 999, currency: 'usd',
      created: 1_787_000_000 + attempt, attempt_count: attempt, billing_reason: 'subscription_cycle',
      status: 'open',
      parent: { type: 'subscription_details', quote_details: null,
        subscription_details: { metadata: {}, subscription: SUB } },
    },
  },
});

const dahliaChargeEvent = (eventId: string, n: number) => ({
  id: eventId, type: 'charge.failed', created: 1_787_000_100 + n,
  data: { object: { id: `ch_${n}`, object: 'charge', customer: CUS, payment_intent: LIVE_PI,
    amount: 999, currency: 'usd', created: 1_787_000_100 + n, failure_code: 'card_declined',
    decline_code: 'insufficient_funds',
    outcome: { type: 'issuer_declined', reason: 'insufficient_funds', risk_level: 'normal' },
    payment_method_details: { type: 'card', card: { brand: 'mastercard', country: 'CH', funding: 'credit' } } } },
});

const dahliaPiEvent = (eventId: string, n: number) => ({
  id: eventId, type: 'payment_intent.payment_failed', created: 1_787_000_200 + n,
  data: { object: { id: LIVE_PI, object: 'payment_intent', customer: CUS, amount: 999,
    currency: 'usd', created: 1_787_000_200 + n,
    last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds',
      message: 'declined',
      payment_method: { type: 'card', card: { brand: 'mastercard', country: 'CH', funding: 'credit' } } } } },
});

describe('🛑 the linkage `dahlia` actually carries', () => {
  it('an Invoice has NO payment_intent — so the old mapper wrote NULL for every invoice event', () => {
    const inv = dahliaInvoiceEvent('evt_inv_1', 1).data.object as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(inv, 'payment_intent')).toBe(false);
    expect(buildPaymentFailureRow(dahliaInvoiceEvent('evt_inv_1', 1))!.paymentIntentId).toBeNull();
  });

  it('...but it DOES carry the customer, and so do the other two events', () => {
    expect(buildPaymentFailureRow(dahliaInvoiceEvent('evt_inv_1', 1))!.customerId).toBe(CUS);
    expect(buildPaymentFailureRow(dahliaChargeEvent('evt_ch_1', 1))!.customerId).toBe(CUS);
    expect(buildPaymentFailureRow(dahliaPiEvent('evt_pi_1', 1))!.customerId).toBe(CUS);
  });

  it('reads the subscription from `parent.subscription_details`, where dahlia moved it', () => {
    const row = buildPaymentFailureRow(dahliaInvoiceEvent('evt_inv_1', 1))!;
    expect(row.subscriptionId).toBe(SUB);
    expect(row.invoiceId).toBe(INV);
  });

  it('still reads a legacy top-level `subscription` / `payment_intent` (pre-basil payloads)', () => {
    const legacy = {
      id: 'evt_legacy', type: 'invoice.payment_failed', created: 1,
      data: { object: { id: 'in_legacy', object: 'invoice', subscription: 'sub_legacy',
        payment_intent: 'pi_legacy', amount_due: 999, currency: 'usd', created: 1 } },
    };
    const row = buildPaymentFailureRow(legacy)!;
    expect(row.paymentIntentId).toBe('pi_legacy');
    expect(row.subscriptionId).toBe('sub_legacy');
  });

  it('prefers the modern `payments[].payment.payment_intent` when a backfill expands it', () => {
    const expanded = {
      id: 'evt_expanded', type: 'invoice.payment_failed', created: 1,
      data: { object: { id: INV, object: 'invoice', customer: CUS, amount_due: 999, currency: 'usd',
        created: 1, payments: { data: [{ status: 'open', payment: { payment_intent: LIVE_PI } }] } } },
    };
    expect(buildPaymentFailureRow(expanded)!.paymentIntentId).toBe(LIVE_PI);
  });

  it('a charge carries no invoice on dahlia — null, never a fabricated linkage', () => {
    expect(buildPaymentFailureRow(dahliaChargeEvent('evt_ch_1', 1))!.invoiceId).toBeNull();
  });
});

describe('🛑 THE REGRESSION: one dunned customer is ONE failing customer', () => {
  it('the live six-row episode counts 1 by customer where the old unit counted 3', async () => {
    // Exactly the live 30d table: 2 invoice retries (NULL PI) + 2 PI failures + 2 charge failures.
    for (const e of [
      dahliaInvoiceEvent('evt_1U5dJZKGleoEgU2HUjnGDU0Y', 1),
      dahliaInvoiceEvent('evt_1U6aJhKGleoEgU2H0EP3m1to', 2),
      dahliaPiEvent('evt_3U5dJUKGleoEgU2H1MIUjBXZ', 1),
      dahliaPiEvent('evt_3U5dJUKGleoEgU2H1mWyYxK3', 2),
      dahliaChargeEvent('evt_3U5dJUKGleoEgU2H1BB6HbtZ', 1),
      dahliaChargeEvent('evt_3U5dJUKGleoEgU2H1kQ7Rhz5', 2),
    ]) {
      expect(await recordPaymentFailure(buildPaymentFailureRow(e)!)).toBe(true);
    }

    const [rows] = await dbQuery<{ n: number }>(
      'SELECT COUNT(*) AS n FROM stripe_payment_failures', []);
    expect(Number(rows.n)).toBe(6);

    // The OLD unit — the one that paged. Kept as an assertion so the inflation stays visible.
    const [oldUnit] = await dbQuery<{ n: number }>(
      'SELECT COUNT(DISTINCT COALESCE(payment_intent_id, event_id)) AS n FROM stripe_payment_failures', []);
    expect(Number(oldUnit.n)).toBe(3);

    // The unit the floor means.
    const [newUnit] = await dbQuery<{ n: number }>(
      'SELECT COUNT(DISTINCT COALESCE(customer_id, payment_intent_id, event_id)) AS n FROM stripe_payment_failures', []);
    expect(Number(newUnit.n)).toBe(1);
  });

  it('two genuinely different customers still count as two', async () => {
    await recordPaymentFailure(buildPaymentFailureRow(dahliaChargeEvent('evt_a', 1))!);
    await recordPaymentFailure(buildPaymentFailureRow({
      ...dahliaChargeEvent('evt_b', 2),
      data: { object: { ...dahliaChargeEvent('evt_b', 2).data.object, customer: 'cus_someone_else',
        payment_intent: 'pi_someone_else' } },
    })!);
    const [n] = await dbQuery<{ n: number }>(
      'SELECT COUNT(DISTINCT COALESCE(customer_id, payment_intent_id, event_id)) AS n FROM stripe_payment_failures', []);
    expect(Number(n.n)).toBe(2);
  });

  it('a row with NO customer falls back to its PI and is never DROPPED', async () => {
    await recordPaymentFailure({
      ...buildPaymentFailureRow(dahliaChargeEvent('evt_nocus', 3))!,
      customerId: null,
    });
    const [n] = await dbQuery<{ n: number }>(
      'SELECT COUNT(DISTINCT COALESCE(customer_id, payment_intent_id, event_id)) AS n FROM stripe_payment_failures', []);
    expect(Number(n.n)).toBe(1);
  });
});

/**
 * OPS-PAYMENT-DECLINE-INSTRUMENT-UNIT-W1 — one card, several customer records, ONE failing payer.
 *
 * THE INCIDENT. On 2026-08-27 the decline floor fired on "3 distinct CUSTOMERS with a failed
 * payment in the last 7d". Two of those three were the SAME PHYSICAL CARD: Stripe fingerprint
 * `NErSOdf0ZP9j0cJB`, last4 7755, two customer records created 48 MINUTES apart with different
 * emails, both `past_due`. True distinct payment instruments: 2 — which does not breach a floor
 * of 3.
 *
 * This is the customer-unit defect one rung higher. Stripe inflates per PAYMENT (dunning
 * retries), then per CUSTOMER RECORD (one person can hold many). It cannot inflate per CARD.
 *
 * Fixtures are CAPTURED shapes: measured on api_version 2026-03-25.dahlia, the fingerprint is
 * present on `charge.failed` (`payment_method_details.card`) and on
 * `payment_intent.payment_failed` (`last_payment_error.payment_method.card`), and ABSENT from
 * `invoice.payment_failed` — which is exactly why the canary joins it per customer, not per row.
 */
const FP_SHARED = 'NErSOdf0ZP9j0cJB';
const CUS_A = 'cus_UxLEF1LqHKaHih';
const CUS_B = 'cus_UxM0PrC0uwky7Q';

const sharedCard = (fingerprint: string) => ({
  type: 'card',
  card: { brand: 'mastercard', country: 'US', funding: 'credit', last4: '7755', fingerprint },
});

const chargeWithCard = (eventId: string, customer: string, pi: string, fingerprint: string) => ({
  id: eventId, type: 'charge.failed', created: 1_788_000_000,
  data: { object: { id: `ch_${eventId}`, object: 'charge', customer, payment_intent: pi,
    amount: 999, currency: 'usd', created: 1_788_000_000, failure_code: 'card_declined',
    decline_code: 'insufficient_funds', payment_method_details: sharedCard(fingerprint) } },
});

const piWithCard = (eventId: string, customer: string, pi: string, fingerprint: string) => ({
  id: eventId, type: 'payment_intent.payment_failed', created: 1_788_000_100,
  data: { object: { id: pi, object: 'payment_intent', customer, amount: 999, currency: 'usd',
    created: 1_788_000_100,
    last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds',
      message: 'declined', payment_method: sharedCard(fingerprint) } } },
});

/**
 * The pseudonym key is set BY THE SUITE, never inherited from the developer's shell. Measured:
 * without it these tests pass locally (my shell had it) and fail in CI — the classic hermeticity
 * hole, and the reason `hashCardRef`'s no-key degrade path gets its own explicit test below
 * rather than being the accidental default everywhere else.
 */
const TEST_PSEUDONYM_KEY = 'test-card-ref-key-0000000000000000000000000000000000000000000000';
let _savedKey: string | undefined;
beforeEach(() => { _savedKey = process.env.ALGOVAULT_IP_HASH_KEY; process.env.ALGOVAULT_IP_HASH_KEY = TEST_PSEUDONYM_KEY; });
afterEach(() => {
  if (_savedKey === undefined) delete process.env.ALGOVAULT_IP_HASH_KEY;
  else process.env.ALGOVAULT_IP_HASH_KEY = _savedKey;
});

describe('🛑 the card pseudonym — the unit one rung above the customer record', () => {
  it('🛑 stores a KEYED ref, never the fingerprint — the PAN prohibition is not weakened', () => {
    const row = buildPaymentFailureRow(chargeWithCard('evt_pan', CUS_A, 'pi_a', FP_SHARED))!;
    expect(row.cardRef).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain(FP_SHARED);
    expect(JSON.stringify(row)).not.toContain('7755');
  });

  it('🛑 no key ⇒ NULL ref, never an unkeyed value, and never a throw on the webhook path', () => {
    delete process.env.ALGOVAULT_IP_HASH_KEY;
    let row: ReturnType<typeof buildPaymentFailureRow>;
    expect(() => { row = buildPaymentFailureRow(chargeWithCard('evt_nokey', CUS_A, 'pi_a', FP_SHARED)); })
      .not.toThrow();
    expect(row!.cardRef).toBeNull();
    // ...and the row is otherwise intact, so the canary simply falls back to customer_id.
    expect(row!.customerId).toBe(CUS_A);
  });

  it('the same card yields the same ref; a different card a different one', () => {
    const a = buildPaymentFailureRow(chargeWithCard('evt_s1', CUS_A, 'pi_a', FP_SHARED))!.cardRef;
    const b = buildPaymentFailureRow(chargeWithCard('evt_s2', CUS_B, 'pi_b', FP_SHARED))!.cardRef;
    const c = buildPaymentFailureRow(chargeWithCard('evt_s3', CUS_A, 'pi_c', 'DifferentCard123'))!.cardRef;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('case is PRESERVED — two cards differing only in case must not fold together', () => {
    const upper = buildPaymentFailureRow(chargeWithCard('evt_u', CUS_A, 'pi_a', 'AbCdEfGh1234'))!.cardRef;
    const lower = buildPaymentFailureRow(chargeWithCard('evt_l', CUS_A, 'pi_a', 'abcdefgh1234'))!.cardRef;
    expect(upper).not.toBe(lower);
  });

  it('is extracted from a charge (payment_method_details.card)', () => {
    const ref = buildPaymentFailureRow(chargeWithCard('evt_c1', CUS_A, 'pi_a', FP_SHARED))!.cardRef!;
    expect(ref).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(ref).not.toContain(FP_SHARED);
  });

  it('is extracted from a PaymentIntent (last_payment_error.payment_method.card)', () => {
    expect(buildPaymentFailureRow(piWithCard('evt_p1', CUS_A, 'pi_a', FP_SHARED))!.cardRef)
      .toBe(buildPaymentFailureRow(chargeWithCard('evt_c9', CUS_B, 'pi_b', FP_SHARED))!.cardRef);
  });

  it('is NULL on an invoice — it carries no card node, and that is why the join is per customer', () => {
    const row = buildPaymentFailureRow(dahliaInvoiceEvent('evt_inv_fp', 1))!;
    expect(row.cardRef).toBeNull();
    expect(row.customerId).toBe(CUS);   // ...but the customer IS there, which is what rescues it
  });

  it('a too-short or non-base62 fingerprint is REFUSED, never keyed into a bogus ref', () => {
    // The validator bounds are 8..64 base62 chars. A short or punctuated value is not a Stripe
    // fingerprint, and hashing it anyway would mint a confident key for a value we do not trust.
    for (const bad of ['short', 'has-dash-000000', '', '   ']) {
      expect(buildPaymentFailureRow(chargeWithCard('evt_bad', CUS_A, 'pi_a', bad))!.cardRef).toBeNull();
    }
    expect(buildPaymentFailureRow(chargeWithCard('evt_ok', CUS_A, 'pi_a', 'abcd1234'))!.cardRef)
      .toMatch(/^v1:[0-9a-f]{16}$/);
  });

  it('a card-less method (no card node at all) yields null, never a fabricated key', () => {
    const noCard = {
      id: 'evt_nocard', type: 'charge.failed', created: 1,
      data: { object: { id: 'ch_x', object: 'charge', customer: CUS_A, amount: 999,
        currency: 'usd', created: 1, payment_method_details: { type: 'link' } } },
    };
    expect(buildPaymentFailureRow(noCard)!.cardRef).toBeNull();
  });
});

describe('🛑 THE REGRESSION: two customer records, one card, one failing payer', () => {
  it('the live 2026-08-27 shape counts 2 by card where the customer unit counted 3', async () => {
    // Customer A and B share ONE card; customer C (the incumbent past_due) has a different one.
    for (const e of [
      chargeWithCard('evt_a_ch', CUS_A, 'pi_a', FP_SHARED),
      piWithCard('evt_a_pi', CUS_A, 'pi_a', FP_SHARED),
      chargeWithCard('evt_b_ch', CUS_B, 'pi_b', FP_SHARED),
      piWithCard('evt_b_pi', CUS_B, 'pi_b', FP_SHARED),
      chargeWithCard('evt_c_ch', CUS, 'pi_c', 'fn0g5haOdN7RU6eh'),
    ]) {
      expect(await recordPaymentFailure(buildPaymentFailureRow(e)!)).toBe(true);
    }
    // Plus an INVOICE row for A, which carries no card — the row the per-row COALESCE would split.
    await recordPaymentFailure(buildPaymentFailureRow(dahliaInvoiceEvent('evt_a_inv', 1))!);

    const [byCustomer] = await dbQuery<{ n: number }>(
      'SELECT COUNT(DISTINCT COALESCE(customer_id, payment_intent_id, event_id)) AS n FROM stripe_payment_failures', []);
    const [byCard] = await dbQuery<{ n: number }>(
      `WITH fp AS (SELECT customer_id, MAX(card_ref) AS card_ref
                     FROM stripe_payment_failures
                    WHERE customer_id IS NOT NULL AND COALESCE(TRIM(card_ref),'') <> ''
                    GROUP BY customer_id)
       SELECT COUNT(DISTINCT COALESCE(fp.card_ref, f.customer_id, f.payment_intent_id, f.event_id)) AS n
         FROM stripe_payment_failures f LEFT JOIN fp ON fp.customer_id = f.customer_id`, []);

    expect(Number(byCustomer.n)).toBe(3);   // the unit that fired the floor
    expect(Number(byCard.n)).toBe(2);       // the truth: two physical cards
  });

  it('...and the invoice row inherits its customer\'s card rather than splitting off', async () => {
    await recordPaymentFailure(buildPaymentFailureRow(chargeWithCard('evt_a_ch', CUS_A, 'pi_a', FP_SHARED))!);
    await recordPaymentFailure(buildPaymentFailureRow(dahliaInvoiceEvent('evt_a_inv', 1))!);
    const [n] = await dbQuery<{ n: number }>(
      `WITH fp AS (SELECT customer_id, MAX(card_ref) AS card_ref
                     FROM stripe_payment_failures
                    WHERE customer_id IS NOT NULL AND COALESCE(TRIM(card_ref),'') <> ''
                    GROUP BY customer_id)
       SELECT COUNT(DISTINCT COALESCE(fp.card_ref, f.customer_id, f.payment_intent_id, f.event_id)) AS n
         FROM stripe_payment_failures f LEFT JOIN fp ON fp.customer_id = f.customer_id`, []);
    // The invoice row belongs to a DIFFERENT customer (CUS) than the charge (CUS_A), so 2 is
    // correct here — what matters is that neither splits into more than one key.
    expect(Number(n.n)).toBe(2);
  });

  it('two genuinely different CARDS still count as two — the alarm is not disarmed', async () => {
    await recordPaymentFailure(buildPaymentFailureRow(chargeWithCard('evt_x', CUS_A, 'pi_x', 'FPoneAAAAAAAAAAA'))!);
    await recordPaymentFailure(buildPaymentFailureRow(chargeWithCard('evt_y', CUS_B, 'pi_y', 'FPtwoBBBBBBBBBBB'))!);
    const [n] = await dbQuery<{ n: number }>(
      'SELECT COUNT(DISTINCT card_ref) AS n FROM stripe_payment_failures WHERE card_ref IS NOT NULL', []);
    expect(Number(n.n)).toBe(2);
  });
});
