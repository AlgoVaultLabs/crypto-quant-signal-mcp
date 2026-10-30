/**
 * tests/unit/backfill-fail-class.test.ts — OPS-VENUE-MARKET-CLOSED-W2.
 *
 * On 2026-10-30 arm 3e paged `BINGX|NCSKRIG2USD` ("5 matured, 0 filled, 5 attempted in 7 d") for attempts the
 * producer had REFUSED because BingX declared the market paused — 0 requests sent. The attempt record carried
 * no reason, so the census counted the venue's own pause as our failure. The producer now classifies each
 * failed attempt once, at attempt time (`backfill_fail_class`), and `attempted` projects from that record.
 *
 *   * AC1 — every attempt site writes its class: the cron's `main()` and the lazy `runBackfill()` driven with
 *     a stubbed venue (a `VenueMarketClosedError` from the seam AND in-band ⇒ `venue_closed`), and the real
 *     UPDATE round-tripped on the real SQLite backend, its column added by SIGNAL_MIGRATIONS.
 *   * AC2 — the real census SQL on the real engine (better-sqlite3): a closure-only cell has `attempted_7d` = 0
 *     and the canary's OWN candidacy rule (`is_coin_candidate`, Python) does not pick it; an `error` cell and a
 *     NULL-class (pre-W2) cell still count. The deliberate break — the same SQL with the filter removed — makes
 *     the closure cell a candidate again, so the filter is load-bearing, not decorative.
 *
 * SPAWN BUDGET DECLARED on every spawning block (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  // The real backend for the write round-trip: a private in-memory SQLite, never a shared file.
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  return {
    queue: [] as unknown[][],
    recorded: [] as Array<[number, string]>,
    filled: [] as number[],
  };
});

vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: (venue: string) => ({
    getCandles: async (coin: string, _tf: string, startMs: number) => {
      const { VenueMarketClosedError } = await import('../../src/lib/errors.js');
      if (coin === 'NCSKSEAM2USD') {
        throw new VenueMarketClosedError({ venue, coin, symbol: coin, source: 'status', venueCode: 25, venueMessage: null });
      }
      if (coin === 'NCSKBAND2USD') {
        throw new VenueMarketClosedError({
          venue, coin, symbol: coin, source: 'in_band', venueCode: 109415, venueMessage: `${coin} is pause currently`,
        });
      }
      if (coin === 'BOOM') throw new Error('upstream 500');
      if (coin === 'EMPTY') return [];
      // GOOD and BAD: a full evaluation window of 1h candles after the signal time.
      return Array.from({ length: 10 }, (_, i) => ({
        time: startMs + i * 3_600_000, open: 1, high: 1.02, low: 0.98, close: 1.01, volume: 1,
      }));
    },
  }),
}));

// `computePFEMAE` returns null only on an empty window, which the caller's own filter already excludes, so
// the `unevaluable` branch is reached by a stub — the branch is real, the input that reaches it is not.
vi.mock('../../src/lib/pfe-mae.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/pfe-mae.js')>();
  return {
    ...real,
    computePFEMAE: (sig: { coin: string }, candles: never, n: number) =>
      sig.coin === 'BAD' ? null : real.computePFEMAE(sig as never, candles, n),
  };
});

vi.mock('../../src/lib/performance-db.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/performance-db.js')>();
  return {
    ...real,
    getSignalsNeedingUnifiedBackfillAsync: vi.fn(async () => h.queue.shift() ?? []),
    recordBackfillAttempt: vi.fn(async (id: number, failClass: string) => { h.recorded.push([id, failClass]); }),
    updateSignalOutcomes: vi.fn(async (id: number) => { h.filled.push(id); }),
    closeDb: vi.fn(),
  };
});

import {
  BACKFILL_FAIL_CLASSES, EXOGENOUS_BACKFILL_FAIL_CLASSES, SQL_ATTEMPT_NOT_EXOGENOUS,
  buildBackfillCoinCensusSql, buildBackfillVenueCensusSql,
} from '../../src/lib/performance-db.js';
import { main } from '../../src/scripts/backfill-outcomes.js';
import { runBackfill } from '../../src/resources/signal-performance.js';

const REPO = path.resolve(__dirname, '../..');
const CANARY = path.join(REPO, 'ops/monitoring/outcome-backfill-freshness.py');
const DAY = 86_400;
const NOW = 1_793_380_000; // 2026-10-30T17:06:40Z

const sig = (id: number, coin: string, exchange: string) => ({
  id, coin, signal: 'BUY', confidence: 70, timeframe: '1h', exchange, price_at_signal: 1,
  created_at: Math.floor(Date.now() / 1000) - 3 * DAY,
});

describe('the class list is declared once', () => {
  it('four classes; the exogenous ones are a subset; the SQL test is built from them and is NULL-safe', () => {
    expect([...BACKFILL_FAIL_CLASSES]).toEqual(['venue_closed', 'no_candles', 'unevaluable', 'error']);
    expect([...EXOGENOUS_BACKFILL_FAIL_CLASSES]).toEqual(['venue_closed']);
    for (const c of EXOGENOUS_BACKFILL_FAIL_CLASSES) expect(SQL_ATTEMPT_NOT_EXOGENOUS).toContain(`'${c}'`);
    expect(SQL_ATTEMPT_NOT_EXOGENOUS).toBe("(backfill_fail_class IS NULL OR backfill_fail_class NOT IN ('venue_closed'))");
    // the coin AND the venue census carry it (one counter, two censuses)
    expect(buildBackfillCoinCensusSql(NOW)).toContain(SQL_ATTEMPT_NOT_EXOGENOUS);
    expect(buildBackfillVenueCensusSql(NOW)).toContain(SQL_ATTEMPT_NOT_EXOGENOUS);
  });

  it('the column is nullable TEXT with no DEFAULT, in SIGNAL_MIGRATIONS and in migrations/050 (up + down)', () => {
    const src = readFileSync(path.join(REPO, 'src/lib/performance-db.ts'), 'utf8');
    expect(src).toContain(`{ table: 'signals', column: 'backfill_fail_class', type: 'TEXT' }`);
    const up = readFileSync(path.join(REPO, 'migrations/050_signals_backfill_fail_class.sql'), 'utf8');
    expect(up).toContain('ALTER TABLE signals ADD COLUMN IF NOT EXISTS backfill_fail_class TEXT;');
    expect(up).not.toMatch(/backfill_fail_class TEXT[^;]*(NOT NULL|DEFAULT)/);
    const down = readFileSync(path.join(REPO, 'migrations/050_signals_backfill_fail_class.down.sql'), 'utf8');
    expect(down).toContain('ALTER TABLE signals DROP COLUMN IF EXISTS backfill_fail_class;');
  });
});

describe('AC1 — every attempt site writes its class', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.recorded.length = 0;
    h.filled.length = 0;
  });

  it('the cron main(): seam + in-band closure ⇒ venue_closed · other throw ⇒ error · no candles · unevaluable', async () => {
    h.queue.push([
      sig(1, 'NCSKSEAM2USD', 'BINGX'), sig(2, 'NCSKBAND2USD', 'BINGX'), sig(3, 'BOOM', 'BINGX'),
      sig(4, 'EMPTY', 'HL'), sig(5, 'BAD', 'HL'), sig(6, 'GOOD', 'HL'),
    ]);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      let done = false;
      const run = main().finally(() => { done = true; });
      for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(5_000);
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(Object.fromEntries(h.recorded)).toEqual({
      1: 'venue_closed', 2: 'venue_closed', 3: 'error', 4: 'no_candles', 5: 'unevaluable',
    });
    expect(h.recorded).toHaveLength(5); // one attempt per failed row, none for the fill
    expect(h.filled).toEqual([6]);
  });

  it('the lazy runBackfill(): no candles · unevaluable; its catch still records nothing', async () => {
    h.queue.push([sig(11, 'EMPTY', 'HL'), sig(12, 'BAD', 'HL'), sig(13, 'NCSKSEAM2USD', 'BINGX')]);
    await runBackfill();
    expect(h.recorded).toEqual([[11, 'no_candles'], [12, 'unevaluable']]);
  });

  describe.skipIf(!!process.env.DATABASE_URL)('the real UPDATE on the real SQLite backend', () => {
    it('writes each class with the attempt; the column exists because SIGNAL_MIGRATIONS added it', async () => {
      const real = await vi.importActual<typeof import('../../src/lib/performance-db.js')>('../../src/lib/performance-db.js');
      real.dbRun(
        'INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'ZZW2', 'BUY', 70, '1h', 'BINGX', 1, NOW - 2 * DAY,
      );
      const [{ id }] = await real.dbQuery<{ id: number }>(`SELECT id FROM signals WHERE coin = 'ZZW2'`);
      const read = async () => (await real.dbQuery<Record<string, unknown>>(
        'SELECT outcome_attempts, outcome_last_attempt_at, backfill_fail_class FROM signals WHERE id = ?', [id]))[0];
      expect((await read()).backfill_fail_class).toBeNull();
      let n = 0;
      for (const c of BACKFILL_FAIL_CLASSES) {
        await real.recordBackfillAttempt(id, c, NOW + ++n);
        expect(await read()).toEqual({ outcome_attempts: n, outcome_last_attempt_at: NOW + n, backfill_fail_class: c });
      }
    });
  });
});

// ── AC2 — the census on the real engine ───────────────────────────────────────────────────────────────

interface Cell { venue: string; coin: string; classes: Array<string | null> }
// Every row: 1h, created 2 d before NOW (matured inside the 7 d window), pending, attempted 1 h before NOW.
const CELLS: Cell[] = [
  { venue: 'BINGX', coin: 'NCSKRIG2USD', classes: Array(5).fill('venue_closed') },  // the page: closure only
  { venue: 'BINGX', coin: 'NCSKMIX2USD', classes: ['venue_closed', 'venue_closed', 'venue_closed', 'no_candles', 'error'] },
  { venue: 'BINGX', coin: 'ERRCOIN', classes: Array(5).fill('error') },
  { venue: 'HL', coin: 'LEGACY', classes: Array(5).fill(null) },                 // attempted before W2
];
const SCHEMA = `CREATE TABLE signals (
  id INTEGER PRIMARY KEY, coin TEXT NOT NULL, signal TEXT NOT NULL DEFAULT 'BUY',
  confidence INTEGER NOT NULL DEFAULT 70, timeframe TEXT NOT NULL, exchange TEXT NOT NULL DEFAULT 'HL',
  price_at_signal REAL NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, outcome_price REAL,
  outcome_attempts INTEGER, outcome_last_attempt_at INTEGER, outcome_filled_at INTEGER,
  backfill_fail_class TEXT, pfe_return_pct REAL, mae_return_pct REAL)`;

describe('AC2 — real engine (better-sqlite3): the census counts our failures, not the venue’s pauses', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;
  const rows = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
  const WITH = buildBackfillCoinCensusSql(NOW);
  const BROKEN = WITH.replaceAll(` AND ${SQL_ATTEMPT_NOT_EXOGENOUS}`, ''); // the deliberate break: filter removed
  const byCell = (sql: string) => Object.fromEntries(rows(sql).map((r) => [`${r.venue}|${r.coin}`, Number(r.attempted_7d)]));

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    db = new Database(':memory:');
    db.exec(SCHEMA);
    const ins = db.prepare(
      'INSERT INTO signals (coin, timeframe, exchange, created_at, outcome_attempts, outcome_last_attempt_at, backfill_fail_class)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of CELLS) for (const cls of c.classes) ins.run(c.coin, '1h', c.venue, NOW - 2 * DAY, 3, NOW - 3600, cls);
  });
  afterAll(() => db?.close());

  it('attempted_7d: closure-only 0 · mixed 2 · error 5 · NULL class 5', () => {
    expect(BROKEN).not.toBe(WITH); // the break really removed something
    expect(byCell(WITH)).toEqual({
      'BINGX|NCSKRIG2USD': 0, 'BINGX|NCSKMIX2USD': 2, 'BINGX|ERRCOIN': 5, 'HL|LEGACY': 5,
    });
    expect(byCell(BROKEN)).toEqual({
      'BINGX|NCSKRIG2USD': 5, 'BINGX|NCSKMIX2USD': 5, 'BINGX|ERRCOIN': 5, 'HL|LEGACY': 5,
    });
  });

  it('the venue census (arm 3d) shares the counter: BINGX attempted_24h excludes its closures', () => {
    const v = Object.fromEntries(rows(buildBackfillVenueCensusSql(NOW)).map((r) => [String(r.venue), Number(r.attempted_24h)]));
    expect(v).toEqual({ BINGX: 7, HL: 5 }); // BINGX: 2 mixed + 5 error; the 8 closures are not ours
  });

  it('the canary’s OWN candidacy rule: the closure cell is no arm-3e candidate — until the filter is removed',
    { timeout: 120_000 }, () => {
      // psql -tA -F'|' renders the census exactly like this; the canary parses it with its real parser.
      const render = (sql: string) => 'SET\n' + rows(sql).map((r) => Object.values(r).map(String).join('|')).join('\n');
      const prog = [
        'import importlib.util, json, sys',
        `s = importlib.util.spec_from_file_location("obf", ${JSON.stringify(CANARY)})`,
        'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
        'd = json.load(sys.stdin)',
        'pick = lambda out: sorted("%s|%s" % (c["venue"], c["coin"]) for c in m.coin_candidates(m.parse_coin_rows(out)))',
        'print(json.dumps({"with": pick(d["with"]), "broken": pick(d["broken"])}))',
      ].join('\n');
      const r = spawnSync('python3', ['-B', '-c', prog], {
        input: JSON.stringify({ with: render(WITH), broken: render(BROKEN) }), encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      // A real failure among closures still pages; a pre-W2 row still counts.
      expect(out.with).toEqual(['BINGX|ERRCOIN', 'BINGX|NCSKMIX2USD', 'HL|LEGACY']);
      expect(out.broken).toEqual(['BINGX|ERRCOIN', 'BINGX|NCSKMIX2USD', 'BINGX|NCSKRIG2USD', 'HL|LEGACY']);
    });
});
