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
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { dbExec } from '../../src/lib/performance-db.js';

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
