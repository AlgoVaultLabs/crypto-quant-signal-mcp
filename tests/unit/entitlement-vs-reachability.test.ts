/**
 * OPS-REACHABILITY-AND-XREPO-INSTALL-W1 CH1 — one Stripe lookup, two questions, kept apart.
 *
 * `getCustomerByApiKey` answers ENTITLEMENT ("may this key act?") and must stay active-only:
 * `referral-accrual` credits a real Stripe balance off it, so widening it silently changes who
 * gets paid. `resolveCustomerByApiKey` answers RESOLUTION ("who is this, and what is their
 * billing state?") and applies no filter at all.
 *
 * Both are derived from ONE search + ONE list, so they can never disagree about the same
 * customer — the single-derivation rule. These tests pin the split in both directions, because
 * the failure modes are opposite and both are silent: widen entitlement and a churned referrer
 * gets paid; narrow resolution and a paying customer stops being contactable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const search = vi.fn();
const list = vi.fn();
vi.mock('stripe', () => ({
  default: class { customers = { search }; subscriptions = { list }; },
}));

const CUS = { id: 'cus_UuBrP1otU51OBm', deleted: false, email: 'x@y.com', metadata: { tier: 'starter' } };
const sub = (status: string) => ({ id: `sub_${status}`, status });

async function load() {
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  return import('../../src/lib/stripe.js');
}

beforeEach(() => { search.mockReset(); list.mockReset(); });

describe('resolveCustomerByApiKey — resolution, no entitlement filter', () => {
  it('a past_due customer RESOLVES, with their email and their real status', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('past_due')] });
    const m = await load();
    const r = await m.resolveCustomerByApiKey('av_live_x');
    expect(r).toEqual({
      customerId: 'cus_UuBrP1otU51OBm', tier: 'starter', email: 'x@y.com',
      subscriptionStatus: 'past_due', hasActiveSubscription: false,
    });
  });

  it('a customer with NO subscription at all still resolves (status null)', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [] });
    const m = await load();
    const r = await m.resolveCustomerByApiKey('av_live_x');
    expect(r?.subscriptionStatus).toBeNull();
    expect(r?.hasActiveSubscription).toBe(false);
    expect(r?.email).toBe('x@y.com');
  });

  it('an ACTIVE subscription wins over a newer non-active one', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('canceled'), sub('active')] });
    const m = await load();
    const r = await m.resolveCustomerByApiKey('av_live_x');
    expect([r?.subscriptionStatus, r?.hasActiveSubscription]).toEqual(['active', true]);
  });

  it('a DELETED customer resolves to null — nothing to email, nothing to manage', async () => {
    search.mockResolvedValue({ data: [{ ...CUS, deleted: true }] });
    const m = await load();
    expect(await m.resolveCustomerByApiKey('av_live_x')).toBeNull();
  });

  it('no match, a malformed key, and a Stripe throw are all null and never throw', async () => {
    const m = await load();
    search.mockResolvedValue({ data: [] });
    expect(await m.resolveCustomerByApiKey('av_live_x')).toBeNull();
    expect(await m.resolveCustomerByApiKey("av'; DROP--")).toBeNull();
    search.mockRejectedValue(new Error('stripe down'));
    await expect(m.resolveCustomerByApiKey('av_live_x')).resolves.toBeNull();
  });

  it('ONE list call, and it asks for ALL statuses — not `active`', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('past_due')] });
    const m = await load();
    await m.resolveCustomerByApiKey('av_live_x');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0].status).toBe('all');
  });
});

describe('🛑 getCustomerByApiKey — entitlement, and it did NOT widen', () => {
  it('past_due is still null (a churned referrer must not be credited)', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('past_due')] });
    const m = await load();
    expect(await m.getCustomerByApiKey('av_live_x')).toBeNull();
  });

  for (const status of ['unpaid', 'canceled', 'incomplete', 'paused']) {
    it(`"${status}" is still null`, async () => {
      search.mockResolvedValue({ data: [CUS] });
      list.mockResolvedValue({ data: [sub(status)] });
      const m = await load();
      expect(await m.getCustomerByApiKey('av_live_x')).toBeNull();
    });
  }

  it('active still returns the SAME shape it always did — no extra fields leak out', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('active')] });
    const m = await load();
    expect(await m.getCustomerByApiKey('av_live_x'))
      .toEqual({ customerId: 'cus_UuBrP1otU51OBm', tier: 'starter', email: 'x@y.com' });
  });

  it('the two answers are DERIVED from one lookup, so they cannot disagree', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('past_due')] });
    const m = await load();
    const [resolved, entitled] = [await m.resolveCustomerByApiKey('av_live_x'),
                                  await m.getCustomerByApiKey('av_live_x')];
    expect(resolved?.hasActiveSubscription).toBe(false);
    expect(entitled).toBeNull();
    expect(search).toHaveBeenCalledTimes(2); // one search per call, not one shared cache
  });
});
