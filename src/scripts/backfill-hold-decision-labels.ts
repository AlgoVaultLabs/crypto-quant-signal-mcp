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
 *        [--since <ISO8601|epoch-seconds>] [--require-parts]
 *
 * `--side` / `--conf-min` / `--conf-max` (EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R2) narrow the
 * WORK-LIST only, for dedicated band-targeted backfills; default-off, byte-identical SQL when
 * absent, barrier arithmetic untouched.
 *
 * ── `--since` AND `--require-parts` (EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R1) ────────────────────
 *
 * Same contract: work-list SQL only, default-off, byte-identical when absent.
 *
 * They exist because the work-list is `ROW_NUMBER() … ORDER BY h.decided_at ASC` with
 * `rn <= perCell`, so it takes the OLDEST row in every cell first. After migration 036 added the
 * 13 scorer-parts columns (2026-08-31) the oldest rows are precisely the ones carrying NO parts —
 * measured 2026-09-04, only 17.4% of this labeler's output reached a captured parent while 82.6%
 * went to rows feature attribution cannot use. The labeler was working hard on data the gate
 * could not consume.
 *
 * **`--require-parts` (`h.raw0 IS NOT NULL`) is the SEMANTIC filter and it is AUTHORITATIVE;
 * `--since` is an index
 * bound.** `raw0` and not `raw_final` ON PURPOSE: `scorer-input-identity-canary.py` — the
 * instrument that PUBLISHES the pre-registered gate quantity — already keys "is captured" on
 * `raw0`, and the filter selecting the rows must be the SAME predicate as the counter scoring
 * them. All 13 parts columns are written in one atomic insert so any would serve; picking a
 * second one would be a second derivation of one question, and the drifted copy is always the
 * one nobody watches.
 * They are ANDed, so the intersection IS `--require-parts` winning — stated here and
 * asserted in the tests rather than left to a reader. The distinction is load-bearing because
 * `--lookback-days`, the pre-existing time filter this pair REFINES rather than replaces, is
 * relative to `now` and floored to whole days and therefore cannot name an absolute epoch:
 * measured 2026-09-04 against the exact 461,469-row post-capture target, `--lookback-days 4`
 * over-included 24,604 parts-less rows and `--lookback-days 3` excluded 97,681 wanted ones, an
 * error drifting ~122,000 rows/day as `now` advances. A date is a PROXY for "has parts"; only the
 * parts predicate is the thing itself, and it cannot drift if capture is paused and resumed.
 *
 * The two agreeing is a FACT about today, not a guarantee — measured 2026-09-04, post-capture rows
 * with NULL parts = 0 and pre-capture rows with parts = 0. So the run evidence carries
 * `since_admitted_without_parts`: the count `--since` would have admitted that `--require-parts`
 * rejects. A future divergence becomes a number in the log instead of a silent filter.
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
  BARRIER_SPECS_V2,
  nextFetchStartMs,
  advanceCoverage,
  prepareRaceV2,
} from './directional-labeler.js';
import { servedCandleStepMs, SERVED_VENUES } from '../lib/tf-support.js';
import { isStopRequested, installGracefulStop } from '../lib/graceful-stop.js';

const DELAY_BETWEEN_FETCHES_MS = 250;
const FETCH_BUFFER_CANDLES = 2;
const MAX_PAGES_PER_RANGE = 500;
const INSERT_CHUNK_ROWS = 1000;

/** The hold labeller's cadence (cron `41 3`, daily): "a nightly" in the retry contract below. */
export const HOLD_NIGHTLY_CADENCE_MS = 86_400_000;
/** How far a nightly's legs may start from the same instant a day apart (the legs run one after another, so the
 *  unscoped reserve leg's start moves with the venue legs' durations). The retry bound carries it, so a nightly
 *  that starts late never misses a row's last retry, and "pending" is judged against the latest plausible start. */
export const HOLD_NIGHTLY_JITTER_MS = 6 * 3_600_000;
/**
 * EDGE-LABELER-RACE-WINDOW-V2-W1 CH2b (ruling LRW-Q15 = A) — how long a hold -v2 row not written in its -v1 run
 * stays retryable: two nightlies after its own -v2 window closes (`decided_at + (W+1)·served`), plus the schedule
 * jitter. Bounded per row, so the retry list never becomes the historical hold relabel (LRW-Q11: a sized
 * follow-up).
 */
export const HOLD_V2_RETRY_GRACE_MS = 2 * HOLD_NIGHTLY_CADENCE_MS + HOLD_NIGHTLY_JITTER_MS;
/** The SQL pre-filter the per-row bound refines: ≥ the largest `(W+1)·served + grace` of any venue × timeframe
 *  (pinned by tests/unit/lrw-hold-v2.test.ts — a new coarser pair that outgrows it fails the suite instead of
 *  silently losing -v2 again), so it never cuts a row the per-row bound would keep. */
