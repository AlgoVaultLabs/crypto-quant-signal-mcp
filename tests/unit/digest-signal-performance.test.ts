/**
 * OPS-DIGEST-EVAL-COVERAGE-W1 — the digest's 📈 Signal Performance counts.
 *
 * AC1: golden layout, and the refusal (`⚠️ counts inconsistent (T/E/S)`, never a number) on every non-finite or
 *      negative value, including the old-shape `overall` with no `totalWithResult`.
 * AC2: on a fixture holding every `pfeExclusionOf` class, S, X and P equal the matching class counts over non-HOLD
 *      rows on all three `overall` producers (computeStats, the JS rollup and the SQL pushdown executed in a real
 *      engine). A mutant whose `evaluated_n` is built on `SQL_PFE_ELIGIBLE` must FAIL that check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COUNTS_INCONSISTENT_LINE,
  EXCLUDED_LABEL,
  FROZEN_CLASS_NAMED_BY,
  formatSignalPerformance,
  signalPerformanceCounts,
} from '../../src/lib/digest-signal-performance.js';
import {
  PFE_EXCLUSION_CLASS_NAMED_BY,
  SCORING_EXCLUSIONS_RULE,
  SQL_EVALUATED,
  SQL_PFE_ELIGIBLE,
  pfeExclusionOf,
} from '../../src/lib/pfe-scoring.js';
import {
  _computeStatsOracle,
  aggregateRowsInJs,
  buildStatsAggregateSql,
  rollupStats,
  type PeriodRow,
  type StatGroupRow,
} from '../../src/lib/performance-db.js';
import { isPublishedPopulation } from '../../src/lib/published-population.js';
import type { PerformanceStats } from '../../src/types.js';
import { EVAL_COVERAGE_ROWS, runStatsSqlInSqlite } from '../fixtures/eval-coverage-rows.js';

type Overall = PerformanceStats['overall'];

/** Synthetic, shaped like the 2026-10-29 digest: chosen so every separator and the rounding path show. */
const GOLDEN: Overall = { totalCalls: 1_224_635, totalWithResult: 1_216_240, totalEvaluated: 1_135_523, pfeWinRate: 0.9065295916020012 };

describe('AC1 — formatSignalPerformance golden', () => {
  it('renders T, E (E/T %), S · X excluded (labelled), W and P, each projected from ONE aggregate', () => {
    expect(formatSignalPerformance(GOLDEN)).toEqual([
      '• Total trade calls: 1,224,635',
      '• Evaluated: 1,216,240 (99.3%)',
      '• Scored for win rate: 1,135,523 · 80,717 excluded (on a market that did not trade during the evaluation window; priced from an incomplete venue candle window)',
      '• PFE Win Rate: 90.7%',
      '• Pending evaluation: 8,395',
    ]);
  });

  it('P = T − E and X = E − S: a narrower S moves X and leaves P alone (the property the old line lacked)', () => {
    const narrower = { ...GOLDEN, totalEvaluated: GOLDEN.totalEvaluated - 78_402 };
    const before = signalPerformanceCounts(GOLDEN)!;
    const after = signalPerformanceCounts(narrower)!;
    expect(after.pending).toBe(before.pending);
    expect(after.excluded).toBe(before.excluded + 78_402);
  });

  it('E/T is floored: it never reads 100.0 % while a call is pending', () => {
    const out = formatSignalPerformance({ totalCalls: 20_000, totalWithResult: 19_999, totalEvaluated: 19_000, pfeWinRate: 0.9 });
    expect(out[1]).toBe('• Evaluated: 19,999 (99.9%)');
    expect(formatSignalPerformance({ totalCalls: 5, totalWithResult: 5, totalEvaluated: 5, pfeWinRate: 1 })[1]).toBe('• Evaluated: 5 (100.0%)');
  });

  it('an empty population renders zeros, no share and N/A — not the refusal', () => {
    expect(formatSignalPerformance({ totalCalls: 0, totalWithResult: 0, totalEvaluated: 0, pfeWinRate: null })).toEqual([
      '• Total trade calls: 0',
      '• Evaluated: 0 (—)',
      `• Scored for win rate: 0 · 0 excluded (${EXCLUDED_LABEL})`,
      '• PFE Win Rate: N/A',
      '• Pending evaluation: 0',
    ]);
  });

  it('a non-finite win rate renders N/A, never NaN%', () => {
    expect(formatSignalPerformance({ ...GOLDEN, pfeWinRate: Number.NaN })[3]).toBe('• PFE Win Rate: N/A');
  });

  const INCONSISTENT: Array<[string, unknown]> = [
    ['T is NaN', { ...GOLDEN, totalCalls: Number.NaN }],
    ['E is Infinity', { ...GOLDEN, totalWithResult: Number.POSITIVE_INFINITY }],
    ['S is negative', { ...GOLDEN, totalEvaluated: -1 }],
    ['E > T (P < 0)', { ...GOLDEN, totalWithResult: GOLDEN.totalCalls + 1 }],
    ['S > E (X < 0)', { ...GOLDEN, totalEvaluated: GOLDEN.totalWithResult + 1 }],
    ['the old shape: no totalWithResult', { totalCalls: 10, totalEvaluated: 8, pfeWinRate: 0.9 }],
    ['a count left as a string (an uncoerced bigint)', { ...GOLDEN, totalCalls: '1224635' }],
    ['no overall at all', undefined],
  ];
  it.each(INCONSISTENT)('%s → the ⚠️ line and never a number', (_label, overall) => {
    const out = formatSignalPerformance(overall as Overall);
    expect(out).toEqual([COUNTS_INCONSISTENT_LINE]);
    expect(COUNTS_INCONSISTENT_LINE).toBe('• ⚠️ counts inconsistent (T/E/S)');
    expect(out.join('\n')).not.toMatch(/\d/);
  });
});

