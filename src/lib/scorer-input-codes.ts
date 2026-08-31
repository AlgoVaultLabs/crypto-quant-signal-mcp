/**
 * scorer-input-codes.ts — OPS-SCORER-INPUT-PERSISTENCE-W1 R1/R3.
 *
 * The branch codes that make each adjustment stage's NET DELTA recoverable back to the branch
 * that produced it, plus the tolerance the arithmetic-identity gate judges on.
 *
 * A PURE-DATA LEAF, deliberately. `get-trade-call.ts` (the producer), the capture writers, the
 * identity test and the monitoring canary all project from THIS file; a second copy of any
 * constant here is a second definition of what a captured row means. It imports nothing, so
 * every one of those consumers can reach it without a cycle (the same reason
 * `published-population.ts` exists).
 *
 * ── WHY CODES EXIST AT ALL: THE INJECTIVITY TEST ─────────────────────────────────────────────
 *
 * A branch code is REQUIRED wherever the stage's net delta is NOT INJECTIVE onto its branch set
 * — i.e. wherever two different branches, or two different branch COMBINATIONS, can produce the
 * same net number. Where the delta alone identifies the branch, a code would be a second
 * derivation of something already recoverable, and is not added.
 *
 * The test was run for all three stages on 2026-08-31 against the live ladder. ALL THREE FAIL,
 * each for a different reason, and the reasons are recorded here because a future reader must be
 * able to see the test was performed rather than assume it:
 *
 *   FUNDING — FAILS. Two distinct branches emit the SAME net +10: the z-present contrarian bonus
 *     (`fundingZScore < -1.5`) and the z-null raw fallback (`fundingRateAnnualized < -4.38`).
 *     The net number cannot say which fired, and they are different claims about the market.
 *     A second, subtler case: because `sellSofteningZ` (-2.0) is BELOW the contrarian gate
 *     (-1.5), any z satisfying the softening branch ALSO satisfies the contrarian one — so when
 *     softening flips `rawScore` from negative to positive, BOTH fire and the net is +30, a value
 *     no single branch produces. The combination is reachable, so the branch set is not the set
 *     of single branches.
 *
 *   HURST — FAILS, and this one is the most valuable of the three. `hurstVal === null` (the
 *     indicator could not be evaluated) and `0.45 <= hurstVal <= 0.55` (evaluated, neutral) BOTH
 *     emit net 0. That is the exact "measured-neutral vs not-measured" ambiguity
 *     `verdict-factors.ts` already names for `rsiScore`, and it matters here more than there:
 *     Hurst is dead on 5 of 8 venues per EDGE-SCORING-LADDER-REDESIGN-W1 §1.5, so WHETHER it
 *     fired is itself a per-venue finding — and a bare 0 destroys it. The signed magnitude does
 *     separate the two LIVE branches (|25| ⇒ mean-reverting, |10| ⇒ trending), so the code's
 *     whole job is separating null from neutral.
 *
 *   SQUEEZE — FAILS. `squeezeActive === false` and `squeezeActive === true && |rawScore| <= 10`
 *     both emit net 0. The second is a squeeze that was DETECTED and then gated out by the
 *     magnitude guard — a different fact about the market from no squeeze at all.
 *
 * Storage cost of all three codes: ZERO. Five `SMALLINT` buckets occupy 10 bytes and must pad to
 * 16 for the following `DOUBLE PRECISION` run; three more `SMALLINT`s fill that padding exactly.
 * Measured as a property of Postgres alignment, not assumed.
 */

/**
 * FUNDING — a BITMASK, because the branches compose (see the +30 case above). A bitmask is the
 * only shape that can express "these two fired, in this order"; an enum would have to enumerate
 * combinations and would silently truncate the first unanticipated one.
 *
 * Bit 5 is not a branch — it records WHICH BRANCH SET was in play. Without it, a code of 0 cannot
 * say whether the z-score path ran and matched nothing, or the raw fallback ran and matched
 * nothing. That is the same null-vs-neutral defect the Hurst code exists for, one stage over.
 */
