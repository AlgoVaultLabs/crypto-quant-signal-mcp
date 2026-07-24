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
} from './directional-labeler.js';
import { sloHoursFor as defaultSloHoursFor } from '../lib/venue-slo-tiers.js';
import { isStopRequested, installGracefulStop } from '../lib/graceful-stop.js';

const DELAY_BETWEEN_FETCHES_MS = 250;
const FETCH_BUFFER_CANDLES = 2; // pad each fetched range slightly
const MAX_PAGES_PER_RANGE = 500; // runaway guard for one paginated range
const INSERT_CHUNK_ROWS = 1000; // stay well under the PG bind-param ceiling (9 params/row)

const ALL_SPECS = [
  { tau: 1.0, spec: 'tau1.0-floor0.30-v1' },
  { tau: 0.5, spec: 'tau0.5-floor0.30-v1' },
  { tau: 2.0, spec: 'tau2.0-floor0.30-v1' },
] as const;

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
  };
}

/** Ensure the internal table + index exist (idempotent; migrations/019 is the SoT). */
function ensureTable(): void {
  dbExec(`
    CREATE TABLE IF NOT EXISTS directional_labels (
      signal_id        INTEGER NOT NULL,
      barrier_spec     TEXT NOT NULL,
      label            SMALLINT NOT NULL,
      ambiguous_candle BOOLEAN NOT NULL DEFAULT FALSE,
      low_vol_history  BOOLEAN NOT NULL DEFAULT FALSE,
      t_hit_candles    INT,
      mfe_return_pct   DOUBLE PRECISION,
      mae_return_pct   DOUBLE PRECISION,
      barrier_pct      DOUBLE PRECISION NOT NULL,
      computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (signal_id, barrier_spec)
    );
    CREATE INDEX IF NOT EXISTS idx_dirlabels_spec_signal ON directional_labels (barrier_spec, signal_id);
  `);
}

/** Epoch-seconds lower bound for the nightly recency window; 0 = full depth. */
export function lookbackCutoff(cli: Pick<Cli, 'lookbackDays'>, nowMs: number): number {
  return cli.lookbackDays ? Math.floor(nowMs / 1000) - cli.lookbackDays * 86_400 : 0;
}

