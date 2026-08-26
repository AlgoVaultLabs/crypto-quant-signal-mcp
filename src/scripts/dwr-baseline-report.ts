#!/usr/bin/env tsx
/**
 * dwr-baseline-report.ts — EDGE-DWR-METRIC-SOT-W1 (R5); refreshed by EDGE-DWR-REFRESH-W1 (R2).
 *
 * Honest Directional Win Rate baseline for the CURRENT engine. Reads directional_labels
 * (INTERNAL), builds the timeframe × tier × confidence-bin × regime family, and emits a
 * machine-readable JSON blob to stdout (the human .md is rendered from it). READ-ONLY.
 *
 *   node dist/scripts/dwr-baseline-report.js > /tmp/dwr-baseline.json
 *   node dist/scripts/dwr-baseline-report.js --signals-before=2026-07-05   # healing-only re-run
 *
 * ── EDGE-DWR-REFRESH-W1 R2: what was added, and what was deliberately NOT ───────────────
 *
 * ADDED: `byVenue` + `byTimeframe` rollups, a pooled `aggregate`, `coverageByVenue`, and two
 * optional corpus-window bounds. All of it is DESCRIPTIVE PROJECTION: every figure comes from
 * the same `computeCellStats()` the family cells use, so there is exactly one derivation of DWR
 * / benchmark / edge / Wilson / PT in this repo (`dwr-baseline.ts` → `edge-stats.ts`).
 *
 * NOT ADDED — and this is the load-bearing half: the rollups are **NOT members of the
 * multiple-testing family.** `SPECS`, `POWERED_FLOOR`, `Q`, the cell key, and the
 * BH-FDR/Bonferroni/walk-forward set are untouched, and the rollups carry no `fdrReject` /
 * `validated` field at all. Feeding 17 venue rows + 10 timeframe rows into BH-FDR would enlarge
 * the family and move the bar — a metric redefinition wearing a reporting change's clothes.
 * A venue rollup pools ~10 timeframes and both tiers, so it is a coverage-and-mix diagnostic,
 * never evidence of edge: an aggregate can sit flat while every component moves.
 *
 * ── Why the window bounds exist ────────────────────────────────────────────────────────
 *
 * The corpus grew two ways at once since the last baseline: ~7 weeks of ACCRUAL, and a BACKFILL
 * that healed 7 venues whose labels were silently missing. A single delta cannot separate them.
 * `--signals-before` re-runs on the signal population the previous baseline could already see,
 * so the backfill's contribution is measured with accrual held out. `--labels-before` bounds by
 * label write time (`computed_at` is a FIRST-write stamp — the labeler is
 * `ON CONFLICT DO NOTHING`, so it never moves) to reconstruct what a given run actually read.
 *
 * ── EDGE-DWR-VALIDATED-PREDICATE-W1: the bar moved, and only the bar ──────────────────────
 *
 * `validated` is no longer computed here. It is `validityVerdict()` in `edge-stats.ts` — the ONE
 * definition — and this file supplies its inputs and records its `rejectReason`. The metric
 * itself is untouched: DWR, the benchmark, the barrier rule and the cell key are byte-identical.
 * Only the VALIDITY predicate changed, and every change is an ADDED conjunct, so no cell can
 * gain validation under it.
 *
 * Two live false positives motivated it, both measured 2026-08-26 at τ=0.5: a cell losing
 * 5,124 of 10,377 races certified because the old bar had no CI-separation, magnitude or cost
 * condition; and a cell with a NEGATIVE edge in BOTH the full sample and the holdout certified
 * because "same holdout sign" is satisfied by two negatives. See `edge-stats.ts`.
 *
 * `barrier_pct` is now SELECTed — the one new column — because the magnitude conditions are
 * expressed in return space and a symmetric barrier race pays ±barrier_pct on a decided outcome.
 */

import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import {
  benjaminiHochberg, bonferroni, validityVerdict,
  VALIDITY_PREDICATE_VERSION, VALIDITY_POWERED_FLOOR, type ValidityReject,
} from './edge-stats.js';
import { computeCellStats, medianOf, ptOverRows, type LabelRow, type Side } from './dwr-baseline.js';
import { ROUND_TRIP_COST_PCT } from './directional-labeler.js';

