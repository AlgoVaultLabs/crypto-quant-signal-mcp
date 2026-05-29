/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 C4 — delivery worker (HMAC + retry + auto-disable).
 *
 * SQLite temp-HOME harness. fetch is mocked (injected fetchImpl) so we assert
 * on the captured request (URL, headers, body, HMAC) deterministically; sleep
 * is a noop so backoff is instant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';

const ORIGINAL = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');
let delivery: typeof import('../src/lib/webhook-delivery.js');

const noopSleep = async () => {};

const FORBIDDEN_KEYS = ['outcome_return_pct', 'outcome_price', 'return_pct_', 'pfe_', 'mae_', 'price_after_'];

const eventData = (over = {}) => ({
  type: 'trade_call' as const,
  coin: 'BTC',
  timeframe: '1h',
  exchange: 'HL',
  call: 'BUY',
  confidence: 72,
  regime: 'TRENDING_UP',
  price_at_call: 50000,
  signal_hash: '0xdeadbeef',
  created_at: 1_700_000_000,
  ...over,
});

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-delivery-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
  store = await import('../src/lib/webhooks-store.js');
  delivery = await import('../src/lib/webhook-delivery.js');
});

afterEach(() => {
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
});

// Mock fetch that returns a programmed sequence of statuses and captures calls.
function mockFetch(statuses: number[]) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const impl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body });
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('buildPayload: allow-list + shape', () => {
  it('omits ALL forbidden Phase-E keys and includes call + verify_url + envelope', () => {
    const payload = delivery.buildPayload(eventData(), 42);
    const serialized = JSON.stringify(payload);
    for (const k of FORBIDDEN_KEYS) {
      expect(serialized.includes(k), `forbidden key ${k} must be absent`).toBe(false);
    }
    expect(payload.event).toBe('trade_call');
    expect(payload.delivery_id).toBe('42');
    expect(payload.data.call).toBe('BUY');
    expect(payload.data.price_at_call).toBe(50000);
    expect(payload.data.verify_url).toBe('https://algovault.com/verify?hash=0xdeadbeef');
    expect(payload._algovault.service).toBe('webhook-delivery');
    expect(typeof payload._algovault.version).toBe('string');
  });

  it('regime_shift payload carries prior_regime; trade_call does not', () => {
    const shift = delivery.buildPayload(eventData({ type: 'regime_shift', prior_regime: 'TRENDING_UP', regime: 'RANGING' }), 1);
    expect(shift.data.prior_regime).toBe('TRENDING_UP');
    const call = delivery.buildPayload(eventData(), 2);
    expect('prior_regime' in call.data).toBe(false);
  });
});

