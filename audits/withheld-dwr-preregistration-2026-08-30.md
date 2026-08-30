# Withheld-SELL counterfactual DWR curve — PRE-REGISTRATION

**Wave:** `EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1` · **Recorded:** 2026-08-30 (before any curve query)
**Authority:** the Observed-Path Exception (Mr.1, 2026-08-29) + the Q1–Q5 ratification of 2026-08-30.
**Binding on:** this wave's R3/R4. Committed BEFORE the band-targeted labeling completes and BEFORE
any curve aggregation is run, so the analysis cannot be chosen after seeing the data. A deviation is
recorded here as a deviation, with its reason — never silently absorbed.

This file is methodology only. **Every resulting figure is internal research under the exception's
hard boundary and lives in the private vault** — no counterfactual number appears in this repo, in
public copy, on a track-record surface, in an MCP response, or in any customer-facing artifact.

## 1. Question

Does counterfactual DWR **rise with the raw score** across the withheld would-be-SELL bands, or is
it flat? Rising ⇒ the SELL threshold does real work and the scoring-ladder redesign must be
conservative. Flat ⇒ the threshold destroys sound calls and the redesign is urgent. This measures
whether *sub-threshold* reads were directionally right; it is **not** an accuracy claim about the
product, and it may never be cited for or against the HOLD-discipline hypothesis (see
`hold-decision-preregistration-2026-08-26.md` §12).

## 2. Population and bands — defined in RAW-SCORE space

Population: `hold_decisions` rows with `would_be_side = -1`, `suppression_reason = 'below_threshold'`,
re-pinned at run time with a frozen `decided_at` upper bound stated in the output. Confidence is
`round(|raw| / 89 × 100)`, which collapses many raw values onto one confidence value, so bands are
raw-space intervals; confidence appears only as display projection.

| Band | Definition | Note |
|---|---|---|
| **−55 atom** | withheld ∧ confidence = 62 (⇔ raw ∈ [−55, −54.735] given rounding; mass sits at integer −55) | the exact population a one-point threshold move admits — reported alone, never merged |
| **52–61** | withheld ∧ confidence ∈ [52, 61] | fleet-sampled ONLY (request arm holds zero rows here) |
| **45–51** | withheld ∧ confidence ∈ [45, 51] | |
| **below-45 (context)** | withheld ∧ confidence < 45 | organic nightly coverage only; reported, never gates |
| **emitted** | `directional_labels ⨝ signals` where `signal='SELL'` (conf ≥ 62 by construction) | the real corpus, same labeler |

Cuts: regime × timeframe, plus the pooled band. Arms reported separately where populated.

## 3. Metric — the SHIPPED instrument, verbatim

Per band/cell, `computeCellStats` from `src/scripts/dwr-baseline.ts` executed from the deployed
build — never a re-implementation:

- corpus filter: `barrier_spec = 'tau1.0-floor0.30-v1'` (primary; tau0.5/tau2.0 reported secondary)
  ∧ `low_vol_history = FALSE`;
- **DWR = wins / (wins + losses)** — timeouts excluded, ambiguous-flagged ±1 labels count, exactly
  as `dwrFromLabels` does for the real baseline;
- Wilson interval on (wins, nDecided);
- (venue, coin) cluster count stated beside every interval — n is coverage, never a power claim.

## 4. Baselines — same rows, stated before measurement

From `benchmarks()` on the identical row set per band: `alwaysSellDwr`, `alwaysBuyDwr`
(denominator uppers+lowers+ambiguous, the shipped convention), plus
`random = 0.5 × (alwaysBuyDwr + alwaysSellDwr)` (coin-flip side per race; algebraically ≤ the max
of the two, so reported but never binding). **edge = DWR − max(alwaysSell, alwaysBuy, random).**
An edge ≤ 0 in a band means that band's number is a liability, and the output must say so in those
words.

## 5. Decision rule — declared now

- **SUPPORTS LOWERING** ⇔ in the −55 atom band (or any withheld band above the admit line under
  consideration), tau1.0 pooled **Wilson CI-lower > max(naive)** on the same rows, with ≥ 50
  (venue, coin) clusters in that band. The admissible new bar is the lowest band boundary at which
  every band above it clears that test.
- **DOES NOT SUPPORT** ⇔ edge ≤ 0 (point estimate) in every withheld band, or the powered floor is
  unmet everywhere — then the answer is "not yet", with the accrual date, never a substituted test.
- **Curve shape** (rising vs flat) is described from band point estimates with their CIs; no
  additional test is invented after seeing the data.

## 6. Coverage — two denominators, drops reported never filled

Denominator A (raw): all captured target-band rows at the frozen bound. Denominator B (labelable):
A minus structural drops — `would_be_side = 0`, `timeframe = '1m'` (retired lane),
`exchange IS NULL`, and rows whose evaluation window has not closed. Both published per band, with
the drop counts named.

## 7. Selection effects — stated with every rendering of the curve

1. Withheld rows are precisely the sub-threshold ones — not a random sample.
2. The fleet arm is cell-sampled at capture (`uq_hold_decisions_fleet_cell`, first-write-wins per
   UTC-day cell); the request arm is 100% but ~28 assets and zero 52–61 rows.
3. Bands compare across two stores (withheld vs emitted) sharing ONE labeler code path and ONE
   entry-price instrument (live adapter price at decision) — the property that makes the
   comparison legal.
