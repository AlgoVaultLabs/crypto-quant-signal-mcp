/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH3 — the /api/entitlement/* HTTP surface.
 *
 * Boots the REAL registrar on an ephemeral port (the shape tests/webhook-api.test.ts uses), so
 * these assertions run against the handlers production registers — not a re-implementation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ORIGINAL = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
  BYPASS: process.env.ALGOVAULT_INTERNAL_BYPASS_KEY,
  BYPASS_ON: process.env.BOT_INTERNAL_BYPASS_ENABLED,
  PREFIX: process.env.ALLOW_DEV_KEY_PREFIX,
};

const KEY = 'test-internal-key';
let tempHome: string;
let server: http.Server;
let baseUrl: string;
let perfDb: typeof import('../src/lib/performance-db.js');
let license: typeof import('../src/lib/license.js');
let PLANS: typeof import('../src/lib/plans.js').PLANS;

/** A starter-tier key the dev-prefix escape hatch will tier without hitting Stripe. */
const starterKey = () => `av_live_starter_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  process.env.ALLOW_DEV_KEY_PREFIX = 'true';
  process.env.BOT_INTERNAL_BYPASS_ENABLED = 'true';
  process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = KEY;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-entitlement-api-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  // The route resolves a key's tier through stripe.validateApiKey. Mocking it keeps these tests
  // hermetic and makes "unknown key" a deterministic input rather than a network outcome.
  vi.doMock('../src/lib/stripe.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/lib/stripe.js')>()),
    validateApiKey: async (k: string) => {
      const m = /^av_live_(starter|pro|enterprise)_/.exec(k);
      return m ? { valid: true, tier: m[1], customerId: `cus_${m[1]}` } : { valid: false };
    },
  }));

  perfDb = await import('../src/lib/performance-db.js');
  license = await import('../src/lib/license.js');
  ({ PLANS } = await import('../src/lib/plans.js'));
  const express = (await import('express')).default;
  const { registerEntitlementRoutes } = await import('../src/lib/entitlement-api.js');

  const app = express();
  registerEntitlementRoutes(app);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  for (const [k, v] of Object.entries({
    USERPROFILE: ORIGINAL.USERPROFILE, DATABASE_URL: ORIGINAL.DATABASE_URL,
    ALGOVAULT_INTERNAL_BYPASS_KEY: ORIGINAL.BYPASS, BOT_INTERNAL_BYPASS_ENABLED: ORIGINAL.BYPASS_ON,
    ALLOW_DEV_KEY_PREFIX: ORIGINAL.PREFIX,
  })) {
    if (v !== undefined) process.env[k] = v; else delete process.env[k];
  }
});

const post = (body: unknown, headers: Record<string, string> = { 'X-AlgoVault-Internal-Key': KEY }) =>
  fetch(`${baseUrl}/api/entitlement/consume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

describe('auth — the same gate as /api/bot/validate-key', () => {
  it('401 without the internal key', async () => {
    const r = await post({ api_key: starterKey(), channel: 'bot', idempotency_key: 'k' }, {});
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('unauthorized');
  });

  it('403 when the bypass is disabled server-side', async () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'false';
    const r = await post({ api_key: starterKey(), channel: 'bot', idempotency_key: 'k' });
    expect(r.status).toBe(403);
  });

  it('the state route is behind the same gate', async () => {
    const r = await fetch(`${baseUrl}/api/entitlement/state?api_key=x&channel=bot`);
    expect(r.status).toBe(401);
  });
});

