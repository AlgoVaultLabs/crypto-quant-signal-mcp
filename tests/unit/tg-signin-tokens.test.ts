/**
 * TG-SIGNIN-W1-R2 CH2 R2.2–R2.5 — the one-time Telegram sign-in token: mint, store, redeem.
 *
 * A checkout bought from the bot's plan buttons reveals its key on /welcome once; that reveal mints ONE token
 * (`tgl_` + 32 lowercase hex), stores its sha256, and the page's Open Telegram button carries the token to the
 * bot, which redeems it through `POST /api/bot/signin-token/redeem`. The table holds NO api key and no chat id:
 * the redeem reads the customer's current key by id at redeem time.
 *
 * Boots the REAL registrar on an ephemeral port (the `entitlement-api.test.ts` shape), on a private SQLite file
 * outside the work tree. On the Postgres lane DATABASE_URL wins and the same assertions run on Postgres. Two
 * seams, both recorders that delegate: the Stripe key read (`getApiKeyByCustomerId`), so "a Stripe error leaves
 * the token redeemable", "deleted / no key" and "over 5 s" are inputs here, and the database (`dbQuery`,
 * `dbExec`), so "nothing is read before auth" is an observation, not an inference.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

const keys = vi.hoisted(() => ({
  // A string is the customer's key, `null` a customer with no key, DELETED a deleted customer, an Error a read
  // that failed, a function the read itself (to hold it open). A customer never set is a failed read too.
  byCustomer: new Map<string, string | null | Error | symbol | (() => Promise<unknown>)>(),
  calls: [] as string[],
  DELETED: Symbol('deleted'),
}));

vi.mock('../../src/lib/stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/stripe.js')>()),
  getApiKeyByCustomerId: async (customerId: string) => {
    keys.calls.push(customerId);
    const v = keys.byCustomer.get(customerId);
    if (typeof v === 'function') return v();
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`no answer mocked for ${customerId}`);
    if (v === keys.DELETED) return { kind: 'deleted' };
    if (v === null) return { kind: 'no_key' };
    return { kind: 'key', apiKey: v };
  },
}));

const db = vi.hoisted(() => ({ statements: [] as string[] }));
vi.mock('../../src/lib/performance-db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/performance-db.js')>();
  return {
    ...real,
    dbQuery: (sql: string, params?: unknown[]) => {
      db.statements.push(sql);
      return real.dbQuery(sql, params);
    },
    dbExec: (sql: string) => {
      db.statements.push(sql);
      return real.dbExec(sql);
    },
  };
});

import { dbQuery, dbExec, isPgBackend, closeDbAsync } from '../../src/lib/performance-db.js';
import {
  REDEEM_PATH,
  SIGNIN_TOKEN_TTL_MS,
  STRIPE_READ_TIMEOUT_MS,
  formatRedeemResponse,
  hashSigninToken,
  isSigninToken,
  mintSigninToken,
  redeemSigninToken,
  registerSigninTokenRoutes,
  signinTokenGrant,
  tgSigninTokensDdl,
  _resetTgSigninTokensForTest,
} from '../../src/lib/tg-signin-tokens.js';

const INTERNAL_KEY = 'test-internal-key-0123456789';
const API_KEY = 'av_live_0123456789abcdef01234567';
const EMAIL = 'buyer@example.com';
const MASKED = 'b***@example.com';
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-tg-signin-tokens-'));
const ORIGINAL = {
  dbPath: process.env.PERFORMANCE_DB_PATH,
  on: process.env.BOT_INTERNAL_BYPASS_ENABLED,
  key: process.env.ALGOVAULT_INTERNAL_BYPASS_KEY,
};

let server: http.Server;
let base: string;

beforeAll(async () => {
  process.env.PERFORMANCE_DB_PATH = path.join(DB_DIR, 'performance.db');
  await closeDbAsync();
  const express = (await import('express')).default;
  const app = express();
  registerSigninTokenRoutes(app);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDbAsync();
  for (const [k, v] of [['PERFORMANCE_DB_PATH', ORIGINAL.dbPath], ['BOT_INTERNAL_BYPASS_ENABLED', ORIGINAL.on], ['ALGOVAULT_INTERNAL_BYPASS_KEY', ORIGINAL.key]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(DB_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.BOT_INTERNAL_BYPASS_ENABLED = 'true';
  process.env.ALGOVAULT_INTERNAL_BYPASS_KEY = INTERNAL_KEY;
  keys.byCustomer.clear();
  keys.calls.length = 0;
  _resetTgSigninTokensForTest();
  // Creates the table on first use (the lazy ensure under test), then empties it.
  await redeemSigninToken('tgl_00000000000000000000000000000000');
  await dbQuery('DELETE FROM tg_signin_tokens RETURNING id');
  db.statements.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const grant = (over: Partial<{ customerId: string; tier: 'starter' | 'pro'; email: string }> = {}) => ({
  customerId: 'cus_tg_1', tier: 'starter' as const, email: EMAIL, ...over,
});
const rows = () => dbQuery<Record<string, unknown>>('SELECT * FROM tg_signin_tokens ORDER BY id');
const ddl = async (sql: string) => (isPgBackend() ? void (await dbQuery(sql)) : dbExec(sql));

/** POST the redeem. `body` is sent as JSON unless it is a string (sent raw, as `type`). */
const redeem = (body: unknown, auth: string | null = INTERNAL_KEY, type = 'application/json') =>
  fetch(`${base}${REDEEM_PATH}`, {
    method: 'POST',
    headers: { 'content-type': type, ...(auth === null ? {} : { 'X-AlgoVault-Internal-Key': auth }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const tableStatements = () => db.statements.filter((s) => /tg_signin_tokens/.test(s));

describe('the token (Build Rule 4) and who is handed one (R2.3)', () => {
  it('tgl_ + 32 lowercase hex, 128 random bits: every mint differs', async () => {
    const minted = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const t = await mintSigninToken(grant());
      expect(t).toMatch(/^tgl_[0-9a-f]{32}$/);
      expect(t).toHaveLength(36);
      minted.add(t!);
    }
    expect(minted.size).toBe(20);
  });

  it('isSigninToken accepts exactly that shape', () => {
    expect(isSigninToken(`tgl_${'a'.repeat(32)}`)).toBe(true);
    expect(isSigninToken(`tgl_${'0123456789abcdef'.repeat(2)}`)).toBe(true);
    for (const bad of [
      `tgl_${'a'.repeat(31)}`, `tgl_${'a'.repeat(33)}`, `tgl_${'A'.repeat(32)}`, `TGL_${'a'.repeat(32)}`,
      `tgc_${'a'.repeat(32)}`, `tgl_${'g'.repeat(32)}`, `tgl_${'a'.repeat(31)}-`, `tgl_${'a'.repeat(32)}\n`,
      ` tgl_${'a'.repeat(32)}`, `auth_${API_KEY}`, '', null, undefined, 42, [`tgl_${'a'.repeat(32)}`], {},
    ]) {
      expect(isSigninToken(bad), JSON.stringify(bad) ?? String(bad)).toBe(false);
    }
  });

  it('a grant needs a Telegram checkout, a starter or pro plan, an email and a customer', () => {
    const ok = { fromTelegram: true, tier: 'starter', email: EMAIL, customerId: 'cus_1' };
    expect(signinTokenGrant(ok)).toEqual({ customerId: 'cus_1', tier: 'starter', email: EMAIL });
    expect(signinTokenGrant({ ...ok, tier: 'pro' })).toEqual({ customerId: 'cus_1', tier: 'pro', email: EMAIL });
    for (const over of [
      { fromTelegram: false }, { fromTelegram: 'true' }, { fromTelegram: undefined },
      { tier: 'enterprise' }, { tier: 'free' }, { tier: null }, { tier: 'Starter' },
      { email: null }, { email: '' }, { customerId: null }, { customerId: '' },
    ]) {
      expect(signinTokenGrant({ ...ok, ...over }), JSON.stringify(over)).toBeNull();
    }
  });
});

describe('mintSigninToken — one row, the hash alone, 24 h (R2.2)', () => {
  it('stores sha256(token), the customer, the tier, the MASKED email and created + 24 h — never the token', async () => {
    const now = new Date('2026-11-16T04:00:00.000Z');
    const token = await mintSigninToken(grant({ tier: 'pro' }), now);
    const [row, ...more] = await rows();
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      token_hash: createHash('sha256').update(token!).digest('hex'),
      customer_id: 'cus_tg_1',
      tier: 'pro',
      email_masked: MASKED,
      redeemed_at: null,
    });
    expect(row.token_hash).toBe(hashSigninToken(token!));
    expect(new Date(row.created_at as string).toISOString()).toBe(now.toISOString());
    expect(new Date(row.expires_at as string).getTime() - new Date(row.created_at as string).getTime()).toBe(SIGNIN_TOKEN_TTL_MS);
    expect(SIGNIN_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(JSON.stringify(row)).not.toContain(token!);
    expect(JSON.stringify(row)).not.toContain(EMAIL);
  });

  it('no api key column and no chat id, in either dialect', () => {
    for (const sql of [...tgSigninTokensDdl(true), ...tgSigninTokensDdl(false)]) {
      expect(sql).not.toMatch(/api_key|chat/i);
    }
  });

  it('a database fault is null, never a throw — logged without the token or the email', async () => {
    await ddl('DROP TABLE IF EXISTS tg_signin_tokens');
    await ddl('CREATE TABLE tg_signin_tokens (unrelated INTEGER)');
    _resetTgSigninTokensForTest();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await mintSigninToken(grant())).toBeNull();
      const logged = err.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toMatch(/\[tg-signin-tokens\] mint failed/);
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain(MASKED);
      expect(logged).not.toMatch(/tgl_[0-9a-f]{32}/);
    } finally {
      await ddl('DROP TABLE IF EXISTS tg_signin_tokens');
      _resetTgSigninTokensForTest();
    }
  });
});