export const HOLD_V2_RETRY_PREFILTER_S = 8 * 86_400;

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
  /** EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R1 — additive, default-off, same contract as the three
   *  above. `requireParts` is AUTHORITATIVE over `since`: they are ANDed, so the intersection is
   *  the parts predicate winning. See the header for why a date is only a proxy for it. */
  since?: number;
  requireParts?: boolean;
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
  // `--since` accepts an absolute instant in either notation. DEFAULT-DENY on anything else: a
  // silently-mis-parsed bound would point the drain at the wrong era and report a confident wrong
  // number. The digits-only branch is matched by REGEX before Number(), because Number('0x1') is
  // 1 and parseFloat('0x1') is 0 — both finite, both 1970, neither an error.
  const sinceRaw = val('--since');
  let since: number | undefined;
  if (sinceRaw !== undefined) {
    if (/^\d{1,11}$/.test(sinceRaw)) {
      since = Number(sinceRaw);
    } else {
      const ms = Date.parse(sinceRaw);
      if (!Number.isFinite(ms)) {
        throw new Error(`--since must be ISO8601 or epoch-seconds, got '${sinceRaw}'`);
      }
      since = Math.floor(ms / 1000);
    }
    if (!Number.isInteger(since) || since <= 0) {
      throw new Error(`--since must resolve to a positive epoch-second, got '${sinceRaw}'`);
    }
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
    since,
    requireParts: has('--require-parts') ? true : undefined,
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
/**
 * The eligibility predicate — ONE derivation, two consumers.
 *
 * `buildWorklistSql` fetches rows with it; `buildSinceWithoutPartsSql` counts the rows `--since`
 * admits that `--require-parts` rejects, which is the SAME predicate with the parts test inverted.
 * Writing that predicate twice would let the measurement of a filter drift away from the filter,
 * and the drifted copy is the one nobody watches.
 *
 * `partsMode`: `'require'` ⇒ `IS NOT NULL` · `'exclude'` ⇒ `IS NULL` · `'off'` ⇒ no parts test.
 */
function buildEligibleWhere(
  cli: Cli,
  nowSec: number,
  partsMode: 'require' | 'exclude' | 'off',
): { where: string[]; params: unknown[] } {
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
  // EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R1 — appended AFTER every pre-existing conditional and
  // BEFORE the LIMIT params, for the same reason the block above is: inserting earlier renumbers
  // every later `$n`. With both absent nothing here executes and the emitted SQL + param vector
  // stay byte-identical to the pre-flag behaviour (pinned by a golden in
  // tests/unit/hold-decision-label-filters.test.ts).
  //
  // ORDER WITHIN THIS BLOCK IS DELIBERATE: `--since` is the index bound, `--require-parts` is the
  // semantic filter, and the parts predicate is written LAST so it reads as the final word. They
  // are ANDed, so the intersection IS `--require-parts` winning over a looser `--since`.
  if (cli.since !== undefined) {
    params.push(cli.since);
    where.push(`h.decided_at >= $${params.length}`);
  }
  // no param either way — a NULL test takes no bind
  if (partsMode === 'require') where.push('h.raw0 IS NOT NULL');
  else if (partsMode === 'exclude') where.push('h.raw0 IS NULL');
  return { where, params };
}

export function buildWorklistSql(cli: Cli, nowSec: number): { sql: string; params: unknown[] } {
  const { where, params } = buildEligibleWhere(cli, nowSec, cli.requireParts ? 'require' : 'off');
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

/**
 * The DISAGREEMENT counter: rows `--since` admits that `--require-parts` rejects.
 *
 * `--require-parts` is authoritative, and because the two predicates are ANDed it wins silently.
 * Silently is the problem: measured 2026-09-04 the two agree exactly (post-capture rows with NULL
 * parts = 0, pre-capture rows with parts = 0), and an agreement that is a fact about today will
 * be read by a later wave as a guarantee. This makes the gap a NUMBER in every run's evidence, so
 * the day a writer path stops populating parts, the log says so instead of the drain quietly
 * shrinking.
 *
 * Deliberately NOT a gate leg: `main` reports `null` if it cannot be read, and the run proceeds.
 */
export function buildSinceWithoutPartsSql(cli: Cli, nowSec: number): { sql: string; params: unknown[] } {
  const { where, params } = buildEligibleWhere(cli, nowSec, 'exclude');
  return { sql: `SELECT count(*)::int AS n FROM hold_decisions h WHERE ${where.join(' AND ')}`, params };
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
  /** Paging step. Defaults to the REQUESTED interval — the hold -v1 path, unchanged (ruling LRW-Q11: hold -v1
   *  stays on its current cache until its owner rules). The hold -v2 pass passes the SERVED step. */
  pageStepMs: number = TF_MS[timeframe],
): Promise<boolean> {
  const tfMs = pageStepMs;
  const adapter = getAdapter(exchangeId);
  const dex = exchangeId === 'HL' ? getDexForCoin(coin) : undefined;
  let cursor = startMs;
  let pages = 0;
  let answered = false; // the venue returned at least one candle — in range or not (read by hold -v2 only)
  while (cursor <= endMs && pages < MAX_PAGES_PER_RANGE) {
    pages++;
    const page = await adapter.getCandles(coin, timeframe, cursor, dex, endMs);
    if (!page || page.length === 0) break;
    answered = true;
    let maxTime = cursor;
    for (const c of page) {
      if (c.time >= startMs && c.time <= endMs) cache.set(c.time, c);
      if (c.time > maxTime) maxTime = c.time;
    }
    if (maxTime <= cursor) break; // no forward progress → venue horizon
    cursor = maxTime + tfMs;
    await sleep(DELAY_BETWEEN_FETCHES_MS);
  }
  return answered;
}

interface Cov {
  considered: number; skippedUnclosed: number; labeled: number; written: number;
  noKlines: number; lowVolHistory: number; timeouts: number; wins: number; losses: number;
  ambiguous: number; budgetSkips: number; errors: number;
  cells: Set<string>; clusters: Set<string>;
}

/**
 * EDGE-LABELER-RACE-WINDOW-V2-W1 CH2b (ruling LRW-Q11 = A) — the hold -v2 family, WRITE-ONLY.
 *
 * R0.2 measured that this file carries its own copy of the directional labeller's off-grid cache extension
 * (`coveredUntil + tf`) and races through the imported index race, so hold -v1 inherits the race-window defect.
 * Hold -v1 is the HOLD-discipline pre-registration's corpus and stays EXACTLY as it is until that owner rules
 * (§11.6 is theirs). Beside it, this pass writes the corrected family for the decisions holdV2Worklist hands it
 * (this run's -v1 writes, plus the bounded retry and cut-timeout sources): its own gap-free cache on the SERVED grid (`nextFetchStartMs` / `advanceCoverage`, paging on the served
 * step), the race by time over all W candles (`prepareRaceV2` — a window with a hole is refused, an open window
 * deferred, a short σ history unreachable, each counted, never written). The arithmetic is imported from
 * directional-labeler.ts — the one module this file shares, as its header requires.
 *
 * It runs on the REMAINDER of the run's time budget, after every -v1 row is inserted: hold -v1's throughput is
 * never reduced by it (never the reverse). Nothing here reads a label — cardinalities only.
 */
interface HoldV2Cov {
  labeled: number; written: number; deferred: number; refused: number;
  unreachableDepth: number; unreachableHistory: number; groupsNotReached: number;
  budgetSkips: number; errors: number;
  noV1Twin: number; // V2_NO_V1_TWIN — -v2 rows whose same-τ hold -v1 row does not exist (after this run's -v1 insert)
  outcome: Map<number, HoldV2Outcome>; // per decision: how this pass ended it
}

export async function labelHoldV2(
  groups: Map<string, HoldRow[]>,
  specs: ReadonlyArray<{ tau: number; spec: string }>,
  outOfTime: () => boolean,
  /** `${decision}|${spec}` rows that already exist, both families — read once, existence only (holdV2Worklist). */
  have: ReadonlySet<string> = new Set(),
): Promise<HoldV2Cov> {
  const v2: HoldV2Cov = {
    labeled: 0, written: 0, deferred: 0, refused: 0, unreachableDepth: 0, unreachableHistory: 0,
    groupsNotReached: 0, budgetSkips: 0, errors: 0, noV1Twin: 0, outcome: new Map(),
  };
  for (const list of groups.values()) for (const d of list) v2.outcome.set(d.decision_id, 'notReached');
  const v2Specs = BARRIER_SPECS_V2.filter((v) => specs.some((s) => s.tau === v.tau));
  const rows: unknown[][] = [];
  let i = 0;
  for (const [key, decisions] of groups) {
    if (outOfTime()) { v2.groupsNotReached = groups.size - i; break; }
    i++;
    const [exchange, coin, timeframe] = key.split('|');
    const W = EVAL_CANDLES[timeframe];
    const tfMs = TF_MS[timeframe];
    if (!W || !tfMs) continue;
    const stepMs = servedCandleStepMs(exchange, timeframe) ?? tfMs;
    const groupStartMs = Date.now(); // before any fetch: a candle is trusted closed only before this instant
    const cache = new Map<number, Candle>();
    let coveredUntil = -Infinity; // the last candle that ARRIVED
    let probedThrough = -Infinity; // a range the venue answered with no candle in it — not asked again
    for (const d of decisions) {
      const entryMs = d.decided_at * 1000;
      const neededStart = entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * stepMs;
      const neededEnd = entryMs + (W + FETCH_BUFFER_CANDLES) * stepMs;
      try {
        if (neededEnd > Math.max(coveredUntil, probedThrough)) {
          const start = Math.max(nextFetchStartMs(coveredUntil, stepMs, neededStart), probedThrough + 1);
          if (start <= neededEnd) {
            const answered = await fetchRangeInto(cache, exchange as ExchangeId, coin, timeframe, start, neededEnd, stepMs);
            const before = coveredUntil;
            coveredUntil = advanceCoverage(coveredUntil, cache.keys(), start, neededEnd);
            if (answered && coveredUntil === before) probedThrough = neededEnd;
          }
        }
      } catch (err) {
        if (err instanceof WeightBudgetSkipError) { v2.budgetSkips++; break; }
        v2.errors++;
        v2.outcome.set(d.decision_id, 'error');
        continue;
      }
      const forwardAsc = [...cache.values()].filter((c) => c.time >= entryMs).sort((a, b) => a.time - b.time);
      const prep = prepareRaceV2(cache, forwardAsc, entryMs, W, stepMs, groupStartMs);
      if (prep.kind === 'deferred') { v2.deferred++; v2.outcome.set(d.decision_id, 'deferred'); continue; }
      if (prep.kind === 'refused') { v2.refused++; v2.outcome.set(d.decision_id, 'refused'); continue; }
      if (prep.kind === 'unreachable') {
        if (prep.reason === 'depth') v2.unreachableDepth++; else v2.unreachableHistory++;
        v2.outcome.set(d.decision_id, 'unreachable');
        continue;
      }
      v2.outcome.set(d.decision_id, 'written');
      const side = d.would_be_side > 0 ? 'BUY' : 'SELL';
      for (const sp of v2Specs) {
        if (have.has(`${d.decision_id}|${sp.spec}`)) continue; // hold -v2 written once
        const bpSpec = barrierPct(prep.sigma, sp.tau);
        const race = runTripleBarrier(side, d.price_at_decision, prep.window, bpSpec, W);
        rows.push([
          d.decision_id, sp.spec, race.label, race.ambiguousCandle, false,
          race.tHitCandles, race.mfeReturnPct, race.maeReturnPct, bpSpec,
        ]);
        v2.labeled++;
        const twin = specs.find((v) => v.tau === sp.tau)!.spec; // no-twin is per τ
        if (!have.has(`${d.decision_id}|${twin}`)) v2.noV1Twin++;
      }
    }
  }
  v2.written = (await insertHoldLabels(rows)).written;
  return v2;
}

/** pg returns int8 columns (`decision_id`, `decided_at`) as STRINGS: every -v2 candidate is normalized once, so
 *  id sets and maps never mix '123' with 123. */
function holdRowNum<T extends HoldRow>(r: T): HoldRow {
  return { ...r, decision_id: Number(r.decision_id), decided_at: Number(r.decided_at), price_at_decision: Number(r.price_at_decision), would_be_side: Number(r.would_be_side) };
}

/** A pair whose served candle is coarser than the timeframe — the only pairs with a cut-unwritable -v1 timeout. */
function isCoarserPair(exchange: string, timeframe: string): boolean {
  const tfMs = TF_MS[timeframe];
  return !!tfMs && (servedCandleStepMs(exchange, timeframe) ?? tfMs) > tfMs;
}

/** THE retry span of one pair: its -v2 window `(W+1)·served`, two nightlies and the schedule jitter. null for an
 *  unknown pair. */
export function holdV2RetrySpanMs(exchange: string, timeframe: string): number | null {
  const W = EVAL_CANDLES[timeframe];
  const stepMs = servedCandleStepMs(exchange, timeframe);
  if (!W || !stepMs) return null;
  return (W + 1) * stepMs + HOLD_V2_RETRY_GRACE_MS;
}

/** Within its retry bound at `nowMs`: `decided_at + span > now`. Pure. */
export function holdV2Retryable(d: Pick<HoldRow, 'decided_at' | 'timeframe' | 'exchange'>, nowMs: number): boolean {
  const span = holdV2RetrySpanMs(d.exchange, d.timeframe);
  return span !== null && nowMs < d.decided_at * 1000 + span;
}

/** The same bound as SQL binds: per (venue, timeframe) the newest `decided_at` (s) that is NO LONGER retryable —
 *  a row is retryable iff `decided_at > lo_s` (integer seconds), exactly holdV2Retryable. */
export function holdV2RetryBounds(nowMs: number): { exchanges: string[]; timeframes: string[]; loS: number[] } {
  const exchanges: string[] = [];
  const timeframes: string[] = [];
  const loS: number[] = [];
  for (const exchange of SERVED_VENUES) {
    for (const timeframe of Object.keys(EVAL_CANDLES)) {
      const span = holdV2RetrySpanMs(exchange, timeframe);
      if (span === null) continue;
      exchanges.push(exchange);
      timeframes.push(timeframe);
      loS.push(Math.floor((nowMs - span) / 1000));
    }
  }
  return { exchanges, timeframes, loS };
}

/**
 * EDGE-LABELER-RACE-WINDOW-V2-W1 CH2b — which decisions the hold -v2 pass races this run (rulings LRW-Q15 = A,
 * LRW-Q16 = A, 2026-09-29; registration amendment). Hold -v1's eligibility (`W·tf`) precedes the -v2 window's
 * close (`(W+1)·served`), so "-v2 only in the run that writes -v1" lost every 1d decision's -v2 for good, and a
 * coarser-served pair's cut -v1 timeout (never writable) kept -v2 to the decided rows. THE RETRY CONTRACT: a
 * deferred hold -v2 is retried until two nightlies after its window closes, and every candidate ends a run
 * counted (HOLD_V2_RETRY pending / written / aged_out / terminal). The first nights also pick up pre-wave
 * decisions still inside that bound — a bounded, recorded LRW-Q11 deviation. Three sources, in order,
 * de-duplicated:
 *   1. `v1` — decisions with a hold -v1 row this run actually INSERTED (never a re-push the table refused:
 *      a decision whose primary (τ1.0) -v1 row is missing stays in the -v1 work-list and re-pushes every night);
 *      on a coarser-served pair held to the retry bound, like source 2;
 *   2. `cut` — this run's coarser-served decisions with a -v1 τ whose cut timeout is unwritable, within the bound;
 *   3. `retry` — decisions with the hold -v1 row and without the -v2 row, within the bound (sources 1-2 excluded,
 *      so this run's own writes never spend the LIMIT).
 * Then ONE existence read — which (decision, spec) rows exist, both families, never a label value — drops every
 * candidate whose -v2 set is complete and tells the race which τ to write and which τ has a -v1 twin.
 * Per-row bounded, so never the historical hold relabel. A `cut` candidate lacks the primary -v1 row, so the
 * retry list (keyed on it) never selects it; it re-enters only through the hold -v1 work-list, whose reach is the
 * HOLD owner's (LRW-Q11).
 */
export type HoldV2Source = 'v1' | 'cut' | 'retry';

export async function holdV2Worklist(
  cli: Cli,
  v1Inserted: HoldRow[],
  cutUnwritable: HoldRow[],
  nowMs: number,
): Promise<{
  groups: Map<string, HoldRow[]>; candidates: HoldRow[]; source: Map<number, HoldV2Source>; have: Set<string>;
  retried: number; cut: number; limited: boolean; overflowLastChance: number;
}> {
  const picked: HoldRow[] = [];
  const source = new Map<number, HoldV2Source>();
  const add = (raw: HoldRow, src: HoldV2Source): void => {
    const d = holdRowNum(raw);
    if (source.has(d.decision_id)) return;
    source.set(d.decision_id, src);
    picked.push(d);
  };
  // On a coarser-served pair BOTH -v1 outcomes are held to the retry bound: a decided -v1 (source 1) and a cut
  // timeout (source 2) alike, so the drained backlog's coarser -v2 is never selected on the -v1 outcome (LRW-Q16).
  for (const d of v1Inserted) if (!isCoarserPair(d.exchange, d.timeframe) || holdV2Retryable(d, nowMs)) add(d, 'v1');
  for (const d of cutUnwritable) if (holdV2Retryable(d, nowMs)) add(d, 'cut');
  const v2Key = BARRIER_SPECS_V2.find((v) => v.tau === cli.specs[0].tau)?.spec;
  let limited = false;
  let overflowLastChance = 0;
  if (v2Key) {
    const bounds = holdV2RetryBounds(nowMs);
    const params: unknown[] = [
      cli.specs[0].spec, v2Key, Math.floor(nowMs / 1000) - HOLD_V2_RETRY_PREFILTER_S,
      bounds.exchanges, bounds.timeframes, bounds.loS, picked.map((d) => d.decision_id),
    ];
    const where = [
      `EXISTS (SELECT 1 FROM hold_decision_labels l WHERE l.hold_decision_id = h.decision_id AND l.barrier_spec = $1)`,
      `NOT EXISTS (SELECT 1 FROM hold_decision_labels l WHERE l.hold_decision_id = h.decision_id AND l.barrier_spec = $2)`,
      `h.decided_at > $3`,
      `h.decided_at > b.lo_s`, // the per-row bound, exactly holdV2Retryable
      `h.decision_id <> ALL($7::bigint[])`, // sources 1-2 are already in: they never spend the LIMIT
    ];
    if (cli.venue) { params.push(cli.venue); where.push(`h.exchange = $${params.length}`); }
    if (cli.coin) { params.push(cli.coin); where.push(`h.coin = $${params.length}`); }
    if (cli.timeframe) { params.push(cli.timeframe); where.push(`h.timeframe = $${params.length}`); }
    params.push(cli.maxDecisions);
    const retry = await dbQuery<HoldRow>(
      `SELECT h.decision_id, h.decided_at, h.coin, h.timeframe, h.exchange, h.would_be_side, h.price_at_decision
         FROM hold_decisions h
         JOIN unnest($4::text[], $5::text[], $6::bigint[]) AS b(exchange, timeframe, lo_s)
           ON b.exchange = h.exchange AND b.timeframe = h.timeframe
        WHERE ${where.join(' AND ')}
        ORDER BY h.decided_at - b.lo_s, h.exchange, h.coin, h.timeframe, h.decided_at
        LIMIT $${params.length}`,
      params,
    );
    // most urgent first (closest to its bound), so a cap cuts the rows that can still wait a nightly
    for (const r of retry) add(r, 'retry');
    limited = retry.length >= cli.maxDecisions;
    if (limited) {
      // rows past the cap that are on their LAST retryable nightly: they will get no row — counted, never silent
      const next = holdV2RetryBounds(nowMs + HOLD_NIGHTLY_CADENCE_MS + HOLD_NIGHTLY_JITTER_MS);
      const cparams = params.slice(0, -1);
      cparams[6] = picked.map((d) => d.decision_id);
      cparams.push(next.loS);
      const n = await dbQuery<{ n: number | string }>(
        `SELECT count(*) AS n
           FROM hold_decisions h
           JOIN unnest($4::text[], $5::text[], $6::bigint[], $${cparams.length}::bigint[]) AS b(exchange, timeframe, lo_s, lo_next)
             ON b.exchange = h.exchange AND b.timeframe = h.timeframe
          WHERE ${where.join(' AND ')} AND h.decided_at <= b.lo_next`,
        cparams,
      );
      overflowLastChance = Number(n[0]?.n ?? 0);
    }
  }
  // ONE existence read for every candidate, both families (after this run's -v1 insert, so its rows are seen)
  const v2Specs = BARRIER_SPECS_V2.filter((v) => cli.specs.some((sp) => sp.tau === v.tau));
  const have = new Set<string>();
  if (picked.length > 0 && v2Specs.length > 0) {
    const existing = await dbQuery<{ hold_decision_id: number; barrier_spec: string }>(
      `SELECT hold_decision_id, barrier_spec FROM hold_decision_labels
        WHERE hold_decision_id = ANY($1) AND barrier_spec = ANY($2)`,
      [picked.map((d) => d.decision_id), [...cli.specs.map((sp) => sp.spec), ...v2Specs.map((sp) => sp.spec)]],
    );
    for (const e of existing) have.add(`${Number(e.hold_decision_id)}|${e.barrier_spec}`);
  }
  const candidates = picked.filter((d) => v2Specs.some((sp) => !have.has(`${d.decision_id}|${sp.spec}`)));
  const groups = new Map<string, HoldRow[]>();
  for (const d of candidates) {
    const k = `${d.exchange}|${d.coin}|${d.timeframe}`;
    const list = groups.get(k);
    if (list) list.push(d); else groups.set(k, [d]);
  }
  // the group cache extends in time order
  for (const list of groups.values()) list.sort((a, b) => a.decided_at - b.decided_at);
  const count = (src: HoldV2Source) => candidates.filter((d) => source.get(d.decision_id) === src).length;
  return { groups, candidates, source, have, retried: count('retry'), cut: count('cut'), limited, overflowLastChance };
}

export type HoldV2Outcome = 'written' | 'deferred' | 'refused' | 'unreachable' | 'notReached' | 'error';

/**
 * The retry contract's accounting (ruling LRW-Q15 = A): EVERY hold -v2 candidate of the run (all three sources)
 * ends it WRITTEN, still PENDING (retryable at the next nightly), TERMINAL (refused / unreachable with no
 * retryable nightly left — a hole or a short history, answered, not lost) or AGED OUT (no retryable nightly left
 * and no row: the budget never reached it, or it was still deferred / errored). Aged-out rows are the
 * silent-loss class this contract exists to count. One nightly runs the labeller once per venue leg and then once
 * unscoped (ops/cron/hold-decision-labeler.sh); only that last, unscoped leg decides aged_out / terminal, so a row
 * is judged lost once a night and never while a later leg can still write it. Pure.
 */
export function holdV2RetryAccounting(
  retryRows: ReadonlyArray<Pick<HoldRow, 'decision_id' | 'decided_at' | 'timeframe' | 'exchange'>>,
  outcome: ReadonlyMap<number, HoldV2Outcome>,
  nowMs: number,
  /** Only the nightly's LAST leg — the unscoped invocation — may call a row lost: a scoped (per-venue) leg reports
   *  every unwritten candidate as pending, because the unscoped leg after it can still reach it. */
  lastLegOfNight = true,
): { pending: number; written: number; agedOut: number; terminal: number } {
  const a = { pending: 0, written: 0, agedOut: 0, terminal: 0 };
  for (const d of retryRows) {
    const o = outcome.get(Number(d.decision_id)) ?? 'notReached';
    if (o === 'written') a.written++;
    else if (!lastLegOfNight || holdV2Retryable(d, nowMs + HOLD_NIGHTLY_CADENCE_MS + HOLD_NIGHTLY_JITTER_MS)) a.pending++;
    else if (o === 'refused' || o === 'unreachable') a.terminal++;
    else a.agedOut++;
  }
  return a;
}

/** The one INSERT both families use (nine named columns, idempotent). Returns the rows actually written and the
 *  decisions they belong to (RETURNING — a row the table refused on conflict is in neither). */
async function insertHoldLabels(rows: unknown[][]): Promise<{ written: number; ids: Set<number> }> {
  let written = 0;
  const ids = new Set<number>();
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
    written += res.length;
    for (const r of res) ids.add(Number(r.hold_decision_id));
  }
  return { written, ids };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = parseCli(argv);
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();
  installGracefulStop();

  const nowSec = Math.floor(Date.now() / 1000);
  const { sql, params } = buildWorklistSql(cli, nowSec);
  const all = await dbQuery<HoldRow>(sql, params);

  // Only meaningful when BOTH are set — with one of them absent there is no disagreement to
  // measure. A RECORD, never a gate leg: a failure here reports `null` and the run continues,
  // because a measurement fault must not become a labeling fault.
  let sinceWithoutParts: number | null = null;
  if (cli.since !== undefined && cli.requireParts) {
    try {
      const q = buildSinceWithoutPartsSql(cli, nowSec);
      const r = await dbQuery<{ n: number }>(q.sql, q.params);
      sinceWithoutParts = r[0]?.n ?? null;
    } catch {
      sinceWithoutParts = null;
    }
  }

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
        `decisions=${todo.length} unclosed_skipped=${cov.skippedUnclosed}` +
        (sinceWithoutParts === null ? '' : ` since_admitted_without_parts=${sinceWithoutParts}`),
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
  const v1Attempted: HoldRow[] = []; // every decision the -v1 loop raced (its inserted rows decide source 1)
  const v1CutUnwritable: HoldRow[] = []; // coarser-served: a -v1 τ whose cut timeout is unwritable (see holdV2Worklist)

  for (const [key, decisions] of groups) {
    if (isStopRequested() || Date.now() - startMs > budgetMs) break;
    const [exchange, coin, timeframe] = key.split('|');
    const W = EVAL_CANDLES[timeframe];
    const tfMs = TF_MS[timeframe];
    if (!W || !tfMs) continue;

    const cache = new Map<number, Candle>();
    let coveredUntil = -Infinity;
    const coarser = (servedCandleStepMs(exchange, timeframe) ?? tfMs) > tfMs; // read by the -v2 gate only

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

      let cutUnwritable = false;
      for (const sp of cli.specs) {
        const bpSpec = barrierPct(sigma, sp.tau);
        const race = runTripleBarrier(side, d.price_at_decision, forwardAsc, bpSpec, W);
        // Same guard as the acted arm: a label-0 on a short window is NOT a timeout, it is an
        // absence of evidence, and recording it as a timeout would bias the counterfactual arm
        // toward "no move" — the exact direction that would fake a PASS.
        const indeterminateTimeout = race.label === 0 && forwardAsc.length < W;
        if (forwardAsc.length === 0 || indeterminateTimeout) {
          // an EMPTY forward is no-klines (the venue served nothing), not a completed -v1 attempt
          if (indeterminateTimeout && forwardAsc.length > 0 && coarser) cutUnwritable = true;
          cov.noKlines++;
          continue;
        }
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
      v1Attempted.push(d);
      if (cutUnwritable) v1CutUnwritable.push(d);
    }
  }

  const v1Insert = await insertHoldLabels(rows);
  cov.written += v1Insert.written;
  // The -v1 run's own truncation, taken BEFORE the -v2 pass: the verdict and exit code are the -v1 run's, and
  // nothing -v2 does on the remainder may turn a complete -v1 run INDETERMINATE (review 2026-09-29).
  const v1Truncated = cov.budgetSkips > 0 || isStopRequested() || Date.now() - startMs > budgetMs;

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
  const truncated = v1Truncated;
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
    // `--require-parts` wins over `--since` by construction (they are ANDed). This is the size of
    // that win. 0 = the two predicates agree. null = not both flags set, or the count could not
    // be read — never silently 0, which would read as agreement.
    since_admitted_without_parts: sinceWithoutParts,
    elapsed_min: Math.round(((Date.now() - startMs) / 60_000) * 10) / 10,
  };
  // Silent on success in the sense that matters — no alert, no Telegram. The token is the record.
  // Printed BEFORE the -v2 pass: the -v1 run's token, key set and exit code are exactly what they were before this
  // wave, and nothing the -v2 pass does afterwards — a fault, an overrun, a SIGKILL — can take them back.
  console.log(`HOLD_LABEL_VERDICT=${verdict} ${JSON.stringify(evidence)}`);

  // hold -v2 (CH2b): the corrected family — on what is LEFT of the budget, so hold -v1 is never displaced by it.
  // Cardinalities only; see holdV2Worklist + labelHoldV2.
  // Its failure is RECORDED, never thrown: the -v1 verdict token and exit code below must survive any -v2 fault.
  let v2: HoldV2Cov | null = null;
  let v2Groups: Awaited<ReturnType<typeof holdV2Worklist>> | null = null;
  let retryAcc: ReturnType<typeof holdV2RetryAccounting> | null = null;
  let v2Error: string | null = null;
  try {
    const v2NowMs = Date.now();
    v2Groups = await holdV2Worklist(cli, v1Attempted.filter((d) => v1Insert.ids.has(Number(d.decision_id))), v1CutUnwritable, v2NowMs);
    v2 = await labelHoldV2(v2Groups.groups, cli.specs, () => isStopRequested() || Date.now() - startMs > budgetMs, v2Groups.have);
    const lastLeg = !(cli.venue || cli.coin || cli.timeframe);
    retryAcc = holdV2RetryAccounting(v2Groups.candidates, v2.outcome, v2NowMs, lastLeg);
    if (lastLeg) retryAcc.agedOut += v2Groups.overflowLastChance; // past the cap on their last nightly
  } catch (err) {
    v2Error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    console.error(`[${ts()}] hold -v2 pass FAILED (recorded; the -v1 verdict stands): ${v2Error}`);
  }

  // The -v2 pass's record lines (LRW-Q15 / LRW-Q16) — cardinalities, never part of the verdict above.
  // null = not measured (the -v2 pass failed: v2_error says why) — never a zero that reads as "nothing lost"
  const v2Evidence = {
    v2_error: v2Error,
    v2_candidates: v2Groups ? v2Groups.candidates.length : null,
    v2_retry_candidates: v2Groups ? v2Groups.retried : null,
    v2_cut_candidates: v2Groups ? v2Groups.cut : null,
    v2_retry_pending: retryAcc ? retryAcc.pending : null,
    v2_retry_written: retryAcc ? retryAcc.written : null,
    v2_retry_aged_out: retryAcc ? retryAcc.agedOut : null,
    v2_retry_terminal: retryAcc ? retryAcc.terminal : null,
    v2_retry_limited: v2Groups ? (v2Groups.limited ? 1 : 0) : null,
    v2_retry_overflow_last_chance: v2Groups ? v2Groups.overflowLastChance : null,
    v2_no_v1_twin: v2 ? v2.noV1Twin : null,
    v2_labeled: v2 ? v2.labeled : null,
    v2_written: v2 ? v2.written : null,
    v2_deferred: v2 ? v2.deferred : null,
    v2_refused: v2 ? v2.refused : null,
    v2_unreachable_depth: v2 ? v2.unreachableDepth : null,
    v2_unreachable_history: v2 ? v2.unreachableHistory : null,
    v2_groups_not_reached: v2 ? v2.groupsNotReached : null,
    v2_budget_skips: v2 ? v2.budgetSkips : null,
    v2_errors: v2 ? v2.errors : null,
    v2_elapsed_min_total: Math.round(((Date.now() - startMs) / 60_000) * 10) / 10, // the whole run, -v2 remainder included
  };
  console.log(`HOLD_V2_EVIDENCE ${JSON.stringify(v2Evidence)}`);
  if (retryAcc && v2Groups && v2) {
    console.log(
      `HOLD_V2_RETRY pending=${retryAcc.pending} written=${retryAcc.written} aged_out=${retryAcc.agedOut} ` +
        `terminal=${retryAcc.terminal} limited=${v2Groups.limited ? 1 : 0}`,
    );
    console.log(`V2_NO_V1_TWIN written=${v2.noV1Twin}`);
  } else {
    // no counts at all when unmeasured: a reader keyed on `aged_out=` finds none and must read INDETERMINATE
    console.log('HOLD_V2_RETRY error=1');
    console.log('V2_NO_V1_TWIN error=1');
  }
  return verdict === 'INDETERMINATE' ? 3 : 0;
}

if (process.argv[1] && process.argv[1].includes('backfill-hold-decision-labels')) {
  void runScript('backfill-hold-decision-labels', () => runAsBatch(() => main(), 'hold_decision_labeler'));
}
