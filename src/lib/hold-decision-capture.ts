/**
 * hold-decision-capture.ts — OPS-HOLD-DECISION-CAPTURE-W1 R1.
 *
 * Captures the two facts that make a HOLD reconstructible and which the engine currently throws
 * away: the side it WOULD have chosen, and the venue + price needed to replay a barrier race
 * against that side.
 *
 * ~99% of evaluations return HOLD, and *"the engine stays silent unless the signal is clear"* is
 * the flagship's live claim. It has never been measured, and could not be: `deriveVerdict` takes
 * `Math.abs(rawScore)` at `get-trade-call.ts:273` before deriving confidence, so the sign is gone
 * by the time anything is logged; `request_log` has no venue and no price; `hold_counts` is a
 * daily aggregate keyed only on (date, timeframe, coin). Nothing in this file changes what any
 * caller receives — it is pure instrumentation on a path that already runs.
 *
 * ── ZERO STATIC IMPORTS (structural, not stylistic) ──
 *
 * Same constraint as `emit-suppressions.ts` and `rate-limit-events.ts`, copied deliberately: a
 * static `get-trade-call → performance-db` import risks the documented init cycle
 * (`performance-db → asset-tiers → exchange-universe → _upstream-fetch → venue-budget-registry →
 * upstream-weight-budget`). A module with no static imports can never be in a cycle, and the lazy
 * `import()` resolves the already-loaded module at CALL time.
 *
 * Fire-and-forget + fail-open throughout: `recordHoldDecision` returns `void` synchronously and
 * the write happens in a microtask whose rejection is swallowed. Instrumentation that can delay
 * or fail a trade call is worse than no instrumentation.
 *
 * ── WHERE THE SAMPLING ACTUALLY LIVES ──
 *
 * Not here. The fleet arm's one-row-per-cell-per-day quota is a partial UNIQUE INDEX
 * (`uq_hold_decisions_fleet_cell`, migration 032) combined with `ON CONFLICT DO NOTHING`, so the
 * database itself is the sampler: race-free, no extra round trip, and unbiased with respect to
 * which coins get in. This module owns only the ARM decision, the runaway cap, and the shape of
 * the tuple. See the migration for why a deterministic hash prefilter — the obvious cheaper
 * design — is wrong (hashed on the cell key it is constant per cell, so it excludes the same
 * coins every day: a blocklist wearing a sampler's clothes).
 */

/** +1 BUY · -1 SELL · 0 exactly-zero score (no direction at all). */
import type { ScorerParts } from './scorer-input-codes.js';

export type WouldBeSide = -1 | 0 | 1;

/**
 * Which population a HOLD belongs to. Pooling these biases the pre-registered analysis, so the
 * distinction is recorded at capture rather than inferred later.
 *
 * `below_threshold` — |rawScore| never cleared BUY>40 / SELL>55. The claim's actual subject.
 * `book_liveness`   — the score DID clear, but the book was not trading, so the gate at
 *                     `get-trade-call.ts:291-296` forced HOLD *after* the threshold comparison.
 *                     Those decisions were confident; they are a categorically different thing
 *                     from "the signal was unclear".
 *
 * The live gate is `EMIT_BOOK_LIVENESS_MODE=shadow` (verified 2026-08-26), so `bookLive` is
 * passed `undefined` (`get-trade-call.ts:1028`) and no row will carry `book_liveness` until the
 * gate flips. That is exactly why it is defined now: adding the distinction after the flip would
 * leave a permanently unclassifiable segment straddling the cutover.
 */
export type HoldSuppressionReason = 'below_threshold' | 'book_liveness';

/** 'request' = the tool handler. 'fleet' = seed / batch. See {@link resolveCaptureArm}. */
export type CaptureArm = 'request' | 'fleet';

/**
 * The capture tuple as the call site knows it. `arm` is deliberately ABSENT: resolving it needs
 * `currentCaller()` from `upstream-weight-budget.js`, which sits in the documented init cycle
 * (`performance-db → asset-tiers → exchange-universe → _upstream-fetch → venue-budget-registry →
 * upstream-weight-budget`). Statically importing it into `get-trade-call.ts` to save one async
 * hop would re-open exactly the cycle this module's no-static-imports rule exists to avoid, so
 * the arm is resolved in the lazy continuation instead — where AsyncLocalStorage still carries
 * the caller tag, because promise continuations inherit the ALS context of the chain they were
 * created in.
 */
export interface HoldDecisionCapture {
  decidedAt: number; // epoch SECONDS — mirrors signals.created_at, not wall-clock bookkeeping
  coin: string;
  timeframe: string;
  exchange: string | null;
  regime: string | null;
  wouldBeSide: WouldBeSide;
  confidence: number;
  priceAtDecision: number;
  isBotInternal: boolean | null;
  suppressionReason: HoldSuppressionReason;
  /**
   * OPS-SCORER-INPUT-PERSISTENCE-W1 R1 — the scorer's own inputs for this decision.
   *
   * REQUIRED, not optional, and that is the point: an optional field is one a future edit can
   * drop in silence, and capture is FORWARD-ONLY — a dropped part is not a bug you find later,
   * it is data that never existed. The compiler refuses a capture that forgot them.
   */
  parts: ScorerParts;
}

