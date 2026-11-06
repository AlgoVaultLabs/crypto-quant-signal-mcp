/**
 * DECISION-CALL-V2-W5 CH1 — the call ledger's writes, in a REAL Postgres engine (PGlite, Cowork Q4-A).
 *
 * `dbQuery` is routed to an in-process PGlite, so every statement the check log issues — the 051/053/055 lazy
 * ensure and the one-statement CTE — is parsed, planned and constrained by Postgres itself; nothing here is a
 * recorded string. The served calls go through the REAL pipeline (`callTool`) and the REAL handler; only the
 * handler's data seam is pinned (no network) and request_log's writer is counted instead of written.
 *
 * PGlite 0.5.11 runs PostgreSQL 18.6; production runs 16.13. The SQL is written to 16 (the static guard below
 * refuses the 17/18-only syntax), and CI's Postgres lane applies every migration to postgres:16-alpine.
 *
 * AC1.1 — on 20 fixture checks the leaf rebuilt from the STORED row equals the SERVED leaf (and the odds leaf
 *         rebuilt from the row and its stored salt equals the stored odds leaf).
 * AC1.3 — a failed log write leaves the response byte-identical, and the parity leg counts the missing row.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { PreTradeCheckDeps } from '../../src/tools/pre-trade-check.js';

const NOW = Date.parse('2026-11-06T07:13:01.123Z');

const pg = vi.hoisted(() => ({
  db: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  failInsert: false,
  statements: [] as string[],
}));
const ctl = vi.hoisted(() => ({ fixedId: null as null | string, world: null as null | (() => PreTradeCheckDeps) }));

vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  isPgBackend: () => true,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    pg.statements.push(sql);
    if (pg.failInsert && /INSERT INTO pre_trade_checks/.test(sql)) throw new Error('connection terminated unexpectedly');
    return (await pg.db!.query(sql, params)).rows;
  },
}));
vi.mock('../../src/lib/analytics.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/analytics.js')>()),
  logRequest: vi.fn(),
}));
vi.mock('../../src/lib/call-ledger.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/call-ledger.js')>();
  return { ...m, mintCallLedgerId: () => ctl.fixedId ?? m.mintCallLedgerId() };
});
vi.mock('../../src/tools/pre-trade-check.js', async (orig) => {
  const m = await orig<typeof import('../../src/tools/pre-trade-check.js')>();
  return { ...m, runPreTradeCheck: async (p: never, lic: never, deps?: PreTradeCheckDeps) => m.runPreTradeCheck(p, lic, deps ?? ctl.world!()) };
});

import { logRequest } from '../../src/lib/analytics.js';
import { callTool, type ValidatedToolInput } from '../../src/lib/tool-call-pipeline.js';
import {
  countLoggedChecks,
  readLedgerCheckRows,
  adoptCallLedger,
  countChecksMissingLeaves,
  _resetPreTradeCheckLogForTest,
  _preTradeCheckLogFailuresForTest,
} from '../../src/lib/pre-trade-check-log.js';
import { oddsLeaf, oddsRecordFromRow, verdictLeaf, verdictRecordFromRow, CALL_LEDGER_ID_RE } from '../../src/lib/call-ledger.js';
import { judgeLogParity } from '../../src/scripts/pre-trade-health.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import type { LicenseInfo } from '../../src/types.js';
import type { Hex } from 'viem';
import { preTradeWorld } from '../fixtures/pre-trade-world.js';

const ROOT = resolve(__dirname, '../..');
const STORE = readFileSync(join(ROOT, 'src/lib/pre-trade-check-log.ts'), 'utf8');
const M055 = readFileSync(join(ROOT, 'migrations/055_call_ledger.sql'), 'utf8');
const M055_DOWN = readFileSync(join(ROOT, 'migrations/055_call_ledger.down.sql'), 'utf8');

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
  pg.db = db;
  ctl.world = () => preTradeWorld(NOW);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS call_ledger, pre_trade_checks CASCADE');
  _resetPreTradeCheckLogForTest();
  _resetCallTrackersForTest();
  resetLicenseCache();
  pg.failInsert = false;
  pg.statements = [];
  ctl.fixedId = null;
  vi.mocked(logRequest).mockClear();
  process.env.ALGOVAULT_IP_HASH_KEY = 'call-ledger-pglite-test-key-0123456789abcdef';
});

let n = 0;
const free = (): LicenseInfo => ({ tier: 'free', key: `av_free_pglite_${++n}`, outcome: 'RESOLVED' } as LicenseInfo);
const call = (input: Record<string, unknown>, license: LicenseInfo = free()) =>
  callTool({ tool: 'pre_trade_check', channel: 'mcp', license, input: { coin: 'BTC', side: 'long', sizeUsd: 10_000, ...input } as unknown as ValidatedToolInput });
/** The write is fire-and-forget; PGlite answers asynchronously, so wait until the log has had its turn. */
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5)); };
const count = async (sql: string) => Number(((await db.query(sql)).rows[0] as { n: number }).n);

