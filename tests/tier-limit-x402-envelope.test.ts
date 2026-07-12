/**
 * FUNNEL-FIX-AGENT-X402-NUDGE-W1 — the allow-listed tier-limit envelope formatter.
 *
 * `buildTierLimitPayload` is the EXPORTED allow-list serializer (extracted from the inline
 * index.ts handler per the CLAUDE.md public-shape rule + AC3) that projects a
 * TierLimitReachedError to its wire shape, with `suggested_x402` as an ADDITIVE, allow-listed
 * sibling to the intact Stripe/referral fields. Omitted entirely when not provided ⇒ the
 * envelope is BYTE-IDENTICAL to today (the X402_NUDGE_ENABLED-off contract, AC3).
 */
import { describe, it, expect } from 'vitest';
import { TierLimitReachedError, buildTierLimitPayload } from '../src/lib/errors.js';
import type { SuggestedX402 } from '../src/types.js';

function mkErr() {
  return new TierLimitReachedError({
    currentUsage: 100,
    monthlyLimit: 100,
    tier: 'free',
    suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
    retryAfterDays: 12,
    referralCode: null,
    tool: 'get_trade_call',
  });
}

const SAMPLE_SX: SuggestedX402 = {
  tool: 'get_trade_call',
  instructions: 'pay per call',
  primary: { rail: 'x402_bazaar', label: 'CDP x402 Bazaar (Base/USDC)', method: 'POST', url: 'https://api.algovault.com/x402/get_trade_call', network: 'eip155:8453', asset: 'USDC', price_usd: 0.02, scheme: 'exact' },
  alternatives: [],
};

describe('buildTierLimitPayload', () => {
  it('omits suggested_x402 entirely when not provided (byte-identical to today, AC3)', () => {
    const p = buildTierLimitPayload(mkErr());
    expect(p.code).toBe('TIER_LIMIT_REACHED');
    expect(p.error_code).toBe('TIER_LIMIT_REACHED');
    expect(p.current_usage).toBe(100);
    expect(p.monthly_limit).toBe(100);
    expect(p.tier).toBe('free');
    expect(p.suggested_upgrade_url).toContain('upgrade_from=limit');
    expect(p.retry_after_days).toBe(12);
    expect(p.referral_hint).toBeDefined();
    expect('suggested_x402' in p).toBe(false);
    // the exact key set of today's envelope (order-preserving JSON)
    expect(Object.keys(p)).toEqual([
      'code', 'error_code', 'message', 'current_usage', 'monthly_limit',
      'tier', 'suggested_upgrade_url', 'retry_after_days', 'referral_hint',
    ]);
  });

  it('adds suggested_x402 as an additive last sibling when provided; Stripe/referral intact', () => {
    const p = buildTierLimitPayload(mkErr(), { suggestedX402: SAMPLE_SX });
    expect(p.suggested_x402).toEqual(SAMPLE_SX);
    expect(p.suggested_upgrade_url).toContain('upgrade_from=limit'); // Stripe path intact
    expect(p.referral_hint).toBeDefined(); // referral intact
    expect(Object.keys(p)[Object.keys(p).length - 1]).toBe('suggested_x402'); // additive last
  });
});
