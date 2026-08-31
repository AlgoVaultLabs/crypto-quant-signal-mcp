/**
 * band-population-invariance.test.ts — OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R3.
 *
 * THE GUARD THAT MAKES THE WAVE PERMANENT: the published population must be UNCHANGED by the
 * presence of band rows. The wave's headline gate is that no public number moves by a single
 * basis point, and this is where that stops depending on anyone remembering it.
 *
 * ── TWO ARMS, AND ARM A ALONE WOULD BE VACUOUS ───────────────────────────────────────────────
 *
 * The spec asks for "seed one band row, assert every public figure is byte-identical". Under the
 * sibling-table design that assertion CANNOT FAIL: `band_signals` is a different table, so no
 * `FROM signals` query can reach it whether or not R1's predicates exist. A test that cannot fail
 * is not a gate, and shipping only Arm A would have been exactly the dark-guard shape this
 * estate has recorded four times.
 *
 * So the gate has two arms answering two different questions:
 *
 *   ARM A — ISOLATION. Does the band corpus leak into a published number, or onto a public
 *   surface, by any route? Weak by construction, and worth having precisely because it pins the
 *   structural property (separate table, no Merkle columns, count field admin-only) that the rest
 *   of the design rests on.
 *
 *   ARM B — THE REAL GATE. Seeds a sub-52 row INTO `signals` ITSELF — the exact future-writer
 *   failure mode this wave exists to make impossible — and asserts every public figure is still
 *   byte-identical. This is the only arm that can go RED when an R1 predicate is deleted, and it
 *   has been PROVEN red by deleting one (recorded in the wave audit).
 *
 * ── WHY ARM B IS THE ONE THAT MATTERS ────────────────────────────────────────────────────────
 *
 * R1's predicates remove zero rows today (measured on prod: `min(confidence) = 52`, zero rows
 * below it). A predicate that removes nothing reads to a future maintainer as dead code, and the
 * natural thing to do with dead code is delete it. Arm B is the answer: it constructs the row
 * that makes the predicate bind, so deleting the predicate stops being free.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getPerformanceStats,
  recordBandSignal,
  getBandSignalCounts,
  dbRun,
  dbQuery,
  awaitDbWrites,
  _clearPerformanceStatsCache,
} from '../../src/lib/performance-db.js';
import {
  MIN_TRACKABLE_CONFIDENCE,
  SQL_PUBLISHED_POPULATION,
} from '../../src/lib/published-population.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const uniq = (n: string) => `${n}_${RUN_ID}`;

/** Every figure a public surface renders off `PerformanceStats`, serialised for exact comparison. */
function publicFigures() {
  _clearPerformanceStatsCache();
  const s = getPerformanceStats();
  return JSON.stringify({
    totalCalls: s.totalCalls,
    period: s.period,
    overall: s.overall,
    byCallType: s.byCallType,
    byTimeframe: s.byTimeframe,
    byAsset: s.byAsset,
    byExchange: s.byExchange,
    byTier: s.byTier,
    recentSignals: s.recentSignals,
    methodology: s.methodology,
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * OPS-PG-LANE-BOOTSTRAP-W1 — WHICH ARMS ARE SQLITE-PATH, AND WHY IT IS A DECLARATION RATHER
 * THAN A QUARANTINE.
 *
 * `getPerformanceStats()` opens with `if (isPg) return emptyStats();`. Under DATABASE_URL it is
 * a no-op BY CONSTRUCTION — production reads the async path, and the sync one exists for SQLite
 * dev/test. So on the Postgres lane every `publicFigures()` snapshot is the empty object, and
 * the three byte-identical arms below split into two useless halves: the two "nothing moved"
 * assertions pass because both sides are empty (vacuous), and the two-way half — "a row AT the
 * gate DOES move the figures" — CANNOT pass, ever. That is the deterministic failure the lane
 * has reported on every run since 2026-08-30, and no amount of retrying changes it.
 *
 * Two things follow, and only doing both is honest:
 *
 *   1. The byte-identical arms are marked for the backend they were written against. A snapshot
 *      comparison of GLOBAL figures is additionally unsafe on this lane even in principle: all
 *      twelve vitest workers share ONE database, and other suites write `signals` between the
 *      `before` and the `after`. "Make them run on PG" would trade a deterministic red for a
 *      flaky one.
 *   2. The PG branch does NOT lose coverage — see the block at the bottom of this file. It seeds
 *      the same two rows and asserts the same rule directly against `SQL_PUBLISHED_POPULATION`
 *      on whichever engine is under test, scoped to a unique coin so twelve concurrent workers
 *      cannot perturb it. On Postgres that is STRICTLY MORE than the arms it stands in for,
 *      because it executes the predicate production actually runs instead of a comparison of two
 *      empty objects.
 *
 * A `skipIf` that names its backend and ships a replacement arm is not the baseline row this
 * file refused to become.
 */
const ON_POSTGRES = !!process.env.DATABASE_URL;
const itSqlitePath = it.skipIf(ON_POSTGRES);


// OPS-SCORER-INPUT-PERSISTENCE-W1 R1a: `recordBandSignal` gained a REQUIRED trailing `parts`.
// Required rather than optional on purpose — capture is forward-only, so a caller that silently
// omits the parts loses them permanently, and only the compiler can prevent that. Note it did
// NOT prevent it HERE: `tsconfig.json` excludes `tests/`, so this call site was caught at
// runtime by this suite rather than at typecheck. That is the suite doing its job, and it is
// why the fixture below is a REAL parts vector rather than a cast — a degenerate one would let
// a future writer bug through.
//
// Internally consistent by construction: 40*0.30 + 0 + 0 + 20*0.15 + 10*0.20 = 17, no
// adjustments, so raw_final == raw0 and both identities hold. The arithmetic-identity canary
// reads live rows, and a fixture that violated the identity would make the corpus it samples
// look broken.
const PARTS = {
  rsiScore: 40, emaScore: 0, fundingScore: 0, oiScore: 20, volumeScore: 10,
  raw0: 17, fundingDelta: 0, hurstDelta: 0, squeezeDelta: 0, rawFinal: 17,
  fundingAdjustCode: 0, hurstAdjustCode: 0, squeezeAdjustCode: 0,
};

describe('R3 ARM A — the band corpus is ISOLATED from every published number', () => {
  const coin = uniq('BAND_ARM_A');

  beforeEach(() => { _clearPerformanceStatsCache(); });
  // `dbRun` is fire-and-forget on Postgres, so an un-drained DELETE can outlive the test that
  // issued it and bleed into the next one. Draining is a no-op on SQLite.
  afterEach(async () => {
    dbRun('DELETE FROM band_signals WHERE coin = ?', coin);
    await awaitDbWrites();
  });

  itSqlitePath('seeding band_signals moves NO public figure', () => {
    const before = publicFigures();
    // A real band row: below the gate, directional, fully populated — not a degenerate fixture.
    recordBandSignal(coin, 'BUY', 47, '5m', 100, 'HL', 'TRENDING_UP', 'request', false, PARTS);
    const after = publicFigures();
    expect(after).toBe(before);
  });

  it('the seeded row really landed — the arm above is not passing on an empty corpus', async () => {
    // VACUITY GUARD, and it belongs here because THIS test constructs the corpus. If the insert
    // silently failed, the byte-identical assertion above would pass for the wrong reason and the
    // arm would be decorative forever.
    recordBandSignal(coin, 'SELL', 30, '1h', 200, 'BINANCE', null, 'fleet', true, PARTS);
    // OPS-PG-LANE-BOOTSTRAP-W1: `recordBandSignal` reaches `dbRun`, which on Postgres RETURNS
    // BEFORE THE STATEMENT IS SENT. On SQLite the row exists when it returns. One signature,
    // two happens-before contracts — so this read was sound on SQLite and a coin flip on the
    // lane, which is exactly what the 1-vs-3 failure counts on an identical SHA were.
    await awaitDbWrites();
    const n = await dbQuery<{ c: number }>('SELECT count(*) AS c FROM band_signals WHERE coin = ?', [coin]);
    expect(Number(n[0].c)).toBeGreaterThan(0);
  });

  it('band_signals carries NO Merkle column — the anchor path cannot select these rows', async () => {
    // The property migration 035 exists to buy, asserted against the LIVE schema rather than the
    // migration text: `getUnbatchedSignals()` selects `WHERE signal_hash IS NOT NULL AND
    // merkle_batch_id IS NULL`, so absence of those columns is what makes on-chain publication of
    // a band row unrepresentable rather than merely forbidden.
    for (const forbidden of ['signal_hash', 'merkle_batch_id', 'merkle_proof']) {
      await expect(
        dbQuery(`SELECT ${forbidden} FROM band_signals LIMIT 1`),
        `band_signals must not carry ${forbidden} — it would re-open the Merkle anchor path`,
      ).rejects.toThrow();
    }
  });

  it('the migration CHECK and the code constant state the same boundary', () => {
    // Two projections of one rule; the migration file is a snapshot artifact and cannot import,
    // so the duplication is PINNED here rather than trusted. Same discipline as
    // published-population.test.ts pinning the predicate against the public disclosure.
    const sql = readFileSync(resolve(__dirname, '../../migrations/035_signal_band_capture.sql'), 'utf8');
    const m = /CHECK \(confidence >= 0 AND confidence < (\d+)\)/.exec(sql);
    expect(m, 'migration 035 no longer states a band boundary').not.toBeNull();
    expect(Number(m![1])).toBe(MIN_TRACKABLE_CONFIDENCE);
  });

  it('the running count is reported, and it is a COUNT of the band corpus only', async () => {
    const counts = await getBandSignalCounts();
    expect(counts.captured).toBeGreaterThanOrEqual(0);
    expect(counts.resolved).toBeLessThanOrEqual(counts.captured);
  });
});

describe('R3 ARM B — a sub-gate row IN `signals` moves no public figure (the real gate)', () => {
  const coin = uniq('BAND_ARM_B');

  beforeEach(() => { _clearPerformanceStatsCache(); });
  afterEach(async () => {
    dbRun('DELETE FROM signals WHERE coin = ?', coin);
    await awaitDbWrites();
  });

  itSqlitePath('a confidence-45 row inserted directly into `signals` changes NOTHING public', () => {
    const before = publicFigures();

    // The future-writer failure mode, constructed. A backfill, a migration, a counterfactual
    // capture wired to the wrong table, or a threshold change — any of them could put this row
    // here, and before R1 it would have moved totalCalls, the period bounds, the PFE win rate and
    // the on-chain anchor with nothing failing anywhere.
    dbRun(
      `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, pfe_return_pct, mae_return_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      coin, 'BUY', 45, '5m', 'HL', 100, nowSec(), 2.5, -0.5,
    );

    const after = publicFigures();
    expect(after).toBe(before);
  });

  it('the sub-gate row really is in `signals` — Arm B is not passing on an empty insert', async () => {
    // The vacuity guard for the arm that can actually fail. Without it, a rejected INSERT would
    // make "nothing changed" true for the wrong reason and the gate would go dark silently.
    dbRun(
      `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      coin, 'SELL', 51, '1h', 'HL', 200, nowSec(),
    );
    await awaitDbWrites();
    const rows = await dbQuery<{ c: number }>(
      'SELECT count(*) AS c FROM signals WHERE coin = ? AND confidence < ?',
      [coin, MIN_TRACKABLE_CONFIDENCE],
    );
    expect(Number(rows[0].c)).toBeGreaterThan(0);
  });

  itSqlitePath('a row AT the gate DOES move the figures — proving the arm above measures something', () => {
    // The two-way half. If a confidence-52 row also changed nothing, Arm B would be measuring an
    // inert harness rather than the predicate, and its green would mean nothing. This is the
    // assertion that says the instrument is live.
    const before = publicFigures();
    dbRun(
      `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, pfe_return_pct, mae_return_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      coin, 'BUY', MIN_TRACKABLE_CONFIDENCE, '5m', 'HL', 100, nowSec(), 2.5, -0.5,
    );
    const after = publicFigures();
    expect(after).not.toBe(before);
  });
});

describe('R3 ARM B (both backends) — the PREDICATE, on whichever engine is under test', () => {
  /**
   * OPS-PG-LANE-BOOTSTRAP-W1 — the arm that replaces the byte-identical pair on Postgres, and
   * that runs on SQLite too so there is no branch-only coverage.
   *
   * Arm B asks "does a sub-gate row move a published figure?" through a global snapshot. That
   * question is unanswerable on a lane where twelve workers share one database and
   * `getPerformanceStats()` is a no-op. So this asks the SAME question one layer down, where the
   * answer is a property of the rows rather than of the process: seed BOTH boundary rows under a
   * unique coin, then evaluate `SQL_PUBLISHED_POPULATION` — the literal predicate every public
   * reader concatenates — and require exactly the at-gate row to survive it.
   *
   * Coin-scoped on purpose: another worker inserting signals mid-test cannot change the answer,
   * which is what makes this safe to run on the shared lane at all. And it is the branch
   * production executes: the SQL predicate, on Postgres, rather than the TypeScript filter.
   */
  const coin = uniq('BAND_PREDICATE');

  afterEach(async () => {
    dbRun('DELETE FROM signals WHERE coin = ?', coin);
    await awaitDbWrites();
  });

  it('excludes the sub-gate row and admits the at-gate row', async () => {
    const insert = (confidence: number) =>
      dbRun(
        `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, pfe_return_pct, mae_return_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        coin, 'BUY', confidence, '5m', 'HL', 100, nowSec(), 2.5, -0.5,
      );
    insert(MIN_TRACKABLE_CONFIDENCE - 7);
    insert(MIN_TRACKABLE_CONFIDENCE);
    await awaitDbWrites();

    // VACUITY GUARD FIRST, and it belongs here because this test CONSTRUCTS the corpus. If the
    // inserts had not landed, "only the at-gate row is published" would be true of an empty
    // table and the arm would be decorative — the precise failure mode that made the two Arm A/B
    // guards go red on the lane rather than silently pass.
    const seeded = await dbQuery<{ c: number }>(
      'SELECT count(*) AS c FROM signals WHERE coin = ?', [coin],
    );
    expect(Number(seeded[0].c), 'both fixture rows must exist or the assertion below is vacuous').toBe(2);

    const published = await dbQuery<{ confidence: number }>(
      `SELECT confidence FROM signals WHERE coin = ? AND ${SQL_PUBLISHED_POPULATION}`, [coin],
    );
    expect(published.map((r) => Number(r.confidence))).toEqual([MIN_TRACKABLE_CONFIDENCE]);
  });
});

describe('R3 ARM A — the band count field never reaches an unauthenticated surface', () => {
  it('the public confidence-bands route emits neither band count field', () => {
    // Asserted by FIELD NAME over the route's response shape in source, not by substring over a
    // serialised body: `band_signals_captured` would substring-match plenty of legitimate text,
    // and a guard that cries wolf once is ignored forever.
    //
    // `/api/confidence-bands-public` is unauthenticated and live (HTTP 200). Its admin sibling
    // `/api/confidence-bands` carries the counts behind `isAdminAuthorized`. Adding a count
    // surface without a test that it stayed off the public route is how the next wave leaks it.
    const src = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');
    const publicRoute = extractRouteBody(src, "app.get('/api/confidence-bands-public'");
    expect(publicRoute).not.toContain('band_signals_captured');
    expect(publicRoute).not.toContain('band_signals_resolved');
    expect(publicRoute).not.toContain('getBandSignalCounts');

    // ...and the ADMIN route does carry them, so this pair cannot pass by the fields simply not
    // existing anywhere.
    const adminRoute = extractRouteBody(src, "app.get('/api/confidence-bands'");
    expect(adminRoute).toContain('band_signals_captured');
    expect(adminRoute).toContain('isAdminAuthorized');
  });
});

describe('R3 — every R1 reader still states the population (the arm ARM B cannot reach)', () => {
  /**
   * WHY THIS BLOCK EXISTS, AND IT IS NOT BELT-AND-BRACES.
   *
   * Arm B runs on the SQLite scan path. Production runs the PG SQL pushdown
   * (`PERF_STATS_SQL_PUSHDOWN=1`). Measured by deliberately breaking this wave's own code:
   *
   *   delete the TS filter in `computeStats` alone  -> Arm B stays GREEN (11/11)
   *   delete the SQL predicate on the scan path alone -> Arm B stays GREEN (11/11)
   *   delete BOTH                                    -> Arm B goes RED
   *
   * So Arm B proves the pair is load-bearing and proves nothing about EITHER half. A future wave
   * deleting only the SQL predicate — on the branch prod actually executes — would ship green.
   * That is the "a hermetic self-test is structurally blind to exactly what its own seam
   * replaces" law, and the prescribed answer is to assert the BYPASSED ARTIFACTS directly.
   *
   * So: every reader R1 touched is named here and checked for the predicate in its own SQL. The
   * list is an ENUMERATION, not a detector — a new public reader is invisible to a grep for
   * readers that already exist, so adding one means adding a row here, and the migration-035
   * header plus `published-population.ts` both say so.
   */
  const READERS: { fn: string; why: string }[] = [
    { fn: 'loadSignalsForStats',            why: '/api/performance-public + MCP resource + get_track_record (scan branch)' },
    { fn: 'getPerformanceStats',            why: 'the same three, sync SQLite branch' },
    // HONEST SCOPE on this row: the check below is per-FUNCTION, and this function builds THREE
    // SQL strings. Measured by deleting each in turn — a function-level check stays green when
    // only `groupsSql` loses its predicate, because `periodSql` and `recentSql` still name it.
    // The per-STRING coverage lives in `tests/unit/perfstats-sql-aggregate.test.ts`, which was
    // verified to go red for each of the three individually. Both suites are load-bearing here;
    // neither alone covers the branch prod actually executes.
    { fn: 'buildStatsAggregateSql',         why: 'the LIVE prod branch — per-string cover in perfstats-sql-aggregate.test.ts' },
    { fn: 'getConfidenceBands',             why: '/api/confidence-bands-public (unauthenticated)' },
    { fn: 'getRecentCallsAsync',            why: '/api/recent-calls — the landing live ticker' },
    { fn: 'getUnbatchedSignals',            why: 'publish-merkle-batch -> Base L2. Irreversible once anchored.' },
    { fn: 'getSignalWithBatch',             why: '/api/verify-signal by id' },
    { fn: 'getSignalByHash',                why: '/api/verify-signal by leaf hash' },
  ];

  const src = stripComments(
    readFileSync(resolve(__dirname, '../../src/lib/performance-db.ts'), 'utf8'),
  );

  for (const { fn, why } of READERS) {
    it(`${fn} states the published population — ${why}`, () => {
      const body = extractFunctionBody(src, fn);
      expect(body, `${fn} no longer exists in performance-db.ts`).not.toBe('');
      expect(
        /SQL_PUBLISHED_POPULATION|sqlPublishedPopulation\(/.test(body),
        `${fn} reaches a public surface and no longer names the published population. ` +
          `Deleting this predicate looks free — it removes zero rows today — and is exactly ` +
          `the change this test exists to refuse.`,
      ).toBe(true);
    });
  }

  it('computeStats filters the input ONCE rather than per-cohort', () => {
    const body = extractFunctionBody(src, 'computeStats');
    expect(body).toContain('rows.filter(isPublishedPopulation)');
  });
});

describe('R3 — the capture seam has a real non-test consumer', () => {
  it('get-trade-call.ts calls recordBandSignalCapture on the emit path', () => {
    // A unit test calling a helper directly cannot prove anything CALLS it. Comments are stripped
    // first: a mention in prose is not an invocation, and this file's own docstrings discuss the
    // seam at length.
    const src = stripComments(
      readFileSync(resolve(__dirname, '../../src/tools/get-trade-call.ts'), 'utf8'),
    );
    expect(src).toContain('recordBandSignalCapture({');
    expect(src).toContain('isBandConfidence(confidence)');
  });

  it('priority is ONE-WAY: the tracked backfill never references the band lane', () => {
    // The band lane reads `isTrackedBackfillInflight()` and yields. Nothing in the tracked
    // evaluator may reach the other way, or the published metric's own evaluator becomes
    // blockable by a counterfactual measurement. Comments stripped — signal-performance.ts
    // documents the asymmetry in prose, and the prose is the most valuable line in the file.
    const tracked = stripComments(
      readFileSync(resolve(__dirname, '../../src/resources/signal-performance.ts'), 'utf8'),
    );
    expect(tracked).not.toContain('band-outcome-lane');
    expect(tracked).not.toContain('runBandOutcomeSweep');
    expect(tracked).not.toContain('bandOutcomeEnabled');

    const lane = stripComments(
      readFileSync(resolve(__dirname, '../../src/lib/band-outcome-lane.ts'), 'utf8'),
    );
    expect(lane).toContain('isTrackedBackfillInflight()');
  });
});

// ── helpers ──

/** Strip line and block comments so a ban-grep cannot false-positive on explanatory prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** A named function's source, from its declaration to the next top-level declaration. */
function extractFunctionBody(src: string, name: string): string {
  const re = new RegExp(`(export )?(async )?function ${name}\\b`);
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index);
  const next = rest.slice(1).search(/\n(export )?(async )?(function|const) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The body of one `app.get(...)` registration, up to the next one. */
function extractRouteBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`route not found in src/index.ts: ${marker}`);
  const rest = src.slice(start + marker.length);
  const next = rest.indexOf('app.get(');
  return rest.slice(0, next === -1 ? rest.length : next);
}

