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

/**
 * Why an emission was suppressed. A string union rather than a bare string so a new reason
 * cannot be added without the type surfacing every consumer.
 */
export type SuppressionReason = 'frozen_book';

/**
 * Increment the suppression counter for one (day, venue, timeframe, coin, reason).
 *
 * @param exchange The venue whose book was frozen — the field `hold_counts` lacks.
 */
export function recordEmitSuppression(
  exchange: string,
  timeframe: string,
  coin: string,
  reason: SuppressionReason = 'frozen_book',
): void {
  // Offline under vitest by default so an emit-path test never spins up the SQLite backend.
  // `EMIT_SUPPRESSIONS_TEST=1` re-enables the real path for the fail-open recorder test.
  if (process.env.VITEST && process.env.EMIT_SUPPRESSIONS_TEST !== '1') return;
  void import('./performance-db.js')
    .then((m) => m.recordEmitSuppressionImpl(exchange, timeframe, coin, reason))
    .catch((e) => console.warn(`[emit-suppressions] record failed (fail-open): ${e instanceof Error ? e.message : e}`));
}
