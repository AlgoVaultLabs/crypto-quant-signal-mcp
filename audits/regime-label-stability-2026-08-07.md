# Regime label stability — measurement report

**Wave:** `SIGNAL-REGIME-LABEL-STABILITY-W1` (retitled from `SIGNAL-REGIME-LATENCY-MEASURE-W1`)
**Date:** 2026-08-07 · **Classification:** INTERNAL
**Tree:** `b5ccf3f` · **Classifier unchanged since:** `dc42b38`
**Data:** [`regime-label-stability-2026-08-07.json`](regime-label-stability-2026-08-07.json)

> This file is INTERNAL. It carries no `outcome_return_pct`, no component scores and no
> Phase-E WR. It is deliberately **not** named `*-shape-snapshot-*` — that glob is projected
> into the PUBLIC knowledge bundle by `scripts/build-knowledge-json.mjs`.

---

## Verdict

**The regime label's problem is not latency. It is churn.**

The classifier's lag is exactly what its own arithmetic predicts (≈11.6 bars) and is not a
defect. What the measurement found instead is that **the public label changes every ~7 bars and
reverts within 10 bars 53% of the time**, at an identical rate on 15m, 1h and 4h — and that
**about half of those changes are driven by RSI crossing 70/30, not by any trend change at
all.**

The lag is *unmeasurable in production* for a reason that is itself the finding: the label
flips faster than the filter can resolve a transition.

---

## Method, and why the dispatched one was replaced

The wave was dispatched to compare a LIVE classification at bar *i* with a HINDSIGHT one
computed with *K* further bars available. That measures **identically zero**. `ema()` is a
forward recursion (`indicators.ts:10`) and `rsi()` is Wilder's forward smoothing (`:45`), so the
classification at bar *i* is a pure causal function of bars `0…i` and **no future bar can change
it**. The golden check meant to validate such a harness — *"on a window with no transition, LIVE
and HINDSIGHT agree at every index"* — is vacuously true on every series. **A golden check that
cannot fail is not a golden check.**

Measuring a causal filter's lag requires an **acausal reference**. The construction used:

| | |
|---|---|
| forward | production classifier over `candles[i−99…i]` — lags a transition by **+τ** |
| backward | the **same** production classifier over the time-reversed window `candles[i…i+99]`, label mirrored — in real time, **leads by τ** |
| estimate | **τ = (t_forward − t_backward) / 2** |

`computeIndicatorScores` is called verbatim in both directions. Nothing is extracted and nothing
is restated, so the EMA pair, the RSI gate and the 3-way collapse to `RANGING` all ride along.

### ⚠️ Declared caveat — the reference is NOT ground truth

Forward-backward filtering is **not** "the same classifier without lag". It squares the
magnitude response, so the reference is zero-phase **and sharper** than production. It is valid
for isolating **lag** — phase is exactly what the construction removes — but its regime *labels*
are not those of a hypothetical lag-free production classifier, and must never be read as the
correct labels.

### ⚠️ Second declared asymmetry

Time reversal maps an uptrend to a downtrend. That mirror is **exact** for the EMA crossover and
**inexact** through the RSI gate: a forward overbought region (`rsi ≥ 70` ⇒ `RANGING`) appears in
reversed time as oversold, where a different gate fires. Lag is therefore reported **only** for
EMA-driven transitions. RSI-driven flips are counted in churn with lag `null`, never averaged in.

---

## The anchor, and a correction to this wave's own pre-registration

The primary anchor is a closed form computable from the **periods alone**; the empirical run is
its confirmation, not the other way round.

**The wave pre-registered `[τ₉, τ₂₁] = [4, 10]` bars. That was wrong.** Those bracket where each
EMA *sits* on a ramp, not where the two *cross*. Before a reversal `ema₉ − ema₂₁ = m(τ₂₁ − τ₉) >
0`; afterwards that difference must not merely shrink but **change sign**, so the crossover lags
by **more** than either individual τ. Solving the EMA ramp response,

```
d(t)/m = (τ_fast − τ_slow) − 2[τ_fast(1−k_fast)^t − τ_slow(1−k_slow)^t] ≤ 0
```

gives **11.64 bars** for 9/21.

| | bars |
|---|---|
| closed form (parameters only) | **11.64** |
| harness, two-sided, deterministic reversal fixture | **11.5** |
| forward detection alone (= `ceil`) | **12** |

**Proven able to fail:** perturbing production `ema(closes, 9)` → `ema(closes, 5)` moved the
measurement to **9.5** while the prediction held at 11.64, and the gate reported `FAIL`. 9.5 is
exactly `crossoverLagAfterReversal(5, 21)`, so the harness tracks the parameter rather than a
constant that happens to match.

