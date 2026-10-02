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
  never a live price. The candle is identified BY TIME, never by array position: the first forward candle
  must open within one period of the entry and the W-th exactly (W−1) periods after it; a window with a
  missing candle is `null`. (Found by the pre-pull review, 2026-09-28: the group cache's extension start
  `coveredUntil + tf` is off the candle grid, so one candle per extension step is never fetched — by index
  the column would have taken a later candle's close.)
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

`node dist/scripts/ads1/selftest.js` (`ADS1_SELFTEST`, 43 known-answer checks):

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
| minority share as `1 − shareBuy` (float) instead of integer counts | FAIL (exact 10 % minority, both sides) |

`scripts/gates/ads1-ch1-gate.sh --self-test` (11 checks) and `scripts/gates/ads1-ch2-gate.sh --self-test`
(13 checks, drives the real decision function; the script is sourceable): every mutation of a verdict
branch, an exit-code mapping, or the missing-tool precondition turns the self-test red.

## Gates

- CH1 `scripts/gates/ads1-ch1-gate.sh <addendum>` — ten `PROBE_<n>` lines → `CH1_GREEN` / `CH1_RED` / `CH1_INDETERMINATE`.
- CH2 `scripts/gates/ads1-ch2-gate.sh` — build (`tsc`, then the knowledge bundle — `deploy.yml`'s order), the full suite through `scripts/classify-suite-verdict.mjs`
  (the verdict deploy gates on; the raw vitest exit code is not the gate), the python3 differential
  against `src/scripts/cluster-perm-stats.py` (mandatory — python3 absent is RED), `ADS1_SELFTEST`,
  `DDL_PARITY` → `CH2_GREEN` / `CH2_RED` / `CH2_INDETERMINATE`.
- Every gate is a committed bash script: the agent tool shell is zsh, where `${PIPESTATUS[0]}` is empty and
  `[ "" -eq 0 ]` is true, so a gate pasted there fails open.

## V3 CH3-A — the pre-read `-v2` amendment (EDGE-ADS1-SCORECARD-W1-V3, Dispatch A, 2026-10-02)

Step-0 probes P1–P12 (thin Plan Mode). Figure-free and infra-free here; the vault copy carries the host-side rows.

| Probe | Claim | Reality | Resolution |
|---|---|---|---|
| P1 amendment admission | `tests/unit/ads1-scorecard.test.ts:222-234` admits exactly one amendment section | the pin test asserted ONE registration file and `md.includes(sql)` anywhere — no heading semantics; a generator reverted to the `-v1` text would still pass (that text stays in §3.1) | anticipated branch: the pin is now SECTION-scoped (amended statements must sit inside §10), with an allow-list of exactly the two new headings and exactly one `## <n>. Amendment` |
| P2 §4c gate | the registration is a grandfathered row; a self-test mutation drops a grandfather row | the row was present; the "row dropped" mutation was a manual mutation of `OPS-PREREG-IDENTIFIABILITY-GATE-W1`, not in the file | row removed; nothing to adjust |
| P3 literal census | minority constant `MIN_MINORITY_SHARE` | `MINORITY_SIDE_FLOOR` (0.1); no family literal in `src/scripts/ads1/**` (they imported `BARRIER_SPECS`) | the real name is cited; a test now forbids any family literal in the ADS-1 source |
| P4 constants module | `BARRIER_SPECS_V2` exported, import pure | exported; `require()` of the dist module prints `pure`, exit 0, no DB env | imported by identity (`ADS1_BARRIER_SPECS === BARRIER_SPECS_V2`, test) |
| P5 served table | the derived coarser pairs equal the LRW §3.1 nine rows | equal over every venue × the 10 label-window timeframes and × the 11 `pfe-mae` timeframes | `COARSER_SERVED` derived from `servedCandleStepMs`; set-equality test parses the LRW registration |
| P6 columns | `race_gap_candles` smallint nullable, `computed_at` present | both present (`computed_at` timestamptz NOT NULL) | `computed_at` is selected raw and parsed under `SET TIME ZONE 'UTC'` + strict pattern |
| P7 LRW primitives | DONE probes, `T_CUT`, adapter-pending cells, manifest, launch epoch | `completeness.ts` (`--emit MISSING_V2/NULL_V1_GAP`, `--relabel`, `--annotation`); `T_CUT_EPOCH` 1790754894.743475; `ADAPTER_PENDING_CELLS` = BITGET 2h/8h; manifest = `LRW_MANIFEST <id> <class>` runner-log lines; no launch-epoch token in code | all imported; the launch epoch is an explicit pull argument (`--relabel-launch`), checked ≥ `T_CUT` and < now |
| P8 AOE | columns read by header name; seal guard | the parser demanded the exact header tuple; the seal guard used the requested form | parser by name (superset), seal guard in the max form from the vendored `coarser_served` |
| P9 clocks | `T_CUT` 1790754894 · `T_ADAPTER` 1790864836 · `T_FLIP` 1788169595 · `T_DIAG_END` 1790402400 | every ISO ↔ epoch pair agrees; `T_CUT` is pinned fractional (.743475); `T_ADAPTER` was pinned in no source file | `T_CUT` imported; `T_ADAPTER` pinned once in `ads1/spec.ts` |
| P10 landing state | nothing in flight, no writer, relabel not started | confirmed | landing permitted |
| P11 fixtures | an extract-fixture header and smoke session files gain the two columns | the fixture is object-level and the round-trip test builds its header from `EXTRACT_HEADER`; no smoke session files exist | fixtures gain `computedAt` / `raceGapCandles`; round-trip gains both values |
| P12 mirror | `PREREG_MIRROR_VERDICT=PASS` before and after | PASS before | re-synced after landing |

**NEW drift: 1 (≤ 2 → fixed inline, flagged).** N1 — the dispatched presence statement (grouped by exchange, timeframe, window) cannot carry what §10.4 registers: the chain per UNIT (tier needs the coin), the `no_v1_twin` class (`-v2` ∧ ¬`-v1`) and the placement of LRW's manifest (keyed by signal id only). Emitted per signal instead — same predicate, same literals, same three presences; every grouped count is a projection in code (`buildCoverage`). Recorded in §10.3 of the registration.

**Hazard found, not drift.** `withinTCap` in `ads1/spec.ts` is imported by the nightly labeller's seal edge (`sealEdgeRow`, `backfill-directional-labels.ts`). It stays byte-identical; the max form is a new export `withinTCapMax`.

**Completions (no ruling needed).** The integrity statement is quoted in §10.3 (the pin requires every statement verbatim). The generated coarser `VALUES` list carries the derivation's row order (SERVED_VENUES order × the label window), not the dispatch draft's hand order — same nine rows, set-asserted. The chain adds `pre_cut` and `not_visited:{v1,no_v1}` so every registered row lands in exactly one class (a partition, tested). The CH3-B pull runner (`scripts/ads1/ads1-pull.sh`) and both B-side gates land here, so Dispatch B changes no code.

### Identifier diff (identifiers cited in more than one place)

| Identifier | Dispatch | LRW registration / code | ADS-1 code (V3) | Agree |
|---|---|---|---|---|
| `-v2` family | `tau{1.0,0.5,2.0}-floor0.30-v2` | `BARRIER_SPECS_V2` | imported (`ADS1_BARRIER_SPECS`) | yes |
| T_CAP predicate | `GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec))` | LRW §3.1 | `tCapPredicate()` / `withinTCapMax` | yes |
| coarser-served table | 9 rows | LRW §3.1 literal | `COARSER_SERVED` (derived) | yes (set; row order differs) |
| `T_CUT` | 1790754894 | `T_CUT_EPOCH` 1790754894.743475 | imported | yes (the dispatch shows the floor) |
| `T_ADAPTER` | 1790864836 | status.md only | `T_ADAPTER` (pinned here) | yes |
| registration commit | `6d43486c` | `lrw-pull.sh` reads the file path | gates + pull | yes |

### Gates (V3)

- CH3-A `scripts/gates/ads1-amend-gate.sh [--post-landing <sha>]` — build · suite verdict · shape (the `## ` heading list = the landed list + exactly the two admitted headings) · pure-insertion diff vs `6d43486c` (tail carries no other heading; the two pointers inside §3) · no `-v1` literal · no grandfather row · §4c (vitest) · pin (vitest) · mirror · (post) ancestor + INTRODUCES the amendment + `AMENDMENT_SHA` in status → `CH3A_GREEN` / `CH3A_RED` / `CH3A_INDETERMINATE`. `--self-test` runs the REAL legs on a mutated, git-indexed copy of the tree and `leg_post` on a synthetic repo: 27 checks (the 8 registered mutations + m9 restated section, m10 pointer moved into §7, m11 landed heading renamed, the registration commit offered as the amendment; 8 controls; 3 indeterminate), every leg shown able to fail by breaking it.
- CH3-B `scripts/ads1/ads1-pull.sh` (R11 → `ADS1_PULL_WAIT: <condition>` exit 3, else R12 → `ADS1_PULL_VERDICT=`) and `scripts/gates/ads1-ch3-gate.sh` (amended: amendment landed + INTRODUCES the amendment + before the pull, LRW DONE tokens, counters equal, `gap_t10 = 0`, no WAIT in the audit; self-test on a synthetic git history built so every case trips exactly the check it names: 28 checks).

### Pre-landing adversarial review (4 lenses — registration, scorecard code, gates + pull, firewall — each finding challenged by 2 skeptics)

Accepted and fixed before landing (the call is Code's, on the evidence — a skeptic's refutation does not overrule a reproduced defect):
- **HIGH** — the registration commit `6d43486c` itself passed as "the amendment" (it touches the file) in the pull, the CH3 gate and the post-landing leg. All three now require the commit to INTRODUCE the `## <n>. Amendment` heading (one at the commit, none at its parent). The same "touches the ADS-1 registration" test exists in `scripts/lrw/lrw-pull.sh` (LRW's file, not edited here).
- A rate figure from the dispatch's verbatim Reason sentence would have entered this figure-free public file; replaced by a figure-free form (the dispatch's header clause outranks its own verbatim text).
- Three sentences added at Step 0 overstated what the session reads (`-v1` presence "read once"; "every statement from `--print-session`"; "no provenance column"); reworded to name LRW's DONE probes and the one `computed_at` predicate.
- `chainClass` threw on a `-v2` row written between the extract and the label-free part (no audit, gate INDETERMINATE); it is now the counted class `unstamped` and the self-check fails on it.
- `ADAPTER_SPLIT_CELLS` aliased LRW's `ADAPTER_PENDING_CELLS`, which shrinks when the relabel reaches BITGET; now the registration's own fixed pair, pinned, never aliased.
- "INCONSISTENT reported" could not fail; it now asserts the by-construction tally equals the scorer's own count on the `fleet:all` FULL unit.
- Gate self-tests had masked legs (registration timestamp, file-in-commit, grandfather, §3 range, status line); every one is now isolated and was shown to fail when its check is deleted. The heading allow-list now also catches a re-stated §1–§9 section appended after `## Identifiability`. The pull no longer rounds a fractional launch epoch and prints a token on every exit; an empty audit field no longer shifts the CH3 gate's fields.
