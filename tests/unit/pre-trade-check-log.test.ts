/**
 * DECISION-CALL-V2-W1 CH3 (AC3.1) — the pre_trade_check check log (src/lib/pre-trade-check-log.ts).
 *
 * Driven through the REAL pipeline (`callTool`) and the REAL handler: only the handler's data seam is pinned
 * (no network), `dbQuery` is a mock that records every statement, and request_log's writer is silenced. So
 * "one row per served billed call" is measured where the row is written, with billing counted by the real
 * meter — never asserted on a stub of the writer.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExchangeAsset } from '../../src/lib/exchange-universe.js';
import type { RegimeSnapshotRow, ServableGeneration } from '../../src/lib/regime-snapshots.js';
import type { VenueFundingRow } from '../../src/lib/venue-market-state.js';
import type { PreTradeCheckDeps } from '../../src/tools/pre-trade-check.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
const VENUE_STRING: Record<string, string> = { BINANCE: 'BinPerp', BYBIT: 'BybitPerp', OKX: 'OKXPerp', BITGET: 'BitgetPerp' };

/** A healthy world, as the handler suite builds it: BTC on all four venues, quoted 99,990 / 100,010. */
const testDeps = vi.hoisted(() => ({ make: null as null | (() => PreTradeCheckDeps), dropFacts: false }));

vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  // `residency:'hosted'`: the pipeline's admission reads this before the tool runs.
  isPgBackend: () => true,
  dbQuery: vi.fn(),
}));
vi.mock('../../src/lib/analytics.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/analytics.js')>()),
  logRequest: vi.fn(),
}));
vi.mock('../../src/tools/pre-trade-check.js', async (orig) => {
  const m = await orig<typeof import('../../src/tools/pre-trade-check.js')>();
  // The pipeline row calls runPreTradeCheck(params, license); pin its data seam, keep the engine and billing real.
  // `dropFacts` serves the real, billed outcome WITHOUT its internal facts — the shape the x402 suites stub.
  return {
    ...m,
    runPreTradeCheck: async (p: never, lic: never, deps?: PreTradeCheckDeps) => {
      const o = await m.runPreTradeCheck(p, lic, deps ?? testDeps.make!());
      return testDeps.dropFacts && o.kind === 'ok' ? { kind: o.kind, response: o.response } : o;
    },
  };
});

