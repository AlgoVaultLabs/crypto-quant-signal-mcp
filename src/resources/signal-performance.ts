import { getPerformanceStatsAsync, getSignalsNeedingUnifiedBackfillAsync, updateSignalOutcomes, recordBackfillAttempt } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { runAsBatch } from '../lib/upstream-weight-budget.js';
import type { ExchangeId, PerformanceStats } from '../types.js';
import { computePFEMAE, toSignalOutcomeUpdate, EVAL_CANDLES, TF_MS } from '../lib/pfe-mae.js';

/**
 * Run a lightweight backfill pass with PFE/MAE multi-candle tracking.
 * v1.4: fetches candle data for each pending signal and computes
 * outcome, PFE, and MAE across the evaluation window.
 * Called lazily on resource access — processes max 10 signals per call.
 */
export async function runBackfill(): Promise<void> {
  try {
    const signals = await getSignalsNeedingUnifiedBackfillAsync();
    // Process max 50 per resource access to keep it lightweight
    const batch = signals.slice(0, 50);

    for (const sig of batch) {
      try {
        const candleMs = TF_MS[sig.timeframe];
        const evalCount = EVAL_CANDLES[sig.timeframe];
        if (!candleMs || !evalCount) continue;

        const signalTimeMs = sig.created_at * 1000;
        const endTimeNeeded = signalTimeMs + (evalCount + 1) * candleMs;
        if (Date.now() < endTimeNeeded) continue; // not ready yet

        const adapter = getAdapter((sig.exchange as ExchangeId) || 'HL');
        // OPS-HL-SEED-LOAD-W1: bound the HL candle fetch to the eval window (+2
        // buffer) instead of [signalTime, now] (~5000 candles, HL weight ~104).
        // We only consume evalCount candles below; outcome math unchanged.
        const fetchEndTime = signalTimeMs + (evalCount + 2) * candleMs;
        const candles = await adapter.getCandles(sig.coin, sig.timeframe, signalTimeMs, undefined, fetchEndTime);
        const relevant = candles.filter(c => c.time >= signalTimeMs);
        // OPS-OUTCOME-BACKFILL-STALL-W1 A1 — this lazy path shares ONE queue with the cron, so it
        // must feed the same durable breaker. If only the cron recorded attempts, every resource
        // read would keep re-serving the sediment the cron had just backed off, and the two
        // consumers of one queue would disagree about which rows are worth attempting.
        // `not ready yet` above records nothing, for the same reason it records nothing in the
        // cron: an immature row is not a failed row.
        if (relevant.length < 1) { await recordBackfillAttempt(sig.id!); continue; }

        const result = computePFEMAE(sig, relevant, evalCount);
        if (!result) { await recordBackfillAttempt(sig.id!); continue; }

        await updateSignalOutcomes(sig.id!, toSignalOutcomeUpdate(result));
      } catch {
        // Skip failed fetches silently — cron will pick them up
      }
    }
  } catch {
    // Skip backfill errors silently
  }
}

/**
 * OPS-HL-BACKFILL-BATCH-W1: single-flight the lazy outcome-backfill so concurrent
 * `getSignalPerformance` reads SHARE one batch sweep. Mirrors
 * `cross-asset-grid.ts ensureRefreshInflight` EXACTLY (set-on-start / clear-on-settle).
 * `runBackfill` is a GLOBAL no-arg "all due outcomes" sweep
 * (`getSignalsNeedingUnifiedBackfillAsync()` takes no args) → one in-flight covers every
 * concurrent reader; reader B's needs are satisfied by reader A's sweep.
 *
 * NOTE (generator hygiene): this is the 2nd hand-rolled pure-single-flight-void wrapper
 * (`ensureRefreshInflight` = 1st; `coalescedCache` doesn't fit — it caches a value, this
 * returns none). Below the 3-example extraction threshold → inline. A 3rd warrants a
 * shared `singleFlight()` helper (WIS-flagged).
 */
let backfillInflight: Promise<void> | null = null;

/**
 * OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2 — an IN-PROCESS inflight read.
 *
 * Nothing in THIS file references the band lane, and that half of the asymmetry is real and
 * asserted: `tests/unit/band-population-invariance.test.ts` fails the build if this module ever
 * mentions `band-outcome-lane`, `runBandOutcomeSweep` or `bandOutcomeEnabled`. The tracked
 * evaluator that feeds the published number therefore cannot be blocked, delayed or reordered by
 * a counterfactual measurement, because it does not know the band lane exists.
 *
 * **The other half is NOT a cross-process priority, and used to be described as one.**
 * `backfillInflight` above is module-level state set only by `getSignalPerformance()` in the
 * SAME process. The dominant tracked consumer is the `backfill-outcomes.js` cron, which runs as
 * a separate `docker exec` process — so a scheduled band sweep reads its own fresh module state
 * and this returns a constant `false`. It is a useful in-process courtesy and nothing more.
 * The real mechanism is a weight class below `batch` in `upstream-weight-budget.ts`, deferred to
 * the capacity wave; see `OPS-HL-INTERACTIVE-STARVATION-W1`.
 *
 * _(Corrected 2026-08-31 `OPS-BAND-OUTCOME-WIRE-W1`. The prior text cited
 * `tests/unit/band-outcome-lane.test.ts` as asserting BOTH directions. That file exists on no
 * ref and never has; only the absence half was ever asserted, by the test named above, and the
 * yield half could not have passed a behavioural test because it does not work across
 * processes.)_
 */
export function isTrackedBackfillInflight(): boolean {
  return backfillInflight !== null;
}

/**
 * Get signal performance stats (the MCP resource handler).
 * Backfill runs in the background — never blocks the response.
 */
export async function getSignalPerformance(): Promise<PerformanceStats> {
  // OPS-HL-BACKFILL-BATCH-W1: run the lazy outcome-backfill in the BATCH lane — it was the
  // SOLE interactive backfill path (100% of HL interactive BUDGET_CEILING throws per
  // OPS-RATELIMIT-CALLER-ATTRIBUTION-W1); in batch it WAITS under budget pressure instead of
  // stealing the interactive reserve from live `get_trade_call(HL)` callers. Single-flighted
  // so concurrent reads share one batch sweep. Keeps the `signal_perf_backfill` caller tag.
  // Fire-and-forget — never blocks the read: `getPerformanceStatsAsync` below is untouched,
  // so returned-stats freshness is identical (only the background backfill coalesces).
  if (backfillInflight === null) {
    backfillInflight = runAsBatch(() => runBackfill(), 'signal_perf_backfill').finally(() => {
      backfillInflight = null;
    });
  }
  void backfillInflight.catch(() => {});
  return getPerformanceStatsAsync();
}
