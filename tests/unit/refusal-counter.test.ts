/**
 * refusal-counter.test.ts — REGIME-TF-ADMISSION-W1 CH2 (AC4, AC5).
 *
 * Every refused tool input becomes a persistent daily count. `dbQuery` is routed to an in-process PGlite (the shape
 * tests/unit/tg-signin-tokens-pglite.test.ts set), so the ensure, the seed and the upsert are parsed, planned and
 * constrained by Postgres itself.
 *
 *   - the four call sites count: an enum refusal at the MCP seam (zod, inside the SDK), an unknown key, the pipeline's
 *     timeframe admission, a non-public venue — each with the request's own caller (keyed, request_log's ip_hash);
 *   - the record path is synchronous, never throws and makes no DB call; a failing flush never throws, never delays a
 *     response, logs ONE line and drops its batch;
 *   - the bounds: ≤ 32 chars of [A-Za-z0-9_.:-] else <other>; ≤ 10,000 distinct keys per UTC day, then <overflow>,
 *     counting the rows the table already held for the day;
 *   - 058 IS the ensure, applies up → down → up, its aoe_readonly GRANT is guarded, and aoe_readonly can read the table;
 *   - the refusal text and the enum leaves' behaviour are unchanged by the observer.
 *
 * PGlite runs PostgreSQL 18; production runs 16. The SQL is written to 16 (the static guard at the end).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { PGlite } from '@electric-sql/pglite';

const pg = vi.hoisted(() => ({
  db: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown> },
  statements: [] as string[],
  fail: null as null | Error,
  isPg: true,
}));

vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  isPgBackend: () => pg.isPg,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    pg.statements.push(sql);
    if (pg.fail) throw pg.fail;
    // The production PgBackend's own placeholder rewrite (`?` → `$n`).
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    return (await pg.db!.query(pgSql, params)).rows;
  },
}));

import {
  recordRefusal,
  flushRefusals,
  observeEnumLeaves,
  _pendingRefusalsForTest,
  _resetRefusalCounterForTest,
} from '../../src/lib/refusal-counter.js';
import { recordNonPublicVenue } from '../../src/lib/non-public-venue-counter.js';
import { requestContext } from '../../src/lib/license.js';
import { callTool, type ValidatedToolInput } from '../../src/lib/tool-call-pipeline.js';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const M058 = read('migrations/058_refusal_counts.sql');
const M058_DOWN = read('migrations/058_refusal_counts.down.sql');
const STORE = read('src/lib/refusal-counter.ts');

const IP = 'v2:0123456789abcdef';
const FREE = { tier: 'free', key: null, outcome: 'RESOLVED' } as const;
const KEYED = { tier: 'starter', key: 'av_live_test0000000000000000000000', outcome: 'RESOLVED' } as const;
const ctx = (license: typeof FREE | typeof KEYED = FREE) => ({ license, sessionId: 'refusal-test', ipHash: IP, isAutomated: false });
const DAY = new Date().toISOString().slice(0, 10);

/** Statements as text: comments out, whitespace collapsed; `;` inside a `$$ … $$` body does not split. */
function statementsOf(sql: string): string[] {
  const text = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const out: string[] = [];
  let cur = '';
  let inBody = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$$', i)) { inBody = !inBody; cur += '$$'; i++; continue; }
    if (text[i] === ';' && !inBody) { out.push(cur); cur = ''; continue; }
    cur += text[i];
  }
  out.push(cur);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const count = async (sql: string): Promise<number> => Number(((await pg.db!.query(sql)).rows[0] as { n: number }).n);
const tableExists = () => count("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'refusal_counts'");
const rowsOf = async () => (await pg.db!.query('SELECT day::text AS day, reason, tool, parameter, value, keyed, caller_key, count::int AS count FROM refusal_counts ORDER BY reason, tool, parameter, value')).rows;

let db: PGlite;
let mcp: { client: { close(): Promise<void>; callTool(a: unknown): Promise<unknown> }; server: { close(): Promise<void> } };

