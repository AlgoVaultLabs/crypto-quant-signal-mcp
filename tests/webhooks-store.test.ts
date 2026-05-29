/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 C2 — webhooks-store unit suite.
 *
 * Strategy mirrors tests/performance-db-migration.test.ts: redirect HOME to a
 * mkdtempSync dir BEFORE dynamically importing the modules so the SQLite DB
 * resolves to the temp dir; vi.resetModules() per test for isolation.
 * DATABASE_URL is unset → SQLite backend.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhooks-store-'));
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
});

const baseInput = () => ({
  url: 'https://sink.example.com/hook',
  events: ['trade_call', 'regime_shift'] as ('trade_call' | 'regime_shift')[],
  tier: 'free',
  ownerKey: 'free:abc123',
});

const sampleEventData = (overrides = {}) => ({
  type: 'trade_call' as const,
  coin: 'BTC',
  timeframe: '1h',
  exchange: 'HL',
  call: 'BUY',
  confidence: 72,
  regime: 'TRENDING_UP',
  price_at_call: 50000,
  signal_hash: '0xabc',
  created_at: 1700000000,
  ...overrides,
});

describe('webhooks-store: schema', () => {
  it('creates webhook_subscriptions + webhook_deliveries with expected columns', async () => {
    // Trigger getBackend() via a query.
    await store.listSubscriptions();
    const subCols = await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(webhook_subscriptions)', []);
    const subNames = new Set(subCols.map(r => r.name));
    for (const c of ['id', 'url', 'secret', 'events', 'assets', 'timeframes', 'min_confidence', 'tier', 'owner_key', 'active', 'consecutive_failures', 'created_at', 'last_delivered_at']) {
      expect(subNames.has(c), `webhook_subscriptions.${c}`).toBe(true);
    }
    const delCols = await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(webhook_deliveries)', []);
    const delNames = new Set(delCols.map(r => r.name));
    for (const c of ['id', 'subscription_id', 'event_id', 'event_type', 'event_data', 'status', 'attempts', 'last_attempt_at', 'response_code', 'created_at']) {
      expect(delNames.has(c), `webhook_deliveries.${c}`).toBe(true);
    }
  });
});

