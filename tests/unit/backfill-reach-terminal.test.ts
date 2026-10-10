/**
 * tests/unit/backfill-reach-terminal.test.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH1 (AC2).
 *
 * A row the venue can no longer serve leaves the PFE outcome backfill's queue. It EXECUTES the
 * producer's own SQL — on an in-process SQLite database always, and on Postgres when the lane sets
 * DATABASE_URL (a session TEMP table shadows `signals`, so the lane's real table is never touched).
 *
 * Why the exit is correct and not a tombstone: by the measured reach table the venue cannot serve the
 * row's window, so a retry either returns nothing (HL answers 500, Gate refuses — sediment) or, on the
 * six count-limited venues, FILLS the row from bars days after the signal (`computePFEMAE` takes the
 * first bars it is handed). The predicate is a clock against the venue's served depth: it reads no
 * attempt column, so nothing the producer does can move it, and re-measuring the table deeper puts
 * the rows back.
 *
 * The fixture rows are all long past their maturity horizon, so the only clause that can tell them
 * apart is the reach clause under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBackfillQueueSql, BACKFILL_MAX_ATTEMPTS, BACKFILL_ATTEMPT_COOLDOWN_S } from '../../src/lib/performance-db.js';
import {
  buildPastReachClause, reachCutoffS, VENUE_CANDLE_REACH_DAYS, REACH_MARGIN_S, PAST_REACH_EXCLUDED_PAIRS,
} from '../../src/lib/venue-candle-reach.js';

const NOW = 1_791_630_186; // 2026-10-10T11:03:06Z — this wave's R0 census instant.
const HL5M = reachCutoffS(17.36, NOW); // first created_at still inside HL 5m reach
const XT1H = reachCutoffS(41, NOW);

interface Fixture {
  id: number; coin: string; timeframe: string; exchange: string; created_at: number;
  outcome_price: number | null; outcome_attempts: number | null; outcome_last_attempt_at: number | null;
}

const COOLING = NOW - 60;                                   // maxed and still cooling
const COOLED = NOW - BACKFILL_ATTEMPT_COOLDOWN_S - 60;      // maxed and released by the backoff

/** id → why it is there. Each past-reach row comes in every attempt state the backoff knows. */
const ROWS: Fixture[] = [
  // HL 5m, one second PAST reach, in every attempt state — all must leave the queue.
  { id: 1, coin: 'BTC', timeframe: '5m', exchange: 'HL', created_at: HL5M - 1, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null },
  { id: 2, coin: 'BTC', timeframe: '5m', exchange: 'HL', created_at: HL5M - 1, outcome_price: null, outcome_attempts: 1, outcome_last_attempt_at: NOW - 600 },
  { id: 3, coin: 'BTC', timeframe: '5m', exchange: 'HL', created_at: HL5M - 1, outcome_price: null, outcome_attempts: BACKFILL_MAX_ATTEMPTS, outcome_last_attempt_at: COOLED },
  { id: 4, coin: 'BTC', timeframe: '5m', exchange: 'HL', created_at: HL5M - 1, outcome_price: null, outcome_attempts: BACKFILL_MAX_ATTEMPTS * 9, outcome_last_attempt_at: null },
  // HL 5m, exactly AT and one second INSIDE the cutoff — kept.
  { id: 5, coin: 'ETH', timeframe: '5m', exchange: 'HL', created_at: HL5M, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null },
  { id: 6, coin: 'ETH', timeframe: '5m', exchange: 'HL', created_at: HL5M + 1, outcome_price: null, outcome_attempts: 2, outcome_last_attempt_at: NOW - 600 },
  // exchange = '' is HL on the fill path (`sig.exchange || 'HL'`) — judged as HL here too.
  { id: 7, coin: 'SOL', timeframe: '5m', exchange: '', created_at: HL5M - 1, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null },
  { id: 8, coin: 'SOL', timeframe: '5m', exchange: '', created_at: HL5M + 1, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null },
  // An unbounded venue (no finite entry) is never excluded, however old.
  { id: 9, coin: 'BTC', timeframe: '5m', exchange: 'BINANCE', created_at: NOW - 400 * 86_400, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null },
  // An unlisted timeframe on a listed venue is unbounded too (HL 4h).
  { id: 10, coin: 'BTC', timeframe: '4h', exchange: 'HL', created_at: NOW - 400 * 86_400, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null },
  // A count-limited venue: XT 1h past reach (would be MISFILLED) and inside.
  { id: 11, coin: 'BTC', timeframe: '1h', exchange: 'XT', created_at: XT1H - 1, outcome_price: null, outcome_attempts: 1, outcome_last_attempt_at: NOW - 600 },
  { id: 12, coin: 'BTC', timeframe: '1h', exchange: 'XT', created_at: XT1H + 3600, outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null },
  // A past-reach row that is MAXED AND STILL COOLING is out either way — kept here to show the reach
  // clause does not depend on the backoff state.
  { id: 13, coin: 'DOGE', timeframe: '5m', exchange: 'HL', created_at: HL5M - 1, outcome_price: null, outcome_attempts: BACKFILL_MAX_ATTEMPTS, outcome_last_attempt_at: COOLING },
  // Already filled rows are never in the queue.
  { id: 14, coin: 'BTC', timeframe: '5m', exchange: 'BINANCE', created_at: NOW - 30 * 86_400, outcome_price: 1.5, outcome_attempts: null, outcome_last_attempt_at: null },
];

