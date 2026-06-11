/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 C5 — /api/webhooks REST API over a real local server.
 *
 * Boots a minimal Express app with registerWebhookRoutes() on an ephemeral port
 * and drives it with real fetch() (create→list→delete→test). A second ephemeral
 * http server is the delivery sink for the /test ping. SQLite temp-HOME harness;
 * no Stripe/x402 + ALLOW_DEV_KEY_PREFIX=true (dev escape hatch, SECURITY-FIX-TIER-ESCALATION-W1)
 * → keys resolve via prefix (av_starter_* → starter, else pro). Without the flag a
 * Stripe-invalid key now default-denies to free (the fix), so the dev flag is required here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ORIGINAL = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL, CQS_API_KEY: process.env.CQS_API_KEY, SSRF: process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK, PREFIX: process.env.ALLOW_DEV_KEY_PREFIX };

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let apiServer: http.Server;
let baseUrl: string;
let sink: http.Server;
let sinkUrl: string;
let sinkHits: { headers: http.IncomingHttpHeaders; body: string }[];

const STARTER_KEY = 'av_starter_testkey_A';
const OTHER_KEY = 'av_starter_testkey_B';

function authHeaders(key?: string): Record<string, string> {
  return key ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } : { 'Content-Type': 'application/json' };
}

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.CQS_API_KEY; // ensure the Bearer header (not env) drives auth
  process.env.ALLOW_DEV_KEY_PREFIX = 'true'; // dev escape hatch so prefix keys tier (SECURITY-FIX-TIER-ESCALATION-W1; a Stripe-invalid key otherwise default-denies to free)
  delete process.env.WEBHOOK_DELIVERY_ENABLED;
  process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = '1'; // local http://127.0.0.1 sink (W1 test seam)
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-api-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();

  perfDb = await import('../src/lib/performance-db.js');
  const express = (await import('express')).default;
  const { registerWebhookRoutes } = await import('../src/lib/webhook-api.js');

  const app = express();
  registerWebhookRoutes(app);
  apiServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  // Delivery sink.
  sinkHits = [];
  sink = await new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        sinkHits.push({ headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    });
    s.listen(0, () => resolve(s));
  });
  sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
});

afterEach(async () => {
  await new Promise<void>((r) => apiServer.close(() => r()));
  await new Promise<void>((r) => sink.close(() => r()));
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
  if (ORIGINAL.CQS_API_KEY !== undefined) process.env.CQS_API_KEY = ORIGINAL.CQS_API_KEY;
  if (ORIGINAL.SSRF !== undefined) process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = ORIGINAL.SSRF; else delete process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK;
  if (ORIGINAL.PREFIX !== undefined) process.env.ALLOW_DEV_KEY_PREFIX = ORIGINAL.PREFIX; else delete process.env.ALLOW_DEV_KEY_PREFIX;
});

