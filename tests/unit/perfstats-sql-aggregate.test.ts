// OPS-PERFSTATS-SQL-PUSHDOWN-W1 CH2 — SQL-shape + flag-parse units.
// The pure SQL-builder shape + the flag parser are unit-tested here; the PG executor
// (aggregateSignalsSql) + byte-equivalence is the LIVE e2e gate. Since
// OPS-DIGEST-EVAL-COVERAGE-W1 the groups SQL is ALSO executed in a real engine (better-sqlite3)
// against aggregateRowsInJs, group for group — see the AC3 test below.
import { describe, it, expect } from 'vitest';
import { aggregateRowsInJs, buildStatsAggregateSql, _parsePerfStatsPushdownFlag, type StatGroupRow } from '../../src/lib/performance-db.js';
import { SQL_PUBLISHED_POPULATION, isPublishedPopulation } from '../../src/lib/published-population.js';
import { SQL_EVALUATED, SQL_PFE_ELIGIBLE, sqlNotDefectWindow } from '../../src/lib/pfe-scoring.js';
import { EVAL_COVERAGE_ROWS, runStatsSqlInSqlite } from '../fixtures/eval-coverage-rows.js';

describe('OPS-PERFSTATS-SQL-PUSHDOWN-W1 CH2 — SQL shape + flag', () => {
  // OPS-RECENT-SIGNALS-VENUE-FILTER-W1: the builder now takes the public venue scope.
  // `null` = unfiltered (admin/oracle); the venue-scoped shape is asserted in its own block below.
  const { groupsSql, periodSql, recentSql } = buildStatsAggregateSql(null);

  it('groups SQL: grouping + win/eval predicates + max_ca/max_id + coalesce; population EXPLICIT, NO time-window/outcome', () => {
    expect(groupsSql).toMatch(/GROUP BY coalesce\(exchange,\s*'HL'\),\s*coin,\s*timeframe,\s*signal/i);
    // OPS-PFE-METRIC-INTEGRITY-W1 R5 CHANGED THIS PREDICATE — deliberately, and this
    // assertion was flipped with it (exemption + its test are a pair, per CLAUDE.md).
    // `pfe_eval` (the DENOMINATOR) now also excludes S2 frozen-book rows: `pfe = 0 AND
    // mae = 0` means price did not move in EITHER direction, i.e. the market was shut, not
    // that the call was wrong. S1 (`pfe = 0`, `mae != 0`) is a GENUINE loss and stays in.
    // OPS-SERVED-CANDLE-TRUTH-W1 CH3 FLIPPED IT AGAIN: the eligibility fragment now also carries the generated
    // scoring-exclusion fragment (PFE_DEFECT_WINDOWS), read from the one producer rather than restated here.
    // OPS-DIGEST-EVAL-COVERAGE-W1 added the HOLD clause isPfeEligible carries (the AC3 real-engine test measured a HOLD
    // group with a result reading pfe_eval 1 here and 0 in aggregateRowsInJs).
    expect(groupsSql).toContain(`count(*) FILTER (WHERE signal <> 'HOLD' AND ${SQL_PFE_ELIGIBLE}) AS pfe_eval`);
    expect(SQL_PFE_ELIGIBLE).toBe(`pfe_return_pct IS NOT NULL AND NOT (pfe_return_pct = 0 AND mae_return_pct = 0) AND ${sqlNotDefectWindow()}`);
    // Non-vacuity: the frozen exclusion and the window fragment must appear in BOTH the denominator and the
    // numerator. Applying either to only one silently skews the rate instead of the cohort.
    expect(groupsSql.match(/NOT \(pfe_return_pct = 0 AND mae_return_pct = 0\)/g) ?? []).toHaveLength(2);
    expect(groupsSql.split(sqlNotDefectWindow()).length - 1).toBe(2);
    expect(groupsSql).toMatch(/signal\s*=\s*'BUY'\s+AND\s+pfe_return_pct\s*>\s*0/i);             // BUY win
    expect(groupsSql).toMatch(/signal\s*=\s*'SELL'\s+AND\s+pfe_return_pct\s*<\s*0/i);            // SELL win
    expect(groupsSql).toMatch(/max\(created_at\)/i);                                              // Q1 ordering
    expect(groupsSql).toMatch(/max\(id\)/i);
    // OPS-DIGEST-EVAL-COVERAGE-W1: "evaluated" (any result) beside "eligible", from the one predicate constant.
    expect(groupsSql).toContain(`count(*) FILTER (WHERE ${SQL_EVALUATED}) AS evaluated_n`);
    expect(SQL_EVALUATED).toBe('pfe_return_pct IS NOT NULL');
    expect(groupsSql).not.toMatch(/outcome_/);                                                    // PII LAW

    // OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R1 — FLIPPED, and the flip IS the wave.
    //
    // These two assertions used to read `not.toMatch(/confidence/i)` and
    // `not.toMatch(/FROM signals\s+WHERE/i)`, pinning the ABSENCE of a confidence predicate as a
    // desired property. It never was one: the population was inherited from `recordSignal`'s
    // write gate and stated nowhere here, so one insert below that gate moved the published win
    // rate silently. The predicate is now REQUIRED, and asserting it positively is what stops a
    // future wave deleting it as dead code (measured: it removes 0 rows today).
    expect(groupsSql).toContain(SQL_PUBLISHED_POPULATION);
    // The no-time-window property the deleted `FROM signals WHERE` assertion was really guarding
    // — Merkle-parity means the full table, never a rolling window. Asserted directly now, so it
    // survives the arrival of a legitimate WHERE clause instead of being collateral damage.
    // OPS-SERVED-CANDLE-TRUTH-W1 CH3: the scoring-exclusion fragment carries created_at bounds by design, inside the
    // win-rate FILTERs only (eligibility, never the population); everything outside it still holds no time bound.
    expect(groupsSql.split(sqlNotDefectWindow()).join('')).not.toMatch(/created_at\s*[<>]=?/i);
    expect(groupsSql.slice(groupsSql.indexOf(' FROM signals'))).not.toMatch(/created_at\s*[<>]=?/i);
  });

  it('period SQL: min/max created_at + count; NO outcome / time-window', () => {
    expect(periodSql).toMatch(/min\(created_at\)/i);
    expect(periodSql).toMatch(/max\(created_at\)/i);
    expect(periodSql).toMatch(/count\(\*\)/i);
    expect(periodSql).not.toMatch(/outcome_/);
    // R1: same flip as groupsSql above — the population is stated, the time-window still is not.
    expect(periodSql).toContain(SQL_PUBLISHED_POPULATION);
    expect(periodSql).not.toMatch(/created_at\s*>=?/i);
  });

  it('recent SQL: deterministic top-20 (created_at DESC, id DESC), LIMIT 20; NO outcome', () => {
    expect(recentSql).toMatch(/ORDER BY created_at DESC,\s*id DESC/i);   // Q2 determinism
    expect(recentSql).toMatch(/LIMIT 20/i);
    expect(recentSql).not.toMatch(/outcome_/);
    expect(recentSql).toMatch(/pfe_return_pct/);  // STATS_COL_PROJECTION (rollup ignores it for recentSignals)
    expect(recentSql).toContain(SQL_PUBLISHED_POPULATION);  // R1: population stated on the row lane too
  });

  // ── OPS-RECENT-SIGNALS-VENUE-FILTER-W1 — the venue predicate lives in the SQL ──
  //
  // It has to. `LIMIT 20` executes in the DATABASE, so a post-query JS filter could never reach
  // a 21st row to backfill with — it could only shrink the window, producing a ticker whose
  // LENGTH leaks how many rows were dropped. And this is the LIVE branch: PERF_STATS_SQL_PUSHDOWN
  // is ON in prod, so a predicate applied only to the in-memory path would be a production no-op.
  it('venue-scoped: recentSql gains a parameterised allow-list; groups/period are UNTOUCHED', () => {
    const scoped = buildStatsAggregateSql(new Set(['BINANCE', 'HL']));
    // R1: the venue predicate is now the SECOND conjunct — the published-population predicate
    // leads. Both are present; only their order changed, and `AND` is asserted explicitly so a
    // future edit cannot silently drop one of the two into an `OR`.
    expect(scoped.recentSql).toMatch(/AND coalesce\(exchange,\s*'HL'\)\s*=\s*ANY\(\?\)/i);
    expect(scoped.recentSql).toContain(SQL_PUBLISHED_POPULATION);
    expect(scoped.recentParams).toEqual([['BINANCE', 'HL']]);
    // Parameterised, never interpolated — no venue id is ever spliced into the SQL text.
    expect(scoped.recentSql).not.toMatch(/BINANCE/);
    // The window is still the deterministic top-20 AFTER the predicate.
    expect(scoped.recentSql).toMatch(/ORDER BY created_at DESC,\s*id DESC/i);
    expect(scoped.recentSql).toMatch(/LIMIT 20/i);
    // AGGREGATES are deliberately unfiltered here — byExchange is filtered downstream by the
    // shared public formatter, so the admin view and /api/performance-shadow keep every venue.
    const bare = buildStatsAggregateSql(null);
    expect(scoped.groupsSql).toBe(bare.groupsSql);
    expect(scoped.periodSql).toBe(bare.periodSql);
  });

  it('venue-scoped: an EMPTY scope is FAIL-CLOSED — it matches nothing, it does not match all', () => {
    // `= ANY('{}')` is false for every row, so a venue-registry fault withholds rows rather
    // than leaking them. Fail-closed BY CONSTRUCTION: there is no branch here to get wrong.
    const empty = buildStatsAggregateSql(new Set());
    expect(empty.recentSql).toMatch(/= ANY\(\?\)/);
    expect(empty.recentParams).toEqual([[]]);
  });

  it('venue-scoped: null means UNFILTERED and emits no predicate at all (admin/oracle)', () => {
    const bare = buildStatsAggregateSql(null);
    expect(bare.recentSql).not.toMatch(/ANY\(/);
    expect(bare.recentParams).toEqual([]);
  });

  // ── OPS-DIGEST-EVAL-COVERAGE-W1 AC3 — the groups SQL, executed ──
  //
  // The shape assertions above prove a fragment is PRESENT; they cannot prove the query COUNTS what aggregateRowsInJs
  // counts. This runs the real groupsSql + periodSql in better-sqlite3 over a fixture holding every pfeExclusionOf
  // class (and HOLD, NULL-exchange and below-population rows), maps each row with the production mapping
  // (statGroupRowOf), and requires every group — evaluated_n included — to equal the JS reference grouping.
  it('real engine: groupsSql over the class fixture equals aggregateRowsInJs, group for group, evaluated_n included', () => {
    const key = (g: StatGroupRow) => `${g.exchange}|${g.coin}|${g.timeframe}|${g.signal}`;
    const sortGroups = (gs: StatGroupRow[]) => [...gs].sort((a, b) => key(a).localeCompare(key(b)));
    const sql = runStatsSqlInSqlite(EVAL_COVERAGE_ROWS, groupsSql, periodSql);
    // The pushdown states the population in SQL; the JS grouping is handed the loader's (already-population) rows.
    const js = aggregateRowsInJs(EVAL_COVERAGE_ROWS.filter(isPublishedPopulation));
    expect(sql.groups.length).toBeGreaterThan(5);
    expect(sortGroups(sql.groups)).toEqual(sortGroups(js.groups));
    expect(sql.period).toEqual(js.period);
    // Non-vacuity: evaluated_n and pfe_eval really differ somewhere, so the equality above compared two quantities.
    expect(sql.groups.some((g) => g.evaluated_n !== g.pfe_eval)).toBe(true);
    expect(sql.groups.reduce((a, g) => a + g.evaluated_n, 0)).toBeGreaterThan(sql.groups.reduce((a, g) => a + g.pfe_eval, 0));
  });

  it('flag parse: default-deny — only "1"/"true" enable', () => {
    expect(_parsePerfStatsPushdownFlag('1')).toBe(true);
    expect(_parsePerfStatsPushdownFlag('true')).toBe(true);
    expect(_parsePerfStatsPushdownFlag(undefined)).toBe(false);
    expect(_parsePerfStatsPushdownFlag('0')).toBe(false);
    expect(_parsePerfStatsPushdownFlag('false')).toBe(false);
    expect(_parsePerfStatsPushdownFlag('yes')).toBe(false);
    expect(_parsePerfStatsPushdownFlag('')).toBe(false);
    expect(_parsePerfStatsPushdownFlag('TRUE')).toBe(false);  // strict
  });
});
