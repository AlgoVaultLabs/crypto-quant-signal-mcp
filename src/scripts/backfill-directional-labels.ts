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
  DIRECTIONAL_LABELS_DDL_PG,
} from './directional-labeler.js';
import { T_DIAG_END } from './ads1/spec.js';
import { servedIntervalMs as SERVED_HL } from '../lib/adapters/hyperliquid.js';
import { servedIntervalMs as SERVED_BINANCE } from '../lib/adapters/binance.js';
import { servedIntervalMs as SERVED_BYBIT } from '../lib/adapters/bybit.js';
import { servedIntervalMs as SERVED_OKX } from '../lib/adapters/okx.js';
import { servedIntervalMs as SERVED_BITGET } from '../lib/adapters/bitget.js';
import { servedIntervalMs as SERVED_ASTER } from '../lib/adapters/aster.js';
import { servedIntervalMs as SERVED_EDGEX } from '../lib/adapters/edgex.js';
import { servedIntervalMs as SERVED_GATE } from '../lib/adapters/gateio.js';
import { servedIntervalMs as SERVED_MEXC } from '../lib/adapters/mexc.js';
import { servedIntervalMs as SERVED_KUCOIN } from '../lib/adapters/kucoin.js';
import { servedIntervalMs as SERVED_PHEMEX } from '../lib/adapters/phemex.js';
import { servedIntervalMs as SERVED_BINGX } from '../lib/adapters/bingx.js';
import { servedIntervalMs as SERVED_HTX } from '../lib/adapters/htx.js';
import { servedIntervalMs as SERVED_WEEX } from '../lib/adapters/weex.js';
import { servedIntervalMs as SERVED_BITMART } from '../lib/adapters/bitmart.js';
import { servedIntervalMs as SERVED_XT } from '../lib/adapters/xt.js';
import { servedIntervalMs as SERVED_WHITEBIT } from '../lib/adapters/whitebit.js';
import { sloHoursFor as defaultSloHoursFor, isFullPanelVenue, FRESHNESS_BARRIER_SPEC, FULL_PANEL_VENUES } from '../lib/venue-slo-tiers.js';
import { candleHorizonDays, CANDLE_HORIZON_DAYS, CANDLE_HORIZONS_MEASURED_AT } from '../lib/venue-candle-horizons.js';
import { isStopRequested, installGracefulStop } from '../lib/graceful-stop.js';
import { buildEnvelope, isConforming, type Verdict } from '../lib/detector-envelope.js';

const DELAY_BETWEEN_FETCHES_MS = 250;
const FETCH_BUFFER_CANDLES = 2; // pad each fetched range slightly
const MAX_PAGES_PER_RANGE = 500; // runaway guard for one paginated range
const INSERT_CHUNK_ROWS = 1000; // stay well under the PG bind-param ceiling (10 params/row)

/** The INSERT's column list — one array, so the placeholder count can never disagree with it. */
export const INSERT_COLUMNS = [
  'signal_id', 'barrier_spec', 'label', 'ambiguous_candle', 'low_vol_history',
  't_hit_candles', 'mfe_return_pct', 'mae_return_pct', 'barrier_pct', 'ret_at_expiry_pct',
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
  ambiguous: number; // same-candle -1 conservative
  timeouts: number; // label 0
  wins: number;
  losses: number;
  sanityWarn: number; // kline-derived vs stored mfe/mae gross mismatch
  budgetSkips: number; // groups deferred on WeightBudgetSkipError (retry on re-run)
  errors: number;
}

const cov: Coverage = {
  groups: 0, groupsSkipped: 0, signalsSeen: 0, labeled: 0, written: 0,
  noKlines: 0, lowVolHistory: 0, ambiguous: 0, timeouts: 0, wins: 0, losses: 0,
  sanityWarn: 0, budgetSkips: 0, errors: 0,
};
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
  return {
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
): Promise<void> {
  const tfMs = pageStepMs;
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
    if (maxTime <= cursor) break; // no forward progress → venue horizon reached
    cursor = maxTime + tfMs;
    await sleep(DELAY_BETWEEN_FETCHES_MS);
  }
}

/** Exported for tests/unit/directional-label-golden.test.ts only — a seam, not an API: that golden
 *  pins the labels this function writes for a fixed fixture, which is how "the worklist order changed
 *  WHICH rows are reached, never WHAT label they get" is proven rather than asserted. */
