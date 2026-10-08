/**
 * REVENUE-DUNNING-BOUND-W1-V2 CH3 — DUNNING ends when Stripe stops collecting.
 *
 * `past_due` is a label whose LIFETIME the Stripe Dashboard owns. Under "Leave the subscription
 * past-due" it never ends: measured 2026-10-08, three subscriptions had an open invoice at
 * attempt 9 with `next_payment_attempt: null` — Stripe had stopped trying — and one of them was
 * still being served 253 Telegram alerts a day as DUNNING. The leg keys entitlement on the
 * COLLECTION state instead: DUNNING only while every open invoice of the subscription still has a
 * scheduled retry; any exhausted one → NOT_ENTITLED(`dunning_exhausted`).
 *
 * Two views, two caches (ruling Q-C). `/mcp` already treats DUNNING and NOT_ENTITLED identically
 * (`license.ts`), so it keeps the status-only view and pays no invoice call. The bot edge —
 * validate-key and /api/entitlement/{consume,state} — asks with `{ collection: true }`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.fn();
const list = vi.fn();
const invoicesList = vi.fn();
vi.mock('stripe', () => ({
  default: class {
    customers = { search };
    subscriptions = { list };
    invoices = { list: invoicesList };
  },
}));

const STARTER = 'price_rdb_test_starter';
const PRO = 'price_rdb_test_pro';
const CUS = { id: 'cus_rdb_test', deleted: false, metadata: { tier: 'starter' } };
const sub = (id: string, status: string, price = STARTER) => ({
  id,
  status,
  items: { data: [{ price: { id: price } }] },
});
const T = 1_791_461_652;
const retrying = (attempts = 1) => ({ attempt_count: attempts, next_payment_attempt: T + 86_400 });
const exhausted = (attempts = 9) => ({ attempt_count: attempts, next_payment_attempt: null });
const page = (data: unknown[], hasMore = false) => ({ data, has_more: hasMore });

async function load() {
  vi.resetModules();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
  vi.stubEnv('STRIPE_STARTER_PRICE_ID', STARTER);
  vi.stubEnv('STRIPE_PRO_PRICE_ID', PRO);
  return import('../../src/lib/stripe.js');
}

beforeEach(() => {
  search.mockReset();
  list.mockReset();
  invoicesList.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('collectionStateOf — where Stripe is in collecting ONE subscription', () => {
  it('an open invoice with attempts and no next attempt is EXHAUSTED', async () => {
    const { collectionStateOf } = await load();
    expect(collectionStateOf([exhausted()], true)).toBe('EXHAUSTED');
  });

  it('every open invoice still scheduled is RETRYING', async () => {
    const { collectionStateOf } = await load();
    expect(collectionStateOf([retrying(1), retrying(6)], true)).toBe('RETRYING');
  });

  it('an exhausted OLDER invoice beside a retrying NEWER one is EXHAUSTED (the live cus_UxM0… shape)', async () => {
    const { collectionStateOf } = await load();
    expect(collectionStateOf([retrying(6), exhausted(9)], true)).toBe('EXHAUSTED');
  });

  it('a not-yet-attempted invoice (attempt_count 0, no next attempt) has not run out', async () => {
    const { collectionStateOf } = await load();
    expect(collectionStateOf([{ attempt_count: 0, next_payment_attempt: null }], true)).toBe('RETRYING');
  });

  it('a partial page with no exhausted invoice is UNKNOWN, never RETRYING', async () => {
    const { collectionStateOf } = await load();
    expect(collectionStateOf([retrying()], false)).toBe('UNKNOWN');
  });

  it('a partial page that already shows an exhausted invoice is EXHAUSTED — one is enough', async () => {
    const { collectionStateOf } = await load();
    expect(collectionStateOf([exhausted()], false)).toBe('EXHAUSTED');
  });
});

describe('classifyCustomerSubscriptions — the leg, pure', () => {
  it('the status-only view (no collection map) is unchanged: past_due → DUNNING', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions('cus_x', [sub('sub_pd', 'past_due')]);
    expect(r.entitlementState).toBe('DUNNING');
    expect(r.dunning?.subscriptionId).toBe('sub_pd');
  });

  it('past_due with every open invoice retrying → DUNNING (served + charged)', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions('cus_x', [sub('sub_pd', 'past_due')], new Map([['sub_pd', 'RETRYING' as const]]));
    expect(r.entitlementState).toBe('DUNNING');
    expect(r.valid).toBe(false);
  });

  it('past_due with an exhausted open invoice → NOT_ENTITLED(dunning_exhausted)', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions('cus_x', [sub('sub_pd', 'past_due')], new Map([['sub_pd', 'EXHAUSTED' as const]]));
    expect(r.entitlementState).toBe('NOT_ENTITLED');
    expect(r.reason).toBe('dunning_exhausted');
    expect(r.subscriptionStatus).toBe('past_due');
    expect(r.valid).toBe(false);
    expect(r.dunning).toBeUndefined();
    expect(r.indeterminate).toBeUndefined();
  });

  it('active → ENTITLED: the leg never touches a subscription Stripe is not dunning', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions('cus_x', [sub('sub_a', 'active', PRO)], new Map());
    expect(r.entitlementState).toBe('ENTITLED');
    expect(r.tier).toBe('pro');
  });

  it.each(['canceled', 'unpaid'])('%s → NOT_ENTITLED(subscription_ended), unchanged', async (status) => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions('cus_x', [sub('sub_e', status)], new Map());
    expect(r.entitlementState).toBe('NOT_ENTITLED');
    expect(r.reason).toBe('subscription_ended');
  });

  it('best-wins: a RETRYING subscription outranks an EXHAUSTED one, whatever their order', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const col = new Map([['sub_old', 'EXHAUSTED' as const], ['sub_new', 'RETRYING' as const]]);
    for (const subs of [
      [sub('sub_old', 'past_due', PRO), sub('sub_new', 'past_due', STARTER)],
      [sub('sub_new', 'past_due', STARTER), sub('sub_old', 'past_due', PRO)],
    ]) {
      const r = classifyCustomerSubscriptions('cus_x', subs, col);
      expect(r.entitlementState).toBe('DUNNING');
      expect(r.dunning?.tier).toBe('starter');
      expect(r.dunning?.subscriptionId).toBe('sub_new');
    }
  });

  it('an UNKNOWN that could change the answer → INDETERMINATE (never a guess either way)', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions('cus_x', [sub('sub_pd', 'past_due')], new Map([['sub_pd', 'UNKNOWN' as const]]));
    expect(r.entitlementState).toBe('INDETERMINATE');
    expect(r.indeterminate).toBe(true);
  });

  it('a past_due subscription missing from a supplied map is UNKNOWN, not DUNNING', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions('cus_x', [sub('sub_pd', 'past_due')], new Map());
    expect(r.entitlementState).toBe('INDETERMINATE');
  });

  it('an UNKNOWN that cannot change the answer does not degrade an ENTITLED customer', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions(
      'cus_x',
      [sub('sub_a', 'active', PRO), sub('sub_pd', 'past_due', STARTER)],
      new Map([['sub_pd', 'UNKNOWN' as const]]),
    );
    expect(r.entitlementState).toBe('ENTITLED');
    expect(r.tier).toBe('pro');
  });

  it('reason precedence: no_subscription > unrecognised_price > dunning_exhausted > subscription_ended', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const ex = new Map([['sub_pd', 'EXHAUSTED' as const]]);
    expect(classifyCustomerSubscriptions('cus_x', [], ex).reason).toBe('no_subscription');
    expect(
      classifyCustomerSubscriptions('cus_x', [sub('sub_pd', 'past_due'), sub('sub_u', 'active', 'price_unknown')], ex).reason,
    ).toBe('unrecognised_price');
    const both = classifyCustomerSubscriptions('cus_x', [sub('sub_c', 'canceled'), sub('sub_pd', 'past_due')], ex);
    expect(both.reason).toBe('dunning_exhausted');
    expect(both.subscriptionStatus, 'the status reported is the exhausted subscription’s').toBe('past_due');
    expect(classifyCustomerSubscriptions('cus_x', [sub('sub_c', 'canceled')], ex).reason).toBe('subscription_ended');
  });

  it('a lost price-ID config can never mint dunning_exhausted — the reason the bot lets act alone', async () => {
    const { classifyCustomerSubscriptions } = await load();
    const r = classifyCustomerSubscriptions(
      'cus_x',
      [sub('sub_pd', 'past_due', 'price_nobody_configured')],
      new Map([['sub_pd', 'EXHAUSTED' as const]]),
    );
    expect(r.entitlementState).toBe('NOT_ENTITLED');
    expect(r.reason).toBe('unrecognised_price');
  });
});

describe('validateApiKey — two views, two caches', () => {
  const dunningCustomer = () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('sub_pd', 'past_due')] });
  };

  it('the /mcp view (no options) answers DUNNING and makes ZERO invoice calls', async () => {
    dunningCustomer();
    const m = await load();
    const r = await m.validateApiKey('av_live_rdb');
    expect(r.entitlementState).toBe('DUNNING');
    expect(invoicesList).not.toHaveBeenCalled();
  });

  it('the collection view asks Stripe for the open invoices, once per dunning subscription', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValue(page([retrying(6), exhausted(9)]));
    const m = await load();
    const r = await m.validateApiKey('av_live_rdb', { collection: true });
    expect(r.entitlementState).toBe('NOT_ENTITLED');
    expect(r.reason).toBe('dunning_exhausted');
    expect(invoicesList).toHaveBeenCalledTimes(1);
    expect(invoicesList).toHaveBeenCalledWith({ subscription: 'sub_pd', status: 'open', limit: 100 });
  });

  it('the collection view answers DUNNING while every open invoice is still being retried', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValue(page([retrying(1)]));
    const m = await load();
    expect((await m.validateApiKey('av_live_rdb', { collection: true })).entitlementState).toBe('DUNNING');
  });

  it('the collection view makes ZERO invoice calls for an ENTITLED customer', async () => {
    search.mockResolvedValue({ data: [CUS] });
    list.mockResolvedValue({ data: [sub('sub_a', 'active')] });
    const m = await load();
    expect((await m.validateApiKey('av_live_rdb', { collection: true })).entitlementState).toBe('ENTITLED');
    expect(invoicesList).not.toHaveBeenCalled();
  });

  it('a cached status-only DUNNING never answers a collection call', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValue(page([exhausted()]));
    const m = await load();
    expect((await m.validateApiKey('av_live_rdb')).entitlementState).toBe('DUNNING');
    const r = await m.validateApiKey('av_live_rdb', { collection: true });
    expect(r.entitlementState).toBe('NOT_ENTITLED');
    expect(invoicesList).toHaveBeenCalledTimes(1);
  });

  it('a cached collection answer never answers a status-only call', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValue(page([exhausted()]));
    const m = await load();
    expect((await m.validateApiKey('av_live_rdb', { collection: true })).entitlementState).toBe('NOT_ENTITLED');
    expect((await m.validateApiKey('av_live_rdb')).entitlementState).toBe('DUNNING');
  });

  it('each view caches its own answer for the TTL', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValue(page([exhausted()]));
    const m = await load();
    await m.validateApiKey('av_live_rdb', { collection: true });
    await m.validateApiKey('av_live_rdb', { collection: true });
    expect(invoicesList).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('an invoice-list failure is INDETERMINATE, and is NEVER cached', async () => {
    dunningCustomer();
    invoicesList.mockRejectedValueOnce(new Error('stripe 500'));
    invoicesList.mockResolvedValueOnce(page([exhausted()]));
    const m = await load();
    const first = await m.validateApiKey('av_live_rdb', { collection: true });
    expect(first.entitlementState).toBe('INDETERMINATE');
    expect(first.indeterminate).toBe(true);
    const second = await m.validateApiKey('av_live_rdb', { collection: true });
    expect(second.entitlementState, 'the failure was not cached').toBe('NOT_ENTITLED');
    expect(invoicesList).toHaveBeenCalledTimes(2);
  });

  it('a partial invoice page (has_more) is INDETERMINATE, and is NEVER cached', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValueOnce(page([retrying()], true));
    invoicesList.mockResolvedValueOnce(page([retrying()]));
    const m = await load();
    expect((await m.validateApiKey('av_live_rdb', { collection: true })).entitlementState).toBe('INDETERMINATE');
    expect((await m.validateApiKey('av_live_rdb', { collection: true })).entitlementState).toBe('DUNNING');
  });

  it('invalidateCacheForCustomer clears BOTH views', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValue(page([exhausted()]));
    const m = await load();
    await m.validateApiKey('av_live_rdb');
    await m.validateApiKey('av_live_rdb', { collection: true });
    expect(search).toHaveBeenCalledTimes(2);
    m.invalidateCacheForCustomer('cus_rdb_test');
    await m.validateApiKey('av_live_rdb');
    await m.validateApiKey('av_live_rdb', { collection: true });
    expect(search, 'both views asked Stripe again').toHaveBeenCalledTimes(4);
  });

  it('the wire: NOT_ENTITLED(dunning_exhausted) is today’s 404 shape, reason carried', async () => {
    dunningCustomer();
    invoicesList.mockResolvedValue(page([exhausted()]));
    const m = await load();
    const { projectEntitlementHttp } = await import('../../src/lib/entitlement-http.js');
    const p = projectEntitlementHttp(await m.validateApiKey('av_live_rdb', { collection: true }));
    expect(p.status).toBe(404);
    expect(p.chargeableTier).toBeNull();
    expect(p.body).toEqual({
      valid: false,
      entitlement_state: 'NOT_ENTITLED',
      customer_id: 'cus_rdb_test',
      reason: 'dunning_exhausted',
      subscription_status: 'past_due',
    });
  });
});

describe('placement (ruling Q-C) — pinned in source, because a unit test cannot prove a caller', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(join(here, '../../src', rel), 'utf8');
  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
  const COLLECTION_CALL = /validateApiKey\(apiKey, \{ collection: true \}\)/g;

  it('validate-key routes on the collection view (index.ts)', () => {
    expect(count(read('index.ts'), COLLECTION_CALL)).toBe(1);
  });

  it('/api/entitlement/{consume,state} route on the collection view', () => {
    expect(count(read('lib/entitlement-api.ts'), COLLECTION_CALL)).toBe(2);
  });

  it('/mcp keeps the status-only view — no invoice call on the request path', () => {
    const lic = read('lib/license.ts');
    expect(count(lic, /stripeValidateApiKey\(key\)/g)).toBe(1);
    expect(lic).not.toMatch(/collection:\s*true/);
  });

  it('key recovery keeps the status-only view (ruling Q-B)', () => {
    const s = read('lib/stripe.ts');
    expect(s).toMatch(/const state = classifyCustomerSubscriptions\(customer\.id, subs\.data\)\.entitlementState;/);
  });
});
