/**
 * TG-REFERRAL-W1 / C1 — referral machine API + TG identity-lane invariants.
 *
 * Covers: deterministic/opaque tgIdentity; resolve-or-mint idempotency for a TG
 * user; deep-link + share-url shape; terms projected from the SoT (never
 * hardcoded); attribution (channel='tg') one-grant-per-tg + self-referral +
 * invalid/unknown-code refusal; the bonus amount = REFERRAL_TERMS.BONUS_CALLS.
 *
 * Reuses the referral_* tables (full DELETE in beforeEach; this suite is the only
 * toucher of these tables in its own temp-HOME SQLite file).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Per-file SQLite isolation (unique temp HOME before imports) — see referral-store.test.ts.
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-api-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

import {
  tgIdentity,
  tgDeepLink,
  referralTerms,
  resolveTgReferralCode,
  attributeTgReferral,
} from '../../src/lib/referral-api.js';
import { ensureReferralSchema, getAttributionByEmail, referrerStats } from '../../src/lib/referral-store.js';
import { REFERRAL_TERMS, isValidCodeFormat } from '../../src/lib/referral-constants.js';
import { dbRun } from '../../src/lib/performance-db.js';

beforeEach(() => {
  ensureReferralSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus']) {
    dbRun(`DELETE FROM ${t}`);
  }
});

describe('tgIdentity', () => {
  it('is deterministic, opaque, and prefixed', () => {
    const a = tgIdentity(1793689937);
    expect(a).toBe(tgIdentity('1793689937')); // number vs string → same
    expect(a.startsWith('tg:')).toBe(true);
    expect(a).not.toContain('1793689937'); // raw chat_id never appears
  });
  it('maps distinct chat_ids to distinct identities', () => {
    expect(tgIdentity(111)).not.toBe(tgIdentity(222));
  });
});

describe('referralTerms (SoT projection)', () => {
  it('mirrors REFERRAL_TERMS exactly', () => {
    const t = referralTerms();
    expect(t.bonus_calls).toBe(REFERRAL_TERMS.BONUS_CALLS);
    expect(t.commission_pct).toBe(Math.round(REFERRAL_TERMS.COMMISSION_RATE * 100));
    expect(t.commission_months).toBe(REFERRAL_TERMS.COMMISSION_MONTHS);
  });
});

describe('resolveTgReferralCode', () => {
  it('resolve-or-mint is idempotent and yields a valid code + links + SoT terms', async () => {
    const r1 = await resolveTgReferralCode(555001);
    const r2 = await resolveTgReferralCode(555001);
    expect(r1.code).toBe(r2.code);
    expect(isValidCodeFormat(r1.code)).toBe(true);
    expect(r1.deep_link).toBe(`https://t.me/algovaultofficialbot?start=ref_${r1.code}`);
    expect(r1.deep_link).toBe(tgDeepLink(r1.code));
    expect(r1.share_url).toContain(`/signup?ref=${r1.code}`);
    expect(r1.terms.bonus_calls).toBe(REFERRAL_TERMS.BONUS_CALLS);
    // fresh referrer → zero stats
    expect(r1.stats.signups).toBe(0);
    expect(r1.stats.conversions).toBe(0);
    expect(r1.stats.accrued_usd_e2).toBe(0);
  });
});

describe('attributeTgReferral', () => {
  it('records a tg attribution + returns the SoT bonus; idempotent per referee', async () => {
    const referrer = await resolveTgReferralCode(600001);
    const first = await attributeTgReferral(referrer.code, 600002);
    expect(first.recorded).toBe(true);
    expect(first.bonus_calls).toBe(REFERRAL_TERMS.BONUS_CALLS);

    // persisted with channel='tg', keyed on the referee's tg identity
    const row = await getAttributionByEmail(tgIdentity(600002));
    expect(row?.channel).toBe('tg');
    expect(row?.code).toBe(referrer.code);

    // referrer stats reflect the signup
    expect((await referrerStats(referrer.code)).signups).toBe(1);

    // second join from the same referee → no double grant
    const dup = await attributeTgReferral(referrer.code, 600002);
    expect(dup.recorded).toBe(false);
    expect(dup.bonus_calls).toBe(0);
    expect(dup.reason).toBe('already_attributed');
  });

  it('refuses self-referral (code owner == referee)', async () => {
    const me = await resolveTgReferralCode(700001);
    const res = await attributeTgReferral(me.code, 700001);
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe('self_referral');
  });

  it('refuses invalid + unknown codes', async () => {
    const bad = await attributeTgReferral('bad!', 800002);
    expect(bad.reason).toBe('invalid_code');
    const unknown = await attributeTgReferral('ZZZZZZ', 800002); // well-formed, not minted
    expect(unknown.reason).toBe('unknown_code');
  });

  it('grants distinct referees independently under one code', async () => {
    const referrer = await resolveTgReferralCode(900001);
    expect((await attributeTgReferral(referrer.code, 900002)).recorded).toBe(true);
    expect((await attributeTgReferral(referrer.code, 900003)).recorded).toBe(true);
    expect((await referrerStats(referrer.code)).signups).toBe(2);
  });

  it('normalizes a lowercase code (bot may pass it raw)', async () => {
    const referrer = await resolveTgReferralCode(910001);
    const res = await attributeTgReferral(referrer.code.toLowerCase(), 910002);
    expect(res.recorded).toBe(true);
  });
});