const EXPECTED_QUEUE = [5, 6, 8, 9, 10, 12];
const PAST_ROWS = [1, 2, 3, 4, 7, 11, 13];

type Exec = (sql: string) => Promise<Array<Record<string, unknown>>>;

const SCHEMA = `CREATE TEMP TABLE signals (
  id INTEGER PRIMARY KEY, coin TEXT NOT NULL, signal TEXT NOT NULL DEFAULT 'BUY', confidence INTEGER NOT NULL DEFAULT 70,
  timeframe TEXT NOT NULL, exchange TEXT NOT NULL DEFAULT 'HL', price_at_signal REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, outcome_price REAL, outcome_attempts INTEGER, outcome_last_attempt_at INTEGER,
  outcome_filled_at INTEGER, pfe_return_pct REAL, mae_return_pct REAL)`;

function insertSql(r: Fixture): string {
  const v = (x: number | string | null) => (x === null ? 'NULL' : typeof x === 'number' ? String(x) : `'${x}'`);
  return `INSERT INTO signals (id, coin, timeframe, exchange, created_at, outcome_price, outcome_attempts, outcome_last_attempt_at) VALUES (${[
    r.id, r.coin, r.timeframe, r.exchange, r.created_at, r.outcome_price, r.outcome_attempts, r.outcome_last_attempt_at,
  ].map(v).join(', ')})`;
}

