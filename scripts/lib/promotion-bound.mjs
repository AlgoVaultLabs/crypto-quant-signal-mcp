/**
 * OPS-AUTHOR-IDENTITY-PROMOTE-W1 R4a — the shared promotion-bound assertion.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED
 * -------------------------------------
 * Until this wave the YYYY-MM-DD shape check was hardcoded to ONE block —
 * `freshness_promotion` in check-claudemd-claims.mjs. Every other promotion block in the repo
 * therefore inherited ZERO enforcement, which is exactly how `report_class_promotion` (no date)
 * and session-drift's `_mode2_promotion_criterion` (a prose STRING, not even an object) came to
 * exist. A rule enforced on one instance of a class is a rule that silently exempts every future
 * instance. Sharing the assertion retires the class: the next promotion block added to either
 * config cannot ship dateless.
 *
 * WHY BOTH BOUNDS
 * ---------------
 * A promotion criterion needs a numeric bar AND a calendar bound. A numeric bar alone can never
 * fire on a clock — only when someone remembers — and this repo has recorded a REPORT-only guard
 * left in place indefinitely as decoration. A date alone flips a guard that is still noisy.
 *
 * DELIBERATELY NOT UNIVERSAL — read before "unifying" anything
 * -----------------------------------------------------------
 * TWO criterion shapes exist in this repo and the divergence is INTENTIONAL:
 *
 *   {runs_required, escalate_after}                                   -> RUNS vs an ESCALATION DATE
 *     freshness_promotion, report_class_promotion, mode2_promotion    -> asserted here
 *
 *   {max_violations, not_before, measure_from, min_rows_in_window}    -> VIOLATIONS vs a START BOUND
 *     ops/author-identity-allowlist.json -> promotion                 -> NOT asserted here
 *
 * Applying this assertion to the author-identity block would throw, because that block measures a
 * different quantity against a different kind of bound. Do not "unify" them — that is the same
 * mistake as collapsing claudemd-claim-config's two criteria, which have two owners on purpose.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Assert that `block` is a well-formed {runs_required, escalate_after, reason, owner} promotion
 * criterion. Throws an Error naming `name`, so a failure identifies WHICH block is malformed —
 * a bare "invalid promotion block" in a config with three of them costs a bisect.
 *
 * Checks are a superset-or-equal of the inline ones this replaced; never weaker.
 *
 * @param {unknown} block  the promotion object to validate
 * @param {string}  name   the config key, used verbatim in every thrown message
 */
export function assertPromotionBound(block, name) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(`${name} must be an object — a promotion criterion that lives in prose cannot be enforced`);
  }
  if (typeof block.runs_required !== 'number') {
    throw new Error(`${name}.runs_required must be numeric — a promotion criterion is a number that can be checked, not a vibe`);
  }
  if (!DATE_RE.test(String(block.escalate_after ?? ''))) {
    throw new Error(`${name}.escalate_after must be a YYYY-MM-DD calendar bound — a numeric criterion with no deadline is how a REPORT-only guard becomes permanent`);
  }
  if (!block.reason || typeof block.reason !== 'string') {
    throw new Error(`${name} needs a reason — a bound with no recorded rationale is indistinguishable from someone moving the goalposts`);
  }
  if (!block.owner || typeof block.owner !== 'string') {
    throw new Error(`${name} needs an owning follow-up wave — an unowned criterion is nobody's job`);
  }
}

export default assertPromotionBound;