import { dbQuery } from '../../src/lib/performance-db.js';
import { callTool, type ValidatedToolInput } from '../../src/lib/tool-call-pipeline.js';
import { runPreTradeCheck } from '../../src/tools/pre-trade-check.js';
import {
  recordPreTradeCheck,
  toPreTradeCheckLogRow,
  adoptPreTradeCheckTable,
  countLoggedChecks,
  countServedChecks,
  firstLoggedCheckAt,
  _resetPreTradeCheckLogForTest,
  _preTradeCheckLogFailuresForTest,
} from '../../src/lib/pre-trade-check-log.js';
import { callerRef, hashEmail, PRE_TRADE_CALLER_REF_VERSION } from '../../src/lib/lifecycle/identity.js';
import { checkQuota, trackCall, _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import type { LicenseInfo } from '../../src/types.js';

testDeps.make = (): PreTradeCheckDeps => ({
  now: () => NOW,
  retiredVenues: async () => new Set(),
  venueUniverse: async () => ({ rows: [{ coin: 'BTC', notionalOI_usd: 5e8, volume24h_usd: 1e10, bidPx: 99_990, askPx: 100_010 } as ExchangeAsset], failed: false }),
  fundingSnapshot: async () => ({
    byCoin: new Map([['BTC', VENUES.map((v) => ({ venue: VENUE_STRING[v], fundingRate: 0.0001, nextFundingTime: NOW + 4 * H, intervalHours: 8 }) as VenueFundingRow)]]),
    failedVenues: new Set(),
  }),
  sampledRegimeVenues: async () => [...VENUES],
  latestServableGeneration: async (venue, tf) => ({ exchange: venue, timeframe: tf, bar_close_ms: NOW - H, disposition: 'COMPLETE', universe_n: 1, written_n: 1, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: NOW - H, finished_at: NOW - H }) as ServableGeneration,
  readGenerationRow: async (venue, tf, bar, coin) => ({ exchange: venue, timeframe: tf, bar_close_ms: bar, coin, regime: 'RANGING', confidence: 50, volatility_ratio: 0.01 }) as RegimeSnapshotRow,
  resolveAssetClass: async () => 'CRYPTO' as never,
  venueStatus: async () => 'promoted',
  marginTierAt: async (venue) => (venue === 'BINANCE' ? { rate: null, basis: 'tier_table_requires_key' } : { rate: 0.004, basis: 'public_tier_table' }),
});

const ROOT = resolve(__dirname, '../..');
const MIGRATION = readFileSync(join(ROOT, 'migrations/051_pre_trade_checks.sql'), 'utf8');
const STORE = readFileSync(join(ROOT, 'src/lib/pre-trade-check-log.ts'), 'utf8');
const KEY_ENV = 'ALGOVAULT_IP_HASH_KEY';
const TEST_KEY = 'pre-trade-check-log-test-key-0123456789abcdef';

const q = vi.mocked(dbQuery);
const inserts = () => q.mock.calls.filter((c) => /INSERT INTO pre_trade_checks/.test(String(c[0])));
const creates = () => q.mock.calls.filter((c) => /CREATE TABLE IF NOT EXISTS pre_trade_checks/.test(String(c[0])));
/** The write is fire-and-forget: let every pending microtask and the next macrotask run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let n = 0;
const freeLicense = (): LicenseInfo => ({ tier: 'free', key: `av_free_ptclog_${++n}`, outcome: 'RESOLVED' } as LicenseInfo);
const INTERNAL: LicenseInfo = { tier: 'internal', key: null, outcome: 'RESOLVED' } as LicenseInfo;
const X402: LicenseInfo = { tier: 'x402', key: null, outcome: 'RESOLVED' } as LicenseInfo;
const IN = (over: Record<string, unknown> = {}) => ({ coin: 'BTC', side: 'long', sizeUsd: 10_000, ...over }) as unknown as ValidatedToolInput;
const call = (license: LicenseInfo, input = IN(), channel: 'mcp' | 'httpX402' = 'mcp') =>
  callTool({ tool: 'pre_trade_check', channel, license, input, ...(channel === 'httpX402' ? { ctx: { sessionId: 's-1', ipHash: 'h-1', isAutomated: false } } : {}) });

let savedKey: string | undefined;
beforeAll(() => { savedKey = process.env[KEY_ENV]; });
afterAll(() => { if (savedKey === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = savedKey; });
beforeEach(() => {
  process.env[KEY_ENV] = TEST_KEY;
  testDeps.dropFacts = false;
  q.mockReset();
  q.mockResolvedValue([]);
  _resetPreTradeCheckLogForTest();
  _resetCallTrackersForTest();
  resetLicenseCache();
});

/** Column `name type` pairs of the CREATE TABLE body (digits allowed in names: sigma_1h_pct). */
function columnsOf(sql: string): string[] {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS pre_trade_checks');
  if (start === -1) return [];
  const open = sql.indexOf('(', start);
  let depth = 0, end = -1;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  return sql.slice(open + 1, end).split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter((l) => /^[a-z_][a-z0-9_]*\s/.test(l))
    .map((l) => { const [name, type] = l.split(/\s+/); return `${name} ${type.replace(/,$/, '')}`; });
}

describe('AC3.1 — the schema: the lazy ensure IS migrations/051, and it has nowhere to put a secret', () => {
  it('same columns, same types, in the same order; the checked_at index in both', () => {
    const a = columnsOf(MIGRATION);
    expect(a.length, 'migration parser found nothing').toBeGreaterThan(15);
    expect(columnsOf(STORE)).toEqual(a);
    const idx = 'CREATE INDEX IF NOT EXISTS idx_pre_trade_checks_checked_at ON pre_trade_checks (checked_at)';
    expect(MIGRATION).toContain(idx);
    expect(STORE).toContain(idx);
  });

  it('the contract\'s columns, exactly — no equity, key, address, wallet, payer or IP column', () => {
    const cols = columnsOf(MIGRATION).map((c) => c.split(' ')[0]);
    expect(cols).toEqual(['id', 'checked_at', 'rule_version', 'channel', 'caller_ref', 'coin', 'side', 'size_usd', 'hold_hours', 'timeframe',
      'order_type', 'leverage', 'stop_pct', 'target_pct', 'decision', 'decision_venue', 'sigma_1h_pct', 'liq_distance_pct', 'ref_mid_px', 'rules', 'venues']);
    for (const c of cols) expect(c, c).not.toMatch(/equity|key|address|wallet|payer|(^|_)ip($|_)/);
  });

  it('the down migration drops only this table and its index, and says it is destructive', () => {
    const down = readFileSync(join(ROOT, 'migrations/051_pre_trade_checks.down.sql'), 'utf8');
    expect(down).toContain('DESTRUCTIVE');
    expect(down.split('\n').filter((l) => /^\s*DROP /.test(l))).toEqual(['DROP INDEX IF EXISTS idx_pre_trade_checks_checked_at;', 'DROP TABLE IF EXISTS pre_trade_checks;']);
  });

  it('never on a public surface: the only SQL against pre_trade_checks in src/ is the log module\'s', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(join(ROOT, 'src'));
    expect(files.length, 'the scan must have a corpus').toBeGreaterThan(100);
    const hits = files.filter((f) => /(FROM|INTO|UPDATE|TABLE IF NOT EXISTS)\s+pre_trade_checks\b/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.slice(ROOT.length + 1))).toEqual(['src/lib/pre-trade-check-log.ts']);
  });
});