describe('400s — default-deny on every input', () => {
  it('missing api_key', async () => {
    expect((await (await post({ channel: 'bot', idempotency_key: 'k' })).json()).error).toBe('api_key_required');
  });

  it('unknown channel — never falls back to one that can charge', async () => {
    const r = await post({ api_key: starterKey(), channel: 'discord', idempotency_key: 'k' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('unknown_channel');
  });

  it('missing idempotency_key — the server must NOT mint one', async () => {
    // A server-minted key differs on every retry, so every replay would charge.
    const r = await post({ api_key: starterKey(), channel: 'bot' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('idempotency_key_required');
  });

  it('404 on an unknown key, byte-identical to the validate-key shape', async () => {
    const r = await post({ api_key: 'not-a-real-key', channel: 'bot', idempotency_key: 'k' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ valid: false });
  });
});

describe('the 200 contract CH4/CH5 depend on', () => {
  it('CHARGED, then ALREADY_CHARGED on the same key, with `used` unmoved', async () => {
    const key = starterKey();
    const idem = `bot:1:${Date.now()}`;
    const first = await (await post({ api_key: key, channel: 'bot', units: 2, idempotency_key: idem })).json();
    expect(first.outcome).toBe('CHARGED');
    expect(first.used).toBe(2);

    const second = await (await post({ api_key: key, channel: 'bot', units: 2, idempotency_key: idem })).json();
    expect(second.outcome).toBe('ALREADY_CHARGED');
    expect(second.used).toBe(first.used);
  });

  it('all four outcomes return HTTP 200 — business outcomes are not transport errors', async () => {
    const key = starterKey();
    const refused = await post({ api_key: key, channel: 'a2mcp', units: 1, idempotency_key: 'x' });
    expect(refused.status).toBe(200);
    expect((await refused.json()).outcome).toBe('REFUSED');
  });

  it('units clamp: non-finite / <1 / fractional all collapse to a sane integer', async () => {
    for (const [units, expected] of [[0, 1], [-5, 1], ['abc', 1], [2.9, 2]] as const) {
      const key = starterKey();
      const body = await (await post({ api_key: key, channel: 'bot', units, idempotency_key: `${key}:u` })).json();
      expect(body.used, `units=${JSON.stringify(units)}`).toBe(expected);
    }
  });

  it('carries the episode keys and the wall flag', async () => {
    const key = starterKey();
    const b = await (await post({ api_key: key, channel: 'bot', units: 1, idempotency_key: `${key}:e` })).json();
    expect(b.period_start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b.daily_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(b.refuses_at_wall).toBe(true);
    expect(b.limit).toBeNull();
  });
});

describe('Infinity serialises as an explicit null, never a silent one', () => {
  it('an uncapped tier reports total/remaining as null — meaning "no ceiling", never zero', async () => {
    const key = `av_live_enterprise_${Date.now()}`;
    const b = await (await post({ api_key: key, channel: 'bot', units: 1, idempotency_key: `${key}:i` })).json();
    expect(b.tier).toBe('enterprise');
    expect(b.total).toBe(PLANS.enterprise.monthlyCalls); // enterprise IS capped monthly…
    expect(b.next_plan).toBeNull();                       // …but has no self-serve next rung
    // The settled rail is uncapped regardless of the key's tier.
    const s = await (await post({ api_key: key, channel: 'httpX402', units: 1, idempotency_key: `${key}:x` })).json();
    expect(s.total).toBeNull();
    expect(s.remaining).toBeNull();
  });
});

describe('next_plan is projected from plans.ts — the bot hand-types no number', () => {
  it('starter is upsold to pro, with the live ladder figures', async () => {
    const key = starterKey();
    const b = await (await post({ api_key: key, channel: 'bot', units: 1, idempotency_key: `${key}:n` })).json();
    expect(b.tier).toBe('starter');
    expect(b.next_plan.id).toBe('pro');
    expect(b.next_plan.monthly_calls).toBe(PLANS.pro.monthlyCalls);
    expect(b.next_plan.price_usd).toBe(PLANS.pro.priceUsdMonthly);
    expect(b.next_plan.signup_url).toContain('utm_source=tg_bot');
  });
});

describe('GET /state — no charge, no claim', () => {
  it('reads without moving the meter', async () => {
    const key = starterKey();
    await post({ api_key: key, channel: 'bot', units: 4, idempotency_key: `${key}:seed` });
    const used = license.checkQuotaByKey(key, 'starter').used;
    const r = await fetch(`${baseUrl}/api/entitlement/state?api_key=${key}&channel=bot`, {
      headers: { 'X-AlgoVault-Internal-Key': KEY },
    });
    const b = await r.json();
    expect(b.outcome).toBe('READ');
    expect(b.used).toBe(used);
    expect(license.checkQuotaByKey(key, 'starter').used).toBe(used);
  });
});
