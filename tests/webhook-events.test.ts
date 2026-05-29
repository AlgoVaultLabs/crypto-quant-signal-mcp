/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 C3 — event detection + fan-out + cooldown.
 *
 * SQLite temp-HOME harness. WEBHOOK_DELIVERY_ENABLED='true'. We insert `signals`
 * rows directly (no hook) and drive onSignalRecorded() explicitly so the
 * fire-and-forget path is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
  FLAG: process.env.WEBHOOK_DELIVERY_ENABLED,
  COOLDOWN: process.env.WEBHOOK_REGIME_COOLDOWN_SEC,
};

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let store: typeof import('../src/lib/webhooks-store.js');
let events: typeof import('../src/lib/webhook-events.js');

async function insertSignalRow(p: {
  coin: string; signal: string; confidence: number; timeframe: string; exchange: string;
  price: number; createdAt: number; signalHash: string | null; regime: string | null;
}) {
  await perfDb.dbQuery(
    `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, signal_hash, regime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [p.coin, p.signal, p.confidence, p.timeframe, p.exchange, p.price, p.createdAt, p.signalHash, p.regime],
  );
}

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  process.env.WEBHOOK_DELIVERY_ENABLED = 'true';
  delete process.env.WEBHOOK_REGIME_COOLDOWN_SEC; // use default 3600
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-events-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
  store = await import('../src/lib/webhooks-store.js');
  events = await import('../src/lib/webhook-events.js');
});

afterEach(() => {
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
  if (ORIGINAL.FLAG !== undefined) process.env.WEBHOOK_DELIVERY_ENABLED = ORIGINAL.FLAG; else delete process.env.WEBHOOK_DELIVERY_ENABLED;
  if (ORIGINAL.COOLDOWN !== undefined) process.env.WEBHOOK_REGIME_COOLDOWN_SEC = ORIGINAL.COOLDOWN; else delete process.env.WEBHOOK_REGIME_COOLDOWN_SEC;
});

const sub = () => store.createSubscription({
  url: 'https://sink.example.com/hook',
  events: ['trade_call', 'regime_shift'],
  tier: 'free',
  ownerKey: 'free:test',
});

describe('webhook-events: trade_call detection', () => {
  it('synthetic BUY row → exactly 1 trade_call enqueued', async () => {
    await sub();
    const T = 1_700_000_000;
    await insertSignalRow({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', price: 50000, createdAt: T, signalHash: '0xbuy', regime: 'TRENDING_UP' });
    await events.onSignalRecorded({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', priceAtSignal: 50000, signalHash: '0xbuy', regime: 'TRENDING_UP', createdAt: T });

    const pending = await store.pendingDeliveries(100);
    expect(pending.length).toBe(1);
    expect(pending[0].event_type).toBe('trade_call');
    expect(pending[0].event_id).toBe('call:0xbuy');
    const data = JSON.parse(pending[0].event_data);
    expect(data.call).toBe('BUY');
    expect(data.price_at_call).toBe(50000);
  });

  it('HOLD never produces a trade_call (and never reaches here in prod)', async () => {
    await sub();
    const T = 1_700_000_100;
    await events.onSignalRecorded({ coin: 'BTC', signal: 'HOLD', confidence: 40, timeframe: '1h', exchange: 'HL', priceAtSignal: 50000, signalHash: null, regime: 'RANGING', createdAt: T });
    expect((await store.pendingDeliveries(100)).length).toBe(0);
  });
});

describe('webhook-events: regime_shift detection', () => {
  it('TRENDING_UP → RANGING → 1 regime_shift carrying prior_regime', async () => {
    await sub();
    const T0 = 1_700_000_000, T1 = 1_700_003_600;
    await insertSignalRow({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', price: 50000, createdAt: T0, signalHash: '0xprev', regime: 'TRENDING_UP' });
    await insertSignalRow({ coin: 'BTC', signal: 'SELL', confidence: 65, timeframe: '1h', exchange: 'HL', price: 49000, createdAt: T1, signalHash: '0xcur', regime: 'RANGING' });
    await events.onSignalRecorded({ coin: 'BTC', signal: 'SELL', confidence: 65, timeframe: '1h', exchange: 'HL', priceAtSignal: 49000, signalHash: '0xcur', regime: 'RANGING', createdAt: T1 });

    const pending = await store.pendingDeliveries(100);
    const shift = pending.filter(d => d.event_type === 'regime_shift');
    const calls = pending.filter(d => d.event_type === 'trade_call');
    expect(shift.length).toBe(1);
    expect(calls.length).toBe(1); // the SELL also fires a trade_call
    expect(shift[0].event_id).toBe(`regime:BTC:1h:HL:${T1}`);
    const data = JSON.parse(shift[0].event_data);
    expect(data.prior_regime).toBe('TRENDING_UP');
    expect(data.regime).toBe('RANGING');
  });

  it('unchanged regime → 0 regime_shift events', async () => {
    await sub();
    const T0 = 1_700_000_000, T1 = 1_700_003_600;
    await insertSignalRow({ coin: 'ETH', signal: 'BUY', confidence: 70, timeframe: '4h', exchange: 'HL', price: 3000, createdAt: T0, signalHash: '0xa', regime: 'RANGING' });
    await insertSignalRow({ coin: 'ETH', signal: 'BUY', confidence: 71, timeframe: '4h', exchange: 'HL', price: 3010, createdAt: T1, signalHash: '0xb', regime: 'RANGING' });
    await events.onSignalRecorded({ coin: 'ETH', signal: 'BUY', confidence: 71, timeframe: '4h', exchange: 'HL', priceAtSignal: 3010, signalHash: '0xb', regime: 'RANGING', createdAt: T1 });

    const pending = await store.pendingDeliveries(100);
    expect(pending.filter(d => d.event_type === 'regime_shift').length).toBe(0);
    expect(pending.filter(d => d.event_type === 'trade_call').length).toBe(1);
  });

  it('no prior row → no regime_shift (first call for the tuple)', async () => {
    await sub();
    const T = 1_700_000_000;
    await insertSignalRow({ coin: 'SOL', signal: 'BUY', confidence: 80, timeframe: '1h', exchange: 'HL', price: 150, createdAt: T, signalHash: '0xsol', regime: 'TRENDING_UP' });
    await events.onSignalRecorded({ coin: 'SOL', signal: 'BUY', confidence: 80, timeframe: '1h', exchange: 'HL', priceAtSignal: 150, signalHash: '0xsol', regime: 'TRENDING_UP', createdAt: T });
    expect((await store.pendingDeliveries(100)).filter(d => d.event_type === 'regime_shift').length).toBe(0);
  });
});

describe('webhook-events: idempotency, cooldown, filters, flag', () => {
  it('duplicate onSignalRecorded → 0 duplicate deliveries', async () => {
    await sub();
    const T = 1_700_000_000;
    await insertSignalRow({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', price: 50000, createdAt: T, signalHash: '0xbuy', regime: 'TRENDING_UP' });
    const params = { coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', priceAtSignal: 50000, signalHash: '0xbuy', regime: 'TRENDING_UP', createdAt: T };
    await events.onSignalRecorded(params);
    await events.onSignalRecorded(params);
    expect((await store.pendingDeliveries(100)).length).toBe(1);
  });

  it('second regime_shift within cooldown is debounced', async () => {
    await sub();
    const T0 = 1_700_000_000, T1 = 1_700_003_600, T2 = 1_700_003_700;
    await insertSignalRow({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', price: 50000, createdAt: T0, signalHash: '0xp', regime: 'TRENDING_UP' });
    await insertSignalRow({ coin: 'BTC', signal: 'SELL', confidence: 60, timeframe: '1h', exchange: 'HL', price: 49000, createdAt: T1, signalHash: '0xt1', regime: 'RANGING' });
    await events.onSignalRecorded({ coin: 'BTC', signal: 'SELL', confidence: 60, timeframe: '1h', exchange: 'HL', priceAtSignal: 49000, signalHash: '0xt1', regime: 'RANGING', createdAt: T1 });
    // Second flip within cooldown (RANGING → TRENDING_DOWN).
    await insertSignalRow({ coin: 'BTC', signal: 'SELL', confidence: 62, timeframe: '1h', exchange: 'HL', price: 48000, createdAt: T2, signalHash: '0xt2', regime: 'TRENDING_DOWN' });
    await events.onSignalRecorded({ coin: 'BTC', signal: 'SELL', confidence: 62, timeframe: '1h', exchange: 'HL', priceAtSignal: 48000, signalHash: '0xt2', regime: 'TRENDING_DOWN', createdAt: T2 });

    const shifts = (await store.pendingDeliveries(100)).filter(d => d.event_type === 'regime_shift');
    expect(shifts.length).toBe(1); // second shift debounced
  });

  it('asset / timeframe / min_confidence filters exclude non-matching subs', async () => {
    await store.createSubscription({ url: 'https://a', events: ['trade_call'], assets: ['ETH'], tier: 'free', ownerKey: 'A' });
    await store.createSubscription({ url: 'https://b', events: ['trade_call'], timeframes: ['4h'], tier: 'free', ownerKey: 'B' });
    await store.createSubscription({ url: 'https://c', events: ['trade_call'], minConfidence: 80, tier: 'free', ownerKey: 'C' });
    await store.createSubscription({ url: 'https://d', events: ['trade_call'], assets: ['BTC'], minConfidence: 60, tier: 'free', ownerKey: 'D' });
    const T = 1_700_000_000;
    await insertSignalRow({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', price: 50000, createdAt: T, signalHash: '0xbuy', regime: 'TRENDING_UP' });
    await events.onSignalRecorded({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', priceAtSignal: 50000, signalHash: '0xbuy', regime: 'TRENDING_UP', createdAt: T });
    // Only sub D matches (BTC + conf 70 >= 60). A (ETH), B (4h), C (conf<80) excluded.
    const pending = await store.pendingDeliveries(100);
    expect(pending.length).toBe(1);
    const subD = (await store.listSubscriptions('D'))[0];
    expect(pending[0].subscription_id).toBe(subD.id);
  });

  it('flag off → no detection', async () => {
    await sub();
    process.env.WEBHOOK_DELIVERY_ENABLED = 'false';
    const T = 1_700_000_000;
    await insertSignalRow({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', price: 50000, createdAt: T, signalHash: '0xbuy', regime: 'TRENDING_UP' });
    await events.onSignalRecorded({ coin: 'BTC', signal: 'BUY', confidence: 70, timeframe: '1h', exchange: 'HL', priceAtSignal: 50000, signalHash: '0xbuy', regime: 'TRENDING_UP', createdAt: T });
    expect((await store.pendingDeliveries(100)).length).toBe(0);
  });
});