async function createSub(key: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/webhooks`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ url: sinkUrl, events: ['trade_call', 'regime_shift'], ...overrides }),
  });
  return { res, json: await res.json() as any };
}

describe('/api/webhooks: auth', () => {
  it('keyless POST → 401 auth_required with suggested_action', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ url: sinkUrl, events: ['trade_call'] }) });
    expect(res.status).toBe(401);
    const j = await res.json() as any;
    expect(j.code).toBe('auth_required');
    expect(j.suggested_action).toBeTruthy();
  });

  it('keyless GET → 401', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});

describe('/api/webhooks: CRUD lifecycle', () => {
  it('create → returns secret ONCE + quota; owner_key never exposed', async () => {
    const { res, json } = await createSub(STARTER_KEY);
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.subscription.id).toBeGreaterThan(0);
    expect(json.subscription.secret).toMatch(/^whsec_/);
    expect(json.subscription.events).toEqual(['trade_call', 'regime_shift']);
    expect(json.quota.total).toBe(3000); // starter
    // Security: owner_key must never appear anywhere in the response.
    expect(JSON.stringify(json).includes('owner_key')).toBe(false);
  });

  it('list → omits secret, scoped to the caller', async () => {
    await createSub(STARTER_KEY);
    const res = await fetch(`${baseUrl}/api/webhooks`, { headers: authHeaders(STARTER_KEY) });
    const j = await res.json() as any;
    expect(j.subscriptions.length).toBe(1);
    expect('secret' in j.subscriptions[0]).toBe(false);
    // A different key sees none.
    const other = await (await fetch(`${baseUrl}/api/webhooks`, { headers: authHeaders(OTHER_KEY) })).json() as any;
    expect(other.subscriptions.length).toBe(0);
  });

  it('delete is owner-scoped (wrong owner → 404; right owner → ok)', async () => {
    const { json } = await createSub(STARTER_KEY);
    const id = json.subscription.id;
    const wrong = await fetch(`${baseUrl}/api/webhooks/${id}`, { method: 'DELETE', headers: authHeaders(OTHER_KEY) });
    expect(wrong.status).toBe(404);
    const right = await fetch(`${baseUrl}/api/webhooks/${id}`, { method: 'DELETE', headers: authHeaders(STARTER_KEY) });
    expect(right.status).toBe(200);
    const after = await (await fetch(`${baseUrl}/api/webhooks`, { headers: authHeaders(STARTER_KEY) })).json() as any;
    expect(after.subscriptions.length).toBe(0);
  });

  it('validates url and events', async () => {
    const badUrl = await fetch(`${baseUrl}/api/webhooks`, { method: 'POST', headers: authHeaders(STARTER_KEY), body: JSON.stringify({ url: 'ftp://x', events: ['trade_call'] }) });
    expect(badUrl.status).toBe(400);
    expect((await badUrl.json() as any).code).toBe('invalid_url');
    const badEvents = await fetch(`${baseUrl}/api/webhooks`, { method: 'POST', headers: authHeaders(STARTER_KEY), body: JSON.stringify({ url: sinkUrl, events: ['nope'] }) });
    expect(badEvents.status).toBe(400);
    expect((await badEvents.json() as any).code).toBe('invalid_events');
  });

  it('rejects SSRF/internal registration URLs at the API (invalid_url)', async () => {
    // Seam is ON in this suite (loopback allowed for the local sink), but
    // non-loopback internal targets + http + embedded creds are still blocked.
    for (const url of ['http://10.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'http://hooks.public.com/x', 'https://user:pass@hooks.public.com/x', 'ftp://hooks.public.com/x']) {
      const res = await fetch(`${baseUrl}/api/webhooks`, { method: 'POST', headers: authHeaders(STARTER_KEY), body: JSON.stringify({ url, events: ['trade_call'] }) });
      expect(res.status, url).toBe(400);
      expect((await res.json() as any).code, url).toBe('invalid_url');
    }
  });
});

describe('/api/webhooks/:id/test: signed ping', () => {
  it('delivers a signed sample event to the subscriber sink', async () => {
    const { json } = await createSub(STARTER_KEY);
    const id = json.subscription.id;
    const secret = json.subscription.secret;

    const res = await fetch(`${baseUrl}/api/webhooks/${id}/test`, { method: 'POST', headers: authHeaders(STARTER_KEY) });
    const j = await res.json() as any;
    expect(j.ok).toBe(true);
    expect(j.result.status).toBe('delivered');

    expect(sinkHits.length).toBe(1);
    const hit = sinkHits[0];
    expect(hit.headers['x-algovault-event']).toBe('trade_call');
    expect(hit.headers['x-algovault-signature']).toMatch(/^[0-9a-f]{64}$/);
    // WH-04: HMAC verifies against "{timestamp}.{body}" using the received
    // X-AlgoVault-Timestamp header (replay-resistant signature scheme).
    const crypto = await import('node:crypto');
    const ts = String(hit.headers['x-algovault-timestamp']);
    expect(ts).toMatch(/^\d+$/);
    const expected = crypto.createHmac('sha256', secret).update(`${ts}.${hit.body}`).digest('hex');
    expect(hit.headers['x-algovault-signature']).toBe(expected);
    const payload = JSON.parse(hit.body);
    expect(payload.event).toBe('trade_call');
    expect(payload.data.call).toBe('BUY');
    // No forbidden Phase-E keys in the wire payload.
    for (const k of ['outcome_return_pct', 'pfe_', 'mae_', 'price_after_', 'return_pct_']) {
      expect(hit.body.includes(k)).toBe(false);
    }
  });

  it('test ping on a non-owned id → 404', async () => {
    const { json } = await createSub(STARTER_KEY);
    const res = await fetch(`${baseUrl}/api/webhooks/${json.subscription.id}/test`, { method: 'POST', headers: authHeaders(OTHER_KEY) });
    expect(res.status).toBe(404);
  });
});
