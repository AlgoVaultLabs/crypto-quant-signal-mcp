/**
 * band-outcome-lane.ts — OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2 / R2b.
 *
 * Evaluates captured band rows with the SAME evaluator the tracked lane uses, so the eventual
 * band-vs-tracked comparison is a difference in the data rather than an artifact of two
 * labellers. That requirement is the spec's, verbatim: outcome/label backfill must treat these
 * rows exactly as tracked rows.
 *
 * ── SHIPS DARK. THAT IS A MEASUREMENT DECISION, NOT TIMIDITY ─────────────────────────────────
 *
 * `BAND_OUTCOME_ENABLED` defaults OFF. The estimate driving this lane's cost — 5.6k-8.9k band
 * rows/day — is EXTRAPOLATED FROM THE REQUEST ARM, and the fleet arm is precisely the population
 * that has never been observed. Enabling on that estimate would be sizing a ~3x increase in
 * upstream candle fetches against a number the wave exists to discover.
 *
 * So the flag flips on a MEASUREMENT, never a calendar day: capture first, read the real daily
 * band volume off `band_signals`, compute headroom against the tracked lane's budget, then
 * enable. R2b owns that step, and a material divergence between the measured rate and the
 * estimate above is itself a finding to report rather than a number to quietly adopt.
 *
 * ── THERE IS NO TRACKED-LANE YIELD. WHAT PROTECTS THE TRACKED LANE IS THE BUDGET ─────────────
 *
 * This block previously read "PRIORITY IS ONE-WAY, AND ASSERTED" and described
 * `isTrackedBackfillInflight()` as the mechanism. **That was false, and the correction is the
 * point of OPS-BAND-OUTCOME-WIRE-W1.** `isTrackedBackfillInflight()` reads a module-level `let`
 * in `signal-performance.ts`, set only by `getSignalPerformance()` IN THE SAME PROCESS. The
 * dominant tracked consumer is the cron `2-59/3 * * * * … docker exec … node
 * dist/scripts/backfill-outcomes.js`, which is a SEPARATE node process — so from any scheduled
 * sweep the call is a constant `false` and yields to nothing. A safety property rented from a
 * process-local boolean is exactly what CLAUDE.md forbids.
 *
 * The call is KEPT because it is correct in-process, costs one boolean, and is the seam the real
 * mechanism will build on. It is not, and must not be described as, a cross-process priority.
 *
 * What IS enforced today, cross-process, is the INTERACTIVE RESERVE in `upstream-weight-budget.ts`:
 * this lane runs under `runAsBatch`, and `acquire()` caps every batch caller at
 * `ceilingPerMin − interactiveReserve` against a shared on-disk ledger. Batch load therefore
 * cannot touch the reserve — measured 2026-08-31 over 222 closed HL windows, batch exceeded its
 * 700 cap in ZERO of them. It gives this lane no priority BELOW the tracked lane, though: both
 * are `batch`, so they compete as equals for the same share.
 *
 * The real mechanism is a third weight class below `batch`, so the shared ledger enforces the
 * ordering where it belongs. It is DEFERRED, with the caller, to the capacity wave — see
 * `OPS-HL-INTERACTIVE-STARVATION-W1`. Until then this lane has no caller at all.
 *
 * _(Corrected 2026-08-31 `OPS-BAND-OUTCOME-WIRE-W1`. The prior text also cited
 * `tests/unit/band-outcome-lane.test.ts` as asserting "both directions"; that file exists on no
 * ref and never has. What does exist is the ABSENCE half — `tests/unit/band-population-invariance.test.ts`
 * asserts `signal-performance.ts` contains no reference to this module — and that assertion is
 * real and stays. The yield half was never asserted by anything, which is how a mechanism that
 * cannot work survived a wave, a review and a gate.)_
 */
import { getAdapter } from './exchange-adapter.js';
import { runAsBatch } from './upstream-weight-budget.js';
import { getVenueBudget } from './venue-budget-registry.js';
import { computePFEMAE, toSignalOutcomeUpdate, EVAL_CANDLES, TF_MS } from './pfe-mae.js';
import { getBandSignalsNeedingOutcome, updateBandSignalOutcomes } from './performance-db.js';
import { isTrackedBackfillInflight } from '../resources/signal-performance.js';
import type { ExchangeId } from '../types.js';

/**
 * Default-deny on anything that is not an explicit opt-in. `'1'` and `'true'` only — the same
 * parse shape as `PERF_STATS_SQL_PUSHDOWN`, so the estate has one convention rather than two
 * dialects of "is this flag on".
 */