describe('webhooks-store: subscriptions CRUD', () => {
  it('createSubscription returns a row with id, secret, parsed events', async () => {
    const sub = await store.createSubscription(baseInput());
    expect(sub.id).toBeGreaterThan(0);
    expect(sub.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(sub.events).toEqual(['trade_call', 'regime_shift']);
    expect(sub.assets).toBeNull();        // not supplied → all
    expect(sub.timeframes).toBeNull();
    expect(sub.active).toBe(true);
    expect(sub.consecutive_failures).toBe(0);
    expect(sub.owner_key).toBe('free:abc123');
  });

  it('stores assets/timeframes/min_confidence when supplied', async () => {
    const sub = await store.createSubscription({
      ...baseInput(),
      assets: ['BTC', 'ETH'],
      timeframes: ['1h'],
      minConfidence: 60,
    });
    expect(sub.assets).toEqual(['BTC', 'ETH']);
    expect(sub.timeframes).toEqual(['1h']);
    expect(sub.min_confidence).toBe(60);
  });

  it('listSubscriptions returns created subs and scopes by ownerKey', async () => {
    await store.createSubscription({ ...baseInput(), ownerKey: 'owner-A' });
    await store.createSubscription({ ...baseInput(), ownerKey: 'owner-B' });
    const all = await store.listSubscriptions();
    expect(all.length).toBe(2);
    const onlyA = await store.listSubscriptions('owner-A');
    expect(onlyA.length).toBe(1);
    expect(onlyA[0].owner_key).toBe('owner-A');
  });

  it('listActiveSubscriptions excludes disabled subs', async () => {
    const sub = await store.createSubscription(baseInput());
    expect((await store.listActiveSubscriptions()).length).toBe(1);
    await store.bumpFailureAndMaybeDisable(sub.id, 1); // disable immediately
    expect((await store.listActiveSubscriptions()).length).toBe(0);
  });

  it('deleteSubscription removes the row; owner-scoped delete enforces ownership', async () => {
    const sub = await store.createSubscription({ ...baseInput(), ownerKey: 'owner-A' });
    // Wrong owner → no delete.
    expect(await store.deleteSubscription(sub.id, 'owner-B')).toBe(false);
    expect((await store.listSubscriptions()).length).toBe(1);
    // Correct owner → deleted.
    expect(await store.deleteSubscription(sub.id, 'owner-A')).toBe(true);
    expect((await store.listSubscriptions()).length).toBe(0);
  });
});

describe('webhooks-store: delivery ledger idempotency', () => {
  it('enqueueDelivery is idempotent — duplicate (sub,event) returns claimed:false, one row', async () => {
    const sub = await store.createSubscription(baseInput());
    const first = await store.enqueueDelivery({
      subscriptionId: sub.id, eventId: 'call:0xabc', eventType: 'trade_call', eventData: sampleEventData(),
    });
    expect(first.claimed).toBe(true);
    expect(first.deliveryId).toBeGreaterThan(0);

    const dup = await store.enqueueDelivery({
      subscriptionId: sub.id, eventId: 'call:0xabc', eventType: 'trade_call', eventData: sampleEventData(),
    });
    expect(dup.claimed).toBe(false);
    expect(dup.deliveryId).toBeNull();

    const pending = await store.pendingDeliveries(100);
    expect(pending.filter(d => d.subscription_id === sub.id).length).toBe(1);
  });

  it('tryClaimDelivery returns true for a fresh key and false after enqueue (dup)', async () => {
    const sub = await store.createSubscription(baseInput());
    expect(await store.tryClaimDelivery(sub.id, 'regime:BTC:1h:HL:1700000000')).toBe(true);
    await store.enqueueDelivery({
      subscriptionId: sub.id, eventId: 'regime:BTC:1h:HL:1700000000', eventType: 'regime_shift',
      eventData: sampleEventData({ type: 'regime_shift', prior_regime: 'TRENDING_UP', regime: 'RANGING' }),
    });
    expect(await store.tryClaimDelivery(sub.id, 'regime:BTC:1h:HL:1700000000')).toBe(false);
  });

  it('the same event_id across different subscriptions enqueues independently', async () => {
    const a = await store.createSubscription({ ...baseInput(), ownerKey: 'A' });
    const b = await store.createSubscription({ ...baseInput(), ownerKey: 'B' });
    const ra = await store.enqueueDelivery({ subscriptionId: a.id, eventId: 'call:0xabc', eventType: 'trade_call', eventData: sampleEventData() });
    const rb = await store.enqueueDelivery({ subscriptionId: b.id, eventId: 'call:0xabc', eventType: 'trade_call', eventData: sampleEventData() });
    expect(ra.claimed).toBe(true);
    expect(rb.claimed).toBe(true);
    expect((await store.pendingDeliveries(100)).length).toBe(2);
  });
});

describe('webhooks-store: delivery state + subscription health', () => {
  it('markDelivery updates status, attempts, response_code', async () => {
    const sub = await store.createSubscription(baseInput());
    const { deliveryId } = await store.enqueueDelivery({
      subscriptionId: sub.id, eventId: 'call:0xabc', eventType: 'trade_call', eventData: sampleEventData(),
    });
    await store.markDelivery(deliveryId!, 'delivered', { attempts: 1, responseCode: 200 });
    const after = await store.pendingDeliveries(100);
    expect(after.length).toBe(0); // no longer pending

    const rows = await perfDb.dbQuery<{ status: string; attempts: number; response_code: number }>(
      'SELECT status, attempts, response_code FROM webhook_deliveries WHERE id = ?', [deliveryId],
    );
    expect(rows[0].status).toBe('delivered');
    expect(Number(rows[0].attempts)).toBe(1);
    expect(Number(rows[0].response_code)).toBe(200);
  });

  it('bumpFailureAndMaybeDisable disables at threshold; recordDeliverySuccess resets', async () => {
    const sub = await store.createSubscription(baseInput());
    const r1 = await store.bumpFailureAndMaybeDisable(sub.id, 3);
    expect(r1).toEqual({ disabled: false, consecutiveFailures: 1 });
    const r2 = await store.bumpFailureAndMaybeDisable(sub.id, 3);
    expect(r2.consecutiveFailures).toBe(2);
    expect(r2.disabled).toBe(false);
    const r3 = await store.bumpFailureAndMaybeDisable(sub.id, 3);
    expect(r3).toEqual({ disabled: true, consecutiveFailures: 3 });

    const disabled = await store.getSubscription(sub.id);
    expect(disabled?.active).toBe(false);

    // Recovery path: success resets the counter (operator re-enables active separately).
    await store.recordDeliverySuccess(sub.id);
    const recovered = await store.getSubscription(sub.id);
    expect(recovered?.consecutive_failures).toBe(0);
    expect(recovered?.last_delivered_at).toBeGreaterThan(0);
  });
});