---

## R2 — the matrix

8 assets × 3 venues (HL / BINANCE / BYBIT) × {15m·30d, 1h·60d, 4h·90d} = **72 cells**,
**440 requests**, 148 s, under `runAsBatch`.

> **Budget note.** The plan estimated 264 requests assuming 500 rows/page. Measured page depth is
> venue-specific (HL 1501, BINANCE/BYBIT ≈200, OKX 100), so the real figure is recorded rather
> than the estimate. Pacing was never shrunk.

### Churn — invariant across cadence

| TF | flips / 100 bars | dwell p50 | round-trip rate |
|---|---|---|---|
| 15m | 9.45 | 7 bars | 0.529 |
| 1h | 9.45 | 7 bars | 0.533 |
| 4h | 9.46 | 7 bars | 0.525 |

Three timeframes spanning a 16× range in bar duration produce the **same** churn to two decimal
places. Label stability is a property of the **filter**, not of the market or the cadence.

### Flip cause — roughly half the label changes are not trend changes

| cause | count | share |
|---|---|---|
| EMA crossover | 5,427 | 50.5% |
| **RSI band (70/30)** | **5,252** | **48.8%** |
| both | 73 | 0.7% |
| unknown | 0 | 0% |

Demonstrated deterministically in the gate: **a perfect monotone uptrend is labelled `RANGING`
for all 257 scorable bars** — `emaCross = BULLISH`, `rsiVal = 100`, so the `rsiVal < 70` gate
fails and the strongest possible trend is publicly called "ranging".

### Label share (1h, all venues)

`TRENDING_UP` 46.5% · `TRENDING_DOWN` 45.3% · `RANGING` 8.2%

The label claims a trend **92% of the time** and alternates between the two directions every ~7
bars.

### Latency — NOT IDENTIFIABLE, and that is the result

| | |
|---|---|
| naive pairing, median cell p50 | **−8 bars** ← negative, i.e. nonsense |
| structural lag (closed form) | 11.64 bars |
| measured median dwell | 7 bars |
| **dwell / lag** | **0.601** |

The lag **exceeds** the dwell: the next flip arrives before the previous one has been detected,
so "nearest transition into the same label" matches unrelated events. A negative median is the
symptom that reveals it.

**Identifiability probe.** Restricting to transitions with nothing else within 24 bars:

| | |
|---|---|
| isolated pairing, median cell p50 | **+10.5 bars** (vs closed form 11.64) |
| isolated pairs available | **7**, across 6 of 72 cells |

**Applying this wave's own declared threshold to its own favourable result: 7 ≪ 30, so this is
`INDETERMINATE`.** It **corroborates** the closed form; it does not measure it. In 30–90 days
across 8 assets, 3 venues and 3 timeframes, only **seven** regime transitions were separable
enough to time.

> **Declared threshold:** a cell with `n_transitions_observed < 30` reports `INDETERMINATE` and
> never a latency figure. A p90 over 3 transitions is not a measurement. This is a decision, not
> a filter for a later wave to "fix". 24 of 72 cells (every 4h cell) reported `INDETERMINATE`.

---

## R4 — the frontier is monotone; the current setting is ON it

HL 1h, mean across 8 assets. Lag is the closed form; churn is measured.

| fast/slow | lag (bars) | flips/100 bars | mean dwell | dwell/lag | |
|---|---|---|---|---|---|
| 5/13 | 6.71 | 13.05 | 7.66 | 1.14 | |
| 7/17 | 9.18 | 11.07 | 9.03 | 0.98 | |
| **9/21** | **11.64** | **9.44** | **10.59** | **0.91** | **← shipped** |
| 12/26 | 14.96 | 8.49 | 11.78 | 0.79 | |
| 16/34 | 19.88 | 7.67 | 13.04 | 0.66 | |

**There is no interior point.** Both columns move monotonically, so `(9, 21)` sits **on** the
frontier — no free improvement exists on the window-length axis. Shortening the window buys lag
at the cost of churn and vice versa.

And the ratio **degrades monotonically as the window lengthens**: the only swept setting where
the classifier's own transitions are resolvable at all is the fastest one. **Lengthening the
window to reduce churn makes the label less self-consistent, not more.**

### UNEXPLORED axis — nobody has priced it

There is **no confirmation margin, no hysteresis and no minimum dwell** anywhere in the
classifier (see H2 below), so the churn side of the tradeoff is entirely **unmanaged**. A
confirmation margin is the one lever that attacks *reversion* directly rather than by smoothing
harder, and the 0.53 round-trip rate is exactly what it would target. It is a named candidate
for `SIGNAL-REGIME-HYSTERESIS-TUNE-W{NEXT}` and **may be strictly better than shortening the
window**. This wave prices no part of it — it only records that the axis exists and is untouched.