export const FUNDING_ADJUST = {
  /** `fundingZScore > buyPenaltyZ (2.5)` on a positive score ⇒ -20. Crowded longs. */
  BUY_PENALTY_Z: 1 << 0,
  /** `fundingZScore < sellSofteningZ (-2.0)` on a negative score ⇒ +20. Crowded shorts. */
  SELL_SOFTENING_Z: 1 << 1,
  /** `fundingZScore < -1.5` on a positive score ⇒ +10. Contrarian bullish. */
  CONTRARIAN_BONUS_Z: 1 << 2,
  /** z-null fallback: `fundingRateAnnualized > 4.38` on a negative score ⇒ +15. */
  SELL_SOFTENING_RAW: 1 << 3,
  /** z-null fallback: `fundingRateAnnualized < -4.38` on a positive score ⇒ +10. */
  CONTRARIAN_BONUS_RAW: 1 << 4,
  /** NOT a branch: set whenever `fundingZScore === null`, i.e. the raw-fallback set was in play. */
  Z_NULL_PATH: 1 << 5,
} as const;

/**
 * HURST — an ENUM, because the branches are mutually exclusive by construction (one `if/else if`
 * over disjoint ranges of a single scalar). A bitmask here would advertise a composition that
 * cannot happen.
 */
export const HURST_ADJUST = {
  /** `hurstVal === null` — NOT EVALUATED. Distinct from NEUTRAL; see the header. */
  NOT_EVALUATED: 0,
  /** `0.45 <= hurstVal <= 0.55` — evaluated, no adjustment. */
  NEUTRAL: 1,
  /** `hurstVal < 0.45` — mean-reverting/choppy ⇒ magnitude reduced by 25. */
  MEAN_REVERTING: 2,
  /** `hurstVal > 0.55` — trending/persistent ⇒ magnitude increased by 10. */
  TRENDING: 3,
} as const;

/** SQUEEZE — an ENUM for the same reason as Hurst; the three states are mutually exclusive. */
export const SQUEEZE_ADJUST = {
  /** No squeeze detected. */
  INACTIVE: 0,
  /** Squeeze DETECTED but `|rawScore| <= 10`, so the magnitude guard suppressed it. Net 0. */
  ACTIVE_GATED: 1,
  /** Squeeze detected and applied ⇒ magnitude increased by 12. */
  ACTIVE_APPLIED: 2,
} as const;

/**
 * The arithmetic-identity tolerance, in raw-score points.
 *
 * Every bucket ladder value times its weight is an INTEGER (rsi {30,24,12,0,…}, ema {10,0,…},
 * funding {20,10,0,…}, oi {9,3,0,…}, volume {20,16,10,2,-6,-14}), and every adjustment is an
 * integer, so both identities are exact in real arithmetic. They are evaluated in IEEE-754
 * doubles, where `0.30`, `0.15` and `0.20` are not exactly representable — so the residual is
 * bounded by a few ULPs of a value under ~130, i.e. ~1e-14, never zero-by-construction.
 *
 * 1e-9 is therefore ~5 orders of magnitude above the achievable residual and ~9 below the
 * smallest real defect (a wrong bucket moves the sum by >= 2). The gate additionally REPORTS the
 * maximum observed residual, so a drift from ~1e-14 toward the bound is visible long before it
 * trips — a tolerance without a reported residual is a number nobody can ever re-derive.
 */
export const IDENTITY_TOLERANCE = 1e-9;

/**
 * THE PARTS, as one shape — the single definition all three capture arms write and the identity
 * gate reads. A type rather than three parallel field lists: the arms must stay column-for-column
 * identical or the gate cannot UNION them and judge one shape, and three hand-maintained lists
 * would drift on the first arm somebody edits alone.
 *
 * Every field here is READ OFF `deriveVerdict`'s own locals. Nothing in this estate may recompute
 * a part from the others — a second computation is a second instrument, and the value of the
 * corpus is precisely that these are the numbers the engine used.
 */
