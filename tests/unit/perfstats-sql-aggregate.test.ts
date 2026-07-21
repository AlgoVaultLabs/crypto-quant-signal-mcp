// OPS-PERFSTATS-SQL-PUSHDOWN-W1 CH2 — SQL-shape + flag-parse units.
// The FILTER aggregate + executor run on PG only (dual-backend rule), so the
// pure SQL-builder shape + the flag parser are unit-tested here; the actual
// aggregateSignalsSql execution + byte-equivalence is the LIVE e2e gate.
import { describe, it, expect } from 'vitest';
import { buildStatsAggregateSql, _parsePerfStatsPushdownFlag } from '../../src/lib/performance-db.js';

describe('OPS-PERFSTATS-SQL-PUSHDOWN-W1 CH2 — SQL shape + flag', () => {
  const { groupsSql, periodSql, recentSql } = buildStatsAggregateSql();

  it('groups SQL: grouping + win/eval predicates + max_ca/max_id + coalesce; NO time-window/confidence/outcome', () => {
    expect(groupsSql).toMatch(/GROUP BY coalesce\(exchange,\s*'HL'\),\s*coin,\s*timeframe,\s*signal/i);
    // OPS-PFE-METRIC-INTEGRITY-W1 R5 CHANGED THIS PREDICATE — deliberately, and this
    // assertion was flipped with it (exemption + its test are a pair, per CLAUDE.md).
    // `pfe_eval` (the DENOMINATOR) now also excludes S2 frozen-book rows: `pfe = 0 AND
    // mae = 0` means price did not move in EITHER direction, i.e. the market was shut, not
    // that the call was wrong. S1 (`pfe = 0`, `mae != 0`) is a GENUINE loss and stays in.
    expect(groupsSql).toMatch(/count\(\*\)\s+FILTER\s*\(WHERE pfe_return_pct IS NOT NULL AND NOT \(pfe_return_pct = 0 AND mae_return_pct = 0\)\)\s+AS pfe_eval/i);
    // Non-vacuity: the frozen exclusion must appear in BOTH the denominator and the
    // numerator. Applying it to only one silently skews the rate instead of the cohort.
    expect(groupsSql.match(/NOT \(pfe_return_pct = 0 AND mae_return_pct = 0\)/g) ?? []).toHaveLength(2);
    expect(groupsSql).toMatch(/signal\s*=\s*'BUY'\s+AND\s+pfe_return_pct\s*>\s*0/i);             // BUY win
    expect(groupsSql).toMatch(/signal\s*=\s*'SELL'\s+AND\s+pfe_return_pct\s*<\s*0/i);            // SELL win
    expect(groupsSql).toMatch(/max\(created_at\)/i);                                              // Q1 ordering
    expect(groupsSql).toMatch(/max\(id\)/i);
    expect(groupsSql).not.toMatch(/outcome_/);                                                    // PII LAW
    expect(groupsSql).not.toMatch(/confidence/i);                                                 // no confidence filter
    expect(groupsSql).not.toMatch(/FROM signals\s+WHERE/i);                                       // no time-window (only FILTER WHEREs)
  });

  it('period SQL: min/max created_at + count; NO outcome / time-window', () => {
    expect(periodSql).toMatch(/min\(created_at\)/i);
    expect(periodSql).toMatch(/max\(created_at\)/i);
    expect(periodSql).toMatch(/count\(\*\)/i);
    expect(periodSql).not.toMatch(/outcome_/);
    expect(periodSql).not.toMatch(/FROM signals\s+WHERE/i);
  });

  it('recent SQL: deterministic top-20 (created_at DESC, id DESC), LIMIT 20; NO outcome', () => {
    expect(recentSql).toMatch(/ORDER BY created_at DESC,\s*id DESC/i);   // Q2 determinism
    expect(recentSql).toMatch(/LIMIT 20/i);
    expect(recentSql).not.toMatch(/outcome_/);
    expect(recentSql).toMatch(/pfe_return_pct/);  // STATS_COL_PROJECTION (rollup ignores it for recentSignals)
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
