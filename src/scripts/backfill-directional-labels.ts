#!/usr/bin/env tsx
/**
 * backfill-directional-labels.ts — EDGE-DWR-METRIC-SOT-W1 (R3/R4)
 *
 * Backfills the durable `directional_labels` dataset: a symmetric triple-barrier label
 * for every historical crypto BUY/SELL signal, across all three barrier specs (τ = 1.0
 * primary; 0.5 / 2.0 sensitivity). INTERNAL-ONLY dataset (same class as outcome_return_pct).
 *
 * Machinery reused from backfill-outcomes.ts (OPS-ADAPTER-RATELIMIT-UNIFY-W1): the shared
 * rate-limited transport (getAdapter + runAsBatch/runAsCaller/WeightBudgetSkipError, 418/429
 * never retried) and the getDexForCoin HL routing. The pure label math lives in
 * ./directional-labeler.ts (unit-tested). NEVER raw fetch.
 *
 * Batches by (exchange, coin, timeframe): a group-level candle cache is filled incrementally
 * (contiguous when signals are dense, island fetches across gaps) so a kline range is fetched
 * ~once, never per-signal. Idempotent + resumable via DB state: a (signal_id, barrier_spec)
 * that already exists is skipped, so a re-run — or `--check` — writes nothing.
 *
 * Q4 (architect): mfe/mae are REUSED from signals.pfe_return_pct / mae_return_pct (identical
 * eval window); the kline-derived excursions are recomputed only for a non-fatal sanity WARN.
 *
 *   node dist/scripts/backfill-directional-labels.js                 (all specs, all groups, full depth)
 *   node dist/scripts/backfill-directional-labels.js --check         (audit only, zero writes)
 *   node dist/scripts/backfill-directional-labels.js --barrier-spec tau1.0-floor0.30-v1
 *   node dist/scripts/backfill-directional-labels.js --venue BINANCE --coin BTC --limit-groups 20
 *   node dist/scripts/backfill-directional-labels.js --venue HTX --timeframe 5m   (triage slice)
 *   node dist/scripts/backfill-directional-labels.js --lookback-days 21 \
 *        --time-budget-min 210 --venue-budget-min 45   (the nightly freshness form —
 *        staleness-first venue rotation + clean-exit budgets; OPS-DIRECTIONAL-LABEL-HALT-W1)
 */

import { dbQuery, dbExec } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { getDexForCoin } from '../lib/asset-tiers.js';
import { runAsBatch, runAsCaller, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import type { Candle, ExchangeId } from '../types.js';
import {
  EVAL_CANDLES,
  TF_MS,
  SIGMA_TARGET_WINDOWS,
  computeSigmaW,
  barrierPct,
  runTripleBarrier,
  expiryReturnPct,
  BARRIER_SPECS,
  BARRIER_SPECS_V2,
  DIRECTIONAL_LABELS_DDL_PG,
  nextFetchStartMs,
  advanceCoverage,
  raceGapCandles,
  prepareRaceV2,
  windowClosed,
} from './directional-labeler.js';
import { T_DIAG_END, withinTCap } from './ads1/spec.js';
import { servedCandleStepMs, SERVED_VENUES, CRON_TIMEFRAMES } from '../lib/tf-support.js';
import { sloHoursFor as defaultSloHoursFor, isFullPanelVenue, FRESHNESS_BARRIER_SPEC, FULL_PANEL_VENUES } from '../lib/venue-slo-tiers.js';
import { candleHorizonDays, CANDLE_HORIZON_DAYS, CANDLE_HORIZONS_MEASURED_AT } from '../lib/venue-candle-horizons.js';
import { isStopRequested, installGracefulStop } from '../lib/graceful-stop.js';
import { ADAPTER_CELL, ADAPTER_PENDING_CELLS, type ManifestClass } from './lrw/registered.js';
import { relabelUntil, buildRelabelGroupsSql } from './lrw/relabel-sql.js';
import { parseGapWorklists, loadAnnotationSources } from './lrw/annotation-sources.js';
import { buildEnvelope, isConforming, type Verdict } from '../lib/detector-envelope.js';

const DELAY_BETWEEN_FETCHES_MS = 250;
const FETCH_BUFFER_CANDLES = 2; // pad each fetched range slightly
const MAX_PAGES_PER_RANGE = 500; // runaway guard for one paginated range
const INSERT_CHUNK_ROWS = 1000; // stay well under the PG bind-param ceiling (11 params/row)

/** The INSERT's column list — one array, so the placeholder count can never disagree with it. */
export const INSERT_COLUMNS = [
  'signal_id', 'barrier_spec', 'label', 'ambiguous_candle', 'low_vol_history',
  't_hit_candles', 'mfe_return_pct', 'mae_return_pct', 'barrier_pct', 'ret_at_expiry_pct',
  'race_gap_candles',
] as const;

const ALL_SPECS = BARRIER_SPECS; // one literal set, in directional-labeler.ts (EDGE-ADS1-SCORECARD-W1-V2 D1)

export interface Cli {
  check: boolean;
  specs: { tau: number; spec: string }[];
  venue?: string;
  coin?: string;
  timeframe?: string;
  limitGroups?: number;
  /** Nightly recency window (days). UNSET = full-depth (backfill semantics unchanged). */
  lookbackDays?: number;
  /** Whole-run wall-clock budget (minutes). UNSET = unbounded (backfill semantics). */
  timeBudgetMin?: number;
  /** Per-venue wall-clock slice cap (minutes). UNSET = unbounded. */
  venueBudgetMin?: number;
  /**
   * EDGE-ADS1-SCORECARD-W1-V2 CH2 (ruling Q2 = A): fill `ret_at_expiry_pct` on EXISTING rows instead of
   * labelling. Label-independent worklist, bounded by `T_CAP`, forward-only fetch, UPDATE path.
   */
  expiryOnly: boolean;
  /** `--expiry-only` pass selector: only rows with `created_at > since` (epoch s). UNSET = every row under T_CAP. */
  since?: number;
  /** `--expiry-only --expiry-reset-written-from <s> --expiry-reset-written-to <s>`: blind-NULL the expiry
   *  values written in that `computed_at` window (see mainExpiryReset). */
  expiryResetFrom?: number;
  expiryResetTo?: number;
  /**
   * EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 (rulings LRW-Q5 = B, LRW-Q13): write the corrected `-v2` race for every
   * eligible signal that lacks it — history included, ADD-ONLY (no `-v1` row is read, written or updated).
   */
  relabelV2: boolean;
  /** `--relabel-v2` window: only signals with `created_at <= until` (epoch s). ALWAYS bounded by T_CUT
   *  (`relabelUntil`): rows created after it are the fixed nightly's, so an unbounded relabel would chase the live
   *  inflow and never converge. `--until` may lower the bound, never raise it. */
  until?: number;
  /** `--relabel-v2`: this process's OWN request ceiling per minute (ruling LRW-Q13: ≤ 50 % of the venue's
   *  documented limit, never above its batch cap). UNSET = the existing per-page pacing only. */
  maxReqPerMin?: number;
  /** `--relabel-v2 --venue HL --order depth-deadline` (ruling LRW-Q17, rider 1): HL's groups in
   *  time-to-depth-loss order instead of horizon-first. HL only — its depth is a fixed candle count. */
  order?: 'depth-deadline';
  /** `--annotate-gaps <worklist.csv.gz>[,<delta.csv.gz>]`: write `race_gap_candles` on `-v1` rows from the
   *  sha-pinned replay worklists (ruling LRW-Q3), only where NULL. */
  annotateGaps?: string;
  /** `--annotate-gaps` batch size, in rows (ruling LRW-Q13: 2–5k, ctid order). */
  annotateBatch: number;
}

interface SignalRow {
  id: number;
  created_at: number; // unix seconds
  price_at_signal: number;
  signal: 'BUY' | 'SELL';
  pfe_return_pct: number | null;
  mae_return_pct: number | null;
}

interface Coverage {
  groups: number;
  groupsSkipped: number; // already fully labeled
  signalsSeen: number;
  labeled: number; // (signal,spec) rows written or already-present
  written: number; // rows actually inserted this run
  noKlines: number; // forward window unreachable (signal×spec)
  lowVolHistory: number; // labeled but flagged (excluded from cell stats)
  // EDGE-LABELER-RACE-WINDOW-V2-W1 (LRW-Q7-D): no outcome tally (wins / losses / timeouts / same-candle) is
  // counted or printed here any more — this run's DONE line lands in a host log, over rows that include the
  // sealed holdout, and nothing parsed those fields. Cardinalities only.
  v2Labeled: number; // -v2 rows raced (signal×spec)
  v2Deferred: number; // -v2 not raced: the window had not closed at fetch (signal) — same-grid / finer pairs only in
  // practice; a coarser signal meets the hold-back first and is counted apart, as V2_HELDBACK
  v2Refused: number; // -v2 not raced: a candle missing inside the window (signal)
  v2UnreachableDepth: number; // -v2 not raced: no candle of the window in hand (signal)
  v2UnreachableHistory: number; // -v2 not raced: < 30 contiguous σ windows (signal)
  // The counted classes of the LRW-Q15 / LRW-Q16 amendment (registration, 2026-09-29) — cardinalities, never a
  // comparator input:
  v2HeldBack: number; // V2_HELDBACK pending — coarser signal held back WHOLE: its -v2 window is still open (signal)
  // V2_HELDBACK released — passed the hold-back this run AND its -v2 window was open at a nominal run one
  // NIGHTLY_CADENCE_MS earlier, when -v1 was already due: a CLOCK ESTIMATE, not a record. It does not reconcile with
  // the previous run's `pending` (catch-up runs, visit-time drift, groups a run never reached, the first night).
  v2HeldBackReleased: number;
  v2NoV1Twin: number; // V2_NO_V1_TWIN written — -v2 rows with no same-τ -v1 row, written or already present (rows)
  sanityWarn: number; // kline-derived vs stored mfe/mae gross mismatch
  budgetSkips: number; // groups deferred on WeightBudgetSkipError (retry on re-run)
  errors: number;
}

const cov: Coverage = {
  groups: 0, groupsSkipped: 0, signalsSeen: 0, labeled: 0, written: 0,
  noKlines: 0, lowVolHistory: 0,
  v2Labeled: 0, v2Deferred: 0, v2Refused: 0, v2UnreachableDepth: 0, v2UnreachableHistory: 0,
  v2HeldBack: 0, v2HeldBackReleased: 0, v2NoV1Twin: 0,
  sanityWarn: 0, budgetSkips: 0, errors: 0,
};

/** A copy of this process's coverage counters — a test seam, not an API (the `_…ForTest` name exemption). */
export function _coverageForTest(): Readonly<Coverage> {
  return { ...cov };
}

/** The amendment's counted classes as the nightly prints them, beside its DONE line (LRW-Q15 / LRW-Q16). */
export function formatV2Tokens(c: Pick<Coverage, 'v2HeldBack' | 'v2HeldBackReleased' | 'v2NoV1Twin'>): string[] {
  return [
    `V2_HELDBACK pending=${c.v2HeldBack} released=${c.v2HeldBackReleased}`,
    `V2_NO_V1_TWIN written=${c.v2NoV1Twin}`,
  ];
}

/** The directional nightly's cadence: "the previous nightly" is one of these before this run. */
export const NIGHTLY_CADENCE_MS = 86_400_000;

/**
 * THE coarser `-v1` lag (ruling LRW-Q15 = A): on a pair whose served candle is coarser than the timeframe, a
 * signal whose `-v2` window is still open when `-v1` is due is held back WHOLE, so the instant its `-v1` row
 * becomes writable moves by `(W+1)·(served − requested)` — a per-pair bound, never a constant. Rows land at a
 * nightly, so the row itself lands at the first run at or after `entry + (W+1)·served`: at most
 * `⌈lag / NIGHTLY_CADENCE_MS⌉` nightlies later (coarserV1LagTable's `nightlies`). 0 on a same-grid or finer pair.
 * Derived from the served table and EVAL_CANDLES; the SoT §5 table must equal renderCoarserV1LagTable().
 */
export function coarserV1LagMs(venue: string, timeframe: string): number {
  const W = EVAL_CANDLES[timeframe];
  const requested = TF_MS[timeframe];
  const served = servedCandleStepMs(venue, timeframe);
  if (!W || !requested || served == null || served <= requested) return 0;
  return (W + 1) * (served - requested);
}

/** Every coarser-served pair of the seeded timeframes, with its lag and the most nightlies a `-v1` row can
 *  land late by — venue order, then timeframe order. */
export function coarserV1LagTable(): Array<{ venue: string; timeframe: string; servedMs: number; lagMs: number; nightlies: number }> {
  const out: Array<{ venue: string; timeframe: string; servedMs: number; lagMs: number; nightlies: number }> = [];
  for (const venue of SERVED_VENUES) {
    for (const timeframe of CRON_TIMEFRAMES) {
      const lagMs = coarserV1LagMs(venue, timeframe);
      if (lagMs > 0) {
        out.push({ venue, timeframe, servedMs: servedCandleStepMs(venue, timeframe)!, lagMs, nightlies: Math.ceil(lagMs / NIGHTLY_CADENCE_MS) });
      }
    }
  }
  return out;
}

const fmtInterval = (ms: number): string =>
  ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`;

/** The SoT §5 "coarser -v1 lag" table, byte for byte (tests/unit/lrw-race-window-v2.test.ts fails if the doc
 *  region between its markers differs — change the code, then paste this output there). */
export function renderCoarserV1LagTable(): string {
  const rows = coarserV1LagTable().map((r) =>
    `| ${r.venue} | ${r.timeframe} | ${fmtInterval(r.servedMs)} | ${r.lagMs / 60_000} min | ${r.nightlies} |`);
  return ['| Venue | Timeframe | Served candle | Coarser `-v1` lag | Nightlies late, at most |', '|---|---|---|---|---|', ...rows].join('\n');
}
const noKlinesByVenue = new Map<string, number>();
/** Per-venue newest labeled signal created_at (s) written THIS run — the frontier evidence. */
const frontierByVenue = new Map<string, number>();

function ts(): string {
  return new Date().toISOString();
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Module-level positive-int env override (default-deny on NaN/≤0). */
function envPosInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseCli(argv: string[]): Cli {
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const posInt = (f: string): number | undefined => {
    const raw = val(f);
    if (raw === undefined) return undefined;
    const n = parseInt(raw, 10);
    // default-deny: a malformed bound must not silently mean "unbounded"
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${f} '${raw}' (positive integer required)`);
    return n;
  };
  const specSel = val('--barrier-spec');
  const specs = specSel ? ALL_SPECS.filter((s) => s.spec === specSel) : ALL_SPECS.slice();
  if (specSel && specs.length === 0) throw new Error(`unknown --barrier-spec '${specSel}'`);
  // The adapter-pending cell is the registration's (lrw/registered.ts), never a flag: an opt-in set let a run
  // without it write permanent -v2 rows into the cell the registration declares empty.
  if (has('--adapter-pending')) throw new Error('--adapter-pending is refused: the cell is pinned in src/scripts/lrw/registered.ts');
  const order = val('--order');
  if (order !== undefined && order !== 'depth-deadline') throw new Error(`unknown --order '${order}' (one of: depth-deadline)`);
  if (order !== undefined && val('--venue') !== 'HL') throw new Error('--order depth-deadline needs --venue HL: only HL has a fixed candle-count depth');
  return {
    order,
    check: has('--check'),
    specs,
    venue: val('--venue'),
    coin: val('--coin'),
    timeframe: val('--timeframe'),
    limitGroups: posInt('--limit-groups'),
    lookbackDays: posInt('--lookback-days'),
    timeBudgetMin: posInt('--time-budget-min'),
    venueBudgetMin: posInt('--venue-budget-min'),
    expiryOnly: has('--expiry-only'),
    since: posInt('--since'),
    expiryResetFrom: posInt('--expiry-reset-written-from'),
    expiryResetTo: posInt('--expiry-reset-written-to'),
    relabelV2: has('--relabel-v2'),
    until: posInt('--until'),
    maxReqPerMin: posInt('--max-req-per-min'),
    annotateGaps: val('--annotate-gaps'),
    annotateBatch: Math.min(5000, Math.max(2000, posInt('--annotate-batch') ?? 5000)),
  };
}