export function bandOutcomeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.BAND_OUTCOME_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * How many band rows one sweep may evaluate. Deliberately far below the tracked lane's
 * `LIMIT 5000`: this lane is allowed to fall behind, the published metric's evaluator is not.
 */
export function bandOutcomeBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BAND_OUTCOME_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 50;
}

/**
 * How many consecutive failures block an `<exchange>:<coin>` pair for the rest of a sweep.
 * Ported verbatim from `src/scripts/backfill-outcomes.ts` (`MAX_FAIL_PER_SYMBOL = 3`), which
 * carries it for the same reason: without it one permanently-failing symbol clogs the queue.
 */
const MAX_FAIL_PER_SYMBOL = 3;

export interface BandOutcomeSweepResult {
  /** Why the sweep did nothing as a WHOLE, or `null` when it ran. Never silent — a skipped sweep
   *  and an empty one are different facts and a caller must be able to tell them apart. */
  skipped: 'disabled' | 'tracked_lane_busy' | null;
  considered: number;
  evaluated: number;
  /**
   * Per-reason row counters. A sweep that evaluates 0 of 50 rows has at least four distinct
   * causes and they demand different responses: the queue head is not due yet, the venue has no
   * batch headroom, the symbol is poisoned, or the fetch errored. Collapsing them into one
   * number is the same invisibility that let a lane with zero callers look "dark" for a week —
   * so every row leaves this loop counted under exactly one reason, and `evaluated + skipped_* +
   * errors === considered` is asserted by the unit suite. (OPS-BAND-OUTCOME-WIRE-W1 R1.)
   */
  /** Eval window has not closed yet — the row is simply early, and correct to leave. */
  skipped_not_ready: number;
  /** The venue's shared batch lane had no headroom at pre-check time. See `venueHasBatchHeadroom`. */
  skipped_budget: number;
  /** `<exchange>:<coin>` already hit `MAX_FAIL_PER_SYMBOL` in this sweep. */
  skipped_poison: number;
  /** Unknown timeframe, no candles after signal time, or `computePFEMAE` returned null. */
  skipped_unevaluable: number;
  /** The fetch or the write threw. Counted, and it feeds the poison tally. */
  errors: number;
}

/**
 * ADVISORY headroom pre-check — `true` when the venue's shared batch lane still has room.
 *
 * WHY THIS EXISTS. `acquire()` makes a `batch` caller WAIT across window rolls for up to
 * `maxBatchWaitMs`, which defaults to **300 s**. That knob is a constructor option on the
 * per-venue singleton, so a lane cannot lower it for itself. Measured 2026-08-31, five of
 * fifteen venues sit at ~100% of their batch cap at p95 (OKX, MEXC, Hyperliquid, XT, KuCoin), so
 * without this check a single row on a saturated venue can stall a whole sweep for five minutes —
 * longer than the cadence such a sweep would run at. One counted skip now beats one stalled fire.
 *
 * WHY IT IS NOT A GUARD, and must never be promoted to one: headroom read here can be consumed
 * by any of the ~10 other batch callers before this process reaches its own `acquire()`. That
 * race is FINE — `acquire()` remains the sole authority and still waits or skips correctly. This
 * only avoids the common, predictable stall. It fails OPEN (returns `true`) on an unbudgeted
 * venue or an unreadable ledger, because refusing work on a failed instrument read would let a
 * bad ledger silently halt the lane — the dark-guard shape this wave exists to retire.
 */
export function venueHasBatchHeadroom(exchangeId: string): boolean {
  try {
    const entry = getVenueBudget(exchangeId);
    if (!entry) return true; // delay-paced shadow venue — no shared budget to be out of
    // `weightFor({})` is what an unhinted request costs here (1 on the request-count venues;
    // HL/Binance compute a `weightHint` in the adapter that we cannot know before the call, so
    // this under-estimates them — deliberately, since over-estimating would skip rows that
    // would in fact have fitted). `batchHeadroom()` is roll-aware and owns the one derivation
    // of `ceiling − reserve`.
    return entry.budget.batchHeadroom() >= entry.weightFor({});
  } catch {
    return true;
  }
}

/**
 * One bounded sweep. Fail-soft per row: a venue fetch that throws leaves the row unevaluated for
 * the next sweep rather than aborting the batch, exactly as the tracked lane does.
 */
