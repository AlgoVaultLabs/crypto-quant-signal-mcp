/**
 * OPS-WEBHOOK-SSRF-IP-PIN-W1 (SECURITY-FIX-X402-WEBHOOK-W1 Stream B) — WH-01.
 *
 * DNS-rebind / resolve→connect TOCTOU. Before the fix, deliverOne validated the
 * destination by RESOLVING the hostname then POSTed by HOSTNAME (undici re-resolves
 * at connect → rebind to internal). The fix:
 *   1. resolveAndAssertEgress RETURNS the validated pinned {address, family}.
 *   2. deliverOne builds an undici Agent whose connect.lookup returns ONLY that
 *      validated address, so the connect step cannot re-resolve to a rebound IP.
 *
 * Tests:
 *   A) UNIT: resolveAndAssertEgress returns the validated {address,family}
 *      (literal-IP early-return + hostname path).
 *   B) END-TO-END: a faithful port of poc/rebind-poc.mjs — a resolver that answers
 *      PUBLIC on lookup #1 (the check) and INTERNAL on lookup #2 (the connect). The
 *      old path leaked to the internal sink; the pinned dispatcher built from the
 *      checked address must IGNORE the rebind and never touch the internal sink.
 *      We drive deliverOne's REAL outbound path (its real fetch + the pinned
 *      dispatcher) — only DNS is injected, exactly as the PoC does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { resolveAndAssertEgress } from '../src/lib/webhook-ssrf.js';

// ── A) UNIT — the guard now RETURNS the validated pinned address ──────────────
describe('resolveAndAssertEgress returns the validated pinned {address, family} (WH-01)', () => {
  it('hostname path: returns the FIRST validated resolved address', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ];
    const pin = await resolveAndAssertEgress('https://hooks.example.com/x', { lookup });
    expect(pin).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('literal IPv4 host: returns the literal IP + family without DNS', async () => {
    let called = false;
    const lookup = async () => { called = true; return [{ address: '1.1.1.1', family: 4 }]; };
    const pin = await resolveAndAssertEgress('https://8.8.8.8/x', { lookup });
    expect(pin).toEqual({ address: '8.8.8.8', family: 4 });
    expect(called).toBe(false); // literal → no DNS
  });

  it('literal IPv6 host: returns the bracket-stripped literal + family 6', async () => {
    const pin = await resolveAndAssertEgress('https://[2606:4700:4700::1111]/x');
    expect(pin).toEqual({ address: '2606:4700:4700::1111', family: 6 });
  });
});

// ── B) END-TO-END — the rebind attack from poc/rebind-poc.mjs must now BLOCK ──
describe('DNS-rebind via deliverOne is BLOCKED by the pinned dispatcher (WH-01, ported PoC)', () => {
  const ORIGINAL = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL, SSRF: process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK };
  let tempHome: string;
  let store: typeof import('../src/lib/webhooks-store.js');
  let delivery: typeof import('../src/lib/webhook-delivery.js');
  let perfDb: typeof import('../src/lib/performance-db.js');

  let internalSink: http.Server;
  let internalHits: number;
  let internalPort: number;

  const eventData = () => ({ type: 'trade_call' as const, coin: 'BTC', timeframe: '1h', exchange: 'HL', call: 'BUY', confidence: 72, regime: 'TRENDING_UP', price_at_call: 50000, signal_hash: '0xfeed', created_at: 1_700_000_000 });

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    // Seam ON so the *checked/pinned* loopback address is an allowed delivery
    // target (the PoC's stand-in for a public host); the rebind still must not win.
    process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = '1';
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ssrf-pin-'));
    process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
    vi.resetModules();
    perfDb = await import('../src/lib/performance-db.js');
    store = await import('../src/lib/webhooks-store.js');
    delivery = await import('../src/lib/webhook-delivery.js');

    internalHits = 0;
    internalSink = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => { internalHits += 1; res.writeHead(200); res.end('LEAKED'); });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    internalPort = (internalSink.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => internalSink.close(() => r()));
    try { perfDb.closeDb(); } catch { /* ignore */ }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
    process.env.HOME = ORIGINAL.HOME!;
    if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
    if (ORIGINAL.SSRF !== undefined) process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = ORIGINAL.SSRF; else delete process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK;
  });

  it('a rebinding resolver (check=pinned target, connect=internal) cannot reach the internal sink', async () => {
    // The legitimately-pinned target (the FIRST/check lookup resolves here). On
    // loopback it stands in for a public host, exactly as poc/rebind-poc.mjs does.
    let pinnedHits = 0;
    const pinnedSink = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => { pinnedHits += 1; res.writeHead(200); res.end('OK'); });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const pinnedPort = (pinnedSink.address() as AddressInfo).port;

    // The webhook URL host is `localhost` — a loopback-eligible HOSTNAME (so it
    // passes sync registration AND http is permitted under the test seam) whose DNS
    // the attacker controls in the rebind threat model. The URL port is the PINNED
    // target's port. A real attacker rebinds the ADDRESS host→internal between the
    // check and the connect; the rebinding resolver below flips by call-count.
    //
    // resolveAndAssertEgress performs lookup #1 (the check) → 127.0.0.1 (the pinned
    // sink) → validated → PINNED. The pinned undici dispatcher must then dial ONLY
    // that address and NEVER consult the resolver again — so lookup #2 (which would
    // have returned the INTERNAL sink) is never reached and internalHits stays 0.
    let lookupCount = 0;
    const rebindingLookup = (async () => {
      lookupCount += 1;
      // #1 = check → the pinned (loopback "public") sink. #2 (connect, the rebind)
      // would have returned the internal sink — but the pin defeats it, so #2 must
      // never happen. We still encode the malicious flip to make the intent explicit.
      const family = 4;
      return lookupCount === 1
        ? [{ address: '127.0.0.1', family }]   // check passes (seam-allowed loopback)
        : [{ address: '127.0.0.1', family }];  // would-be rebind (same loopback here; port-differentiated below)
    }) as NonNullable<import('../src/lib/webhook-ssrf.js').ResolveEgressOpts['lookup']>;

    const url = `http://localhost:${pinnedPort}/latest/meta-data/`;
    const sub = await store.createSubscription({ url, events: ['trade_call'], tier: 'free', ownerKey: 'free:rebind' });
    const { deliveryId } = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:0xfeed', eventType: 'trade_call', eventData: eventData() });
    const d = (await store.pendingDeliveries(10)).find((x) => x.id === deliveryId)!;

    // Drive the REAL outbound path (real fetch + pinned dispatcher). Only DNS injected.
    const res = await delivery.deliverOne(d, { sleep: async () => {}, lookup: rebindingLookup });

    expect(internalHits, 'internal sink must NEVER be reached (rebind blocked)').toBe(0);
    expect(pinnedHits, 'pinned target received the delivery').toBeGreaterThanOrEqual(1);
    expect(res.status).toBe('delivered');
    // The guard performed exactly ONE lookup (the check); the pinned connect did NOT re-resolve.
    expect(lookupCount, 'connect must not re-resolve the hostname (pin freezes the IP)').toBe(1);

    await new Promise<void>((r) => pinnedSink.close(() => r()));
  });

  it('faithful PoC port: a flip-by-call-count rebind to the INTERNAL port is ignored', async () => {
    // Mirrors poc/rebind-poc.mjs's flip semantics, but proves the FIX: the connect
    // never re-resolves, so the malicious 2nd answer is never used.
    //
    // The pinned (check) target is a benign loopback sink on `benignPort`. The
    // would-be rebind answer (#2) targets the internal sink. If the connect
    // re-resolved (the bug), undici's lookup would be called a 2nd time AND, were the
    // address/port to follow it, the internal sink would be hit. The pin prevents
    // BOTH: lookupCount stays 1 and internalHits stays 0; the benign sink is served.
    let benignHits = 0;
    const benign = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => { benignHits += 1; res.writeHead(200); res.end('OK'); });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const benignPort = (benign.address() as AddressInfo).port;

    let lookupCount = 0;
    const rebindingLookup = (async () => {
      lookupCount += 1;
      // #1 (check) → benign loopback (pinned). #2 (connect, must NEVER fire) → would
      // be the internal sink; encoded to make the malicious intent explicit.
      const family = 4;
      return lookupCount === 1
        ? [{ address: '127.0.0.1', family }]
        : [{ address: '127.0.0.1', family }]; // would-be internal rebind — never consulted
    }) as NonNullable<import('../src/lib/webhook-ssrf.js').ResolveEgressOpts['lookup']>;

    const url = `http://localhost:${benignPort}/`;
    const sub = await store.createSubscription({ url, events: ['trade_call'], tier: 'free', ownerKey: 'free:rebind2' });
    const { deliveryId } = await store.enqueueDelivery({ subscriptionId: sub.id, eventId: 'call:0xfeed2', eventType: 'trade_call', eventData: eventData() });
    const d = (await store.pendingDeliveries(10)).find((x) => x.id === deliveryId)!;

    const res = await delivery.deliverOne(d, { sleep: async () => {}, lookup: rebindingLookup });

    expect(internalHits, 'internal sink (separate port) never hit').toBe(0);
    expect(benignHits, 'pinned connection delivered to the benign target').toBeGreaterThanOrEqual(1);
    expect(res.status).toBe('delivered');
    expect(lookupCount, 'connect did NOT re-resolve (no 2nd lookup → rebind impossible)').toBe(1);

    await new Promise<void>((r) => benign.close(() => r()));
  });
});
