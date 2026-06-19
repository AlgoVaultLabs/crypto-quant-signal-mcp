/**
 * REFERRAL-LIGHT-W1 / C3 — accrual engine unit invariants.
 * Free-signup mint+grant+attribute, self-referral refusal, paid conversion,
 * 30% accrual + auto-credit, idempotent replay, usdc_pending fallback, window
 * expiry, and clawback (both rails). Stripe is stubbed (no real charges).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Per-file SQLite isolation (unique temp HOME before imports).
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-accrual-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

// Stub the Stripe client: a fake balance-transaction creator + a customer lookup map.
const { balanceTxnSpy, customerLookup } = vi.hoisted(() => ({
  balanceTxnSpy: vi.fn(async (_id: string, _params: { amount: number }) => ({ id: 'txn_stub' })),
  customerLookup: new Map<string, { customerId: string; tier: string }>(),
}));
vi.mock('../../src/lib/stripe.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/stripe.js')>();
  return {
    ...actual,
    getStripeClient: () => ({
      customers: { createBalanceTransaction: balanceTxnSpy },
      webhookEndpoints: { list: async () => ({ data: [] }), update: async () => ({}) },
    }),
    getCustomerByApiKey: async (key: string) => customerLookup.get(key) ?? null,
  };
});

import {
  processFreeReferralSignup,
  onPaidConversion,
  processInvoicePaid,
  processChargeRefunded,
} from '../../src/lib/referral-accrual.js';
import {
  ensureReferralSchema,
  mintPartnerCode,
  ensureUserCode,
  recordAttribution,
  getAttributionByCustomer,
  getAttributionByEmail,
  getLedgerByEventId,
} from '../../src/lib/referral-store.js';
import { ensureFreeKeysSchema, _resetFreeKeyCacheForTest } from '../../src/lib/free-keys-store.js';
import { getBonusForKey } from '../../src/lib/license.js';
import { dbRun } from '../../src/lib/performance-db.js';

beforeEach(() => {
  ensureReferralSchema();
  ensureFreeKeysSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus', 'free_keys']) dbRun(`DELETE FROM ${t}`);
  _resetFreeKeyCacheForTest();
  balanceTxnSpy.mockClear();
  customerLookup.clear();
});

const invEvent = (id: string, invoiceId: string, customer: string, amountPaid: number) => ({
  id,
  data: { object: { id: invoiceId, customer, amount_paid: amountPaid } },
});

describe('processFreeReferralSignup', () => {
  it('mints a key, attributes, and grants +500 on a valid ref', async () => {
    await mintPartnerCode({ code: 'FREEP01', owner_label: 'p', owner_email: 'owner@x.com' });
    const r = await processFreeReferralSignup('newuser@x.com', 'FREEP01');
    expect(r.applied).toBe(true);
    expect(r.freeKey).toMatch(/^av_free_[0-9a-f]{24}$/);
    expect(r.bonusCalls).toBe(500);
    expect(getBonusForKey(r.freeKey as string)).toBe(500);
    expect((await getAttributionByEmail('newuser@x.com'))?.channel).toBe('free_signup');
  });
  it('refuses self-referral (referee email == code owner email)', async () => {
    await mintPartnerCode({ code: 'SELF01', owner_label: 'p', owner_email: 'self@x.com' });
    const r = await processFreeReferralSignup('self@x.com', 'SELF01');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('self_referral');
  });
  it('invalid ref → plain signup (no key, no bonus)', async () => {
    const r = await processFreeReferralSignup('x@x.com', 'NOSUCH9');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('invalid_ref');
  });
  it('one grant per human — a second free grant for the same email is refused', async () => {
    await mintPartnerCode({ code: 'DUPF01', owner_label: 'p' });
    expect((await processFreeReferralSignup('dupref@x.com', 'DUPF01')).applied).toBe(true);
    const r2 = await processFreeReferralSignup('dupref@x.com', 'DUPF01');
    expect(r2.applied).toBe(false);
    expect(r2.reason).toBe('already_attributed');
  });
});

describe('onPaidConversion', () => {
  it('records the paid attribution (with a 12-month window) + grants the referee bonus', async () => {
    await mintPartnerCode({ code: 'PAIDC01', owner_label: 'p', owner_email: 'owner@x.com' });
    const refereeKey = `av_live_${'1'.repeat(24)}`;
    await onPaidConversion({ customerId: 'cus_referee1', apiKey: refereeKey, refCode: 'PAIDC01', email: 'buyer@x.com' });
    const attr = await getAttributionByCustomer('cus_referee1');
    expect(attr?.code).toBe('PAIDC01');
    expect(attr?.channel).toBe('paid_checkout');
    expect(attr?.window_ends_at).toBeTruthy();
    expect(getBonusForKey(refereeKey)).toBe(500);
  });
});

describe('processInvoicePaid — accrual + auto-credit', () => {
  it('accrues 30% and auto-credits a referrer who has a Stripe customer', async () => {
    const ownerKey = `av_live_${'o'.repeat(24)}`;
    const ownerCode = await ensureUserCode(ownerKey, 'owner@x.com');
    customerLookup.set(ownerKey, { customerId: 'cus_owner', tier: 'pro' });
    await onPaidConversion({ customerId: 'cus_ref', apiKey: `av_live_${'r'.repeat(24)}`, refCode: ownerCode, email: 'buyer@x.com' });
    await processInvoicePaid(invEvent('evt_inv_1', 'in_1', 'cus_ref', 10000)); // $100
    expect(balanceTxnSpy).toHaveBeenCalledTimes(1);
    const [custId, params] = balanceTxnSpy.mock.calls[0];
    expect(custId).toBe('cus_owner');
    expect(params.amount).toBe(-3000); // 30% of $100 = $30 credit (negative)
    const led = await getLedgerByEventId('evt_inv_1');
    expect(led?.status).toBe('credited');
    expect(led?.commission_usd_e2).toBe(3000);
  });
  it('is idempotent — replaying the same event credits exactly once', async () => {
    const ownerKey = `av_live_${'p'.repeat(24)}`;
    const ownerCode = await ensureUserCode(ownerKey, 'owner2@x.com');
    customerLookup.set(ownerKey, { customerId: 'cus_owner2', tier: 'pro' });
    await onPaidConversion({ customerId: 'cus_ref2', apiKey: `av_live_${'s'.repeat(24)}`, refCode: ownerCode, email: 'b2@x.com' });
    await processInvoicePaid(invEvent('evt_dup', 'in_d', 'cus_ref2', 10000));
    await processInvoicePaid(invEvent('evt_dup', 'in_d', 'cus_ref2', 10000));
    expect(balanceTxnSpy).toHaveBeenCalledTimes(1);
  });
  it('parks usdc_pending when the referrer has no Stripe customer', async () => {
    const ownerCode = await ensureUserCode(`av_live_${'n'.repeat(24)}`, 'nocust@x.com');
    await onPaidConversion({ customerId: 'cus_ref3', apiKey: `av_live_${'q'.repeat(24)}`, refCode: ownerCode, email: 'b3@x.com' });
    await processInvoicePaid(invEvent('evt_pending', 'in_p', 'cus_ref3', 20000)); // $200
    expect(balanceTxnSpy).not.toHaveBeenCalled();
    const led = await getLedgerByEventId('evt_pending');
    expect(led?.status).toBe('usdc_pending');
    expect(led?.commission_usd_e2).toBe(6000); // 30% of $200
  });
  it('does not accrue past the commission window', async () => {
    await mintPartnerCode({ code: 'EXPD01', owner_label: 'p' });
    await recordAttribution({ code: 'EXPD01', referee_email: 'exp@x.com', referee_key: `av_live_${'e'.repeat(24)}`, channel: 'paid_checkout', stripe_customer_id: 'cus_exp', window_ends_at: '2020-01-01T00:00:00Z' });
    await processInvoicePaid(invEvent('evt_exp', 'in_e', 'cus_exp', 10000));
    expect(await getLedgerByEventId('evt_exp')).toBeNull();
    expect(balanceTxnSpy).not.toHaveBeenCalled();
  });
  it('ignores an invoice for a non-attributed customer', async () => {
    await processInvoicePaid(invEvent('evt_none', 'in_none', 'cus_unknown', 10000));
    expect(await getLedgerByEventId('evt_none')).toBeNull();
  });
});

describe('processChargeRefunded — clawback', () => {
  it('reverses a credited commission (positive debit) and marks clawed_back', async () => {
    const ownerKey = `av_live_${'o'.repeat(24)}`;
    const ownerCode = await ensureUserCode(ownerKey, 'owner@x.com');
    customerLookup.set(ownerKey, { customerId: 'cus_owner', tier: 'pro' });
    await onPaidConversion({ customerId: 'cus_ref', apiKey: `av_live_${'r'.repeat(24)}`, refCode: ownerCode, email: 'b@x.com' });
    await processInvoicePaid(invEvent('evt_c', 'in_claw', 'cus_ref', 10000));
    expect(balanceTxnSpy).toHaveBeenCalledTimes(1); // credit
    balanceTxnSpy.mockClear();
    await processChargeRefunded({ data: { object: { invoice: 'in_claw' } } });
    expect(balanceTxnSpy).toHaveBeenCalledTimes(1); // reversal
    expect(balanceTxnSpy.mock.calls[0][1].amount).toBe(3000); // positive = debit back
    expect((await getLedgerByEventId('evt_c'))?.status).toBe('clawed_back');
  });
  it('voids a usdc_pending commission with no balance call', async () => {
    const ownerCode = await ensureUserCode(`av_live_${'n'.repeat(24)}`, 'nc@x.com');
    await onPaidConversion({ customerId: 'cus_ref3', apiKey: `av_live_${'q'.repeat(24)}`, refCode: ownerCode, email: 'b3@x.com' });
    await processInvoicePaid(invEvent('evt_pend', 'in_pend', 'cus_ref3', 20000));
    expect(balanceTxnSpy).not.toHaveBeenCalled();
    await processChargeRefunded({ data: { object: { invoice: 'in_pend' } } });
    expect(balanceTxnSpy).not.toHaveBeenCalled();
    expect((await getLedgerByEventId('evt_pend'))?.status).toBe('clawed_back');
  });
});
