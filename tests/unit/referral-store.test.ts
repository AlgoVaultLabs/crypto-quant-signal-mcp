/**
 * REFERRAL-LIGHT-W1 / C1 — referral-store unit invariants.
 *
 * Covers: deterministic code derivation + CODE_RE; one-grant-per-human
 * (referee_email UNIQUE); ledger event-id idempotency; bonus grant/persist/load;
 * stats aggregation; pending-payout minUsd gate; partner-code minting.
 *
 * The four referral_* tables are exclusive to this feature, so a full DELETE in
 * beforeEach gives clean isolation with zero cross-file collision (the shared
 * SQLite file is only touched on these tables by this suite).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Per-file SQLite isolation (unique temp HOME before imports) — see free-keys.test.ts.
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-store-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

import {
  ensureReferralSchema,
  deriveUserCode,
  ensureUserCode,
  mintPartnerCode,
  resolveCode,
  recordAttribution,
  getAttributionByCustomer,
  getAttributionByEmail,
  grantBonus,
  getBonusRemaining,
  loadAllBonuses,
  persistBonusRemaining,
  appendLedger,
  getLedgerByEventId,
  markLedger,
  referrerStats,
  pendingPayouts,
} from '../../src/lib/referral-store.js';
import { REFERRAL_TERMS, isValidCodeFormat, commissionPct, shareLink, formatUsdE2 } from '../../src/lib/referral-constants.js';
import { dbRun } from '../../src/lib/performance-db.js';

beforeEach(() => {
  ensureReferralSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus']) {
    dbRun(`DELETE FROM ${t}`);
  }
});

describe('referral-constants (SoT renderers)', () => {
  it('renders program facts from the single source of truth', () => {
    expect(commissionPct()).toBe('30%');
    expect(REFERRAL_TERMS.BONUS_CALLS).toBe(500);
    expect(REFERRAL_TERMS.COMMISSION_MONTHS).toBe(12);
    expect(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD).toBe(50);
  });
  it('shareLink interpolates the code', () => {
    expect(shareLink('ABC123')).toBe('https://api.algovault.com/signup?ref=ABC123');
  });
  it('formatUsdE2 renders cents', () => {
    expect(formatUsdE2(9000)).toBe('$90.00');
    expect(formatUsdE2(3050)).toBe('$30.50');
  });
  it('isValidCodeFormat enforces 6-16 uppercase alnum', () => {
    expect(isValidCodeFormat('ABC123')).toBe(true);
    expect(isValidCodeFormat('abc123')).toBe(false); // lowercase
    expect(isValidCodeFormat('AB12')).toBe(false); // too short
    expect(isValidCodeFormat('A'.repeat(17))).toBe(false); // too long
    expect(isValidCodeFormat('AB_123')).toBe(false); // underscore
    expect(isValidCodeFormat(undefined)).toBe(false);
  });
});

describe('deriveUserCode (deterministic + idempotent)', () => {
  it('is stable for the same key', () => {
    const k = 'av_live_deadbeefdeadbeefdeadbeef';
    expect(deriveUserCode(k)).toBe(deriveUserCode(k));
  });
  it('produces a CODE_RE-valid 8-char code', () => {
    const c = deriveUserCode('av_live_0123456789abcdef01234567');
    expect(c).toHaveLength(8);
    expect(REFERRAL_TERMS.CODE_RE.test(c)).toBe(true);
  });
  it('differs across keys', () => {
    expect(deriveUserCode('av_live_aaaaaaaa')).not.toBe(deriveUserCode('av_live_bbbbbbbb'));
  });
});

describe('ensureUserCode (lazy, idempotent issuance)', () => {
  it('inserts once and returns the same code', async () => {
    const k = 'av_live_idempotency0000000000000000';
    const c1 = await ensureUserCode(k, 'u@example.com');
    const c2 = await ensureUserCode(k, 'u@example.com');
    expect(c1).toBe(c2);
    const row = await resolveCode(c1);
    expect(row?.kind).toBe('user');
    expect(row?.owner_key).toBe(k);
  });
});

describe('mintPartnerCode', () => {
  it('mints a valid partner code (uppercased)', async () => {
    const r = await mintPartnerCode({ code: 'cryptopanic', owner_label: 'listicle:cryptopanic', owner_email: 'x@p.com' });
    expect(r.kind).toBe('partner');
    expect(r.code).toBe('CRYPTOPANIC');
    expect((await resolveCode('CRYPTOPANIC'))?.owner_label).toBe('listicle:cryptopanic');
  });
  it('rejects invalid format', async () => {
    await expect(mintPartnerCode({ code: 'ab', owner_label: 'x' })).rejects.toThrow();
  });
  it('rejects duplicates', async () => {
    await mintPartnerCode({ code: 'PARTNERX', owner_label: 'a' });
    await expect(mintPartnerCode({ code: 'PARTNERX', owner_label: 'b' })).rejects.toThrow();
  });
});

describe('resolveCode (never throws on bad input)', () => {
  it('returns null for an invalid format', async () => {
    expect(await resolveCode('!!!')).toBeNull();
    expect(await resolveCode('nope!!')).toBeNull();
  });
  it('returns null for an unknown but well-formed code', async () => {
    expect(await resolveCode('ZZ9999')).toBeNull();
  });
});

describe('recordAttribution — one grant per human (referee_email UNIQUE)', () => {
  it('blocks a second attribution for the same referee email', async () => {
    await mintPartnerCode({ code: 'GRANT01', owner_label: 'p' });
    const first = await recordAttribution({ code: 'GRANT01', referee_email: 'ref@x.com', channel: 'free_signup' });
    expect(first.recorded).toBe(true);
    const second = await recordAttribution({ code: 'GRANT01', referee_email: 'ref@x.com', channel: 'free_signup' });
    expect(second.recorded).toBe(false);
    expect(second.id).toBe(first.id);
  });
  it('looks up by customer and by email', async () => {
    await mintPartnerCode({ code: 'CUST01', owner_label: 'p' });
    await recordAttribution({
      code: 'CUST01', referee_email: 'c@x.com', channel: 'paid_checkout',
      stripe_customer_id: 'cus_123', window_ends_at: '2027-01-01T00:00:00Z',
    });
    expect((await getAttributionByCustomer('cus_123'))?.referee_email).toBe('c@x.com');
    expect((await getAttributionByEmail('c@x.com'))?.channel).toBe('paid_checkout');
  });
});

describe('bonus meter', () => {
  it('grant is additive and getBonusRemaining reads it', async () => {
    const k = 'av_free_bonustest0000000000000000';
    await grantBonus(k, REFERRAL_TERMS.BONUS_CALLS, 'GRANT01');
    expect(await getBonusRemaining(k)).toBe(REFERRAL_TERMS.BONUS_CALLS);
    await grantBonus(k, 50);
    expect(await getBonusRemaining(k)).toBe(REFERRAL_TERMS.BONUS_CALLS + 50);
  });
  it('persistBonusRemaining sets the absolute value (C2 consumption write-through)', async () => {
    const k = 'av_free_persisttest00000000000000';
    await grantBonus(k, REFERRAL_TERMS.BONUS_CALLS);
    persistBonusRemaining(k, 123);
    expect(await getBonusRemaining(k)).toBe(123);
  });
  it('persistBonusRemaining upserts when no row exists yet', async () => {
    persistBonusRemaining('av_free_fresh000000000000000000000', 7);
    expect(await getBonusRemaining('av_free_fresh000000000000000000000')).toBe(7);
  });
  it('loadAllBonuses returns the warm-set for the in-memory map', async () => {
    await grantBonus('av_free_a0000000000000000000000000', 10);
    await grantBonus('av_free_b0000000000000000000000000', 20);
    const all = await loadAllBonuses();
    const m = new Map(all.map((r) => [r.tracker_key, r.bonus_remaining]));
    expect(m.get('av_free_a0000000000000000000000000')).toBe(10);
    expect(m.get('av_free_b0000000000000000000000000')).toBe(20);
  });
});

describe('ledger — idempotent accrual, stats, clawback', () => {
  it('appendLedger is idempotent on stripe_event_id', async () => {
    await mintPartnerCode({ code: 'LEDGER1', owner_label: 'p' });
    const a = await appendLedger({ code: 'LEDGER1', stripe_event_id: 'evt_1', invoice_id: 'in_1', gross_usd_e2: 10000, commission_usd_e2: 3000, status: 'usdc_pending' });
    expect(a.appended).toBe(true);
    const b = await appendLedger({ code: 'LEDGER1', stripe_event_id: 'evt_1', invoice_id: 'in_1', gross_usd_e2: 10000, commission_usd_e2: 3000, status: 'usdc_pending' });
    expect(b.appended).toBe(false);
    expect(b.id).toBe(a.id);
    expect((await getLedgerByEventId('evt_1'))?.commission_usd_e2).toBe(3000);
  });
  it('referrerStats aggregates signups/conversions and ledger by status', async () => {
    await mintPartnerCode({ code: 'STATS01', owner_label: 'p' });
    await recordAttribution({ code: 'STATS01', referee_email: 's1@x.com', channel: 'paid_checkout', stripe_customer_id: 'cus_s1' });
    await recordAttribution({ code: 'STATS01', referee_email: 's2@x.com', channel: 'free_signup' });
    await appendLedger({ code: 'STATS01', stripe_event_id: 'evt_c', gross_usd_e2: 10000, commission_usd_e2: 3000, status: 'credited' });
    await appendLedger({ code: 'STATS01', stripe_event_id: 'evt_p', gross_usd_e2: 20000, commission_usd_e2: 6000, status: 'usdc_pending' });
    const s = await referrerStats('STATS01');
    expect(s.signups).toBe(2);
    expect(s.conversions).toBe(1);
    expect(s.credited_usd_e2).toBe(3000);
    expect(s.usdc_pending_usd_e2).toBe(6000);
    expect(s.accrued_usd_e2).toBe(9000);
    expect(s.clawed_back_usd_e2).toBe(0);
  });
  it('markLedger flips status (clawback rail)', async () => {
    await mintPartnerCode({ code: 'CLAW01', owner_label: 'p' });
    const a = await appendLedger({ code: 'CLAW01', stripe_event_id: 'evt_claw', gross_usd_e2: 10000, commission_usd_e2: 3000, status: 'credited' });
    markLedger(a.id as number, 'clawed_back', 'reversal_txn_1');
    const row = await getLedgerByEventId('evt_claw');
    expect(row?.status).toBe('clawed_back');
    expect(row?.tx_ref).toBe('reversal_txn_1');
  });
});

describe('pendingPayouts — minUsd gate', () => {
  it('lists only codes whose pending total >= minUsd', async () => {
    await mintPartnerCode({ code: 'PAYBIG', owner_label: 'big', owner_email: 'big@x.com' });
    await mintPartnerCode({ code: 'PAYSML', owner_label: 'small' });
    await appendLedger({ code: 'PAYBIG', stripe_event_id: 'evt_b1', gross_usd_e2: 20000, commission_usd_e2: 6000, status: 'usdc_pending' });
    await appendLedger({ code: 'PAYBIG', stripe_event_id: 'evt_b2', gross_usd_e2: 10000, commission_usd_e2: 3000, status: 'usdc_pending' });
    await appendLedger({ code: 'PAYSML', stripe_event_id: 'evt_s1', gross_usd_e2: 5000, commission_usd_e2: 1500, status: 'usdc_pending' });
    const q = await pendingPayouts(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD); // $50
    const codes = q.map((p) => p.code);
    expect(codes).toContain('PAYBIG'); // $90 pending >= $50
    expect(codes).not.toContain('PAYSML'); // $15 < $50
    const big = q.find((p) => p.code === 'PAYBIG');
    expect(big?.pending_usd_e2).toBe(9000);
    expect(big?.row_count).toBe(2);
    expect(big?.ledger_ids).toHaveLength(2);
    expect(big?.owner_email).toBe('big@x.com');
  });
});
