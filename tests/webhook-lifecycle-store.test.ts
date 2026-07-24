/**
 * OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 C2 — lifecycle schema + store helpers.
 *
 * Mirrors tests/webhooks-store.test.ts: HOME→mkdtemp BEFORE dynamic import so the
 * SQLite DB lands in the temp dir; vi.resetModules() per test. DATABASE_URL unset
 * → SQLite backend. PG+SQLite parity is by shared code (same helpers/DDL/migration
 * descriptors); the PG side is additionally verified live via the C2 SSH pre-apply.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_QUARANTINE_AFTER = process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES;
const ORIGINAL_PROBE_BASE = process.env.WEBHOOK_PROBE_BACKOFF_BASE_SEC;

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  // Small deterministic thresholds for the transient path (default is 10).
  process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES = '3';
  process.env.WEBHOOK_PROBE_BACKOFF_BASE_SEC = '300';
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-lifecycle-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
  store = await import('../src/lib/webhooks-store.js');
});

afterEach(() => {
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME; else delete process.env.HOME;
  if (ORIGINAL_USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL_USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_QUARANTINE_AFTER !== undefined) process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES = ORIGINAL_QUARANTINE_AFTER; else delete process.env.WEBHOOK_QUARANTINE_AFTER_FAILURES;
  if (ORIGINAL_PROBE_BASE !== undefined) process.env.WEBHOOK_PROBE_BACKOFF_BASE_SEC = ORIGINAL_PROBE_BASE; else delete process.env.WEBHOOK_PROBE_BACKOFF_BASE_SEC;
});

const baseInput = () => ({
  url: 'https://sink.example.com/hook',
  events: ['trade_call'] as ('trade_call')[],
  tier: 'free',
  ownerKey: 'free:abc123',
});

async function newSub() {
  return store.createSubscription(baseInput());
}

describe('C2 schema: additive lifecycle columns', () => {
  it('webhook_subscriptions gains all 7 lifecycle columns', async () => {
    await store.listSubscriptions();
    const cols = await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(webhook_subscriptions)', []);
    const names = new Set(cols.map(r => r.name));
    for (const c of ['delivery_state', 'failure_class', 'quarantined_at', 'next_probe_at', 'last_probe_at', 'last_success_at', 'disabled_reason']) {
      expect(names.has(c), `missing column ${c}`).toBe(true);
    }
    // Existing columns preserved.
    for (const c of ['active', 'consecutive_failures', 'last_delivered_at']) {
      expect(names.has(c), `dropped column ${c}`).toBe(true);
    }
  });

  it('a fresh subscription defaults to delivery_state=active, active=true, null scratch', async () => {
    const sub = await store.getSubscription((await newSub()).id);
    expect(sub!.delivery_state).toBe('active');
    expect(sub!.active).toBe(true);
    expect(sub!.failure_class).toBeNull();
    expect(sub!.quarantined_at).toBeNull();
    expect(sub!.next_probe_at).toBeNull();
    expect(sub!.last_success_at).toBeNull();
    expect(sub!.disabled_reason).toBeNull();
  });
});

describe('C2 single-derivation: active := delivery_state IN (active,degraded)', () => {
  it('isActiveState is the one projection', () => {
    expect(store.isActiveState('active')).toBe(true);
    expect(store.isActiveState('degraded')).toBe(true);
    expect(store.isActiveState('quarantined')).toBe(false);
    expect(store.isActiveState('disabled')).toBe(false);
  });

  it.each([
    ['active', true],
    ['degraded', true],
    ['quarantined', false],
    ['disabled', false],
  ] as const)('setDeliveryState(%s) projects active=%s in the same write', async (state, expected) => {
    const id = (await newSub()).id;
    await store.setDeliveryState(id, state);
    const sub = await store.getSubscription(id);
    expect(sub!.delivery_state).toBe(state);
    expect(sub!.active).toBe(expected);
  });

  it('setDeliveryState sets present opts and clears present-null opts', async () => {
    const id = (await newSub()).id;
    await store.setDeliveryState(id, 'quarantined', { failure_class: 'http_5xx', quarantined_at: 100, next_probe_at: 400 });
    let sub = await store.getSubscription(id);
    expect(sub!.failure_class).toBe('http_5xx');
    expect(sub!.next_probe_at).toBe(400);
    // Clearing via present-null; absent keys untouched.
    await store.setDeliveryState(id, 'active', { next_probe_at: null });
    sub = await store.getSubscription(id);
    expect(sub!.next_probe_at).toBeNull();
    expect(sub!.failure_class).toBe('http_5xx'); // absent from opts → untouched
  });
});

describe('C2 recordFailureAndTransition (transient → degraded → quarantined)', () => {
  it('degrades below threshold, quarantines at threshold, sets next_probe_at', async () => {
    const id = (await newSub()).id;
    const now = 1_700_000_000;

    const t1 = await store.recordFailureAndTransition(id, 'http_5xx', now);
    expect(t1.state).toBe('degraded');
    expect(t1.consecutiveFailures).toBe(1);
    expect((await store.getSubscription(id))!.active).toBe(true); // degraded still delivers

    const t2 = await store.recordFailureAndTransition(id, 'http_4xx', now);
    expect(t2.state).toBe('degraded');

    const t3 = await store.recordFailureAndTransition(id, 'timeout', now);
    expect(t3.state).toBe('quarantined');
    expect(t3.quarantined).toBe(true);
    const sub = await store.getSubscription(id);
    expect(sub!.delivery_state).toBe('quarantined');
    expect(sub!.active).toBe(false);               // quarantined → paused
    expect(sub!.quarantined_at).toBe(now);
    expect(sub!.next_probe_at).toBe(now + 300);     // base backoff
    expect(sub!.failure_class).toBe('timeout');     // last granular cause stamped
  });
});

describe('C2 recordFailureAndTransition (permanent — HTTP 410 only)', () => {
  it('http_410 hard-disables immediately with permanent_http_410', async () => {
    const id = (await newSub()).id;
    const t = await store.recordFailureAndTransition(id, 'http_410', 1_700_000_000);
    expect(t.state).toBe('disabled');
    expect(t.disabled).toBe(true);
    const sub = await store.getSubscription(id);
    expect(sub!.delivery_state).toBe('disabled');
    expect(sub!.active).toBe(false);
    expect(sub!.disabled_reason).toBe('permanent_http_410');
    expect(sub!.failure_class).toBe('http_410');
  });

  it('egress_block / tls / conn are TRANSIENT (NOT permanent) — Q1 ratification', async () => {
    for (const cls of ['egress_block', 'tls', 'conn', 'http_5xx']) {
      const id = (await newSub()).id;
      const t = await store.recordFailureAndTransition(id, cls, 1_700_000_000);
      expect(t.disabled, `${cls} must not hard-disable`).toBe(false);
      expect(t.state).toBe('degraded');
    }
  });
});

describe('C2 recordProbeResult (auto-resume vs stamp-only)', () => {
  it('ok=true auto-resumes to active, stamps last_success_at, NOT last_delivered_at, clears scratch', async () => {
    const id = (await newSub()).id;
    await store.recordFailureAndTransition(id, 'http_5xx', 1_700_000_000);
    await store.recordFailureAndTransition(id, 'http_5xx', 1_700_000_000);
    await store.recordFailureAndTransition(id, 'http_5xx', 1_700_000_000); // → quarantined
    const before = await store.getSubscription(id);
    expect(before!.last_delivered_at).toBeNull();

    await store.recordProbeResult(id, true, 1_700_000_500);
    const sub = await store.getSubscription(id);
    expect(sub!.delivery_state).toBe('active');
    expect(sub!.active).toBe(true);
    expect(sub!.consecutive_failures).toBe(0);
    expect(sub!.last_success_at).toBe(1_700_000_500);
    expect(sub!.last_delivered_at).toBeNull();       // a probe is NOT a delivery (Q3)
    expect(sub!.quarantined_at).toBeNull();
    expect(sub!.next_probe_at).toBeNull();
    expect(sub!.failure_class).toBeNull();
  });

  it('ok=false stamps last_probe_at only, leaves state untouched', async () => {
    const id = (await newSub()).id;
    await store.recordFailureAndTransition(id, 'http_5xx', 1_700_000_000);
    await store.recordFailureAndTransition(id, 'http_5xx', 1_700_000_000);
    await store.recordFailureAndTransition(id, 'http_5xx', 1_700_000_000); // quarantined
    await store.recordProbeResult(id, false, 1_700_000_900);
    const sub = await store.getSubscription(id);
    expect(sub!.delivery_state).toBe('quarantined');  // unchanged
    expect(sub!.last_probe_at).toBe(1_700_000_900);
  });
});

describe('C2 recordDeliverySuccess (real delivery → full heal, stamps BOTH timestamps)', () => {
  it('resets a degraded sub to active and stamps last_delivered_at AND last_success_at', async () => {
    const id = (await newSub()).id;
    await store.recordFailureAndTransition(id, 'http_5xx', 1_700_000_000); // degraded
    await store.recordDeliverySuccess(id);
    const sub = await store.getSubscription(id);
    expect(sub!.delivery_state).toBe('active');
    expect(sub!.active).toBe(true);
    expect(sub!.consecutive_failures).toBe(0);
    expect(sub!.last_delivered_at).not.toBeNull();
    expect(sub!.last_success_at).not.toBeNull();      // Q3: both stamped
    expect(sub!.failure_class).toBeNull();
  });
});

describe('C2 getQuarantinedDue', () => {
  it('returns only quarantined subs whose next_probe_at <= now', async () => {
    const dueId = (await newSub()).id;
    await store.setDeliveryState(dueId, 'quarantined', { quarantined_at: 1, next_probe_at: 1_000 });

    const futureId = (await newSub()).id;
    await store.setDeliveryState(futureId, 'quarantined', { quarantined_at: 1, next_probe_at: 9_999 });

    const degradedId = (await newSub()).id; // not quarantined
    await store.setDeliveryState(degradedId, 'degraded', { next_probe_at: 1 });

    const due = await store.getQuarantinedDue(5_000, 100);
    const ids = due.map(s => s.id);
    expect(ids).toContain(dueId);
    expect(ids).not.toContain(futureId);   // next_probe_at in the future
    expect(ids).not.toContain(degradedId); // wrong state
  });
});

describe('C2 backfillLegacyWebhookLifecycle (Mr.1 Q2 — quarantine-seed, idempotent)', () => {
  it('seeds legacy active=false rows as quarantined/legacy, leaves healthy rows, is idempotent', async () => {
    // Healthy sub (untouched).
    const healthyId = (await newSub()).id;
    // Legacy-disabled sub: simulate the OLD bumpFailureAndMaybeDisable (active=false,
    // delivery_state left at the DEFAULT 'active').
    const legacyId = (await newSub()).id;
    await perfDb.dbQuery('UPDATE webhook_subscriptions SET active = 0 WHERE id = ? RETURNING id', [legacyId]);

    const converted = await store.backfillLegacyWebhookLifecycle(1_700_000_000);
    expect(converted).toBe(1);

    const legacy = await store.getSubscription(legacyId);
    expect(legacy!.delivery_state).toBe('quarantined');
    expect(legacy!.failure_class).toBe('legacy');
    expect(legacy!.quarantined_at).toBe(1_700_000_000);
    expect(legacy!.next_probe_at).toBe(1_700_000_000); // probe on first sweep

    const healthy = await store.getSubscription(healthyId);
    expect(healthy!.delivery_state).toBe('active');    // untouched
    expect(healthy!.active).toBe(true);

    // Idempotent: a second run converts nothing.
    expect(await store.backfillLegacyWebhookLifecycle(1_700_000_000)).toBe(0);
  });

  it('does NOT touch a row already given a real lifecycle state (disabled)', async () => {
    const id = (await newSub()).id;
    await store.setDeliveryState(id, 'disabled', { disabled_reason: 'permanent_http_410' });
    expect(await store.backfillLegacyWebhookLifecycle(1_700_000_000)).toBe(0);
    expect((await store.getSubscription(id))!.delivery_state).toBe('disabled');
  });
});
