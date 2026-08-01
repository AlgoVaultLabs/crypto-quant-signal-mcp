/**
 * OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH4 (R4.8) — notify isolation.
 *
 * THE load-bearing invariant of this chapter: notifying a subscriber is a
 * SIDE-CHANNEL. If it breaks, deliveries and the health-probe sweep must carry on
 * exactly as before. A notification is worth nothing if it can take the delivery
 * path down with it — that would make the retention feature a reliability
 * liability, which is strictly worse than the silence it replaces.
 *
 * Strategy: force `notifySubscriber` to THROW on every call, then assert the sweep
 * and its state transitions are byte-identical to a run where notify succeeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENVKEYS = [
  'WEBHOOK_AUTO_RECOVERY_ENABLED', 'WEBHOOK_DELIVERY_ENABLED', 'WEBHOOK_QUARANTINE_MAX_SEC',
  'WEBHOOK_PROBE_BACKOFF_BASE_SEC', 'WEBHOOK_PROBE_BACKOFF_MAX_SEC', 'WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED',
] as const;
const ORIGINAL: Record<string, string | undefined> = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL,
};
for (const k of ENVKEYS) ORIGINAL[k] = process.env[k];

const okLookup = async (): Promise<{ address: string; family: number }[]> => [{ address: '93.184.216.34', family: 4 }];
const cfg = { maxAttempts: 1, timeoutMs: 1000, disableAfter: 20, baseBackoffMs: 0 };

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');
let delivery: typeof import('../src/lib/webhook-delivery.js');

function mockFetch(status: number) {
  const impl = (async () => ({ ok: status >= 200 && status < 300, status } as Response)) as unknown as typeof fetch;
  return { impl };
}

/** Boot the module graph with notifySubscriber either throwing or recording. */
async function boot(mode: 'throws' | 'records') {
  const calls: Array<{ event: string; ownerKey: string }> = [];
  vi.doMock('../src/lib/subscriber-notify.js', () => ({
    notifySubscriberDetached: (args: { event: string; ownerKey: string }) => {
      if (mode === 'throws') throw new Error('notify exploded');
      calls.push({ event: args.event, ownerKey: args.ownerKey });
    },
    notifySubscriber: async () => {
      if (mode === 'throws') throw new Error('notify exploded');
      return { sent: true, outcome: 'sent' };
    },
  }));
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
  store = await import('../src/lib/webhooks-store.js');
  delivery = await import('../src/lib/webhook-delivery.js');
  return calls;
}

beforeEach(() => {
  delete process.env.DATABASE_URL;
  process.env.WEBHOOK_AUTO_RECOVERY_ENABLED = 'true';
  process.env.WEBHOOK_QUARANTINE_MAX_SEC = '10';
  process.env.WEBHOOK_PROBE_BACKOFF_BASE_SEC = '300';
  process.env.WEBHOOK_PROBE_BACKOFF_MAX_SEC = '86400';
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-notify-isolation-'));
  process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  try { delivery?.stopHealthProbeSweep(); } catch { /* ignore */ }
  try { perfDb?.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.doUnmock('../src/lib/subscriber-notify.js');
  vi.resetModules();
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
  for (const k of ENVKEYS) { if (ORIGINAL[k] !== undefined) process.env[k] = ORIGINAL[k]!; else delete process.env[k]; }
});

const nowS = () => Math.floor(Date.now() / 1000);

/** Quarantine a sub long enough ago that the sweep must expire it. */
async function seedExpiredQuarantine(ownerKey = 'av_live_paying', tier = 'free') {
  const sub = await store.createSubscription({
    url: 'https://sink.example.com/h', events: ['trade_call'], tier, ownerKey,
  });
  await store.setDeliveryState(sub.id, 'quarantined', {
    quarantined_at: nowS() - 10_000, next_probe_at: nowS() - 1, failure_class: 'timeout',
  });
  return sub;
}

describe('a notify throw never reaches the sweep', () => {
  it('runHealthProbeSweep completes and expires the sub even when notify THROWS', async () => {
    await boot('throws');
    const sub = await seedExpiredQuarantine();
    const { impl } = mockFetch(500);

    // Must not reject.
    const out = await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: okLookup }, cfg);

    expect(out.disabled).toBe(1);
    const after = await store.getSubscription(sub.id);
    expect(after?.delivery_state).toBe('disabled');
    expect(after?.disabled_reason).toBe('quarantine_expired');
  });

  it('the sweep result is BYTE-IDENTICAL with notify throwing vs notify working', async () => {
    // Run A — notify throws.
    await boot('throws');
    const subA = await seedExpiredQuarantine();
    const a = await delivery.runHealthProbeSweep({ fetchImpl: mockFetch(500).impl, lookup: okLookup }, cfg);
    const rowA = await store.getSubscription(subA.id);
    const snapA = { ...a, state: rowA?.delivery_state, reason: rowA?.disabled_reason };
    try { perfDb.closeDb(); } catch { /* ignore */ }
    fs.rmSync(tempHome, { recursive: true, force: true });

    // Run B — notify records.
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-notify-isolation-b-'));
    process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
    vi.doUnmock('../src/lib/subscriber-notify.js');
    const calls = await boot('records');
    const subB = await seedExpiredQuarantine();
    const b = await delivery.runHealthProbeSweep({ fetchImpl: mockFetch(500).impl, lookup: okLookup }, cfg);
    const rowB = await store.getSubscription(subB.id);
    const snapB = { ...b, state: rowB?.delivery_state, reason: rowB?.disabled_reason };

    expect(snapA).toEqual(snapB);
    // And the working run really did fire the terminal notification.
    expect(calls.map((c) => c.event)).toContain('webhook_disabled');
  });
});

