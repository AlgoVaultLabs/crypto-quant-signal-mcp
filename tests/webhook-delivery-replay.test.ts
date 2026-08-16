/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH2e — webhook replay-safety, the ONLY behaviour this wave
 * changes for webhooks.
 *
 * Before it, `deliverOne` charged via `trackCallByKey`, which has no idempotency key: redelivering
 * the same `delivery.id` charged the owner a SECOND time. Now the charge goes through
 * `consumeEntitlement` keyed on `webhook:<delivery.id>`.
 *
 * This file is NEW rather than an edit to tests/webhook-delivery.test.ts on purpose: that suite
 * must pass UNMODIFIED, which is the acceptance criterion proving nothing else about webhooks
 * moved. Adding assertions to it would destroy that evidence.
 *
 * It drives the REAL `deliverOne` twice rather than spying on `consumeEntitlement`, because a spy
 * would prove only that a helper exists — CLAUDE.md: *"a unit test calling a helper directly
 * cannot prove anything CALLS it."* The subject here is the wiring.
 *
 * Harness copied from tests/webhook-delivery.test.ts (SQLite temp-HOME, injected fetch, noop sleep).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
};

const okLookup = async (): Promise<{ address: string; family: number }[]> => [
  { address: '93.184.216.34', family: 4 },
];
const noopSleep = async () => {};

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');
let delivery: typeof import('../src/lib/webhook-delivery.js');
let license: typeof import('../src/lib/license.js');

const eventData = (over = {}) => ({
  type: 'trade_call' as const,
  coin: 'BTC', timeframe: '1h', exchange: 'HL', call: 'BUY', confidence: 72,
  regime: 'TRENDING_UP', price_at_call: 50000, signal_hash: '0xdeadbeef',
  created_at: 1_700_000_000, ...over,
});

function mockFetch(statuses: number[]) {
  let i = 0;
  const impl = (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return impl;
}

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-replay-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
  store = await import('../src/lib/webhooks-store.js');
  delivery = await import('../src/lib/webhook-delivery.js');
  license = await import('../src/lib/license.js');
});

afterEach(() => {
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
});

async function seed(ownerKey: string, over = {}) {
  const sub = await store.createSubscription({
    url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'starter', ownerKey,
  });
  const { deliveryId } = await store.enqueueDelivery({
    subscriptionId: sub.id, eventId: `call:${ownerKey}`, eventType: 'trade_call', eventData: eventData(over),
  });
  const d = (await store.pendingDeliveries(10)).find((x) => x.id === deliveryId)!;
  return { sub, d };
}

describe('webhook delivery is replay-safe (the ONE behaviour change)', () => {
  it('redelivering the SAME delivery.id charges the owner exactly once', async () => {
    const ownerKey = `av_replay_${Date.now()}`;
    const { d } = await seed(ownerKey);
    const impl = mockFetch([200]);

    const first = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep, lookup: okLookup });
    expect(first.status).toBe('delivered');
    const afterFirst = license.checkQuotaByKey(ownerKey, 'starter').used;
    expect(afterFirst).toBeGreaterThan(0); // vacuity guard: it charged at all

    // Same delivery row, delivered again — the shape a worker retry or a double-drain produces.
    const second = await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep, lookup: okLookup });
    expect(second.status).toBe('delivered');
    expect(
      license.checkQuotaByKey(ownerKey, 'starter').used,
      'a redelivery must not charge a second time',
    ).toBe(afterFirst);
  });

  it('the ledger records ONE row for that delivery, tagged to the webhook channel', async () => {
    const ownerKey = `av_ledger_${Date.now()}`;
    const { d } = await seed(ownerKey);
    const impl = mockFetch([200]);
    await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep, lookup: okLookup });
    await delivery.deliverOne(d, { fetchImpl: impl, sleep: noopSleep, lookup: okLookup });

    const rows = await perfDb.dbQuery<{ idem_key: string; channel: string }>(
      'SELECT idem_key, channel FROM entitlement_debits WHERE tracker_key = ?',
      [ownerKey],
    );
    expect(rows).toHaveLength(1);
    // Pins the WIRING: the key deliverOne passes is the natural per-delivery one.
    expect(rows[0].idem_key).toBe(`webhook:${d.id}`);
    expect(rows[0].channel).toBe('webhook');
  });

  it('a scan_digest still charges max(1, calls.length) — the units rule is untouched', async () => {
    const ownerKey = `av_units_${Date.now()}`;
    const sub = await store.createSubscription({
      url: 'https://sink.example.com/h', events: ['scan_digest'], tier: 'starter', ownerKey,
    });
    const { deliveryId } = await store.enqueueDelivery({
      subscriptionId: sub.id, eventId: 'scan:1', eventType: 'scan_digest',
      eventData: { type: 'scan_digest', cadence: '15m', timeframe: '15m', exchange: 'HL',
        calls: [{ coin: 'BTC' }, { coin: 'ETH' }, { coin: 'SOL' }] } as never,
    });
    const d = (await store.pendingDeliveries(10)).find((x) => x.id === deliveryId)!;
    await delivery.deliverOne(d, { fetchImpl: mockFetch([200]), sleep: noopSleep, lookup: okLookup });

    expect(license.checkQuotaByKey(ownerKey, 'starter').used).toBe(3);
    const rows = await perfDb.dbQuery<{ units: number }>(
      'SELECT units FROM entitlement_debits WHERE tracker_key = ?', [ownerKey],
    );
    expect(Number(rows[0].units)).toBe(3);
  });

  it('an exhausted owner still PAUSES, and the pause claims nothing', async () => {
    const ownerKey = `av_paused_${Date.now()}`;
    const { d } = await seed(ownerKey);
    const { PLANS } = await import('../src/lib/plans.js');
    license.trackCallByKey(ownerKey, 'starter', PLANS.starter.monthlyCalls);

    const res = await delivery.deliverOne(d, { fetchImpl: mockFetch([200]), sleep: noopSleep, lookup: okLookup });
    expect(res.status).toBe('pending'); // PAUSE semantics unchanged
    expect(res.suggested_action).toContain('quota exhausted');

    // Nothing claimed on a pause — so the same delivery is servable after a reset/upgrade.
    //
    // The table may not EXIST here, and that is the strongest possible form of this assertion:
    // the ledger's DDL runs lazily inside `consumeEntitlement`, so an absent table proves the
    // charge path was never entered at all. Absent and empty both mean "claimed nothing".
    let claimed: unknown[];
    try {
      claimed = await perfDb.dbQuery<{ idem_key: string }>(
        'SELECT idem_key FROM entitlement_debits WHERE tracker_key = ?', [ownerKey],
      );
    } catch (err) {
      expect(String(err)).toContain('no such table');
      claimed = [];
    }
    expect(claimed).toHaveLength(0);
  });
});