const SPECS = ['tau1.0-floor0.30-v1', 'tau0.5-floor0.30-v1', 'tau2.0-floor0.30-v1'];
const PRIMARY = 'tau1.0-floor0.30-v1';
/** Imported, never re-declared: the powered floor is part of the BAR, and the bar has one home
 *  (`edge-stats.ts`). A second literal here is how two definitions of `validated` started. */
const POWERED_FLOOR = VALIDITY_POWERED_FLOOR;
const Q = 0.05;

/**
 * Provenance of the artifact this report is compared against, recorded in code because it was
 * mis-cited once already. `audits/dwr-baseline-2026-07-03.json` carries the FILENAME date of its
 * first run (395aa81, "0/61 FDR @ 11.4% coverage") but its CONTENT is the close-out refresh
 * committed 2026-07-05 (020d5f4, 104 powered cells / median edge -0.0385 / 78.19% coverage).
 * Cross-checked against the DB: its `labeledSignals` 247,771 sits between the 2026-07-05 and
 * 2026-07-06 `computed_at` cutoffs (238,777 / 248,139), and its `eligible` 316,881 between the
 * same cutoffs on `signals.created_at`. Anchor comparisons at 2026-07-05, never the filename.
 */
const PRIOR_BASELINE = {
  artifact: 'audits/dwr-baseline-2026-07-03.json',
  filenameDate: '2026-07-03',
  actualAsOf: '2026-07-05',
  refreshCommit: '020d5f4',
} as const;

export interface ReportOptions {
  /** Exclusive upper bound on `signals.created_at`, `YYYY-MM-DD` or full ISO-8601 UTC. */
  signalsBefore?: string;
  /** Exclusive upper bound on `directional_labels.computed_at`, same formats. */
  labelsBefore?: string;
}

/**
 * ISO date/datetime -> unix seconds, or null when absent. Validated STRICTLY: the value is
 * interpolated into SQL as an integer (a nullable `$n::timestamptz` placeholder would need a
 * cast on every branch), so the regex is what keeps it an integer and not a string.
 * EXPORTED for the unit test — it is the only parsing in this file.
 */
