/**
 * TG-SIGNIN-W1-R2 CH2 R2.1 / R2.3 / R2.4 — the Stripe side of the one-time Telegram sign-in token.
 *
 *   1. `getCustomerApiKey` (the session read behind the /welcome reveal) reports `fromTelegram` — the session's
 *      `metadata.utm_source` is exactly `tg_bot`, which the bot's plan buttons send — and the customer id the
 *      redeem will read the key by.
 *   2. `getApiKeyByCustomerId` reads the key by `customers.retrieve` — NEVER `customers.search`, which Stripe
 *      documents as unfit for read-after-write (a key minted seconds ago can read as unknown) — and answers
 *      `key | deleted | no_key` or throws (reused from TG-SIGNIN-W1 CH2 `0c88aa5a`, R-REV3 LOW-2).
 *   3. Checkout metadata is byte-identical to BASE `2e52b6b3`: this wave adds no metadata key. The sha256 of
 *      four fixtures' `buildCheckoutMetadata` output was captured at 2e52b6b3, before any TG-SIGNIN change.
 *
 * The Stripe SDK is replaced by a fake (the `checkout-session-params.test.ts` shape), so the real functions run
 * and every call they make to Stripe is recorded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fake = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_tg_signin_fake';
  process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_tg';
  process.env.STRIPE_PRO_PRICE_ID = 'price_pro_tg';
  return {
    sessions: new Map<string, unknown>(),
    customers: new Map<string, unknown>(),
    retrieves: [] as string[],
    searches: 0,
    retrieveError: null as null | Error,
  };
});

vi.mock('stripe', () => {
  class FakeStripe {
    checkout = {
      sessions: {
        retrieve: async (id: string) => {
          const s = fake.sessions.get(id);
          if (!s) throw new Error(`No such checkout.session: '${id}'`);
          return s;
        },
      },
    };
    customers = {
      retrieve: async (id: string) => {
        fake.retrieves.push(id);
        if (fake.retrieveError) throw fake.retrieveError;
        const c = fake.customers.get(id);
        if (!c) throw new Error(`No such customer: '${id}'`);
        return c;
      },
      search: async () => {
        fake.searches += 1;
        throw new Error('customers.search must never be called on the sign-in token path');
      },
    };
    constructor(_key: string) { /* no network */ }
  }
  return { default: FakeStripe };
});

import { buildCheckoutMetadata, getCustomerApiKey, getApiKeyByCustomerId } from '../../src/lib/stripe.js';

const REPO = join(__dirname, '..', '..');
const KEY = 'av_live_0123456789abcdef01234567';

/** A Checkout Session as `getCustomerApiKey` retrieves it (customer + subscription expanded). */
function session(
  metadata: Record<string, string> | null | undefined,
  customer: unknown = { id: 'cus_tg_1', email: 'buyer@example.com', metadata: { api_key: KEY } },
) {
  return {
    status: 'complete',
    payment_status: 'paid',
    created: 1_700_000_000,
    metadata,
    customer,
    subscription: { items: { data: [{ price: { id: 'price_starter_tg' } }] }, metadata },
  };
}

describe('getCustomerApiKey — fromTelegram and the customer id (R2.3)', () => {
  it('a checkout from the bot (utm_source=tg_bot) is fromTelegram, with its customer id', async () => {
    fake.sessions.set('cs_test_tg_yes', session({ tier: 'starter', billing_interval: 'month', utm_source: 'tg_bot', utm_medium: 'telegram' }));
    const r = await getCustomerApiKey('cs_test_tg_yes');
    expect(r).toMatchObject({ apiKey: KEY, tier: 'starter', email: 'buyer@example.com', customerId: 'cus_tg_1', fromTelegram: true });
  });

  it('exactly tg_bot: any other source, none, or no metadata is not', async () => {
    const others: Array<Record<string, string> | null | undefined> = [
      { utm_source: 'tg' }, { utm_source: 'tg_bot_x' }, { utm_source: 'TG_BOT' }, { utm_source: ' tg_bot' },
      { utm_source: 'telegram' }, { utm_medium: 'tg_bot' }, { tier: 'starter' }, {}, null, undefined,
    ];
    for (const [i, metadata] of others.entries()) {
      fake.sessions.set(`cs_test_tg_no_${i}`, session(metadata));
      const r = await getCustomerApiKey(`cs_test_tg_no_${i}`);
      expect(r.fromTelegram, JSON.stringify(metadata) ?? 'undefined').toBe(false);
      expect(r.customerId).toBe('cus_tg_1');
    }
  });

  it('a session whose customer is not expanded is pending, and still names the customer id', async () => {
    fake.sessions.set('cs_test_tg_pending', session({ utm_source: 'tg_bot' }, 'cus_not_expanded'));
    expect(await getCustomerApiKey('cs_test_tg_pending')).toMatchObject({ apiKey: null, customerId: 'cus_not_expanded', fromTelegram: true });
    fake.sessions.set('cs_test_tg_nocus', session({ utm_source: 'tg_bot' }, null));
    expect(await getCustomerApiKey('cs_test_tg_nocus')).toMatchObject({ apiKey: null, customerId: null, fromTelegram: true });
  });

  it('a customer object without an id gives no customer id (so no token can be minted for it)', async () => {
    fake.sessions.set('cs_test_tg_noid', session({ utm_source: 'tg_bot' }, { email: 'buyer@example.com', metadata: { api_key: KEY } }));
    expect(await getCustomerApiKey('cs_test_tg_noid')).toMatchObject({ apiKey: KEY, customerId: null, fromTelegram: true });
  });
});