export interface ScorerParts {
  /** The five indicator bucket values, from the SELECTED basis (`emittedScores`). */
  rsiScore: number;
  emaScore: number;
  fundingScore: number;
  /**
   * ⚠ THE oiScore THAT THE LIVE VERDICT USED, which is not always `oiScorePrice`.
   * `OISCORE_SOURCE=oi` swaps in the contracts-basis shadow score, and capturing the price-basis
   * value while the verdict came from the OI-basis one would produce a row whose parts do not sum
   * to its own total — the identity gate would (correctly) fail it. Default is 'price'; the flip
   * wave is SCAN-OISCORE-FLIP-W1.
   */
  oiScore: number;
  volumeScore: number;
  /** `SUM(bucket_i * WEIGHTS_i)`, before any adjustment. */
  raw0: number;
  /** Stage deltas, in application order. Hurst and squeeze read the sign at their own stage. */
  fundingDelta: number;
  hurstDelta: number;
  squeezeDelta: number;
  /** The post-adjustment score the threshold comparison actually read. */
  rawFinal: number;
  /** Branch codes — see the injectivity test in this file's header. */
  fundingAdjustCode: number;
  hurstAdjustCode: number;
  squeezeAdjustCode: number;
}

/**
 * Project a `deriveVerdict` outcome onto the persisted shape, pairing it with the bucket values
 * that produced it.
 *
 * THE ONE PLACE the two halves are joined. `deriveVerdict` returns the deltas and codes but not
 * the buckets (it receives them and does not echo them back), while the call site holds the
 * buckets. Doing the join here rather than at each of the three capture sites means a future
 * fourth arm cannot pair them differently — and, specifically, cannot pair the price-basis
 * `oiScore` with an OI-basis verdict.
 *
 * Structurally typed on both arguments so it needs no import from `get-trade-call.ts`, which
 * imports THIS module — the leaf discipline that keeps the cycle from forming.
 */
export function toScorerParts(
  buckets: { rsiScore: number; emaScore: number; fundingScore: number; oiScore: number; volumeScore: number },
  outcome: {
    raw0: number; fundingDelta: number; hurstDelta: number; squeezeDelta: number; rawScore: number;
    fundingAdjustCode: number; hurstAdjustCode: number; squeezeAdjustCode: number;
  },
): ScorerParts {
  return {
    rsiScore: buckets.rsiScore,
    emaScore: buckets.emaScore,
    fundingScore: buckets.fundingScore,
    oiScore: buckets.oiScore,
    volumeScore: buckets.volumeScore,
    raw0: outcome.raw0,
    fundingDelta: outcome.fundingDelta,
    hurstDelta: outcome.hurstDelta,
    squeezeDelta: outcome.squeezeDelta,
    rawFinal: outcome.rawScore,
    fundingAdjustCode: outcome.fundingAdjustCode,
    hurstAdjustCode: outcome.hurstAdjustCode,
    squeezeAdjustCode: outcome.squeezeAdjustCode,
  };
}

/**
 * ONE kill switch, all three arms. `SCORER_INPUT_CAPTURE_ENABLED=0` (or `=false`) stops capture
 * everywhere with no rebuild and no deploy; anything else — including unset — is ON, because
 * capture is this wave's deliverable and is forward-only.
 *
 * It lives in this LEAF rather than beside the emitted arm's writer for a structural reason:
 * `scorer-input-capture.ts` imports `hold-decision-capture.ts` for `resolveCaptureArm`, so the
 * two column-arms could not import the predicate back from it without forming a cycle. A leaf
 * every consumer can reach is the same shape `published-population.ts` took for
 * `MIN_TRACKABLE_CONFIDENCE`, and for the same reason.
 *
 * ONE flag rather than three: what an operator wants to stop is "the new write on the serving
 * path" — a single concern with three sites. Three flags would mean an incident is resolved only
 * by remembering all of them, and a partly-disabled capture yields arms covering different time
 * ranges, which is worse than either extreme.
 */
export function scorerCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.SCORER_INPUT_CAPTURE_ENABLED ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}
