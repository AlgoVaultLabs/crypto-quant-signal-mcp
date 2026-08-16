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
 * Criterion SHAPES diverge in this repo and the divergence is INTENTIONAL:
 *
 *   {runs_required, escalate_after}                                   -> RUNS vs an ESCALATION DATE
 *     freshness_promotion, report_class_promotion, mode2_promotion    -> asserted here
 *
 *   {max_violations, not_before, measure_from, min_commits_in_window} -> VIOLATIONS vs a START BOUND
 *     ops/author-identity-allowlist.json -> promotion                 -> NOT asserted here
 *
 *   {max_unexplained, not_before}                                     -> COUNT vs a START BOUND
 *     ops/dark-exports-config.json -> promotion                       -> NOT asserted here
 *
 *   {numeric_criterion{}, time_bound{}}   /   {max_violations, decide_by, observed[]}
 *     ops/gate-staleness-config.json -> promotion                     -> NOT asserted here
 *     ops/shared-worktree-state.json -> ...R1_confinement.promotion   -> NOT asserted here
 *
 * Applying this assertion to any of the last three would throw, because they measure different
 * quantities against different kinds of bound. Do not "unify" them — that is the same mistake as
 * collapsing claudemd-claim-config's two criteria, which have two owners on purpose.
 *
 * ── CORRECTION, OPS-PROMOTION-INSTRUMENT-INDEPENDENCE-W1 ──────────────────────────────────
 * This header said "TWO criterion shapes exist". Measured at that wave's Plan Mode: FOUR, across
 * SEVEN promotion blocks, not the four blocks its own spec asserted. The undercount survived
 * because the census was read rather than scanned — the same defect the block below exists to
 * retire, in the file that retires it. `tests/unit/promotion-independence.test.ts` now DISCOVERS
 * the set by recursive scan of ops/*.json instead of trusting any list, this one included.
 *
 * INDEPENDENCE IS ORTHOGONAL TO SHAPE
 * ----------------------------------
 * `assertInstrumentIndependence` below reads ONLY `block.instrument`. It never touches
 * `runs_required`, `max_violations` or any other shape field, which is the only reason it can
 * cover all seven blocks — including the author-identity one this assertion must never see.
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

/**
 * OPS-PROMOTION-INSTRUMENT-INDEPENDENCE-W1 R1.1 — the instrument-independence contract.
 *
 * WHAT THIS ASKS, AND WHY IT IS NOT "WHO WROTE THE LOG"
 * ----------------------------------------------------
 * A promotion criterion is a decision to make a guard BLOCK. The evidence behind that decision
 * has to be evidence about the WORLD, not evidence the guard can mint about itself. The obvious
 * test — "is the log written by the thing under test?" — is the wrong one: it rejects every
 * criterion in this repo, and a contract that rejects everything gets deleted within a week.
 *
 * The property that actually matters is:
 *
 *   CAN A DELIBERATE INVOCATION MANUFACTURE A VALUE THAT NEVER OCCURRED IN OPERATION?
 *
 * That is the difference between the two cases this wave was built on:
 *
 *   author-identity  YES. `GIT_AUTHOR_EMAIL=test@test.local` fabricates a violation out of
 *                    nothing. It is what poisoned the ledger and HALTed the previous wave.
 *   gate-staleness   NO.  The gate READS fleet state. You cannot make it report stale worktrees
 *                    that do not exist without first creating them. A manual run adds a TRUE
 *                    extra sample, never a fabricated one.
 *
 * Re-derivability was the first proxy tried for this and it merely CORRELATED — it graded
 * gate-staleness as invalid (its number is a world-state instant and is not recomputable later)
 * while gate-staleness is in fact perfectly safe. Grade D exists because of that miss.
 *
 * THE FOUR GRADES
 * ---------------
 *   A  INDEPENDENT POPULATION — the instrument is written by something other than the subject;
 *      a deliberate run cannot enter it at all.                    e.g. git history
 *   B  RE-DERIVABLE — the subject writes it, but the same verdict is recomputable at any commit
 *      from inputs the subject does not control. The log is a CACHE, not the source of truth.
 *      REQUIRES `rederive`: a cache with no stated re-derivation is grade C wearing a label.
 *   D  LIVE OBSERVATION — the subject writes it, the value is external world-state at an instant
 *      and is NOT recomputable later, but a deliberate run cannot manufacture a violation.
 *      REQUIRES `reobserve`: the command that re-takes the measurement NOW. Without it the
 *      number is unfalsifiable, which is grade C by a slower route.
 *   C  SUBJECT-WRITTEN AND MANUFACTURABLE — the log is the sole record and a deliberate
 *      invocation can produce a value that never occurred operationally. ALWAYS INVALID.
 *
 * SHAPE-AGNOSTIC BY CONSTRUCTION. This reads `block.instrument` and nothing else, so it applies
 * to all four criterion shapes in this repo — including author-identity's, which the shape
 * assertion above must never be pointed at. Do not add a shape field to this function.
 *
 * @param {unknown} block  the promotion object whose `instrument` is validated
 * @param {string}  name   the config key, used verbatim in every thrown message
 */
