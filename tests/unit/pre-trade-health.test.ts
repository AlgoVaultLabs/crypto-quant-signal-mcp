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

  it('the probe is batch class under ONE literal caller tag', () => {
    expect(src.match(/await runAsBatch\(/g)).toHaveLength(1);
    expect(src).toContain("INTERNAL_LICENSE), 'pre_trade_health') };");
  });
});
