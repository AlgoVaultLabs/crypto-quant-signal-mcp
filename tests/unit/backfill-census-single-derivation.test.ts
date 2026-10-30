/**
 * tests/unit/backfill-census-single-derivation.test.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH1 (AC3).
 *
 * The outcome-backfill canary used to judge the producer through a hand-written Python MIRROR of the
 * queue predicate. A mirror is a second derivation: it drifted once already (the drain gate's copy
 * never got A1b's maturity clause), and the canary's own parity check compared constants only, and
 * only when a checkout sat beside it — never on the host where it runs. Now the canary EXECUTES the
 * producer's own SQL, emitted by `dist/scripts/backfill-queue-census.js`.
 *
 * These tests run that SQL on a fixture and pin what single derivation means here:
 *   * `servable_uncapped` IS `count(*)` of the queue's rows with no LIMIT;
 *   * `frontier` IS `MAX(created_at)` of the queue's own LIMITed result;
 *   * `horizons_s[tf]` IS `maturityHorizonS(tf)`;
 *   * the emitter's JSON carries every key the canary reads, and the canary's REAL parser reads the
 *     REAL census SQL's output (the artifacts its hermetic self-test replaces with fixtures);
 *   * (OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1 CH2) the per-(venue, coin) census arm 3e reads: the SAME
 *     windowed counters as the venue census, one venue's fills never counted into another's cell, and the
 *     wrapper's page-on-change key grammar pinned to the canary's copy.
 *
 * SPAWN BUDGET DECLARED on every spawning block (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBackfillQueueSql, buildBackfillCensusSql, buildBackfillVenueCensusSql, buildBackfillCoinCensusSql,
  buildWindowedCensusCounters,
  BACKFILL_CENSUS_COLUMNS, BACKFILL_VENUE_CENSUS_COLUMNS, BACKFILL_COIN_CENSUS_COLUMNS, BACKFILL_COIN_CENSUS_WINDOW_S,
  BACKFILL_QUEUE_LIMIT, BACKFILL_MAX_ATTEMPTS, BACKFILL_ATTEMPT_COOLDOWN_S,
} from '../../src/lib/performance-db.js';
import { EVAL_CANDLES, maturityHorizonS } from '../../src/lib/pfe-mae.js';
import { reachCutoffS, REACH_MARGIN_S, EXPIRY_REACH_DAYS_MEASURED_AT, buildPastReachClause } from '../../src/lib/venue-candle-reach.js';
import { buildCensusEmission, runCensusEmitter, EMITTER_KEYS, EMITTER_CONSTANT_KEYS } from '../../src/scripts/backfill-queue-census.js';

const REPO = path.resolve(__dirname, '../..');
const CANARY = path.join(REPO, 'ops/monitoring/outcome-backfill-freshness.py');
const WRAPPER = path.join(REPO, 'ops/monitoring/send_telegram.sh');
const NOW = 1_791_630_186;
const DAY = 86_400;
const HL5M = reachCutoffS(17.36, NOW);

interface Row {
  id: number; timeframe: string; exchange: string; created_at: number; outcome_price: number | null;
  outcome_attempts: number | null; outcome_last_attempt_at: number | null; outcome_filled_at: number | null;
}
const ROWS: Row[] = [];
let nextId = 1;
const add = (r: Omit<Row, 'id'>) => ROWS.push({ id: nextId++, ...r });
// HL 5m: 3 past reach (one never attempted, one cooling, one cooled), 4 servable inside reach.
add({ timeframe: '5m', exchange: 'HL', created_at: HL5M - 10, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: null });
add({ timeframe: '5m', exchange: 'HL', created_at: HL5M - 20, outcome_price: null, outcome_attempts: BACKFILL_MAX_ATTEMPTS, outcome_last_attempt_at: NOW - 60, outcome_filled_at: null });
add({ timeframe: '5m', exchange: '', created_at: HL5M - 30, outcome_price: null, outcome_attempts: BACKFILL_MAX_ATTEMPTS, outcome_last_attempt_at: NOW - BACKFILL_ATTEMPT_COOLDOWN_S - 60, outcome_filled_at: null });
for (let i = 0; i < 4; i++) add({ timeframe: '5m', exchange: 'HL', created_at: NOW - (5 + i) * DAY, outcome_price: null, outcome_attempts: i % 2 ? 1 : null, outcome_last_attempt_at: i % 2 ? NOW - 600 : null, outcome_filled_at: null });
// Parked but inside reach (attempted 3 times in the last hour) — counted parked, not servable.
add({ timeframe: '5m', exchange: 'HL', created_at: NOW - 2 * DAY, outcome_price: null, outcome_attempts: BACKFILL_MAX_ATTEMPTS, outcome_last_attempt_at: NOW - 3600, outcome_filled_at: null });
// Immature: a 1h row created 2 h ago (horizon 9 h).
add({ timeframe: '1h', exchange: 'BINANCE', created_at: NOW - 7200, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: null });
// BINANCE (unbounded) old pending rows — servable whatever their age.
add({ timeframe: '5m', exchange: 'BINANCE', created_at: NOW - 300 * DAY, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: null });
// Filled rows: one in the last 24 h (matured within it), one long ago.
add({ timeframe: '15m', exchange: 'BINANCE', created_at: NOW - 6 * 3600, outcome_price: 2, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: NOW - 3 * 3600 });
add({ timeframe: '15m', exchange: 'BINANCE', created_at: NOW - 40 * DAY, outcome_price: 2, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: NOW - 39 * DAY });
// XT: a row matured within 24 h, attempted, NOT filled — the shape arm 3d pages on.
add({ timeframe: '15m', exchange: 'XT', created_at: NOW - 8 * 3600, outcome_price: null, outcome_attempts: 1, outcome_last_attempt_at: NOW - 1800, outcome_filled_at: null });
// HL 5m row that crossed into past-reach within the last 24 h (and one that crossed earlier: id 1..3).
add({ timeframe: '5m', exchange: 'HL', created_at: HL5M - 3600, outcome_price: null, outcome_attempts: 2, outcome_last_attempt_at: NOW - 7200, outcome_filled_at: null });
add({ timeframe: '5m', exchange: 'HL', created_at: HL5M - 2 * DAY, outcome_price: null, outcome_attempts: 3, outcome_last_attempt_at: NOW - 2 * DAY, outcome_filled_at: null });

// ── the coin census fixture (CH2) — its own table, so the queue scenarios above keep their counts ──
interface CoinRow {
  id: number; coin: string; timeframe: string; exchange: string; created_at: number; outcome_price: number | null;
  outcome_attempts: number | null; outcome_last_attempt_at: number | null; outcome_filled_at: number | null;
}
const COIN_ROWS: CoinRow[] = [];
const H1 = 32_400; // the 1h maturity horizon (EVAL_CANDLES + 1 bars)
const coinAdd = (r: Omit<CoinRow, 'id'>) => COIN_ROWS.push({ id: COIN_ROWS.length + 1, ...r });
const pending = { outcome_price: null, outcome_attempts: 1, outcome_last_attempt_at: NOW - 3600, outcome_filled_at: null };
// HL|SKHY — the xyz shape: 6 rows due inside the window, every one attempted, none filled. One carries an
// EMPTY exchange, which the fill path reads as HL.
for (let k = 0; k < 6; k++) coinAdd({ coin: 'SKHY', timeframe: '1h', exchange: k === 5 ? '' : 'HL', created_at: NOW - H1 - k * DAY / 2, ...pending });
// BINANCE|SKHY — the SAME coin on another venue, filling: it must never stand in for HL|SKHY.
for (let k = 0; k < 3; k++) coinAdd({ coin: 'SKHY', timeframe: '1h', exchange: 'BINANCE', created_at: NOW - H1 - k * DAY, outcome_price: 2, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: NOW - 7200 });
coinAdd({ coin: 'SKHY', timeframe: '1h', exchange: 'BINANCE', created_at: NOW - 9 * DAY, outcome_price: 2, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: NOW - 8 * DAY });
// HL|BTC — filled inside the window, but it became due weeks ago: nothing due ⇒ no cell.
coinAdd({ coin: 'BTC', timeframe: '1h', exchange: 'HL', created_at: NOW - 20 * DAY, outcome_price: 2, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: NOW - DAY });
// XT|EDGE — the window is (now − 7 d, now]: due exactly 7 d ago is out, one second later is in.
coinAdd({ coin: 'EDGE', timeframe: '1h', exchange: 'XT', created_at: NOW - 7 * DAY - H1, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: null });
coinAdd({ coin: 'EDGE', timeframe: '1h', exchange: 'XT', created_at: NOW - 7 * DAY - H1 + 1, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null, outcome_filled_at: null });
// ASTER|龙虾 — a coin in another script survives the census and the canary's parser.
coinAdd({ coin: '龙虾', timeframe: '1h', exchange: 'ASTER', created_at: NOW - H1 - 3600, ...pending });
// GATE|NEW — immature (created 10 min ago): no cell.
coinAdd({ coin: 'NEW', timeframe: '1h', exchange: 'GATE', created_at: NOW - 600, ...pending });
const COIN_EXPECTED = [
  { venue: 'ASTER', coin: '龙虾', matured_7d: 1, filled_7d: 0, attempted_7d: 1 },
  { venue: 'BINANCE', coin: 'SKHY', matured_7d: 3, filled_7d: 3, attempted_7d: 0 },
  { venue: 'HL', coin: 'SKHY', matured_7d: 6, filled_7d: 0, attempted_7d: 6 },
  { venue: 'XT', coin: 'EDGE', matured_7d: 1, filled_7d: 0, attempted_7d: 0 },
];
const coinInsert = (r: CoinRow) =>
  `INSERT INTO signals (id, coin, timeframe, exchange, created_at, outcome_price, outcome_attempts, outcome_last_attempt_at, outcome_filled_at) VALUES (${[
    r.id, r.coin, r.timeframe, r.exchange, r.created_at, r.outcome_price, r.outcome_attempts, r.outcome_last_attempt_at, r.outcome_filled_at,
  ].map((x) => (x === null ? 'NULL' : typeof x === 'number' ? String(x) : `'${x}'`)).join(', ')})`;

type Exec = (sql: string) => Promise<Array<Record<string, unknown>>>;
const SCHEMA = `CREATE TEMP TABLE signals (
  id INTEGER PRIMARY KEY, coin TEXT NOT NULL DEFAULT 'BTC', signal TEXT NOT NULL DEFAULT 'BUY',
  confidence INTEGER NOT NULL DEFAULT 70, timeframe TEXT NOT NULL, exchange TEXT NOT NULL DEFAULT 'HL',
  price_at_signal REAL NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, outcome_price REAL,
  outcome_attempts INTEGER, outcome_last_attempt_at INTEGER, outcome_filled_at INTEGER,
  backfill_fail_class TEXT, pfe_return_pct REAL, mae_return_pct REAL)`;
const sqlVal = (x: number | string | null) => (x === null ? 'NULL' : typeof x === 'number' ? String(x) : `'${x}'`);
const insert = (r: Row) =>
  `INSERT INTO signals (id, timeframe, exchange, created_at, outcome_price, outcome_attempts, outcome_last_attempt_at, outcome_filled_at) VALUES (${[
    r.id, r.timeframe, r.exchange, r.created_at, r.outcome_price, r.outcome_attempts, r.outcome_last_attempt_at, r.outcome_filled_at,
  ].map(sqlVal).join(', ')})`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function scenarios(label: string, exec: () => Exec) {
  describe(`AC3 [${label}] — the census is the queue, counted`, () => {
    it('one scalar row whose columns are exactly BACKFILL_CENSUS_COLUMNS, in order', async () => {
      const rows = await exec()(buildBackfillCensusSql(NOW));
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0])).toEqual([...BACKFILL_CENSUS_COLUMNS]);
    });

    it('servable_uncapped = count(*) of the queue’s own rows with no LIMIT', async () => {
      const [c] = await exec()(buildBackfillCensusSql(NOW));
      const queue = await exec()(buildBackfillQueueSql(NOW, 1_000_000));
      expect(num(c.servable_uncapped)).toBe(queue.length);
      expect(queue.length).toBe(6); // 4 HL in reach (ids 4-7) + BINANCE 300 d old (10) + XT (13)
    });

    it('frontier = MAX(created_at) of the queue’s own LIMITed result', async () => {
      const [c] = await exec()(buildBackfillCensusSql(NOW));
      const q = await exec()(buildBackfillQueueSql(NOW));
      expect(num(c.frontier)).toBe(Math.max(...q.map((r) => Number(r.created_at))));
      // and the LIMIT is honoured: with a cap of 2 the frontier is the 2nd-oldest servable row
      const [c2] = await exec()(buildBackfillCensusSql(NOW, 2));
      const q2 = await exec()(buildBackfillQueueSql(NOW, 2));
      expect(q2).toHaveLength(2);
      expect(num(c2.frontier)).toBe(Math.max(...q2.map((r) => Number(r.created_at))));
      expect(num(c2.frontier)).toBeLessThan(num(c.frontier)!);
    });

    it('backlog, immature, parked and past_reach count exactly their populations', async () => {
      const [c] = await exec()(buildBackfillCensusSql(NOW));
      expect(num(c.backlog_uncapped)).toBe(ROWS.filter((r) => r.outcome_price === null).length);
      expect(num(c.immature)).toBe(1);
      // parked = maxed AND still cooling: id 2 (past reach) and id 8 (inside); id 15 is maxed but cooled
      expect(num(c.parked)).toBe(2);
      // past reach (pending, mature, older than HL 5m reach − margin): ids 1, 2, 3, 14, 15 ⇒ 5
      expect(num(c.past_reach)).toBe(5);
    });

    it('the venue rows carry exactly BACKFILL_VENUE_CENSUS_COLUMNS and the 24 h counters', async () => {
      const rows = await exec()(buildBackfillVenueCensusSql(NOW));
      for (const r of rows) expect(Object.keys(r)).toEqual([...BACKFILL_VENUE_CENSUS_COLUMNS]);
      const by = Object.fromEntries(rows.map((r) => [String(r.venue), r]));
      expect(Object.keys(by).sort()).toEqual(['BINANCE', 'HL', 'XT']); // '' folds into HL
      expect(num(by.XT.matured_24h)).toBe(1);
      expect(num(by.XT.filled_24h)).toBe(0);
      expect(num(by.XT.attempted_24h)).toBe(1);
      expect(num(by.BINANCE.filled_24h)).toBe(1);
      expect(num(by.BINANCE.matured_24h)).toBe(1); // the 15m row created 6 h ago; the 1h row is immature
      expect(num(by.HL.past_reach_entered_24h)).toBe(4); // ids 1, 2, 3, 14 crossed within 24 h; 15 crossed 2 d ago
    });

    it('servable per venue sums to the scalar servable_uncapped (one predicate, two projections)', async () => {
      const [c] = await exec()(buildBackfillCensusSql(NOW));
      const rows = await exec()(buildBackfillVenueCensusSql(NOW));
      expect(rows.reduce((n, r) => n + Number(r.servable), 0)).toBe(num(c.servable_uncapped));
    });
  });
}

function coinScenarios(label: string, exec: () => Exec) {
  describe(`CH2 [${label}] — the coin census is the venue census's counters, per (venue, coin)`, () => {
    const rows = async () => (await exec()(buildBackfillCoinCensusSql(NOW))).map((r) => ({
      venue: String(r.venue), coin: String(r.coin), matured_7d: num(r.matured_7d), filled_7d: num(r.filled_7d), attempted_7d: num(r.attempted_7d),
    }));

    it('one row per (venue, coin) with matured_7d >= 1, columns exactly BACKFILL_COIN_CENSUS_COLUMNS', async () => {
      const raw = await exec()(buildBackfillCoinCensusSql(NOW));
      for (const r of raw) expect(Object.keys(r)).toEqual([...BACKFILL_COIN_CENSUS_COLUMNS]);
      expect(await rows()).toEqual(COIN_EXPECTED);
    });

    it('ONE venue’s fills never count into ANOTHER venue’s cell — HL|SKHY stays at 0 beside a filling BINANCE|SKHY', async () => {
      const by = Object.fromEntries((await rows()).map((r) => [`${r.venue}|${r.coin}`, r]));
      expect(by['HL|SKHY'].filled_7d).toBe(0);
      expect(by['BINANCE|SKHY'].filled_7d).toBe(3);
    });

    it('an empty exchange is HL (the fill path’s own venue key), and the window is (now − 7 d, now]', async () => {
      const by = Object.fromEntries((await rows()).map((r) => [`${r.venue}|${r.coin}`, r]));
      expect(by['HL|SKHY'].matured_7d).toBe(6);  // five 'HL' rows + one '' row
      expect(by['XT|EDGE'].matured_7d).toBe(1);  // due exactly 7 d ago is out; one second later is in
      expect(Object.keys(by)).not.toContain('|SKHY');
      expect(Object.keys(by)).not.toContain('HL|BTC');   // filled in the window, due weeks ago
      expect(Object.keys(by)).not.toContain('GATE|NEW'); // immature
    });
  });
}

describe('CH2 — one derivation for both per-group censuses', () => {
  it('the venue census and the coin census carry the SAME windowed counters, each at its own window', () => {
    const day = buildWindowedCensusCounters(NOW, DAY);
    const week = buildWindowedCensusCounters(NOW, BACKFILL_COIN_CENSUS_WINDOW_S);
    for (const expr of Object.values(day)) expect(buildBackfillVenueCensusSql(NOW)).toContain(expr);
    for (const expr of Object.values(week)) expect(buildBackfillCoinCensusSql(NOW)).toContain(expr);
    // the same expressions, differing ONLY in where the window starts
    expect(week.filled).toBe(day.filled.replaceAll(String(NOW - DAY), String(NOW - 7 * DAY)));
    expect(week.attempted).toBe(day.attempted.replaceAll(String(NOW - DAY), String(NOW - 7 * DAY)));
    expect(week.matured.split(' AND NOT ')[0]).toBe(day.matured.split(' AND NOT ')[0]);
  });

  it('the `_7d` column suffix IS the window — the canary’s "7 d" can never drift from the SQL', () => {
    expect(BACKFILL_COIN_CENSUS_WINDOW_S).toBe(7 * DAY);
    expect(BACKFILL_COIN_CENSUS_COLUMNS.filter((c) => c.endsWith('_7d'))).toHaveLength(3);
  });

  it('the coin census names no outcome value and no statement separator (the canary refuses both)', () => {
    const sql = buildBackfillCoinCensusSql(NOW).toLowerCase();
    for (const t of ['outcome_return_pct', 'mae_return_pct', 'pfe_return_pct', 'pfe_price', 'mae_price', 'return_1candle']) expect(sql).not.toContain(t);
    expect(sql).not.toContain(';');
  });
});

describe('AC3 — the emitter', () => {
  it('horizons_s[tf] = maturityHorizonS(tf) for every EVAL_CANDLES key', () => {
    const e = buildCensusEmission(NOW, {});
    for (const tf of Object.keys(EVAL_CANDLES)) expect(e.horizons_s[tf], tf).toBe(maturityHorizonS(tf));
    expect(Object.keys(e.horizons_s).sort()).toEqual(Object.keys(EVAL_CANDLES).sort());
  });

  it('carries the producer’s own constants and the SQL its builders emit, byte-identical', () => {
    const sha = '0b1ea5d0288f6a69640640f0d2965163e71bd79c';
    const e = buildCensusEmission(NOW, { GIT_SHA: sha });
    expect(e.constants).toEqual({ limit: BACKFILL_QUEUE_LIMIT, max_attempts: BACKFILL_MAX_ATTEMPTS,
      cooldown_s: BACKFILL_ATTEMPT_COOLDOWN_S, reach_margin_s: REACH_MARGIN_S });
    expect(e.census_sql).toBe(buildBackfillCensusSql(NOW));
    expect(e.venue_sql).toBe(buildBackfillVenueCensusSql(NOW));
    expect(e.coin_sql).toBe(buildBackfillCoinCensusSql(NOW));
    expect(e.past_reach_clause).toBe(buildPastReachClause(NOW));
    expect(e.census_sql).toContain(e.past_reach_clause); // the audited clause IS the executed one
    expect(e.past_reach_clause).not.toMatch(/outcome_attempts|outcome_last_attempt_at|outcome_filled_at/);
    expect(e.reach_measured_at).toBe(EXPIRY_REACH_DAYS_MEASURED_AT);
    expect(e.source_sha).toBe(sha);
    expect(buildCensusEmission(NOW, {}).source_sha).toBe('unknown');
    expect(buildCensusEmission(NOW, { GIT_SHA: 'not-a-sha' }).source_sha).toBe('unknown');
  });

  it('prints ONE JSON line then BACKFILL_CENSUS_EMIT_VERDICT=PASS, exit 0', () => {
    const r = runCensusEmitter(['--emit-sql', '--now', String(NOW)], {});
    expect(r.exitCode).toBe(0);
    expect(r.lines).toHaveLength(2);
    expect(Object.keys(JSON.parse(r.lines[0])).sort()).toEqual([...EMITTER_KEYS].sort());
    expect(r.lines[1]).toBe('BACKFILL_CENSUS_EMIT_VERDICT=PASS');
  });

  it('a malformed --now, a missing --emit-sql or a builder throw is INDETERMINATE at exit 3 — never PASS', () => {
    for (const argv of [['--emit-sql', '--now', 'abc'], ['--emit-sql'], ['--now', String(NOW)], ['--emit-sql', '--now', '-5']]) {
      const r = runCensusEmitter(argv, {});
      expect(r.exitCode, argv.join(' ')).toBe(3);
      expect(r.lines[r.lines.length - 1]).toBe('BACKFILL_CENSUS_EMIT_VERDICT=INDETERMINATE');
      expect(r.lines.some((l) => l.startsWith('{')), 'no JSON on the INDETERMINATE path').toBe(false);
    }
  });

  it('the CLI entry point is wired: the script prints the same two lines', { timeout: 120_000 }, () => {
    const tsx = path.join(REPO, 'node_modules/.bin/tsx');
    const r = spawnSync(tsx, [path.join(REPO, 'src/scripts/backfill-queue-census.ts'), '--emit-sql', '--now', String(NOW)],
      { encoding: 'utf8', env: { ...process.env, GIT_SHA: '' } });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[lines.length - 1]).toBe('BACKFILL_CENSUS_EMIT_VERDICT=PASS');
    expect(JSON.parse(lines[lines.length - 2]).census_sql).toBe(buildBackfillCensusSql(NOW));
  });
});

describe('AC3 — the canary reads what the emitter writes (the artifacts its self-test bypasses)', () => {
  const py = readFileSync(CANARY, 'utf8');
  const tuple = (name: string): string[] => {
    const m = new RegExp(`^${name} = \\x28([^\\x29]*)\\x29`, 'm').exec(py);
    if (!m) throw new Error(`${name} not declared in ${CANARY}`);
    return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  };

  it('every emitter key the canary requires is in the emitted JSON, and nothing it requires is missing', () => {
    expect(tuple('EMITTER_KEYS')).toEqual([...EMITTER_KEYS]);
    expect(tuple('EMITTER_CONSTANT_KEYS')).toEqual([...EMITTER_CONSTANT_KEYS]);
    const e = buildCensusEmission(NOW, {}) as unknown as Record<string, unknown>;
    for (const k of tuple('EMITTER_KEYS')) expect(e, k).toHaveProperty(k);
    for (const k of tuple('EMITTER_CONSTANT_KEYS')) expect(e.constants, k).toHaveProperty(k);
  });

  it('the canary’s column contracts are the builders’ columns', () => {
    expect(tuple('CENSUS_COLUMNS')).toEqual([...BACKFILL_CENSUS_COLUMNS]);
    expect(tuple('VENUE_COLUMNS')).toEqual([...BACKFILL_VENUE_CENSUS_COLUMNS]);
    expect(tuple('COIN_COLUMNS')).toEqual([...BACKFILL_COIN_CENSUS_COLUMNS]);
  });

  it('arm 3e’s own emitter keys are emitter keys (their absence blinds arm 3e alone, never arms 2-3d)', () => {
    expect(tuple('ARM_3E_EMITTER_KEYS')).toEqual(['coin_sql']);
    for (const k of tuple('ARM_3E_EMITTER_KEYS')) expect(EMITTER_KEYS as readonly string[]).toContain(k);
  });

  it('the canary’s page-on-change key grammar IS the wrapper’s — a key the wrapper refuses would LEVEL-page', () => {
    const grab = (src: string, name: string): string => {
      const m = new RegExp(`${name} = re\\.compile\\(r"([^"]+)"\\)`).exec(src);
      if (!m) throw new Error(`${name} not found`);
      return m[1];
    };
    expect(grab(py, 'WRAPPER_KEY_RE')).toBe(grab(readFileSync(WRAPPER, 'utf8'), 'KEY_RE'));
  });

  it('the canary’s REAL parsers read the REAL census SQL’s output from this fixture', { timeout: 120_000 }, async () => {
    // psql -tA -F'|' renders NULL as an empty field; reproduce exactly that from the SQLite rows.
    const render = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => Object.values(r).map((v) => (v === null || v === undefined ? '' : String(v))).join('|')).join('\n');
    const census = 'SET\n' + render(sqliteRows(buildBackfillCensusSql(NOW)));
    const venues = 'SET\n' + render(sqliteRows(buildBackfillVenueCensusSql(NOW)));
    const coins = 'SET\n' + render(coinRows(buildBackfillCoinCensusSql(NOW)));
    const prog = [
      'import importlib.util, json, sys',
      `s = importlib.util.spec_from_file_location("obf", ${JSON.stringify(CANARY)})`,
      'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'd = json.load(sys.stdin)',
      'print(json.dumps({"census": m.parse_emitter_census(d["census"]), "venues": m.parse_venue_rows(d["venues"]),',
      '                  "coins": m.parse_coin_rows(d["coins"])}, ensure_ascii=False))',
    ].join('\n');
    const r = spawnSync('python3', ['-B', '-c', prog], {
      input: JSON.stringify({ census, venues, coins }), encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    const [c] = sqliteRows(buildBackfillCensusSql(NOW));
    for (const k of BACKFILL_CENSUS_COLUMNS) expect(out.census[k], k).toBe(num(c[k]));
    expect(out.venues.map((v: Record<string, unknown>) => v.venue).sort()).toEqual(['BINANCE', 'HL', 'XT']);
    expect(out.coins).toEqual(COIN_EXPECTED);   // the CJK coin and the HL fold arrive intact
  });
});

// ── backends ──────────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteCoin: any = null;
const sqliteRows = (sql: string) => sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
const coinRows = (sql: string) => sqliteCoin.prepare(sql).all() as Array<Record<string, unknown>>;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA.replace('CREATE TEMP TABLE', 'CREATE TABLE'));
  for (const r of ROWS) sqlite.exec(insert(r));
  sqliteCoin = new Database(':memory:');
  sqliteCoin.exec(SCHEMA.replace('CREATE TEMP TABLE', 'CREATE TABLE'));
  for (const r of COIN_ROWS) sqliteCoin.exec(coinInsert(r));
});
afterAll(() => { sqlite?.close(); sqliteCoin?.close(); });
scenarios('sqlite', () => async (sql) => sqliteRows(sql));
coinScenarios('sqlite', () => async (sql) => coinRows(sql));

const PG_URL = process.env.DATABASE_URL;
describe.skipIf(!PG_URL)('AC3 — Postgres lane', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null;
  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    await client.query(SCHEMA);
    for (const r of ROWS) await client.query(insert(r));
  });
  afterAll(async () => { if (client) await client.end(); });
  scenarios('postgres', () => async (sql) => (await client.query(sql)).rows);
});

describe.skipIf(!PG_URL)('CH2 — Postgres lane (coin census)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null;
  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    await client.query(SCHEMA);
    for (const r of COIN_ROWS) await client.query(coinInsert(r));
  });
  afterAll(async () => { if (client) await client.end(); });
  coinScenarios('postgres', () => async (sql) => (await client.query(sql)).rows);
});