export async function processGroup(cli: Cli, g: { exchange: string; coin: string; timeframe: string }): Promise<void> {
  const W = EVAL_CANDLES[g.timeframe];
  const tfMs = TF_MS[g.timeframe];
  if (!W || !tfMs) return; // unknown/retired timeframe — already filtered, defensive
  // Taken BEFORE any fetch: a candle is only trusted as CLOSED if it closed before this instant
  // (expiryReturnPct refuses a vertical-barrier candle that may have been forming at fetch time).
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

  // Which (signal_id, spec) already exist → skip (idempotency + resume).
  const specNames = cli.specs.map((s) => s.spec);
  const ids = sigs.map((s) => s.id);
  const existing = await dbQuery<{ signal_id: number; barrier_spec: string }>(
    `SELECT signal_id, barrier_spec FROM directional_labels
     WHERE barrier_spec = ANY($1) AND signal_id = ANY($2)`,
    [specNames, ids],
  );
  const done = new Set(existing.map((e) => `${e.signal_id}|${e.barrier_spec}`));
  cov.labeled += existing.length;

  // Build the to-do list: signal × spec not yet present.
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

  // Incremental group candle cache (dense → contiguous; sparse → islands).
  const cache = new Map<number, Candle>();
  let coveredUntil = -Infinity;
  const rows: unknown[][] = [];

  for (const s of todo) {
    const entryMs = s.created_at * 1000;
    const neededStart = entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * tfMs;
    const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * tfMs;
    try {
      if (neededEnd > coveredUntil) {
        const start = coveredUntil + tfMs >= neededStart ? coveredUntil + tfMs : neededStart; // extend vs new island
        await fetchRangeInto(cache, g.exchange as ExchangeId, g.coin, g.timeframe, start, neededEnd);
        coveredUntil = Math.max(coveredUntil, neededEnd);
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
    const trailingCloses = asc.filter((c) => c.time < entryMs).map((c) => c.close);
    const forwardAsc = asc.filter((c) => c.time >= entryMs);

    const { sigma } = computeSigmaW(trailingCloses, W);
    const lowVol = sigma == null;
    // EDGE-ADS1-SCORECARD-W1-V2 (Q2 = A): the expiry return from the candle already in hand — the
    // same entry and window the race uses; null when the window had not closed at fetch time.
    const expiry = expiryReturnPct(forwardAsc, W, s.price_at_signal, entryMs, servedStepMs(g.exchange, g.timeframe), groupStartMs);

    // Forward reachability: need a resolved race OR full-window coverage to call a timeout.
    for (const sp of cli.specs) {
      if (done.has(`${s.id}|${sp.spec}`)) continue;
      const bpSpec = barrierPct(sigma, sp.tau);
      const race = runTripleBarrier(s.signal, s.price_at_signal, forwardAsc, bpSpec, W);
      const indeterminateTimeout = race.label === 0 && forwardAsc.length < W;
      if (forwardAsc.length === 0 || indeterminateTimeout) {
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
        race.tHitCandles, storedMfe, storedMae, bpSpec, expiry,
      ]);
      frontierByVenue.set(g.exchange, Math.max(frontierByVenue.get(g.exchange) ?? 0, s.created_at));
      cov.labeled++;
      if (lowVol) cov.lowVolHistory++;
      if (race.ambiguousCandle) cov.ambiguous++;
      if (race.label === 0) cov.timeouts++;
      else if (race.label === 1) cov.wins++;
      else cov.losses++;
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
export const EXPIRY_REACH_DAYS_MEASURED_AT = '2026-09-27';
export const EXPIRY_REACH_DAYS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  BINGX: { '3m': 2, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 83 },
  BITGET: { '2h': 8.75, '8h': 51 },
  GATE: { '3m': 34.5, '5m': 34.5, '15m': 104 },
  HL: { '3m': 10.41, '5m': 17.36, '15m': 52.08, '30m': 104.16, '1h': 208.33 },
  HTX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  MEXC: { '3m': 6.75, '5m': 6.75, '15m': 20.75, '30m': 41, '1h': 83, '2h': 83 },
  PHEMEX: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  WEEX: { '3m': 2.08, '5m': 3.47, '15m': 10.41, '30m': 20.83, '1h': 41.66, '2h': 83.33, '4h': 166.66 },
  WHITEBIT: { '5m': 10.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
  XT: { '3m': 3.25, '5m': 3.25, '15m': 10.25, '30m': 20.75, '1h': 41, '2h': 42 },
};

export function expiryReachDays(venue: string, timeframe: string): number {
  return EXPIRY_REACH_DAYS[venue]?.[timeframe] ?? Infinity;
}

/** One margin hour inside the measured depth, so a row on the edge is skipped rather than fetched empty. */
const REACH_MARGIN_S = 3600;

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
// No adapter aggregates: 29 (venue, timeframe) pairs are fetch-and-relabel — e.g. 2h is served as 1h candles
// on BITGET/GATE/HTX/MEXC/PHEMEX/WEEX/WHITEBIT/XT, 3m as 5m on GATE/MEXC/HTX/PHEMEX/WEEX/XT. The race runs on
// the SERVED candles, so the expiry return must too: its W-th candle, spacing and alignment are on the served
// grid. The functions are each adapter's own `servedIntervalMs` export (the ones src/lib/tf-support.ts reads);
// the table is `Record<ExchangeId, …>`, so a venue added without an entry is a compile error.
const SERVED_INTERVAL: Record<ExchangeId, (tf: string) => number | null> = {
  HL: SERVED_HL, BINANCE: SERVED_BINANCE, BYBIT: SERVED_BYBIT, OKX: SERVED_OKX, BITGET: SERVED_BITGET,
  ASTER: SERVED_ASTER, EDGEX: SERVED_EDGEX, GATE: SERVED_GATE, MEXC: SERVED_MEXC, KUCOIN: SERVED_KUCOIN,
  PHEMEX: SERVED_PHEMEX, BINGX: SERVED_BINGX, HTX: SERVED_HTX, WEEX: SERVED_WEEX, BITMART: SERVED_BITMART,
  XT: SERVED_XT, WHITEBIT: SERVED_WHITEBIT,
};

/** The candle interval `exchange` actually returns for `timeframe` (ms); the requested interval when the
 *  adapter does not map it. */
export function servedStepMs(exchange: string, timeframe: string): number {
  return SERVED_INTERVAL[exchange as ExchangeId]?.(timeframe) ?? TF_MS[timeframe];
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
  const sealEndMs = T_DIAG_END * 1000;
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
    if (entryMs + (W + 1) * tfMs > sealEndMs) { sealEdge++; continue; }
    const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * tfMs;
    try {
      if (neededEnd > coveredUntil) {
        // Extend from the first candle boundary AFTER what is covered — never `coveredUntil + tf`, which is
        // off the grid (created_at is arbitrary seconds) and skips the one candle opening inside that step.
        const nextOpen = (Math.floor(coveredUntil / tfMs) + 1) * tfMs;
        const start = nextOpen >= entryMs ? nextOpen : entryMs; // extend vs new island
        await fetchRangeInto(cache, g.exchange as ExchangeId, g.coin, g.timeframe, start, neededEnd, tfMs);
        // Advance only as far as candles actually ARRIVED, so a short or empty page leaves the rest to be
        // fetched again for the next row instead of silently becoming a hole.
        let lastOpen = -Infinity;
        for (const t of cache.keys()) if (t >= start && t <= neededEnd && t > lastOpen) lastOpen = t;
        if (Number.isFinite(lastOpen)) coveredUntil = Math.max(coveredUntil, lastOpen);
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

/** Per-venue label frontier (MAX labeled created_at) — the F1 rotation key. */
async function loadVenueFrontier(): Promise<Map<string, number>> {
  const rows = await dbQuery<{ exchange: string; frontier: string | number | null }>(
    `SELECT s.exchange, MAX(s.created_at) FILTER (WHERE d.signal_id IS NOT NULL) AS frontier
     FROM signals s
     LEFT JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = 'tau1.0-floor0.30-v1'
     WHERE s.signal IN ('BUY','SELL') AND s.pfe_return_pct IS NOT NULL AND s.timeframe <> '1m'
     GROUP BY 1`,
  );
  return new Map(rows.map((r) => [r.exchange, Number(r.frontier ?? 0)]));
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.expiryOnly && (cli.expiryResetFrom !== undefined || cli.expiryResetTo !== undefined)) return mainExpiryReset(cli);
  if (cli.expiryOnly) return mainExpiry(cli);
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
