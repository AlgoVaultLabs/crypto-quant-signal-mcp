/**
 * emit-suppressions.ts — OPS-PFE-METRIC-INTEGRITY-W1 R3 (C3 ruling).
 *
 * Thin, CYCLE-SAFE entry point for the fail-open emit-suppression counter. Structure copied
 * verbatim from `rate-limit-events.ts`, for the same reason: a static
 * `get-trade-call → performance-db` import would risk the documented init cycle
 * (`performance-db → asset-tiers → exchange-universe → _upstream-fetch →
 * venue-budget-registry → upstream-weight-budget`). This module has **zero static imports**,
 * so it can never be in a cycle, and the lazy `import()` resolves the already-loaded module at
 * CALL time.
 *
 * Fire-and-forget + fail-open: returns `void` synchronously; the DB write happens in a
 * microtask whose rejection is swallowed (the impl has its own try/catch too). It can NEVER
 * delay or break an emission — a telemetry counter that can fail a trade call is worse than no
 * counter at all.
 *
 * ── WHY A COUNTER EXISTS AT ALL (C3: "the rate is MEASURED, not argued") ──
 *
 * A suppressed emission becomes a **HOLD**, and HOLD is written to `hold_counts`, whose schema
 * is `(date, timeframe, coin, hold_count)` — **no `exchange` column**. So the HOLD row alone
 * cannot attribute a suppression to a venue, and freeze is overwhelmingly venue-specific
 * (measured: ASTER 5.93% of evaluated rows vs BINANCE/BYBIT/OKX/KUCOIN/MEXC exactly 0.000%).
 * This table carries `exchange` precisely so that gap is not repeated.
 *
 * ── THE LIMITATION THAT MAKES THIS THE *ONLY* RECORD ──
 *
 * Suppressed calls become HOLDs, and **HOLD is never persisted in `signals`** (live:
 * `SELECT signal, count(*) FROM signals GROUP BY 1` → `BUY 347,712` / `SELL 35,090`, zero HOLD
 * rows). The directional labeler is hardcoded `FROM signals … WHERE signal IN ('BUY','SELL')`
 * (`backfill-directional-labels.ts:150`, `:193`), so the suppressed cohort is **structurally
 * invisible to DWR labelling**. There is no second source to reconcile against: if this
 * counter is wrong or missing, the suppression rate is unknowable after the fact.
 *
 * Daily aggregate, mirroring `hold_counts` — NOT row-per-event. `hold_counts` records ~660k
 * HOLDs/day; suppressions are a subset of that same evaluation firehose, and an append-only
 * event table at that rate is costly. `rate_limit_events` is row-per-event because it is sized
 * for RARE events; this is not that.
 */

import type { BookLivenessMode } from './book-liveness.js';

/**
 * Why an emission was suppressed. A string union rather than a bare string so a new reason
 * cannot be added without the type surfacing every consumer.
 *
 * ── WHY THE MODE IS PART OF THE REASON (EDGE-SELL-RESOLUTION-ASYMMETRY-W1 Q3) ──
 *
 * `shadow` and `enforce` BOTH write here — deliberately, so the shadow-compare report and the
 * live rate come from one code path (see the call site in `get-trade-call.ts`). But the row
 * they wrote was indistinguishable, and a downstream consumer that reads "are there any rows"
 * as "the gate is live" then goes silently WRONG the moment shadow starts: in shadow the
 * verdict is untouched, so the emitted corpus still contains every frozen-book row.
 *
 * That consumer is real. `autonomous-optimizer`'s `src/monitoring/dwr_baseline.py`
 * `frozen_book_footnote()` renders *"decided set still includes frozen-book rows (liveness
 * gate dark)"* and hid it on `count(*) > 0` — which is TRUE throughout shadow. It reads this
 * table over the read-only pg-tunnel and has no other way to observe the gate's mode, so the
 * distinction has to exist in the DATA. `reason` is already part of the primary key
 * (`date, exchange, timeframe, coin, reason`), so splitting by mode needs no migration.
 *
 * `frozen_book` therefore means "an emission was ACTUALLY withheld"; `frozen_book_shadow`
 * means "would have been, had the gate been enforcing".
 */
export type SuppressionReason = 'frozen_book' | 'frozen_book_shadow';

/**
 * The ONE mapping from rollout stage to recorded reason. Single-derivation: every consumer
 * projects from this, and `off` can never reach here (the predicate does not run), so it maps
 * to the shadow value rather than inventing a third.
 */
export function suppressionReasonFor(mode: BookLivenessMode): SuppressionReason {
  return mode === 'enforce' ? 'frozen_book' : 'frozen_book_shadow';
}

/**
 * Increment the suppression counter for one (day, venue, timeframe, coin, reason).
 *
 * `reason` is REQUIRED, not defaulted. A default would have to pick a mode, and picking
 * `frozen_book` would let a caller that forgets the argument mint a fake "we actually withheld
 * this" row — the exact class of defect this parameter exists to prevent. Derive it with
 * {@link suppressionReasonFor}.
 *
 * @param exchange The venue whose book was frozen — the field `hold_counts` lacks.
 */
export function recordEmitSuppression(
  exchange: string,
  timeframe: string,
  coin: string,
  reason: SuppressionReason,
): void {
  // Offline under vitest by default so an emit-path test never spins up the SQLite backend.
  // `EMIT_SUPPRESSIONS_TEST=1` re-enables the real path for the fail-open recorder test.
  if (process.env.VITEST && process.env.EMIT_SUPPRESSIONS_TEST !== '1') return;
  void import('./performance-db.js')
    .then((m) => m.recordEmitSuppressionImpl(exchange, timeframe, coin, reason))
    .catch((e) => console.warn(`[emit-suppressions] record failed (fail-open): ${e instanceof Error ? e.message : e}`));
}