export async function runBandOutcomeSweep(): Promise<BandOutcomeSweepResult> {
  const empty = {
    considered: 0, evaluated: 0, skipped_not_ready: 0, skipped_budget: 0,
    skipped_poison: 0, skipped_unevaluable: 0, errors: 0,
  };
  if (!bandOutcomeEnabled()) return { skipped: 'disabled', ...empty };
  // IN-PROCESS ONLY. This yields to a backfill running in THIS process (the lazy one behind
  // `getSignalPerformance`) and is blind to the `backfill-outcomes.js` cron, which is a separate
  // process — see the header. Kept because it is cheap and correct as far as it goes; it is not
  // the cross-process priority the header used to claim.
  if (isTrackedBackfillInflight()) {
    return { skipped: 'tracked_lane_busy', ...empty };
  }

  // Oldest-first: `getBandSignalsNeedingOutcome` orders `created_at ASC`, so a standing backlog
  // drains from its head rather than starving behind fresh arrivals.
  const rows = await getBandSignalsNeedingOutcome(bandOutcomeBatchSize());
  const tally = { ...empty, considered: rows.length };

  // Consecutive failures per `<exchange>:<coin>`, same shape and same key as
  // `backfill-outcomes.ts`. Sweep-scoped by design: it stops one bad symbol from consuming a
  // whole batch, and forgets across fires so a venue that recovers is retried rather than
  // permanently blacklisted by a transient outage.
  const failCounts = new Map<string, number>();

  await runAsBatch(async () => {
    for (const sig of rows) {
      const exchangeId = (sig.exchange as ExchangeId) || 'HL';
      const failKey = `${exchangeId}:${sig.coin}`;
      try {
        const candleMs = TF_MS[sig.timeframe];
        const evalCount = EVAL_CANDLES[sig.timeframe];
        if (!candleMs || !evalCount) { tally.skipped_unevaluable += 1; continue; }

        const signalTimeMs = sig.created_at * 1000;
        const endTimeNeeded = signalTimeMs + (evalCount + 1) * candleMs;
        if (Date.now() < endTimeNeeded) { tally.skipped_not_ready += 1; continue; }

        // POISON GUARD. Without it, a coin whose venue permanently 4xxs sits at the `created_at
        // ASC` head forever and burns a slot on every fire — and a drain report could never
        // distinguish that from an empty queue.
        if ((failCounts.get(failKey) ?? 0) >= MAX_FAIL_PER_SYMBOL) { tally.skipped_poison += 1; continue; }

        // ADVISORY, and cheap: skip before the fetch rather than let `acquire()` block up to its
        // 300 s batch wait on a venue measured at 100% of its cap.
        if (!venueHasBatchHeadroom(exchangeId)) { tally.skipped_budget += 1; continue; }

        const adapter = getAdapter(exchangeId);
        // `fetchEndTime` bounds the window on the TWO adapters that accept it — `hyperliquid.ts`
        // and `edgex.ts`. The other 15 declare `getCandles(coin, interval, startTime, _dex?)`
        // and silently ignore this 5th argument (TS bivariance lets the narrower signatures
        // satisfy the interface), so they return their fixed default page; OKX and Bitget each
        // issue a SECOND HTTP request inside one `getCandles` (`…/market/candles` then
        // `…/market/history-candles`). Of the 15 venues in the band backlog, Hyperliquid is the
        // ONLY one that honours it.
        //
        // The comparison this lane exists for still holds, because the tracked lane
        // (`backfill-outcomes.ts`) passes the same argument to the same adapters and therefore
        // pays the same per-row cost on the same venue. What does NOT hold is the "bounded
        // window" rationale that used to be written here, which was fictional off Hyperliquid.
        // _(Corrected 2026-08-31 `OPS-BAND-OUTCOME-WIRE-W1` R2 — the prior comment claimed the
        // bound as a property of the call rather than of two adapters.)_
        const fetchEndTime = signalTimeMs + (evalCount + 2) * candleMs;
        const candles = await adapter.getCandles(sig.coin, sig.timeframe, signalTimeMs, undefined, fetchEndTime);
        const relevant = candles.filter(c => c.time >= signalTimeMs);
        if (relevant.length < 1) { tally.skipped_unevaluable += 1; continue; }

        // The IMPORTED evaluator, verbatim. Not a band-specific copy — a second implementation
        // would make every band-vs-tracked difference unattributable.
        const result = computePFEMAE(sig, relevant, evalCount);
        if (!result) { tally.skipped_unevaluable += 1; continue; }

        await updateBandSignalOutcomes(sig.id!, toSignalOutcomeUpdate(result));
        tally.evaluated += 1;
      } catch {
        // Fail-soft per row, as the tracked lane does — but COUNTED, and it feeds the poison
        // tally so a permanently-failing symbol stops consuming slots within this sweep.
        failCounts.set(failKey, (failCounts.get(failKey) ?? 0) + 1);
        tally.errors += 1;
      }
    }
  }, 'band_outcome_backfill');

  return { skipped: null, ...tally };
}