describe('the route refuses without the internal key (R2.4)', () => {
  it('401 with validate-key\'s shape, never cached — no header, a wrong key', async () => {
    const token = await mintSigninToken(grant());
    for (const auth of [null, 'wrong-key']) {
      const r = await redeem({ token }, auth);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('403 when the bypass is off — the same two-flag firewall as validate-key', async () => {
    process.env.BOT_INTERNAL_BYPASS_ENABLED = 'false';
    const r = await redeem({ token: `tgl_${'a'.repeat(32)}` });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'bot_internal_bypass_disabled' });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('an unauthenticated redeem reads no table and asks Stripe nothing — and the token stays redeemable', async () => {
    const token = await mintSigninToken(grant());
    keys.byCustomer.set('cus_tg_1', API_KEY);
    db.statements.length = 0;
    expect((await redeem({ token }, null)).status).toBe(401);
    expect((await redeem('{not json', null)).status).toBe(401);
    expect(tableStatements()).toEqual([]);
    expect(keys.calls).toEqual([]);
    const r = await redeem({ token });
    expect(await r.json()).toMatchObject({ ok: true });
  });
});

describe('POST /api/bot/signin-token/redeem (R2.4)', () => {
  it('a token redeems ONCE: the key, the tier and the masked email; the second call is {ok:false} with no Stripe call', async () => {
    const token = await mintSigninToken(grant({ tier: 'pro' }));
    keys.byCustomer.set('cus_tg_1', API_KEY);
    const first = await redeem({ token });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual({ ok: true, api_key: API_KEY, tier: 'pro', email_masked: MASKED });
    expect(keys.calls).toEqual(['cus_tg_1']);
    const [row] = await rows();
    expect(row.redeemed_at).not.toBeNull();
    const second = await redeem({ token });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: false });
    expect(keys.calls).toEqual(['cus_tg_1']);
  });

  it('bad shape, unknown token, a body that is not JSON or is over 1 kB → 200 {ok:false}, no Stripe call', async () => {
    await mintSigninToken(grant());
    keys.byCustomer.set('cus_tg_1', API_KEY);
    const bodies: Array<[unknown, string?]> = [
      [{}], [{ token: null }], [{ token: 42 }], [{ token: [`tgl_${'a'.repeat(32)}`] }], [{ token: `tgl_${'A'.repeat(32)}` }],
      [{ token: `tgl_${'a'.repeat(31)}` }], [{ token: `auth_${API_KEY}` }], [{ token: `tgl_${'a'.repeat(32)}` }], // unknown
      ['{not json'], [`{"token":"${'x'.repeat(2048)}"}`], [['tgl_']], [`tgl_${'a'.repeat(32)}`, 'text/plain'],
    ];
    for (const [body, type] of bodies) {
      const r = await redeem(body, INTERNAL_KEY, type);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(200);
      expect(await r.json()).toEqual({ ok: false });
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect(keys.calls).toEqual([]);
    expect((await rows())[0].redeemed_at).toBeNull();
  });

  it('an expired token is {ok:false} with no Stripe call; one a second inside its 24 h redeems', async () => {
    const t0 = Date.now();
    const old = await mintSigninToken(grant({ customerId: 'cus_old' }), new Date(t0 - SIGNIN_TOKEN_TTL_MS - 1000));
    const fresh = await mintSigninToken(grant({ customerId: 'cus_fresh' }), new Date(t0 - SIGNIN_TOKEN_TTL_MS + 60_000));
    keys.byCustomer.set('cus_old', API_KEY);
    keys.byCustomer.set('cus_fresh', API_KEY);
    expect(await (await redeem({ token: old })).json()).toEqual({ ok: false });
    expect(keys.calls).toEqual([]);
    expect(await (await redeem({ token: fresh })).json()).toMatchObject({ ok: true, api_key: API_KEY });
  });

  it('a Stripe error is a 503 and the token stays redeemable: the next redeem gets the key', async () => {
    const token = await mintSigninToken(grant());
    keys.byCustomer.set('cus_tg_1', Object.assign(new Error('Service Unavailable'), { type: 'StripeAPIError', statusCode: 503 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await redeem({ token });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: 'stripe_unavailable' });
    expect((await rows())[0].redeemed_at).toBeNull();
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/left unspent/);
    keys.byCustomer.set('cus_tg_1', API_KEY);
    expect(await (await redeem({ token })).json()).toEqual({ ok: true, api_key: API_KEY, tier: 'starter', email_masked: MASKED });
  });

  it('the whole Stripe read is bounded at 5 s: over it → 503, the token unspent, and a late answer spends nothing', async () => {
    expect(STRIPE_READ_TIMEOUT_MS).toBe(5_000);
    const token = await mintSigninToken(grant());
    let answer: (v: unknown) => void = () => {};
    keys.byCustomer.set('cus_tg_1', () => new Promise((resolve) => { answer = resolve; }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = redeemSigninToken(token);
    await vi.advanceTimersByTimeAsync(STRIPE_READ_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 503, body: { ok: false, error: 'stripe_unavailable' } });
    answer({ kind: 'key', apiKey: API_KEY }); // the read finally answers — after the 503
    await Promise.resolve();
    vi.useRealTimers();
    expect((await rows())[0].redeemed_at).toBeNull();
    keys.byCustomer.set('cus_tg_1', API_KEY);
    expect(await redeemSigninToken(token)).toEqual({ status: 200, body: { ok: true, api_key: API_KEY, tier: 'starter', email_masked: MASKED } });
  });

  it('a deleted or keyless customer spends the token and answers {ok:false}; the next call asks Stripe nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [customerId, answer] of [['cus_gone', keys.DELETED], ['cus_nokey', null]] as const) {
      const token = await mintSigninToken(grant({ customerId }));
      keys.byCustomer.set(customerId, answer);
      expect(await (await redeem({ token })).json()).toEqual({ ok: false });
      expect(await (await redeem({ token })).json()).toEqual({ ok: false });
      expect(keys.calls.filter((c) => c === customerId)).toEqual([customerId]);
    }
    expect((await rows()).map((r) => r.redeemed_at === null)).toEqual([false, false]);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/is deleted[\s\S]*carries no key/);
  });

  it('a race: of concurrent redeems of one token exactly ONE gets the key, the rest {ok:false}', async () => {
    const token = await mintSigninToken(grant());
    // Hold every Stripe read open until all redeems have read the row, so each passes the unredeemed check
    // and only the spend can tell them apart.
    const waiting: Array<() => void> = [];
    keys.byCustomer.set('cus_tg_1', () => new Promise((resolve) => { waiting.push(() => resolve({ kind: 'key', apiKey: API_KEY })); }));
    const n = 4;
    const outcomes = Array.from({ length: n }, () => redeemSigninToken(token));
    await vi.waitFor(() => expect(waiting).toHaveLength(n));
    for (const go of waiting) go();
    const bodies = (await Promise.all(outcomes)).map((o) => o.body);
    expect(bodies.filter((b) => b.ok)).toEqual([{ ok: true, api_key: API_KEY, tier: 'starter', email_masked: MASKED }]);
    expect(bodies.filter((b) => !b.ok)).toHaveLength(n - 1);
  });

  it('no log line carries the token, the key or the email — on any path', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    }
    const tokens: string[] = [];
    const paths: Array<[string, unknown]> = [
      ['cus_ok', API_KEY], ['cus_503', new Error(`upstream said ${API_KEY} ${EMAIL}`)], ['cus_del', keys.DELETED], ['cus_none', null],
    ];
    for (const [customerId, answer] of paths) {
      const token = (await mintSigninToken(grant({ customerId })))!;
      tokens.push(token);
      keys.byCustomer.set(customerId, answer as string);
      await redeem({ token });
      await redeem({ token });
    }
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const secret of [...tokens, ...tokens.map(hashSigninToken), API_KEY, EMAIL, MASKED]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('formatRedeemResponse — the allow-list (lead ruling 11:05)', () => {
  it('OK is exactly {ok, api_key, tier, email_masked}: a boolean ok, tier starter|pro, a non-empty masked email', () => {
    for (const tier of ['starter', 'pro'] as const) {
      const out = formatRedeemResponse({ apiKey: API_KEY, tier, emailMasked: MASKED });
      expect(out).toEqual({ ok: true, api_key: API_KEY, tier, email_masked: MASKED });
      expect(Object.keys(out)).toEqual(['ok', 'api_key', 'tier', 'email_masked']);
      expect(typeof out.ok).toBe('boolean');
    }
  });

  it('anything short of that is {ok:false} — and ok is still a boolean', () => {
    const bad = [
      { apiKey: '', tier: 'pro', emailMasked: MASKED }, { apiKey: null, tier: 'pro', emailMasked: MASKED },
      { apiKey: API_KEY, tier: 'enterprise', emailMasked: MASKED }, { apiKey: API_KEY, tier: 'free', emailMasked: MASKED },
      { apiKey: API_KEY, tier: null, emailMasked: MASKED }, { apiKey: API_KEY, tier: 'pro', emailMasked: '' },
      { apiKey: API_KEY, tier: 'pro', emailMasked: null }, { apiKey: API_KEY, tier: 'pro', emailMasked: 7 },
    ];
    for (const r of bad) {
      const out = formatRedeemResponse(r);
      expect(out, JSON.stringify(r)).toEqual({ ok: false });
      expect(typeof out.ok).toBe('boolean');
    }
  });

  it('nothing from the row leaves: the answer never names the customer, the hash or the expiry', async () => {
    const token = await mintSigninToken(grant());
    keys.byCustomer.set('cus_tg_1', API_KEY);
    const body = JSON.stringify(await (await redeem({ token })).json());
    const [row] = await rows();
    for (const v of ['cus_tg_1', row.token_hash, 'expires_at', 'created_at', 'redeemed_at', 'customer_id', 'id"']) {
      expect(body).not.toContain(String(v));
    }
  });
});

describe('the server wires it (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');

  it('the route registers once, beside validate-key', () => {
    const iValidate = src.indexOf("app.get('/api/bot/validate-key'");
    const iRegister = src.indexOf('registerSigninTokenRoutes(app);');
    expect(iValidate).toBeGreaterThan(0);
    expect(iRegister).toBeGreaterThan(iValidate);
    expect(src.indexOf('registerSigninTokenRoutes(app);', iRegister + 1)).toBe(-1);
  });
});