beforeAll(async () => {
  db = await PGlite.create();
  pg.db = db as never;
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createSandboxServer();
  const client = new Client({ name: 'refusal-counter', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  mcp = { client: client as never, server: server as never };
}, 60_000);
afterAll(async () => {
  await mcp.client.close();
  await mcp.server.close();
  await db.close();
});
beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS refusal_counts CASCADE');
  _resetRefusalCounterForTest();
  pg.statements = [];
  pg.fail = null;
  pg.isPg = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type McpResult = { isError?: boolean; content: Array<{ text: string }> };
const mcpCall = (name: string, args: Record<string, unknown>, c = ctx()) =>
  requestContext.run(c as never, () => mcp.client.callTool({ name, arguments: args })) as Promise<McpResult>;
const pendingOf = (reason: string) => _pendingRefusalsForTest().filter((r) => r.reason === reason);

// ─────────────────────────────── the four call sites ───────────────────────────────

describe('an enum refusal at the MCP seam counts — and its refusal text is byte-identical', () => {
  it('scan_market_regimes 15m: one invalid_enum_value row with the request\'s caller; the text is the pre-wave text', async () => {
    const r = await mcpCall('scan_market_regimes', { timeframe: '15m' });
    expect(r.isError).toBe(true);
    // Captured from the server at the CH1 head, before the observer existed (audits evidence: refusal-text-before).
    expect(r.content[0].text).toBe("MCP error -32602: Input validation error: Invalid arguments for tool scan_market_regimes: [\n  {\n    \"received\": \"15m\",\n    \"code\": \"invalid_enum_value\",\n    \"options\": [\n      \"1h\",\n      \"4h\",\n      \"1d\"\n    ],\n    \"path\": [\n      \"timeframe\"\n    ],\n    \"message\": \"Invalid enum value. Expected '1h' | '4h' | '1d', received '15m'\"\n  }\n]");
    expect(_pendingRefusalsForTest()).toEqual([
      { day: DAY, reason: 'invalid_enum_value', tool: 'scan_market_regimes', parameter: 'timeframe', value: '15m', keyed: false, callerKey: IP, count: 1 },
    ]);
  });

  it('enums under .default(), .optional() + z.array() and a bare .describe() all count; keyed follows the license', async () => {
    await mcpCall('scan_market_regimes', { regime: ['SIDEWAYS'] }, ctx(KEYED));
    await mcpCall('pre_trade_check', { coin: 'BTC', side: 'flat', sizeUsd: 1000 }, ctx(KEYED));
    await mcpCall('pre_trade_check', { coin: 'BTC', side: 'long', sizeUsd: 1000, timeframe: '15m' });
    expect(pendingOf('invalid_enum_value').map((r) => [r.tool, r.parameter, r.value, r.keyed, r.count])).toEqual([
      ['scan_market_regimes', 'regime', 'SIDEWAYS', true, 1],
      ['pre_trade_check', 'side', 'flat', true, 1],
      ['pre_trade_check', 'timeframe', '15m', false, 1],
    ]);
  });

  it('a served value counts nothing', async () => {
    await mcpCall('scan_market_regimes', { timeframe: '4h' });
    expect(pendingOf('invalid_enum_value')).toEqual([]);
  });
});

describe('an unknown key counts — the stdout line stays', () => {
  it('get_market_regime {venue}: one unrecognized_keys row naming the key and its value, and the [tool-args] line once', async () => {
    const log = vi.spyOn(console, 'log');
    const r = await mcpCall('get_market_regime', { coin: 'BTC', venue: 'BINANCE' });
    expect(r.isError).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[tool-args]'))).toEqual(['[tool-args] refused tool=get_market_regime unknown=venue keyed=n']);
    expect(pendingOf('unrecognized_keys')).toEqual([
      { day: DAY, reason: 'unrecognized_keys', tool: 'get_market_regime', parameter: 'venue', value: 'BINANCE', keyed: false, callerKey: IP, count: 1 },
    ]);
  });
});

describe('the pipeline\'s timeframe admission refusal counts', () => {
  it('get_market_regime 2h through callTool: refused INVALID_TIMEFRAME and one timeframe_admission row with the ctx caller', async () => {
    const out = await callTool({ tool: 'get_market_regime', input: { coin: 'BTC', timeframe: '2h' } as unknown as ValidatedToolInput, license: KEYED as never, channel: 'mcp', ctx: { sessionId: 's', ipHash: IP, isAutomated: false } as never });
    expect(out.ok).toBe(false);
    expect((out as { payload: { code: string; valid_timeframes: string[] } }).payload).toMatchObject({ code: 'INVALID_TIMEFRAME', valid_timeframes: ['1h', '4h', '1d'] });
    expect(pendingOf('timeframe_admission')).toEqual([
      { day: DAY, reason: 'timeframe_admission', tool: 'get_market_regime', parameter: 'timeframe', value: '2h', keyed: true, callerKey: IP, count: 1 },
    ]);
  });

  it('scan_market_regimes 15m (an ACP-style free string reaching the pipeline) is refused naming 1h, 4h, 1d, and counts', async () => {
    const out = await callTool({ tool: 'scan_market_regimes', input: { timeframe: '15m' } as unknown as ValidatedToolInput, license: FREE as never, channel: 'mcp', ctx: { sessionId: 's', ipHash: IP, isAutomated: false } as never });
    expect((out as { payload: { code: string; valid_timeframes: string[] } }).payload).toMatchObject({ code: 'INVALID_TIMEFRAME', valid_timeframes: ['1h', '4h', '1d'] });
    expect(pendingOf('timeframe_admission').map((r) => [r.tool, r.value, r.keyed])).toEqual([['scan_market_regimes', '15m', false]]);
  });
});

describe('a non-public venue counts — exactly once per call, per reason', () => {
  it('the /mcp seam (recordNonPublicVenue in the request scope) plus the SDK\'s zod refusal of the same call: one row each', async () => {
    // The route's own sequence for one POST: the venue seam at the top of the request scope, then the SDK parse.
    await requestContext.run(ctx(KEYED) as never, async () => {
      recordNonPublicVenue('BITMART', 'get_trade_call', 'starter');
      await mcp.client.callTool({ name: 'get_trade_call', arguments: { coin: 'BTC', exchange: 'BITMART' } });
    });
    expect(pendingOf('non_public_venue')).toEqual([
      { day: DAY, reason: 'non_public_venue', tool: 'get_trade_call', parameter: 'exchange', value: 'BITMART', keyed: true, callerKey: IP, count: 1 },
    ]);
    expect(pendingOf('invalid_enum_value').map((r) => [r.tool, r.parameter, r.value, r.count])).toEqual([['get_trade_call', 'exchange', 'BITMART', 1]]);
  });

  it('the route calls it once, inside the request scope, before the transport — and a public venue counts nothing', () => {
    const idx = read('src/index.ts');
    expect(idx.split('recordNonPublicVenue(venueArg, callTool, license.tier)').length - 1).toBe(1);
    const run = idx.indexOf('await requestContext.run({ license, sessionId, ipHash');
    const call = idx.indexOf('recordNonPublicVenue(venueArg, callTool, license.tier)');
    const transport = idx.indexOf('handleMcpStateless(', run);
    expect(run).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(run);
    expect(transport).toBeGreaterThan(call);
    recordNonPublicVenue('BINANCE', 'get_trade_call', 'free');
    expect(pendingOf('non_public_venue')).toEqual([]);
  });
});

// ─────────────────────────────── the record path ───────────────────────────────

describe('the record path never throws, never awaits, never touches the database', () => {
  it('is synchronous and returns nothing; hostile input is absorbed', () => {
    expect(recordRefusal({ reason: 'invalid_enum_value', tool: 't', parameter: 'p', value: 'v', keyed: false, callerKey: IP })).toBeUndefined();
    expect(() => recordRefusal(null as never)).not.toThrow();
    expect(() => recordRefusal({ reason: 'invalid_enum_value', tool: 't', parameter: 'p', value: { toString() { throw new Error('x'); } }, keyed: false, callerKey: IP })).not.toThrow();
    expect(pg.statements).toEqual([]);
  });

  it('an observer that throws never changes the refusal: same issues, same messages as the bare schema', () => {
    const shape = { timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe('d'), side: z.enum(['long', 'short']) };
    const observed = observeEnumLeaves(shape, () => { throw new Error('observer down'); });
    const bad = { timeframe: '15m', side: 'flat' };
    expect(() => z.object(observed).strict().safeParse(bad)).not.toThrow();
    expect(z.object(observed).strict().safeParse(bad).error!.issues).toEqual(z.object(shape).strict().safeParse(bad).error!.issues);
    expect(observed.timeframe.description).toBe('d');
    expect(z.object(observed).parse({ side: 'long' })).toEqual({ timeframe: '4h', side: 'long' });
  });

  it('a field without an enum is returned as the same object', () => {
    const coin = z.string().max(20);
    expect(observeEnumLeaves({ coin }, () => {}).coin).toBe(coin);
  });

  it('a failing flush never throws or delays a response: the refusal still returns at once, the flush logs ONE line and drops its batch', async () => {
    pg.fail = new Error('connection refused');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await mcpCall('scan_market_regimes', { timeframe: '15m' });
    expect(r.isError).toBe(true);
    const out = await callTool({ tool: 'get_market_regime', input: { coin: 'BTC', timeframe: '2h' } as unknown as ValidatedToolInput, license: FREE as never, channel: 'mcp', ctx: { sessionId: 's', ipHash: IP, isAutomated: false } as never });
    expect(out.ok).toBe(false);
    expect(pg.statements).toEqual([]); // neither response waited on the database
    await expect(flushRefusals()).resolves.toBeUndefined();
    expect(err.mock.calls.filter((c) => String(c[0]).startsWith('[refusal-counter] flush failed'))).toHaveLength(1);
    expect(String(err.mock.calls[0][0])).toContain('dropped 2 key(s)');
    expect(_pendingRefusalsForTest()).toEqual([]);
    // The next flush retries the ensure and writes.
    pg.fail = null;
    recordRefusal({ reason: 'invalid_enum_value', tool: 'scan_market_regimes', parameter: 'timeframe', value: '15m', keyed: false, callerKey: IP });
    await flushRefusals();
    expect(await rowsOf()).toHaveLength(1);
  });

  it('a local (SQLite) install keeps nothing and issues no statement', async () => {
    pg.isPg = false;
    recordRefusal({ reason: 'invalid_enum_value', tool: 't', parameter: 'p', value: 'v', keyed: false, callerKey: IP });
    await flushRefusals();
    expect(pg.statements).toEqual([]);
    expect(_pendingRefusalsForTest()).toEqual([]);
  });

  it('the interval flushes on its own (armed by the first record, unref\'d), and the ensure runs only on the flush path', async () => {
    vi.useFakeTimers();
    recordRefusal({ reason: 'invalid_enum_value', tool: 't', parameter: 'p', value: 'v', keyed: false, callerKey: IP });
    expect(pg.statements).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await count('SELECT count(*)::int AS n FROM refusal_counts')).toBe(1));
    expect(STORE.match(/ensureRefusalCounts\(\)/g)).toHaveLength(2); // its declaration and its one call, in flushRefusals
    const flushBody = STORE.slice(STORE.indexOf('export async function flushRefusals'), STORE.indexOf('/** Tests only'));
    expect(flushBody).toContain('await ensureRefusalCounts();');
  });

  it('the HTTP shutdown flushes before the pool closes', () => {
    const idx = read('src/index.ts');
    const at = idx.indexOf("console.log('Shutting down...');");
    const end = idx.indexOf("process.on('SIGTERM', shutdown);", at);
    const body = idx.slice(at, end);
    expect(body.indexOf('flushRefusals()')).toBeGreaterThan(-1);
    expect(body.indexOf('closeDb()')).toBeGreaterThan(-1);
    expect(body.indexOf('flushRefusals()')).toBeLessThan(body.indexOf('.then(closeAndExit, closeAndExit)'));
  });
});

