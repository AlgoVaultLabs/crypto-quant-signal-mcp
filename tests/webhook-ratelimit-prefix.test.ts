/**
 * OPS-WEBHOOK-RATELIMIT-PREFIX-FIX-W1 (SECURITY-FIX-X402-WEBHOOK-W1 Stream B) — WH-03.
 *
 * The limiter was mounted on `/webhooks` but the subscription routes live at
 * `/api/webhooks` → Express prefix matching never applied the limiter → `:id/test`
 * was an unthrottled SSRF-probe / DoS amplifier. Fix: registerWebhookRoutes now
 * mounts the limiter on `/api/webhooks` (co-located with the routes it governs),
 * plus a tighter per-key limiter on `:id/test` (real outbound traffic).
 *
 * Proof: the limiter sets `standardHeaders:true`, so the presence of `RateLimit-*`
 * response headers on `/api/webhooks*` proves the limiter is applied; the 429 after
 * the `:id/test` cap proves the tight per-route limiter governs the egress trigger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ORIGINAL = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL, CQS_API_KEY: process.env.CQS_API_KEY, SSRF: process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK };

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let apiServer: http.Server;
let baseUrl: string;

const STARTER_KEY = 'av_starter_ratelimit_key';

function authHeaders(key?: string): Record<string, string> {
  return key ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } : { 'Content-Type': 'application/json' };
}

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.CQS_API_KEY;
  delete process.env.WEBHOOK_DELIVERY_ENABLED;
  process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = '1';
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-webhook-ratelimit-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();

  perfDb = await import('../src/lib/performance-db.js');
  const express = (await import('express')).default;
  const { registerWebhookRoutes } = await import('../src/lib/webhook-api.js');

  const app = express();
  app.set('trust proxy', 1);
  registerWebhookRoutes(app);
  apiServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => apiServer.close(() => r()));
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
  if (ORIGINAL.CQS_API_KEY !== undefined) process.env.CQS_API_KEY = ORIGINAL.CQS_API_KEY;
  if (ORIGINAL.SSRF !== undefined) process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK = ORIGINAL.SSRF; else delete process.env.WEBHOOK_SSRF_ALLOW_LOOPBACK;
});

describe('WH-03: rate-limiter governs /api/webhooks (correct prefix)', () => {
  it('GET /api/webhooks emits RateLimit-* headers (limiter is applied)', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks`, { headers: authHeaders(STARTER_KEY) });
    // The standardHeaders limiter sets RateLimit / RateLimit-Policy headers on
    // every governed response (the bug was their ABSENCE — limiter never matched).
    const hasLimitHeader =
      res.headers.has('ratelimit') ||
      res.headers.has('ratelimit-limit') ||
      res.headers.has('ratelimit-policy');
    expect(hasLimitHeader, 'RateLimit-* header must be present on /api/webhooks').toBe(true);
  });

  it('POST /api/webhooks/:id/test is governed by RateLimit-* headers too', async () => {
    // Use a nonexistent id — auth + limiter run before the 404; we only assert the
    // limiter header is present (the route is behind a limiter at all).
    const res = await fetch(`${baseUrl}/api/webhooks/999999/test`, { method: 'POST', headers: authHeaders(STARTER_KEY) });
    const hasLimitHeader =
      res.headers.has('ratelimit') ||
      res.headers.has('ratelimit-limit') ||
      res.headers.has('ratelimit-policy');
    expect(hasLimitHeader, 'RateLimit-* header must be present on /api/webhooks/:id/test').toBe(true);
  });

  it(':id/test is throttled to its tight per-key cap (429 after the cap)', async () => {
    // The tight :id/test limiter (max 5/min/key) must 429 once the per-key cap is
    // exceeded. Hammer a nonexistent id with the same key; the limiter fires before
    // the handler, so status flips to 429 within a handful of requests.
    let saw429 = false;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/api/webhooks/424242/test`, { method: 'POST', headers: authHeaders(STARTER_KEY) });
      last = res.status;
      if (res.status === 429) { saw429 = true; break; }
    }
    expect(saw429, `expected a 429 from the tight :id/test limiter (last status ${last})`).toBe(true);
  });
});