/** Ensure the internal table + index + the additive expiry column exist (idempotent; migrations/019 +
 *  migrations/043 are the SoT; DIRECTIONAL_LABELS_DDL_PG is pinned to them by a parity test). */
function ensureTable(): void {
  dbExec(DIRECTIONAL_LABELS_DDL_PG);
}

/** Epoch-seconds lower bound for the nightly recency window; 0 = full depth. */
export function lookbackCutoff(cli: Pick<Cli, 'lookbackDays'>, nowMs: number): number {
  return cli.lookbackDays ? Math.floor(nowMs / 1000) - cli.lookbackDays * 86_400 : 0;
}

/**
 * OPS-BDIR-V3-PANEL-READINESS-W1 CH2 — a group carrying what its ORDER needs. `todoOldest` is the
 * oldest eligible, unlabelled row still INSIDE its (venue, timeframe) candle horizon (epoch s), null
 * when there is none; `todoLabelable` / `todoPastHorizon` split the unlabelled rows by that horizon.
 * "Unlabelled" is judged on the primary spec — the three specs are written in one batch, and a group
 * whose primary is complete is still visited (last) so a partial row's missing specs still complete.
 */
export interface PrioritizedGroup {
  exchange: string;
  coin: string;
  timeframe: string;
  todoOldest: number | null;
  todoLabelable: number;
  todoPastHorizon: number;
}

/**
 * The group work-list with its order data in ONE aggregate. The eligibility filters are
 * processGroup's own (BUY/SELL, pfe present, the recency window) plus the rotation's (no 1m, not
 * retired) — verbatim, so the list can never admit a row the labeler would not label. Every measured
 * short horizon rides in as a created_at cut-off so rows already past it are counted apart: they can
 * never be labelled from the venue's API, and ranking a group by one of them would spend the slice on
 * a fetch that returns nothing. Integers are inlined (computed here); CLI strings stay parameters.
 */
export function buildGroupsSql(opts: {
  lookbackCutoff: number;
  nowSec: number;
  venue?: string;
  coin?: string;
  timeframe?: string;
}): { text: string; params: unknown[] } {
  const hz: string[] = [];
  for (const [venue, tfs] of Object.entries(CANDLE_HORIZON_DAYS)) {
    for (const [tf, days] of Object.entries(tfs)) {
      hz.push(`('${venue}', '${tf}', ${Math.floor(opts.nowSec - days * 86_400)})`);
    }
  }
  // A CTE column list over VALUES is the form both Postgres and SQLite accept; the empty fallback is
  // TYPED so `s.created_at <= hz.cut` never compares an integer with an untyped (text) NULL.
  const hzCte = hz.length
    ? `WITH hz(exchange, timeframe, cut) AS (VALUES ${hz.join(', ')}) `
    : 'WITH hz(exchange, timeframe, cut) AS (SELECT CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS BIGINT) WHERE 1 = 0) ';
  const where: string[] = [
    "s.signal IN ('BUY','SELL')",
    's.pfe_return_pct IS NOT NULL',
    "s.timeframe <> '1m'", // retired lane (OPS-1M-SEED-DECOM-W1) — never labeled
    // OPS-BITMART-RETIRE-W1: exclude RETIRED venues from the labeler. A retired venue (e.g. BitMart, whose
    // kline API went dead at its 2026-08-26 trading halt) still has historical unlabeled signals; without
    // this the rotation keeps visiting it, the dead API errors dominate its writes, the A2 circuit-breaker
    // trips, and outcome=venue-circuit-break voids the whole nightly capacity claim. Data-driven off
    // venues.status — deletes/mutates NO rows; the retired venue's unlabeled signals simply stay unlabeled
    // (a frozen, disclosed coverage hole, not an ongoing shortfall).
    "s.exchange NOT IN (SELECT exchange_id FROM venues WHERE status = 'retired')",
  ];
  const params: unknown[] = [];
  if (opts.venue) { params.push(opts.venue); where.push(`s.exchange = $${params.length}`); }
  if (opts.coin) { params.push(opts.coin); where.push(`s.coin = $${params.length}`); }
  if (opts.timeframe) { params.push(opts.timeframe); where.push(`s.timeframe = $${params.length}`); }
  if (opts.lookbackCutoff > 0) where.push(`s.created_at > ${Math.floor(opts.lookbackCutoff)}`);
  const unlabelled = 'd.signal_id IS NULL';
  const inside = '(hz.cut IS NULL OR s.created_at > hz.cut)';
  const text =
    hzCte +
    `SELECT s.exchange, s.coin, s.timeframe, ` +
    `MIN(s.created_at) FILTER (WHERE ${unlabelled} AND ${inside}) AS todo_oldest, ` +
    `COUNT(*) FILTER (WHERE ${unlabelled} AND ${inside}) AS todo_labelable, ` +
    `COUNT(*) FILTER (WHERE ${unlabelled} AND hz.cut IS NOT NULL AND s.created_at <= hz.cut) AS todo_past_horizon ` +
    `FROM signals s ` +
    `LEFT JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = '${FRESHNESS_BARRIER_SPEC}' ` +
    `LEFT JOIN hz ON hz.exchange = s.exchange AND hz.timeframe = s.timeframe ` +
    `WHERE ${where.join(' AND ')} ` +
    `GROUP BY s.exchange, s.coin, s.timeframe ORDER BY s.exchange, s.coin, s.timeframe`;
  return { text, params };
}

async function loadGroups(cli: Cli): Promise<PrioritizedGroup[]> {
  const nowMs = Date.now();
  const { text, params } = buildGroupsSql({
    lookbackCutoff: lookbackCutoff(cli, nowMs),
    nowSec: Math.floor(nowMs / 1000),
    venue: cli.venue,
    coin: cli.coin,
    timeframe: cli.timeframe,
  });
  const raw = await dbQuery<{
    exchange: string; coin: string; timeframe: string;
    todo_oldest: string | number | null; todo_labelable: string | number; todo_past_horizon: string | number;
  }>(text, params);
  const rows: PrioritizedGroup[] = raw.map((r) => ({
    exchange: r.exchange,
    coin: r.coin,
    timeframe: r.timeframe,
    todoOldest: r.todo_oldest == null ? null : Number(r.todo_oldest),
    todoLabelable: Number(r.todo_labelable ?? 0),
    todoPastHorizon: Number(r.todo_past_horizon ?? 0),
  }));
  return cli.limitGroups ? rows.slice(0, cli.limitGroups) : rows;
}

/**
 * A row that crosses its candle horizon before the next nightly (24 h away) is lost unless THIS run
 * labels it; the extra 12 h covers a late or deploy-truncated run. Such groups are served first.
 */
export const CRITICAL_HORIZON_MARGIN_S = 36 * 3600;

/**
 * OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R1 — the order a venue's slice reaches its groups.
 *
 * THE DEFECT: groups were walked `ORDER BY exchange, coin, timeframe`, so on a venue whose backlog
 * outruns its 45-minute slice the labelled set was an ALPHABETICAL COIN PREFIX (HL reached ~149 of
 * ~541 groups per visit, measured 2026-09-26) — any DWR read there measured the prefix, not the venue —
 * and rows past the reach silently aged across short candle horizons (57,053 such rows counted).
 *
 * THE ORDER (architect ruling Q-F): (1) HORIZON-FIRST — groups holding a row that crosses its candle
 * horizon within CRITICAL_HORIZON_MARGIN_S, nearest first; (2) BREADTH — every other group with work,
 * interleaved by per-coin rank so every coin gets its first group before any coin gets a second, each
 * round led by the coin whose oldest unlabelled row is oldest; (3) groups with nothing labelable,
 * last — still visited, so a partially-written row's other specs complete. Pure and total: the same
 * set in any input order yields the same output. It decides WHICH rows are reached, never WHAT label.
 */
export function orderGroupsForVenue<G extends PrioritizedGroup>(groups: G[], nowSec: number): G[] {
  const byName = (a: G, b: G): number => a.coin.localeCompare(b.coin) || a.timeframe.localeCompare(b.timeframe);
  const critical: Array<{ g: G; leftS: number }> = [];
  const breadth: G[] = [];
  const idle: G[] = [];
  for (const g of groups) {
    if (g.todoOldest == null || g.todoLabelable <= 0) { idle.push(g); continue; }
    const depthS = candleHorizonDays(g.exchange, g.timeframe) * 86_400;
    const leftS = Number.isFinite(depthS) ? g.todoOldest + depthS - nowSec : Infinity;
    if (leftS <= CRITICAL_HORIZON_MARGIN_S) critical.push({ g, leftS }); else breadth.push(g);
  }
  critical.sort((a, b) => a.leftS - b.leftS || byName(a.g, b.g));

  const perCoin = new Map<string, G[]>();
  for (const g of breadth) {
    const list = perCoin.get(g.coin);
    if (list) list.push(g); else perCoin.set(g.coin, [g]);
  }
  const rounds: G[][] = [];
  for (const list of perCoin.values()) {
    list.sort((a, b) => (a.todoOldest as number) - (b.todoOldest as number) || byName(a, b));
    list.forEach((g, rank) => (rounds[rank] ??= []).push(g));
  }
  const interleaved = rounds.flatMap((round) =>
    round.sort((a, b) => (a.todoOldest as number) - (b.todoOldest as number) || byName(a, b)),
  );
  idle.sort(byName);
  return [...critical.map((c) => c.g), ...interleaved, ...idle];
}

/** The run's `[worklist]` preamble: WHICH measured horizon table and WHICH FULL-eligible set ordered this
 *  run — a horizon table goes stale when a venue changes its retention, and the log must say which one a
 *  given night used. Pure. */
export function worklistPreamble(): string {
  return (
    `[worklist] order=full-panel-first,horizon-first,breadth horizons_measured=${CANDLE_HORIZONS_MEASURED_AT} ` +
    `critical_margin_h=${CRITICAL_HORIZON_MARGIN_S / 3600} full_panel=${FULL_PANEL_VENUES.join(',')}`
  );
}

/** Per-venue worklist figures for the run's `[worklist]` line. Pure. */
export function worklistStats(
  groups: PrioritizedGroup[],
  nowSec: number,
): { groups: number; critical: number; labelable: number; pastHorizon: number } {
  let critical = 0;
  let labelable = 0;
  let pastHorizon = 0;
  for (const g of groups) {
    labelable += g.todoLabelable;
    pastHorizon += g.todoPastHorizon;
    if (g.todoOldest == null || g.todoLabelable <= 0) continue;
    const depthS = candleHorizonDays(g.exchange, g.timeframe) * 86_400;
    if (Number.isFinite(depthS) && g.todoOldest + depthS - nowSec <= CRITICAL_HORIZON_MARGIN_S) critical++;
  }
  return { groups: groups.length, critical, labelable, pastHorizon };
}

/**
 * OPS-BDIR-V3-PANEL-READINESS-W1 CH2 — the FULL-eligible venues (venue-slo-tiers.ts) are served
 * before every other venue, each class keeping the SLO-deadline order within itself. Measured steady
 * state: the five need ~100 of the 210 nightly minutes once their backlog clears, so they are reached
 * every night; the rest share what remains and are REPORTED, not paged, when it is not enough.
 */
export function orderVenuesFullPanelFirst(
  venues: string[],
  frontier: Map<string, number>,
  nowSec: number,
  sloHoursFor: (venue: string) => number = defaultSloHoursFor,
): string[] {
  const full = venues.filter((v) => isFullPanelVenue(v));
  const rest = venues.filter((v) => !isFullPanelVenue(v));
  return [
    ...orderVenuesBySloDeadline(full, frontier, nowSec, sloHoursFor),
    ...orderVenuesBySloDeadline(rest, frontier, nowSec, sloHoursFor),
  ];
}

/**
 * OPS-DIRECTIONAL-LABEL-HALT-W1 F1 — staleness-first venue rotation.
 *
 * The incident: groups ran in fixed alphabetical venue order and no nightly run
 * ever finished (25,960-group full pass ≈ 15–36h vs deploy-recreate lifetimes),
 * so every venue past the death frontier (HTX…XT) starved DETERMINISTICALLY for
 * 16 days. Ordering venues most-starved-first makes starvation self-correcting:
 * whatever a run fails to reach is at the FRONT of the next run.
 */
export function orderVenuesByStaleness(
  venues: string[],
  frontier: Map<string, number>, // venue → MAX(labeled created_at), 0/absent = never labeled
): string[] {
  return [...venues].sort((a, b) => (frontier.get(a) ?? 0) - (frontier.get(b) ?? 0) || a.localeCompare(b));
}

/**
 * OPS-LABEL-FRESHNESS-W1 R2 — SLO-DEADLINE venue rotation (replaces staleness-first
 * for the multi-venue freshness run).
 *
 * The H1 incident: staleness-first minimises MAX-staleness, so a long-tail venue at
 * 57h (72h SLO, 15h of headroom) sorts AHEAD of a major at 56h (24h SLO, 32h PAST its
 * deadline). A 210-min budget only reaches ~6–7 of 17 venues, so the sacrificed majors
 * breach — and because a just-served major sinks to the back, the breaching-major SET
 * whack-a-moles nightly (observed 07-22 {BITGET,BYBIT} → 07-23 {BINANCE,OKX,HL} → 07-24
 * {BITGET,BYBIT}). Ordering by TIME-TO-BREACH (slo − lag, ascending) — using each
 * venue's OWN tier SLO from the shared SoT (venue-slo-tiers.ts, single-derivation with
 * the canary) — serves the most-overdue-relative-to-its-own-SLO venue first, so a
 * truncated run protects the strict-SLO majors. Never-labeled (frontier 0/absent) →
 * lag huge → most negative time-to-breach → first. Deterministic alphabetical tie-break.
 */
