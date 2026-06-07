/**
 * WEBHOOK-HARDENING-W1 C2 — SSRF egress guard.
 *
 * Unit: IP-class classification, sync assertEgressAllowed (scheme/creds/literal-IP),
 * async resolveAndAssertEgress (DNS-rebind via injected lookup).
 * Integration: a blocked delivery is marked `dead` with 0 quota charged + 0
 * HTTP attempts; postWithTimeout sets redirect:'error'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  assertEgressAllowed,
  resolveAndAssertEgress,
  EgressBlockedError,
  classifyIpv4,
  classifyIpv6,
} from '../src/lib/webhook-ssrf.js';

const ORIGINAL_SSRF = process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK;
beforeEach(() => { delete process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK; }); // prod policy by default
afterEach(() => {
  if (ORIGINAL_SSRF !== undefined) process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = ORIGINAL_SSRF;
  else delete process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK;
});

const lookupTo = (address: string, family = 4) => async () => [{ address, family }];

describe('IP classification', () => {
  it('blocks every internal IPv4 class; allows public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(classifyIpv4(ip).blocked, ip).toBe(true);
    }
    expect(classifyIpv4('127.0.0.1').isLoopback).toBe(true);
    expect(classifyIpv4('8.8.8.8').blocked).toBe(false);
    expect(classifyIpv4('93.184.216.34').blocked).toBe(false);
    // 172.15 / 172.32 are public (outside 172.16/12)
    expect(classifyIpv4('172.15.0.1').blocked).toBe(false);
    expect(classifyIpv4('172.32.0.1').blocked).toBe(false);
  });

  it('blocks internal IPv6 + IPv4-mapped; allows public', () => {
    expect(classifyIpv6('::1').blocked).toBe(true);
    expect(classifyIpv6('::1').isLoopback).toBe(true);
    expect(classifyIpv6('::').blocked).toBe(true);
    expect(classifyIpv6('fe80::1').blocked).toBe(true);
    expect(classifyIpv6('fc00::1').blocked).toBe(true);
    expect(classifyIpv6('fd12:3456::1').blocked).toBe(true);
    expect(classifyIpv6('::ffff:10.0.0.1').blocked).toBe(true); // IPv4-mapped private
    expect(classifyIpv6('2606:4700:4700::1111').blocked).toBe(false); // public (Cloudflare)
  });
});

describe('assertEgressAllowed (sync registration guard)', () => {
  it('allows a public https URL', () => {
    expect(() => assertEgressAllowed('https://hooks.example.com/algovault')).not.toThrow();
  });

  it('rejects http (https-only in prod)', () => {
    expect(() => assertEgressAllowed('http://hooks.example.com/x')).toThrow(EgressBlockedError);
    try { assertEgressAllowed('http://hooks.example.com/x'); } catch (e) { expect((e as EgressBlockedError).code).toBe('insecure_scheme'); }
  });

  it('rejects non-http(s) schemes', () => {
    try { assertEgressAllowed('ftp://x/y'); } catch (e) { expect((e as EgressBlockedError).code).toBe('disallowed_scheme'); }
    try { assertEgressAllowed('file:///etc/passwd'); } catch (e) { expect((e as EgressBlockedError).code).toBe('disallowed_scheme'); }
  });

  it('rejects embedded credentials', () => {
    try { assertEgressAllowed('https://user:pass@hooks.example.com/x'); } catch (e) { expect((e as EgressBlockedError).code).toBe('embedded_credentials'); }
  });

  it('rejects literal internal IPs (https + literal)', () => {
    for (const u of ['https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://169.254.169.254/latest', 'https://192.168.1.1/x', 'https://[::1]/x', 'https://[fe80::1]/x']) {
      expect(() => assertEgressAllowed(u), u).toThrow(EgressBlockedError);
    }
  });

  it('rejects invalid URLs', () => {
    try { assertEgressAllowed('not a url'); } catch (e) { expect((e as EgressBlockedError).code).toBe('invalid_url'); }
  });

  it('seam ON: permits loopback (http + literal) ONLY; non-loopback still blocked', () => {
    process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = '1';
    expect(() => assertEgressAllowed('http://127.0.0.1:8080/hook')).not.toThrow();
    expect(() => assertEgressAllowed('https://127.0.0.1/hook')).not.toThrow();
    expect(() => assertEgressAllowed('http://localhost:3000/hook')).not.toThrow();
    expect(() => assertEgressAllowed('https://10.0.0.1/x')).toThrow(EgressBlockedError); // private != loopback
  });
});

describe('resolveAndAssertEgress (async DNS-rebind guard)', () => {
  it('allows a hostname resolving to a public IP and returns the pinned address', async () => {
    // WH-01: returns the validated {address, family} to pin to the connection.
    await expect(resolveAndAssertEgress('https://hooks.example.com/x', { lookup: lookupTo('93.184.216.34') }))
      .resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('blocks a hostname that resolves to a private IP (rebind)', async () => {
    await expect(resolveAndAssertEgress('https://rebind.evil.com/x', { lookup: lookupTo('10.0.0.1') })).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('blocks if ANY resolved address is internal', async () => {
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }];
    await expect(resolveAndAssertEgress('https://multi.evil.com/x', { lookup: mixed })).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('fails closed on NXDOMAIN / resolver error', async () => {
    const boom = async () => { throw new Error('ENOTFOUND'); };
    await expect(resolveAndAssertEgress('https://nope.invalid/x', { lookup: boom })).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('literal public IP host passes without DNS and pins the literal IP', async () => {
    let called = false;
    const lk = async () => { called = true; return [{ address: '1.1.1.1', family: 4 }]; };
    await expect(resolveAndAssertEgress('https://8.8.8.8/x', { lookup: lk }))
      .resolves.toEqual({ address: '8.8.8.8', family: 4 }); // pins the literal, not the (unused) lookup result
    expect(called).toBe(false); // literal IP → no DNS
  });
});

describe('delivery integration: blocked egress', () => {
  const ORIGINAL = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };
  let tempHome: string;
  let perfDb: typeof import('../src/lib/performance-db.js');
  let store: typeof import('../src/lib/webhooks-store.js');
  let delivery: typeof import('../src/lib/webhook-delivery.js');
  let license: typeof import('../src/lib/license.js');

  const eventData = () => ({ type: 'trade_call' as const, coin: 'BTC', timeframe: '1h', exchange: 'HL', call: 'BUY', confidence: 72, regime: 'TRENDING_UP', price_at_call: 50000, signal_hash: '0xfeed', created_at: 1_700_000_000 });

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ssrf-deliv-'));
    process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
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
    if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
  });

  it('a delivery whose host resolves to a private IP → dead, 0 HTTP attempts, 0 quota charged, 0 retries', async () => {
    const sub = await store.createSubscription({ url: 'https://rebind.evil.com/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:ssrf' });
    const { deliveryId } = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:0xfeed', eventType: 'trade_call', eventData: eventData() });
    const d = (await store.pendingDeliveries(10)).find(x => x.id === deliveryId)!;

    let fetchCalls = 0;
    const fetchImpl = (async () => { fetchCalls++; return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
    const res = await delivery.deliverOne(d, { fetchImpl, sleep: async () => {}, lookup: lookupTo('10.0.0.1') });

    expect(res.status).toBe('dead');
    expect(res.attempts).toBe(0);
    expect(fetchCalls).toBe(0);                                   // no HTTP attempt
    expect(res.suggested_action).toMatch(/disallowed\/internal/);
    expect(license.checkQuotaByKey('free:ssrf', 'free').used).toBe(0); // 0 quota charged
  });

  it('postWithTimeout sets redirect:"error" on the outbound fetch', async () => {
    const sub = await store.createSubscription({ url: 'https://good.example.com/h', events: ['trade_call'], tier: 'free', ownerKey: 'free:ok' });
    const { deliveryId } = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:0xfeed', eventType: 'trade_call', eventData: eventData() });
    const d = (await store.pendingDeliveries(10)).find(x => x.id === deliveryId)!;

    let capturedInit: any = null;
    const fetchImpl = (async (_url: string, init: any) => { capturedInit = init; return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
    const res = await delivery.deliverOne(d, { fetchImpl, sleep: async () => {}, lookup: lookupTo('93.184.216.34') });

    expect(res.status).toBe('delivered');
    expect(capturedInit?.redirect).toBe('error');
  });
});