describe('AC3.1 — callerRef: the hashEmail pattern under its own domain', () => {
  it('pc1:<32 hex>, stable per key, different across keys', () => {
    const a = callerRef('av_free_alpha');
    expect(a).toMatch(new RegExp(`^${PRE_TRADE_CALLER_REF_VERSION}:[0-9a-f]{32}$`));
    expect(callerRef('av_free_alpha')).toBe(a);
    expect(callerRef('av_free_beta')).not.toBe(a);
    expect(callerRef('AV_FREE_ALPHA'), 'a key is used exactly as presented').not.toBe(a);
  });

  it('domain-separated: never the email hash of the same string, and keyed — another secret, another pseudonym', () => {
    expect(callerRef('av_free_alpha').slice(4)).not.toBe(hashEmail('av_free_alpha').slice(4));
    const before = callerRef('av_free_alpha');
    process.env[KEY_ENV] = `${TEST_KEY}-rotated`;
    expect(callerRef('av_free_alpha')).not.toBe(before);
  });

  it('never an unkeyed value: no usable IP-hash key throws, and an empty key throws', () => {
    delete process.env[KEY_ENV];
    expect(() => callerRef('av_free_alpha')).toThrow();
    process.env[KEY_ENV] = 'changeme';
    expect(() => callerRef('av_free_alpha')).toThrow();
    process.env[KEY_ENV] = TEST_KEY;
    expect(() => callerRef('')).toThrow();
  });
});