// ─────────────────────────────── persistence + bounds ───────────────────────────────

describe('the daily count persists (PGlite)', () => {
  it('a batched upsert: one row per key with its count, and a later flush adds to it', async () => {
    const rec = (value: string, keyed = false) => recordRefusal({ reason: 'invalid_enum_value', tool: 'scan_market_regimes', parameter: 'timeframe', value, keyed, callerKey: IP });
    rec('15m'); rec('15m'); rec('15m'); rec('30m', true);
    await flushRefusals();
    expect(await rowsOf()).toEqual([
      { day: DAY, reason: 'invalid_enum_value', tool: 'scan_market_regimes', parameter: 'timeframe', value: '15m', keyed: false, caller_key: IP, count: 3 },
      { day: DAY, reason: 'invalid_enum_value', tool: 'scan_market_regimes', parameter: 'timeframe', value: '30m', keyed: true, caller_key: IP, count: 1 },
    ]);
    rec('15m');
    await flushRefusals();
    expect(((await rowsOf())[0] as { count: number }).count).toBe(4);
    // Distinct refused callers per value — the read REGIME-15M-SERVE-W1's trigger makes.
    expect(await count("SELECT count(DISTINCT caller_key)::int AS n FROM refusal_counts WHERE parameter = 'timeframe' AND value = '15m'")).toBe(1);
  });

  it('a UTC day boundary splits the count into two rows', async () => {
    const t = Date.UTC(2026, 10, 27, 23, 59, 59);
    recordRefusal({ reason: 'unrecognized_keys', tool: 'get_market_regime', parameter: 'venue', value: 'X', keyed: false, callerKey: IP }, t);
    recordRefusal({ reason: 'unrecognized_keys', tool: 'get_market_regime', parameter: 'venue', value: 'X', keyed: false, callerKey: IP }, t + 2_000);
    expect(_pendingRefusalsForTest().map((r) => [r.day, r.count])).toEqual([['2026-11-27', 1], ['2026-11-28', 1]]);
  });
});