export function orderVenuesBySloDeadline(
  venues: string[],
  frontier: Map<string, number>, // venue → MAX(labeled created_at) sec; 0/absent = never labeled
  nowSec: number,
  sloHoursFor: (venue: string) => number = defaultSloHoursFor,
): string[] {
  const timeToBreachSec = (v: string): number =>
    sloHoursFor(v) * 3600 - (nowSec - (frontier.get(v) ?? 0));
  return [...venues].sort((a, b) => timeToBreachSec(a) - timeToBreachSec(b) || a.localeCompare(b));
}

export function partitionByVenue<T extends { exchange: string }>(groups: T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const g of groups) {
    const arr = by.get(g.exchange);
    if (arr) arr.push(g); else by.set(g.exchange, [g]);
  }
  return by;
}

/**
 * F2 — wall-clock budgets with injectable clock (unit-testable). A budgeted run
 * EXITS CLEANLY at expiry: unfinished venues are the stalest → front of the next
 * rotation. TODO: revisit by 2026-08-04 — tighten/loosen from measured nightly
 * timings (defensive-reductions-to-revisit.md carries the row).
 */
export function makeBudget(
  cli: Pick<Cli, 'timeBudgetMin' | 'venueBudgetMin'>,
  now: () => number = Date.now,
): { globalExpired: () => boolean; venueExpired: (venueStartMs: number) => boolean; startMs: number } {
  const startMs = now();
  return {
    startMs,
    globalExpired: () => cli.timeBudgetMin !== undefined && now() - startMs >= cli.timeBudgetMin * 60_000,
    venueExpired: (venueStartMs: number) =>
      cli.venueBudgetMin !== undefined && now() - venueStartMs >= cli.venueBudgetMin * 60_000,
  };
}

export interface VenueRunSummary {
  venue: string;
  groupsDone: number;
  groupsTotal: number;
  outcome: 'complete' | 'venue-budget' | 'global-budget' | 'venue-error' | 'venue-circuit-break' | 'stopped';
  elapsedS: number;
}

/**
 * A2 poison-venue circuit-breaker config. A venue whose errors dominate its writes
 * (e.g. BITMART on 07-23: 2,546 errors, 30 writes, burning the full 45m venue-budget)
 * yields its remaining budget early rather than starving the venues behind it. Omitted
 * → disabled (deep-backfill / unit-test parity). Env-overridable; TODO revisit 2026-08-07.
 */
export interface CircuitBreakerCfg {
  minGroupsBeforeTrip: number; // warm-up: never trip before this many groups attempted
  maxErrors: number;           // trip only once venue errors reach this floor ...
  errorToWriteRatio: number;   // ... AND errors dominate writes (errors > ratio × writes)
}

export interface RotationOpts {
  /** Polled at every venue/group boundary; true → clean 'stopped' exit (A1 graceful checkpoint). */
  stopRequested?: () => boolean;
  /** Cumulative run counters — used to derive per-venue deltas for the circuit-breaker. */
  progress?: () => { written: number; errors: number };
  /** A2 poison-venue circuit-breaker; omitted → disabled. */
  circuit?: CircuitBreakerCfg;
}

/**
 * F4 — the venue-rotation loop with per-venue isolation. Pure orchestration over
 * an injectable per-group processor; one venue's failure can never abort or
 * starve a successor (per-venue try/catch + continue; per-group catch stays in
 * the processor). Emits the load-bearing per-venue success-path summary.
 *
 * OPS-LABEL-FRESHNESS-W1 R2 adds two OPTIONAL, trailing-param behaviours (defaults
 * preserve the shipped semantics exactly, so deep-backfill + existing tests are
 * unchanged): a graceful-stop boundary check (A1 — a SIGTERM checkpoints cleanly at a
 * venue/group boundary, resumable via DB state) and a poison-venue circuit-breaker (A2).
 */
export async function runVenueRotation<G extends { exchange: string; coin: string; timeframe: string }>(
  venueOrder: string[],
  groupsByVenue: Map<string, G[]>,
  budget: ReturnType<typeof makeBudget>,
  processOne: (g: G) => Promise<void>,
  log: (line: string) => void = console.log,
  now: () => number = Date.now,
  extra?: (venue: string) => string,
  opts: RotationOpts = {},
): Promise<VenueRunSummary[]> {
  const summaries: VenueRunSummary[] = [];
  let stopped = false;
  for (const venue of venueOrder) {
    if (opts.stopRequested?.()) { stopped = true; break; } // checkpoint before starting a venue
    const groups = groupsByVenue.get(venue) ?? [];
    const venueStart = now();
    const base = opts.progress?.() ?? { written: 0, errors: 0 };
    let done = 0;
    let outcome: VenueRunSummary['outcome'] = 'complete';
    try {
      for (const g of groups) {
        if (opts.stopRequested?.()) { outcome = 'stopped'; stopped = true; break; }
        if (budget.globalExpired()) { outcome = 'global-budget'; break; }
        if (budget.venueExpired(venueStart)) { outcome = 'venue-budget'; break; }
        // A2: a poison venue (errors dominate, no real write progress) yields its
        // remaining venue-budget early. Never trips a venue that is writing labels.
        if (opts.circuit && opts.progress) {
          const cur = opts.progress();
          const vErr = cur.errors - base.errors;
          const vWrote = cur.written - base.written;
          if (done >= opts.circuit.minGroupsBeforeTrip && vErr >= opts.circuit.maxErrors &&
              vErr > vWrote * opts.circuit.errorToWriteRatio) {
            outcome = 'venue-circuit-break';
            log(`[circuit-breaker] ${venue}: ${vErr} errors vs ${vWrote} writes after ${done} groups — yielding remaining venue-budget (freeing it for the queue)`);
            break;
          }
        }
        await processOne(g);
        done++;
      }
    } catch (err) {
      outcome = 'venue-error';
      log(`[venue-summary] ${venue}: VENUE-LEVEL ERROR after ${done}/${groups.length} groups: ${String((err as Error).message ?? err).slice(0, 200)} — continuing with next venue`);
    }
    const elapsedS = Math.round((now() - venueStart) / 1000);
    summaries.push({ venue, groupsDone: done, groupsTotal: groups.length, outcome, elapsedS });
    if (outcome !== 'venue-error') {
      log(`[venue-summary] ${venue}: groups ${done}/${groups.length} outcome=${outcome} elapsed=${elapsedS}s${extra ? ` ${extra(venue)}` : ''}`);
    }
    if (outcome === 'global-budget') {
      log(`[budget] global time budget reached — clean exit; unreached venues lead the next rotation`);
      break;
    }
    if (stopped) {
      log(`[graceful-stop] checkpointed at the ${venue} boundary — remaining venues resume from DB state next run`);
      break;
    }
  }
  return summaries;
}

/**
 * OPS-LABEL-FRESHNESS-W1 R2 — capacity-honesty. After an SLO-ordered run, quantify whether
 * a venue was left UNREACHED that will breach its OWN tier SLO before the next nightly.
 *
 * OPS-MONITORING-SIGNAL-CONTRACT-W1 CH3 — AND SAY SO ONLY WHEN THE RUN EARNED IT.
 *
 * THE INCIDENT: on 2026-08-22 this function published `est_venue_min_short=26` as a structural
 * capacity verdict from a run SIGTERM'd at 46.6 of 210 minutes — 22% of budget, 163 minutes
 * unspent, 4 of 17 venues reached. It could not have known better: it read only `s.venue` and
 * `s.elapsedS`, never `s.outcome`, and the emit gate asked "were budgets CONFIGURED" rather than
 * "did the budget EXPIRE". A run killed 163 minutes early is evidence of nothing about capacity.
 *
 * It now derives the RUN OUTCOME and returns a verdict with it. A non-conclusive outcome yields
 * `INDETERMINATE` — never silence. The truncation stays fully visible; only the conclusion the
 * run did not reach is withheld. `estVenueMinShort` is still REPORTED, because it is a
 * measurement; what it may no longer do is arrive labelled as a capacity ceiling.
 */
export interface CapacityShortfall {
  shortfall: boolean;
  unreachedInDanger: string[];
  estVenueMinShort: number;
  /** The run's effective outcome, from the per-venue summaries plus the real budget state. */
  runOutcome: string;
  /** PASS = measured, in-SLO · FAIL = measured, short · INDETERMINATE = the run did not finish. */
  verdict: Verdict;
  /**
   * OPS-BITMART-RETIRE-W1 R2 — venues excluded from the capacity verdict because their own breaker
   * tripped (venue-error / venue-circuit-break). INDETERMINATE for THAT venue, not for the corpus;
   * named here so the alert can say its subject rather than emitting a bare `venue-circuit-break`.
   */
  excludedVenues: Array<{ venue: string; outcome: string }>;
}

/**
 * The run's outcome, worst-first. `stopped` dominates everything: a SIGTERM at any venue means
 * the rotation was decapitated, and whatever the later venues would have done is unknown.
 */
export function deriveRunOutcome(summaries: VenueRunSummary[], budgetExpired: boolean): string {
  if (summaries.some((s) => s.outcome === 'stopped')) return 'stopped';
  if (budgetExpired || summaries.some((s) => s.outcome === 'global-budget')) return 'global-budget';
  if (summaries.some((s) => s.outcome === 'venue-error' || s.outcome === 'venue-circuit-break')) {
    // A poisoned venue yielded early, but the rotation itself ran to completion — the budget
    // question was still answered. `complete` here would hide it, so it keeps its own name and
    // the schema decides whether that name is conclusive.
    return 'venue-circuit-break';
  }
  return 'complete';
}
export function detectCapacityShortfall(
  summaries: VenueRunSummary[],
  venueOrder: string[],
  frontier: Map<string, number>,
  nowSec: number,
  sloHoursFor: (venue: string) => number = defaultSloHoursFor,
  nextRunIntervalH = 24,
  // TRAILING + OPTIONAL so every existing caller and test keeps working unchanged — the
  // enum-widening rule: never insert a required param mid-signature.
  budgetExpired = false,
): CapacityShortfall {
  // OPS-BITMART-RETIRE-W1 R2 — the estate's vacuity rule applied per-input: a venue whose OWN breaker
  // tripped (venue-error / venue-circuit-break) is INDETERMINATE for THAT venue, not for the corpus.
  // Exclude those venues from the capacity verdict AND from the run-outcome derivation (they were
  // "reached" but not measured, and would otherwise count as danger OR — via deriveRunOutcome — void
  // the whole nightly claim, which is exactly what BitMart did on 2026-08-27). The excluded venues are
  // reported separately so the alert names its subject. A SIGTERM ('stopped') or a global-budget expiry
  // still voids the run — those decapitate the rotation and are not a single venue's fault.
  const excluded = summaries.filter((s) => s.outcome === 'venue-error' || s.outcome === 'venue-circuit-break');
  const excludedSet = new Set(excluded.map((s) => s.venue));
  // Derive the RUN outcome from the MEASURABLE venues only: a venue whose own breaker tripped is
  // INDETERMINATE for THAT venue, not for the corpus, so it must not flip the whole run to a
  // non-conclusive outcome and void the nightly capacity claim (BitMart did exactly this on 2026-08-27).
  // The reached/unreached/danger/median math is left over ALL summaries — a broken venue was still
  // reached (so it is not falsely counted "in danger"), and its truncated duration is a minor,
  // pre-existing input to the median. Only the corpus-voiding decision is scoped to the measurable set.
  const measured = summaries.filter((s) => !excludedSet.has(s.venue));

  const reached = new Set(summaries.map((s) => s.venue));
  const unreached = venueOrder.filter((v) => !reached.has(v));
  const inDanger = unreached.filter((v) => {
    const projectedLagH = (nowSec - (frontier.get(v) ?? 0)) / 3600 + nextRunIntervalH;
    return projectedLagH > sloHoursFor(v);
  });
  const durations = summaries.map((s) => s.elapsedS / 60).filter((m) => m > 0).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 45;
  const shortfall = inDanger.length > 0;
  const runOutcome = deriveRunOutcome(measured, budgetExpired);
  const conclusive = runOutcome === 'complete' || runOutcome === 'global-budget' || runOutcome === 'venue-budget';
  return {
    shortfall,
    unreachedInDanger: inDanger,
    estVenueMinShort: Math.round(inDanger.length * median),
    runOutcome,
    verdict: conclusive ? (shortfall ? 'FAIL' : 'PASS') : 'INDETERMINATE',
    excludedVenues: excluded.map((s) => ({ venue: s.venue, outcome: s.outcome })),
  };
}

/** Paginated ranged fetch [startMs, endMs] via the shared transport; stops at venue horizon. */
async function fetchRangeInto(
  cache: Map<number, Candle>,
  exchangeId: ExchangeId,
  coin: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  /** Paging step. Defaults to the REQUESTED interval (the race path's behaviour, unchanged); the expiry path
   *  passes the SERVED interval so a finer-served venue does not skip one candle per page boundary. */
  pageStepMs: number = TF_MS[timeframe],
): Promise<boolean> {
  const tfMs = pageStepMs;
  const adapter = getAdapter(exchangeId);
  const dex = exchangeId === 'HL' ? getDexForCoin(coin) : undefined;
  let cursor = startMs;
  let pages = 0;
  let answered = false; // the venue returned at least one candle — in range or not
  while (cursor <= endMs && pages < MAX_PAGES_PER_RANGE) {
    pages++;
    await ownRateGate();
    const page = await adapter.getCandles(coin, timeframe, cursor, dex, endMs);
    if (!page || page.length === 0) break;
    answered = true;
    let maxTime = cursor;
    for (const c of page) {
      if (c.time >= startMs && c.time <= endMs) cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime <= cursor) break; // no forward progress → venue horizon reached
    cursor = maxTime + tfMs;
    await sleep(DELAY_BETWEEN_FETCHES_MS);
  }
  return answered;
}

/**
 * EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 (ruling LRW-Q13) — this process's OWN request ceiling, on top of the shared
 * weight budget (which meters every batch caller of a venue together). Off unless `--max-req-per-min` is set, so
 * the nightly's pacing is unchanged.
 */
