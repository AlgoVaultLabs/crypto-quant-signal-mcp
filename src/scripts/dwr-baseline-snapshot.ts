#!/usr/bin/env tsx
/**
 * dwr-baseline-snapshot.ts — EDGE-DWR-REFRESH-W1 R4.
 *
 * Persists the DWR / Directional-Edge scoreboard into `dwr_baseline_runs`, one row per
 * (calendar month × barrier spec), so the operator digest and any later consumer can READ the
 * baseline instead of recomputing it. This is what makes DWR *tracked* rather than *discovered*.
 *
 *   node dist/scripts/dwr-baseline-snapshot.js              # the monthly job
 *   node dist/scripts/dwr-baseline-snapshot.js --self-test  # hermetic, no DB, no network
 *
 * ── SINGLE DERIVATION ────────────────────────────────────────────────────────────────────
 * Every number written here comes from `buildReport()` in `dwr-baseline-report.ts`, which is the
 * same call `main()` there prints to stdout. There is no second computation of DWR, benchmark,
 * edge, Wilson or PT anywhere in this file — only projection into columns. A writer that
 * re-derived its own aggregates would drift against the report it claims to snapshot.
 *
 * ── VERDICT TOKEN ────────────────────────────────────────────────────────────────────────
 * Exactly one terminal `DWR_SNAPSHOT_VERDICT=PASS|FAIL|INDETERMINATE` line, always. Callers gate
 * on the TOKEN, never the exit code. Mapping: PASS→0, FAIL→1, INDETERMINATE→3 (the token-law
 * default for a new gate — this script deploys no other code for "could not verify").
 *
 * The cron wrapper is where fail-open lives: a non-zero exit lands in the log and pages nobody,
 * matching `ops/cron/carry-tracker-publish.sh`'s declared fail-soft contract. This script itself
 * never launders a failure into PASS.
 *
 * TWO DIFFERENT VERDICTS LIVE HERE AND THEY MUST NOT BE CONFLATED. `DWR_SNAPSHOT_VERDICT` is
 * about the WRITE — did this job persist the month's rows? The `verdict` COLUMN is about the
 * SCIENCE — did any cell clear the validity bar? A spec whose family was empty stores
 * `verdict='INDETERMINATE'` with `verdict_reason='no_powered_cells'` while this job correctly
 * reports `DWR_SNAPSHOT_VERDICT=PASS`, because writing an honest "we tested nothing" IS a
 * successful write. EDGE-DWR-VALIDATED-PREDICATE-W1.
 *
 * ── WHY IT REFUSES A BOUNDED RUN ─────────────────────────────────────────────────────────
 * `dwr-baseline-report.js --signals-before=…` produces a deliberately SMALLER corpus (the
 * healing-only re-run). Writing that into the monthly series would overwrite a full-corpus row
 * with a subset and silently break the series' comparability — the exact class of defect the
 * month key exists to prevent. So a bounded report is refused, loudly, and nothing is written.
 */

import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { buildReport } from './dwr-baseline-report.js';
import { VALIDITY_PREDICATE_VERSION } from './edge-stats.js';

export type SnapshotVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE';

/** One meaning, one exit code, chosen locally. */
export const EXIT_FOR: Record<SnapshotVerdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * Column order is declared ONCE; the SQL and the params array are both generated from it, so a
 * column added to one and forgotten in the other is not expressible.
 */
export const SNAPSHOT_COLUMNS = [
  'run_month', 'spec', 'run_ts', 'window_signals_before',
  'corpus_eligible', 'corpus_labeled', 'coverage_pct',
  'family_size', 'powered_cells', 'testable_cells', 'constant_side_cells',
  'raw_pass', 'fdr_pass', 'bonferroni_pass', 'fdr_survivors', 'verdict', 'verdict_reason',
  'predicate_version',
  'median_dwr', 'median_edge',
  'aggregate_n', 'aggregate_decided', 'aggregate_dwr', 'aggregate_benchmark', 'aggregate_edge',
  'aggregate_dwr_ci_lo', 'aggregate_dwr_ci_hi',
  'by_venue', 'by_timeframe', 'coverage_by_venue',
] as const;