describe('signPayload: HMAC', () => {
  it('produces an HMAC-SHA256 hex that verifies against a recomputed digest', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'whsec_test';
    const sig = delivery.signPayload(body, secret);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deliverOne: delivery, retry, idempotency, auto-disable', () => {
  async function seedDelivery(over = {}) {
    const sub = await store.createSubscription({ url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:x' });
    const { deliveryId } = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:0xdeadbeef', eventType: 'trade_call', eventData: eventData(over) });
    const d = (await store.pendingDeliveries(10)).find(x => x.id === deliveryId)!;
    return { sub, d };
  }

  it('200 → delivered; sink receives POST with valid HMAC + headers; success resets failures', async () => {
    const { sub, d } = await seedDelivery();
    const { impl, calls } = mockFetch([200]);
    const res = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep });

    expect(res.status).toBe('delivered');
    expect(res.attempts).toBe(1);
    expect(res.responseCode).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://sink.example.com/h');
    // HMAC header must verify against the captured body + the subscription secret.
    const recomputed = crypto.createHmac('sha256', sub.secret).update(calls[0].body).digest('hex');
    expect(calls[0].headers['X-AlgoVault-Signature']).toBe(recomputed);
    expect(calls[0].headers['X-AlgoVault-Event']).toBe('trade_call');
    expect(calls[0].headers['X-AlgoVault-Delivery']).toBe(String(d.id));
    expect(calls[0].headers['X-AlgoVault-Timestamp']).toMatch(/^\d+$/);

    const after = await store.getSubscription(sub.id);
    expect(after?.consecutive_failures).toBe(0);
    expect(after?.last_delivered_at).toBeGreaterThan(0);
    // No longer pending.
    expect((await store.pendingDeliveries(10)).length).toBe(0);
  });

  it('500-then-200 → retries and ends delivered (attempts=2)', async () => {
    const { d } = await seedDelivery();
    const { impl, calls } = mockFetch([500, 200]);
    const res = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep });
    expect(res.status).toBe('delivered');
    expect(res.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  it('all 500 → failed after maxAttempts; not re-delivered on a second drain', async () => {
    const { d } = await seedDelivery();
    const cfg = { maxAttempts: 3, timeoutMs: 1000, disableAfter: 20, baseBackoffMs: 0 };
    const { impl, calls } = mockFetch([500]);
    const res = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep }, cfg);
    expect(res.status).toBe('failed');
    expect(res.attempts).toBe(3);
    expect(res.responseCode).toBe(500);
    expect(res.suggested_action).toBeTruthy();
    // Idempotency: a subsequent drain finds nothing pending (status='failed').
    const before = calls.length;
    const drained = await delivery.deliverPending(10, { fetchImpl: impl, sleep: noopSleep }, cfg);
    expect(drained.length).toBe(0);
    expect(calls.length).toBe(before);
  });

  it('network error / timeout (fetch throws) is treated as a failed attempt and retried', async () => {
    const { d } = await seedDelivery();
    const cfg = { maxAttempts: 2, timeoutMs: 1000, disableAfter: 20, baseBackoffMs: 0 };
    let n = 0;
    const impl = (async () => { n += 1; throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const res = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep }, cfg);
    expect(res.status).toBe('failed');
    expect(res.attempts).toBe(2);
    expect(res.responseCode).toBeNull();
    expect(n).toBe(2);
  });

  it('subscription auto-disables after the consecutive-failure threshold', async () => {
    const sub = await store.createSubscription({ url: 'https://sink/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:y' });
    const cfg = { maxAttempts: 1, timeoutMs: 1000, disableAfter: 2, baseBackoffMs: 0 };
    const { impl } = mockFetch([500]);

    // Two distinct failing deliveries → two consecutive failures → disabled on the 2nd.
    const e1 = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:a', eventType: 'trade_call', eventData: eventData() });
    const d1 = (await store.pendingDeliveries(10)).find(x => x.id === e1.deliveryId)!;
    const r1 = await delivery.deliverOne(d1, { fetchImpl: impl, sleep: noopSleep }, cfg);
    expect(r1.subscriptionDisabled).toBe(false);

    const e2 = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:b', eventType: 'trade_call', eventData: eventData() });
    const d2 = (await store.pendingDeliveries(10)).find(x => x.id === e2.deliveryId)!;
    const r2 = await delivery.deliverOne(d2, { fetchImpl: impl, sleep: noopSleep }, cfg);
    expect(r2.subscriptionDisabled).toBe(true);
    expect(r2.suggested_action).toMatch(/auto-disabled/);

    expect((await store.getSubscription(sub.id))?.active).toBe(false);
  });

  it('a disabled subscription marks new deliveries dead without an HTTP attempt', async () => {
    const sub = await store.createSubscription({ url: 'https://sink/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:z' });
    await store.bumpFailureAndMaybeDisable(sub.id, 1); // force-disable
    const { deliveryId } = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:c', eventType: 'trade_call', eventData: eventData() });
    const d = (await store.pendingDeliveries(10)).find(x => x.id === deliveryId)!;
    const { impl, calls } = mockFetch([200]);
    const res = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep });
    expect(res.status).toBe('dead');
    expect(calls.length).toBe(0); // no HTTP attempt for a disabled sub
  });
});

describe('quota gate', () => {
  it('pauses delivery (stays pending, no HTTP) when the owner quota is exhausted, and charges on success', async () => {
    const license = await import('../src/lib/license.js');
    // Free quota = 100. Exhaust the owner's bucket.
    const ownerKey = 'free:exhausted';
    for (let i = 0; i < 100; i++) license.trackCallByKey(ownerKey, 'free');

    const sub = await store.createSubscription({ url: 'https://sink/h', events: ['trade_call'], tier: 'free', ownerKey });
    const { deliveryId } = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:x', eventType: 'trade_call', eventData: eventData() });
    const d = (await store.pendingDeliveries(10)).find(x => x.id === deliveryId)!;

    const { impl, calls } = mockFetch([200]);
    const res = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep });
    expect(res.status).toBe('pending');         // paused
    expect(calls.length).toBe(0);                // no HTTP attempt
    expect(res.suggested_action).toMatch(/quota exhausted/);
    expect((await store.pendingDeliveries(10)).length).toBe(1); // still queued

    // A subscription with quota remaining delivers AND charges one call.
    const ok = await store.createSubscription({ url: 'https://sink/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:fresh' });
    const e2 = await store.enqueueDelivery({ subscriptionId: ok.id, eventId: 'call:y', eventType: 'trade_call', eventData: eventData() });
    const d2 = (await store.pendingDeliveries(10)).find(x => x.id === e2.deliveryId)!;
    const before = license.checkQuotaByKey('free:fresh', 'free').used;
    const r2 = await delivery.deliverOne(d2, { fetchImpl: mockFetch([200]).impl, sleep: noopSleep });
    expect(r2.status).toBe('delivered');
    expect(license.checkQuotaByKey('free:fresh', 'free').used).toBe(before + 1);
  });
});

describe('worker lifecycle', () => {
  it('start is idempotent and stop clears the handle', async () => {
    expect(delivery.isWorkerRunning()).toBe(false);
    delivery.startDeliveryWorker(60_000);
    expect(delivery.isWorkerRunning()).toBe(true);
    delivery.startDeliveryWorker(60_000); // idempotent
    expect(delivery.isWorkerRunning()).toBe(true);
    delivery.stopDeliveryWorker();
    expect(delivery.isWorkerRunning()).toBe(false);
  });
});