async function loadGroups(cli: Cli): Promise<{ exchange: string; coin: string; timeframe: string }[]> {
  const where: string[] = [
    "signal IN ('BUY','SELL')",
    'pfe_return_pct IS NOT NULL',
    "timeframe <> '1m'", // retired lane (OPS-1M-SEED-DECOM-W1) — never labeled
  ];
  const params: unknown[] = [];
  if (cli.venue) { params.push(cli.venue); where.push(`exchange = $${params.length}`); }
  if (cli.coin) { params.push(cli.coin); where.push(`coin = $${params.length}`); }
  if (cli.timeframe) { params.push(cli.timeframe); where.push(`timeframe = $${params.length}`); }
  const cutoff = lookbackCutoff(cli, Date.now());
  if (cutoff > 0) { params.push(cutoff); where.push(`created_at > $${params.length}`); }
  const rows = await dbQuery<{ exchange: string; coin: string; timeframe: string }>(
    `SELECT exchange, coin, timeframe FROM signals WHERE ${where.join(' AND ')}
     GROUP BY exchange, coin, timeframe ORDER BY exchange, coin, timeframe`,
    params,
  );
  return cli.limitGroups ? rows.slice(0, cli.limitGroups) : rows;
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
 * a venue was left UNREACHED that will breach its OWN tier SLO before the next nightly. If
 * so the budget structurally cannot keep every venue in-SLO — fire the signal AT the shortfall
 * (Objective #2), not two days later via a downstream page. Estimated shortfall = unreached-in-
 * danger count × the median reached-venue minutes (a lower bound; real backlogs are larger).
 */
export interface CapacityShortfall {
  shortfall: boolean;
  unreachedInDanger: string[];
  estVenueMinShort: number;
}
export function detectCapacityShortfall(
  summaries: VenueRunSummary[],
  venueOrder: string[],
  frontier: Map<string, number>,
  nowSec: number,
  sloHoursFor: (venue: string) => number = defaultSloHoursFor,
  nextRunIntervalH = 24,
): CapacityShortfall {
  const reached = new Set(summaries.map((s) => s.venue));
  const unreached = venueOrder.filter((v) => !reached.has(v));
  const inDanger = unreached.filter((v) => {
    const projectedLagH = (nowSec - (frontier.get(v) ?? 0)) / 3600 + nextRunIntervalH;
    return projectedLagH > sloHoursFor(v);
  });
  const durations = summaries.map((s) => s.elapsedS / 60).filter((m) => m > 0).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 45;
  return {
    shortfall: inDanger.length > 0,
    unreachedInDanger: inDanger,
    estVenueMinShort: Math.round(inDanger.length * median),
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
    if (maxTime <= cursor) break; // no forward progress → venue horizon reached
    cursor = maxTime + tfMs;
    await sleep(DELAY_BETWEEN_FETCHES_MS);
  }
}

async function processGroup(cli: Cli, g: { exchange: string; coin: string; timeframe: string }): Promise<void> {
  const W = EVAL_CANDLES[g.timeframe];
  const tfMs = TF_MS[g.timeframe];
  if (!W || !tfMs) return; // unknown/retired timeframe — already filtered, defensive

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
        race.tHitCandles, storedMfe, storedMae, bpSpec,
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
      const b = j * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      params.push(...r);
    });
    const res = await dbQuery<{ signal_id: number }>(
      `INSERT INTO directional_labels
         (signal_id, barrier_spec, label, ambiguous_candle, low_vol_history, t_hit_candles, mfe_return_pct, mae_return_pct, barrier_pct)
       VALUES ${values.join(',')}
       ON CONFLICT (signal_id, barrier_spec) DO NOTHING
       RETURNING signal_id`,
      params,
    );
    cov.written += res.length;
  }
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
  ensureTable();
  const groups = await loadGroups(cli);
  const frontier = await loadVenueFrontier();
  const byVenue = partitionByVenue(groups);
  const nowSec = Math.floor(Date.now() / 1000);
  const venueOrder = orderVenuesBySloDeadline([...byVenue.keys()], frontier, nowSec);
  const budget = makeBudget(cli);
  console.log(
    `[${ts()}] DWR backfill start — ${groups.length} groups over ${venueOrder.length} venues ` +
    `(rotation: ${venueOrder.join('>')}), specs=[${cli.specs.map((s) => s.spec).join(', ')}]` +
    `${cli.lookbackDays ? ` lookback=${cli.lookbackDays}d` : ''}` +
    `${cli.timeBudgetMin ? ` budget=${cli.timeBudgetMin}m/venue≤${cli.venueBudgetMin ?? '∞'}m` : ''}` +
    `${cli.check ? ' (CHECK — no writes)' : ''}`,
  );

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
  });

  // Capacity-honesty (Objective #2): if an SLO-ordered run still left a venue UNREACHED that
  // will breach its own tier SLO before the next nightly, the budget structurally cannot fit —
  // emit the signal AT the shortfall (freshness runs only). A host consumer (the freshness
  // canary) forwards it via send_telegram.sh with the severity/cooldown/DRY_RUN gates.
  if (cli.timeBudgetMin !== undefined) {
    const cap = detectCapacityShortfall(summaries, venueOrder, frontier, nowSec);
    if (cap.shortfall) {
      console.log(
        `[capacity-shortfall] unreached_in_danger=${cap.unreachedInDanger.join(',')} ` +
        `count=${cap.unreachedInDanger.length} est_venue_min_short=${cap.estVenueMinShort} ` +
        `budget_min=${cli.timeBudgetMin} venues=${venueOrder.length} recommended_wave=OPS-LABEL-CAPACITY-W{NEXT}`,
      );
    }
  }

  console.log(`[${ts()}] DONE ${JSON.stringify({ ...cov, noKlinesByVenue: Object.fromEntries(noKlinesByVenue) })}`);
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