const KEY_COLUMNS = ['run_month', 'spec'];

/**
 * The upsert. EXPORTED and built by a pure function so `--self-test` can assert the SQL's shape:
 * a hermetic self-test is otherwise structurally blind to exactly the string the DB seam replaces.
 */
export function upsertSql(): string {
  const cols = SNAPSHOT_COLUMNS.join(', ');
  const ph = SNAPSHOT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  const upd = SNAPSHOT_COLUMNS.filter((c) => !KEY_COLUMNS.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  return `INSERT INTO dwr_baseline_runs (${cols})
     VALUES (${ph})
     ON CONFLICT (run_month, spec) DO UPDATE SET ${upd}
     RETURNING run_month, spec, run_ts`;
}

/** `YYYY-MM` of an ISO instant. Derived from the report's OWN `generatedAt` so the row's month
 *  and its `run_ts` can never disagree — two clock reads is how a month-boundary run splits. */
export function runMonthOf(generatedAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(generatedAt)) {
    throw new Error(`runMonthOf: expected an ISO instant, got ${JSON.stringify(generatedAt)}`);
  }
  return generatedAt.slice(0, 7);
}

/** NaN / ±Infinity → null. `round()` upstream yields NaN for an empty set, and a stored 'NaN'
 *  float is indistinguishable from a real measurement in every later aggregate. */
