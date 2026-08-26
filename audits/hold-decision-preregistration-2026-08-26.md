# HOLD-discipline analysis — PRE-REGISTRATION

**Wave:** `OPS-HOLD-DECISION-CAPTURE-W1` R3 · **Recorded:** 2026-08-26 · **Binding on:** `EDGE-HOLD-DISCIPLINE-W{NEXT}`
**Status:** pre-registered BEFORE any data exists. Capture began with this wave; no HOLD has been labeled yet.

This document is written now, and its numbers are fixed now, for one reason: the analysis it describes
cannot be chosen after seeing the data. Everything below — the comparison, the PASS condition, the
stratification, the falsifier — is binding. A future wave may report that the pre-registered test could
not be run; it may not substitute a different test and report that one instead.

---

## 1. The claim under test

*"The engine stays silent unless the signal is clear."*

~99% of evaluations return HOLD. The claim is live in public positioning and has **never been measured**,
because until this wave the two facts that make a HOLD testable were destroyed at the source:

| Fact | Where it died |
|---|---|
| the side the engine would have taken | `src/tools/get-trade-call.ts:273` — `Math.abs(rawScore)` before confidence is derived |
| the venue (so a candle series can be chosen) | `request_log` had no `exchange`; `hold_counts` is keyed only on (date, timeframe, coin) |
| the entry price | HOLDs never reach `recordSignal` (`get-trade-call.ts:1326`), so `signals.price_at_signal` never exists for one |

## 2. Question

**Do HOLD decisions systematically decline *worse* opportunities than the engine acts on?**

## 3. PRIMARY test

**HOLD-counterfactual DWR vs the same-window directionless benchmark, PER CONFIDENCE-BIN STRATUM.**

- Wilson CI on the DWR proportion (the only interval `src/scripts/edge-stats.ts` derives).
- Cluster-bootstrapped on `(venue, coin)`, **with cluster counts stated in the output**. `n` is a coverage
  target and never a power claim — the `EDGE-CARRY-SERVING-W2` lesson.
- BH-FDR across the stratum family.
- **PASS ⇔ in ≥1 powered stratum, the counterfactual DWR's CI-UPPER sits BELOW the benchmark.**
  That is: acting on those declined signals would have been worse than chance, so declining was right.
- Powered floor: **n ≥ 50 independent clusters** in the stratum.

### 3a. Mandatory stratification — this is not a robustness check, it is the test

Measured 2026-08-26 over 30 days of caller-facing HOLDs: **92% carry confidence below 50**, and the
distribution runs 0–62 with a hard maximum of 62.

| confidence bin | share of HOLDs |
|---|---|
| 0–39 | ~87% |
| 40–49 | ~8% |
| 50–62 | ~4% |

Below ~50, `sign(rawScore)` is near-arbitrary — a score of ±3 is noise with a sign attached — so its
counterfactual DWR is ~benchmark **by construction**, not as a finding. Pooling those with borderline
HOLDs would drown any real signal in rows that cannot carry one, and would produce a null that looks
like evidence of no edge when it is only evidence of averaging.

**The headline is the TOP confidence stratum. Pooled is reported and NEVER gates.**

## 4. SECONDARY test (report-only, may gate nothing)

Regression discontinuity on the `[50, 62]` band: just-below-threshold HOLDs vs just-above-threshold acted
calls. **Underpowered by design** — ~28 caller-facing rows/day land in that band. Reported for continuity
with the retracted comparison in §6, not relied on.

## 5. Falsifier — stated now, in advance

**No separation ⇒ HOLD discipline adds no measurable information, and the claim must be RETIRED from
public copy, not softened.**

"Retired" means removed. A rewrite to *"the engine is selective"* or *"HOLD when signals conflict"* is the
same claim with hedging, and would be a violation of this pre-registration rather than a response to it.

## 6. RETRACTED before any data existed: "HOLD-counterfactual DWR vs ACTED DWR in the same cells"

The spec's original primary. Retracted during Plan-Mode on measured evidence, not on preference:

- HOLD confidence maxes at **62**; acted `signals` begin at **52** (`MIN_TRACKABLE_CONFIDENCE`,
  `get-trade-call.ts:188`), because `recordSignal` only fires at or above it.
