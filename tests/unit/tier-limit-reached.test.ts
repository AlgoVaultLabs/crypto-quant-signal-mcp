/**
 * Unit test for TierLimitReachedError (ACTIVATION-PAYWALL-W1 / R3).
 *
 * Asserts the structured-error envelope shape that fires when a free-tier
 * caller exceeds the in-process monthly quota counter (license.ts:checkQuota
 * returns allowed:false at >=100 calls/month).
 */
import { describe, expect, it } from 'vitest';
import { TierLimitReachedError } from '../../src/lib/errors.js';
import { PLANS, planCallsLabel } from '../../src/lib/plans.js';

// OPS-QUOTA-EXHAUSTION-NOTICE-W1: `retryAfterDays` is no longer passed alongside the reset
// instant — it is DERIVED from it, so the two cannot disagree. These helpers keep every
// pre-existing day-count assertion intact by turning "N days" into a real instant against a
// frozen clock, which also proves the date is computed rather than hardcoded.
const NOW = Date.parse('2026-08-02T00:00:00.000Z');
const inDays = (n: number) => NOW + n * 24 * 60 * 60 * 1000;

describe('TierLimitReachedError', () => {
  it('exposes the canonical code TIER_LIMIT_REACHED', () => {
    const err = new TierLimitReachedError({
      currentUsage: 100,
      monthlyLimit: 100,
      tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      resetAtMs: inDays(7), nowMs: NOW,
    });
    expect(err.code).toBe('TIER_LIMIT_REACHED');
  });

  it('persists the structured fields (+ appends upgrade_from=limit when absent, A2)', () => {
    const err = new TierLimitReachedError({
      currentUsage: 105,
      monthlyLimit: 100,
      tier: 'free',
      suggestedUpgradeUrl: 'https://example.com/upgrade',
      resetAtMs: inDays(12), nowMs: NOW,
    });
    expect(err.current_usage).toBe(105);
    expect(err.monthly_limit).toBe(100);
    expect(err.tier).toBe('free');
    // ACTIVATION-NUDGE-W1: funnel-attribution param added to the structured field.
    expect(err.suggested_upgrade_url).toBe('https://example.com/upgrade?upgrade_from=limit');
    expect(err.retry_after_days).toBe(12);
    // Derived from the SAME instant, never a second passed-in number.
    expect(err.resets_at).toBe('2026-08-14T00:00:00.000Z');
  });

  it('builds the referral-prominent + upgrade-retained .message (REFERRAL-INPRODUCT-NUDGE-W1)', () => {
    // KEYLESS (no referralCode) → the get-your-link free-signup path leads, upgrade
    // retained beneath. No "unlimited". The bare upgrade_from=limit URL is embedded.
    const err = new TierLimitReachedError({
      currentUsage: 100,
      monthlyLimit: 100,
      tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
      resetAtMs: inDays(5), nowMs: NOW,
    });
    expect(err.message).toContain('Free monthly quota used: 100/100');
    expect(err.message).toContain('Access returns 2026-08-07 (5 days)');
    expect(err.message.toLowerCase()).toContain('refer a friend');
    expect(err.message).toContain('500 bonus calls');
    expect(err.message).toContain('Create your free account for a referral link'); // keyless path
    expect(err.message).toContain(`${PLANS.starter.label} — ${planCallsLabel('starter')} calls/month`); // upgrade retained
    expect(err.message).toContain('signup?plan=starter&upgrade_from=limit');
    expect(err.message).not.toContain('unlimited');
    // The dollar figure is deliberately NOT inlined — the notice links to the plan page so a
    // price change cannot leave stale copy on the highest-intent surface the product has.
    expect(err.message).not.toContain('$9.99');
  });

  it('KEYED message renders the user\'s own give-get link (state-adaptive)', () => {
    const err = new TierLimitReachedError({
      currentUsage: 100,
      monthlyLimit: 100,
      tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
      resetAtMs: inDays(5), nowMs: NOW,
      referralCode: 'ABCD1234',
    });
    expect(err.message).toContain('Your link: algovault.com/join?ref=ABCD1234');
    expect(err.message).not.toContain('Create your free account'); // keyed → not the keyless path
  });

  it('carries the allow-listed structured referral_hint (from: limit; keyed→link, keyless→path)', () => {
    const keyed = new TierLimitReachedError({
      currentUsage: 100, monthlyLimit: 100, tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
      resetAtMs: inDays(5), nowMs: NOW, referralCode: 'ABCD1234',
    });
    expect(keyed.referral_hint.from).toBe('limit');
    expect(keyed.referral_hint.link_or_path).toBe('https://algovault.com/join?ref=ABCD1234');
    expect(keyed.referral_hint.bonus_calls).toBe(500);
    expect(Object.keys(keyed.referral_hint).sort()).toEqual(['bonus_calls', 'cta', 'from', 'link_or_path']);

    const keyless = new TierLimitReachedError({
      currentUsage: 100, monthlyLimit: 100, tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
      resetAtMs: inDays(5), nowMs: NOW, // no referralCode
    });
    expect(keyless.referral_hint.link_or_path).toBe('https://api.algovault.com/signup?upgrade_from=limit_referral');
    // no outcome_* leak in the structured hint
    expect(JSON.stringify(keyed.referral_hint)).not.toContain('outcome_');
  });

  it('is instance-of Error AND TierLimitReachedError (prototype chain preserved across CJS transpile)', () => {
    const err = new TierLimitReachedError({
      currentUsage: 100,
      monthlyLimit: 100,
      tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup',
      resetAtMs: inDays(7), nowMs: NOW,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TierLimitReachedError);
  });

  it('UTM tags are present in the canonical suggested_upgrade_url', () => {
    const err = new TierLimitReachedError({
      currentUsage: 100,
      monthlyLimit: 100,
      tier: 'free',
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      resetAtMs: inDays(7), nowMs: NOW,
    });
    expect(err.suggested_upgrade_url).toContain('utm_source=mcp_tool');
    expect(err.suggested_upgrade_url).toContain('utm_campaign=tier_limit_reached');
  });
});