describe('getApiKeyByCustomerId — by id, never by search (R2.4)', () => {
  beforeEach(() => {
    fake.retrieves.length = 0;
    fake.searches = 0;
    fake.retrieveError = null;
  });

  it('returns the customer\'s current key through customers.retrieve', async () => {
    fake.customers.set('cus_tg_1', { id: 'cus_tg_1', metadata: { api_key: 'av_live_aaaaaaaaaaaaaaaaaaaaaaaa', tier: 'starter' } });
    expect(await getApiKeyByCustomerId('cus_tg_1')).toEqual({ kind: 'key', apiKey: 'av_live_aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(fake.retrieves).toEqual(['cus_tg_1']);
    expect(fake.searches).toBe(0);
  });

  it('R-REV3 LOW-2: a deleted customer reads as deleted, one without a key as no_key — both definitive', async () => {
    fake.customers.set('cus_tg_deleted', { id: 'cus_tg_deleted', object: 'customer', deleted: true });
    fake.customers.set('cus_tg_nokey', { id: 'cus_tg_nokey', metadata: {} });
    fake.customers.set('cus_tg_blank', { id: 'cus_tg_blank', metadata: { api_key: '' } });
    fake.customers.set('cus_tg_nometa', { id: 'cus_tg_nometa' });
    expect(await getApiKeyByCustomerId('cus_tg_deleted')).toEqual({ kind: 'deleted' });
    for (const id of ['cus_tg_nokey', 'cus_tg_blank', 'cus_tg_nometa']) {
      expect(await getApiKeyByCustomerId(id), id).toEqual({ kind: 'no_key' });
    }
    expect(fake.searches).toBe(0);
  });

  it('a Stripe error propagates — a 503 is "could not read", never "no key"', async () => {
    fake.retrieveError = Object.assign(new Error('Service Unavailable'), { type: 'StripeAPIError', statusCode: 503 });
    await expect(getApiKeyByCustomerId('cus_tg_1')).rejects.toThrow('Service Unavailable');
    expect(fake.searches).toBe(0);
  });

  it('an unconfigured Stripe client is "could not read" too — never no_key, which would spend the token', async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    vi.resetModules();
    try {
      const unconfigured = await import('../../src/lib/stripe.js');
      await expect(unconfigured.getApiKeyByCustomerId('cus_tg_1')).rejects.toThrow(/not configured/);
    } finally {
      process.env.STRIPE_SECRET_KEY = saved;
      vi.resetModules();
    }
    expect(fake.retrieves).toEqual([]);
  });

  it('source: the function never names customers.search', () => {
    const src = readFileSync(join(REPO, 'src', 'lib', 'stripe.ts'), 'utf8');
    const start = src.indexOf('export async function getApiKeyByCustomerId(');
    const end = src.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, end);
    expect(body).toContain('customers.retrieve(');
    expect(body).not.toContain('customers.search');
  });
});

/** The four fixtures whose outputs were captured from the BASE builder (2e52b6b3) before any TG-SIGNIN change. */
const BASE_CASES: Array<[Parameters<typeof buildCheckoutMetadata>[0], Parameters<typeof buildCheckoutMetadata>[1], Record<string, unknown>]> = [
  ['starter', 'month', {}],
  ['pro', '6month', { utmSource: 'tg_bot', utmMedium: 'telegram', utmCampaign: 'plan_wall', refCode: 'ABCD1234', upgradeFrom: 'quota_notice', classification: 'browser', landingPath: 'https://t.me/' }],
  ['enterprise', 'month', { utmSource: 'x'.repeat(100), landingPath: 'y'.repeat(300), refCode: 'R'.repeat(20) }],
  ['starter', 'month', { utmSource: '', utmCampaign: undefined, clientReferenceId: 'direct:1:abc', interval: '6month' }],
];
/** sha256 over the four BASE outputs, `JSON.stringify` each, joined by `\n` — captured at 2e52b6b3. */
const BASE_SHA256 = '1a939767db81d27fcf733746d85f64617da863ee66e90c8dd6b8b9dbc05fafea';

describe('checkout metadata is byte-identical to BASE 2e52b6b3 (R2.1 — no tg_link, no new key)', () => {
  it('the four BASE fixtures hash to the value captured before the wave', () => {
    const sha = createHash('sha256')
      .update(BASE_CASES.map(([p, i, o]) => JSON.stringify(buildCheckoutMetadata(p, i, o))).join('\n'))
      .digest('hex');
    expect(sha).toBe(BASE_SHA256);
  });

  it('no metadata key or reader for a Telegram link exists anywhere in src (the reverted R2.1 surface)', () => {
    const files = ['src/lib/stripe.ts', 'src/index.ts', 'src/lib/key-reveal.ts', 'src/lib/welcome-page.ts', 'src/lib/tg-signin-tokens.ts'];
    for (const f of files) {
      const src = readFileSync(join(REPO, f), 'utf8');
      expect(src, f).not.toMatch(/\btg_link\b|\bisTgLink\b|\btgLink\b|tg-checkout-links|checkout-links/);
    }
  });
});