- The two populations therefore overlap only in `[50, 62]` — **~28 caller-facing rows/day**.
- Confidence is a monotone transform of `|rawScore|`, which IS the decision variable. So "the same cell"
  is a cell the threshold itself carved the two arms out of: the comparison is near-empty **by
  construction**, and no amount of elapsed time fills it.

Recorded here so a future wave does not rediscover it as a finding, or quietly restore it as a primary.

## 7. Cell keys

| key | in the joint cell key? | why |
|---|---|---|
| confidence bin | **YES** — it is the stratification axis | §3a: without it the test is meaningless |
| timeframe | yes | |
| regime | yes | `TRENDING_UP` / `RANGING` / `TRENDING_DOWN` |
| venue | yes (also the cluster unit with coin) | |
| **license tier** | **NO** | `signals` has no `license_tier` column, so tier cannot cut the acted arm at all. Reported as a descriptive split of the HOLD arm ONLY, never across arms. |

## 8. Populations, and their measured limits

Both arms are captured; the fleet arm exists because of the cluster ceiling below.

| arm | rate | sampling | distinct assets (30d) |
|---|---|---|---|
| request (`is_bot_internal` true + false) | ~3.19k/day | none — 100% | 28 external + 11 bot |
| fleet (seed / batch) | ~437k/day | 1 row per (UTC day × venue × coin × timeframe × conf-decile × regime), enforced by `uq_hold_decisions_fleet_cell` | ~2,000 coins × 17 venues |

**The cluster ceiling is why the fleet arm was added.** Measured: request-arm HOLDs cover **28 distinct
assets** over 30 days (internal bot: 11), on a near-constant venue, because callers rarely pass
`exchange`. That is a **diversity ceiling, not a time ceiling** — more weeks add rows, not clusters, and
n ≥ 50 independent `(venue, coin)` clusters is unreachable from caller traffic at any horizon. The acted
corpus has **7,978** such clusters, all of them fleet-generated. A caller-only HOLD arm would also have
been comparing a caller population against a fleet population.

## 9. Earliest possible answer

**Capture start (2026-08-26) + the longest evaluation window + n ≥ 50 clusters in a powered stratum.**

Projected: **2026-10-07 at the earliest** (~6 weeks). Published in `status.md` as a date so it is a clock
and not a hope. If clusters accrue faster than projected the analysis still does not run early — see §11.

## 10. Reference numbers, frozen as of 2026-08-26

So a future wave compares against what was actually true here, not a remembered version of it.

| quantity | value | source |
|---|---|---|
| acted aggregate DWR (`tau1.0-floor0.30-v1`) | 0.4820 | `dwr_baseline_runs` 2026-08, re-verified live |
| acted benchmark | 0.5021 | same |
| **acted edge** | **−0.0201** | same |
| acted verdict | `NO-VALIDATED-EDGE` | same |
| acted clusters | 7,978 | `directional_labels ⋈ signals` |
| HOLD rows, `get_trade_call`, all time | 290,440 | `request_log`, earliest 2026-04-28 |
| fleet HOLD rate | ~437k/day | `hold_counts` daily sum, 426,922–446,807 over 10d |

**Why a PASS would matter even though acted edge is ~benchmark.** Separation would be the first positive
evidence in this program that the engine's *selection* carries information: it would mean the calls it
declines are genuinely worse than the ones it takes, even though the ones it takes are not better than
chance. That is a claim about the filter, not about the signal, and nothing measured so far speaks to it.

## 11. Binding conditions on `EDGE-HOLD-DISCIPLINE-W{NEXT}`

1. **Do not run early on thin data.** Running before the powered floor is met and reporting whatever came
   out is the failure this whole design exists to prevent.
2. **No metric shopping.** If the pre-registered test cannot be run, report *that*. Do not substitute.
3. **Report cluster counts with every interval.** An interval without its cluster count is not a result.
4. **Benchmark before publishing any rate.** Compute the edge against always-long / always-short / random
   on the same rows. Edge ≤ 0 makes the number a liability.
5. **The falsifier is not optional.** If §5 fires, the public-copy retirement is the deliverable.
6. Any deviation from this document is recorded as a deviation, in this file, with its reason — not
   silently absorbed into the next wave's method section.