describe('the bounds hold', () => {
  it('value, parameter, tool and caller_key: ≤ 32 chars of [A-Za-z0-9_.:-], else <other>; an absent caller is <none>', () => {
    const base = { reason: 'invalid_enum_value' as const, tool: 'scan_market_regimes', parameter: 'timeframe', keyed: false };
    recordRefusal({ ...base, value: 'x'.repeat(32), callerKey: IP });
    recordRefusal({ ...base, value: 'x'.repeat(33), callerKey: IP });
    recordRefusal({ ...base, value: 'a b', callerKey: IP });
    recordRefusal({ ...base, value: 'me@example.com', callerKey: IP });
    recordRefusal({ ...base, value: { nested: 1 }, callerKey: IP });
    recordRefusal({ ...base, value: 7, callerKey: undefined });
    recordRefusal({ ...base, parameter: '../../etc/passwd', value: '1h', callerKey: 'v2:' + 'f'.repeat(40) });
    expect(_pendingRefusalsForTest().map((r) => [r.parameter, r.value, r.callerKey, r.count])).toEqual([
      ['timeframe', 'x'.repeat(32), IP, 1],
      ['timeframe', '<other>', IP, 4],
      ['timeframe', '7', '<none>', 1],
      ['<other>', '1h', '<other>', 1],
    ]);
  });

  it('at most 10,000 distinct keys per UTC day; every later new key folds into one <overflow> row, an admitted key keeps counting', () => {
    const rec = (value: string) => recordRefusal({ reason: 'unrecognized_keys', tool: 'get_market_regime', parameter: 'p', value, keyed: false, callerKey: IP });
    for (let i = 0; i < 10_000; i++) rec(`v${i}`);
    rec('new-a'); rec('new-b'); rec('v7');
    const rows = _pendingRefusalsForTest();
    expect(rows).toHaveLength(10_001);
    expect(rows.filter((r) => r.reason === '<overflow>')).toEqual([
      { day: DAY, reason: '<overflow>', tool: '<overflow>', parameter: '<overflow>', value: '<overflow>', keyed: false, callerKey: '<overflow>', count: 2 },
    ]);
    expect(rows.find((r) => r.value === 'v7')!.count).toBe(2);
  });

  it('the cap counts the rows the table already held for the day, so a restart does not grant a fresh 10,000', async () => {
    await db.exec(statementsOf(M058)[0]);
    await db.query(`INSERT INTO refusal_counts SELECT $1::date, 'unrecognized_keys', 'get_market_regime', 'p', 'old' || g, false, 'v2:x', 1 FROM generate_series(1, 9999) g`, [DAY]);
    recordRefusal({ reason: 'unrecognized_keys', tool: 'get_market_regime', parameter: 'p', value: 'fresh', keyed: false, callerKey: IP });
    await flushRefusals(); // seeds 9,999 for today, then writes the one admitted key → 10,000
    recordRefusal({ reason: 'unrecognized_keys', tool: 'get_market_regime', parameter: 'p', value: 'one-too-many', keyed: false, callerKey: IP });
    await flushRefusals();
    expect(await count('SELECT count(*)::int AS n FROM refusal_counts')).toBe(10_001);
    expect(await count("SELECT count(*)::int AS n FROM refusal_counts WHERE reason = '<overflow>'")).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM refusal_counts WHERE value = 'one-too-many'")).toBe(0);
  });
});

