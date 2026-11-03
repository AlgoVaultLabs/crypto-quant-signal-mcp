/**
 * DECISION-CALL-V2-W2 CH2 (AC2.1) — `/api/pre-trade-rules` over a real local server, and the profile store under it
 * on a real SQLite backend (`Prompt/pre-trade-check-contract-v2.md` § v2.1).
 *
 * The tests/webhook-api.test.ts harness: a minimal Express app with registerPreTradeRulesRoutes() on an ephemeral
 * port, driven with real fetch(); a temp HOME so each test's SQLite is fresh; no Stripe and ALLOW_DEV_KEY_PREFIX=true
 * so an av_starter_* key resolves to that key. `resolveLicense` is wrapped pass-through so one case can present an
 * x402 payment, and `trackCall` / `checkQuota` so the routes can be shown unbilled.
 *
 * What it pins: PUT, GET and DELETE per the contract; the refusal for no key, an x402 payment and an OAuth access
 * token is refuseOwner's own body; a key reaches only its own profile; PUT accepts exactly what the `rules` param
 * accepts and names the key it refuses; the 4 KB limit; 10 writes a minute per key; and what PUT saves is what the
 * check reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Response } from 'express';
import Ajv from 'ajv';
import type { LicenseInfo } from '../../src/types.js';

vi.mock('../../src/lib/license.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/license.js')>();
  return { ...m, resolveLicense: vi.fn(m.resolveLicense), trackCall: vi.fn(m.trackCall), checkQuota: vi.fn(m.checkQuota) };
});

const ROOT = path.join(__dirname, '..', '..');
const ENV = ['HOME', 'USERPROFILE', 'DATABASE_URL', 'CQS_API_KEY', 'ALLOW_DEV_KEY_PREFIX', 'ALGOVAULT_IP_HASH_KEY', 'MCP_OAUTH', 'AUTH_STRICT_UNKNOWN'] as const;
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]])) as Record<(typeof ENV)[number], string | undefined>;

const KEY_A = 'av_starter_rules_key_A';
const KEY_B = 'av_starter_rules_key_B';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const METHODS = ['GET', 'PUT', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

let tempHome: string;
let perfDb: typeof import('../../src/lib/performance-db.js');
let server: http.Server;
let url: string;

beforeEach(async () => {
  // The license wrappers are made once and outlive vi.resetModules(): each test counts its own calls.
  vi.clearAllMocks();
  delete process.env.DATABASE_URL;
  delete process.env.CQS_API_KEY; // the Bearer header, not the env, drives auth
  delete process.env.MCP_OAUTH;
  delete process.env.AUTH_STRICT_UNKNOWN;
  process.env.ALLOW_DEV_KEY_PREFIX = 'true'; // prefix keys resolve to themselves (SECURITY-FIX-TIER-ESCALATION-W1 escape hatch)
  process.env.ALGOVAULT_IP_HASH_KEY = 'f3'.repeat(32); // callerRef's key: the profile's row id
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-pre-trade-rules-api-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();

  perfDb = await import('../../src/lib/performance-db.js');
  const express = (await import('express')).default;
  const { registerPreTradeRulesRoutes } = await import('../../src/lib/pre-trade-rules-api.js');
  const app = express();
  registerPreTradeRulesRoutes(app);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pre-trade-rules`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

interface Sent { key?: string; body?: unknown; raw?: string; type?: string }

/** One request to the route; `json` is null for a body that is not JSON (the 413 and 429 defaults). */
async function call(method: Method, o: Sent = {}): Promise<{ status: number; json: Record<string, any> | null; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  let body: string | undefined;
  if (o.raw !== undefined) body = o.raw;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined) headers['Content-Type'] = o.type ?? 'application/json';
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

/** What refuseOwner itself sends for `license`, captured on a stub response: the body every route must send. */
async function refusalOf(license: LicenseInfo): Promise<{ status: number; body: unknown }> {
  const { refuseOwner } = await import('../../src/lib/webhook-api.js');
  const out = { status: 0, body: undefined as unknown };
  const stub = { status(c: number) { out.status = c; return stub; }, json(b: unknown) { out.body = b; return stub; } };
  refuseOwner(stub as unknown as Response, license, 'An API key is required.');
  return out;
}

