/**
 * OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 C4 — health-probe sweep + auto-resume.
 *
 * Drives runHealthProbeSweep() directly (deterministic) with an injected fetch +
 * SSRF resolver. Run with WEBHOOK_SSRF_ALLOW_LOOPBACK=1 per the gate; lookups are
 * injected so the assertions don't touch real DNS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENVKEYS = ['WEBHOOK_AUTO_RECOVERY_ENABLED', 'WEBHOOK_DELIVERY_ENABLED', 'WEBHOOK_QUARANTINE_MAX_SEC', 'WEBHOOK_PROBE_BACKOFF_BASE_SEC', 'WEBHOOK_PROBE_BACKOFF_MAX_SEC'] as const;
const ORIGINAL: Record<string, string | undefined> = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };
for (const k of ENVKEYS) ORIGINAL[k] = process.env[k];

const okLookup = async (): Promise<{ address: string; family: number }[]> => [{ address: '93.184.216.34', family: 4 }];
const blockedLookup = async (): Promise<{ address: string; family: number }[]> => [{ address: '10.0.0.1', family: 4 }];
const cfg = { maxAttempts: 1, timeoutMs: 1000, disableAfter: 20, baseBackoffMs: 0 };

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');
let delivery: typeof import('../src/lib/webhook-delivery.js');

function mockFetch(status: number) {
  const calls: { headers: Record<string, string> }[] = [];
  const impl = (async (_url: string, init: { headers: Record<string, string> }) => {
    calls.push({ headers: init.headers });
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  process.env.WEBHOOK_AUTO_RECOVERY_ENABLED = 'true';
  process.env.WEBHOOK_QUARANTINE_MAX_SEC = '10';       // low → easy expiry test
  process.env.WEBHOOK_PROBE_BACKOFF_BASE_SEC = '300';
  process.env.WEBHOOK_PROBE_BACKOFF_MAX_SEC = '86400';
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-recovery-'));
  process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
  store = await import('../src/lib/webhooks-store.js');
  delivery = await import('../src/lib/webhook-delivery.js');
});

afterEach(() => {
  try { delivery.stopHealthProbeSweep(); } catch { /* ignore */ }
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
  for (const k of ENVKEYS) { if (ORIGINAL[k] !== undefined) process.env[k] = ORIGINAL[k]!; else delete process.env[k]; }
});

const newSub = () => store.createSubscription({ url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:x' });
const nowS = () => Math.floor(Date.now() / 1000);
async function quarantine(id: number, over: { quarantined_at?: number; next_probe_at?: number; last_probe_at?: number } = {}) {
  const now = nowS();
  await store.setDeliveryState(id, 'quarantined', {
    quarantined_at: over.quarantined_at ?? now,
    next_probe_at: over.next_probe_at ?? now - 1, // due
    last_probe_at: over.last_probe_at ?? null,
  });
}

describe('C4 auto-resume', () => {
  it('a quarantined sub whose endpoint now returns 2xx resumes to active in one sweep', async () => {
    const sub = await newSub();
    await quarantine(sub.id);
    const { impl } = mockFetch(200);
    const r = await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: okLookup }, cfg);
    expect(r.resumed).toBe(1);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('active');
    expect(after!.active).toBe(true);
    expect(after!.consecutive_failures).toBe(0);
    expect(after!.last_success_at).not.toBeNull();
    expect(after!.next_probe_at).toBeNull();
  });

  it('the probe carries the X-AlgoVault-Event: health_probe header', async () => {
    const sub = await newSub();
    await quarantine(sub.id);
    const { impl, calls } = mockFetch(200);
    await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: okLookup }, cfg);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['X-AlgoVault-Event']).toBe('health_probe');
    expect(calls[0].headers['X-AlgoVault-Signature']).toBeTruthy(); // still HMAC-signed
  });
});

describe('C4 still-dead → back-off then expiry', () => {
  it('a 5xx probe grows next_probe_at (back-off) and keeps the sub quarantined', async () => {
    const sub = await newSub();
    await quarantine(sub.id); // fresh: last_probe_at null → seed 300 → next 600
    const before = nowS();
    const { impl } = mockFetch(503);
    const r = await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: okLookup }, cfg);
    expect(r.backedOff).toBe(1);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('quarantined');
    expect(after!.next_probe_at!).toBeGreaterThan(before + 500); // ~now+600
    expect(after!.last_probe_at).not.toBeNull();
  });

  it('quarantined longer than WEBHOOK_QUARANTINE_MAX_SEC → disabled(quarantine_expired)', async () => {
    const sub = await newSub();
    await quarantine(sub.id, { quarantined_at: nowS() - 100 }); // > MAX(10)
    const { impl } = mockFetch(503);
    const r = await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: okLookup }, cfg);
    expect(r.disabled).toBe(1);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('disabled');
    expect(after!.disabled_reason).toBe('quarantine_expired');
  });
});

describe('C4 SSRF guard in the probe (Q1 — internal target is transient, not instant-disable)', () => {
  it('a now-internal target → egress_block → back-off (stays quarantined this sweep)', async () => {
    const sub = await newSub();
    await quarantine(sub.id, { quarantined_at: nowS() }); // fresh (not expired)
    const { impl } = mockFetch(200); // unused — guard throws before fetch
    const r = await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: blockedLookup }, cfg);
    expect(r.disabled).toBe(0);
    expect(r.backedOff).toBe(1);
    expect((await store.getSubscription(sub.id))!.delivery_state).toBe('quarantined');
  });
});

describe('C4 permanent 410 probe', () => {
  it('a 410 probe → disabled(permanent_http_410)', async () => {
    const sub = await newSub();
    await quarantine(sub.id);
    const { impl } = mockFetch(410);
    const r = await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: okLookup }, cfg);
    expect(r.disabled).toBe(1);
    const after = await store.getSubscription(sub.id);
    expect(after!.delivery_state).toBe('disabled');
    expect(after!.disabled_reason).toBe('permanent_http_410');
  });
});

describe('C4 sweep only touches DUE quarantined subs', () => {
  it('a not-yet-due quarantined sub is skipped', async () => {
    const sub = await newSub();
    await quarantine(sub.id, { next_probe_at: nowS() + 9999 }); // future
    const { impl } = mockFetch(200);
    const r = await delivery.runHealthProbeSweep({ fetchImpl: impl, lookup: okLookup }, cfg);
    expect(r.probed).toBe(0);
    expect((await store.getSubscription(sub.id))!.delivery_state).toBe('quarantined');
  });
});

describe('C4 firewall — flag OFF means no sweep worker', () => {
  it('startHealthProbeSweep no-ops when WEBHOOK_AUTO_RECOVERY_ENABLED=0', () => {
    process.env.WEBHOOK_AUTO_RECOVERY_ENABLED = '0';
    delivery.startHealthProbeSweep(60_000);
    expect(delivery.isSweepRunning()).toBe(false);
  });

  it('startHealthProbeSweep starts when enabled', () => {
    process.env.WEBHOOK_AUTO_RECOVERY_ENABLED = 'true';
    delivery.startHealthProbeSweep(60_000);
    expect(delivery.isSweepRunning()).toBe(true);
    delivery.stopHealthProbeSweep();
    expect(delivery.isSweepRunning()).toBe(false);
  });
});