let ownMinIntervalMs = 0;
let ownLastCallMs = -Infinity;
export function setOwnRequestRate(perMin: number | undefined): void {
  ownMinIntervalMs = perMin && perMin > 0 ? Math.ceil(60_000 / perMin) : 0;
  ownLastCallMs = -Infinity;
}
/** The relabel's hard stop (LRW-Q13: 02:15Z, through `--time-budget-min`), checked before EVERY venue page, so a
 *  long range fetch at a low own rate cannot run past it. Infinity (off) everywhere else — the nightly is unchanged. */
let ownDeadlineMs = Infinity;
let ownStopArmed = false;
/** Arms the relabel's stop checks (the deadline, `Infinity` for none, and a SIGTERM) — called by --relabel-v2 only. */
export function setOwnDeadline(ms: number): void {
  ownDeadlineMs = ms;
  ownStopArmed = true;
}
export class OwnStopError extends Error {}
function ownStopDue(): boolean {
  return ownStopArmed && (Date.now() >= ownDeadlineMs || isStopRequested());
}
async function ownRateGate(): Promise<void> {
  if (ownStopDue()) throw new OwnStopError('relabel deadline / stop request');
  if (ownMinIntervalMs <= 0) return;
  const wait = ownLastCallMs + ownMinIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  ownLastCallMs = Date.now();
}

/**
 * EDGE-LABELER-RACE-WINDOW-V2-W1 CH2 — the `-v1` fetch extents seen so far in one group run, merged.
 *
 * `-v1` raced on whatever its own fetches covered: each row asked for `[entry − (60W+2)·tf, entry + (W+2)·tf]`
 * on the REQUESTED interval. The strict UNION of those requested extents is what `-v1` is allowed to see from
 * the corrected cache. The candle its off-grid extension used to drop opened INSIDE the next row's own
 * extent, so it is back; a candle strictly between two extents was never requested by any `-v1` row (the
 * retired extension restarted at `previous end + tf`, which is at or past the next row's start), so it stays
 * out on every pair class — merging only OVERLAPPING extents is what makes that so.
 * Pure; rows arrive in `created_at` order, so extents only ever grow at the end.
 */
export function addV1Extent(extents: Array<[number, number]>, lo: number, hi: number): void {
  const last = extents[extents.length - 1];
  if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
  else extents.push([lo, hi]);
}

/**
 * THE seal edge — one derivation for the race path and the expiry-only path. A row that ADS-1's
 * requested-interval T_CAP admits, but whose race on the SERVED grid ends after T_DIAG_END (a coarser-served
 * venue), would carry a post-seal close in `ret_at_expiry_pct`: it is never written there (NULL). Pure.
 */
export function sealEdgeRow(createdAtS: number, timeframe: string, stepMs: number): boolean {
  const W = EVAL_CANDLES[timeframe];
  if (!W) return false;
  return withinTCap(createdAtS, timeframe) && createdAtS * 1000 + (W + 1) * stepMs > T_DIAG_END * 1000;
}

/** The candles of `asc` (ascending) that lie inside the merged extents (ascending, disjoint). Pure. */
export function withinExtents<T extends { time: number }>(asc: T[], extents: Array<[number, number]>): T[] {
  const out: T[] = [];
  let k = 0;
  for (const c of asc) {
    while (k < extents.length && extents[k][1] < c.time) k++;
    if (k === extents.length) break;
    if (c.time >= extents[k][0]) out.push(c);
  }
  return out;
}

/** Exported for tests/unit/directional-label-golden.test.ts only — a seam, not an API: that golden
 *  pins the labels this function writes for a fixed fixture, which is how "the worklist order changed
 *  WHICH rows are reached, never WHAT label they get" is proven rather than asserted. */
export async function processGroup(cli: Cli, g: { exchange: string; coin: string; timeframe: string }): Promise<void> {
  const W = EVAL_CANDLES[g.timeframe];
  const tfMs = TF_MS[g.timeframe];
  if (!W || !tfMs) return; // unknown/retired timeframe — already filtered, defensive
  // EDGE-LABELER-RACE-WINDOW-V2-W1 CH2 (rulings Q9, LRW-Q9c): the candle the venue SERVES — the grid the race
  // runs on, the step pages advance by, the grid the cache extends on. One fetch covers both families: the
  // `-v1` extent on the requested interval and the `-v2` extent on the served one.
  const stepMs = servedStepMs(g.exchange, g.timeframe);
  const spanMs = Math.max(tfMs, stepMs);
  // Taken BEFORE any fetch: a candle is only trusted as CLOSED if it closed before this instant
  // (expiryReturnPct and the -v2 race refuse a window that may have been forming at fetch time).
  const groupStartMs = Date.now();

  // F3: the nightly recency window bounds the per-group scan too — aged-out
  // unlabelable signals (the noKlines re-attempt swamp) leave the nightly forever.
  const cutoff = lookbackCutoff(cli, Date.now());
  const sigs = await dbQuery<SignalRow>(
    `SELECT id, created_at, price_at_signal, signal, pfe_return_pct, mae_return_pct
     FROM signals
     WHERE exchange = $1 AND coin = $2 AND timeframe = $3
       AND signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL
       AND created_at > $4
     ORDER BY created_at ASC`,
    [g.exchange, g.coin, g.timeframe, cutoff],
  );
  if (sigs.length === 0) return;

  // -v2 rides with the -v1 specs of this run, paired by τ (a --barrier-spec slice writes its own τ's -v2 only).
  const v2Specs = BARRIER_SPECS_V2.filter((v) => cli.specs.some((s) => s.tau === v.tau));
  const v1Names = cli.specs.map((s) => s.spec);
  // Which (signal_id, spec) already exist → skip (idempotency + resume).
  const specNames = [...v1Names, ...v2Specs.map((s) => s.spec)];
  const ids = sigs.map((s) => s.id);
  const existing = await dbQuery<{ signal_id: number; barrier_spec: string }>(
    `SELECT signal_id, barrier_spec FROM directional_labels
     WHERE barrier_spec = ANY($1) AND signal_id = ANY($2)`,
    [specNames, ids],
  );
  const done = new Set(existing.map((e) => `${e.signal_id}|${e.barrier_spec}`));
  cov.labeled += existing.filter((e) => v1Names.includes(e.barrier_spec)).length;

  // Build the to-do list: signal × -v1 spec not yet present. Keyed on -v1 ONLY (ruling LRW-Q6): the nightly
  // writes -v2 only alongside a -v1 attempt of the same run, so -v2 never joins the lookback's backlog (a
  // coarser-served signal whose -v2 window is still open is held back whole until it closes — the retry contract below).
  const todo = sigs.filter((s) => cli.specs.some((sp) => !done.has(`${s.id}|${sp.spec}`)));
  cov.signalsSeen += sigs.length;
  if (todo.length === 0) {
    cov.groupsSkipped++;
    return;
  }
  if (cli.check) {
    // Report only: count what WOULD be written, touch nothing.
    for (const s of todo) for (const sp of cli.specs) if (!done.has(`${s.id}|${sp.spec}`)) cov.written++;
    return;
  }

  // Incremental group candle cache (dense → contiguous; sparse → islands), on the SERVED grid.
  // `coveredUntil` is the last candle that ARRIVED — never a range end, never `coveredUntil + tf` (the
  // off-grid extension that dropped one candle per step since 20129e14: EDGE-LABELER-RACE-WINDOW-V2-W1).
  const cache = new Map<number, Candle>();
  let coveredUntil = -Infinity;
  // The venue ANSWERED a range but put no candle in it (a young coin's pre-listing history, an outage):
  // that range is not asked again for the next row. Without this, `coveredUntil` never moves, every later row
  // restarts at its own pre-listing start, and a venue whose history window returns its NEWEST bars when the
  // window is empty (OKX, Bitget) never gets past the gap — rows the retired `coveredUntil = neededEnd` reached.
  let probedThrough = -Infinity;
  const v1Extents: Array<[number, number]> = [];
  const rows: unknown[][] = [];
  let groupNoTwin = 0; // V2_NO_V1_TWIN rows of this group: added to cov only once the group's rows are inserted

  for (const s of todo) {
    const entryMs = s.created_at * 1000;
    const neededStart = entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * spanMs;
    const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * spanMs;
    addV1Extent(
      v1Extents,
      entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * tfMs,
      entryMs + (W + FETCH_BUFFER_CANDLES) * tfMs,
    );
    try {
      if (neededEnd > Math.max(coveredUntil, probedThrough)) {
        // extend vs new island — never back into a range the venue already answered empty
        const start = Math.max(nextFetchStartMs(coveredUntil, stepMs, neededStart), probedThrough + 1);
        if (start <= neededEnd) {
          const answered = await fetchRangeInto(cache, g.exchange as ExchangeId, g.coin, g.timeframe, start, neededEnd, stepMs);
          const before = coveredUntil;
          coveredUntil = advanceCoverage(coveredUntil, cache.keys(), start, neededEnd);
          if (answered && coveredUntil === before) probedThrough = neededEnd;
        }
      }
    } catch (err) {
      if (err instanceof WeightBudgetSkipError) {
        cov.budgetSkips++;
        return; // defer whole group; re-run picks it up (labels absent)
      }
      cov.errors++;
      noKlinesByVenue.set(g.exchange, (noKlinesByVenue.get(g.exchange) || 0) + 1);
      continue;
    }

    const asc = [...cache.values()].sort((a, b) => a.time - b.time);
    // ── -v1 (ruling Q9; LRW-Q4): the UNCHANGED race and σ, on exactly the candles its own fetch extents cover —
    // now without the holes. Clipping to those extents keeps -v1 byte-identical to its registered self where the
    // corrected fetch reaches further for -v2 (a coarser-served pair's -v1 window stays cut at (W+2)·requested).
    const v1View = withinExtents(asc, v1Extents);
    const trailingCloses = v1View.filter((c) => c.time < entryMs).map((c) => c.close);
    const forwardAsc = v1View.filter((c) => c.time >= entryMs);
    const { sigma } = computeSigmaW(trailingCloses, W);
    const lowVol = sigma == null;
    // EDGE-ADS1-SCORECARD-W1-V2 (Q2 = A): the expiry return from the candles in hand — on the served grid,
    // time-verified, NULL when the window had not closed at fetch time. A fact of the path, the same for every
    // spec and both families.
    const fullForward = asc.filter((c) => c.time >= entryMs);
    // The seal edge (sealEdgeRow): a row ADS-1's T_CAP admits never carries a post-seal close — the same
    // predicate processExpiryGroup applies.
    const expiry = sealEdgeRow(s.created_at, g.timeframe, stepMs)
      ? null
      : expiryReturnPct(fullForward, W, s.price_at_signal, entryMs, stepMs, groupStartMs);
    // race_gap_candles (ruling LRW-Q3): the TRUE window's served slots absent from what -v1 raced on; any
    // candle in hand fixes the venue's grid phase. Expected 0 — never asserted 0.
    const anchor = forwardAsc[0]?.time ?? v1View[v1View.length - 1]?.time;
    const gap = anchor === undefined ? null : raceGapCandles(new Set(v1View.map((c) => c.time)), entryMs, W, stepMs, anchor);

    // THE RETRY CONTRACT (ruling LRW-Q15 = A; registration amendment 2026-09-29). The worklist keys on -v1 alone,
    // so a -v2 window still open when the -v1 row is written would never be raced: on a coarser-served pair -v1
    // is due at (W+1)·requested, -v2 at (W+1)·served. Such a signal is HELD BACK WHOLE — neither family this
    // run; it stays in the worklist, and the first run after its -v2 window closes writes both. The hold-back
    // waits on the CLOCK only, never on what the -v2 fetch finds: a refused -v2 window still writes -v1 in that
    // run, so -v1 coverage can never shrink by a -v2 refusal. -v1 is computed by the UNCHANGED rule in the run that
    // writes it — that run's LRW-Q4 extent union and the candles then in hand — so a held-back row's σ, label or
    // expiry can differ from what its due-night run would have written (the fetch and extents above still run, so
    // the held-back signal's extent does join this run's union). It becomes writable up to coarserV1LagMs later
    // and lands at most ⌈lag / nightly⌉ nightlies later. On a same-grid or finer pair the -v2 window is closed
    // whenever -v1 is due (maturityHorizonMs), so this never fires there.
    const v2Missing = v2Specs.some((sp) => !done.has(`${s.id}|${sp.spec}`));
    if (v2Missing && stepMs > tfMs) {
      if (!windowClosed(entryMs, W, stepMs, groupStartMs)) { cov.v2HeldBack++; continue; }
      // released (a clock ESTIMATE — see the Coverage field): at a nominal run one cadence ago -v1 was due and the
      // -v2 window open
      const prevRun = groupStartMs - NIGHTLY_CADENCE_MS;
      if (prevRun >= entryMs + (W + 1) * tfMs && !windowClosed(entryMs, W, stepMs, prevRun)) cov.v2HeldBackReleased++;
    }

    // Forward reachability: need a resolved race OR full-window coverage to call a timeout.
    let wroteV1 = false;
    // A coarser-served pair's -v1 window is cut at (W+2)·requested, which holds fewer than W served candles, so
    // its timeout can never be written. That attempt still counts for the -v2 gate below — otherwise nightly -v2
    // on those pairs would exist only where -v1 DECIDED, a population selected on the outcome.
    let v1CutUnwritable = false;
    const v1Written = new Set<string>(); // the -v1 specs this run wrote for this signal (the same-τ twin test)
    for (const sp of cli.specs) {
      if (done.has(`${s.id}|${sp.spec}`)) continue;
      const bpSpec = barrierPct(sigma, sp.tau);
      const race = runTripleBarrier(s.signal, s.price_at_signal, forwardAsc, bpSpec, W);
      const indeterminateTimeout = race.label === 0 && forwardAsc.length < W;
      if (forwardAsc.length === 0 || indeterminateTimeout) {
        // an EMPTY forward is no-klines (the venue served nothing), not a completed -v1 attempt
        if (indeterminateTimeout && forwardAsc.length > 0 && stepMs > tfMs) v1CutUnwritable = true;
        cov.noKlines++;
        noKlinesByVenue.set(g.exchange, (noKlinesByVenue.get(g.exchange) || 0) + 1);
        continue;
      }
      // Q4: persist stored mfe/mae; kline-derived only for a non-fatal sanity check.
      const storedMfe = s.pfe_return_pct;
      const storedMae = s.mae_return_pct;
      if (storedMfe != null && Math.abs(race.mfeReturnPct - storedMfe) > 0.5 &&
          Math.abs(race.mfeReturnPct) > 2 * Math.abs(storedMfe) + 0.5) {
        cov.sanityWarn++;
        if (cov.sanityWarn <= 20) {
          console.warn(`[${ts()}] SANITY ${g.exchange}:${g.coin}:${g.timeframe} sig ${s.id} kline-mfe ${race.mfeReturnPct.toFixed(3)} vs stored ${storedMfe}`);
        }
      }
      rows.push([
        s.id, sp.spec, race.label, race.ambiguousCandle, lowVol,
        race.tHitCandles, storedMfe, storedMae, bpSpec, expiry, gap,
      ]);
      wroteV1 = true;
      v1Written.add(sp.spec);
      frontierByVenue.set(g.exchange, Math.max(frontierByVenue.get(g.exchange) ?? 0, s.created_at));
      cov.labeled++;
      if (lowVol) cov.lowVolHistory++;
    }

    // ── -v2 (rulings Q8, LRW-Q1, LRW-Q2, LRW-Q6 as amended by LRW-Q16): the corrected race, for the signals whose
    // -v1 ATTEMPT this run completed — a written row, or a timeout the LRW-Q4 cut makes unwritable (the counted
    // class V2_NO_V1_TWIN, never a comparator input). Written ONCE: a -v1-less signal is re-attempted every
    // nightly, and its -v2 is skipped as soon as the row exists. By TIME on the served grid over all W candles;
    // a hole is refused, an open window deferred, a short σ history unreachable — each a count, never a row.
    // mfe/mae reuse the stored path values as -v1 does.
    if (!(wroteV1 || v1CutUnwritable) || !v2Missing) continue;
    const prep = prepareRaceV2(cache, fullForward, entryMs, W, stepMs, groupStartMs);
    if (prep.kind === 'deferred') { cov.v2Deferred++; continue; }
    if (prep.kind === 'refused') { cov.v2Refused++; continue; }
    if (prep.kind === 'unreachable') {
      if (prep.reason === 'depth') cov.v2UnreachableDepth++;
      else cov.v2UnreachableHistory++;
      continue;
    }
    for (const sp of v2Specs) {
      if (done.has(`${s.id}|${sp.spec}`)) continue; // -v2 written once
      const bpSpec = barrierPct(prep.sigma, sp.tau);
      const race = runTripleBarrier(s.signal, s.price_at_signal, prep.window, bpSpec, W);
      rows.push([
        s.id, sp.spec, race.label, race.ambiguousCandle, false,
        race.tHitCandles, s.pfe_return_pct, s.mae_return_pct, bpSpec, expiry, 0,
      ]);
      cov.v2Labeled++;
      // no-twin is per τ: a -v2 row whose same-τ -v1 row neither exists nor was written this run
      const twin = cli.specs.find((v) => v.tau === sp.tau)!.spec;
      if (!done.has(`${s.id}|${twin}`) && !v1Written.has(twin)) groupNoTwin++;
    }
  }

  // Batch insert (idempotent).
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_ROWS);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * INSERT_COLUMNS.length;
      values.push(`(${INSERT_COLUMNS.map((_, k) => `$${b + k + 1}`).join(',')})`);
      params.push(...r);
    });
    const res = await dbQuery<{ signal_id: number }>(
      `INSERT INTO directional_labels
         (${INSERT_COLUMNS.join(', ')})
       VALUES ${values.join(',')}
       ON CONFLICT (signal_id, barrier_spec) DO NOTHING
       RETURNING signal_id`,
      params,
    );
    cov.written += res.length;
  }
  // counted once the rows are in: a group a budget skip abandons mid-way wrote nothing and counts nothing
  cov.v2NoV1Twin += groupNoTwin;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// EDGE-ADS1-SCORECARD-W1-V2 CH2 — `--expiry-only`: fill `ret_at_expiry_pct` on EXISTING rows (Q2 = A).
