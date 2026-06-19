/**
 * REFERRAL-LIGHT-W1 / C2 — bonus-aware quota meter + av_free_ resolution.
 *
 * Determinism: every test uses a UNIQUE tracker key so the module-level
 * callTrackers + bonusRemaining maps never bleed (mirrors license-units.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Spy on Stripe validateApiKey to PROVE av_free_ resolution never calls Stripe.
// vi.hoisted so the spy exists when the (hoisted) vi.mock factory runs.
const { validateSpy } = vi.hoisted(() => ({
  validateSpy: vi.fn(async (_key: string) => ({ valid: false, tier: null as string | null })),
}));
vi.mock('../../src/lib/stripe.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/stripe.js')>();
  return { ...actual, validateApiKey: validateSpy };
});

import {
  resolveLicense,
  resolveLicenseSync,
  trackCall,
  trackCallByKey,
  checkQuota,
  getMonthlyQuota,
  getBonusForKey,
  grantReferralBonus,
} from '../../src/lib/license.js';
import { ensureReferralSchema, getBonusRemaining } from '../../src/lib/referral-store.js';
import { mintFreeKey, ensureFreeKeysSchema, _resetFreeKeyCacheForTest } from '../../src/lib/free-keys-store.js';
import { dbRun } from '../../src/lib/performance-db.js';
import type { LicenseInfo } from '../../src/types.js';

beforeEach(() => {
  ensureReferralSchema();
  ensureFreeKeysSchema();
  for (const t of ['referral_bonus', 'free_keys', 'quota_usage']) dbRun(`DELETE FROM ${t}`);
  _resetFreeKeyCacheForTest();
  validateSpy.mockClear();
});

const FREE_QUOTA = getMonthlyQuota('free'); // 100
const freeKey = (k: string): LicenseInfo => ({ tier: 'free', key: k });

describe('av_free_ resolution never queries Stripe', () => {
  it('async resolveLicense → free + key for a known av_free_ key (no Stripe call)', async () => {
    const k = await mintFreeKey('res@x.com', 'RC');
    const { license } = await resolveLicense({ authorization: `Bearer ${k}` });
    expect(license.tier).toBe('free');
    expect(license.key).toBe(k);
    expect(validateSpy).not.toHaveBeenCalled();
  });
  it('sync resolveLicenseSync → free (NOT prefix-pro escalation)', async () => {
    const k = await mintFreeKey('sync@x.com'); // mint warms the cache
    const license = resolveLicenseSync({ authorization: `Bearer ${k}` });
    expect(license.tier).toBe('free');
    expect(license.key).toBe(k);
  });
  it('unknown av_free_ key → keyless free (async), no Stripe call', async () => {
    const { license } = await resolveLicense({ authorization: `Bearer av_free_${'0'.repeat(24)}` });
    expect(license.tier).toBe('free');
    expect(license.key).toBeNull();
    expect(validateSpy).not.toHaveBeenCalled();
  });
});

describe('bonus-aware meter — monthly then bonus', () => {
  it('multi-unit boundary: 3 monthly left + 8-unit scan, bonus 500 → 3 monthly + 5 bonus', async () => {
    const k = `av_free_${'a'.repeat(24)}`;
    await grantReferralBonus(k, 500, 'RCODE');
    const lic = freeKey(k);
    const r1 = trackCall(lic, FREE_QUOTA - 3); // burn 97 of 100 in one batch
    expect(r1.allowed).toBe(true);
    expect(r1.used).toBe(FREE_QUOTA - 3);
    const r2 = trackCall(lic, 8); // 3 monthly + 5 bonus
    expect(r2.allowed).toBe(true);
    expect(r2.used).toBe(FREE_QUOTA); // monthly capped at 100
    expect(r2.bonus_remaining).toBe(495);
    expect(getBonusForKey(k)).toBe(495);
  });

  it('write-through: referral_store sees the decrement (in-memory ↔ DB sync)', async () => {
    const k = `av_free_${'b'.repeat(24)}`;
    await grantReferralBonus(k, 10);
    const lic = freeKey(k);
    trackCall(lic, FREE_QUOTA); // exhaust monthly exactly
    const r = trackCall(lic, 4); // 4 overflow → bonus 10→6
    expect(r.allowed).toBe(true);
    expect(r.bonus_remaining).toBe(6);
    expect(await getBonusRemaining(k)).toBe(6); // DB write-through
  });

  it('bonus exhaustion is atomic (all-or-nothing) → allowed:false', async () => {
    const k = `av_free_${'c'.repeat(24)}`;
    await grantReferralBonus(k, 2);
    const lic = freeKey(k);
    trackCall(lic, FREE_QUOTA); // exhaust monthly
    const r = trackCall(lic, 5); // needs 5 bonus, only 2 → blocked, bonus untouched
    expect(r.allowed).toBe(false);
    expect(getBonusForKey(k)).toBe(2);
    const r2 = trackCall(lic, 2); // fits exactly → allowed, drains to 0
    expect(r2.allowed).toBe(true);
    expect(getBonusForKey(k)).toBe(0);
  });

  it('single-unit calls drain bonus one at a time after monthly exhaustion', async () => {
    const k = `av_free_${'d'.repeat(24)}`;
    await grantReferralBonus(k, 2);
    const lic = freeKey(k);
    trackCall(lic, FREE_QUOTA);
    expect(trackCall(lic, 1).allowed).toBe(true); // 2→1
    expect(trackCall(lic, 1).allowed).toBe(true); // 1→0
    expect(trackCall(lic, 1).allowed).toBe(false); // 0 → blocked
  });
});

describe('keyless free is byte-identical (no bonus lane)', () => {
  it('blocks at quota with no bonus_remaining field', () => {
    const r1 = trackCallByKey('free:keyless-bonus-test-1', 'free', FREE_QUOTA);
    expect(r1.allowed).toBe(true);
    const r2 = trackCallByKey('free:keyless-bonus-test-1', 'free', 1);
    expect(r2.allowed).toBe(false);
    expect(r2.bonus_remaining).toBeUndefined();
  });
});

describe('checkQuota is bonus-aware (read-only gate)', () => {
  it('allows a bonus-holding free user past monthly exhaustion', async () => {
    const k = `av_free_${'e'.repeat(24)}`;
    await grantReferralBonus(k, 50);
    const lic = freeKey(k);
    trackCall(lic, FREE_QUOTA); // exhaust monthly
    const c = checkQuota(lic);
    expect(c.allowed).toBe(true);
    expect(c.bonus_remaining).toBe(50);
  });
});
