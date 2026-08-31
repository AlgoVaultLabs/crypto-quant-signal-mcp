/**
 * OPS-HL-INTERACTIVE-STARVATION-W1 — the `request_log.verdict` vocabulary for `get_market_regime`.
 *
 * WHY `verdict` CARRIES THE OUTCOME AND NOT THE REGIME. `request_log` has both a `verdict` and a
 * `regime` column. Writing the classification into both would make one of them redundant and leave
 * the wave's actual question — did this call succeed — still unanswerable. So for this tool
 * `verdict` is the CALL OUTCOME and `regime` is the classification. `get_trade_call` writes its
 * BUY/SELL/HOLD into `verdict` because for that tool the outcome and the decision are the same
 * thing; here they are not, and the columns are read per `tool_name` anyway.
 *
 * WHY THREE STATES AND NOT TWO. A `get_market_regime` call touches Hyperliquid on two independent
 * legs (`get-market-regime.ts:311-313`), and a `BUDGET_CEILING` refusal on each has a DIFFERENT
 * consequence for the customer:
 *
 *   • candles leg (`exchange=HL`, the default) → throws → the caller gets
 *     `isError: true` / `UPSTREAM_RATE_LIMIT`                                → `ERR_UPSTREAM_RATE_LIMIT`
 *   • funding leg (EVERY call, EVERY venue) → swallowed by `.catch` → the caller gets a 200 whose
 *     `cross_venue_funding_sentiment` has silently become `'NEUTRAL'`         → `DEGRADED_FUNDING_BUDGET`
 *   • neither                                                                → `OK`
 *
 * Collapsing the middle state into either neighbour is the defect this wave exists to remove:
 * folded into `OK` it is the silent degradation that ran for ten days unseen; folded into the
 * error state it would overstate hard failures and make the fix unprovable.
 */

/** Clean call — neither HL leg was refused. */
export const REGIME_VERDICT_OK = 'OK';

/**
 * The call SUCCEEDED (HTTP 200, `isError` false) but its cross-venue funding leg was refused by the
 * HL interactive weight budget, so `cross_venue_funding_sentiment` degraded to `'NEUTRAL'` with
 * `'Insufficient cross-venue data'`. Indistinguishable from a real neutral market in the RESPONSE —
 * this token is the only place the difference survives.
 */
export const REGIME_VERDICT_DEGRADED_FUNDING = 'DEGRADED_FUNDING_BUDGET';

/** Prefix for a call that surfaced an error to the caller. Suffix is the error's stable `code`. */
export const REGIME_VERDICT_ERROR_PREFIX = 'ERR_';

/** Fallback suffix for an error carrying no stable machine-readable `code`. */
export const REGIME_VERDICT_ERROR_UNKNOWN = 'UNKNOWN';

/**
 * Verdict for a call that RETURNED a result. Pure.
 * @param fundingDegraded `true` only when an upstream rate-limit refusal on the funding leg was
 *   actually observed. Never infer it from an empty funding array — a coin with no HL funding
 *   produces the same empty array and is a legitimate `OK`.
 */
export function regimeSuccessVerdict(fundingDegraded: boolean): string {
  return fundingDegraded ? REGIME_VERDICT_DEGRADED_FUNDING : REGIME_VERDICT_OK;
}

/**
 * Verdict for a call that THREW. Pure, total, and never throws itself — it runs on the error path,
 * where a second throw would lose the row entirely and re-open the blind spot.
 *
 * Reads the error's own `code` (`UpstreamRateLimitError.code === 'UPSTREAM_RATE_LIMIT'`, pinned in
 * `errors.ts:39` because clients pattern-match on it) rather than its message, so the stored token
 * tracks the contract the caller sees instead of prose that can be reworded.
 */
export function regimeErrorVerdict(err: unknown): string {
  const raw = (err as { code?: unknown } | null | undefined)?.code;
  const code = typeof raw === 'string' && raw.length > 0 && raw.length <= 64
    ? raw
    : REGIME_VERDICT_ERROR_UNKNOWN;
  return `${REGIME_VERDICT_ERROR_PREFIX}${code}`;
}

/** True for any verdict token this module emits on the error arm. Used by the failure-rate reader. */
export function isRegimeErrorVerdict(verdict: string | null | undefined): boolean {
  return typeof verdict === 'string' && verdict.startsWith(REGIME_VERDICT_ERROR_PREFIX);
}