describe('AC3.1 — one row per served, billed call, through the real pipeline', () => {
  it('MCP, a keyed caller: ONE row, every column from the served response, one unit billed', async () => {
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    if (!out.ok) throw new Error('expected a served call');
    const r = out.result as Record<string, any>;
    expect(checkQuota(lic).used, 'billing: exactly one unit').toBe(1);
    expect(inserts()).toHaveLength(1);
    const params = inserts()[0][1] as unknown[];
    expect(params.slice(0, 18)).toEqual([
      new Date(NOW).toISOString(), 2, 'mcp', callerRef(lic.key!), 'BTC', 'long', 10_000, 8, '4h', 'market',
      null, null, null, r.decision, 'BINANCE', 0.6267, null, 100_000,
    ]);
    expect(JSON.parse(params[18] as string)).toEqual(r.rules);
    expect(JSON.parse(params[19] as string)).toEqual(r.venues.map((v: Record<string, unknown>) => ({
      exchange: v.exchange, est_cost_bps: v.est_cost_bps, round_trip_bps: v.round_trip_bps, liq_distance_pct: v.liq_distance_pct, your_rules: v.your_rules,
    })));
    expect(String(inserts()[0][0])).toMatch(/\$19::jsonb, \$20::jsonb\)$/);
  });

  it('each call is its own row; the lazy ensure runs once per process', async () => {
    await call(freeLicense());
    await call(freeLicense());
    await settle();
    expect(inserts()).toHaveLength(2);
    expect(creates()).toHaveLength(1);
  });

  it('the x402 rail: channel httpX402, and no caller_ref — the license has no key and the payer is not threaded to the pipeline', async () => {
    const out = await call(X402, IN(), 'httpX402');
    await settle();
    expect(out.ok).toBe(true);
    const params = inserts()[0][1] as unknown[];
    expect([params[2], params[3]]).toEqual(['httpX402', null]);
  });

  it('a call with v2 inputs logs them — and never the equity it was sent, nor the raw key', async () => {
    const lic = freeLicense();
    await call(lic, IN({ leverage: 20, stopPct: 2, targetPct: 4, equityUsd: 51_234, orderType: 'limit', rules: { maxLeverage: 25 } }));
    await settle();
    const params = inserts()[0][1] as unknown[];
    expect([params[9], params[10], params[11], params[12], params[14], params[17]]).toEqual(['limit', 20, 2, 4, 'OKX', 100_000]);
    const text = JSON.stringify(params);
    expect(text).not.toContain('51234');
    expect(text).not.toContain(lic.key!);
    expect(JSON.parse(params[18] as string)[0]).toMatchObject({ id: 'maxLeverage', source: 'yours', result: 'pass' });
  });

  it('none for a refusal (unbilled)', async () => {
    const lic = freeLicense();
    const out = await call(lic, IN({ side: 'up' }));
    await settle();
    expect(out.ok).toBe(false);
    expect([inserts().length, checkQuota(lic).used]).toEqual([0, 0]);
  });

  it('none for the quota wall (the handler throws before it bills)', async () => {
    const lic = freeLicense();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    expect(checkQuota(lic).allowed, 'fixture must be walled').toBe(false);
    const out = await call(lic);
    await settle();
    expect(out.ok === false && out.kind).toBe('threw');
    expect(inserts()).toHaveLength(0);
  });

  it('none for an internal caller', async () => {
    const out = await call(INTERNAL);
    await settle();
    expect(out.ok).toBe(true);
    expect(inserts()).toHaveLength(0);
  });

  it('none for the health probe: it calls the ENGINE, and the engine never writes — the row lives in the pipeline only', async () => {
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000, holdHours: 8, timeframe: '4h' }, freeLicense(), testDeps.make!());
    await settle();
    expect(out.kind).toBe('ok');
    expect(q.mock.calls).toHaveLength(0);
  });
});

