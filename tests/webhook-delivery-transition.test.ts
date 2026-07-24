/**
 * OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 C3 — deliverOne wires the classifier into
 * the SUBSCRIPTION lifecycle. Auto-recovery ON (WEBHOOK_AUTO_RECOVERY_ENABLED=true):
 * transient failures degrade→quarantine; http_410 hard-disables; egress-block
 * transitions (transient). Flag OFF → the legacy one-way disable (firewall).
 *
 * SQLite temp-HOME harness mirroring tests/webhook-delivery.test.ts; fetch mocked,
 * sleep noop, SSRF resolver injected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL,
  AUTO: process.env.WEBHOOK_AUTO_RECOVERY_ENABLED, DELIV: process.env.WEBHOOK_DELIVERY_ENABLED,
  QUAR: process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES,
};

const okLookup = async (): Promise<{ address: string; family: number }[]> => [{ address: '93.184.216.34', family: 4 }];
const blockedLookup = async (): Promise<{ address: string; family: number }[]> => [{ address: '10.0.0.1', family: 4 }];
const noopSleep = async () => {};

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');
let delivery: typeof import('../src/lib/webhook-delivery.js');

const eventData = () => ({
  type: 'trade_call' as const, coin: 'BTC', timeframe: '1h', exchange: 'HL',
  call: 'BUY', confidence: 72, price_at_call: 50000, signal_hash: '0xabc', created_at: 1_700_000_000,
});
const cfg = { maxAttempts: 2, timeoutMs: 1000, disableAfter: 20, baseBackoffMs: 0 };

function mockFetch(statuses: number[]) {
  let i = 0;
  return (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
}
const throwingFetch = (() => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  process.env.WEBHOOK_AUTO_RECOVERY_ENABLED = 'true';
  process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES = '3';
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-transition-'));
  process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
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
  if (ORIGINAL.AUTO !== undefined) process.env.WEBHOOK_AUTO_RECOVERY_ENABLED = ORIGINAL.AUTO; else delete process.env.WEBHOOK_AUTO_RECOVERY_ENABLED;
  if (ORIGINAL.DELIV !== undefined) process.env.WEBHOOK_DELIVERY_ENABLED = ORIGINAL.DELIV; else delete process.env.WEBHOOK_DELIVERY_ENABLED;
  if (ORIGINAL.QUAR !== undefined) process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES = ORIGINAL.QUAR; else delete process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES;
});

async function deliverOnce(subId: number, eventId: string, fetchImpl: typeof fetch, lookup = okLookup) {
  const { deliveryId } = await store.enqueueDelivery({ subscriptionId: subId, eventId, eventType: 'trade_call', eventData: eventData() });
  const d = (await store.pendingDeliveries(50)).find(x => x.id === deliveryId)!;
  return delivery.deliverOne(d, { fetchImpl, sleep: noopSleep, lookup }, cfg);
}
const newSub = () => store.createSubscription({ url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:x' });

describe('C3 deliverOne — transient failures degrade then quarantine', () => {
  it('a single 503-exhausted delivery → degraded (still active), not disabled', async () => {
    const sub = await newSub();
    const res = await deliverOnce(sub.id, 'e1', mockFetch([503]));
    expect(res.status).toBe('failed');
    expect(res.subscriptionDisabled).toBe(false);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('degraded');
    expect(after!.active).toBe(true);
    expect(after!.failure_class).toBe('http_5xx');
  });

  it('reaching the quarantine threshold → quarantined (paused), next_probe_at set', async () => {
    const sub = await newSub();
    await deliverOnce(sub.id, 'q1', mockFetch([503]));
    await deliverOnce(sub.id, 'q2', mockFetch([503]));
    const res = await deliverOnce(sub.id, 'q3', mockFetch([503])); // 3rd = threshold
    expect(res.subscriptionDisabled).toBe(false);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('quarantined');
    expect(after!.active).toBe(false);
    expect(after!.next_probe_at).not.toBeNull();
  });

  it('a network error (ECONNREFUSED) classifies as conn (transient) → degraded', async () => {
    const sub = await newSub();
    const res = await deliverOnce(sub.id, 'n1', throwingFetch);
    expect(res.subscriptionDisabled).toBe(false);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('degraded');
    expect(after!.failure_class).toBe('conn');
  });
});

describe('C3 deliverOne — HTTP 410 is the only instant hard-disable', () => {
  it('410-exhausted → disabled immediately with permanent_http_410', async () => {
    const sub = await newSub();
    const res = await deliverOnce(sub.id, 'g1', mockFetch([410]));
    expect(res.subscriptionDisabled).toBe(true);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('disabled');
    expect(after!.disabled_reason).toBe('permanent_http_410');
  });
});

describe('C3 deliverOne — egress block advances lifecycle (transient, Q1)', () => {
  it('a blocked target marks the delivery dead AND degrades the subscription (not disabled)', async () => {
    const sub = await newSub();
    const res = await deliverOnce(sub.id, 'b1', mockFetch([200]), blockedLookup);
    expect(res.status).toBe('dead');
    expect(res.subscriptionDisabled).toBe(false); // egress_block is transient
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('degraded');
    expect(after!.failure_class).toBe('egress_block');
  });
});

describe('C3 firewall — flag OFF reverts to legacy one-way disable', () => {
  it('WEBHOOK_AUTO_RECOVERY_ENABLED=0 uses bumpFailureAndMaybeDisable (delivery_state untouched)', async () => {
    process.env.WEBHOOK_AUTO_RECOVERY_ENABLED = '0';
    const sub = await newSub();
    // Legacy disableAfter=2 (cfg override) → 2 failures → disabled the OLD way.
    const legacyCfg = { maxAttempts: 1, timeoutMs: 1000, disableAfter: 2, baseBackoffMs: 0 };
    const mk = () => mockFetch([503]);
    const e1 = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'L1', eventType: 'trade_call', eventData: eventData() });
    const d1 = (await store.pendingDeliveries(50)).find(x => x.id === e1.deliveryId)!;
    const r1 = await delivery.deliverOne(d1, { fetchImpl: mk(), sleep: noopSleep, lookup: okLookup }, legacyCfg);
    expect(r1.subscriptionDisabled).toBe(false);
    const e2 = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'L2', eventType: 'trade_call', eventData: eventData() });
    const d2 = (await store.pendingDeliveries(50)).find(x => x.id === e2.deliveryId)!;
    const r2 = await delivery.deliverOne(d2, { fetchImpl: mk(), sleep: noopSleep, lookup: okLookup }, legacyCfg);
    expect(r2.subscriptionDisabled).toBe(true); // legacy hard-disable
    const after = await store.getSubscription(sub.id);
    expect(after!.active).toBe(false);
    expect(after!.delivery_state).toBe('active'); // legacy path never touches delivery_state
  });
});

describe('C3 deliverOne — a 2xx after degrade fully heals', () => {
  it('degraded → deliver 200 → back to active, both timestamps stamped', async () => {
    const sub = await newSub();
    await deliverOnce(sub.id, 'h1', mockFetch([503])); // degraded
    const ok = await deliverOnce(sub.id, 'h2', mockFetch([200]));
    expect(ok.status).toBe('delivered');
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('active');
    expect(after!.consecutive_failures).toBe(0);
    expect(after!.last_delivered_at).not.toBeNull();
    expect(after!.last_success_at).not.toBeNull();
  });
});