// ─────────────────────────────── the migration ───────────────────────────────

describe('058 — the migration IS the lazy ensure', () => {
  it('the ensure issues exactly the migration\'s statements, in order, on the first flush', async () => {
    recordRefusal({ reason: 'invalid_enum_value', tool: 't', parameter: 'p', value: 'v', keyed: false, callerKey: IP });
    expect(await tableExists()).toBe(0);
    await flushRefusals();
    expect(await tableExists()).toBe(1);
    const ddl = pg.statements.filter((s) => /^\s*(CREATE|DO)\b/.test(s)).map(norm);
    expect(ddl).toEqual(statementsOf(M058));
    expect(statementsOf(M058)).toHaveLength(2);
  });
});

describe('058 is revertible: up → down → up, idempotent, its GRANT guarded', () => {
  it('applies twice with no aoe_readonly role, its down removes the table, and it applies again', async () => {
    expect(await count("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'aoe_readonly'")).toBe(0);
    await db.exec(M058);
    await db.exec(M058);
    expect(await count("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'refusal_counts'")).toBe(8);
    expect(M058_DOWN).toContain('DESTRUCTIVE');
    await db.exec(M058_DOWN);
    expect(await tableExists()).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'refusal_counts'")).toBe(0);
    await db.exec(M058_DOWN); // a second down is a no-op
    await db.exec(M058);
    expect(await tableExists()).toBe(1);
  });

  it('with the role present, aoe_readonly (the owed-read runner\'s read-only session) can SELECT and cannot write', async () => {
    await db.exec("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoe_readonly') THEN CREATE ROLE aoe_readonly; END IF; END $$");
    try {
      recordRefusal({ reason: 'invalid_enum_value', tool: 'scan_market_regimes', parameter: 'timeframe', value: '15m', keyed: false, callerKey: IP });
      await flushRefusals(); // the ensure runs the GRANT
      await db.exec('SET ROLE aoe_readonly');
      expect(await count("SELECT count::int AS n FROM refusal_counts WHERE value = '15m'")).toBe(1);
      await expect(db.query("INSERT INTO refusal_counts VALUES (CURRENT_DATE, 'r', 't', 'p', 'v', false, 'c', 1)")).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec('RESET ROLE');
      await db.exec('DROP TABLE IF EXISTS refusal_counts CASCADE');
      await db.exec('DROP ROLE IF EXISTS aoe_readonly');
    }
  });
});

describe('PG16 only', () => {
  it('no statement uses 17/18-only syntax (PGlite runs 18, production 16)', () => {
    const sql = [M058, M058_DOWN, STORE].join('\n');
    for (const re of [/\bRETURNING\s+(OLD|NEW)\b/i, /\bMERGE\s+INTO\b/i, /\bJSON_(TABLE|QUERY|VALUE|EXISTS)\s*\(/i, /\buuidv7\s*\(/i, /\bVIRTUAL\b/, /\bWITHOUT\s+OVERLAPS\b/i, /\bON_ERROR\b/]) {
      expect(sql, String(re)).not.toMatch(re);
    }
  });
});
