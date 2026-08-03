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

// OPS-QUOTA-EXHAUSTION-NOTICE-W1: `retry_after_days` is DERIVED from the reset instant, so the
// fixture pins a frozen clock 12 days before the reset instead of passing the day count directly.
const NOW = Date.parse('2026-08-02T00:00:00.000Z');
const RESET_AT = NOW + 12 * 24 * 60 * 60 * 1000;

function mkErr() {
  return new TierLimitReachedError({
    currentUsage: 100,
    monthlyLimit: 100,
    tier: 'free',
    suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
    resetAtMs: RESET_AT,
    nowMs: NOW,
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
    // OPS-QUOTA-EXHAUSTION-NOTICE-W1 grew the envelope by four ADDITIVE notice fields. Every
    // pre-existing key keeps its name, value and relative order — an existing consumer reading
    // `retry_after_days` or `referral_hint` is untouched.
    expect(Object.keys(p)).toEqual([
      'code', 'error_code', 'message', 'current_usage', 'monthly_limit',
      'tier', 'suggested_upgrade_url', 'retry_after_days',
      'resets_at', 'usage_display', 'recommended_path', 'suggested_action',
      'referral_hint',
    ]);
    expect(p.resets_at).toBe('2026-08-14T00:00:00.000Z');
    expect(p.usage_display).toBe('100/100');
    // No live rail was passed ⇒ nothing to compare ⇒ the subscription leads, and the prose
    // must NOT name x402 (the pre-wave scan copy advertised it unconditionally).
    expect(p.recommended_path).toBe('subscription');
    expect(p.message).not.toContain('x402');
    expect(p.suggested_action).not.toContain('x402');
  });

  it('adds suggested_x402 as an additive last sibling when provided; Stripe/referral intact', () => {
    const p = buildTierLimitPayload(mkErr(), { suggestedX402: SAMPLE_SX });
    expect(p.suggested_x402).toEqual(SAMPLE_SX);
    expect(p.suggested_upgrade_url).toContain('upgrade_from=limit'); // Stripe path intact
    expect(p.referral_hint).toBeDefined(); // referral intact
    expect(Object.keys(p)[Object.keys(p).length - 1]).toBe('suggested_x402'); // additive last
    // With a LIVE rail the prose names it — and names it at the SoT price, never a literal.
    expect(p.message).toContain('https://api.algovault.com/x402/get_trade_call');
    expect(p.message).toContain('$0.02');
    expect(p.suggested_action).toContain('x402');
  });
});

/**
 * OPS-AUDIT-REMEDIATION-LOW-W2 wave-close. The suite above was failing on `main` — not from any
 * wave's change, but because `noticeContext()` dropped `nowMs`, so `buildTierLimitPayload`
 * re-derived `retry_after_days` from `Date.now()` while the constructor used the injected clock.
 * The two derivations agreed only while the real date sat inside the frozen window, which is why
 * it looked like a date-dependent flake. It was a SINGLE-DERIVATION violation with a clock in it.
 */
describe('single-derivation: the error and its wire payload read ONE clock', () => {
  it('buildTierLimitPayload honours the injected clock, not Date.now()', () => {
    const err = mkErr();
    const p = buildTierLimitPayload(err);
    expect(p.retry_after_days, 'the payload must not re-derive from the live clock').toBe(err.retry_after_days);
    expect(p.resets_at).toBe(err.resets_at);
  });

  it('is stable no matter what day the suite runs on', () => {
    // The frozen NOW is 12 days before RESET_AT, so this is 12 forever — the assertion that was
    // silently drifting with the wall clock before the fix.
    expect(buildTierLimitPayload(mkErr()).retry_after_days).toBe(12);
  });
});