describe('the "excluded" label is the public rule\'s own words', () => {
  it('names the frozen class and every registry class, each a substring of SCORING_EXCLUSIONS_RULE', () => {
    expect(SCORING_EXCLUSIONS_RULE).toContain(FROZEN_CLASS_NAMED_BY);
    expect(EXCLUDED_LABEL.startsWith(FROZEN_CLASS_NAMED_BY)).toBe(true);
    const classes = Object.values(PFE_EXCLUSION_CLASS_NAMED_BY);
    expect(classes.length).toBeGreaterThan(0);
    for (const words of classes) {
      expect(SCORING_EXCLUSIONS_RULE).toContain(words);
      expect(EXCLUDED_LABEL).toContain(words);
    }
  });
});

// ── AC2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The class counts over the published, non-HOLD rows: what S, X and P must equal. */
const published = EVAL_COVERAGE_ROWS.filter(isPublishedPopulation);
const nonHold = published.filter((r) => r.signal !== 'HOLD');
const classOf = nonHold.map(pfeExclusionOf);
const EXPECTED = {
  scored: classOf.filter((c) => c === null).length,
  excluded: classOf.filter((c) => c === 'frozen' || c === 'defect_window').length,
  pending: classOf.filter((c) => c === 'unevaluated').length,
};

/** Every way `overall` disagrees with the class counts; empty is the only passing answer. */
function classCountMismatches(overall: Overall): string[] {
  const c = signalPerformanceCounts(overall);
  if (!c) return ['counts inconsistent'];
  return (['scored', 'excluded', 'pending'] as const)
    .filter((k) => c[k] !== EXPECTED[k])
    .map((k) => `${k}: ${c[k]} != ${EXPECTED[k]}`);
}

const SQL = buildStatsAggregateSql(null);
const rolledOverall = (g: { groups: StatGroupRow[]; period: PeriodRow }): Overall => rollupStats(g.groups, g.period, null, [], null).overall;

describe('AC2 — S, X and P equal the pfeExclusionOf class counts over non-HOLD rows', () => {
  it('the fixture exercises every class (non-vacuity), and HOLD / below-population rows are present', () => {
    for (const c of [null, 'frozen', 'defect_window', 'unevaluated'] as const) {
      expect(classOf.filter((x) => x === c).length, `class ${c}`).toBeGreaterThan(0);
    }
    expect(published.some((r) => r.signal === 'HOLD' && r.pfe_return_pct != null)).toBe(true);
    expect(EVAL_COVERAGE_ROWS.length).toBeGreaterThan(published.length);
    expect(EXPECTED).toEqual({ scored: 5, excluded: 6, pending: 3 });
  });

  it('computeStats (the oracle and the non-pushdown path)', () => {
    expect(classCountMismatches(_computeStatsOracle([...EVAL_COVERAGE_ROWS], null, null).overall)).toEqual([]);
  });

  it('rollupStats over aggregateRowsInJs', () => {
    expect(classCountMismatches(rolledOverall(aggregateRowsInJs(published)))).toEqual([]);
  });

  it('rollupStats over the real groupsSql, executed in better-sqlite3 (the live pushdown path)', () => {
    expect(classCountMismatches(rolledOverall(runStatsSqlInSqlite(EVAL_COVERAGE_ROWS, SQL.groupsSql, SQL.periodSql)))).toEqual([]);
  });

  it('MUTANT: evaluated_n built on SQL_PFE_ELIGIBLE FAILS the check (the check can fail)', () => {
    const real = `count(*) FILTER (WHERE ${SQL_EVALUATED}) AS evaluated_n`;
    expect(SQL.groupsSql).toContain(real);
    const mutant = SQL.groupsSql.replace(real, `count(*) FILTER (WHERE ${SQL_PFE_ELIGIBLE}) AS evaluated_n`);
    expect(mutant).not.toBe(SQL.groupsSql);
    const bad = classCountMismatches(rolledOverall(runStatsSqlInSqlite(EVAL_COVERAGE_ROWS, mutant, SQL.periodSql)));
    // The mutant is exactly the 10-29 defect: every excluded row reads as pending.
    expect(bad).toEqual([`excluded: 0 != ${EXPECTED.excluded}`, `pending: ${EXPECTED.pending + EXPECTED.excluded} != ${EXPECTED.pending}`]);
  });

  it('MUTANT (JS side): groups whose evaluated_n is the eligible count FAIL too', () => {
    const g = aggregateRowsInJs(published);
    const bad = classCountMismatches(rolledOverall({ ...g, groups: g.groups.map((x) => ({ ...x, evaluated_n: x.pfe_eval })) }));
    expect(bad).not.toEqual([]);
  });
});

describe('the digest CALLS the formatter (a helper test proves nothing about its callers)', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'scripts', 'monitor.ts'), 'utf8');
  const runDigest = src.slice(src.indexOf('async function runDigest('), src.indexOf('function getSystemInfo('));

  it('runDigest renders the block through formatSignalPerformance and does no count arithmetic of its own', () => {
    expect(runDigest.length).toBeGreaterThan(1000);
    expect(runDigest).toContain('...formatSignalPerformance(perfStats.overall)');
    // Judged on code, not prose: the comment explaining the old subtraction names the field it subtracted.
    const code = runDigest.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/totalEvaluated|totalWithResult/);
    expect(code).not.toMatch(/total\s*-\s*evaluated/);
  });

  it('the Infrastructure backlog line says what it counts', () => {
    expect(runDigest).toContain('• Outcome backlog (all rows, incl. not yet due): ${backfillResult.count.toLocaleString()}');
    expect(runDigest).not.toContain('Backfill queue:');
  });
});
