# EDGE-ADS1-SCORECARD-W1 — endpoint truth (repo copy: figure-free, infra-free)

> This wave measures the live product against a DRAFT standard (ADS-1). It is NON-PROMOTABLE: no gate
> verdict any promotion path consumes, no serving change, no threshold, weight, emission policy or public
> figure. Every figure it produces lives in the private vault, never in this repository. This copy
> carries identifiers, code anchors, the decisions that bind the code, and the self-test mutation
> matrices — and no count, rate, cardinality or infrastructure detail.

## Seal

Every label-bearing read and write is bounded by **T_CAP**: `created_at ≤ T_DIAG_END` AND the race END
`created_at + (W+1)·tf ≤ T_DIAG_END` (`T_DIAG_END = 1790402400`, the B-DIR v3 sealed-holdout floor; ruling
Q1 = A). The race-end form is label-independent (it never selects on the label or on when the labeler
happened to run) and guarantees no post-seal price enters a row. On rows above T_CAP this wave reads
cardinalities and feature presence only. `src/scripts/ads1/spec.ts` `withinTCap`;
`backfill-directional-labels.ts` `tCapSql`.

## The branch point — decided B

`signals.outcome_return_pct` shares the labeler's entry (`price_at_signal`) and window rule, but is not the
labeler's expiry return row by row: the outcome path accepts a partial window
(`src/scripts/backfill-outcomes.ts`, one-candle floor) and fetches its candles independently of, and at a
different time from, the labeler; one retired venue's early cohort was evaluated on the wrong slice before
`e34f95e9`. Withheld decisions have no expiry source at all. Hence (ruling Q2 = A):

- `migrations/043_directional_labels_expiry.sql` — additive, nullable `directional_labels.ret_at_expiry_pct
  DOUBLE PRECISION` (PERCENT, price-perspective); rollback in the `.down.sql`. The labeler's applied DDL
  (`DIRECTIONAL_LABELS_DDL_PG`) carries the same column; `tests/unit/directional-labels-ddl-parity.test.ts`
  and `dist/scripts/ads1/ddl-parity-check.js` pin the two copies equal.
- The labeler writes it for every new row from the W-th forward candle it already holds
  (`directional-labeler.ts` `expiryReturnPct`), and only when that candle had closed before the fetch —
  never a live price.
- `backfill-directional-labels.js --expiry-only`: label-independent worklist (every NULL expiry under
  T_CAP), forward-only fetch, `UPDATE … WHERE ret_at_expiry_pct IS NULL` (never overwrites), rows past a
  measured candle depth skipped without a fetch (`EXPIRY_REACH_DAYS`), `--check` = zero writes,
  cardinality-only output. Rows the venue no longer serves stay NULL (UNRESOLVED), never estimated.

A consequence stated as a property of the label, not a defect: a timeout has `|close_W/entry − 1| <
barrier_pct`, so a floor-bound barrier (0.30 %) resolves only to FLAT.

## Pinned identifiers

| Identifier | Pin | Source |
|---|---|---|
| barrier specs | `tau1.0-floor0.30-v1` (primary) · `tau0.5-floor0.30-v1` · `tau2.0-floor0.30-v1` | `directional-labeler.ts` `BARRIER_SPECS`; primary == `FRESHNESS_BARRIER_SPEC` |
| `T_FLIP` | `1788169595` (TREND_MODE flip #2, final; the first rule-v2 row belongs to a rolled-back flip #1) | `ads1/spec.ts` |
| `T_DIAG_END` | `1790402400` | `ads1/spec.ts` |
| withheld-decision time column | `decided_at` (there is no `created_at`) | schema |
| cost tiers | PERCENT: taker = `ROUND_TRIP_COST_PCT`, maker 0.04 | `ads1/spec.ts` |
| power floors | `N_EFF_FLOOR` 3863, `auditMinNeff` 617 (ceilings of the one-sided α .05 / power .8 sizes) | `tests/unit/ads1-spec-lock.test.ts` derives them |
| cross-repo contract | `ops/ads1-spec.json` = `serializeAds1Spec()` | `scripts/emit-ads1-spec.mjs`, lock test |

## Definitions that bind the code

- Complete label (`ads1/core.ts` `completeLabel`): ±1 pass through; a timeout resolves by the expiry return
  in the called direction (≥ +0.30 % WIN, ≤ −0.30 % LOSS, else FLAT); NULL → UNRESOLVED; a timeout whose
  expiry lies outside its barrier → INCONSISTENT (counted, excluded, never coerced).
- Null: mix-matched on the same rows; an ambiguous same-candle race is a LOSS for both always-side callers
  (`dwr-baseline.ts` `deriveRaceOutcome`), never mirrored.
- Headline edge: per-UTC-day unweighted cluster mean with a day-cluster bootstrap lower bound
  (`dwr-cluster-edge.ts` `clusterEdgeCompleteWithCi`, floors 20 days × 30 rows, fixed seed); the pooled edge
  is printed beside it. `clusterEdge()` above it is byte-identical to origin/main (pinned by hash).
- nEff: Kish, `m* = Σm²/Σm`, ρ = ICC(1) floored at 0 in the design effect only (raw ρ reported).
- NOT_IDENTIFIABLE: minority-side share < 0.10 OR Fréchet attainable range < 1.0 pp, with a `reason`.
- Calibration: one binning over the emitted support [52, 100], shared by the reliability table and ECE;
  full-window L2 floored at the April recalibration.
- Coverage (L3): emitted arm only; the withheld store stays quarantined. The census's HOLD counter counts
  evaluations while the emitted record is idempotent per window, so a coverage ratio is reported as
  `n/a: COVERAGE_UNITS_INCOMMENSURATE`.

## Self-test mutation matrices (each mutation must turn its self-test red)

`node dist/scripts/ads1/selftest.js` (`ADS1_SELFTEST`, 42 known-answer checks):

| Mutation | Result |
|---|---|
| flip the FLAT-floor comparison | FAIL (L0 cases) |
| swap WIN / LOSS for decided labels | FAIL |
| drop ρ from nEff | FAIL |
| mirror an ambiguous race instead of `deriveRaceOutcome` | FAIL |
| pooled headline instead of per-day | FAIL |
| drop the INCONSISTENT guard | FAIL |
| percentile floor instead of nearest-rank ceiling | FAIL |
| drop the AUDIT hit-rate branch | FAIL |

`scripts/gates/ads1-ch1-gate.sh --self-test` (11 checks) and `scripts/gates/ads1-ch2-gate.sh --self-test`
(13 checks, drives the real decision function; the script is sourceable): every mutation of a verdict
branch, an exit-code mapping, or the missing-tool precondition turns the self-test red.

## Gates

- CH1 `scripts/gates/ads1-ch1-gate.sh <addendum>` — ten `PROBE_<n>` lines → `CH1_GREEN` / `CH1_RED` / `CH1_INDETERMINATE`.
- CH2 `scripts/gates/ads1-ch2-gate.sh` — build, the full suite through `scripts/classify-suite-verdict.mjs`
  (the verdict deploy gates on; the raw vitest exit code is not the gate), the python3 differential
  against `src/scripts/cluster-perm-stats.py` (mandatory — python3 absent is RED), `ADS1_SELFTEST`,
  `DDL_PARITY` → `CH2_GREEN` / `CH2_RED` / `CH2_INDETERMINATE`.
- Every gate is a committed bash script: the agent tool shell is zsh, where `${PIPESTATUS[0]}` is empty and
  `[ "" -eq 0 ]` is true, so a gate pasted there fails open.