export function epochBound(iso: string | undefined, label: string): number | null {
  if (iso == null || iso === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?$/.test(iso)) {
    throw new Error(`${label}: expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]Z, got ${JSON.stringify(iso)}`);
  }
  const ms = Date.parse(iso.includes('T') ? (iso.endsWith('Z') ? iso : `${iso}Z`) : `${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`${label}: unparseable date ${JSON.stringify(iso)}`);
  return Math.floor(ms / 1000);
}

interface RawRow {
  timeframe: string; tier: string; conf_bin: string; regime: string;
  side: Side; coin: string; created_at: number; label: number; ambiguous_candle: boolean;
  barrier_pct: number; venue: string;
}

/** A label row that also remembers the two dimensions the family key averages over. */
export type DimRow = LabelRow & { venue: string; timeframe: string };

interface LoadedSpec {
  /** The multiple-testing family: timeframe|tier|conf_bin|regime -> rows. UNCHANGED. */
  cells: Map<string, LabelRow[]>;
  /** The same rows, flat, carrying venue + timeframe for the descriptive rollups. */
  rows: DimRow[];
}

/** SQL fragment for the optional corpus window. Integers only — see `epochBound`. */
function windowSql(sigBefore: number | null, labBefore: number | null): string {
  let sql = '';
  if (sigBefore != null) sql += `\n       AND s.created_at < ${sigBefore}`;
  if (labBefore != null) sql += `\n       AND dl.computed_at < to_timestamp(${labBefore})`;
  return sql;
}

async function loadRows(spec: string, sigBefore: number | null, labBefore: number | null): Promise<LoadedSpec> {
  const raw = await dbQuery<RawRow>(
    `SELECT s.timeframe,
       CASE WHEN s.coin IN ('BTC','ETH') THEN 'T1' ELSE 'rest' END AS tier,
       CASE WHEN s.confidence<60 THEN 'c52_59' WHEN s.confidence<75 THEN 'c60_74' ELSE 'c75_100' END AS conf_bin,
       coalesce(s.regime,'none') AS regime,
       s.signal AS side, s.coin, s.created_at, dl.label, dl.ambiguous_candle,
       dl.barrier_pct, s.exchange AS venue
     FROM directional_labels dl JOIN signals s ON s.id = dl.signal_id
     WHERE dl.barrier_spec = $1 AND dl.low_vol_history = FALSE${windowSql(sigBefore, labBefore)}`,
    [spec],
  );
  const cells = new Map<string, LabelRow[]>();
  const rows: DimRow[] = [];
  for (const r of raw) {
    const key = `${r.timeframe}|${r.tier}|${r.conf_bin}|${r.regime}`;
    if (!cells.has(key)) cells.set(key, []);
    const row: DimRow = {
      side: r.side, label: r.label, ambiguous: r.ambiguous_candle, coin: r.coin, createdAt: r.created_at,
      barrierPct: Number(r.barrier_pct), venue: r.venue, timeframe: r.timeframe,
    };
    cells.get(key)!.push(row);
    rows.push(row);
  }
  return { cells, rows };
}

export interface WalkForward {
  holdoutN: number;
  holdoutP: number | null;
  /** The holdout's OWN edge (dwr − benchmark). Reported, not merely its sign — the sign alone is
   *  what let a cell negative on BOTH halves of the split read as "the edge persisted". */
  holdoutEdge: number;
  /** Retained as a DIAGNOSTIC only. It is no longer a validity condition: `validityVerdict`
   *  requires `holdoutEdge > 0`, which this cannot express (two negatives are "the same sign"). */
  holdoutSameSign: boolean;
}

/**
 * Walk-forward: 70% calendar-train / 30% holdout. Computes the holdout's statistics; it does NOT
 * decide validity — `validityVerdict()` owns that, and this function no longer returns a
 * `survives` flag a caller could mistake for the bar.
 *
 * EXPORTED for the unit test: the previous version's defect was unreachable from a test because
 * the function was module-private, so the regression that certified a negative edge could only
 * be found by reading a 300 KB production artifact.
 */
export function walkForward(rows: LabelRow[], fullEdge: number): WalkForward {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const cut = Math.floor(sorted.length * 0.7);
  const holdout = sorted.slice(cut);
  const hoStats = computeCellStats(holdout);
  const pt = ptOverRows(holdout);
  return {
    holdoutN: hoStats.decided,
    holdoutP: pt.p,
    holdoutEdge: hoStats.edge,
    holdoutSameSign: Math.sign(hoStats.edge) === Math.sign(fullEdge) && fullEdge !== 0,
  };
}

/**
 * One descriptive row per group, from the SAME `computeCellStats`. Deliberately carries no
 * `fdrReject` / `validated` — a rollup is not a member of the multiple-testing family.
 * EXPORTED for the unit test (it must prove the grouping PARTITIONS the row set).
 */
export function rollup(rows: DimRow[], dim: 'venue' | 'timeframe') {
  const groups = new Map<string, DimRow[]>();
  for (const r of rows) {
    const k = r[dim];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.entries()].map(([key, gr]) => ({ key, ...describe(gr) }))
    .sort((a, b) => b.n - a.n);
}

/** The descriptive projection of one row set. No statistic is computed here — only selected. */
export function describe(rows: LabelRow[]) {
  const s = computeCellStats(rows);
  return {
    n: s.n, decided: s.decided, wins: s.wins, losses: s.losses, timeouts: s.timeouts,
    dwr: round(s.dwr), timeoutRate: round(s.timeoutRate), ambiguousRate: round(s.ambiguousRate),
    alwaysBuyDwr: round(s.alwaysBuyDwr), alwaysSellDwr: round(s.alwaysSellDwr),
    benchmark: round(s.benchmark), edge: round(s.edge),
    wilsonLo: round(s.wilsonLo), wilsonHi: round(s.wilsonHi),
    ptZ: s.ptAll.z == null ? null : round(s.ptAll.z),
    ptP: s.ptAll.p == null ? null : round(s.ptAll.p, 5),
    ptNa: s.ptAll.na ?? (s.constantSide ? 'PT_NA_CONSTANT_SIDE' : null),
    constantSide: s.constantSide,
    // Descriptive only, like every other field here. A venue's or timeframe's typical barrier
    // width is what decides how large a rate edge must be to clear costs, so it belongs beside
    // the edge it conditions — but it confers no validity, and rollups still carry no `validated`.
    barrierPctMedian: round(s.barrierPctMedian),
  };
}

export type SpecVerdict = 'EDGE-FOUND' | 'NO-VALIDATED-EDGE' | 'INDETERMINATE';

/**
 * The spec-level verdict, as a PURE function of what was actually tested.
 *
 * Vacuity guard, placed where the family is CONSTRUCTED rather than where it is observed:
 * `NO-VALIDATED-EDGE` must mean "a real family was tested and nothing survived". With zero
 * TESTABLE cells — an empty corpus, or one where every powered cell is constant-side so PT is
 * undefined throughout — nothing was tested at all, and reporting that as a clean result is
 * exactly the "one value encodes both verified-clean and verified-nothing" defect the
 * verdict-token law forbids. `INDETERMINATE` reuses the estate's existing vocabulary rather
 * than inventing a parallel one.
 *
 * EXPORTED so the guard is unit-testable without a database — the alternative is a branch that
 * only ever runs against a corpus which, by construction, almost never occurs.
 */
export function specVerdict(testableCells: number, validated: number): { verdict: SpecVerdict; verdictReason: string | null } {
  if (testableCells === 0) return { verdict: 'INDETERMINATE', verdictReason: 'no_powered_cells' };
  return { verdict: validated > 0 ? 'EDGE-FOUND' : 'NO-VALIDATED-EDGE', verdictReason: null };
}

async function reportForSpec(spec: string, sigBefore: number | null, labBefore: number | null) {
  const { cells, rows: allRows } = await loadRows(spec, sigBefore, labBefore);
  const all = [...cells.entries()].map(([key, rows]) => ({ key, stats: computeCellStats(rows), rows }));
  const powered = all.filter((c) => c.stats.decided >= POWERED_FLOOR);

  // BH-FDR across powered cells with a DEFINED PT (constant-side excluded — undefined by design).
  const testable = powered.filter((c) => c.stats.ptAll.p != null);
  const pvals = testable.map((c) => c.stats.ptAll.p as number);
  const fdr = benjaminiHochberg(pvals, Q);
  const bonf = bonferroni(pvals, Q);
  const rawPass = pvals.filter((p) => p < Q).length;

  const cellsOut = powered.map((c) => {
    const ti = testable.indexOf(c);
    const fdrReject = ti >= 0 ? fdr.rejected[ti] : false;
    const bonfReject = ti >= 0 ? bonf[ti] : false;
    // Lazy, as before: the predicate short-circuits at FDR_FAIL long before it reads the
    // holdout, so a non-FDR cell never pays for a walk-forward it cannot use.
    const wf = fdrReject ? walkForward(c.rows, c.stats.edge) : null;
    const v = validityVerdict({
      nDecided: c.stats.decided, wins: c.stats.wins, losses: c.stats.losses,
      benchmark: c.stats.benchmark, wilsonLo: c.stats.wilsonLo,
      ptDefined: c.stats.ptAll.p != null,
      fdrReject,
      holdoutEdge: wf?.holdoutEdge ?? null,
      holdoutP: wf?.holdoutP ?? null,
      barrierPctMedian: c.stats.barrierPctMedian,
      roundTripCostPct: ROUND_TRIP_COST_PCT,
    });
    return {
      key: c.key,
      n: c.stats.n, decided: c.stats.decided, wins: c.stats.wins, losses: c.stats.losses,
      timeouts: c.stats.timeouts,
      dwr: round(c.stats.dwr), timeoutRate: round(c.stats.timeoutRate), ambiguousRate: round(c.stats.ambiguousRate),
      alwaysBuyDwr: round(c.stats.alwaysBuyDwr), alwaysSellDwr: round(c.stats.alwaysSellDwr),
      benchmark: round(c.stats.benchmark), edge: round(c.stats.edge),
      wilsonLo: round(c.stats.wilsonLo), wilsonHi: round(c.stats.wilsonHi),
      ptZ: c.stats.ptAll.z == null ? null : round(c.stats.ptAll.z), ptP: c.stats.ptAll.p == null ? null : round(c.stats.ptAll.p, 5),
      ptNonOverlapZ: c.stats.ptNonOverlap.z == null ? null : round(c.stats.ptNonOverlap.z),
      ptNonOverlapP: c.stats.ptNonOverlap.p == null ? null : round(c.stats.ptNonOverlap.p, 5),
      ptNa: c.stats.ptAll.na ?? (c.stats.constantSide ? 'PT_NA_CONSTANT_SIDE' : null),
      barrierPctMedian: round(c.stats.barrierPctMedian),
      fdrReject, bonferroni: bonfReject,
      walkForward: wf,
      // The two magnitude figures are REPORTED whether or not the cell reached them, so a
      // reader can see how far short a rejected cell fell rather than only that it fell.
      excessReturnPct: round(v.excessReturnPct, 6),
      tradeableReturnPct: round(v.tradeableReturnPct, 6),
      validated: v.validated,
      rejectReason: v.rejectReason as ValidityReject | null,
    };
  }).sort((a, b) => b.edge - a.edge);

  const validated = cellsOut.filter((c) => c.validated).length;

  const { verdict, verdictReason } = specVerdict(testable.length, validated);
  return {
    spec,
    familySize: all.length,
    poweredCells: powered.length,
    testableCells: testable.length,
    constantSideCells: powered.filter((c) => c.stats.constantSide).length,
    rawPass, fdrPass: fdr.rejected.filter(Boolean).length, bonferroniPass: bonf.filter(Boolean).length,
    validated,
    verdict, verdictReason,
    medianDwr: round(medianOf(powered.map((c) => c.stats.dwr))),
    medianEdge: round(medianOf(powered.map((c) => c.stats.edge))),
    // Pooled over EVERY labeled row in the spec (not just powered cells) — the R4 artifact's
    // "aggregate DWR, edge + CI". Descriptive: it mixes timeframes and tiers by construction.
    aggregate: { rowsPooled: allRows.length, ...describe(allRows) },
    byVenue: rollup(allRows, 'venue'),
    byTimeframe: rollup(allRows, 'timeframe'),
    cells: cellsOut,
  };
}

function round(x: number, dp = 4): number { return Number.isFinite(x) ? Number(x.toFixed(dp)) : NaN; }
// `median` was a second copy of the five lines now exported as `medianOf` from dwr-baseline.ts,
// where the per-cell barrier median needs them. One derivation, two callers.

/**
 * The ONE derivation. `main()` prints it; `dwr-baseline-snapshot.ts` persists it. Two consumers,
 * one computation — a second copy would drift to contradiction (single-derivation rule).
 */
export async function buildReport(opts: ReportOptions = {}) {
  const sigBefore = epochBound(opts.signalsBefore, '--signals-before');
  const labBefore = epochBound(opts.labelsBefore, '--labels-before');
  const win = windowSql(sigBefore, labBefore);

  const [eligibleRow] = await dbQuery<{ eligible: number }>(
    `SELECT count(*)::int AS eligible FROM signals
     WHERE signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL AND timeframe <> '1m'
       ${sigBefore != null ? `AND created_at < ${sigBefore}` : ''}`,
  );
  const coverage: Record<string, unknown> = { eligible: eligibleRow?.eligible ?? null };
  for (const spec of SPECS) {
    const [c] = await dbQuery<{ labeled: number; lowvol: number }>(
      `SELECT count(DISTINCT dl.signal_id)::int AS labeled,
              count(*) FILTER (WHERE dl.low_vol_history)::int AS lowvol
       FROM directional_labels dl JOIN signals s ON s.id = dl.signal_id
       WHERE dl.barrier_spec = $1${win}`, [spec],
    );
    coverage[spec] = { labeledSignals: c?.labeled ?? 0, lowVolRows: c?.lowvol ?? 0,
      pctOfEligible: eligibleRow?.eligible ? round((c?.labeled ?? 0) / eligibleRow.eligible, 4) : null };
  }

  // Per-venue coverage: pure counts, so a 3%-covered venue cannot hide behind an 86% aggregate.
  const coverageByVenue = await dbQuery<{ venue: string; eligible: number; labeled: number }>(
    `SELECT e.exchange AS venue, e.eligible::int AS eligible, coalesce(l.labeled,0)::int AS labeled
     FROM (SELECT exchange, count(*) AS eligible FROM signals
           WHERE signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL AND timeframe <> '1m'
             ${sigBefore != null ? `AND created_at < ${sigBefore}` : ''}
           GROUP BY 1) e
     LEFT JOIN (SELECT s.exchange, count(*) AS labeled
                FROM directional_labels dl JOIN signals s ON s.id = dl.signal_id
                WHERE dl.barrier_spec = $1${win} GROUP BY 1) l ON l.exchange = e.exchange
     ORDER BY e.eligible DESC`, [PRIMARY],
  );

  const ambiguityByTf = await dbQuery<{ timeframe: string; n: number; amb: number }>(
    `SELECT s.timeframe, count(*)::int AS n, sum(dl.ambiguous_candle::int)::int AS amb
     FROM directional_labels dl JOIN signals s ON s.id = dl.signal_id
     WHERE dl.barrier_spec = $1${win} GROUP BY s.timeframe ORDER BY s.timeframe`, [PRIMARY],
  );

  const specReports = [];
  for (const spec of SPECS) specReports.push(await reportForSpec(spec, sigBefore, labBefore));

  return {
    wave: 'EDGE-DWR-METRIC-SOT-W1',
    refreshedBy: 'EDGE-DWR-REFRESH-W1',
    // Stamped so a consumer can REFUSE to render a `validated` count computed under an older
    // bar. `dwr_baseline_runs.predicate_version` (migration 033) carries it into the digest.
    predicateVersion: VALIDITY_PREDICATE_VERSION,
    roundTripCostPct: ROUND_TRIP_COST_PCT,
    generatedAt: new Date().toISOString(),
    window: {
      signalsBefore: opts.signalsBefore ?? null,
      labelsBefore: opts.labelsBefore ?? null,
      full: sigBefore == null && labBefore == null,
    },
    priorBaseline: PRIOR_BASELINE,
    primarySpec: PRIMARY,
    poweredFloor: POWERED_FLOOR,
    q: Q,
    coverage,
    coverageByVenue: coverageByVenue.map((r) => ({ venue: r.venue, eligible: r.eligible, labeled: r.labeled,
      pct: r.eligible > 0 ? round(r.labeled / r.eligible, 4) : null })),
    ambiguityByTimeframe: ambiguityByTf.map((r) => ({ timeframe: r.timeframe, n: r.n, ambiguous: r.amb,
      rate: r.n > 0 ? round(r.amb / r.n, 4) : 0, flagRefinement: r.n > 0 && (r.amb / r.n) > 0.1 && (r.timeframe === '3m' || r.timeframe === '5m') })),
    specs: specReports,
    rollupNote: 'byVenue / byTimeframe / aggregate are DESCRIPTIVE projections of the same computeCellStats; they are NOT members of the BH-FDR family and carry no validated flag.',
    predicateNote: 'validated is validityVerdict() in edge-stats.ts: n>=50, PT defined, BH-FDR, W>L, wilsonLo>benchmark, 2*(wilsonLo-benchmark)*barrierPctMedian>roundTripCostPct, 2*(wilsonLo-0.5)*barrierPctMedian>roundTripCostPct, holdout edge>0, holdout PT p<0.05. Every condition is a conjunct ADDED to the pre-2026-08-26 bar, so no cell can gain validation under it. roundTripCostPct is FEES ONLY and excludes spread — see directional-labeler.ts.',
    comparisonNote: 'CRYPTO-EDGE-METRIC-W1 close-to-close: 130 powered cells, 0 survived FDR/Bonferroni/walk-forward. DWR re-answers the same family under the symmetric triple-barrier metric.',
  };
}

/** `--flag=value` only (the shape the cron wrapper passes). EXPORTED for the unit test. */
export function parseArgs(argv: string[]): ReportOptions {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return { signalsBefore: get('signals-before'), labelsBefore: get('labels-before') };
}

async function main() {
  const out = await buildReport(parseArgs(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  void runScript('dwr-baseline-report', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
