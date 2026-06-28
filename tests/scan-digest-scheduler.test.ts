/**
 * FEATURE-PARITY-CHANNELS-W1 CH2 — scheduled scan-digest producer + delivery quota.
 *
 * SQLite temp-HOME harness. scanTradeCalls is spied (the scanner is tested
 * elsewhere; here we assert the SCHEDULER's orchestration — due detection, scan
 * dedup, idempotent enqueue per cadence bucket) and deliverOne is driven with an
 * injected fetch + benign resolver so the quota charge (max(1, non-HOLD)) is
 * deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };

const okLookup = async (): Promise<{ address: string; family: number }[]> => [{ address: '93.184.216.34', family: 4 }];
const noopSleep = async () => {};

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');
let delivery: typeof import('../src/lib/webhook-delivery.js');
let scanner: typeof import('../src/lib/trade-call-scanner.js');
let scheduler: typeof import('../src/lib/scan-digest-scheduler.js');
let license: typeof import('../src/lib/license.js');

// A scan result with 3 non-HOLD calls (the quota-unit driver).
const mockScanResult = (over: Record<string, unknown> = {}) => ({
  scanned: 5,
  eligible_non_hold: 3,
  holds: 2,
  errors: 0,
  partial: false,
  calls: [
    { coin: 'BTC', timeframe: '15m', exchange: 'BINANCE', call: 'BUY', confidence: 80, regime: 'TRENDING_UP' },
    { coin: 'ETH', timeframe: '15m', exchange: 'BINANCE', call: 'SELL', confidence: 70, regime: 'TRENDING_DOWN' },
    { coin: 'SOL', timeframe: '15m', exchange: 'BINANCE', call: 'BUY', confidence: 65, regime: 'TRENDING_UP' },
  ],
  ...over,
});

const mkSub = (over: Record<string, unknown> = {}) => ({
  url: 'https://sink.example.com/hook',
  events: ['scan_digest'] as ('scan_digest')[],
  tier: 'starter',
  ownerKey: 'av_starter_default',
  cadence: '1h',
  timeframe: '15m',
  exchange: 'BINANCE',
  topN: 5,
  ...over,
});

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-scan-digest-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
  store = await import('../src/lib/webhooks-store.js');
  delivery = await import('../src/lib/webhook-delivery.js');
  scanner = await import('../src/lib/trade-call-scanner.js');
  scheduler = await import('../src/lib/scan-digest-scheduler.js');
  license = await import('../src/lib/license.js');
});

afterEach(() => {
  vi.restoreAllMocks();
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
});

describe('CH2 — scheduler enqueues one digest per due sub, idempotent per cadence bucket', () => {
  it('tick enqueues a scan_digest delivery; a 2nd tick in the same bucket is a no-op; the next bucket re-fires', async () => {
    const sub = await store.createSubscription(mkSub({ ownerKey: 'av_starter_sched' }));
    const spy = vi.spyOn(scanner, 'scanTradeCalls').mockResolvedValue(mockScanResult() as never);

    const now = 1_700_003_600;
    const r1 = await scheduler.runScanDigestTick(now);
    expect(r1.scans).toBe(1);
    expect(r1.enqueued).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // The pending row is a scan_digest carrying the resolved cadence + the 3 calls.
    const pending = await store.pendingDeliveries(10);
    const mine = pending.find((d) => d.subscription_id === sub.id);
    expect(mine?.event_type).toBe('scan_digest');
    const ed = JSON.parse(mine!.event_data);
    expect(ed.type).toBe('scan_digest');
    expect(ed.cadence).toBe('1h');
    expect(ed.timeframe).toBe('15m');
    expect(ed.calls).toHaveLength(3);

    // Same hour bucket → idempotent (no re-scan, no re-enqueue).
    const r2 = await scheduler.runScanDigestTick(now + 60);
    expect(r2.enqueued).toBe(0);

    // Next hour bucket → a fresh delivery.
    const r3 = await scheduler.runScanDigestTick(now + 3600);
    expect(r3.enqueued).toBe(1);
  });

  it('subs with identical scan params share ONE scan (dedup); each still gets its own delivery', async () => {
    await store.createSubscription(mkSub({ ownerKey: 'av_starter_a' }));
    await store.createSubscription(mkSub({ ownerKey: 'av_starter_b' }));
    const spy = vi.spyOn(scanner, 'scanTradeCalls').mockResolvedValue(mockScanResult() as never);

    const r = await scheduler.runScanDigestTick(1_700_003_600);
    expect(spy).toHaveBeenCalledTimes(1); // one shared scan
    expect(r.enqueued).toBe(2); // two deliveries
  });

  it('a signal-only subscription is never picked up by the scan-digest scheduler', async () => {
    await store.createSubscription({ url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'starter', ownerKey: 'av_starter_sig' });
    const spy = vi.spyOn(scanner, 'scanTradeCalls').mockResolvedValue(mockScanResult() as never);
    const r = await scheduler.runScanDigestTick(1_700_003_600);
    expect(spy).not.toHaveBeenCalled();
    expect(r.enqueued).toBe(0);
  });
});

describe('CH2 — scan_digest delivery charges the scanner rule max(1, non-HOLD)', () => {
  it('a 3-call digest delivery draws 3 quota units against the owner', async () => {
    const sub = await store.createSubscription(mkSub({ ownerKey: 'av_starter_q' }));
    const ev = {
      type: 'scan_digest', cadence: '1h', timeframe: '15m', exchange: 'BINANCE',
      calls: mockScanResult().calls, generated_at: 1_700_003_600,
    };
    const enq = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'scan_digest:test:1', eventType: 'scan_digest', eventData: ev as never });
    const row = {
      id: enq.deliveryId!, subscription_id: sub.id, event_id: 'scan_digest:test:1',
      event_type: 'scan_digest', event_data: JSON.stringify(ev), status: 'pending' as const,
      attempts: 0, last_attempt_at: null, response_code: null, created_at: 1_700_003_600,
    };

    const before = license.checkQuotaByKey('av_starter_q', 'starter').used;
    const fetchImpl = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const result = await delivery.deliverOne(row, { fetchImpl, lookup: okLookup, sleep: noopSleep });
    expect(result.status).toBe('delivered');
    const after = license.checkQuotaByKey('av_starter_q', 'starter').used;
    expect(after - before).toBe(3);
  });

  it('a signal delivery still charges exactly 1 (byte-unchanged)', async () => {
    const sub = await store.createSubscription({ url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'starter', ownerKey: 'av_starter_sig1' });
    const ev = { type: 'trade_call', coin: 'BTC', timeframe: '1h', exchange: 'HL', call: 'BUY', confidence: 72, regime: 'TRENDING_UP', price_at_call: 50000, signal_hash: '0xabc', created_at: 1_700_003_600 };
    const enq = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:0xabc', eventType: 'trade_call', eventData: ev as never });
    const row = {
      id: enq.deliveryId!, subscription_id: sub.id, event_id: 'call:0xabc',
      event_type: 'trade_call', event_data: JSON.stringify(ev), status: 'pending' as const,
      attempts: 0, last_attempt_at: null, response_code: null, created_at: 1_700_003_600,
    };
    const before = license.checkQuotaByKey('av_starter_sig1', 'starter').used;
    const fetchImpl = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    await delivery.deliverOne(row, { fetchImpl, lookup: okLookup, sleep: noopSleep });
    const after = license.checkQuotaByKey('av_starter_sig1', 'starter').used;
    expect(after - before).toBe(1);
  });
});

describe('SCAN-DIGEST-MCP-PARITY-W1 CH2 — scan_digest projects from the enriched scan', () => {
  const enrichedCalls = [
    {
      coin: 'BTC', timeframe: '15m', exchange: 'BINANCE', call: 'BUY', confidence: 80, regime: 'TRENDING_UP',
      price: 50000, factors: [{ factor: 'trend_persistence', direction: 'neutral', value: 'HIGH' }],
      reasoning: 'Trending regime, upward bias.', oi_change_window: '24h',
    },
  ];

  it('the scheduler opts into enrichment (includeReasoning:true) so calls[] carry the digest fields', async () => {
    await store.createSubscription(mkSub({ ownerKey: 'av_starter_enr' }));
    const spy = vi
      .spyOn(scanner, 'scanTradeCalls')
      .mockResolvedValue(mockScanResult({ scanned: 1, eligible_non_hold: 1, holds: 0, calls: enrichedCalls }) as never);

    await scheduler.runScanDigestTick(1_700_003_600);

    // The ONE CH2 change: the scheduler requests the enriched projection.
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ includeReasoning: true }));

    // The enriched fields flow through buildPayload → event_data.calls (additive — no
    // separate assembly; existing subscribers' parsers are unaffected).
    const pending = await store.pendingDeliveries(10);
    const ed = JSON.parse(pending[0].event_data);
    expect(ed.type).toBe('scan_digest');
    expect(ed.calls[0].price).toBe(50000);
    expect(ed.calls[0].factors).toBeDefined();
    expect(ed.calls[0].reasoning).toContain('Trending');
    expect(ed.calls[0].oi_change_window).toBe('24h');
  });

  it('trade_call delivery shape is byte-unchanged (the firewall — scan-only change)', async () => {
    const sub = await store.createSubscription({ url: 'https://sink.example.com/h', events: ['trade_call'], tier: 'starter', ownerKey: 'av_starter_fw' });
    const ev = { type: 'trade_call', coin: 'BTC', timeframe: '1h', exchange: 'HL', call: 'BUY', confidence: 72, regime: 'TRENDING_UP', price_at_call: 50000, signal_hash: '0xfw', created_at: 1_700_003_600 };
    const enq = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:0xfw', eventType: 'trade_call', eventData: ev as never });
    const payload = delivery.buildPayload(ev as never, enq.deliveryId!);
    // trade_call payload carries NO scan-digest enrichment keys.
    const json = JSON.stringify(payload);
    expect(json).not.toContain('"factors"');
    expect(json).not.toContain('"oi_change_window"');
    expect((payload as { event: string }).event).toBe('trade_call');
  });
});