//
// THE SEAL. Every row this mode touches satisfies T_CAP: `created_at ≤ T_DIAG_END` AND its race END,
// `created_at + (W+1)·tf`, ≤ T_DIAG_END — the label-independent price-path embargo (ruling Q1 = A). No
// candle after T_DIAG_END is ever fetched for it, and rows above the cap stay NULL this wave.
//
// LABEL-INDEPENDENT. The worklist is "every row with a NULL expiry", never "every timeout": selecting
// on the label would be an outcome-conditioned read, and L4's magnitude companion needs decided rows
// too. The row's label is never SELECTed here.
//
// FORWARD-ONLY. The expiry needs the window candles, not the 60·W sigma history the labeler fetches,
// so a backfill here costs ~1/60th of a labeling pass per row.
//
// NOTHING ESTIMATED. A row whose candles the venue no longer serves stays NULL (UNRESOLVED), counted
// per venue as `past_reach` (skipped without a fetch: older than the measured depth) or `unreachable`
// (fetched, window incomplete). Output is cardinalities only — no return value is ever printed.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Measured candle depth (days) for the (venue, timeframe) pairs SHALLOWER than their rows' age —
 * EDGE-ADS1-SCORECARD-W1-V2 CH1 probe 4, 2026-09-27 (vault endpoint-truth addendum). Instrument: the
 * SHIPPED adapter `getCandles` for BTC in the app container on the prod IP, batch class (a variant of
 * `ops/scripts/probe-candle-horizons.cjs`), lower bounds at ≤ 1 d resolution; HL = 5,000 candles
 * (`candleSnapshot`); WEEX = 1,000 candles (its kline endpoint takes no start time); the sub-21 d pairs
 * are `venue-candle-horizons.ts` (2026-09-26). An absent pair served every row probed. The table only
 * saves fetches that cannot succeed; a stale entry costs a skipped-but-reachable row (reported as
 * `past_reach`), never a wrong value.
 */
// OPS-ALARM-OWNER-DERIVATION-W1 CH1: the table, its date, its lookup, HL's depth and the margin now
// live in src/lib/venue-candle-reach.ts — the ONE reach table the outcome backfill's queue and census
// read too. Re-exported here so every existing importer compiles unchanged; values are byte-identical.
import {
  EXPIRY_REACH_DAYS, EXPIRY_REACH_DAYS_MEASURED_AT, HL_CANDLE_DEPTH, REACH_MARGIN_S, expiryReachDays,
} from '../lib/venue-candle-reach.js';
export { EXPIRY_REACH_DAYS, EXPIRY_REACH_DAYS_MEASURED_AT, HL_CANDLE_DEPTH, expiryReachDays };

/**
 * Ruling LRW-Q17, rider 1 (2026-10-05): HL's relabel work-list in time-to-depth-loss order — ascending
 * `created_at + 5,000 · served step − now` of each group's oldest signal still inside the depth, ties in the
 * horizon-first order the list arrives in. A group whose every signal is already past the depth sorts first (its
 * rows are classed `unreachable:depth` without a fetch). Label-independent: times and steps only. Recorded as a
 * deviation from LRW-Q13's horizon-first order: HL's lane-bound pace let rows cross the depth before their turn.
 */
