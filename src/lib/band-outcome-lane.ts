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
 * ── PRIORITY IS ONE-WAY, AND ASSERTED ────────────────────────────────────────────────────────
 *
 * The tracked evaluator feeds the PUBLISHED number and was measured (OPS-HL-BACKFILL-BATCH-W1) as
 * 100% of HL interactive BUDGET_CEILING throws. This lane therefore yields to it and never the
 * reverse: it reads `isTrackedBackfillInflight()` and returns, while nothing in
 * `signal-performance.ts` calls anything here. `tests/unit/band-outcome-lane.test.ts` asserts
 * both directions — the yield, and the ABSENCE of any reverse reference — because priority that
 * both sides negotiate is priority neither side has.
 *
 * It also runs in the BATCH lane (`runAsBatch`), so under budget pressure it WAITS rather than
 * stealing the interactive reserve from live `get_trade_call` callers.
 */
import { getAdapter } from './exchange-adapter.js';
import { runAsBatch } from './upstream-weight-budget.js';
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

export interface BandOutcomeSweepResult {
  /** Why the sweep did nothing, or `null` when it ran. Never silent — a skipped sweep and an
   *  empty one are different facts and a caller must be able to tell them apart. */
  skipped: 'disabled' | 'tracked_lane_busy' | null;
  considered: number;
  evaluated: number;
}

/**
 * One bounded sweep. Fail-soft per row: a venue fetch that throws leaves the row unevaluated for
 * the next sweep rather than aborting the batch, exactly as the tracked lane does.
 */
export async function runBandOutcomeSweep(): Promise<BandOutcomeSweepResult> {
  if (!bandOutcomeEnabled()) return { skipped: 'disabled', considered: 0, evaluated: 0 };
  // THE YIELD. Checked before any work — including before the queue read — so a busy tracked lane
  // costs this lane one boolean rather than a DB round trip plus a discarded batch.
  if (isTrackedBackfillInflight()) {
    return { skipped: 'tracked_lane_busy', considered: 0, evaluated: 0 };
  }

  const rows = await getBandSignalsNeedingOutcome(bandOutcomeBatchSize());
  let evaluated = 0;

  await runAsBatch(async () => {
    for (const sig of rows) {
      try {
        const candleMs = TF_MS[sig.timeframe];
        const evalCount = EVAL_CANDLES[sig.timeframe];
        if (!candleMs || !evalCount) continue;

        const signalTimeMs = sig.created_at * 1000;
        const endTimeNeeded = signalTimeMs + (evalCount + 1) * candleMs;
        if (Date.now() < endTimeNeeded) continue; // not ready yet

        const adapter = getAdapter((sig.exchange as ExchangeId) || 'HL');
        // Same bounded window as the tracked lane — [signalTime, evalCount+2] rather than
        // [signalTime, now] — so a band row costs the same upstream weight as a tracked one and
        // the headroom arithmetic in R2b stays honest.
        const fetchEndTime = signalTimeMs + (evalCount + 2) * candleMs;
        const candles = await adapter.getCandles(sig.coin, sig.timeframe, signalTimeMs, undefined, fetchEndTime);
        const relevant = candles.filter(c => c.time >= signalTimeMs);
        if (relevant.length < 1) continue;

        // The IMPORTED evaluator, verbatim. Not a band-specific copy — a second implementation
        // would make every band-vs-tracked difference unattributable.
        const result = computePFEMAE(sig, relevant, evalCount);
        if (!result) continue;

        await updateBandSignalOutcomes(sig.id!, toSignalOutcomeUpdate(result));
        evaluated += 1;
      } catch {
        // Skip failed fetches silently — the next sweep picks the row up again.
      }
    }
  }, 'band_outcome_backfill');

  return { skipped: null, considered: rows.length, evaluated };
}