describe('the notify leaf itself never throws out of the detached wrapper', () => {
  it('notifySubscriberDetached swallows an internal rejection', async () => {
    vi.doUnmock('../src/lib/subscriber-notify.js');
    vi.resetModules();
    vi.doMock('../src/lib/stripe.js', () => ({
      getCustomerByApiKey: async () => { throw new Error('stripe down'); },
    }));
    vi.doMock('../src/lib/performance-db.js', () => ({ dbQuery: async () => { throw new Error('db down'); } }));
    const notify = await import('../src/lib/subscriber-notify.js');
    // Neither form may throw synchronously or asynchronously.
    expect(() => notify.notifySubscriberDetached({ ownerKey: 'av_live_x', event: 'webhook_disabled' })).not.toThrow();
    await expect(notify.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled' })).resolves.toMatchObject({ sent: false });
    vi.doUnmock('../src/lib/stripe.js');
    vi.doUnmock('../src/lib/performance-db.js');
  });
});

describe('quarantine warning reports when the endpoint last WORKED', () => {
  it('falls back to last_delivered_at when last_success_at is null', async () => {
    // Sub 6 live: last_success_at NULL (only PROBES stamp it) but last_delivered_at
    // 2026-07-21 — a real delivery. Reading only last_success_at would tell a paying
    // customer their endpoint had "not delivered successfully yet", which is FALSE.
    const ctxs: Array<Record<string, unknown>> = [];
    vi.doMock('../src/lib/subscriber-notify.js', () => ({
      notifySubscriberDetached: (a: { context?: Record<string, unknown> }) => { ctxs.push(a.context ?? {}); },
      notifySubscriber: async () => ({ sent: true, outcome: 'sent' }),
    }));
    vi.resetModules();
    perfDb = await import('../src/lib/performance-db.js');
    store = await import('../src/lib/webhooks-store.js');
    delivery = await import('../src/lib/webhook-delivery.js');

    const sub = await store.createSubscription({
      url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'starter', ownerKey: 'av_live_paying',
    });
    const row = await store.getSubscription(sub.id);
    // Reproduce sub 6's LIVE shape exactly: a sub backfilled by
    // backfillLegacyWebhookLifecycle (failure_class 'legacy') carries a real
    // last_delivered_at while last_success_at was never populated.
    const legacyShaped = {
      ...row!,
      delivery_state: 'degraded' as const,
      failure_class: 'legacy',
      last_success_at: null,
      last_delivered_at: 1784642333, // 2026-07-21T13:58:53Z — sub 6's actual value
    };
    delivery.notifyQuarantinedForTest(legacyShaped, 'quarantined', nowS());

    expect(ctxs).toHaveLength(1);
    // Without the fallback this would be null and the email would tell a paying
    // customer their endpoint had "not delivered successfully yet" — false.
    expect(ctxs[0].lastSuccessAt).toBe(1784642333);
  });

  it('omits the sentence only when BOTH timestamps are null', async () => {
    const ctxs: Array<Record<string, unknown>> = [];
    vi.doMock('../src/lib/subscriber-notify.js', () => ({
      notifySubscriberDetached: (a: { context?: Record<string, unknown> }) => { ctxs.push(a.context ?? {}); },
      notifySubscriber: async () => ({ sent: true, outcome: 'sent' }),
    }));
    vi.resetModules();
    perfDb = await import('../src/lib/performance-db.js');
    store = await import('../src/lib/webhooks-store.js');
    delivery = await import('../src/lib/webhook-delivery.js');

    const sub = await store.createSubscription({
      url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'starter', ownerKey: 'av_live_paying',
    });
    const row = await store.getSubscription(sub.id);
    delivery.notifyQuarantinedForTest(
      { ...row!, delivery_state: 'degraded' as const, last_success_at: null, last_delivered_at: null },
      'quarantined', nowS(),
    );
    expect(ctxs[0].lastSuccessAt ?? null).toBeNull();
  });
});

describe('terminal notification fires on the real transitions', () => {
  it('quarantine_expired fires webhook_disabled exactly once', async () => {
    const calls = await boot('records');
    await seedExpiredQuarantine();
    await delivery.runHealthProbeSweep({ fetchImpl: mockFetch(500).impl, lookup: okLookup }, cfg);
    expect(calls.filter((c) => c.event === 'webhook_disabled')).toHaveLength(1);
  });

  it('a 2xx probe fires webhook_resumed (registered-and-silent, not an omission)', async () => {
    const calls = await boot('records');
    const sub = await store.createSubscription({
      url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'starter', ownerKey: 'av_live_paying',
    });
    // Quarantined RECENTLY so it probes rather than expires.
    await store.setDeliveryState(sub.id, 'quarantined', {
      quarantined_at: nowS() - 1, next_probe_at: nowS() - 1, failure_class: 'timeout',
    });
    const out = await delivery.runHealthProbeSweep({ fetchImpl: mockFetch(200).impl, lookup: okLookup }, cfg);
    expect(out.resumed).toBe(1);
    expect(calls.map((c) => c.event)).toContain('webhook_resumed');
  });
});