**No threshold was changed by this wave.**

---

## R3 — hypothesis verdicts

| H | verdict | evidence |
|---|---|---|
| **H1** — window length drives the lag | **SUPPORTED** | Closed form is a pure function of the periods and the harness reproduces it to 0.14 bars; the R4 sweep moves lag monotonically with window length |
| **H2** — the lag is bought hysteresis | 🛑 **REJECTED AT SOURCE** | No hysteresis, no confirmation margin, no minimum dwell exists. `emaCross` reduces to `sign(ema9 − ema21)`: the two "fresh cross" branches (`get-trade-call.ts:312-313`) return the same value as the two "sustained" branches that follow, so `prev9`/`prev21` are read but cannot change the result. **Nothing was bought.** |
| **H3** — partial-bar contamination | **SUPPORTED, but RETROSPECTIVE — already fixed** | See below |
| **H4** — venue/asset specific | **REJECTED** | Churn is 9.45 / 9.45 / 9.46 across three timeframes and flat across 3 venues × 8 assets. Nothing venue- or asset-specific survives |
| **H5** — measurement artifact (the null) | **SUPPORTED for the seed observation** | The seed was taken on the live basis ~24 h before production flipped to closed; a 33-minute gap on a 1h timeframe straddling a bar close is what a closed-bar classifier does. The lag it appeared to show is the filter's own arithmetic, not a defect |

More than one is supported; this is the decomposition, not a single winner.

### H3 in detail — confirmed and already fixed

Production flipped to `CANDLE_BASIS=closed` at **2026-08-07T10:16:12Z** (read from the
container's `/proc/1/environ`, not `.env`). H3 is therefore the seed's post-hoc explanation,
**not an open defect.**

Evidence from `candle_basis_shadow`, **863,363 rows** across the three measured timeframes:

| TF | disagreement |
|---|---|
| 15m | 1.89% |
| 1h | 2.10% |
| 4h | 2.11% |
| **all** | **2.00%** |

When the two bases disagree (n = 58,333): mean |Δconfidence| **25.56**, mean signed **−4.24** —
the live basis was systematically **more bearish**. That independently corroborates the flip
wave's own finding that partial bars pinned volume at −70 and imposed a systematic bearish bias.

- **Instrument (both sides identical, which is what makes the delta valid):** one invocation of
  `computeIndicatorScores` per basis, on the *same* request — `get-trade-call.ts:596` (live) and
  `:619` (closed). A delta across two instruments is not a delta.
- **⚠️ Proxy, labelled as such:** these are **verdict** disagreements, not **regime-label**
  disagreements. The table answers *"did the bar basis change the call"*, not *"did it change the
  label"*. It is the closest live proxy available and is not the measurement.
- **⚠️ Explicit NON-SOURCE:** `candle_basis_shadow.structure_*` — 23 rows, and it is
  `get_market_regime`'s price-**structure** field (`HIGHER_HIGHS` / `LOWER_LOWS` / `MIXED`), not
  this regime. Using it would repeat the wrong-instrument error this arc has already hit four
  times. Recorded here so the next wave does not rediscover it.

---

## Scope note — what a regime error can and cannot cost

`regime` is **computed, returned and persisted, but read by nothing**: there is no `regime ===`,
no branch, no threshold and no adjustment anywhere in the verdict path. It co-derives with
`emaScore` from a shared parent (`emaCross`) rather than feeding it.

So the ceiling on what any regime error costs a *verdict* is the `ema` weight term — **0.10, the
smallest of the five** — plus the label itself. The flip wave's Step 0 independently found the
regime-gated asymmetric thresholds *"defined once and never read"*.

**The comment at `get-trade-call.ts:328` — "Detect regime FIRST (used for asymmetric
thresholds)" — is FALSE.** Follow-up: `SIGNAL-REGIME-COMMENT-CORRECTION-W{NEXT}`.

This is why the wave is scoped to **label quality**, not verdict quality. The label is
public-facing and is the lead sentence of `reasoning`; a flip-flopping label is customer-visible
wrongness independent of its 0.10 contribution.

---

## Reproduce

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/harness/regime-stability.test.ts
```

```bash
REGIME_MATRIX=1 npx vitest run tests/harness/regime-matrix.run.test.ts
```

The first prints one `REGIME_STABILITY_VERDICT=PASS|FAIL|INDETERMINATE` (INDETERMINATE = 3). The
second is the live run and rewrites this report's JSON.
