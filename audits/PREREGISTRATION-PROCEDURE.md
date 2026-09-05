# Pre-registration procedure — studies on a conditioned corpus

**Owner:** `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1` R3 (2026-09-05) · **Gate:** `tests/unit/preregistration-support-stress-test.test.ts` (CI + pre-push test gate) · **Scope:** every `audits/*preregistration*.md`, and by extension every study whose corpus is conditioned on a selection event — `hold_decisions` / `hold_decision_labels`, `band_signals`, a decided-vs-timeout barrier, an emitted-vs-withheld arm.

This file is **methodology only**. It carries no figure. Figures derived under any registration live in the private vault; the code repo is public.

Until 2026-09-05 this procedure existed only as a paragraph inherited from one pre-registration to the next ("cardinalities may be probed; outcome statistics may not", `EDGE-SELL-FEATURE-ATTRIBUTION-W1` §0, architect ruling 2026-09-04). A procedure that lives in the artifacts it governs cannot gain a step without every author remembering to copy it; §4 below is the step that was missing, and the gate is what makes it binding rather than remembered.

---

## 1. Ordering — the landing timestamp is the proof

Commit and **land** the registration before the first outcome query against the corpus it registers. The landed commit's timestamp and the pull's `date -u` are recorded together in the result. A registration landed after the pull is a description, not a registration.

**Cardinalities may be probed before landing; outcome statistics may not.** Row counts, cluster counts, level occupancy, coverage ratios, schema facts and the corpus window are cardinalities. A win rate, a DWR, a correlation, a coefficient, a p-value, or a label sign is an outcome statistic. A ratio that partitions rows by an outcome-derived event (decided vs timeout) sits at the boundary: it may be probed when a design needs it, and it is then **disclosed** in §2, never concealed.

## 2. Prior-examination disclosure

Every figure the author has seen before the registration lands is named in a table with its **class** (`cardinality` · `coverage ratio` · `inherited` · `seen — not a test input`). Precedent: `audits/hold-decision-preregistration-2026-08-26.md` §12. A prior look does not invalidate a test; an undisclosed one would. A corrected reading of a seen corpus is recorded as **SEEN, DISCLOSED, NOT A TEST INPUT**, and the verdict rests on data nobody has seen (§7).

## 3. Corpus — a literal predicate, fixed by a clock

The corpus is defined by literal SQL (or an equivalent predicate) on named stores, with every filter stated. When the corpus **accrues**, the population is closed by an explicit bound — `T_END` fixed at the registration's write time — never by what a labeller or a pull happened to reach: a population defined by the instrument that fills it is the instrument-defines-the-population defect. Rows beyond the bound belong to a successor and are said to.

Coverage travels with two denominators: the registered population, and the subset the pipeline reached; drops are reported by name, never filled.

## 4. Support stress-test — MANDATORY, GATED

**Every registered check is evaluated at some point of the covariate space. Before landing, name that point and probe whether the corpus occupies it.** A check evaluated at a value the data never takes is **undefined, not failed** — and the fact is a cardinality, so it is knowable before any outcome is read.

The registration carries a section headed `## Support stress-test` holding one table with, for each registered check, four columns:

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| the named test, design or floor | the exact point(s) at which it is evaluated | the occupancy / cluster count / bound at that point, with the probe | `inside` · `outside → replaced by …` · `floor` |

What the table must catch, from the incidents that produced it:

- A **raw main effect in an interaction model** is the slope at the other interactors' **zero**. Ask whether zero is occupied. If not, evaluate at an occupied point: centre the covariates, or equivalently report the average marginal effect — in a linear-in-parameters model with pairwise products the centred main effect equals `β_i + Σ_j β_ij·x̄_j`, the AME, and every term of an AME is a row-wise slope at an occupied point.
- A **per-level test** needs the level carried by at least the registered cluster floor in the arm being tested; a level below the floor is reported by name, never dropped or pooled.
- A **band or stratum** needs its own cluster count stated; a **propensity** needs its fitted-probability bounds and a separation flag; a **timeframe or regime restriction** needs a presence rule (a floor), so that two populations compared "on the same timeframes" have identical timeframe sets.
- A **replication on an accruing corpus** needs the achieved independence-unit count (clusters) recorded **before** any outcome is read, against the floor registered in §5.

The gate enforces **presence and shape** of this section — one row per registered check, four cells each. It cannot enforce truth; the author can. Pre-registrations landed before this step existed are grandfathered in the gate by an exact, reasoned, non-empty allowlist and never by a glob.

## 5. Floors and power — before the pull, in the independence unit

State the cluster floor (never a row floor) and the power at the effect the study is powered for, with the instrument beside the number: the standard error's source, how it scales with the cluster count, and any calibration applied. An increment that cannot reach the floor returns `indeterminate — underpowered`, with the size and the date that would resolve it. That branch is registered, not improvised.

## 6. Decision rule — three states, with the sign expected under each

`attributable` / `not-attributable — cause named` / `indeterminate — cause named`, per hypothesis, then one line. A **null counts only when the interval can exclude the in-sample estimate at the registered floor**; below it the result is underpowered, not negative. Magnitude shrinkage between a discovery estimate and an out-of-sample estimate is expected and is reported explicitly; the out-of-sample figure is the usable one.

## 7. The post-result respecification test

Before applying a corrected check to a corpus that has already been read, ask: **would this respecification have been proposed had the check passed?** If not, it is a garden-of-forking-paths move however sound the statistics. The correction is then registered and applied to **data nobody has seen**, and the corrected in-sample value is disclosed under §2 as seen and not a test input.

## 8. Deviations, quarantine, publication

A deviation from the registration is recorded as a deviation with its reason, never absorbed. Third-consumer terms hold where the corpus is quarantined (`hold_decision_labels`: own hypotheses, never cited for or against the HOLD-discipline hypothesis, nothing to public copy). Figures are vault-only.

## 9. Inheritors — named

`EDGE-HOLD-DISCIPLINE-W{NEXT}` (the §3 test of `audits/hold-decision-preregistration-2026-08-26.md`, earliest answer ~2026-10-07) · `EDGE-SCORING-LADDER-REDESIGN-W2` and its W2A pre-registration · `EDGE-BUY-ARM-DRAIN-W{NEXT}` · `OPS-TRACK-RECORD-BAND-DECISION-W{NEXT}` (`band_signals`, gated on a resolved-row count) · every successor of `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1` · every future study on `hold_decision_labels`, `band_signals`, or any corpus conditioned on a selection event.
