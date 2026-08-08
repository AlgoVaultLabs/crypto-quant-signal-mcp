import { describe, it, expect, beforeEach } from 'vitest';
import { getUpgradeHint, trackCall, resetLicenseCache } from '../src/lib/license.js';
// OPS-QUOTA-EXHAUSTION-NOTICE-W1: `getQuotaExhaustedMessage` was deleted (dead export — its
// last production caller moved to the shared notice). These cases now target the canonical
// builder directly, so the test exercises the string a caller actually receives.
import { buildQuotaNoticeMessage } from '../src/lib/quota-notice.js';
import type { LicenseInfo } from '../src/types.js';
import { PLANS, FREE_MONTHLY_CALLS, planCallsLabel } from '../src/lib/plans.js';

describe('getUpgradeHint', () => {
  const free: LicenseInfo = { tier: 'free', key: null };
  const starter: LicenseInfo = { tier: 'starter', key: 'av_starter_test' };
  const pro: LicenseInfo = { tier: 'pro', key: 'pro_test' };
  const enterprise: LicenseInfo = { tier: 'enterprise', key: 'ent_test' };
  const x402: LicenseInfo = { tier: 'x402', key: null };

  it('returns undefined for non-free tiers', () => {
    for (const license of [starter, pro, enterprise, x402]) {
      expect(getUpgradeHint(license, { used: 90, total: 100 })).toBeUndefined();
      expect(getUpgradeHint(license, { cappedResults: 5, totalResults: 20 })).toBeUndefined();
    }
  });

  it('returns undefined for free tier under 80% usage', () => {
    expect(getUpgradeHint(free, { used: 50, total: 100 })).toBeUndefined();
    expect(getUpgradeHint(free, { used: 79, total: 100 })).toBeUndefined();
  });

  it('returns the approved soft nudge when free tier is at 80%+ usage', () => {
    // ACTIVATION-NUDGE-W1: approved CTA copy + LIVE track-record values (the
    // deterministic fallback in tests, since no warmer runs) + upgrade_from=soft.
    const hint = getUpgradeHint(free, { used: 80, total: 100 })!;
    expect(hint).toContain("You've used 80 of your 100 free calls"); // factual used/total
    expect(hint).toContain('PFE win rate');
    expect(hint).toContain('algovault.com/track-record');           // trust→conversion lever
    expect(hint).toContain(
      `${PLANS.starter.label}, ${planCallsLabel('starter')} calls/mo `
      + `(${Math.round(PLANS.starter.monthlyCalls / FREE_MONTHLY_CALLS)}× the free tier)`,
    );
    expect(hint).toContain('$9.99');
    expect(hint).toContain('signup?plan=starter&upgrade_from=soft'); // primary funnel attribution
    expect(hint).not.toContain('unlimited');                         // copy-rule: no "unlimited"
  });

  it('renders the live per-request usage (factual, not the illustrative 80)', () => {
    const hint = getUpgradeHint(free, { used: 95, total: 100 })!;
    expect(hint).toContain("You've used 95 of your 100 free calls");
    expect(hint).not.toContain('80 of your 100');
  });

  it('returns undefined at 100% usage (handled by quota block)', () => {
    expect(getUpgradeHint(free, { used: 100, total: 100 })).toBeUndefined();
  });

  it('returns capped results hint when funding arb is limited', () => {
    const hint = getUpgradeHint(free, { cappedResults: 5, totalResults: 12 });
    expect(hint).toContain('top 5 of 12');
    expect(hint).toContain('Starter');
    expect(hint).toContain('$9.99/mo');
  });

  it('returns undefined when results are not capped', () => {
    expect(getUpgradeHint(free, { cappedResults: 5, totalResults: 3 })).toBeUndefined();
    expect(getUpgradeHint(free, { cappedResults: 5, totalResults: 5 })).toBeUndefined();
  });

  it('capped results hint takes priority over quota hint', () => {
    const hint = getUpgradeHint(free, {
      cappedResults: 5,
      totalResults: 20,
      used: 85,
      total: 100,
    });
    expect(hint).toContain('top 5 of 20');
    expect(hint).not.toContain('85/100');
  });

  it('returns undefined with no context', () => {
    expect(getUpgradeHint(free)).toBeUndefined();
    expect(getUpgradeHint(free, {})).toBeUndefined();
  });
});

describe('the free-tier exhaustion notice (buildQuotaNoticeMessage)', () => {
  // A fixed reset instant + clock: the notice must state a DATE, and a hardcoded interval
  // would pass a "contains 30 days" assertion while being wrong for every real caller.
  const RESET_AT = Date.parse('2026-08-24T09:13:22.000Z');
  const NOW = Date.parse('2026-08-02T09:13:22.000Z'); // exactly 22 days earlier

  it('KEYLESS → usage, a live reset date, the subscription arm and the get-your-link path', () => {
    const msg = buildQuotaNoticeMessage({
      meter: 'calls', used: 100, limit: 100, resetAtMs: RESET_AT, nowMs: NOW, referralCode: null,
    });
    expect(msg).toContain('Free monthly quota used: 100/100');
    expect(msg).toContain('Access returns 2026-08-24 (22 days)');
    expect(msg).toContain('Starter');
    expect(msg).toContain('signup?plan=starter&upgrade_from=limit');
    expect(msg).toContain('Create your free account for a referral link'); // keyless path
    expect(msg.toLowerCase()).toContain('refer a friend');
    expect(msg).not.toContain('unlimited');
  });

  it("KEYED → renders the user's own give-get link", () => {
    const msg = buildQuotaNoticeMessage({
      meter: 'calls', used: 100, limit: 100, resetAtMs: RESET_AT, nowMs: NOW, referralCode: 'ABCD1234',
    });
    expect(msg).toContain('Your link: algovault.com/join?ref=ABCD1234');
    expect(msg).not.toContain('Create your free account');
  });
});