function fin(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Minimal structural view of what `buildReport()` returns — projection only, no recomputation. */
export interface SpecSlice {
  spec: string;
  familySize: number; poweredCells: number; testableCells: number; constantSideCells: number;
  rawPass: number; fdrPass: number; bonferroniPass: number; validated: number; verdict: string;
  verdictReason: string | null;
  medianDwr: number; medianEdge: number;
  aggregate: { n: number; decided: number; dwr: number; benchmark: number; edge: number;
    wilsonLo: number; wilsonHi: number };
  byVenue: unknown; byTimeframe: unknown;
}

/**
 * One spec's row, as the ordered params array. PURE — the whole reason `--self-test` can prove
 * anything about the write without a database.
 */
export function projectRow(
  runMonth: string,
  runTs: string,
  windowSignalsBefore: string | null,
  eligible: number,
  labeled: number,
  s: SpecSlice,
  coverageByVenue: unknown,
  predicateVersion: string,
): unknown[] {
  const row: unknown[] = [
    runMonth, s.spec, runTs, windowSignalsBefore,
    eligible, labeled, eligible > 0 ? Number((labeled / eligible).toFixed(4)) : null,
    s.familySize, s.poweredCells, s.testableCells, s.constantSideCells,
    s.rawPass, s.fdrPass, s.bonferroniPass, s.validated, s.verdict, s.verdictReason ?? null,
    predicateVersion,
    fin(s.medianDwr), fin(s.medianEdge),
    s.aggregate.n, s.aggregate.decided, fin(s.aggregate.dwr), fin(s.aggregate.benchmark),
    fin(s.aggregate.edge), fin(s.aggregate.wilsonLo), fin(s.aggregate.wilsonHi),
    JSON.stringify(s.byVenue), JSON.stringify(s.byTimeframe), JSON.stringify(coverageByVenue),
  ];
  if (row.length !== SNAPSHOT_COLUMNS.length) {
    throw new Error(`projectRow: built ${row.length} values for ${SNAPSHOT_COLUMNS.length} columns`);
  }
  return row;
}

function emit(verdict: SnapshotVerdict, detail: string): number {
  console.log(`[dwr-baseline-snapshot] ${detail}`);
  console.log(`DWR_SNAPSHOT_VERDICT=${verdict}`);
  return EXIT_FOR[verdict];
}

async function snapshot(): Promise<number> {
  let report: Awaited<ReturnType<typeof buildReport>>;
  try {
    report = await buildReport();
  } catch (e) {
    // We were handed the corpus and could not read it — indeterminate, never a pass.
    return emit('INDETERMINATE', `buildReport failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!report.window.full) {
    return emit('FAIL', 'refusing to persist a BOUNDED report into the monthly series (see module header)');
  }

  const runMonth = runMonthOf(report.generatedAt);
  const eligible = Number((report.coverage as Record<string, { eligible?: number }> & { eligible?: number }).eligible ?? 0);
  const sql = upsertSql();
  const written: string[] = [];

  for (const s of report.specs as unknown as SpecSlice[]) {
    const cov = (report.coverage as Record<string, { labeledSignals?: number }>)[s.spec];
    const labeled = Number(cov?.labeledSignals ?? 0);
    const params = projectRow(
      runMonth, report.generatedAt, null, eligible, labeled, s, report.coverageByVenue,
      report.predicateVersion,
    );
    const rows = await dbQuery<{ run_month: string; spec: string }>(sql, params);
    // RETURNING + await, deliberately: `dbRun` is fire-and-forget on PG and this process exits
    // immediately after, so an un-awaited write would be dropped while the log said "done".
    if (rows.length !== 1) {
      return emit('INDETERMINATE', `upsert for spec=${s.spec} returned ${rows.length} rows, expected 1`);
    }
    written.push(`${s.spec}: powered=${s.poweredCells} fdr_survivors=${s.validated} verdict=${s.verdict}`);
  }

  if (written.length === 0) {
    // The report is OURS to construct; zero specs means the constructor built nothing.
    return emit('INDETERMINATE', 'report carried zero specs — nothing to persist');
  }

  return emit('PASS', `run_month=${runMonth} rows=${written.length} | ${written.join(' | ')}`);
}

// ── Self-test ────────────────────────────────────────────────────────────────────────────
// Hermetic: no DB, no network. It asserts the artifacts the DB seam BYPASSES (the SQL string and
// the row projection), the token→exit-code MAPPING (not just the tokens), and it reports FAIL
// rather than raising — an assertion that throws aborts the suite instead of printing a verdict.

function slice(over: Partial<SpecSlice> = {}): SpecSlice {
  return {
    spec: 'tau1.0-floor0.30-v1',
    familySize: 178, poweredCells: 104, testableCells: 43, constantSideCells: 59,
    rawPass: 2, fdrPass: 0, bonferroniPass: 0, validated: 0, verdict: 'NO-VALIDATED-EDGE',
    verdictReason: null,
    medianDwr: 0.4785, medianEdge: -0.0385,
    aggregate: { n: 400, decided: 300, dwr: 0.48, benchmark: 0.52, edge: -0.04, wilsonLo: 0.42, wilsonHi: 0.54 },
    byVenue: [{ key: 'BINANCE', n: 100 }], byTimeframe: [{ key: '5m', n: 100 }],
    ...over,
  };
}

const PV = VALIDITY_PREDICATE_VERSION;

function selfTest(): number {
  let fails = 0;
  const check = (name: string, fn: () => boolean) => {
    let ok = false;
    try { ok = fn(); } catch (e) { ok = false; console.log(`  ${name}: threw ${e instanceof Error ? e.message : String(e)}`); }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) fails++;
  };

  // (1) The SQL the seam replaces — shape asserted, since no scenario ever executes it.
  const sql = upsertSql();
  check('sql: upserts on the (run_month, spec) key', () => sql.includes('ON CONFLICT (run_month, spec) DO UPDATE'));
  check('sql: RETURNING present (dbRun is fire-and-forget on PG)', () => /RETURNING\s+run_month, spec, run_ts/.test(sql));
  check('sql: one placeholder per column, none missing', () => {
    const n = SNAPSHOT_COLUMNS.length;
    return sql.includes(`$${n}`) && !sql.includes(`$${n + 1}`);
  });
  check('sql: key columns are never in the UPDATE set', () => !/run_month = EXCLUDED/.test(sql) && !/\bspec = EXCLUDED/.test(sql));

  // (2) The row projection.
  check('projectRow: arity matches the column list', () => projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 1000, 860, slice(), [], PV).length === SNAPSHOT_COLUMNS.length);
  check('projectRow: coverage_pct = labeled/eligible', () => {
    const r = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 1000, 860, slice(), [], PV);
    return r[SNAPSHOT_COLUMNS.indexOf('coverage_pct')] === 0.86;
  });
  check('projectRow: zero eligible → NULL coverage, never a divide artifact', () => {
    const r = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 0, 0, slice(), [], PV);
    return r[SNAPSHOT_COLUMNS.indexOf('coverage_pct')] === null;
  });
  check('projectRow: fdr_survivors carries `validated`, not fdrPass', () => {
    const r = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 10, 5, slice({ validated: 3, fdrPass: 7 }), [], PV);
    return r[SNAPSHOT_COLUMNS.indexOf('fdr_survivors')] === 3 && r[SNAPSHOT_COLUMNS.indexOf('fdr_pass')] === 7;
  });
  check('projectRow: NaN medians land as NULL, not the float NaN', () => {
    const r = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 10, 5, slice({ medianDwr: NaN, medianEdge: NaN }), [], PV);
    return r[SNAPSHOT_COLUMNS.indexOf('median_dwr')] === null && r[SNAPSHOT_COLUMNS.indexOf('median_edge')] === null;
  });
  check('projectRow: predicate_version is stamped from the report, not defaulted', () => {
    const r = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 10, 5, slice(), [], 'v-under-test');
    return r[SNAPSHOT_COLUMNS.indexOf('predicate_version')] === 'v-under-test';
  });
  check('projectRow: verdict_reason carries the vacuity reason, and NULL when there is none', () => {
    const empty = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 10, 5,
      slice({ verdict: 'INDETERMINATE', verdictReason: 'no_powered_cells' }), [], PV);
    const normal = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 10, 5, slice(), [], PV);
    return empty[SNAPSHOT_COLUMNS.indexOf('verdict_reason')] === 'no_powered_cells'
      && normal[SNAPSHOT_COLUMNS.indexOf('verdict_reason')] === null;
  });
  check('projectRow: JSONB columns are serialized strings', () => {
    const r = projectRow('2026-08', '2026-08-24T06:00:00.000Z', null, 10, 5, slice(), [{ venue: 'HL' }], PV);
    return typeof r[SNAPSHOT_COLUMNS.indexOf('by_venue')] === 'string'
      && typeof r[SNAPSHOT_COLUMNS.indexOf('coverage_by_venue')] === 'string';
  });

  // (3) The month key, both directions.
  check('runMonthOf: takes the month from the report clock', () => runMonthOf('2026-08-24T06:41:02.000Z') === '2026-08');
  check('runMonthOf: rejects a non-instant rather than slicing garbage', () => {
    try { runMonthOf('2026-08-24'); return false; } catch { return true; }
  });

  // (4) The token→exit-code MAPPING. Asserting the tokens alone let a re-coded mapping stay green.
  check('mapping: PASS→0, FAIL→1, INDETERMINATE→3', () => EXIT_FOR.PASS === 0 && EXIT_FOR.FAIL === 1 && EXIT_FOR.INDETERMINATE === 3);
  check('mapping: no verdict shares an exit code', () => new Set(Object.values(EXIT_FOR)).size === 3);

  console.log(fails === 0 ? `SELF-TEST: PASS (0 failures)` : `SELF-TEST: FAIL (${fails})`);
  console.log(`DWR_SNAPSHOT_VERDICT=${fails === 0 ? 'PASS' : 'FAIL'}`);
  return fails === 0 ? EXIT_FOR.PASS : EXIT_FOR.FAIL;
}

async function main(): Promise<number> {
  if (process.argv.slice(2).includes('--self-test')) return selfTest();
  return snapshot();
}

if (require.main === module) {
  void runScript('dwr-baseline-snapshot', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
