/**
 * SECURITY-FIX-TIER-ESCALATION-W1 — permanent CI canary.
 *
 * A Stripe-INVALID API key on the HTTP/Stripe path (resolveFromApiKeyAsync) must
 * DEFAULT-DENY to least privilege (free), NEVER escalate via prefix detection.
 * Re-introducing the unconditional `return resolveFromApiKey(authHeader)` fallback
 * turns the three no-flag cases below RED.
 *
 * The prefix shortcut survives only behind the explicit, dev-only, default-OFF
 * flag ALLOW_DEV_KEY_PREFIX. The stdio path (resolveLicenseSync → resolveFromApiKey)
 * is deliberately UNCHANGED — operators tier their own CQS_API_KEY locally.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Stripe returns invalid by default (configurable per-test); x402 unconfigured so
// resolveLicense flows straight to the API-key path.
vi.mock('../src/lib/stripe.js', () => ({ validateApiKey: vi.fn() }));
vi.mock('../src/lib/x402.js', () => ({
  isX402Configured: () => false,
  verifyX402Payment: async () => ({ valid: false }),
  paymentMatchesToolRoute: () => false,
  classifyToolRouteMismatch: () => 'cross_tool',
}));

import { resolveLicense, resolveLicenseSync } from '../src/lib/license.js';
import { validateApiKey } from '../src/lib/stripe.js';

const mockValidate = vi.mocked(validateApiKey);

beforeEach(() => {
  mockValidate.mockReset();
  mockValidate.mockResolvedValue({ valid: false }); // Stripe-invalid by default
  delete process.env.ALLOW_DEV_KEY_PREFIX;
  delete process.env.CQS_API_KEY;                   // else extractApiKey prefers env over the header
  delete process.env.BOT_INTERNAL_BYPASS_ENABLED;
});

afterEach(() => {
  delete process.env.ALLOW_DEV_KEY_PREFIX;
});

describe('SECURITY-FIX-TIER-ESCALATION-W1 — Stripe-invalid key default-denies to free (no flag)', () => {
  // AUTH-THREE-STATE-W1 CH1 amended these three. The INTENT is unchanged and is the reason the
  // describe text above is preserved verbatim: a forged key must never ESCALATE. What changed is
  // that "free" is no longer the only thing the license can say. All three forged strings fail
  // AV_KEY_SHAPE, so they are MALFORMED — served, exactly as before, and never refusable, which is
  // what keeps the documented unexpanded-`${env:AV_API_KEY}` client lane working. The tier and key
  // assertions are kept, not replaced: they are the anti-escalation guarantee itself.
  it('Bearer ent_forged → free (NOT enterprise)', async () => {
    const { license } = await resolveLicense({ authorization: 'Bearer ent_forged' });
    expect(license.tier).toBe('free');
    expect(license.key).toBeNull();
    expect(license.outcome).toBe('MALFORMED');
  });

  it('Bearer av_starter_x → free (NOT starter)', async () => {
    const { license } = await resolveLicense({ authorization: 'Bearer av_starter_x' });
    expect(license.tier).toBe('free');
    expect(license.key).toBeNull();
    expect(license.outcome).toBe('MALFORMED');
  });

  it('Bearer randomjunk → free (NOT pro)', async () => {
    const { license } = await resolveLicense({ authorization: 'Bearer randomjunk' });
    expect(license.tier).toBe('free');
    expect(license.key).toBeNull();
    expect(license.outcome).toBe('MALFORMED');
  });

  // AUTH-THREE-STATE-W1 CH1: the fourth case this file could not previously express. A key with
  // the RIGHT shape that Stripe does not know is a different fact from a forged one — it is the
  // paying customer whose key is typo'd, revoked, or from the wrong environment. Before this wave
  // it resolved to the same object as `ent_forged` and was served the anonymous free tier.
  it('Bearer av_live_<24 hex> that Stripe does not know → free, but UNKNOWN (not MALFORMED)', async () => {
    const { license } = await resolveLicense({ authorization: `Bearer av_live_${'0'.repeat(24)}` });
    expect(license.tier).toBe('free');
    expect(license.key).toBeNull();
    expect(license.outcome).toBe('UNKNOWN');
  });
});

describe('SECURITY-FIX-TIER-ESCALATION-W1 — ALLOW_DEV_KEY_PREFIX=true keeps the dev escape hatch', () => {
  beforeEach(() => { process.env.ALLOW_DEV_KEY_PREFIX = 'true'; });

  it('ent_ → enterprise', async () => {
    const { license } = await resolveLicense({ authorization: 'Bearer ent_dev' });
    expect(license.tier).toBe('enterprise');
  });

  it('av_starter_ → starter', async () => {
    const { license } = await resolveLicense({ authorization: 'Bearer av_starter_dev' });
    expect(license.tier).toBe('starter');
  });

  it('other → pro', async () => {
    const { license } = await resolveLicense({ authorization: 'Bearer somekey' });
    expect(license.tier).toBe('pro');
  });
});

describe('SECURITY-FIX-TIER-ESCALATION-W1 — regression guards (fix must not touch these paths)', () => {
  it('Stripe-VALID key still returns its Stripe tier (happy path untouched)', async () => {
    mockValidate.mockResolvedValue({ valid: true, tier: 'pro' });
    const { license } = await resolveLicense({ authorization: 'Bearer av_live_realcustomer' });
    expect(license.tier).toBe('pro');
    expect(license.key).toBe('av_live_realcustomer');
  });

  it('stdio path (resolveLicenseSync) STILL tiers by prefix — ent_x → enterprise', () => {
    const license = resolveLicenseSync({ authorization: 'Bearer ent_x' });
    expect(license.tier).toBe('enterprise');
  });
});