export function assertInstrumentIndependence(block, name) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(`${name} must be an object before it can declare an instrument`);
  }
  const inst = block.instrument;
  if (!inst || typeof inst !== 'object' || Array.isArray(inst)) {
    throw new Error(`${name}.instrument must be an object — a promotion criterion that does not declare what population it measures and who writes it is asking to be trusted rather than checked`);
  }

  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

  if (!nonEmpty(inst.population)) {
    throw new Error(`${name}.instrument.population must be a non-empty string — name WHAT IS COUNTED, or nobody can tell later whether the number answered the question`);
  }
  if (!nonEmpty(inst.written_by)) {
    throw new Error(`${name}.instrument.written_by must be a non-empty string — name WHAT PRODUCES THE RECORD; an unnamed producer cannot be reasoned about`);
  }

  const GRADES = ['A', 'B', 'C', 'D'];
  if (!GRADES.includes(inst.grade)) {
    throw new Error(`${name}.instrument.grade must be one of ${GRADES.join(' | ')} — A independent population, B re-derivable, D live observation, C subject-written AND manufacturable`);
  }

  if (inst.grade === 'C') {
    throw new Error(`${name}.instrument.grade is "C" — a subject-written instrument whose value a deliberate invocation can MANUFACTURE cannot support a promotion decision. The log is the sole record, so a run made to prove a point is indistinguishable from an operational one. Re-point the criterion at a population the subject cannot write (grade A), state how the verdict is re-derived from inputs it does not control (grade B), or establish that a deliberate run can only add a TRUE sample (grade D). Do not relabel it.`);
  }
  if (inst.grade === 'B' && !nonEmpty(inst.rederive)) {
    throw new Error(`${name}.instrument.grade is "B" but no rederive is stated — a cache with no stated re-derivation is grade C wearing a label. Name the command or method that recomputes this verdict from inputs the subject does not control.`);
  }
  if (inst.grade === 'D' && !nonEmpty(inst.reobserve)) {
    throw new Error(`${name}.instrument.grade is "D" but no reobserve is stated — a live observation nobody can re-take is unfalsifiable, which is grade C by a slower route. Name the command that re-measures this value NOW.`);
  }

  // A stale field is a half-finished flip, and a half-finished flip reads as a finished one.
  // AC2.9's "no rederive left behind" is enforced HERE rather than only in a gate, so the
  // incomplete state is unwritable rather than merely discouraged.
  if (inst.grade === 'A' && (nonEmpty(inst.rederive) || nonEmpty(inst.reobserve))) {
    throw new Error(`${name}.instrument.grade is "A" but still carries ${nonEmpty(inst.rederive) ? 'rederive' : 'reobserve'} — an independent population needs neither. A leftover field from a previous grade makes an incomplete re-point look complete.`);
  }
  if (inst.grade === 'B' && nonEmpty(inst.reobserve)) {
    throw new Error(`${name}.instrument.grade is "B" but carries reobserve, which belongs to grade D — pick the grade that is true and drop the other's field.`);
  }
  if (inst.grade === 'D' && nonEmpty(inst.rederive)) {
    throw new Error(`${name}.instrument.grade is "D" but carries rederive, which belongs to grade B — if the verdict really is re-derivable the grade is B, and if it is not the field is a false claim.`);
  }

  if (!nonEmpty(inst.reason)) {
    throw new Error(`${name}.instrument.reason must be a non-empty string — a grade with no recorded rationale is indistinguishable from someone picking the grade that let the wave ship`);
  }
}

export default assertPromotionBound;
