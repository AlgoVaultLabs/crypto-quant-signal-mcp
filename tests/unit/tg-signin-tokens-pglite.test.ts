/**
 * TG-SIGNIN-W1-R2 CH2 R2.2 + TG-SIGNIN-W1 lead ruling L1 — `tg_signin_tokens` in a REAL Postgres engine (PGlite).
 *
 * The shape `tests/unit/call-ledger-pglite.test.ts` set: `dbQuery` is routed to an in-process PGlite, so every
 * statement the store issues — the lazy ensure, the insert, the lookup and the spend — is parsed, planned and
 * constrained by Postgres itself. Nothing here is a recorded string.
 *
 *   - the migration IS the lazy ensure: the same statements, in the same order, once normalized;
 *   - L1 (revertible): 057 applies up → down → up, applies twice (idempotent), and its down removes every
 *     object it created — `MIGRATION_DOWN_OK=YES` in the CH2 gate is this describe passing;
 *   - the token hash is UNIQUE in the engine, and a spend sets `redeemed_at` once.
 *
 * PGlite runs PostgreSQL 18; production runs 16. The SQL is written to 16 (the static guard at the end refuses
 * the 17/18-only syntax), and CI's Postgres lane applies every migration to postgres:16-alpine.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const pg = vi.hoisted(() => ({
  db: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  statements: [] as string[],
}));

vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  isPgBackend: () => true,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    pg.statements.push(sql);
    // The production PgBackend's own placeholder rewrite (`?` → `$n`), so the store's portable SQL reaches
    // Postgres exactly as it does in production.
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    return (await pg.db!.query(pgSql, params)).rows;
  },
  // The Postgres path must await every statement through dbQuery; a fire-and-forget exec there could never
  // report a failure to the caller.
  dbExec: () => { throw new Error('dbExec must not run on the Postgres path'); },
}));

const keys = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../src/lib/stripe.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/stripe.js')>()),
  getApiKeyByCustomerId: async (customerId: string) => {
    keys.calls.push(customerId);
    return { kind: 'key', apiKey: 'av_live_0123456789abcdef01234567' };
  },
}));

import {
  tgSigninTokensDdl,
  mintSigninToken,
  redeemSigninToken,
  hashSigninToken,
  _resetTgSigninTokensForTest,
} from '../../src/lib/tg-signin-tokens.js';

const ROOT = resolve(__dirname, '../..');
const M057 = readFileSync(join(ROOT, 'migrations/057_tg_signin_tokens.sql'), 'utf8');
const M057_DOWN = readFileSync(join(ROOT, 'migrations/057_tg_signin_tokens.down.sql'), 'utf8');
const STORE = readFileSync(join(ROOT, 'src/lib/tg-signin-tokens.ts'), 'utf8');
const GRANT = { customerId: 'cus_pg_1', tier: 'starter' as const, email: 'zed@example.org' };

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
  pg.db = db;
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS tg_signin_tokens CASCADE');
  _resetTgSigninTokensForTest();
  pg.statements = [];
  keys.calls = [];
});

/** Statements as text: comments out, whitespace collapsed, no trailing `;`. */
function statementsOf(sql: string): string[] {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const count = async (sql: string): Promise<number> => Number(((await db.query(sql)).rows[0] as { n: number }).n);
const tableExists = () => count("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tg_signin_tokens'");

describe('057 — the migration IS the lazy ensure', () => {
  it('the same statements, in the same order, once normalized', () => {
    expect(statementsOf(M057)).toEqual(tgSigninTokensDdl(true).map(norm));
    expect(statementsOf(M057)).toHaveLength(1);
  });

  it('the lazy ensure creates the table on a fresh Postgres with exactly those statements', async () => {
    expect(await tableExists()).toBe(0);
    expect(await redeemSigninToken(`tgl_${'0'.repeat(32)}`)).toEqual({ status: 200, body: { ok: false } });
    expect(await tableExists()).toBe(1);
    const ddl = pg.statements.filter((s) => /^\s*CREATE\b/.test(s)).map(norm);
    expect(ddl).toEqual(statementsOf(M057));
  });

  it('the SQLite dialect differs only in its types and default — same columns, same constraints', () => {
    const lite = tgSigninTokensDdl(false).map(norm);
    const pgs = tgSigninTokensDdl(true).map(norm);
    expect(lite).toHaveLength(pgs.length);
    const cols = (s: string) => [...s.matchAll(/(\w+) (?:BIGSERIAL|INTEGER|TEXT|TIMESTAMPTZ|TIMESTAMP)\b/g)].map((m) => m[1]);
    expect(cols(lite[0])).toEqual(cols(pgs[0]));
    expect(cols(pgs[0])).toEqual(['id', 'token_hash', 'customer_id', 'tier', 'email_masked', 'created_at', 'expires_at', 'redeemed_at']);
    const rest = (s: string) => s.replace(/BIGSERIAL PRIMARY KEY|INTEGER PRIMARY KEY AUTOINCREMENT|TIMESTAMPTZ|TIMESTAMP|now\(\)|\(datetime\('now'\)\)/g, '_');
    expect(rest(lite[0])).toBe(rest(pgs[0]));
  });

  it('no api key column and no chat id, in either dialect or in the migration (the column list above is exhaustive)', () => {
    for (const sql of [...statementsOf(M057), ...tgSigninTokensDdl(true), ...tgSigninTokensDdl(false)]) {
      expect(sql).not.toMatch(/api_key|chat/i);
    }
  });
});

describe('L1 — 057 is revertible: up → down → up, and idempotent', () => {
  it('applies twice, its down removes the table, and it applies again', async () => {
    await db.exec(M057);
    await db.exec(M057);
    expect(await count("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tg_signin_tokens'")).toBe(8);
    expect(M057_DOWN).toContain('DESTRUCTIVE');
    await db.exec(M057_DOWN);
    expect(await tableExists()).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'tg_signin_tokens'")).toBe(0);
    await db.exec(M057_DOWN); // a second down is a no-op, not an error
    await db.exec(M057);
    expect(await tableExists()).toBe(1);
  });

  it('token_hash is UNIQUE and NOT NULL in the engine; email_masked and expires_at are NOT NULL', async () => {
    await db.exec(M057);
    const insert = (hash: string | null, masked: string | null = 'z***@example.org', expires: string | null = '2026-11-17T00:00:00Z') =>
      db.query('INSERT INTO tg_signin_tokens (token_hash, customer_id, tier, email_masked, expires_at) VALUES ($1, $2, $3, $4, $5)', [hash, 'cus', 'pro', masked, expires]);
    await insert('h1');
    await expect(insert('h1')).rejects.toThrow(/duplicate key|unique/i);
    await expect(insert(null)).rejects.toThrow(/null value/i);
    await expect(insert('h2', null)).rejects.toThrow(/null value/i);
    await expect(insert('h3', 'z***@example.org', null)).rejects.toThrow(/null value/i);
  });
});

describe('the store on Postgres', () => {
  it('mint stores the hash and created + 24 h; the redeem spends it once', async () => {
    const now = new Date(Date.now() - 60_000);
    const token = (await mintSigninToken(GRANT, now))!;
    const [row] = (await db.query('SELECT * FROM tg_signin_tokens')).rows as Record<string, unknown>[];
    expect(row).toMatchObject({ token_hash: hashSigninToken(token), customer_id: 'cus_pg_1', tier: 'starter', email_masked: 'z***@example.org', redeemed_at: null });
    expect((row.expires_at as Date).getTime() - (row.created_at as Date).getTime()).toBe(24 * 60 * 60 * 1000);
    expect((row.created_at as Date).toISOString()).toBe(now.toISOString());
    expect(await redeemSigninToken(token)).toEqual({
      status: 200, body: { ok: true, api_key: 'av_live_0123456789abcdef01234567', tier: 'starter', email_masked: 'z***@example.org' },
    });
    expect(await redeemSigninToken(token)).toEqual({ status: 200, body: { ok: false } });
    expect(keys.calls).toEqual(['cus_pg_1']);
    const [spent] = (await db.query('SELECT redeemed_at FROM tg_signin_tokens')).rows as Array<{ redeemed_at: Date | null }>;
    expect(spent.redeemed_at).toBeInstanceOf(Date);
  });

  it('an expired token reads as expired against Postgres timestamps too', async () => {
    const token = (await mintSigninToken(GRANT, new Date(Date.now() - 25 * 60 * 60 * 1000)))!;
    expect(await redeemSigninToken(token)).toEqual({ status: 200, body: { ok: false } });
    expect(keys.calls).toEqual([]);
  });

  it('the spend sets redeemed_at only where it is still NULL — checked in the engine', async () => {
    await db.exec(M057);
    await db.exec("INSERT INTO tg_signin_tokens (token_hash, customer_id, tier, email_masked, expires_at) VALUES ('h', 'c', 'pro', 'm', now() + interval '1 hour')");
    const spend = () => db.query("UPDATE tg_signin_tokens SET redeemed_at = $1 WHERE id = $2 AND redeemed_at IS NULL RETURNING id", [new Date().toISOString(), 1]);
    expect((await spend()).rows).toHaveLength(1);
    expect((await spend()).rows).toHaveLength(0);
    expect(STORE).toContain("'UPDATE tg_signin_tokens SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL RETURNING id'");
  });
});

describe('PG16 only', () => {
  it('no statement uses 17/18-only syntax (PGlite runs 18, production 16)', () => {
    const sql = [M057, M057_DOWN, STORE].join('\n');
    for (const re of [/\bRETURNING\s+(OLD|NEW)\b/i, /\bMERGE\s+INTO\b/i, /\bJSON_(TABLE|QUERY|VALUE|EXISTS)\s*\(/i, /\buuidv7\s*\(/i, /\bVIRTUAL\b/, /\bWITHOUT\s+OVERLAPS\b/i, /\bON_ERROR\b/]) {
      expect(sql, String(re)).not.toMatch(re);
    }
  });
});