/**
 * Callers that are the REQUEST path. Everything else — including `currentCaller()`'s `'unknown'`
 * default, which is what `seed-signals.ts` produces because it wraps in `runAsBatch` without a
 * caller tag — is FLEET.
 *
 * The fail-safe direction matters and is the reason this is an allowlist rather than a denylist:
 * an unrecognised caller lands in the *sampled, DB-capped* arm, so a future call site added
 * without touching this file can never blow the unsampled budget. A denylist would fail the
 * other way, silently.
 */
const REQUEST_CALLERS = new Set(['get_trade_call', 'get_trade_signal']);

export function resolveCaptureArm(caller: string | undefined): CaptureArm {
  return caller !== undefined && REQUEST_CALLERS.has(caller) ? 'request' : 'fleet';
}

/**
 * The would-be side from the POST-adjustment raw score.
 *
 * PIN THIS IDENTITY — there is more than one `rawScore` in this codebase and they are not
 * interchangeable. The value passed here is the score at `get-trade-call.ts:273`, AFTER funding-z
 * (:237-256), Hurst (:259-267) and squeeze (:268-271) adjustments. It is the value the threshold
 * comparison at :274-277 actually reads, and therefore the only one whose sign would have chosen
 * the side. **B-DIR used the PRE-adjustment score.** Joining, comparing or pooling the two would
 * silently mix two different quantities.
 *
 * `Math.sign` returns `-0` for negative zero; `|| 0` normalises it so the CHECK constraint and
 * any downstream `=== 0` both behave.
 */
export function wouldBeSideFromRawScore(rawScore: number): WouldBeSide {
  if (!Number.isFinite(rawScore)) return 0;
  return (Math.sign(rawScore) || 0) as WouldBeSide;
}

/**
 * Runaway guard on the fleet arm, per process, reset on UTC day change.
 *
 * This is a GUARD, not a metric: the DB-side unique index already bounds the fleet arm to one row
 * per cell per day (~16k/day at the measured cell count of ~11.2k daily (venue,coin,timeframe)
 * combinations). This exists so that a future change to the cell key — or a sudden expansion of
 * the scan universe — cannot quietly turn a bounded table into an unbounded one between two
 * monitoring cycles.
 *
 * Deliberately per-process and reset by restarts. Making it exact would require a shared counter
 * read on every HOLD, which is the round trip the index design just removed, to bound something
 * that is already bounded.
 *
 * NO SILENT TRUNCATION: crossing the cap logs once per day, with the count. A capture path that
 * drops rows without saying so reads downstream as "this cell had no HOLDs".
 */
let fleetDayBucket = -1;
let fleetCapturedToday = 0;
let capWarnedForDay = -1;

/** Test seam — the counter is module state, so a suite that exercises the cap must reset it. */
export function _resetFleetCapForTest(): void {
  fleetDayBucket = -1;
  fleetCapturedToday = 0;
  capWarnedForDay = -1;
}

export function fleetDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HOLD_CAPTURE_FLEET_DAILY_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20_000;
}

/** Capture is ON by default; `HOLD_DECISION_CAPTURE_ENABLED=0` is the no-rebuild kill switch. */
export function captureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.HOLD_DECISION_CAPTURE_ENABLED ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

/**
 * Admit-or-drop for the fleet arm's process-local cap. Exported for the cap test; the DB index is
 * still the real sampler and admission here does NOT mean a row will be written.
 */
export function admitFleetCapture(decidedAt: number, cap: number): boolean {
  const day = Math.floor(decidedAt / 86_400);
  if (day !== fleetDayBucket) {
    fleetDayBucket = day;
    fleetCapturedToday = 0;
  }
  if (fleetCapturedToday >= cap) {
    if (capWarnedForDay !== day) {
      capWarnedForDay = day;
      console.warn(
        `[hold-decision-capture] fleet daily cap ${cap} reached for UTC day ${day}; ` +
          `further fleet captures DROPPED until 00:00Z. Raise HOLD_CAPTURE_FLEET_DAILY_CAP or ` +
          `investigate cell-count growth.`,
      );
    }
    return false;
  }
  fleetCapturedToday += 1;
  return true;
}

/**
 * Record one HOLD decision. Fire-and-forget, fail-open, silent on success.
 *
 * Returns `void` synchronously — no `await` is added to the request path, which is what makes the
 * "no new latency" acceptance criterion structural rather than a measurement that happened to
 * come out flat.
 */
export function recordHoldDecision(c: HoldDecisionCapture): void {
  if (!captureEnabled()) return;
  // Offline under vitest by default so a trade-call test never spins up the SQLite backend.
  // `HOLD_CAPTURE_TEST=1` re-enables the real path for the fail-open recorder test.
  if (process.env.VITEST && process.env.HOLD_CAPTURE_TEST !== '1') return;
  void import('./upstream-weight-budget.js')
    .then(async (wb) => {
      const arm = resolveCaptureArm(wb.currentCaller());
      if (arm === 'fleet' && !admitFleetCapture(c.decidedAt, fleetDailyCap())) return;
      const db = await import('./performance-db.js');
      db.recordHoldDecisionImpl({ ...c, arm });
    })
    .catch((e) =>
      console.warn(
        `[hold-decision-capture] record failed (fail-open): ${e instanceof Error ? e.message : e}`,
      ),
    );
}
