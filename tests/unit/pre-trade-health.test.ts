/**
 * DECISION-CALL-V1-W3 CH2 — the pre_trade_check health probe (src/scripts/pre-trade-health.ts).
 *
 * The probe is judged by two pure functions and run by a `main()` whose every I/O is a seam, so this
 * file needs no database, no network and no mock of a module: the judges get fixtures, `main()` gets
 * injected deps. Each verdict has a PASS arm and a broken arm that must FAIL; the line shapes the
 * canary parses (FEE / VENUE JSON, the token names and their order) are pinned here because
 * ops/monitoring/pre-trade-health-canary.sh's self-test fakes them and cannot see this side.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  judgeFeeTable,
  judgePreTradeHealth,
  judgeLogParity,
  LOG_PARITY_MAX_GAP_PCT,
  LOG_PARITY_MIN_GAP,
  main,
  parseMinVenues,
  PRE_TRADE_HEALTH_PROBE,
  type PreTradeHealthDeps,
} from '../../src/scripts/pre-trade-health.js';
import { VENUE_FEE_ROWS, FEE_TABLE_MAX_AGE_DAYS, feeRowVerifiedAtMs, type VenueFeeRow } from '../../src/lib/venue-fees.js';
import { currentCaller, currentWeightClass } from '../../src/lib/upstream-weight-budget.js';
import type { PreTradeCheckOutcome, PreTradeCheckResponse } from '../../src/tools/pre-trade-check.js';

const DAY = 86_400_000;
const NEWEST_VERIFIED = Math.max(...VENUE_FEE_ROWS.map((r) => feeRowVerifiedAtMs(r)));
const OLDEST_VERIFIED = Math.min(...VENUE_FEE_ROWS.map((r) => feeRowVerifiedAtMs(r)));
const FRESH_NOW = NEWEST_VERIFIED + DAY;

type Venue = { exchange: string; excluded: string | null };
const venues = (...xs: Array<[string, string | null]>): Venue[] => xs.map(([exchange, excluded]) => ({ exchange, excluded }));
const FIVE_UP = venues(['BINANCE', null], ['BYBIT', null], ['OKX', null], ['BITGET', null], ['HYPERLIQUID', null]);

function okOutcome(over: { decision?: unknown; reasons?: unknown; venues?: unknown } = {}): PreTradeCheckOutcome {
  const response = {
    decision: 'GO',
    reasons: [],
    venues: FIVE_UP,
    ...over,
  } as unknown as PreTradeCheckResponse;
  return { kind: 'ok', response };
}

const refused = (code: string, status: number): PreTradeCheckOutcome =>
  ({ kind: 'refused', status, payload: { error: code, code } }) as unknown as PreTradeCheckOutcome;

describe('parseMinVenues — default-deny', () => {
  it('a positive integer is taken from the env', () => {
    expect(parseMinVenues('5')).toEqual({ value: 5, source: 'env' });
    expect(parseMinVenues('1')).toEqual({ value: 1, source: 'env' });
  });
  it.each([undefined, '', '0', '-1', '2.5', 'abc', ' 3', '3 ', '1e1', '03'])('%j is the default 3, never a looser value', (raw) => {
    expect(parseMinVenues(raw)).toEqual({ value: 3, source: 'default' });
  });
});

describe('judgeFeeTable — VENUE_FEE_TABLE_VERDICT', () => {
  it('PASS arm: the committed table, the day after its newest verification', () => {
    const j = judgeFeeTable(FRESH_NOW);
    expect(j.verdict).toBe('PASS');
    expect(j.stale).toEqual([]);
    expect(j.rows).toHaveLength(VENUE_FEE_ROWS.length);
    expect(j.rows.every((r) => r.stale === false && typeof r.age_days === 'number')).toBe(true);
  });

  it(`exactly ${FEE_TABLE_MAX_AGE_DAYS} days after the oldest row is NOT stale (the shared boundary)`, () => {
    expect(judgeFeeTable(OLDEST_VERIFIED + FEE_TABLE_MAX_AGE_DAYS * DAY).verdict).toBe('PASS');
  });

  it('broken arm: one day past the limit FAILs and names the row with its date and its source URL', () => {
    const j = judgeFeeTable(OLDEST_VERIFIED + FEE_TABLE_MAX_AGE_DAYS * DAY + DAY);
    expect(j.verdict).toBe('FAIL');
    const oldest = VENUE_FEE_ROWS.filter((r) => feeRowVerifiedAtMs(r) === OLDEST_VERIFIED);
    expect(j.stale).toEqual(oldest.map((r) => r.exchange));
    for (const r of oldest) {
      expect(j.rows.find((s) => s.exchange === r.exchange)).toEqual({
        exchange: r.exchange, verified_at: r.verifiedAt, age_days: FEE_TABLE_MAX_AGE_DAYS + 1, stale: true, source_url: r.sourceUrl,
      });
    }
  });

  it('an unparseable verified-at date is stale with no age (the shared rule, never a crash)', () => {
    const bad: VenueFeeRow = { ...VENUE_FEE_ROWS[0], verifiedAt: 'not-a-date' };
    const j = judgeFeeTable(FRESH_NOW, [bad]);
    expect(j.verdict).toBe('FAIL');
    expect(j.rows[0]).toMatchObject({ stale: true, age_days: null });
  });

  it('an EMPTY table is INDETERMINATE — a judge that read nothing never reports PASS', () => {
    expect(judgeFeeTable(FRESH_NOW, []).verdict).toBe('INDETERMINATE');
  });
});

describe('judgePreTradeHealth — PRE_TRADE_HEALTH_VERDICT', () => {
  it('PASS arm: a decision and 5 of 5 venues up', () => {
    const j = judgePreTradeHealth({ ok: true, outcome: okOutcome() }, 3);
    expect(j).toMatchObject({ verdict: 'PASS', failKeys: [], decision: 'GO', venuesUp: 5 });
    expect(j.venues.every((v) => v.state === 'UP')).toBe(true);
  });

  it('REGIME_UNAVAILABLE is reported, never judged', () => {
    const j = judgePreTradeHealth({ ok: true, outcome: okOutcome({ decision: 'CAUTION', reasons: [{ code: 'REGIME_UNAVAILABLE', severity: 'info', detail: 'x' }] }) }, 3);
    expect(j.verdict).toBe('PASS');
    expect(j.reasonCodes).toEqual(['REGIME_UNAVAILABLE']);
  });

  it('only feed_unavailable / funding_unavailable mark a venue DOWN; an unsuitable venue still counts as up', () => {
    const j = judgePreTradeHealth({
      ok: true,
      outcome: okOutcome({ venues: venues(['BINANCE', 'feed_unavailable'], ['BYBIT', 'funding_unavailable'], ['OKX', 'thin_liquidity'], ['BITGET', 'not_listed'], ['HYPERLIQUID', null]) }),
    }, 3);
    expect(j.venues.map((v) => v.state)).toEqual(['DOWN', 'DOWN', 'UP', 'UP', 'UP']);
    expect(j).toMatchObject({ verdict: 'PASS', venuesUp: 3 });
  });

  it('broken arm: 2 of 5 venues up is below the floor of 3 — FAIL, with the count in the key', () => {
    const j = judgePreTradeHealth({
      ok: true,
      outcome: okOutcome({ venues: venues(['BINANCE', 'feed_unavailable'], ['BYBIT', 'feed_unavailable'], ['OKX', 'funding_unavailable'], ['BITGET', null], ['HYPERLIQUID', null]) }),
    }, 3);
    expect(j.verdict).toBe('FAIL');
    expect(j.failKeys).toEqual(['venues:2 of 5 up, below 3']);
  });

  it('an empty venue list is 0 up — FAIL, never a vacuous PASS', () => {
    expect(judgePreTradeHealth({ ok: true, outcome: okOutcome({ venues: [] }) }, 3).failKeys).toEqual(['venues:0 of 0 up, below 3']);
  });

  it('a refusal FAILs, naming its code and status', () => {
    const j = judgePreTradeHealth({ ok: true, outcome: refused('data_unavailable', 503) }, 3);
    expect(j).toMatchObject({ verdict: 'FAIL', failKeys: ['call:refused data_unavailable (status 503)'], decision: null });
  });

  it('a throw FAILs', () => {
    expect(judgePreTradeHealth({ ok: false, error: 'TypeError' }, 3)).toMatchObject({ verdict: 'FAIL', failKeys: ['call:threw TypeError'] });
  });

  it.each([undefined, null, '', 'MAYBE'])('a missing or unknown decision (%j) FAILs', (decision) => {
    const j = judgePreTradeHealth({ ok: true, outcome: okOutcome({ decision }) }, 3);
    expect(j.verdict).toBe('FAIL');
    expect(j.failKeys).toEqual(['decision:missing']);
  });
});

// ── main(): the seams, the batch scope, the tokens and the line shapes the canary parses ─────────

function run(deps: Partial<PreTradeHealthDeps>, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  let t = FRESH_NOW;
  const calls: Array<{ params: unknown; license: unknown; weightClass: string; caller: string }> = [];
  const full: PreTradeHealthDeps = {
    now: () => (t += 1000),
    adoptTables: async () => true,
    runCheck: async (params, license) => {
      calls.push({ params, license, weightClass: currentWeightClass(), caller: currentCaller() });
      return okOutcome();
    },
    feeRows: VENUE_FEE_ROWS,
    // The log-parity leg's PASS world: the check log exists, and every served call has its row.
    adoptCheckLog: async () => true,
    countServed: async () => 40,
    countLogged: async () => 40,
    firstLogged: async () => FRESH_NOW - 30 * DAY,
    ...deps,
  };
  return main(['node', 'pre-trade-health.js'], env, full).then((code) => {
    log.mockRestore();
    err.mockRestore();
    return { code, out, calls };
  });
}

const token = (out: string[], name: string) => out.filter((l) => l.startsWith(`${name}=`));

afterEach(() => { vi.restoreAllMocks(); });

describe('main — one probe, two tokens', () => {
  it('PASS: exit 0, both tokens exactly once, the fee token FIRST', async () => {
    const { code, out } = await run({});
    expect(code).toBe(0);
    expect(token(out, 'VENUE_FEE_TABLE_VERDICT')).toEqual(['VENUE_FEE_TABLE_VERDICT=PASS']);
    expect(token(out, 'PRE_TRADE_HEALTH_VERDICT')).toEqual(['PRE_TRADE_HEALTH_VERDICT=PASS']);
    expect(out.indexOf('VENUE_FEE_TABLE_VERDICT=PASS')).toBeLessThan(out.indexOf('PRE_TRADE_HEALTH_VERDICT=PASS'));
    expect(token(out, 'PRE_TRADE_HEALTH_WALL_MS')).toEqual(['PRE_TRADE_HEALTH_WALL_MS=1000']);
  });

  it('the engine is called ONCE, with the fixed probe and the internal license, in the batch lane under its own tag', async () => {
    const { calls } = await run({});
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ coin: 'BTC', side: 'long', sizeUsd: 10_000, holdHours: 8, timeframe: '4h' });
    expect(calls[0].params).toEqual({ ...PRE_TRADE_HEALTH_PROBE });
    expect(calls[0].license).toEqual({ tier: 'internal', key: null, outcome: 'RESOLVED' });
    expect(calls[0].weightClass).toBe('batch');
    expect(calls[0].caller).toBe('pre_trade_health');
  });

  it('every check prints a positive line, a count beside every zero', async () => {
    const { out } = await run({});
    expect(out).toContain(`[pre-trade-health] CHECK fee_table rows=${VENUE_FEE_ROWS.length} stale=0 max_age_days=${FEE_TABLE_MAX_AGE_DAYS}`);
    expect(out).toContain('[pre-trade-health] CHECK db=REACHABLE regime_tables=ADOPTED');
    expect(out).toContain('[pre-trade-health] CHECK probe=BTC long 10000 8h 4h outcome=ok');
    expect(out).toContain('[pre-trade-health] CHECK decision=GO reasons=none');
    expect(out).toContain('[pre-trade-health] CHECK venues_up=5 of 5 min=3 (default)');
    expect(out).toContain('PRE_TRADE_HEALTH_FAIL_KEYS=');
    expect(out).toContain('VENUE_FEE_TABLE_STALE=');
  });

  it('the canary parse contract: one FEE line per row and one VENUE line per venue, with exactly these keys', async () => {
    const { out } = await run({});
    const fee = out.filter((l) => l.startsWith('[pre-trade-health] FEE ')).map((l) => JSON.parse(l.slice('[pre-trade-health] FEE '.length)));
    const ven = out.filter((l) => l.startsWith('[pre-trade-health] VENUE ')).map((l) => JSON.parse(l.slice('[pre-trade-health] VENUE '.length)));
    expect(fee).toHaveLength(VENUE_FEE_ROWS.length);
    for (const f of fee) expect(Object.keys(f).sort()).toEqual(['age_days', 'exchange', 'source_url', 'stale', 'verified_at']);
    expect(ven).toHaveLength(5);
    for (const v of ven) expect(Object.keys(v).sort()).toEqual(['exchange', 'excluded', 'state']);
  });

  it('a slow call is still an answer: 10 minutes of wall time is reported, never judged', async () => {
    let t = FRESH_NOW;
    const { code, out } = await run({ now: () => (t += 600_000) });
    expect(code).toBe(0);
    expect(token(out, 'PRE_TRADE_HEALTH_WALL_MS')).toEqual(['PRE_TRADE_HEALTH_WALL_MS=600000']);
  });

  it('absent regime tables are reported and the probe still runs (the regime is optional context)', async () => {
    const { code, out, calls } = await run({ adoptTables: async () => false });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out).toContain('[pre-trade-health] CHECK db=REACHABLE regime_tables=ABSENT (the regime is unavailable; not judged)');
  });

  it('INDETERMINATE: the adoption threw — the database is unreachable, the probe never runs, exit 3', async () => {
    const { code, out, calls } = await run({ adoptTables: async () => { throw new Error('ECONNREFUSED'); } });
    expect(code).toBe(3);
    expect(calls).toHaveLength(0);
    expect(token(out, 'PRE_TRADE_HEALTH_VERDICT')).toEqual(['PRE_TRADE_HEALTH_VERDICT=INDETERMINATE']);
    expect(out).toContain('[pre-trade-health] CHECK db=UNREACHABLE — nothing was judged');
    // The fee table is judged whatever the database does.
    expect(token(out, 'VENUE_FEE_TABLE_VERDICT')).toEqual(['VENUE_FEE_TABLE_VERDICT=PASS']);
  });

  it('an unreachable database with a stale fee table still exits 1: the FAIL token wins the code', async () => {
    const stale: VenueFeeRow[] = [{ ...VENUE_FEE_ROWS[0], verifiedAt: '2026-01-01' }];
    const { code, out } = await run({ feeRows: stale, adoptTables: async () => { throw new Error('down'); } });
    expect(code).toBe(1);
    expect(token(out, 'VENUE_FEE_TABLE_VERDICT')).toEqual(['VENUE_FEE_TABLE_VERDICT=FAIL']);
    expect(token(out, 'VENUE_FEE_TABLE_STALE')).toEqual([`VENUE_FEE_TABLE_STALE=${VENUE_FEE_ROWS[0].exchange}`]);
  });

  it('broken arm: the probe throws — FAIL, exit 1, the fee token unaffected', async () => {
    const { code, out } = await run({ runCheck: async () => { throw new TypeError('boom'); } });
    expect(code).toBe(1);
    expect(token(out, 'PRE_TRADE_HEALTH_VERDICT')).toEqual(['PRE_TRADE_HEALTH_VERDICT=FAIL']);
    expect(token(out, 'PRE_TRADE_HEALTH_FAIL_KEYS')).toEqual(['PRE_TRADE_HEALTH_FAIL_KEYS=call:threw TypeError']);
    expect(token(out, 'VENUE_FEE_TABLE_VERDICT')).toEqual(['VENUE_FEE_TABLE_VERDICT=PASS']);
  });

  it('broken arm: a refusal FAILs', async () => {
    const { code, out } = await run({ runCheck: async () => refused('coin_not_listed', 404) });
    expect(code).toBe(1);
    expect(out).toContain('[pre-trade-health] CHECK probe=BTC long 10000 8h 4h outcome=refused coin_not_listed');
  });

  it('PRE_TRADE_HEALTH_MIN_VENUES tightens the floor: 4 up against 5 FAILs', async () => {
    const four = venues(['BINANCE', null], ['BYBIT', null], ['OKX', null], ['BITGET', null], ['HYPERLIQUID', 'feed_unavailable']);
    const { code, out } = await run({ runCheck: async () => okOutcome({ venues: four }) }, { PRE_TRADE_HEALTH_MIN_VENUES: '5' });
    expect(code).toBe(1);
    expect(out).toContain('[pre-trade-health] CHECK venues_up=4 of 5 min=5 (env)');
    expect(token(out, 'PRE_TRADE_HEALTH_FAIL_KEYS')).toEqual(['PRE_TRADE_HEALTH_FAIL_KEYS=venues:4 of 5 up, below 5']);
  });

  it('two failed checks are both keyed, semicolon-joined', async () => {
    const { out } = await run({ runCheck: async () => okOutcome({ decision: null, venues: [] }) });
    expect(token(out, 'PRE_TRADE_HEALTH_FAIL_KEYS')).toEqual(['PRE_TRADE_HEALTH_FAIL_KEYS=decision:missing;venues:0 of 0 up, below 3']);
  });
});

// ── DECISION-CALL-V2-W1 CH3 (AC3.2) — the log-parity leg ────────────────────────────────────────

describe('judgeLogParity — served (request_log) against logged (pre_trade_checks), each threshold from both sides', () => {
  it('the thresholds are the spec\'s: more than 2% AND at least 3', () => {
    expect([LOG_PARITY_MAX_GAP_PCT, LOG_PARITY_MIN_GAP]).toEqual([2, 3]);
  });
  it('the 2% side: a gap of 3 on 150 served is exactly 2% (PASS); on 149 it is above (FAIL)', () => {
    expect(judgeLogParity(150, 147)).toBe('PASS');
    expect(judgeLogParity(149, 146)).toBe('FAIL');
  });
  it('the floor side: a gap of 2 never FAILs, however small the volume; a gap of 3 does', () => {
    expect(judgeLogParity(2, 0)).toBe('PASS');
    expect(judgeLogParity(3, 1)).toBe('PASS');
    expect(judgeLogParity(3, 0)).toBe('FAIL');
    expect(judgeLogParity(100, 97)).toBe('FAIL');
  });
  it('equal, or more logged than served, PASSes', () => {
    expect(judgeLogParity(0, 0)).toBe('PASS');
    expect(judgeLogParity(40, 40)).toBe('PASS');
    expect(judgeLogParity(5, 9)).toBe('PASS');
  });
});

describe('main — the log-parity leg (AC3.2)', () => {
  it('PASS arm: the line is printed, the token stays PASS, exit 0', async () => {
    const { code, out } = await run({ countServed: async () => 100, countLogged: async () => 99 });
    expect(code).toBe(0);
    expect(out).toContain('pre_trade_check_log served=100 logged=99');
    expect(out).toContain('[pre-trade-health] CHECK log_parity table=ADOPTED window=24h max_gap_pct=2 min_gap=3 verdict=PASS');
    expect(token(out, 'PRE_TRADE_HEALTH_VERDICT')).toEqual(['PRE_TRADE_HEALTH_VERDICT=PASS']);
  });

  it('FAIL arm: served outruns logged — FAIL keyed log_parity, exit 1, the fee token unaffected', async () => {
    const { code, out } = await run({ countServed: async () => 100, countLogged: async () => 97 });
    expect(code).toBe(1);
    expect(out).toContain('pre_trade_check_log served=100 logged=97');
    expect(token(out, 'PRE_TRADE_HEALTH_VERDICT')).toEqual(['PRE_TRADE_HEALTH_VERDICT=FAIL']);
    expect(token(out, 'PRE_TRADE_HEALTH_FAIL_KEYS')).toEqual(['PRE_TRADE_HEALTH_FAIL_KEYS=log_parity:served=100 logged=97']);
    expect(token(out, 'VENUE_FEE_TABLE_VERDICT')).toEqual(['VENUE_FEE_TABLE_VERDICT=PASS']);
  });

  it('no-table arm: no check log and nothing served is PASS — and the log is never counted', async () => {
    const counted: number[] = [];
    const { code, out } = await run({ adoptCheckLog: async () => false, countServed: async () => 0, countLogged: async (s) => { counted.push(s); return 0; } });
    expect(code).toBe(0);
    expect(counted).toEqual([]);
    expect(out).toContain('[pre-trade-health] CHECK log_parity table=ABSENT window=24h max_gap_pct=2 min_gap=3 verdict=PASS');
    expect(out).toContain('pre_trade_check_log served=0 logged=0');
  });

  it('no-table arm, calls served: the writer is dark — FAIL', async () => {
    const { code, out } = await run({ adoptCheckLog: async () => false, countServed: async () => 5 });
    expect(code).toBe(1);
    expect(out).toContain('pre_trade_check_log served=5 logged=0');
    expect(token(out, 'PRE_TRADE_HEALTH_FAIL_KEYS')).toEqual(['PRE_TRADE_HEALTH_FAIL_KEYS=log_parity:served=5 logged=0']);
  });

  it('the window is the last 24 h, the same instant on both sides', async () => {
    const seen: number[] = [];
    let t = FRESH_NOW;
    await run({ now: () => (t += 1000), countServed: async (s) => { seen.push(s); return 1; }, countLogged: async (s) => { seen.push(s); return 1; } });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(t - seen[0]).toBeGreaterThanOrEqual(DAY);
    expect(t - seen[0]).toBeLessThan(DAY + 10_000);
  });

  it('a log younger than 24 h: the window starts at its first row, the same instant on both sides — v1 calls served before the log existed are not its gap', async () => {
    const born = FRESH_NOW - 2 * 3_600_000;
    const seen: number[] = [];
    const { code, out } = await run({
      firstLogged: async () => born,
      countServed: async (s) => { seen.push(s); return 12; },
      countLogged: async (s) => { seen.push(s); return 12; },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([born, born]);
    expect(out).toContain(`[pre-trade-health] CHECK log_parity table=ADOPTED window=first_row:${new Date(born).toISOString()} max_gap_pct=2 min_gap=3 verdict=PASS`);
  });

  it('a log older than 24 h, or one with no row yet: the full 24 h — served with nothing logged is still the dark writer', async () => {
    const seen: number[] = [];
    const old = await run({ firstLogged: async () => FRESH_NOW - 3 * DAY, countServed: async (s) => { seen.push(s); return 1; } });
    expect(old.code).toBe(0);
    expect(Math.abs(seen[0] - (FRESH_NOW - DAY))).toBeLessThan(10_000); // the harness clock ticks 1 s per read
    const empty = await run({ firstLogged: async () => null, countServed: async () => 5, countLogged: async () => 0 });
    expect(empty.code).toBe(1);
    expect(token(empty.out, 'PRE_TRADE_HEALTH_FAIL_KEYS')).toEqual(['PRE_TRADE_HEALTH_FAIL_KEYS=log_parity:served=5 logged=0']);
    expect(empty.out).toContain('[pre-trade-health] CHECK log_parity table=ADOPTED window=24h max_gap_pct=2 min_gap=3 verdict=FAIL');
  });

  it('no table: the first row is never asked for; an unreadable first row is INDETERMINATE, never a defaulted window', async () => {
    let asked = 0;
    await run({ adoptCheckLog: async () => false, countServed: async () => 0, firstLogged: async () => { asked += 1; return null; } });
    expect(asked).toBe(0);
    const bad = await run({ firstLogged: async () => { throw new Error('pre_trade_checks MIN(checked_at) unreadable: x'); } });
    expect(bad.code).toBe(3);
    expect(bad.out).toContain('[pre-trade-health] CHECK log_parity=UNREADABLE — not judged');
  });

  it('unreadable counts: INDETERMINATE, exit 3 — no PASS for a parity that was never read, and no served= line', async () => {
    const { code, out } = await run({ countServed: async () => { throw new Error('permission denied for table request_log'); } });
    expect(code).toBe(3);
    expect(token(out, 'PRE_TRADE_HEALTH_VERDICT')).toEqual(['PRE_TRADE_HEALTH_VERDICT=INDETERMINATE']);
    expect(out).toContain('[pre-trade-health] CHECK log_parity=UNREADABLE — not judged');
    expect(out.some((l) => l.startsWith('pre_trade_check_log '))).toBe(false);
  });

  it('a probe FAIL still wins over an unreadable parity, and both FAILs are keyed in check order', async () => {
    const thrown = await run({ runCheck: async () => { throw new TypeError('boom'); }, countServed: async () => { throw new Error('x'); } });
    expect([thrown.code, token(thrown.out, 'PRE_TRADE_HEALTH_VERDICT')]).toEqual([1, ['PRE_TRADE_HEALTH_VERDICT=FAIL']]);
    const both = await run({ runCheck: async () => { throw new TypeError('boom'); }, countServed: async () => 10, countLogged: async () => 0 });
    expect(token(both.out, 'PRE_TRADE_HEALTH_FAIL_KEYS')).toEqual(['PRE_TRADE_HEALTH_FAIL_KEYS=call:threw TypeError;log_parity:served=10 logged=0']);
  });
});

describe('source pins — what the probe can never do', () => {
  const src = readFileSync(join(__dirname, '../../src/scripts/pre-trade-health.ts'), 'utf8');
  const imports = src.split('\n').filter((l) => /^import\b/.test(l));

  it('it calls the ENGINE, never the pipeline — so it writes no request_log row (AC2.3, by construction)', () => {
    expect(imports.some((l) => l.includes("from '../tools/pre-trade-check.js'") && l.includes('runPreTradeCheck'))).toBe(true);
    for (const l of imports) {
      expect(l).not.toMatch(/tool-call-pipeline|analytics|request-log/);
    }
  });

  it('it ADOPTS the regime tables and never ensures them, so a read-only session sees no DDL', () => {
    expect(src).toContain('adoptExistingRegimeSnapshotTables');
    expect(src).not.toContain('ensureRegimeSnapshotTables');
  });

  it('it ADOPTS the check log and never writes it: the parity leg reads, the probe (the engine, not the pipeline) logs nothing', () => {
    expect(imports.some((l) => l.includes("from '../lib/pre-trade-check-log.js'") && l.includes('adoptPreTradeCheckTable'))).toBe(true);
    expect(src).not.toMatch(/recordPreTradeCheck|INSERT|CREATE/);
  });

  it('the probe is batch class under ONE literal caller tag', () => {
    expect(src.match(/await runAsBatch\(/g)).toHaveLength(1);
    expect(src).toContain("INTERNAL_LICENSE), 'pre_trade_health') };");
  });
});

describe('the inventory row — what the canary is declared to judge', () => {
  // DECISION-CALL-V2-AUDIT-W1: V2-W1 CH3 gave PRE_TRADE_HEALTH_VERDICT a third leg (log parity) and left the
  // row's notes at V1-W3's two. The inventory's own rule — a wave that edits a host monitoring artifact
  // updates its row in the same commit — covers the probe the wrapper runs: the notes are where an
  // operator reads what FAIL and INDETERMINATE mean, so they must name every leg and quote the live thresholds.
  const inventory = JSON.parse(readFileSync(join(__dirname, '../../ops/monitoring/monitoring-inventory.json'), 'utf8')) as {
    artifacts: Array<{ id: string; notes?: string }>;
  };
  const row = inventory.artifacts.find((a) => a.id === 'pre-trade-health-canary');

  it('names the log-parity leg: the table it reads, the live gap rule, and that unreadable counts are INDETERMINATE', () => {
    expect(row).toBeDefined();
    const notes = String(row!.notes ?? '');
    expect(notes).toMatch(/log[ _-]parity/i);
    expect(notes).toContain('pre_trade_checks');
    expect(notes).toContain(`${LOG_PARITY_MAX_GAP_PCT}%`);
    expect(notes).toContain(`at least ${LOG_PARITY_MIN_GAP}`);
    expect(notes).toMatch(/UNREADABLE|cannot be read|could not be read/);
  });
});
