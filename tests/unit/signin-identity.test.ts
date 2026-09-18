/**
 * FUNNEL-FIX-SIGNIN-PAID-IDENTITY-W1 / CH1 — the ONE sign-in identity derivation.
 *
 * Measured defect this locks out (customer `cus_UepUXyDjxzx99c`, 2026-07-17):
 * a paying customer signed in at 19:31:17 UTC and every sign-in surface called
 * `mintFreeKey(email)` unconditionally, so she was handed an `av_free_` key
 * 27 minutes before her $49 upgrade invoice at 19:58:07. Pasting that key into
 * `/account` returns "Invalid API key" — `resolveCustomerByApiKey` cannot resolve
 * a free key — which is what she reported as "you took away the account login to
 * cancel my subscription". The login was never removed; she held the wrong key.
 *
 * The three outcomes below are the whole contract. INDETERMINATE is not a
 * rounding error on FREE: minting during a Stripe outage is precisely how a
 * paying human acquires a shadow free identity, so it mints NOTHING.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveCustomerByEmail = vi.fn();
const mintFreeKey = vi.fn();

vi.mock('../../src/lib/stripe.js', () => ({ resolveCustomerByEmail }));
vi.mock('../../src/lib/free-keys-store.js', () => ({ mintFreeKey }));

const { resolveSigninIdentity } = await import('../../src/lib/signin-identity.js');

const PAID_KEY = `av_live_${'a'.repeat(24)}`;
const FREE_KEY = `av_free_${'b'.repeat(24)}`;
const EMAIL = 'paid@example.com';

beforeEach(() => {
  resolveCustomerByEmail.mockReset();
  mintFreeKey.mockReset();
  mintFreeKey.mockResolvedValue(FREE_KEY);
});

describe('resolveSigninIdentity', () => {
  it('PAID: an email with a resolvable Stripe customer returns THEIR live key and mints nothing', async () => {
    resolveCustomerByEmail.mockResolvedValue({
      outcome: 'RESOLVED',
      apiKey: PAID_KEY,
      customer: { customerId: 'cus_X', tier: 'pro', email: EMAIL, subscriptionStatus: 'active', hasActiveSubscription: true },
    });

    const id = await resolveSigninIdentity(EMAIL);

    expect(id.outcome).toBe('PAID');
    expect(id.key).toBe(PAID_KEY);
    expect(id.tier).toBe('pro');
    expect(id.customerId).toBe('cus_X');
    expect(id.subscriptionStatus).toBe('active');
    // THE regression this file exists for.
    expect(mintFreeKey).not.toHaveBeenCalled();
  });

  it('PAID: a past_due customer still gets their live key — a failed card is the reason to reach billing, not a bar to it', async () => {
    resolveCustomerByEmail.mockResolvedValue({
      outcome: 'RESOLVED',
      apiKey: PAID_KEY,
      customer: { customerId: 'cus_Y', tier: 'starter', email: EMAIL, subscriptionStatus: 'past_due', hasActiveSubscription: false },
    });

    const id = await resolveSigninIdentity(EMAIL);

    expect(id.outcome).toBe('PAID');
    expect(id.key).toBe(PAID_KEY);
    expect(id.subscriptionStatus).toBe('past_due');
    expect(mintFreeKey).not.toHaveBeenCalled();
  });

  it('FREE: no Stripe customer → mints (idempotently) and reports the free tier', async () => {
    resolveCustomerByEmail.mockResolvedValue({ outcome: 'NOT_FOUND' });

    const id = await resolveSigninIdentity('new@example.com', 'REFCODE1');

    expect(id.outcome).toBe('FREE');
    expect(id.key).toBe(FREE_KEY);
    expect(id.tier).toBe('free');
    expect(id.customerId).toBeNull();
    expect(mintFreeKey).toHaveBeenCalledWith('new@example.com', 'REFCODE1');
  });

  it('INDETERMINATE: a Stripe outage mints NOTHING and hands back no key', async () => {
    resolveCustomerByEmail.mockResolvedValue({ outcome: 'INDETERMINATE' });

    const id = await resolveSigninIdentity(EMAIL);

    expect(id.outcome).toBe('INDETERMINATE');
    expect(id.key).toBeNull();
    expect(id.tier).toBeNull();
    // Minting here is how a paying human acquires a shadow free identity.
    expect(mintFreeKey).not.toHaveBeenCalled();
  });

  it('a resolver THROW is INDETERMINATE, never a silent demotion to FREE', async () => {
    resolveCustomerByEmail.mockRejectedValue(new Error('stripe down'));

    const id = await resolveSigninIdentity(EMAIL);

    expect(id.outcome).toBe('INDETERMINATE');
    expect(id.key).toBeNull();
    expect(mintFreeKey).not.toHaveBeenCalled();
  });

  it('the email is lower-cased once, here, so every surface projects the same identity', async () => {
    resolveCustomerByEmail.mockResolvedValue({ outcome: 'NOT_FOUND' });

    await resolveSigninIdentity('  MiXeD@Example.COM  ');

    expect(resolveCustomerByEmail).toHaveBeenCalledWith('mixed@example.com');
    expect(mintFreeKey).toHaveBeenCalledWith('mixed@example.com', null);
  });
});
