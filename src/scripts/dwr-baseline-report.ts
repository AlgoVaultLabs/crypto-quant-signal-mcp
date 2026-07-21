#!/usr/bin/env tsx
/**
 * dwr-baseline-report.ts — EDGE-DWR-METRIC-SOT-W1 (R5).
 *
 * Honest Directional Win Rate baseline for the CURRENT engine. Reads directional_labels
 * (INTERNAL), builds the timeframe × tier × confidence-bin × regime family, and emits a
 * machine-readable JSON blob to stdout (the human .md is rendered from it). READ-ONLY.
 *
 *   node dist/scripts/dwr-baseline-report.js > /tmp/dwr-baseline.json
 */

import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { benjaminiHochberg, bonferroni } from './edge-stats.js';
import { computeCellStats, ptOverRows, type LabelRow, type Side } from './dwr-baseline.js';

const SPECS = ['tau1.0-floor0.30-v1', 'tau0.5-floor0.30-v1', 'tau2.0-floor0.30-v1'];
const PRIMARY = 'tau1.0-floor0.30-v1';
const POWERED_FLOOR = 50; // n≥50 decided calls
const Q = 0.05;

interface RawRow {
  timeframe: string; tier: string; conf_bin: string; regime: string;
  side: Side; coin: string; created_at: number; label: number; ambiguous_candle: boolean;
}

async function loadRows(spec: string): Promise<Map<string, LabelRow[]>> {
  const raw = await dbQuery<RawRow>(
    `SELECT s.timeframe,
       CASE WHEN s.coin IN ('BTC','ETH') THEN 'T1' ELSE 'rest' END AS tier,
       CASE WHEN s.confidence<60 THEN 'c52_59' WHEN s.confidence<75 THEN 'c60_74' ELSE 'c75_100' END AS conf_bin,
       coalesce(s.regime,'none') AS regime,
       s.signal AS side, s.coin, s.created_at, dl.label, dl.ambiguous_candle
     FROM directional_labels dl JOIN signals s ON s.id = dl.signal_id
     WHERE dl.barrier_spec = $1 AND dl.low_vol_history = FALSE`,
    [spec],
  );
  const cells = new Map<string, LabelRow[]>();
  for (const r of raw) {
    const key = `${r.timeframe}|${r.tier}|${r.conf_bin}|${r.regime}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push({
      side: r.side, label: r.label, ambiguous: r.ambiguous_candle, coin: r.coin, createdAt: r.created_at,
    });
  }
  return cells;
}

/** Walk-forward: 70% calendar-train / 30% holdout; survives iff same edge sign + PT p<0.05 in holdout. */
function walkForward(rows: LabelRow[], fullEdge: number): { holdoutN: number; holdoutP: number | null; holdoutSameSign: boolean; survives: boolean } {
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const cut = Math.floor(sorted.length * 0.7);
  const holdout = sorted.slice(cut);
  const hoStats = computeCellStats(holdout);
  const pt = ptOverRows(holdout);
  const sameSign = Math.sign(hoStats.edge) === Math.sign(fullEdge) && fullEdge !== 0;
  const survives = sameSign && pt.p != null && pt.p < 0.05;
  return { holdoutN: hoStats.decided, holdoutP: pt.p, holdoutSameSign: sameSign, survives };
}

async function reportForSpec(spec: string) {
  const cells = await loadRows(spec);
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
    const wf = fdrReject ? walkForward(c.rows, c.stats.edge) : null;
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
      fdrReject, bonferroni: bonfReject,
      walkForward: wf,
      validated: !!wf?.survives,
    };
  }).sort((a, b) => b.edge - a.edge);

  const validated = cellsOut.filter((c) => c.validated).length;
  return {
    spec,
    familySize: all.length,
    poweredCells: powered.length,
    testableCells: testable.length,
    constantSideCells: powered.filter((c) => c.stats.constantSide).length,
    rawPass, fdrPass: fdr.rejected.filter(Boolean).length, bonferroniPass: bonf.filter(Boolean).length,
    validated,
    verdict: validated > 0 ? 'EDGE-FOUND' : 'NO-VALIDATED-EDGE',
    medianDwr: round(median(powered.map((c) => c.stats.dwr))),
    medianEdge: round(median(powered.map((c) => c.stats.edge))),
    cells: cellsOut,
  };
}

function round(x: number, dp = 4): number { return Number.isFinite(x) ? Number(x.toFixed(dp)) : NaN; }
function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

async function main() {
  const [eligibleRow] = await dbQuery<{ eligible: number }>(
    `SELECT count(*)::int AS eligible FROM signals WHERE signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL AND timeframe <> '1m'`,
  );
  const coverage: Record<string, unknown> = { eligible: eligibleRow?.eligible ?? null };
  for (const spec of SPECS) {
    const [c] = await dbQuery<{ labeled: number; lowvol: number }>(
      `SELECT count(DISTINCT signal_id)::int AS labeled,
              count(*) FILTER (WHERE low_vol_history)::int AS lowvol
       FROM directional_labels WHERE barrier_spec = $1`, [spec],
    );
    coverage[spec] = { labeledSignals: c?.labeled ?? 0, lowVolRows: c?.lowvol ?? 0,
      pctOfEligible: eligibleRow?.eligible ? round((c?.labeled ?? 0) / eligibleRow.eligible, 4) : null };
  }

  const ambiguityByTf = await dbQuery<{ timeframe: string; n: number; amb: number }>(
    `SELECT s.timeframe, count(*)::int AS n, sum(dl.ambiguous_candle::int)::int AS amb
     FROM directional_labels dl JOIN signals s ON s.id = dl.signal_id
     WHERE dl.barrier_spec = $1 GROUP BY s.timeframe ORDER BY s.timeframe`, [PRIMARY],
  );

  const specReports = [];
  for (const spec of SPECS) specReports.push(await reportForSpec(spec));

  const out = {
    wave: 'EDGE-DWR-METRIC-SOT-W1',
    primarySpec: PRIMARY,
    poweredFloor: POWERED_FLOOR,
    q: Q,
    coverage,
    ambiguityByTimeframe: ambiguityByTf.map((r) => ({ timeframe: r.timeframe, n: r.n, ambiguous: r.amb,
      rate: r.n > 0 ? round(r.amb / r.n, 4) : 0, flagRefinement: r.n > 0 && (r.amb / r.n) > 0.1 && (r.timeframe === '3m' || r.timeframe === '5m') })),
    specs: specReports,
    comparisonNote: 'CRYPTO-EDGE-METRIC-W1 close-to-close: 130 powered cells, 0 survived FDR/Bonferroni/walk-forward. DWR re-answers the same family under the symmetric triple-barrier metric.',
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  void runScript('dwr-baseline-report', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