/** Statements as text: comments out, whitespace collapsed, no trailing `;`. */
function statementsOf(sql: string): string[] {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
/** The module's 055 statements: the three template literals the ensure runs for the ledger. */
function storeStatementsFor055(): string[] {
  const names = ['CREATE_CALL_LEDGER_SQL', 'CREATE_CALL_LEDGER_BATCH_INDEX_SQL', 'ADD_LEDGER_ID_COLUMN_SQL'];
  return names.map((name) => {
    const m = STORE.match(new RegExp(`const ${name} =\\s*\`([\\s\\S]*?)\``));
    expect(m, name).not.toBeNull();
    return m![1].replace(/\s+/g, ' ').trim();
  });
}

describe('055 — the migration IS the lazy ensure, and Postgres accepts both', () => {
  it('the same three statements, in the same order, once normalized', () => {
    expect(statementsOf(M055)).toEqual(storeStatementsFor055());
  });

  it('the migration file runs on Postgres after 051 + 053, twice (idempotent), and its down undoes it', async () => {
    const m = (f: string) => readFileSync(join(ROOT, 'migrations', f), 'utf8');
    for (const f of ['051_pre_trade_checks.sql', '053_pre_trade_checks_shadow_odds.sql', '055_call_ledger.sql', '055_call_ledger.sql']) await db.exec(m(f));
    expect(await count("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'call_ledger'")).toBe(10);
    expect(await count("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pre_trade_checks' AND column_name = 'ledger_id'")).toBe(1);
    expect(M055_DOWN).toContain('DESTRUCTIVE');
    await db.exec(M055_DOWN);
    expect(await count("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'call_ledger'")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pre_trade_checks' AND column_name = 'ledger_id'")).toBe(0);
  });

  it('the constraints hold the contract: a salt only on an odds leaf, a leaf once, one leaf of each kind per id', async () => {
    await db.exec(readFileSync(join(ROOT, 'migrations/051_pre_trade_checks.sql'), 'utf8'));
    await db.exec(M055);
    const id = `pcl_${'ab'.repeat(16)}`;
    const L = (c: string) => `0x${c.repeat(64)}`;
    const ins = (ledgerId: string, kind: string, leaf: string, salt: string | null) =>
      db.query('INSERT INTO call_ledger (ledger_id, kind, tool, ref_id, leaf, salt) VALUES ($1, $2, $3, 1, $4, $5)', [ledgerId, kind, 'pre_trade_check', leaf, salt]);
    await ins(id, 'verdict', L('1'), null);
    await ins(id, 'odds', L('2'), L('3'));
    for (const bad of [
      () => ins(`pcl_${'cd'.repeat(16)}`, 'verdict', L('4'), L('5')), // salt on a verdict leaf
      () => ins(`pcl_${'cd'.repeat(16)}`, 'odds', L('6'), null), // an odds leaf without its salt
      () => ins(`pcl_${'ef'.repeat(16)}`, 'verdict', L('1'), null), // a leaf twice
      () => ins(id, 'verdict', L('7'), null), // a second verdict leaf for one id
      () => ins('pcl_short', 'verdict', L('8'), null), // a malformed id
      () => ins(`pcl_${'cd'.repeat(16)}`, 'verdict', `0x${'A'.repeat(64)}`, null), // an upper-case leaf
      () => ins(`pcl_${'cd'.repeat(16)}`, 'label', L('9'), null), // a kind outside verdict | odds
    ]) await expect(bad()).rejects.toThrow();
  });

  it('PG16 only: no statement uses 17/18-only syntax (PGlite runs 18.6, production 16.13)', () => {
    const sql = [M055, M055_DOWN, STORE].join('\n');
    for (const re of [/\bRETURNING\s+(OLD|NEW)\b/i, /\bMERGE\s+INTO\b/i, /\bJSON_(TABLE|QUERY|VALUE|EXISTS)\s*\(/i, /\buuidv7\s*\(/i, /\bVIRTUAL\b/, /\bWITHOUT\s+OVERLAPS\b/i, /\bON_ERROR\b/]) {
      expect(sql, String(re)).not.toMatch(re);
    }
  });
});

/** 20 fixture checks: every kind of value a record carries — nulls, decimals, both sides, caller rules, venue subsets. */
const FIXTURES: Record<string, unknown>[] = [
  {}, { side: 'short' }, { sizeUsd: 2500.5 }, { holdHours: 0.5 }, { holdHours: 72, timeframe: '1h' },
  { leverage: 3 }, { leverage: 50, stopPct: 5 }, { stopPct: 1.5, targetPct: 3 }, { stopPct: 0.5, targetPct: 0.75, leverage: 20, orderType: 'limit' },
  { orderType: 'limit' }, { exchanges: ['OKX'] }, { exchanges: ['BYBIT', 'BITGET'], side: 'short' }, { leverage: 20, rules: { maxLeverage: 10 } },
  { rules: { maxRoundTripBps: 1 } }, { sizeUsd: 30_000_000 }, { equityUsd: 50_000, leverage: 10, stopPct: 2 }, { side: 'short', leverage: 20, stopPct: 2, targetPct: 4 },
  { holdHours: 24, stopPct: 5, targetPct: 10 }, { sizeUsd: 1.25 }, { holdHours: 8, timeframe: '4h', leverage: 2, stopPct: 1, targetPct: 2, rules: { maxFundingBps: 0.1 } },
];

describe('AC1.1 — 20 fixture checks: the stored row rebuilds the served leaf', () => {
  it('each served check is logged once with both leaves, and every leaf rebuilds from the stored row', async () => {
    expect(FIXTURES).toHaveLength(20);
    const served: { leaf: string; id: string; decision: string }[] = [];
    for (const f of FIXTURES) {
      const out = await call(f);
      if (!out.ok) throw new Error(`fixture ${JSON.stringify(f)} was refused: ${JSON.stringify(out)}`);
      const r = out.result as { ledger: { id: string; leaf: string }; decision: string };
      expect(r.ledger.id).toMatch(CALL_LEDGER_ID_RE);
      served.push({ id: r.ledger.id, leaf: r.ledger.leaf, decision: r.decision });
    }
    await settle();
    expect(_preTradeCheckLogFailuresForTest(), 'no write failed').toBe(0);
    expect(new Set(served.map((s) => s.decision)).size, 'vacuity guard: the fixtures must reach more than one decision').toBeGreaterThan(1);
    expect(await count('SELECT count(*)::int AS n FROM pre_trade_checks')).toBe(20);
    expect(await count('SELECT count(*)::int AS n FROM call_ledger')).toBe(40);
    expect(await count("SELECT count(*)::int AS n FROM call_ledger WHERE (kind = 'odds') = (salt IS NOT NULL) AND batch_id IS NULL AND proof IS NULL")).toBe(40);

    const ledger = (await db.query('SELECT ledger_id, kind, ref_id, leaf, salt FROM call_ledger ORDER BY id')).rows as { ledger_id: string; kind: string; ref_id: number; leaf: string; salt: string | null }[];
    const rows = await readLedgerCheckRows([...new Set(ledger.map((l) => l.ref_id))]);
    expect(rows).toHaveLength(20);
    const byRef = new Map(rows.map((r) => [Number(r.id), r]));
    for (const s of served) {
      const v = ledger.find((l) => l.ledger_id === s.id && l.kind === 'verdict')!;
      const o = ledger.find((l) => l.ledger_id === s.id && l.kind === 'odds')!;
      expect(v.leaf, `${s.id}: the stored verdict leaf is the served one`).toBe(s.leaf);
      const row = byRef.get(Number(v.ref_id))!;
      expect(row.ledger_id).toBe(s.id);
      expect(verdictLeaf(verdictRecordFromRow(row)), `${s.id}: rebuilt from the stored row`).toBe(s.leaf);
      expect(Number(o.ref_id)).toBe(Number(v.ref_id));
      expect(oddsLeaf(oddsRecordFromRow(row), o.salt as Hex), `${s.id}: the odds leaf from the row and its salt`).toBe(o.leaf);
    }
  });

  it('the canary\'s leaf read: adoption sees the 055 objects, and a complete log has nothing missing (with its corpus printed)', async () => {
    for (const f of FIXTURES.slice(0, 3)) await call(f);
    await settle();
    expect(await adoptCallLedger()).toBe(true);
    expect(await countChecksMissingLeaves()).toEqual({ checked: 3, missing: 0 });
    // An older writer's row after the ledger began (no ledger_id), and a check whose odds leaf is gone.
    await db.query("INSERT INTO pre_trade_checks (checked_at, rule_version, channel, coin, side, size_usd, hold_hours, timeframe, order_type, decision, rules, venues) VALUES ($1, 2, 'mcp', 'BTC', 'long', 1, 8, '4h', 'market', 'GO', '[]', '[]')", [new Date(NOW + 1000).toISOString()]);
    await db.exec("DELETE FROM call_ledger WHERE id = (SELECT min(id) FROM call_ledger WHERE kind = 'odds')");
    expect(await countChecksMissingLeaves()).toEqual({ checked: 4, missing: 2 });
  });

  it('adoption is false before any receipted check, and issues no DDL', async () => {
    await db.exec(readFileSync(join(ROOT, 'migrations/051_pre_trade_checks.sql'), 'utf8'));
    pg.statements = [];
    expect(await adoptCallLedger()).toBe(false);
    expect(pg.statements.every((s) => /^\s*SELECT\b/.test(s))).toBe(true);
  });
});

describe('one statement, one transaction — a check is logged with both leaves or not at all', () => {
  it('a receipt id that already holds its leaves makes the whole write fail: no second check row', async () => {
    ctl.fixedId = `pcl_${'0f'.repeat(16)}`;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await call({});
    _resetCallTrackersForTest();
    const b = await call({ side: 'short' });
    await settle();
    expect([a.ok, b.ok], 'both calls are served regardless').toEqual([true, true]);
    expect(await count('SELECT count(*)::int AS n FROM pre_trade_checks')).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM call_ledger')).toBe(2);
    expect(_preTradeCheckLogFailuresForTest()).toBe(1);
    err.mockRestore();
  });
});

describe('AC1.3 — a failed log write leaves the response byte-identical; the parity leg counts the missing row', () => {
  it('the same call, logged and unlogged, serves the same bytes', async () => {
    // The quota envelope's reset instant reads the wall clock: freeze Date (only Date — PGlite's timers stay real).
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    ctl.fixedId = `pcl_${'1e'.repeat(16)}`;
    const ok = await call({ leverage: 20, stopPct: 2, targetPct: 4 });
    await settle();
    await db.exec('DELETE FROM call_ledger; DELETE FROM pre_trade_checks');
    _resetCallTrackersForTest();
    pg.failInsert = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await call({ leverage: 20, stopPct: 2, targetPct: 4 });
    await settle();
    if (!ok.ok || !failed.ok) throw new Error('both calls must be served');
    expect(JSON.stringify(failed.result)).toBe(JSON.stringify(ok.result));
    expect(await count('SELECT count(*)::int AS n FROM pre_trade_checks')).toBe(0);
    expect(_preTradeCheckLogFailuresForTest()).toBe(1);
    err.mockRestore();
    vi.useRealTimers();
  });

  it('served (request_log) vs logged (the table): each failed write is one row of gap, and three are a FAIL', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await call({});
    await settle();
    pg.failInsert = true;
    for (let i = 0; i < 3; i += 1) await call({ holdHours: 4 + i });
    await settle();
    const served = vi.mocked(logRequest).mock.calls.length;
    const logged = await countLoggedChecks(0);
    expect([served, logged]).toEqual([4, 1]);
    expect(judgeLogParity(served, logged)).toBe('FAIL');
    expect(judgeLogParity(2, 1), 'one missing row is counted, below the page floor').toBe('PASS');
    err.mockRestore();
  });
});
