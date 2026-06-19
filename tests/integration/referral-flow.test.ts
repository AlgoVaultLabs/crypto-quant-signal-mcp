/**
 * REFERRAL-LIGHT-W1 / C3 — end-to-end referral flow (stubbed Stripe).
 *
 * Exercises the chapters together: free path (signup → av_free_ key + 500 bonus +
 * attribution → the bonus meter actually serves overflow calls) and paid path
 * (conversion → invoice.paid → 30% accrual → auto-credit / usdc_pending → stats +
 * payout queue reflect it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-flow-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

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

import { processFreeReferralSignup, onPaidConversion, processInvoicePaid } from '../../src/lib/referral-accrual.js';
import { ensureReferralSchema, mintPartnerCode, ensureUserCode, referrerStats, pendingPayouts } from '../../src/lib/referral-store.js';
import { ensureFreeKeysSchema, _resetFreeKeyCacheForTest } from '../../src/lib/free-keys-store.js';
import { trackCall, getMonthlyQuota, initQuotaDb } from '../../src/lib/license.js';
import { REFERRAL_TERMS } from '../../src/lib/referral-constants.js';
import { dbRun } from '../../src/lib/performance-db.js';
import type { LicenseInfo } from '../../src/types.js';

beforeEach(() => {
  initQuotaDb(); // creates quota_usage in the fresh per-file DB before the DELETE
  ensureReferralSchema();
  ensureFreeKeysSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus', 'free_keys', 'quota_usage']) dbRun(`DELETE FROM ${t}`);
  _resetFreeKeyCacheForTest();
  balanceTxnSpy.mockClear();
  customerLookup.clear();
});

const FREE_QUOTA = getMonthlyQuota('free');

describe('free referral flow', () => {
  it('two referees sign up → keys minted, bonus granted, stats reflect 2 signups, meter serves bonus', async () => {
    await mintPartnerCode({ code: 'FLOWP01', owner_label: 'creator', owner_email: 'creator@x.com' });

    const a = await processFreeReferralSignup('referee-a@x.com', 'FLOWP01');
    const b = await processFreeReferralSignup('referee-b@x.com', 'FLOWP01');
    expect(a.applied && b.applied).toBe(true);

    const stats = await referrerStats('FLOWP01');
    expect(stats.signups).toBe(2);
    expect(stats.conversions).toBe(0);

    // referee A: exhaust the monthly free allowance, then the bonus serves the overflow.
    const licA: LicenseInfo = { tier: 'free', key: a.freeKey as string };
    expect(trackCall(licA, FREE_QUOTA).allowed).toBe(true); // monthly exhausted exactly
    const overflow = trackCall(licA, 1);
    expect(overflow.allowed).toBe(true); // served from the +500 bonus
    expect(overflow.bonus_remaining).toBe(REFERRAL_TERMS.BONUS_CALLS - 1);
  });
});

describe('paid referral flow', () => {
  it('conversion → invoice.paid → 30% auto-credit; stats show conversion + credited, queue empty', async () => {
    const ownerKey = `av_live_${'o'.repeat(24)}`;
    const ownerCode = await ensureUserCode(ownerKey, 'owner@x.com');
    customerLookup.set(ownerKey, { customerId: 'cus_owner', tier: 'pro' });

    await onPaidConversion({ customerId: 'cus_buyer', apiKey: `av_live_${'b'.repeat(24)}`, refCode: ownerCode, email: 'buyer@x.com' });
    await processInvoicePaid({ id: 'evt_flow_paid', data: { object: { id: 'in_flow', customer: 'cus_buyer', amount_paid: 4900 } } }); // $49 Pro

    expect(balanceTxnSpy).toHaveBeenCalledTimes(1);
    expect(balanceTxnSpy.mock.calls[0][1].amount).toBe(-Math.round(4900 * REFERRAL_TERMS.COMMISSION_RATE)); // -1470

    const stats = await referrerStats(ownerCode);
    expect(stats.conversions).toBe(1);
    expect(stats.credited_usd_e2).toBe(1470);
    expect(stats.usdc_pending_usd_e2).toBe(0);

    // credited (not USDC-pending) → not in the payout queue
    expect((await pendingPayouts(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD)).find((p) => p.code === ownerCode)).toBeUndefined();
  });

  it('conversion for a referrer without a Stripe customer → usdc_pending lands in the ≥$50 queue', async () => {
    const ownerCode = await ensureUserCode(`av_live_${'n'.repeat(24)}`, 'nocust@x.com'); // no Stripe customer
    await onPaidConversion({ customerId: 'cus_buyer2', apiKey: `av_live_${'c'.repeat(24)}`, refCode: ownerCode, email: 'buyer2@x.com' });
    // a $200 invoice → 30% = $60 commission ≥ $50 min
    await processInvoicePaid({ id: 'evt_flow_pending', data: { object: { id: 'in_flow2', customer: 'cus_buyer2', amount_paid: 20000 } } });

    expect(balanceTxnSpy).not.toHaveBeenCalled();
    const stats = await referrerStats(ownerCode);
    expect(stats.usdc_pending_usd_e2).toBe(6000);

    const queue = await pendingPayouts(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD);
    const row = queue.find((p) => p.code === ownerCode);
    expect(row?.pending_usd_e2).toBe(6000);
  });
});