function idsOf(rows: Array<Record<string, unknown>>): number[] {
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

function scenarios(label: string, exec: () => Exec) {
  describe(`AC2 [${label}] — the queue SQL, executed`, () => {
    it('past reach − margin ⇒ EXCLUDED at every attempt count, including never-attempted', async () => {
      const ids = idsOf(await exec()(buildBackfillQueueSql(NOW)));
      for (const id of PAST_ROWS) expect(ids, `row ${id}`).not.toContain(id);
    });

    it('at the cutoff and one second inside ⇒ KEPT', async () => {
      const ids = idsOf(await exec()(buildBackfillQueueSql(NOW)));
      expect(ids).toEqual(expect.arrayContaining([5, 6]));
    });

    it("exchange = '' is judged as HL — out past reach, in inside it", async () => {
      const ids = idsOf(await exec()(buildBackfillQueueSql(NOW)));
      expect(ids).not.toContain(7);
      expect(ids).toContain(8);
    });

    it('an unbounded venue or timeframe is never excluded', async () => {
      const ids = idsOf(await exec()(buildBackfillQueueSql(NOW)));
      expect(ids).toEqual(expect.arrayContaining([9, 10]));
    });

    it('the whole queue is exactly the expected set (no clause excludes anything else)', async () => {
      expect(idsOf(await exec()(buildBackfillQueueSql(NOW)))).toEqual(EXPECTED_QUEUE);
    });

    it('a pair the guard EXCLUDED from the clause keeps its rows — the value is never edited', async () => {
      const kept = idsOf(await exec()(`SELECT id FROM signals WHERE ${buildPastReachClause(NOW, new Set(['HL:5m']))}`));
      expect(kept).toEqual([11]); // only XT 1h is still past reach; every HL 5m row stays
    });

    it('an empty clause is (FALSE) and excludes nothing', async () => {
      const every = new Set<string>();
      for (const [v, m] of Object.entries(VENUE_CANDLE_REACH_DAYS)) for (const tf of Object.keys(m)) every.add(`${v}:${tf}`);
      const clause = buildPastReachClause(NOW, every);
      expect(clause).toBe('(FALSE)');
      const all = await exec()('SELECT id FROM signals');
      const notPast = await exec()(`SELECT id FROM signals WHERE NOT ${clause}`);
      expect(idsOf(notPast)).toEqual(idsOf(all));
    });

    it('the clause moves with `now` — a kept row crosses out exactly when its cutoff passes it', async () => {
      // Two seconds later the HL 5m cutoff is HL5M + 2: rows at HL5M and HL5M + 1 are now past reach.
      const ids = idsOf(await exec()(buildBackfillQueueSql(NOW + 2)));
      for (const id of [5, 6, 8]) expect(ids, `row ${id}`).not.toContain(id);
      expect(ids).toEqual([9, 10, 12]);
    });
  });
}

describe('AC2 — the built clause, as a string', () => {
  const clause = buildPastReachClause(NOW);

  it('references NO attempt or cooldown column — a clock, never the producer’s own state', () => {
    expect(clause).not.toMatch(/outcome_attempts|outcome_last_attempt_at|outcome_filled_at/);
  });

  it('carries one arm per finite pair, keyed by the fill path’s venue expression', () => {
    const finite = Object.values(VENUE_CANDLE_REACH_DAYS).reduce((n, m) => n + Object.keys(m).length, 0);
    expect(finite).toBe(52);
    expect((clause.match(/COALESCE\x28NULLIF\x28exchange,''\x29,'HL'\x29 = '/g) ?? []).length)
      .toBe(finite - PAST_REACH_EXCLUDED_PAIRS.size);
  });

  it('every cutoff is the labeler’s own arithmetic: floor(now − days × 86 400 + margin)', () => {
    expect(clause).toContain(`timeframe = '5m' AND created_at < ${Math.floor(NOW - 17.36 * 86_400 + REACH_MARGIN_S)}\x29`);
    expect(REACH_MARGIN_S).toBe(3600);
  });

  it('the queue embeds the clause verbatim as a NEGATED conjunct between backoff and maturity', () => {
    const sql = buildBackfillQueueSql(NOW);
    expect(sql).toContain(` AND NOT ${clause} AND \x28\x28timeframe = `);
  });
});

// ── backends ──────────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite: any = null;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  sqlite = new Database(':memory:');
  sqlite!.exec(SCHEMA.replace('CREATE TEMP TABLE', 'CREATE TABLE'));
  for (const r of ROWS) sqlite!.exec(insertSql(r));
});
afterAll(() => sqlite?.close());
scenarios('sqlite', () => async (sql) => sqlite!.prepare(sql).all() as Array<Record<string, unknown>>);

const PG_URL = process.env.DATABASE_URL;
describe.skipIf(!PG_URL)('AC2 — Postgres lane', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null;
  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    await client.query(SCHEMA);  // TEMP: shadows the real `signals` for this session only
    for (const r of ROWS) await client.query(insertSql(r));
  });
  afterAll(async () => { if (client) await client.end(); });
  scenarios('postgres', () => async (sql) => (await client.query(sql)).rows);
});