export function depthDeadlineOrder<T extends { timeframe: string; atRiskOldest: number | null }>(
  groups: readonly T[], nowS: number, stepS: (timeframe: string) => number,
): T[] {
  const key = (g: T) => (g.atRiskOldest === null ? -Infinity : g.atRiskOldest + HL_CANDLE_DEPTH * stepS(g.timeframe) - nowS);
  return groups
    .map((g, i) => ({ g, i, k: key(g) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((x) => x.g);
}

// REACH_MARGIN_S (one margin hour inside the measured depth) is imported from venue-candle-reach.ts above.

/** The `T_CAP` predicate as SQL over `s` (signals) and `tf` (timeframe → seconds, W). Integers inlined. */
export function tCapSql(): string {
  return `s.created_at <= ${T_DIAG_END} AND s.created_at + (tf.w + 1) * tf.sec <= ${T_DIAG_END}`;
}

/** `VALUES` rows for the timeframe table — from EVAL_CANDLES / TF_MS, never retyped. */
export function tfValuesSql(): string {
  return Object.keys(EVAL_CANDLES)
    .map((t) => `('${t}', ${TF_MS[t] / 1000}, ${EVAL_CANDLES[t]})`)
    .join(', ');
}

export interface ExpiryGroup {
  exchange: string;
  coin: string;
  timeframe: string;
  todo: number;
  oldest: number;
}

/**
 * The `--expiry-only` group work-list: (exchange, coin, timeframe) with at least one label row whose
 * expiry is NULL, under T_CAP. Label-independent (no `d.label` predicate), the labeler's own eligibility
 * (no 1m, not retired), optional `since` pass selector and CLI filters as parameters.
 */
export function buildExpiryGroupsSql(opts: { since?: number; venue?: string; coin?: string; timeframe?: string }): {
  text: string;
  params: unknown[];
} {
  const where: string[] = [
    'd.ret_at_expiry_pct IS NULL',
    tCapSql(),
    "s.timeframe <> '1m'",
    "s.exchange NOT IN (SELECT exchange_id FROM venues WHERE status = 'retired')",
  ];
  const params: unknown[] = [];
  if (opts.since !== undefined) where.push(`s.created_at > ${Math.floor(opts.since)}`);
  if (opts.venue) { params.push(opts.venue); where.push(`s.exchange = $${params.length}`); }
  if (opts.coin) { params.push(opts.coin); where.push(`s.coin = $${params.length}`); }
  if (opts.timeframe) { params.push(opts.timeframe); where.push(`s.timeframe = $${params.length}`); }
  const text =
    `WITH tf(t, sec, w) AS (VALUES ${tfValuesSql()}) ` +
    `SELECT s.exchange, s.coin, s.timeframe, COUNT(DISTINCT s.id) AS todo, MIN(s.created_at) AS oldest ` +
    `FROM directional_labels d JOIN signals s ON s.id = d.signal_id JOIN tf ON tf.t = s.timeframe ` +
    `WHERE ${where.join(' AND ')} ` +
    `GROUP BY s.exchange, s.coin, s.timeframe ORDER BY s.exchange, MIN(s.created_at), s.coin, s.timeframe`;
  return { text, params };
}

/** The rows of ONE group still missing an expiry, under T_CAP. Label-independent; allow-listed columns. */
export function buildExpiryRowsSql(opts: { since?: number }): string {
  return (
    `WITH tf(t, sec, w) AS (VALUES ${tfValuesSql()}) ` +
    `SELECT DISTINCT s.id, s.created_at, s.price_at_signal ` +
    `FROM directional_labels d JOIN signals s ON s.id = d.signal_id JOIN tf ON tf.t = s.timeframe ` +
    `WHERE s.exchange = $1 AND s.coin = $2 AND s.timeframe = $3 AND d.ret_at_expiry_pct IS NULL AND ${tCapSql()}` +
    (opts.since !== undefined ? ` AND s.created_at > ${Math.floor(opts.since)}` : '') +
    ` ORDER BY s.created_at ASC`
  );
}

/** Fill every spec's row of each signal in one statement; never overwrite a value already there. */
// ── the candle the venue actually serves (2026-09-28) ─────────────────────────────────────────────────
// No adapter aggregates: 30 (venue, timeframe) pairs are fetch-and-relabel — e.g. 2h is served as 1h candles
// on BITGET/GATE/HTX/MEXC/PHEMEX/WEEX/WHITEBIT/XT, 3m as 5m on GATE/MEXC/HTX/PHEMEX/WEEX/XT. The race runs on
// the SERVED candles, so the expiry return, the `-v2` window and the fetch plan are all on the served grid.
// EDGE-LABELER-RACE-WINDOW-V2-W1: the table itself now lives once, in src/lib/tf-support.ts (the hold labeller
// reads the same one); this is the labeller's own name for it, falling back to the requested interval.

/** The candle interval `exchange` actually returns for `timeframe` (ms); the requested interval when the
 *  adapter does not map it. */
export function servedStepMs(exchange: string, timeframe: string): number {
  return servedCandleStepMs(exchange, timeframe) ?? TF_MS[timeframe];
}

// ── the bounded reset (2026-09-28): values written by the pre-fix, index-based expiry code ──────────
// Before 4d172810 `expiryReturnPct` took forwardAsc[W-1] BY INDEX, and the group cache can miss a candle
// (its extension start was off the grid), so some values written between the column's creation and the fix
// deploy are the close of a LATER candle. Reading a stored value to check it would read an outcome value on
// sealed rows, so the reset is BLIND: every value written in the window becomes NULL again, the fixed
// `--expiry-only` fill then recomputes the rows under T_CAP from time-verified candles, and rows past T_CAP
// stay NULL (ruling Q2: "rows between T_CAP and the deploy stay NULL for this wave"). Only this column, only
// rows whose value was written inside the window — never a label, never a row outside it.
/** The column was created 2026-09-27T14:21:14Z; nothing before that can hold a value, so a reset window may
 *  never start earlier (it can only ever touch this wave's own writes). */
export const EXPIRY_COLUMN_CREATED_AT = 1790518874;
export const EXPIRY_RESET_MAX_WINDOW_S = 2 * 86_400;
export const EXPIRY_RESET_SQL =
  `UPDATE directional_labels SET ret_at_expiry_pct = NULL ` +
  `WHERE computed_at >= to_timestamp($1) AND computed_at < to_timestamp($2) AND ret_at_expiry_pct IS NOT NULL ` +
  `RETURNING signal_id`;
export const EXPIRY_RESET_COUNT_SQL =
  `SELECT count(*)::int AS n FROM directional_labels ` +
  `WHERE computed_at >= to_timestamp($1) AND computed_at < to_timestamp($2) AND ret_at_expiry_pct IS NOT NULL`;

/** Refuses any window that is not wholly inside [column creation, now] or is wider than two days. */
export function expiryResetWindow(cli: Pick<Cli, 'expiryResetFrom' | 'expiryResetTo'>, nowS: number): [number, number] {
  const from = cli.expiryResetFrom;
  const to = cli.expiryResetTo;
  if (from === undefined || to === undefined) throw new Error('expiry reset needs BOTH --expiry-reset-written-from and --expiry-reset-written-to');
  if (!(from < to)) throw new Error(`expiry reset window is empty or inverted: ${from} >= ${to}`);
  if (from < EXPIRY_COLUMN_CREATED_AT) throw new Error(`expiry reset may not start before the column existed (${EXPIRY_COLUMN_CREATED_AT})`);
  if (to > nowS) throw new Error(`expiry reset may not end in the future (${to} > ${nowS})`);
  if (to - from > EXPIRY_RESET_MAX_WINDOW_S) throw new Error(`expiry reset window wider than ${EXPIRY_RESET_MAX_WINDOW_S}s`);
  return [from, to];
}

export async function mainExpiryReset(cli: Cli): Promise<void> {
  ensureTable();
  const [from, to] = expiryResetWindow(cli, Math.floor(Date.now() / 1000));
  const before = await dbQuery<{ n: number | string }>(EXPIRY_RESET_COUNT_SQL, [from, to]);
  let reset = 0;
  if (!cli.check) {
    const res = await dbQuery<{ signal_id: number }>(EXPIRY_RESET_SQL, [from, to]);
    reset = res.length;
  }
  console.log(`[${ts()}] EXPIRY RESET ${JSON.stringify({ window: [from, to], written_in_window: Number(before[0]?.n ?? 0), reset, check: cli.check })}`);
}

export const EXPIRY_UPDATE_SQL =
  `UPDATE directional_labels AS d SET ret_at_expiry_pct = v.r ` +
  `FROM unnest($1::int[], $2::double precision[]) AS v(id, r) ` +
  `WHERE d.signal_id = v.id AND d.ret_at_expiry_pct IS NULL ` +
  `RETURNING d.signal_id`;

interface ExpiryCounters {
  groups: number;
  rowsSeen: number;
  filled: number;
  labelRowsUpdated: number;
  pastReach: number;
  unreachable: number;
  budgetSkips: number;
  errors: number;
  wouldFill: number; // --check only
  /** Rows whose race on the SERVED candles would end after T_DIAG_END (a coarser-served venue): never written. */
  sealEdge: number;
}
const ecov: ExpiryCounters = {
  groups: 0, rowsSeen: 0, filled: 0, labelRowsUpdated: 0, pastReach: 0, unreachable: 0, budgetSkips: 0, errors: 0, wouldFill: 0, sealEdge: 0,
};
const expiryByVenue = new Map<string, { filled: number; pastReach: number; unreachable: number }>();
function bumpVenue(venue: string, key: 'filled' | 'pastReach' | 'unreachable', n: number): void {
  const v = expiryByVenue.get(venue) ?? { filled: 0, pastReach: 0, unreachable: 0 };
  v[key] += n;
  expiryByVenue.set(venue, v);
}

/** Exported for tests only — a seam, not an API (the golden-style fixture drives it with the DB and
 *  the adapter replaced at their seams). */
export async function processExpiryGroup(cli: Cli, g: { exchange: string; coin: string; timeframe: string }): Promise<void> {
  const W = EVAL_CANDLES[g.timeframe];
  // the SERVED candle interval: the race, and so the vertical-barrier candle, live on the venue's own grid
  const tfMs = TF_MS[g.timeframe] ? servedStepMs(g.exchange, g.timeframe) : undefined;
  if (!W || !tfMs) return;
  const groupStartMs = Date.now();
  const rows = await dbQuery<{ id: number; created_at: number | string; price_at_signal: number | string }>(
    buildExpiryRowsSql({ since: cli.since }),
    [g.exchange, g.coin, g.timeframe],
  );
  ecov.rowsSeen += rows.length;
  if (rows.length === 0) return;
  const reachDays = expiryReachDays(g.exchange, g.timeframe);
  const reachCutS = Number.isFinite(reachDays) ? Math.floor(groupStartMs / 1000 - reachDays * 86_400 + REACH_MARGIN_S) : -Infinity;
  const reachable = rows.filter((r) => Number(r.created_at) >= reachCutS);
  const past = rows.length - reachable.length;
  ecov.pastReach += past;
  bumpVenue(g.exchange, 'pastReach', past);
  if (cli.check) { ecov.wouldFill += reachable.length; return; }

  const cache = new Map<number, Candle>();
  let coveredUntil = -Infinity;
  const ids: number[] = [];
  const rets: number[] = [];
  let unreachable = 0;
  let sealEdge = 0;
  for (const r of reachable) {
    const entryMs = Number(r.created_at) * 1000;
    // T_CAP's SQL bound uses the requested interval; a coarser-served venue's race runs longer. Its value
    // would carry a post-seal close, so it is never written (NULL = UNRESOLVED, counted).
    if (sealEdgeRow(Number(r.created_at), g.timeframe, tfMs)) { sealEdge++; continue; }
    const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * tfMs;
    try {
      if (neededEnd > coveredUntil) {
        // Extend from the first candle boundary AFTER what is covered — never `coveredUntil + tf`, which is
        // off the grid (created_at is arbitrary seconds) and skips the one candle opening inside that step —
        // and advance only as far as candles actually ARRIVED. One derivation, shared with the race path
        // (directional-labeler.ts nextFetchStartMs / advanceCoverage; EDGE-LABELER-RACE-WINDOW-V2-W1).
        const start = nextFetchStartMs(coveredUntil, tfMs, entryMs); // extend vs new island
        await fetchRangeInto(cache, g.exchange as ExchangeId, g.coin, g.timeframe, start, neededEnd, tfMs);
        coveredUntil = advanceCoverage(coveredUntil, cache.keys(), start, neededEnd);
      }
    } catch (err) {
      if (err instanceof WeightBudgetSkipError) { ecov.budgetSkips++; break; } // the rest stay NULL → next run
      ecov.errors++;
      unreachable++;
      continue;
    }
    const forwardAsc = [...cache.values()].filter((c) => c.time >= entryMs).sort((a, b) => a.time - b.time);
    const v = expiryReturnPct(forwardAsc, W, Number(r.price_at_signal), entryMs, tfMs, groupStartMs);
    if (v === null) { unreachable++; continue; }
    ids.push(Number(r.id));
    rets.push(v);
  }
  ecov.unreachable += unreachable;
  ecov.sealEdge += sealEdge;
  bumpVenue(g.exchange, 'unreachable', unreachable);
  for (let i = 0; i < ids.length; i += INSERT_CHUNK_ROWS) {
    const res = await dbQuery<{ signal_id: number }>(EXPIRY_UPDATE_SQL, [ids.slice(i, i + INSERT_CHUNK_ROWS), rets.slice(i, i + INSERT_CHUNK_ROWS)]);
    ecov.labelRowsUpdated += res.length;
  }
  ecov.filled += ids.length;
  bumpVenue(g.exchange, 'filled', ids.length);
}

async function mainExpiry(cli: Cli): Promise<void> {
  ensureTable();
  const { text, params } = buildExpiryGroupsSql(cli);
  const raw = await dbQuery<{ exchange: string; coin: string; timeframe: string; todo: string | number; oldest: string | number }>(text, params);
  const groups: ExpiryGroup[] = raw.map((r) => ({
    exchange: r.exchange, coin: r.coin, timeframe: r.timeframe, todo: Number(r.todo), oldest: Number(r.oldest),
  }));
  const limited = cli.limitGroups ? groups.slice(0, cli.limitGroups) : groups;
  const byVenue = partitionByVenue(limited);
  // Horizon-first inside a venue: the group whose oldest missing row is oldest is nearest its candle
  // depth, so it is served first (the buildExpiryGroupsSql ORDER BY already sorts by it).
  const venueOrder = [...byVenue.keys()].sort();
  const budget = makeBudget(cli);
  console.log(`[detector-run] run_id=dwr-expiry-${new Date(budget.startMs).toISOString()}`);
  console.log(
    `[${ts()}] EXPIRY backfill start — ${limited.length} groups over ${venueOrder.length} venues, ` +
    `T_CAP=race_end<=${T_DIAG_END}${cli.since !== undefined ? ` since=${cli.since}` : ''} ` +
    `reach_table=${EXPIRY_REACH_DAYS_MEASURED_AT}` +
    `${cli.timeBudgetMin ? ` budget=${cli.timeBudgetMin}m/venue≤${cli.venueBudgetMin ?? '∞'}m` : ''}` +
    `${cli.check ? ' (CHECK — no writes)' : ''}`,
  );
  let summaries: VenueRunSummary[] = [];
  await runAsBatch(async () => {
    summaries = await runVenueRotation(
      venueOrder,
      byVenue,
      budget,
      async (g) => {
        ecov.groups++;
        try {
          await processExpiryGroup(cli, g);
        } catch (err) {
          ecov.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${ts()}] expiry group ${g.exchange}:${g.coin}:${g.timeframe} error: ${msg.slice(0, 200)}`);
        }
        if (ecov.groups % 200 === 0) {
          console.log(`[${ts()}] ${ecov.groups}/${limited.length} groups | filled ${ecov.filled} | past_reach ${ecov.pastReach} | unreachable ${ecov.unreachable}`);
        }
      },
      console.log,
      Date.now,
      (venue) => {
        const v = expiryByVenue.get(venue) ?? { filled: 0, pastReach: 0, unreachable: 0 };
        return `filled=${v.filled} past_reach=${v.pastReach} unreachable=${v.unreachable}`;
      },
      { stopRequested: isStopRequested },
    );
  }, 'dwr-expiry-backfill');
  const outcome = deriveRunOutcome(summaries, budget.globalExpired());
  // Cardinalities only — never a return value.
  console.log(`[${ts()}] EXPIRY DONE ${JSON.stringify({ outcome, ...ecov, byVenue: Object.fromEntries(expiryByVenue) })}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 — the historical `-v2` relabel and the `race_gap_candles` annotation.
//
// ADD-ONLY, by construction and by test: the relabel INSERTs `-v2` rows (ON CONFLICT DO NOTHING) and never reads,
// writes or updates a `-v1` row; the annotation UPDATEs exactly one column, `race_gap_candles`, on `-v1` rows where
// it is NULL — never a label column, never `computed_at` (ruling LRW-Q7-C). Neither prints an outcome tally, and
// above T_CAP only totals (LRW-Q7-B). Scope = every eligible signal (LRW-Q5 = B). Runs host-detached per venue in
// the 18:30–02:15Z slots (LRW-Q13, ops/label-backfill/lrw-relabel-runner.sh), DB-state resumable.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The registered refusal classes (registration §3, §3.2; derived once in lrw/registered.ts): every eligible
 *  signal the relabel visits and cannot write is ONE manifest line `LRW_MANIFEST <signal_id> <class>` — a coverage
 *  fact, never a fill. A signal the run did not finish (a fetch error, a budget skip, the deadline) is NOT a class:
 *  it is counted (`errors` / `budgetSkips` / `cutShort`) and the run cannot report convergence. */
export type RelabelClass = ManifestClass;

interface RelabelCoverage {
  groups: number; signalsSeen: number; todo: number; labeled: number; written: number;
  classes: Record<string, number>;
  nonV2Refused: number; // a row whose spec is not -v2 reached the INSERT — refused, never written (expected 0)
  budgetSkips: number; errors: number; wouldWrite: number;
  cutShort: number; // groups left part-way by the deadline or a stop request (the rest of the group: next pass)
  unservedGroups: number; // market × timeframe pairs the venue refuses outright while it serves a control market
}
const rcov: RelabelCoverage = {
  groups: 0, signalsSeen: 0, todo: 0, labeled: 0, written: 0, classes: {}, nonV2Refused: 0,
  budgetSkips: 0, errors: 0, wouldWrite: 0, cutShort: 0, unservedGroups: 0,
};
/** A copy of the relabel's counters — a test seam, not an API. */
export function _relabelCoverageForTest(): Readonly<RelabelCoverage> {
  return { ...rcov, classes: { ...rcov.classes } };
}
function manifest(signalId: number, cls: RelabelClass): void {
  rcov.classes[cls] = (rcov.classes[cls] ?? 0) + 1;
  console.log(`LRW_MANIFEST ${signalId} ${cls}`);
}

/** The `-v2` INSERT — the ONLY statement the relabel writes with (a test pins: no UPDATE, no DELETE). */
export const RELABEL_INSERT_SQL_HEAD = `INSERT INTO directional_labels (${INSERT_COLUMNS.join(', ')}) VALUES `;
export const RELABEL_INSERT_SQL_TAIL = ' ON CONFLICT (signal_id, barrier_spec) DO NOTHING RETURNING signal_id';

/**
 * A venue's refusal of ONE market × timeframe, told apart from a transient fault. Measured on the relabel's first
 * night (2026-10-02): WhiteBIT "Market is not available", BingX 109418 "offline" / 109415 "pause", HTX
 * `status=error`, OKX 51000 "Parameter bar error" on 8h — each refused on every pass, so the venue could never
 * converge. A market is UNSERVED iff its own most recent page is refused, a control market (BTC 1h) on the same
 * venue is served when asked right after, AND the market's page is then refused AGAIN with the same error key: the
 * venue serves it no candles at all — fewer than 30 contiguous σ windows, the registered `unreachable:history`
 * (registration §0), exactly as a venue that answers `[]` (Bybit 8h) is classed. Night 2 (2026-10-03) is why the
 * control is never cached and the refusal must repeat: with a 10-min control cache and one market probe, a Bybit
 * rate limit (10006 "Too many visits" — an untyped error) was classed once (BYBIT ZEC 3m), while every genuine
 * refusal carried the same key on every probe of both nights. A rate limit, a budget skip, a venue that refuses
 * its control, or a refusal that does not repeat is never a class: it stays a counted error. Re-measured on every
 * pass, and the last class wins, so a paused market that is served on a later pass is written.
 */
const CONTROL_COIN = 'BTC';
const CONTROL_TIMEFRAME = '1h';
type PageProbe = { kind: 'served' } | { kind: 'transient' } | { kind: 'refused'; key: string };
function isTransient(err: unknown): boolean {
  if (err instanceof WeightBudgetSkipError || err instanceof OwnStopError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'UPSTREAM_RATE_LIMIT' || code === 'WEIGHT_BUDGET_SKIP';
}
/** One label-free token for an error: its stable code, else its class and the first words of its message. */
export function errKey(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown; constructor?: { name?: string } } | null;
  if (typeof e?.code === 'string') return e.code;
  return `${e?.constructor?.name ?? 'Error'}:${String(e?.message ?? err).replace(/\s+/g, ' ').slice(0, 100)}`;
}
async function recentPage(exchange: string, coin: string, timeframe: string): Promise<PageProbe> {
  const stepMs = servedStepMs(exchange, timeframe);
  try {
    await ownRateGate();
    await getAdapter(exchange as ExchangeId).getCandles(coin, timeframe, Date.now() - 5 * stepMs, exchange === 'HL' ? getDexForCoin(coin) : undefined);
    return { kind: 'served' };
  } catch (err) {
    if (err instanceof OwnStopError) throw err;
    return isTransient(err) ? { kind: 'transient' } : { kind: 'refused', key: errKey(err) };
  }
}
export async function marketUnserved(exchange: string, coin: string, timeframe: string): Promise<boolean> {
  const first = await recentPage(exchange, coin, timeframe);
  if (first.kind !== 'refused') return false;
  if ((await recentPage(exchange, CONTROL_COIN, CONTROL_TIMEFRAME)).kind !== 'served') return false;
  const again = await recentPage(exchange, coin, timeframe);
  return again.kind === 'refused' && again.key === first.key;
}

/**
 * Venues that REFUSE a candle page older than a fixed count of SERVED candles back from now, where every other
 * venue answers such a range empty. Measured 2026-10-04 from signal-1 on the endpoint the adapter calls: GATE
 * `/api/v4/futures/usdt/candlesticks` answers 400 `INVALID_PARAM_VALUE` "Candlestick too long ago. Maximum 10000
 * points recently are allowed" (BTC_USDT 15m served from now−103 d, refused from now−106 d; 5m 33 d / 35 d). On
 * night 2 the relabel counted GATE 3m / 5m / 15m groups — BTC, ETH and SOL among them — as errors: the σ history
 * of a signal near the depth edge starts past the limit, so those groups errored on every pass and could never
 * converge. The relabel asks such a venue no further back than the limit less a margin; the σ history is
 * then what the venue serves, and prepareRaceV2 classes it as registered (≥ 30 contiguous windows raced, else
 * unreachable:history; a window past the limit unreachable:depth).
 */
const HISTORY_REFUSED_BEYOND_CANDLES: Readonly<Record<string, number>> = { GATE: 10_000 };
/** Candles kept inside the limit: the limit slides with the clock while a group is fetched. */
const HISTORY_REFUSAL_MARGIN_CANDLES = 20;
/** The earliest open time `venue` answers on a `stepMs` grid at `nowMs`; −∞ for a venue with no such limit. */
function historyFloorMs(venue: string, stepMs: number, nowMs: number): number {
  const n = HISTORY_REFUSED_BEYOND_CANDLES[venue];
  return n === undefined ? -Infinity : nowMs - (n - HISTORY_REFUSAL_MARGIN_CANDLES) * stepMs;
}

export async function processRelabelGroup(
  cli: Cli,
  g: { exchange: string; coin: string; timeframe: string },
  ctx: { retired: ReadonlySet<string>; nowMs: number },
): Promise<void> {
  const W = EVAL_CANDLES[g.timeframe];
  const tfMs = TF_MS[g.timeframe];
  if (!W || !tfMs) return;
  const stepMs = servedStepMs(g.exchange, g.timeframe);
  const v2Specs = BARRIER_SPECS_V2.filter((v) => cli.specs.some((s) => s.tau === v.tau));
  if (v2Specs.length === 0) return;
  const params: unknown[] = [g.exchange, g.coin, g.timeframe];
  const bounds: string[] = [];
  if (cli.since !== undefined) bounds.push(` AND created_at > ${Math.floor(cli.since)}`);
  bounds.push(` AND created_at <= ${relabelUntil(cli.until)}`);
  const sigs = await dbQuery<SignalRow>(
    `SELECT id, created_at, price_at_signal, signal, pfe_return_pct, mae_return_pct FROM signals
     WHERE exchange = $1 AND coin = $2 AND timeframe = $3
       AND signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL${bounds.join('')}
     ORDER BY created_at ASC`,
    params,
  );
  rcov.signalsSeen += sigs.length;
  if (sigs.length === 0) return;
  const existing = await dbQuery<{ signal_id: number; barrier_spec: string }>(
    `SELECT signal_id, barrier_spec FROM directional_labels WHERE barrier_spec = ANY($1) AND signal_id = ANY($2)`,
    [v2Specs.map((v) => v.spec), sigs.map((x) => x.id)],
  );
  const done = new Set(existing.map((e) => `${e.signal_id}|${e.barrier_spec}`));
  const todo = sigs.filter((x) => v2Specs.some((v) => !done.has(`${x.id}|${v.spec}`)));
  rcov.todo += todo.length;
  if (todo.length === 0) return;
  if (cli.check) {
    for (const x of todo) for (const v of v2Specs) if (!done.has(`${x.id}|${v.spec}`)) rcov.wouldWrite++;
    return;
  }
  // Coverage classes decided without a fetch (registration §3): a retired venue, a pending adapter cell (none
  // since T_ADAPTER), and a window past the venue's measured candle depth.
  if (ctx.retired.has(g.exchange)) { for (const x of todo) manifest(x.id, 'unreachable:retired'); return; }
  if (ADAPTER_PENDING_CELLS.has(`${g.exchange}:${g.timeframe}`)) {
    for (const x of todo) manifest(x.id, 'unreachable:adapter-pending');
    return;
  }
  // The BITGET 2h / 8h depths in EXPIRY_REACH_DAYS were measured (2026-09-27) through the history fallback that
  // OPS-ADAPTER-HISTORY-ANCHOR-W1 replaced at T_ADAPTER; the registration amendment of 2026-10-01 (OAH-Q8) has the
  // relabel ATTEMPT that cell, so the fetch decides its class (unreachable:history / refused), never a stale depth.
  const reachDays = ADAPTER_CELL.has(`${g.exchange}:${g.timeframe}`) ? Infinity : expiryReachDays(g.exchange, g.timeframe);
  const reachCutS = Number.isFinite(reachDays) ? Math.floor(ctx.nowMs / 1000 - reachDays * 86_400 + REACH_MARGIN_S) : -Infinity;
  const live = todo.filter((x) => {
    if (x.created_at >= reachCutS) return true;
    manifest(x.id, 'unreachable:depth');
    return false;
  });
  if (live.length === 0) return;

  // ONE corrected cache per group on the SERVED grid — merged islands, extend from the next grid boundary after
  // the last candle that ARRIVED, never re-ask a range the venue answered empty (the CH2 derivations).
  const groupStartMs = Date.now();
  const cache = new Map<number, Candle>();
  let coveredUntil = -Infinity;
  let probedThrough = -Infinity;
  const rows: unknown[][] = [];
  let errorLogged = false;
  for (const x of live) {
    // the 02:15Z hard stop and a deploy's SIGTERM act INSIDE a group, not only between groups: what is computed
    // so far is written below, the rest is the next pass's.
    if (ownStopDue()) { rcov.cutShort++; break; }
    const entryMs = x.created_at * 1000;
    const neededStart = entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * stepMs;
    const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * stepMs;
    try {
      if (neededEnd > Math.max(coveredUntil, probedThrough)) {
        const start = Math.max(nextFetchStartMs(coveredUntil, stepMs, neededStart), probedThrough + 1, historyFloorMs(g.exchange, stepMs, Date.now()));
        if (start <= neededEnd) {
          const answered = await fetchRangeInto(cache, g.exchange as ExchangeId, g.coin, g.timeframe, start, neededEnd, stepMs);
          const before = coveredUntil;
          coveredUntil = advanceCoverage(coveredUntil, cache.keys(), start, neededEnd);
          if (answered && coveredUntil === before) probedThrough = neededEnd;
        }
      }
    } catch (err) {
      if (err instanceof OwnStopError) { rcov.cutShort++; break; }
      if (err instanceof WeightBudgetSkipError) { rcov.budgetSkips++; break; } // the rest stay absent → next run
      if (!isTransient(err)) {
        let unserved = false;
        try {
          unserved = await marketUnserved(g.exchange, g.coin, g.timeframe);
        } catch (probeErr) {
          if (probeErr instanceof OwnStopError) { rcov.cutShort++; break; }
        }
        if (unserved) {
          // the venue serves this market × timeframe no candles while it serves its control: no σ history
          console.log(`LRW_UNSERVED ${g.exchange}:${g.coin}:${g.timeframe} ${errKey(err)}`);
          rcov.unservedGroups++;
          for (const y of live.slice(live.indexOf(x))) manifest(y.id, 'unreachable:history');
          break;
        }
      }
      rcov.errors++;
      if (!errorLogged) { console.log(`LRW_ERROR ${g.exchange}:${g.coin}:${g.timeframe} ${errKey(err)}`); errorLogged = true; }
      continue;
    }
    const fullForward = [...cache.values()].filter((c) => c.time >= entryMs).sort((a, b) => a.time - b.time);
    const prep = prepareRaceV2(cache, fullForward, entryMs, W, stepMs, groupStartMs);
    if (prep.kind === 'deferred') { manifest(x.id, 'deferred'); continue; }
    if (prep.kind === 'refused') { manifest(x.id, `refused:${prep.reason}` as RelabelClass); continue; }
    if (prep.kind === 'unreachable') { manifest(x.id, `unreachable:${prep.reason}` as RelabelClass); continue; }
    const expiry = sealEdgeRow(x.created_at, g.timeframe, stepMs)
      ? null
      : expiryReturnPct(fullForward, W, x.price_at_signal, entryMs, stepMs, groupStartMs);
    for (const v of v2Specs) {
      if (done.has(`${x.id}|${v.spec}`)) continue;
      const bp = barrierPct(prep.sigma, v.tau);
      const race = runTripleBarrier(x.signal, x.price_at_signal, prep.window, bp, W);
      rows.push([x.id, v.spec, race.label, race.ambiguousCandle, false, race.tHitCandles, x.pfe_return_pct, x.mae_return_pct, bp, expiry, 0]);
      rcov.labeled++;
    }
  }
  // ADD-ONLY guard at the write: a row whose spec is not a -v2 spec is refused here, counted, never written.
  const v2Names = new Set<string>(BARRIER_SPECS_V2.map((v) => v.spec));
  const safe = rows.filter((r) => {
    if (v2Names.has(String(r[1]))) return true;
    rcov.nonV2Refused++;
    return false;
  });
  for (let i = 0; i < safe.length; i += INSERT_CHUNK_ROWS) {
    const chunk = safe.slice(i, i + INSERT_CHUNK_ROWS);
    const values: string[] = [];
    const flat: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * INSERT_COLUMNS.length;
      values.push(`(${INSERT_COLUMNS.map((_, k) => `$${b + k + 1}`).join(',')})`);
      flat.push(...r);
    });
    const res = await dbQuery<{ signal_id: number }>(RELABEL_INSERT_SQL_HEAD + values.join(',') + RELABEL_INSERT_SQL_TAIL, flat);
    rcov.written += res.length;
  }
}

/** The `--relabel-v2` run (exported as a test seam: the order a run APPLIES is asserted on it, not on a helper). */
export async function mainRelabel(cli: Cli): Promise<void> {
  if (!cli.check) ensureTable(); // --check runs no DDL (an ALTER … IF NOT EXISTS still takes ACCESS EXCLUSIVE)
  setOwnRequestRate(cli.maxReqPerMin);
  const until = relabelUntil(cli.until);
  const v2Specs = BARRIER_SPECS_V2.filter((v) => cli.specs.some((s) => s.tau === v.tau)).map((v) => v.spec);
  const orderNowS = Math.floor(Date.now() / 1000);
  const stepS = (tf: string) => servedStepMs('HL', tf) / 1000;
  const atRiskAfter = cli.order === 'depth-deadline'
    ? Object.fromEntries(Object.keys(TF_MS).map((tf) => [tf, orderNowS - HL_CANDLE_DEPTH * stepS(tf)]))
    : undefined;
  const { text, params } = buildRelabelGroupsSql({ v2Specs, since: cli.since, until, venue: cli.venue, coin: cli.coin, timeframe: cli.timeframe, atRiskAfter });
  const raw = await dbQuery<{ exchange: string; coin: string; timeframe: string; todo: string | number; oldest: string | number; at_risk_oldest?: string | number | null }>(text, params);
  const listed = raw.map((r) => ({
    exchange: r.exchange, coin: r.coin, timeframe: r.timeframe, todo: Number(r.todo), oldest: Number(r.oldest),
    atRiskOldest: r.at_risk_oldest === null || r.at_risk_oldest === undefined ? null : Number(r.at_risk_oldest),
  }));
  const groups = cli.order === 'depth-deadline' ? depthDeadlineOrder(listed, orderNowS, stepS) : listed;
  const limited = cli.limitGroups ? groups.slice(0, cli.limitGroups) : groups;
  const retired = new Set(
    (await dbQuery<{ exchange_id: string }>(`SELECT exchange_id FROM venues WHERE status = 'retired'`)).map((r) => r.exchange_id),
  );
  const byVenue = partitionByVenue(limited);
  const venueOrder = [...byVenue.keys()].sort();
  const budget = makeBudget(cli);
  setOwnDeadline(cli.timeBudgetMin ? budget.startMs + cli.timeBudgetMin * 60_000 : Infinity);
  console.log(`[detector-run] run_id=lrw-relabel-${new Date(budget.startMs).toISOString()}`);
  console.log(
    `[${ts()}] RELABEL -v2 start — ${limited.length} groups over ${venueOrder.length} venues, specs=${v2Specs.join(',')}` +
    `${cli.since !== undefined ? ` since=${cli.since}` : ''} until=${until}` +
    ` adapter_pending=${[...ADAPTER_PENDING_CELLS].join(',')}` +
    `${cli.maxReqPerMin ? ` own_rate=${cli.maxReqPerMin}/min` : ''}` +
    ` order=${cli.order ?? 'horizon-first'}` +
    `${cli.timeBudgetMin ? ` budget=${cli.timeBudgetMin}m/venue≤${cli.venueBudgetMin ?? '∞'}m` : ''}` +
    `${cli.check ? ' (CHECK — no writes)' : ''}`,
  );
  const nowMs = Date.now();
  let summaries: VenueRunSummary[] = [];
  await runAsBatch(async () => {
    summaries = await runVenueRotation(
      venueOrder, byVenue, budget,
      async (g) => {
        rcov.groups++;
        try {
          await processRelabelGroup(cli, g, { retired, nowMs });
        } catch (err) {
          rcov.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${ts()}] relabel group ${g.exchange}:${g.coin}:${g.timeframe} error: ${msg.slice(0, 200)}`);
        }
        if (rcov.groups % 200 === 0) console.log(`[${ts()}] ${rcov.groups}/${limited.length} groups | written ${rcov.written}`);
      },
      console.log, Date.now, undefined, { stopRequested: isStopRequested },
    );
  }, 'lrw-relabel-v2');
  let outcome = deriveRunOutcome(summaries, budget.globalExpired());
  // a group cut short in the LAST group leaves the rotation 'complete' — it is not
  if (outcome === 'complete' && rcov.cutShort > 0) outcome = isStopRequested() ? 'stopped' : 'global-budget';
  // Cardinalities only — no outcome tally (LRW-Q7-D).
  console.log(`[${ts()}] RELABEL DONE ${JSON.stringify({ outcome, ...rcov })}`);
}

/** The annotation's statements — the ONLY SQL it runs (a test pins: SET names `race_gap_candles` alone, never a
 *  label column, never `computed_at`; `-v1` only; NULL only). ctid keyset paging keeps each batch a short scan. */
export const ANNOTATE_SELECT_SQL =
  `SELECT ctid::text AS t, signal_id, barrier_spec FROM directional_labels ` +
  `WHERE barrier_spec IN ('tau0.5-floor0.30-v1', 'tau1.0-floor0.30-v1', 'tau2.0-floor0.30-v1') ` +
  `AND race_gap_candles IS NULL AND ctid > $1::tid ORDER BY ctid LIMIT $2`;
export const ANNOTATE_UPDATE_SQL =
  `UPDATE directional_labels AS l SET race_gap_candles = v.gap ` +
  `FROM unnest($1::tid[], $2::smallint[]) AS v(t, gap) ` +
  `WHERE l.ctid = v.t AND l.race_gap_candles IS NULL ` +
  `AND l.barrier_spec IN ('tau0.5-floor0.30-v1', 'tau1.0-floor0.30-v1', 'tau2.0-floor0.30-v1') RETURNING 1`;

/** `outcome`: 'complete' = the ctid scan reached the end of the table; 'stopped' (SIGTERM) and 'global-budget'
 *  (the deadline) left rows unscanned — never convergence. */
interface AnnotateCoverage { outcome: 'complete' | 'stopped' | 'global-budget'; scanned: number; matched: number; annotated: number; unmatched: number; batches: number; wouldAnnotate: number }

export async function runAnnotation(
  gaps: ReadonlyMap<string, number>,
  opts: { batch: number; check: boolean; deadlineMs?: number },
): Promise<AnnotateCoverage> {
  const a: AnnotateCoverage = { outcome: 'complete', scanned: 0, matched: 0, annotated: 0, unmatched: 0, batches: 0, wouldAnnotate: 0 };
  if (!opts.check) {
    // ruling LRW-Q13: every batch waits at most 5 s for a lock — set per process (PGOPTIONS, the runner). A run
    // without it refuses rather than queue behind the nightly.
    const lt = await dbQuery<{ v: string }>(`SELECT current_setting('lock_timeout') AS v`);
    if (lt[0]?.v !== '5s') throw new Error(`lock_timeout is '${lt[0]?.v}', not '5s' — run with PGOPTIONS='-c lock_timeout=5s'`);
  }
  let last = '(0,0)';
  for (;;) {
    if (isStopRequested()) { a.outcome = 'stopped'; break; }
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) { a.outcome = 'global-budget'; break; }
    const page = await dbQuery<{ t: string; signal_id: number | string; barrier_spec: string }>(ANNOTATE_SELECT_SQL, [last, opts.batch]);
    if (page.length === 0) break;
    a.scanned += page.length;
    last = page[page.length - 1].t;
    const tids: string[] = [];
    const vals: number[] = [];
    for (const r of page) {
      const gap = gaps.get(`${Number(r.signal_id)}|${r.barrier_spec}`);
      if (gap === undefined) { a.unmatched++; continue; }
      tids.push(r.t);
      vals.push(gap);
    }
    a.matched += tids.length;
    a.batches++;
    if (tids.length === 0) continue;
    if (opts.check) { a.wouldAnnotate += tids.length; continue; }
    const res = await dbQuery(ANNOTATE_UPDATE_SQL, [tids, vals]);
    a.annotated += res.length;
  }
  return a;
}

async function mainAnnotate(cli: Cli): Promise<void> {
  if (!cli.check) ensureTable(); // --check runs no DDL
  const startMs = Date.now();
  const files = loadAnnotationSources(cli.annotateGaps!.split(',').map((x) => x.trim()).filter(Boolean));
  const gaps = parseGapWorklists(files);
  console.log(`[${ts()}] ANNOTATE race_gap_candles start — ${gaps.size} worklist rows from ${files.length} pinned file(s) ${files.map((f) => f.sha256.slice(0, 12)).join(',')}, batch=${cli.annotateBatch}${cli.timeBudgetMin ? ` budget=${cli.timeBudgetMin}m` : ''}${cli.check ? ' (CHECK — no writes)' : ''}`);
  const a = await runAnnotation(gaps, {
    batch: cli.annotateBatch, check: cli.check, deadlineMs: cli.timeBudgetMin ? startMs + cli.timeBudgetMin * 60_000 : undefined,
  });
  // Totals only — never a value distribution (LRW-Q7-B).
  console.log(`[${ts()}] ANNOTATE DONE ${JSON.stringify({ ...a, worklistRows: gaps.size, check: cli.check })}`);
}

/** Per-venue label frontier (MAX labeled created_at) — the F1 rotation key. */
async function loadVenueFrontier(): Promise<Map<string, number>> {
  const rows = await dbQuery<{ exchange: string; frontier: string | number | null }>(
    `SELECT s.exchange, MAX(s.created_at) FILTER (WHERE d.signal_id IS NOT NULL) AS frontier
     FROM signals s
     LEFT JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = '${FRESHNESS_BARRIER_SPEC}'
     WHERE s.signal IN ('BUY','SELL') AND s.pfe_return_pct IS NOT NULL AND s.timeframe <> '1m'
     GROUP BY 1`,
  );
  return new Map(rows.map((r) => [r.exchange, Number(r.frontier ?? 0)]));
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.expiryOnly && (cli.expiryResetFrom !== undefined || cli.expiryResetTo !== undefined)) return mainExpiryReset(cli);
  if (cli.expiryOnly) return mainExpiry(cli);
  if (cli.relabelV2 && cli.annotateGaps) throw new Error('--relabel-v2 and --annotate-gaps are separate runs');
  if (cli.relabelV2) return mainRelabel(cli);
  if (cli.annotateGaps) return mainAnnotate(cli);
  ensureTable();
  const groups = await loadGroups(cli);
  const frontier = await loadVenueFrontier();
  const byVenue = partitionByVenue(groups);
  const nowSec = Math.floor(Date.now() / 1000);
  // OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R1 — within a venue: horizon-first, then breadth across coins
  // (never an alphabetical prefix); across venues: the FULL-eligible set first, each class SLO-ordered.
  for (const [venue, list] of byVenue) byVenue.set(venue, orderGroupsForVenue(list, nowSec));
  const venueOrder = orderVenuesFullPanelFirst([...byVenue.keys()], frontier, nowSec);
  const budget = makeBudget(cli);
  // ONE run identity, PRINTED BY THE PRODUCER — never re-derived by the consumer from a log
  // timestamp. `budget.startMs` and the `DWR backfill start` line's own `ts()` are milliseconds
  // apart and differently formatted, so a consumer reconstructing the id would compare two
  // strings that are never equal and refuse every genuine forward.
  console.log(`[detector-run] run_id=dwr-${new Date(budget.startMs).toISOString()}`);
  console.log(
    `[${ts()}] DWR backfill start — ${groups.length} groups over ${venueOrder.length} venues ` +
    `(rotation: ${venueOrder.join('>')}), specs=[${cli.specs.map((s) => s.spec).join(', ')}]` +
    `${cli.lookbackDays ? ` lookback=${cli.lookbackDays}d` : ''}` +
    `${cli.timeBudgetMin ? ` budget=${cli.timeBudgetMin}m/venue≤${cli.venueBudgetMin ?? '∞'}m` : ''}` +
    `${cli.check ? ' (CHECK — no writes)' : ''}`,
  );
  // One line per venue, before any work: what the run is about to face. `past_horizon_todo` counts
  // unlabelled rows already older than the venue's candle depth — lost to its API, reported, never
  // retried — so the per-night horizon-crossing figure is read from the producer, not reconstructed.
  console.log(worklistPreamble());
  for (const venue of venueOrder) {
    const s = worklistStats(byVenue.get(venue) ?? [], nowSec);
    console.log(
      `[worklist] ${venue}: groups=${s.groups} critical=${s.critical} labelable_todo=${s.labelable} ` +
      `past_horizon_todo=${s.pastHorizon}${isFullPanelVenue(venue) ? ' full_panel=1' : ''}`,
    );
  }

  // Per-venue counter snapshots feed the load-bearing summary line (F4).
  let snap = { ...cov };
  const venueDelta = (venue: string): string => {
    const d = {
      written: cov.written - snap.written,
      labeled: cov.labeled - snap.labeled,
      noKlines: cov.noKlines - snap.noKlines,
      budgetSkips: cov.budgetSkips - snap.budgetSkips,
      errors: cov.errors - snap.errors,
    };
    snap = { ...cov };
    const fr = frontierByVenue.get(venue);
    return `written=${d.written} labeled=${d.labeled} noKlines=${d.noKlines} budgetSkips=${d.budgetSkips} errors=${d.errors} frontier=${fr ? new Date(fr * 1000).toISOString() : 'unchanged'}`;
  };

  // A2 circuit-breaker only in the bounded freshness run — deep backfill must sweep
  // every venue to completion, so it never trips (undefined → disabled).
  const circuit = cli.venueBudgetMin !== undefined
    ? {
        minGroupsBeforeTrip: envPosInt('LABELER_CB_MIN_GROUPS', 25),
        maxErrors: envPosInt('LABELER_CB_MAX_ERRORS', 150),
        errorToWriteRatio: envPosInt('LABELER_CB_ERR_WRITE_RATIO', 8),
      }
    : undefined;

  let summaries: VenueRunSummary[] = [];
  await runAsBatch(async () => {
    summaries = await runVenueRotation(
      venueOrder,
      byVenue,
      budget,
      async (g) => {
        cov.groups++;
        try {
          await processGroup(cli, g);
        } catch (err) {
          cov.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${ts()}] group ${g.exchange}:${g.coin}:${g.timeframe} error: ${msg}`);
        }
        if (cov.groups % 200 === 0) {
          console.log(`[${ts()}] ${cov.groups}/${groups.length} groups | labeled ${cov.labeled} | written ${cov.written} | noKlines ${cov.noKlines} | budgetSkips ${cov.budgetSkips}`);
        }
      },
      console.log,
      Date.now,
      venueDelta,
      { stopRequested: isStopRequested, progress: () => ({ written: cov.written, errors: cov.errors }), circuit },
    );
  }, 'dwr-backfill');

  // Capacity-honesty (Objective #2), now under the DETECTOR_ENVELOPE contract (CH3).
  //
  // The emit gate WAS `if (cli.timeBudgetMin !== undefined)` — "were budgets configured", which
  // is true on every nightly and says nothing about whether this run finished. It is now the
  // real question, asked of the real budget: did it EXPIRE. And the envelope is emitted on every
  // budgeted run, not only on a shortfall, because a run that could not measure must SAY so —
  // silence is what let a truncated night look like a clean one.
  if (cli.timeBudgetMin !== undefined) {
    // THE DETECTOR MAY NOT KILL THE RUN IT DESCRIBES.
    //
    // Measured 2026-08-26: `buildEnvelope` threw ENOENT here on every nightly since 2026-08-22,
    // AFTER the rotation had completed and written its rows — so a fully successful 100-minute
    // label pass exited 1, `nightly-carry-labeler` logged `STEP directional-labels FAILED`, and
    // the `DONE` line never printed. OPS-DETECTOR-ENVELOPE-RUNTIME-W1 removed that specific cause
    // (the embedded mirror in detector-envelope.ts), but the SHAPE is the defect: a guard on a
    // path that has already done its work REFUSES, it does not THROW.
    //
    // A failure here is deliberately NOT laundered into a pass. Emitting nothing is exactly what
    // `directional-label-freshness.py` reads as `CAPACITY_SIGNAL INDETERMINATE`, so the dark case
    // stays visible to the consumer that already alerts on it — while the labeling work, which is
    // a different question entirely, keeps its own honest exit code.
    try {
      emitCapacityEnvelope(cli, budget, summaries, venueOrder, frontier, nowSec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[detector-envelope] REFUSING: could not build the capacity envelope: ${msg}`);
    }
  }

  // Cardinalities only (LRW-Q7-D): no win / loss / timeout / same-candle tally — see the Coverage interface.
  for (const line of formatV2Tokens(cov)) console.log(line);
  console.log(`[${ts()}] DONE ${JSON.stringify({ ...cov, noKlinesByVenue: Object.fromEntries(noKlinesByVenue) })}`);
}

/**
 * Capacity-honesty (Objective #2), under the DETECTOR_ENVELOPE contract (CH3). Extracted from
 * `main` by OPS-DETECTOR-ENVELOPE-RUNTIME-W1 so the emission has a seam its caller can refuse at.
 */
function emitCapacityEnvelope(
  cli: { timeBudgetMin?: number },
  budget: { globalExpired: () => boolean; startMs: number },
  summaries: VenueRunSummary[],
  venueOrder: string[],
  frontier: Map<string, number>,
  nowSec: number,
): void {
  const budgetExpired = budget.globalExpired();
  const cap = detectCapacityShortfall(summaries, venueOrder, frontier, nowSec, defaultSloHoursFor, 24, budgetExpired);
  const startedAt = new Date(budget.startMs).toISOString();
  const env = buildEnvelope({
    detector: 'directional-label-capacity',
    // The run's IDENTITY, derived from its own start instant — the consumer re-derives the
    // same string from the log's last `DWR backfill start` line, so a marker from an earlier
    // run cannot masquerade as this one's.
    runId: `dwr-${startedAt}`,
    runStartedAt: startedAt,
    runOutcome: cap.runOutcome,
    producedAt: new Date(nowSec * 1000).toISOString(),
    observationWindow: { from: startedAt, to: new Date(nowSec * 1000).toISOString() },
    verdict: cap.verdict,
    // EVIDENCE, not narrative. Every value here is measured by this run, and the schema caps
    // string values at a word count that no sentence about mechanism can fit inside.
    evidence: {
      unreached_in_danger: cap.unreachedInDanger.join(',') || 'none',
      unreached_count: cap.unreachedInDanger.length,
      est_venue_min_short: cap.estVenueMinShort,
      venues_reached: summaries.length,
      venues_total: venueOrder.length,
      // OPS-BITMART-RETIRE-W1 R2a — name the subject. A venue whose breaker tripped is excluded from
      // the verdict above; these say WHICH and WHY, so the alert never renders a bare venue-circuit-break.
      excluded_venues: cap.excludedVenues.map((e) => e.venue).join(',') || 'none',
      excluded_reason: cap.excludedVenues.map((e) => e.outcome).join(',') || 'none',
      excluded_count: cap.excludedVenues.length,
      rotation: venueOrder.join('>'),
      elapsed_min: Math.round(((Date.now() - budget.startMs) / 60_000) * 10) / 10,
      budget_min: cli.timeBudgetMin,
      budget_expired: budgetExpired,
    },
  });
  // Refuse to emit a signal we would ourselves reject. A producer that can publish a
  // non-conforming envelope makes the consumer's validation the only guard, and one guard is
  // how the class returns.
  if (!isConforming(env)) {
    console.error(`[detector-envelope] REFUSING to emit a non-conforming envelope for ${env.detector}`);
  } else {
    console.log(`[detector-envelope] ${JSON.stringify(env)}`);
  }
}

if (require.main === module) {
  // OPS-LABEL-FRESHNESS-W1 R2 (A1): SIGTERM/SIGINT → checkpoint at the next venue/group
  // boundary (resumable via DB state) instead of a mid-venue decapitation on deploy recreate.
  installGracefulStop();
  // OPS-SCRIPT-EXIT-LIFECYCLE-W1: the success path called closeDb() but never
  // exited — and closeDb() is fire-and-forget, so the drain could not be awaited
  // either. runScript awaits the drain, then exits.
  void runScript('backfill-directional-labels', () => runAsCaller('dwr-backfill', main));
}