describe('AC3.1 — fail-open: a throwing insert leaves the response and billing unchanged', () => {
  const strip = (x: unknown) => JSON.parse(JSON.stringify(x));
  afterEach(() => { vi.useRealTimers(); });

  it('the insert throws: same response as a logged call, one unit billed, the counter bumped, ONE line', async () => {
    // Each license's monthly window is anchored at its own first call on the real clock; freeze it so the
    // two responses are comparable byte for byte, with no field carved out of the comparison.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const control = await call(freeLicense());
    await settle();
    expect(inserts()).toHaveLength(1);

    q.mockImplementation(async (sql: string) => { if (/INSERT INTO pre_trade_checks/.test(sql)) throw new Error('connection terminated'); return []; });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    expect(out.ok).toBe(true);
    if (!out.ok || !control.ok) throw new Error('expected served calls');
    expect(strip(out.result)).toEqual(strip(control.result));
    expect(checkQuota(lic).used).toBe(1);
    expect(_preTradeCheckLogFailuresForTest()).toBe(1);
    const lines = err.mock.calls.map((c) => c.join(' ')).filter((l) => l.startsWith('[pre-trade-check-log]'));
    expect(lines).toEqual(['[pre-trade-check-log] row not written (failures since start: 1): Error: connection terminated']);
    err.mockRestore();
    vi.useRealTimers();
  });

  it('the pseudonym cannot be derived (no IP-hash key): no row, the call still served and billed', async () => {
    delete process.env[KEY_ENV];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    expect(out.ok).toBe(true);
    expect(checkQuota(lic).used).toBe(1);
    expect([inserts().length, _preTradeCheckLogFailuresForTest()]).toEqual([0, 1]);
    err.mockRestore();
  });

  it('an outcome the log cannot read (no facts: a stub\'s shape) is still served and billed: no row, the counter bumped', async () => {
    testDeps.dropFacts = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lic = freeLicense();
    const out = await call(lic);
    await settle();
    expect(out.ok).toBe(true);
    expect(checkQuota(lic).used).toBe(1);
    expect([inserts().length, _preTradeCheckLogFailuresForTest()]).toEqual([0, 1]);
    err.mockRestore();
  });

  it('recordPreTradeCheck itself never rejects', async () => {
    q.mockRejectedValue(new Error('down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000 }, INTERNAL, testDeps.make!());
    if (out.kind !== 'ok') throw new Error('expected ok');
    await expect(recordPreTradeCheck({ response: out.response, facts: out.facts, channel: 'mcp', licenseKey: 'av_x' })).resolves.toBe(false);
    err.mockRestore();
  });
});

describe('the row projection and the parity reads', () => {
  it('toPreTradeCheckLogRow names every column and nothing else — no equity, no key, at any depth', async () => {
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000, equityUsd: 50_000, leverage: 10 }, INTERNAL, testDeps.make!());
    if (out.kind !== 'ok') throw new Error('expected ok');
    const row = toPreTradeCheckLogRow({ response: out.response, facts: out.facts, channel: 'mcp', licenseKey: 'av_free_row' });
    expect(Object.keys(row)).toEqual(columnsOf(MIGRATION).map((c) => c.split(' ')[0]).filter((c) => c !== 'id'));
    const keys: string[] = [];
    const walk = (x: unknown) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); } };
    walk(row);
    for (const k of keys) expect(k, k).not.toMatch(/equity|key|address|wallet|payer|(^|_)ip($|_)/);
    expect(JSON.stringify(row)).not.toContain('av_free_row');
  });

  it('adoption probes both relations with to_regclass and issues no DDL; true marks the ensure done', async () => {
    q.mockResolvedValueOnce([{ t: true, i: true }]);
    expect(await adoptPreTradeCheckTable()).toBe(true);
    expect(String(q.mock.calls[0][0])).toBe("SELECT to_regclass('pre_trade_checks') IS NOT NULL AS t, to_regclass('idx_pre_trade_checks_checked_at') IS NOT NULL AS i");
    const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000 }, INTERNAL, testDeps.make!());
    if (out.kind !== 'ok') throw new Error('expected ok');
    await recordPreTradeCheck({ response: out.response, facts: { refMidPx: null }, channel: 'mcp', licenseKey: null });
    expect(creates()).toHaveLength(0);
  });

  it('a missing index is not an adopted table', async () => {
    q.mockResolvedValueOnce([{ t: true, i: false }]);
    expect(await adoptPreTradeCheckTable()).toBe(false);
  });

  it('firstLoggedCheckAt: the log\'s first row as epoch ms — a Date or ISO text; null while empty; unreadable throws', async () => {
    q.mockResolvedValueOnce([{ first: new Date(NOW - 2 * H) }]);
    expect(await firstLoggedCheckAt()).toBe(NOW - 2 * H);
    expect(q.mock.calls[0]).toEqual(['SELECT MIN(checked_at) AS first FROM pre_trade_checks']);
    q.mockResolvedValueOnce([{ first: new Date(NOW - H).toISOString() }]);
    expect(await firstLoggedCheckAt()).toBe(NOW - H);
    q.mockResolvedValueOnce([{ first: null }]);
    expect(await firstLoggedCheckAt()).toBeNull();
    q.mockResolvedValueOnce([{ first: 'not-a-time' }]);
    await expect(firstLoggedCheckAt()).rejects.toThrow(/unreadable/);
  });

  it('countLoggedChecks: the window on checked_at', async () => {
    q.mockResolvedValueOnce([{ n: '7' }]);
    expect(await countLoggedChecks(NOW - 24 * H)).toBe(7);
    expect(q.mock.calls[0]).toEqual(['SELECT COUNT(*) AS n FROM pre_trade_checks WHERE checked_at >= $1', [new Date(NOW - 24 * H).toISOString()]]);
  });

  it('countServedChecks: the request_log predicate — this tool, not internal, inside the window', async () => {
    q.mockResolvedValueOnce([{ n: 9 }]);
    expect(await countServedChecks(NOW - 24 * H)).toBe(9);
    expect(q.mock.calls[0]).toEqual([
      "SELECT COUNT(*) AS n FROM request_log WHERE tool_name = 'pre_trade_check' AND is_bot_internal IS NOT TRUE AND timestamp >= $1",
      [new Date(NOW - 24 * H).toISOString()],
    ]);
  });
});