/** Whether the profile table exists: a route that never reached the store never created it. */
async function tableExists(): Promise<boolean> {
  const rows = await perfDb.dbQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pre_trade_rule_profiles'");
  return rows.length === 1;
}

const store = () => import('../../src/lib/pre-trade-rule-profiles.js');

describe('the profile store on a real SQLite backend', () => {
  it('get is null on a fresh database; put saves; a second put replaces (created_at kept); delete is true, then false', async () => {
    const s = await store();
    const ref = s.profileRefOf(KEY_A);
    expect(await s.getProfile(ref)).toBeNull();
    const first = await s.putProfile(ref, { maxLeverage: 5, regimeCheck: false }, Date.parse('2026-11-03T08:00:00Z'));
    expect(first).toEqual({ rules: { maxLeverage: 5, regimeCheck: false }, createdAt: '2026-11-03T08:00:00.000Z', updatedAt: '2026-11-03T08:00:00.000Z' });
    expect(await s.getProfile(ref)).toEqual(first);
    const second = await s.putProfile(ref, { maxFundingBps: 3 }, Date.parse('2026-11-03T09:30:00Z'));
    expect(second, 'replaced, never merged').toEqual({ rules: { maxFundingBps: 3 }, createdAt: '2026-11-03T08:00:00.000Z', updatedAt: '2026-11-03T09:30:00.000Z' });
    expect(await s.getProfile(ref)).toEqual(second);
    expect(await s.deleteProfile(ref)).toBe(true);
    expect(await s.deleteProfile(ref)).toBe(false);
    expect(await s.getProfile(ref)).toBeNull();
  });

  it('a row holds the pseudonym, the rules and two times — never the key', async () => {
    const s = await store();
    await s.putProfile(s.profileRefOf(KEY_A), { maxLeverage: 5 });
    const rows = await perfDb.dbQuery<Record<string, unknown>>('SELECT * FROM pre_trade_rule_profiles');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['caller_ref', 'created_at', 'rules', 'updated_at']);
    expect(rows[0].caller_ref).toMatch(/^pc1:[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain(KEY_A);
  });

  it('the store refuses to save what it could not read back, and a raw key as the id', async () => {
    const s = await store();
    const ref = s.profileRefOf(KEY_A);
    for (const rules of [{ maxLeverage: 500 }, { foo: 1 }, { regimeCheck: 'on' }]) {
      await expect(s.putProfile(ref, rules as never), JSON.stringify(rules)).rejects.toThrow();
    }
    await expect(s.putProfile(KEY_A, { maxLeverage: 5 })).rejects.toThrow(/pseudonym/);
    await expect(s.deleteProfile(KEY_A)).rejects.toThrow(/pseudonym/);
    expect(await s.getProfile(ref)).toBeNull();
  });
});

describe('PUT, GET and DELETE /api/pre-trade-rules', () => {
  it('GET with nothing saved: {} and null', async () => {
    const r = await call('GET', { key: KEY_A });
    expect([r.status, r.json]).toEqual([200, { ok: true, rules: {}, updated_at: null }]);
  });

  it('PUT saves the rules object and returns it; GET shows the same; a second PUT replaces it, never merges', async () => {
    const put = await call('PUT', { key: KEY_A, body: { maxLeverage: 5, noLiqBeforeStop: false } });
    expect([put.status, put.json]).toEqual([200, { ok: true, rules: { maxLeverage: 5, noLiqBeforeStop: false }, updated_at: expect.stringMatching(ISO) }]);
    expect((await call('GET', { key: KEY_A })).json).toEqual(put.json);
    const again = await call('PUT', { key: KEY_A, body: { maxSizePctOf24hVolume: 1 } });
    expect(again.json?.rules).toEqual({ maxSizePctOf24hVolume: 1 });
    expect((await call('GET', { key: KEY_A })).json?.rules).toEqual({ maxSizePctOf24hVolume: 1 });
  });

  it('PUT {} saves an empty profile: rules {} with a time, unlike none saved', async () => {
    const put = await call('PUT', { key: KEY_A, body: {} });
    expect([put.status, put.json?.rules, put.json?.updated_at]).toEqual([200, {}, expect.stringMatching(ISO)]);
    expect((await call('GET', { key: KEY_A })).json).toEqual(put.json);
  });

  it('DELETE clears it: deleted true, then GET shows {} and null, and a second DELETE is deleted false', async () => {
    await call('PUT', { key: KEY_A, body: { maxLeverage: 5 } });
    expect(await call('DELETE', { key: KEY_A }).then((r) => [r.status, r.json])).toEqual([200, { ok: true, deleted: true }]);
    expect((await call('GET', { key: KEY_A })).json).toEqual({ ok: true, rules: {}, updated_at: null });
    expect(await call('DELETE', { key: KEY_A }).then((r) => [r.status, r.json])).toEqual([200, { ok: true, deleted: false }]);
  });

  it('what PUT saves is what the check reads: the handler\'s default reader finds it by the same key, and only that key', async () => {
    await call('PUT', { key: KEY_A, body: { maxLeverage: 5 } });
    const { DEFAULT_PRE_TRADE_CHECK_DEPS } = await import('../../src/tools/pre-trade-check.js');
    expect((await DEFAULT_PRE_TRADE_CHECK_DEPS.ruleProfile(KEY_A))?.rules).toEqual({ maxLeverage: 5 });
    expect(await DEFAULT_PRE_TRADE_CHECK_DEPS.ruleProfile(KEY_B)).toBeNull();
  });

  it('unbilled, and pre_trade_check stays read-only: no route ticks or checks a quota, and the handler cannot write', async () => {
    const lic = await import('../../src/lib/license.js');
    await call('PUT', { key: KEY_A, body: { maxLeverage: 5 } });
    await call('GET', { key: KEY_A });
    await call('DELETE', { key: KEY_A });
    expect(vi.mocked(lic.trackCall)).not.toHaveBeenCalled();
    expect(vi.mocked(lic.checkQuota)).not.toHaveBeenCalled();
    const handler = fs.readFileSync(path.join(ROOT, 'src/tools/pre-trade-check.ts'), 'utf8');
    expect(handler).not.toMatch(/\b(putProfile|deleteProfile)\b/);
  });

  it('index.ts registers the routes beside the webhooks\'', () => {
    const indexTs = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    expect(indexTs).toMatch(/registerWebhookRoutes\(app\);\n\s*registerPreTradeRulesRoutes\(app\);/);
  });
});

describe('who may use them: an API key, and only for its own profile', () => {
  for (const method of METHODS) {
    it(`${method} with no key: refuseOwner's 401, and the store is never reached`, async () => {
      const want = await refusalOf({ tier: 'free', key: null, outcome: 'ABSENT' });
      expect(want).toEqual({ status: 401, body: expect.objectContaining({ ok: false, code: 'auth_required', error: 'An API key is required.' }) });
      const r = await call(method, method === 'PUT' ? { body: { maxLeverage: 5 } } : {});
      expect([r.status, r.json]).toEqual([want.status, want.body]);
      expect(await tableExists()).toBe(false);
    });
  }

  it('an x402 payment: refuseOwner\'s 401 on every route — a payment is not a key', async () => {
    const lic = await import('../../src/lib/license.js');
    const x402: LicenseInfo = { tier: 'x402', key: null, outcome: 'RESOLVED' };
    const want = await refusalOf(x402);
    for (const method of METHODS) {
      vi.mocked(lic.resolveLicense).mockResolvedValueOnce({ license: x402 });
      const r = await call(method, method === 'PUT' ? { body: { maxLeverage: 5 } } : {});
      expect([r.status, r.json], method).toEqual([want.status, want.body]);
    }
    expect(vi.mocked(lic.resolveLicense)).toHaveBeenCalledTimes(3);
    expect(await tableExists()).toBe(false);
  });

  it('an OAuth access token: refuseOwner\'s TOKEN_INVALID 401 on every route — a token is not a key here', async () => {
    process.env.MCP_OAUTH = 'optin';
    const token = `avat_${'ab'.repeat(24)}`;
    const want = await refusalOf({ tier: 'free', key: null, outcome: 'TOKEN_INVALID', anonymous: true });
    expect(want.status).toBe(401);
    expect((want.body as { code: string }).code, 'the token\'s own body, not the absent one').not.toBe('auth_required');
    for (const method of METHODS) {
      const r = await call(method, { key: token, ...(method === 'PUT' ? { body: { maxLeverage: 5 } } : {}) });
      expect([r.status, r.json], method).toEqual([want.status, want.body]);
    }
    expect(await tableExists()).toBe(false);
  });

  it('key A cannot read, overwrite or delete key B\'s profile — the key is the only address', async () => {
    await call('PUT', { key: KEY_B, body: { maxLeverage: 9 } });
    expect((await call('GET', { key: KEY_A })).json, 'A reads only its own').toEqual({ ok: true, rules: {}, updated_at: null });
    await call('PUT', { key: KEY_A, body: { maxLeverage: 2 } });
    expect((await call('GET', { key: KEY_B })).json?.rules, 'A\'s PUT wrote A\'s row').toEqual({ maxLeverage: 9 });
    expect((await call('DELETE', { key: KEY_A })).json).toEqual({ ok: true, deleted: true });
    expect((await call('DELETE', { key: KEY_A })).json, 'nothing of A\'s left to delete').toEqual({ ok: true, deleted: false });
    expect((await call('GET', { key: KEY_B })).json?.rules, 'B\'s row survives A\'s deletes').toEqual({ maxLeverage: 9 });
    const refB = (await store()).profileRefOf(KEY_B);
    for (const method of METHODS) {
      const r = await fetch(`${url}/${encodeURIComponent(refB)}`, { method, headers: { Authorization: `Bearer ${KEY_A}` } });
      expect(r.status, `${method} by B's ref: no route names a profile`).toBe(404);
    }
  });
});

describe('PUT accepts exactly what the rules param accepts, and names the key it refuses', () => {
  it('a corpus drawn from the declaration: the endpoint, the served zod schema and the Bazaar schema agree on every body', async () => {
    const { PRE_TRADE_CHECK_SCHEMA } = await import('../../src/tools/pre-trade-check.js');
    const { BAZAAR_ROUTES } = await import('../../src/lib/x402-bazaar.js');
    const { PRE_TRADE_CHECK_PARAM_DECL } = await import('../../src/lib/tool-param-schema.js');
    const bazaar = new Ajv({ strict: false, allErrors: true }).compile(BAZAAR_ROUTES.pre_trade_check.inputSchema);
    const cases: { body: unknown; refusedAt?: string }[] = [
      { body: {} },
      { body: { maxLeverage: 5, noLiqBeforeStop: false, maxSizePctOf24hVolume: 100 } },
      { body: { foo: 1 }, refusedAt: 'rules.foo' },
      { body: [], refusedAt: 'rules' },
      { body: { maxLeverage: { v: 5 } }, refusedAt: 'rules.maxLeverage' },
    ];
    const rules = Object.entries(PRE_TRADE_CHECK_PARAM_DECL.rules.properties) as [string, Record<string, number | string | undefined>][];
    expect(rules).toHaveLength(10);
    for (const [id, p] of rules) {
      const at = `rules.${id}`;
      if (p.type === 'boolean') {
        cases.push({ body: { [id]: true } }, { body: { [id]: false } });
        for (const bad of [1, 'true', null]) cases.push({ body: { [id]: bad }, refusedAt: at });
        continue;
      }
      const max = p.maximum as number;
      if (p.exclusiveMinimum !== undefined) {
        const lo = p.exclusiveMinimum as number;
        cases.push({ body: { [id]: lo }, refusedAt: at }, { body: { [id]: lo + 0.001 } });
      } else {
        const lo = p.minimum as number;
        cases.push({ body: { [id]: lo } }, { body: { [id]: lo - 0.001 }, refusedAt: at });
      }
      cases.push({ body: { [id]: max } }, { body: { [id]: max + 1 }, refusedAt: at });
      for (const bad of [String(max), true, null]) cases.push({ body: { [id]: bad }, refusedAt: at });
    }
    let n = 0;
    for (const c of cases) {
      const label = JSON.stringify(c.body);
      const served = PRE_TRADE_CHECK_SCHEMA.rules.safeParse(c.body).success;
      expect(bazaar({ coin: 'BTC', side: 'long', sizeUsd: 10_000, rules: c.body }), `the two param schemas agree: ${label}`).toBe(served);
      expect(served, `the corpus expects: ${label}`).toBe(c.refusedAt === undefined);
      // A key per body: the corpus is many writes, and the limiter is per key.
      const r = await call('PUT', { key: `av_starter_rules_parity_${n++}`, body: c.body });
      if (served) {
        expect([r.status, r.json?.rules], label).toEqual([200, c.body]);
      } else {
        expect([r.status, r.json?.ok, r.json?.code, r.json?.param], label).toEqual([400, false, 'invalid_rules', c.refusedAt]);
        expect(r.json?.error, `${label}: the error names the key`).toContain(c.refusedAt);
        expect(typeof r.json?.suggested_action, label).toBe('string');
      }
    }
    expect(n).toBeGreaterThan(60);
  });

  it('a refused PUT changes nothing: the saved profile stays', async () => {
    await call('PUT', { key: KEY_A, body: { maxLeverage: 5 } });
    for (const body of [{ maxLeverage: 0 }, { foo: 1 }, { maxLeverage: null }]) {
      expect((await call('PUT', { key: KEY_A, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('GET', { key: KEY_A })).json?.rules).toEqual({ maxLeverage: 5 });
  });

  it('a PUT that carries no JSON body is refused — read as {}, it would clear the profile', async () => {
    await call('PUT', { key: KEY_A, body: { maxLeverage: 5 } });
    const sent: Sent[] = [
      { key: KEY_A, raw: '{"maxLeverage":7}', type: 'text/plain' },
      { key: KEY_A, raw: 'maxLeverage=7', type: 'application/x-www-form-urlencoded' },
      { key: KEY_A, raw: '' },
      { key: KEY_A },
    ];
    for (const s of sent) {
      const r = await call('PUT', s);
      expect([r.status, r.json?.code, r.json?.param], JSON.stringify(s)).toEqual([400, 'invalid_rules', 'rules']);
    }
    expect((await call('GET', { key: KEY_A })).json?.rules).toEqual({ maxLeverage: 5 });
  });

  it('the 4 KB limit: a 4096-byte body is read; a 4097-byte one is refused 413 and nothing is saved', async () => {
    const base = JSON.stringify({ maxLeverage: 5 });
    const over = await call('PUT', { key: KEY_A, raw: base + ' '.repeat(4097 - base.length) });
    expect(over.status).toBe(413);
    expect((await call('GET', { key: KEY_A })).json?.updated_at).toBeNull();
    const at = await call('PUT', { key: KEY_A, raw: base + ' '.repeat(4096 - base.length) });
    expect([at.status, at.json?.rules]).toEqual([200, { maxLeverage: 5 }]);
  });
});

describe('10 writes a minute per key', () => {
  it('the 11th write by one key is refused 429 (PUT and DELETE both count); its reads and another key\'s writes are not', async () => {
    for (let i = 0; i < 9; i++) expect((await call('PUT', { key: KEY_A, body: { maxLeverage: 5 } })).status, `PUT ${i + 1}`).toBe(200);
    const tenth = await call('DELETE', { key: KEY_A });
    expect(tenth.status, 'a DELETE is a write').toBe(200);
    expect(tenth.headers.get('ratelimit-limit'), 'the limiter governs the writes').toBe('10');
    expect((await call('PUT', { key: KEY_A, body: { maxLeverage: 6 } })).status).toBe(429);
    expect((await call('DELETE', { key: KEY_A })).status).toBe(429);
    const read = await call('GET', { key: KEY_A });
    expect([read.status, read.headers.get('ratelimit-limit')], 'reads are not limited').toEqual([200, null]);
    expect((await call('PUT', { key: KEY_B, body: { maxLeverage: 6 } })).status, 'per key, not per address').toBe(200);
  });
});
