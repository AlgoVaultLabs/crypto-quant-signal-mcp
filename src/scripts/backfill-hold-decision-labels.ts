#!/usr/bin/env node
/**
 * backfill-hold-decision-labels.ts — OPS-HOLD-DECISION-CAPTURE-W1 R2.
 *
 * Labels COUNTERFACTUAL HOLD decisions: for each captured HOLD, run the published triple-barrier
 * race against the side the engine WOULD have taken (`would_be_side`) had the threshold cleared,
 * entered at the price the caller was actually shown (`price_at_decision`).
 *
 *   node dist/scripts/backfill-hold-decision-labels.js [--check] [--venue X] [--coin Y]
 *        [--timeframe 15m] [--barrier-spec tau1.0-floor0.30-v1] [--per-cell N]
 *        [--max-decisions N] [--lookback-days N] [--time-budget-min N]
 *        [--side buy|sell] [--conf-min N] [--conf-max N]
 *
 * `--side` / `--conf-min` / `--conf-max` (EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R2) narrow the
 * WORK-LIST only, for dedicated band-targeted backfills; default-off, byte-identical SQL when
 * absent, barrier arithmetic untouched.
 *
 * ── THE QUARANTINE IS THE POINT OF THIS FILE BEING A SEPARATE FILE ───────────────────────────
 *
 * These labels are counterfactual: they score trades the engine deliberately did NOT make. They
 * must NEVER enter `directional_labels`, which backs the DWR baseline and, downstream, the
 * published track record. Reusing `backfill-directional-labels.ts` with a flag was the obvious
 * saving and is rejected: one flag between a published corpus and a counterfactual one is a
 * single edit away from contaminating a Merkle-anchored number, and the hazard is SILENT —
 * `request_log.id` and `signals.id` overlap numerically, so a wrong id joins cleanly to an
 * unrelated acted signal with no error at all.
 *
 * What IS shared is the thing that must not drift: the barrier arithmetic itself, imported
 * verbatim from `directional-labeler.ts`. Same τ specs, same σ window, same 0.30% fee floor, same
 * evaluation windows. If those two arms measured differently, the comparison they exist for would
 * be meaningless — so there is exactly one implementation and this file does not own a copy.
 *
 * ── SAMPLED CAPTURE, SAMPLED LABELING — TWO DIFFERENT BUDGETS ────────────────────────────────
 *
 * Capture is already sampled at write time by `uq_hold_decisions_fleet_cell` (one fleet row per
 * cell per UTC day). This script applies a SECOND, independent budget, because the binding cost
 * here is not storage but venue candle fetches: a barrier replay needs ~60 σ-windows of trailing
 * candles plus a full forward window per decision. Bounded per run, checkpoint-resumable via the
 * label table itself, `--check` writes nothing, silent on success.
 */

import { dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { getDexForCoin } from '../lib/asset-tiers.js';
import { runAsBatch, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import type { Candle, ExchangeId } from '../types.js';
import {
  EVAL_CANDLES,
  TF_MS,
  SIGMA_TARGET_WINDOWS,
  computeSigmaW,
  barrierPct,
  runTripleBarrier,
} from './directional-labeler.js';
import { isStopRequested, installGracefulStop } from '../lib/graceful-stop.js';

const DELAY_BETWEEN_FETCHES_MS = 250;
const FETCH_BUFFER_CANDLES = 2;
const MAX_PAGES_PER_RANGE = 500;
const INSERT_CHUNK_ROWS = 1000;

/** Identical to the acted corpus. Divergence here would make the two arms incomparable. */
const ALL_SPECS = [
  { tau: 1.0, spec: 'tau1.0-floor0.30-v1' },
  { tau: 0.5, spec: 'tau0.5-floor0.30-v1' },
  { tau: 2.0, spec: 'tau2.0-floor0.30-v1' },
] as const;

/**
 * Default rows labeled per (venue, coin, timeframe) group per run.
 *
 * DELIBERATELY SMALL, and for the same reason the capture sampler is breadth-first: the
 * pre-registered analysis is powered by distinct (venue, coin) CLUSTERS, not by row count, so
 * budget spent going deep on one coin buys strictly less than the same budget spread wide.
 */
const DEFAULT_PER_CELL = 3;
const DEFAULT_MAX_DECISIONS = 4000;

interface Cli {
  check: boolean;
  specs: { tau: number; spec: string }[];
  venue?: string;
  coin?: string;
  timeframe?: string;
  perCell: number;
  maxDecisions: number;
  lookbackDays?: number;
  timeBudgetMin?: number;
  /** EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R2 — additive, default-off work-list filters.
   *  Worklist SQL only; the barrier arithmetic is untouched by construction (it lives in
   *  directional-labeler.ts). With all three absent the generated SQL + params are
   *  byte-identical to the pre-flag behaviour — pinned by
   *  tests/unit/hold-decision-label-filters.test.ts. */
  side?: 'buy' | 'sell';
  confMin?: number;
  confMax?: number;
}

interface HoldRow {
  decision_id: number;
  decided_at: number;
  coin: string;
  timeframe: string;
  exchange: string;
  would_be_side: number;
  price_at_decision: number;
}

function ts(): string {
  return new Date().toISOString();
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseCli(argv: string[]): Cli {
  const has = (f: string) => argv.includes(f);
  const val = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const posInt = (f: string) => {
    const v = val(f);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${f} must be a positive number`);
    return Math.floor(n);
  };
  const specSel = val('--barrier-spec');
  const specs = specSel ? ALL_SPECS.filter((s) => s.spec === specSel) : [...ALL_SPECS];
  if (specSel && specs.length === 0) throw new Error(`unknown --barrier-spec '${specSel}'`);
  const sideSel = val('--side');
  if (sideSel !== undefined && sideSel !== 'buy' && sideSel !== 'sell') {
    throw new Error(`--side must be 'buy' or 'sell', got '${sideSel}'`);
  }
  const conf = (f: string) => {
    const v = val(f);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${f} must be an integer 0..100`);
    return n;
  };
  const confMin = conf('--conf-min');
  const confMax = conf('--conf-max');
  if (confMin !== undefined && confMax !== undefined && confMin > confMax) {
    throw new Error(`--conf-min (${confMin}) must be <= --conf-max (${confMax})`);
  }
  return {
    check: has('--check'),
    specs,
    venue: val('--venue'),
    coin: val('--coin'),
    timeframe: val('--timeframe'),
    perCell: posInt('--per-cell') ?? DEFAULT_PER_CELL,
    maxDecisions: posInt('--max-decisions') ?? DEFAULT_MAX_DECISIONS,
    lookbackDays: posInt('--lookback-days'),
    timeBudgetMin: posInt('--time-budget-min'),
    side: sideSel,
    confMin,
    confMax,
  };
}

/**
 * The stratified work-list.
 *
 * `would_be_side <> 0` is not an optimisation — a zero score has NO direction, so there is no
 * counterfactual trade to race and a row for it would be a fabricated observation rather than a
 * missing one.
 *
 * A decision is only labelable once its full evaluation window has CLOSED. Labeling early would
 * silently mint timeouts: `runTripleBarrier` returns label 0 when neither barrier is touched, and
 * on a half-covered window that is indistinguishable from a real timeout. The acted labeler
 * handles this with an explicit `forwardAsc.length < W` guard; here it is also excluded in SQL so
 * the budget is never spent fetching candles that cannot yield a label.
 */
export function buildWorklistSql(cli: Cli, nowSec: number): { sql: string; params: unknown[] } {
  const where: string[] = [
    'h.would_be_side <> 0',
    'h.exchange IS NOT NULL',
    "h.timeframe <> '1m'", // retired lane (OPS-1M-SEED-DECOM-W1) — never labeled, either arm
  ];
  const params: unknown[] = [];
  params.push(cli.specs[0].spec);
  where.push(`NOT EXISTS (SELECT 1 FROM hold_decision_labels l
                WHERE l.hold_decision_id = h.decision_id AND l.barrier_spec = $1)`);
  if (cli.venue) { params.push(cli.venue); where.push(`h.exchange = $${params.length}`); }
  if (cli.coin) { params.push(cli.coin); where.push(`h.coin = $${params.length}`); }
  if (cli.timeframe) { params.push(cli.timeframe); where.push(`h.timeframe = $${params.length}`); }
  if (cli.lookbackDays) {
    params.push(nowSec - cli.lookbackDays * 86_400);
    where.push(`h.decided_at > $${params.length}`);
  }
  // EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R2 filters — appended AFTER every pre-existing
  // conditional and BEFORE the LIMIT params, so with all three absent nothing here executes
  // and the emitted SQL + param vector stay byte-identical to the pre-flag behaviour.
  if (cli.side) {
    params.push(cli.side === 'sell' ? -1 : 1);
    where.push(`h.would_be_side = $${params.length}`);
  }
  if (cli.confMin !== undefined) {
    params.push(cli.confMin);
    where.push(`h.confidence >= $${params.length}`);
  }
  if (cli.confMax !== undefined) {
    params.push(cli.confMax);
    where.push(`h.confidence <= $${params.length}`);
  }
  params.push(cli.perCell);
  const perCell = `$${params.length}`;
  params.push(cli.maxDecisions);
  const maxRows = `$${params.length}`;

  // ROW_NUMBER per (venue, coin, timeframe) is what makes this STRATIFIED rather than merely
  // LIMITed: a bare `ORDER BY decided_at LIMIT n` would hand the entire budget to whichever venue
  // happens to be oldest, which is the opposite of the breadth the analysis needs.
  const sql = `
    WITH eligible AS (
      SELECT h.decision_id, h.decided_at, h.coin, h.timeframe, h.exchange,
             h.would_be_side, h.price_at_decision,
             ROW_NUMBER() OVER (
               PARTITION BY h.exchange, h.coin, h.timeframe ORDER BY h.decided_at ASC
             ) AS rn
        FROM hold_decisions h
       WHERE ${where.join(' AND ')}
    )
    SELECT decision_id, decided_at, coin, timeframe, exchange, would_be_side, price_at_decision
      FROM eligible
     WHERE rn <= ${perCell}
     ORDER BY exchange, coin, timeframe, decided_at
     LIMIT ${maxRows}`;
  return { sql, params };
}

/** Windows must have fully CLOSED — see buildWorklistSql. Applied in JS so `W` stays one table. */
export function windowClosed(row: Pick<HoldRow, 'decided_at' | 'timeframe'>, nowSec: number): boolean {
  const W = EVAL_CANDLES[row.timeframe];
  const tfMs = TF_MS[row.timeframe];
  if (!W || !tfMs) return false;
  return nowSec * 1000 >= row.decided_at * 1000 + W * tfMs;
}

async function fetchRangeInto(
  cache: Map<number, Candle>,
  exchangeId: ExchangeId,
  coin: string,
  timeframe: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const tfMs = TF_MS[timeframe];
  const adapter = getAdapter(exchangeId);
  const dex = exchangeId === 'HL' ? getDexForCoin(coin) : undefined;
  let cursor = startMs;
  let pages = 0;
  while (cursor <= endMs && pages < MAX_PAGES_PER_RANGE) {
    pages++;
    const page = await adapter.getCandles(coin, timeframe, cursor, dex, endMs);
    if (!page || page.length === 0) break;
    let maxTime = cursor;
    for (const c of page) {
      if (c.time >= startMs && c.time <= endMs) cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime <= cursor) break; // no forward progress → venue horizon
    cursor = maxTime + tfMs;
    await sleep(DELAY_BETWEEN_FETCHES_MS);
  }
}

interface Cov {
  considered: number; skippedUnclosed: number; labeled: number; written: number;
  noKlines: number; lowVolHistory: number; timeouts: number; wins: number; losses: number;
  ambiguous: number; budgetSkips: number; errors: number;
  cells: Set<string>; clusters: Set<string>;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = parseCli(argv);
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();
  installGracefulStop();

  const nowSec = Math.floor(Date.now() / 1000);
  const { sql, params } = buildWorklistSql(cli, nowSec);
  const all = await dbQuery<HoldRow>(sql, params);

  const cov: Cov = {
    considered: 0, skippedUnclosed: 0, labeled: 0, written: 0, noKlines: 0, lowVolHistory: 0,
    timeouts: 0, wins: 0, losses: 0, ambiguous: 0, budgetSkips: 0, errors: 0,
    cells: new Set(), clusters: new Set(),
  };

  const todo = all.filter((r) => {
    cov.considered++;
    if (!windowClosed(r, nowSec)) { cov.skippedUnclosed++; return false; }
    return true;
  });

  if (cli.check) {
    // Report only, touch nothing. Idempotent by construction: the work-list already excludes
    // anything labeled, so a second --check immediately after a real run reports 0.
    console.log(
      `[${ts()}] HOLD-LABEL CHECK would_label=${todo.length * cli.specs.length} ` +
        `decisions=${todo.length} unclosed_skipped=${cov.skippedUnclosed}`,
    );
    return 0;
  }

  // Group by (venue, coin, timeframe) so one candle cache serves every decision in a cell.
  const groups = new Map<string, HoldRow[]>();
  for (const r of todo) {
    const k = `${r.exchange}|${r.coin}|${r.timeframe}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const rows: unknown[][] = [];
  const budgetMs = cli.timeBudgetMin ? cli.timeBudgetMin * 60_000 : Infinity;

  for (const [key, decisions] of groups) {
    if (isStopRequested() || Date.now() - startMs > budgetMs) break;
    const [exchange, coin, timeframe] = key.split('|');
    const W = EVAL_CANDLES[timeframe];
    const tfMs = TF_MS[timeframe];
    if (!W || !tfMs) continue;

    const cache = new Map<number, Candle>();
    let coveredUntil = -Infinity;

    for (const d of decisions) {
      const entryMs = d.decided_at * 1000;
      const neededStart = entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * tfMs;
      const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * tfMs;
      try {
        if (neededEnd > coveredUntil) {
          const from = coveredUntil + tfMs >= neededStart ? coveredUntil + tfMs : neededStart;
          await fetchRangeInto(cache, exchange as ExchangeId, coin, timeframe, from, neededEnd);
          coveredUntil = Math.max(coveredUntil, neededEnd);
        }
      } catch (err) {
        if (err instanceof WeightBudgetSkipError) { cov.budgetSkips++; break; }
        cov.errors++;
        continue;
      }

      const asc = [...cache.values()].sort((a, b) => a.time - b.time);
      const trailingCloses = asc.filter((c) => c.time < entryMs).map((c) => c.close);
      const forwardAsc = asc.filter((c) => c.time >= entryMs);
      const { sigma } = computeSigmaW(trailingCloses, W);
      const lowVol = sigma == null;
      // +1/-1 → the direction the barrier race is run in. Zero was excluded in SQL.
      const side = d.would_be_side > 0 ? 'BUY' : 'SELL';

      for (const sp of cli.specs) {
        const bpSpec = barrierPct(sigma, sp.tau);
        const race = runTripleBarrier(side, d.price_at_decision, forwardAsc, bpSpec, W);
        // Same guard as the acted arm: a label-0 on a short window is NOT a timeout, it is an
        // absence of evidence, and recording it as a timeout would bias the counterfactual arm
        // toward "no move" — the exact direction that would fake a PASS.
        const indeterminateTimeout = race.label === 0 && forwardAsc.length < W;
        if (forwardAsc.length === 0 || indeterminateTimeout) { cov.noKlines++; continue; }
        rows.push([
          d.decision_id, sp.spec, race.label, race.ambiguousCandle, lowVol,
          race.tHitCandles, race.mfeReturnPct, race.maeReturnPct, bpSpec,
        ]);
        cov.labeled++;
        if (lowVol) cov.lowVolHistory++;
        if (race.ambiguousCandle) cov.ambiguous++;
        if (race.label === 0) cov.timeouts++;
        else if (race.label === 1) cov.wins++;
        else cov.losses++;
      }
      cov.cells.add(`${exchange}|${coin}|${timeframe}`);
      cov.clusters.add(`${exchange}|${coin}`);
    }
  }

  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_ROWS);
    const values: string[] = [];
    const flat: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      flat.push(...r);
    });
    const res = await dbQuery<{ hold_decision_id: number }>(
      `INSERT INTO hold_decision_labels
         (hold_decision_id, barrier_spec, label, ambiguous_candle, low_vol_history,
          t_hit_candles, mfe_return_pct, mae_return_pct, barrier_pct)
       VALUES ${values.join(',')}
       ON CONFLICT (hold_decision_id, barrier_spec) DO NOTHING
       RETURNING hold_decision_id`,
      flat,
    );
    cov.written += res.length;
  }

  // ── Verdict token ──
  //
  // A gate that can fail open MUST emit a distinguishable token, and this one can: it is bounded
  // by a time budget and by venue weight budgets, so "labeled nothing" has two entirely different
  // meanings. Exit 0 may never encode both "labeled everything there was" and "could not observe
  // enough to say". Callers gate on the TOKEN; 3 is INDETERMINATE.
  //
  // VACUITY BELONGS WHERE THE CORPUS IS CONSTRUCTED. An empty work-list is NOT indeterminate — it
  // means every eligible decision is already labeled, which is the steady state this script exists
  // to reach. Being cut short by a budget, or losing every fetch, is the indeterminate case: the
  // run was SUPPOSED to fill something and could not.
  //
  // ── WHY THIS DOES NOT USE `buildEnvelope` ──
  //
  // `detector-envelope.ts` is the house primitive for exactly this and was the first draft here.
  // It reads `ops/monitoring/detector-envelope.schema.json` at call time, and that file is
  // STRUCTURALLY ABSENT from the runtime image: `/app/ops` does not exist, because the Dockerfile
  // COPYs no `ops/` path and `deploy.yml` lists `ops/monitoring/**` under `paths-ignore`. Every
  // in-container caller therefore throws ENOENT instead of emitting a verdict.
  //
  // That is not a hypothetical. `backfill-directional-labels.ts` calls `buildEnvelope` whenever
  // `--time-budget-min` is set, `nightly-carry-labeler.ts:59` always sets it, and
  // /var/log/carry-labeler.log carries 18 such throws (measured 2026-08-26, most recent
  // 2026-08-26T04:05Z) — its capacity detector has been emitting nothing at all.
  //
  // This script therefore emits the same three-value contract WITHOUT the file dependency, rather
  // than adopting a primitive that cannot work where it runs. It does NOT patch the sibling: that
  // is another wave's artifact and routing around, or silently repairing, someone else's red is
  // forbidden. Flagged in status.md for OPS-DETECTOR-ENVELOPE-RUNTIME-W{NEXT}, which should decide
  // between shipping the schema into the image and making `loadSchema` fall back to its defaults.
  const truncated = cov.budgetSkips > 0 || isStopRequested() || Date.now() - startMs > budgetMs;
  const observedNothing = todo.length > 0 && cov.labeled === 0;
  const verdict: 'PASS' | 'FAIL' | 'INDETERMINATE' =
    truncated || (observedNothing && cov.errors > 0) ? 'INDETERMINATE'
    : cov.written > 0 || todo.length === 0 ? 'PASS'
    : 'FAIL';
  const evidence = {
    run_id: `hold-label-${startedAt}`,
    run_started_at: startedAt,
    produced_at: new Date().toISOString(),
    considered: cov.considered,
    unclosed_skipped: cov.skippedUnclosed,
    labeled: cov.labeled,
    written: cov.written,
    no_klines: cov.noKlines,
    wins: cov.wins,
    losses: cov.losses,
    timeouts: cov.timeouts,
    low_vol: cov.lowVolHistory,
    // The two numbers the pre-registered analysis is actually powered by. Reported EVERY run so
    // the cluster count is tracked rather than discovered at analysis time.
    cells: cov.cells.size,
    clusters: cov.clusters.size,
    budget_skips: cov.budgetSkips,
    errors: cov.errors,
    elapsed_min: Math.round(((Date.now() - startMs) / 60_000) * 10) / 10,
  };
  // Silent on success in the sense that matters — no alert, no Telegram. The token is the record.
  console.log(`HOLD_LABEL_VERDICT=${verdict} ${JSON.stringify(evidence)}`);
  return verdict === 'INDETERMINATE' ? 3 : 0;
}

if (process.argv[1] && process.argv[1].includes('backfill-hold-decision-labels')) {
  void runScript('backfill-hold-decision-labels', () => runAsBatch(() => main()));
}
