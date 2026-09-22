# EDGE-SCORER-PREDICTIVE-CEILING-W1 — pre-registration of the scorer's predictive ceiling

**Write-time clock (live `date -u`):** `2026-09-21T08:10:46Z` (epoch `1789978246`). `T_END` in §1.2 is fixed from this reading.
**Owner:** `EDGE-SCORER-PREDICTIVE-CEILING-W1` · **Procedure:** `audits/PREREGISTRATION-PROCEDURE.md`
· **Gate:** `tests/unit/preregistration-support-stress-test.test.ts`
· **Architect ratification:** Plan-Mode HALT 2026-09-21T07:59Z (12 questions) answered 2026-09-21: **GO, all 12 approved**, riders on Q4, Q5, Q7, Q8, Q10. Four spec corrections were accepted: the pooled null is not 0.5; the cluster unit is coin; `raw_final IS NOT NULL` supersedes the 10:37:58Z timestamp; `P(decided|X)` is a diagnostic.

This file is **methodology only**. It carries no outcome figure. The cardinalities it states are cardinalities under PROCEDURE §1. Prior outcome figures are disclosed in §2 **by reference**, never restated. Every AUC, interval, rate or coefficient derived under this registration lives in the private vault; the code repo is public.

---

## 0. The question, and what this registration does not decide

**Question.** Can a function fitted to the captured scorer inputs **rank** withheld-decision outcomes out-of-sample, and by how much does it beat the live raw score on the same rows? That is predictive **skill**, which is not association. Skill tells you whether the scorer's *function* or its *inputs* is the defect. Association cannot.

**Deliverable.** One comparison per holdout: `AUC(best fitted, inputs-matched) − AUC(S*)`. It is reported beside `AUC(S_fixed)` and decomposed as in §4.4. A registered three-state verdict line (§8) follows.

**Not decided here, and not this wave's to decide:** any scorer, ladder, weight, threshold or `MAX_RAW_SCORE` change; `TREND_MODE` (ratified and permanent); the HOLD-discipline hypothesis (§12). **No model is persisted or wired to any serving path.** No outcome is predicted anywhere in this file. **The whole estimand is WITHIN the withheld support** (SELL `|raw_final| ≤ 55`, BUY `|raw_final| ≤ 40`), and every headroom figure carries that label on its face (§8.4).

---

## 1. Corpus — a literal predicate, closed by a clock

### 1.1 Base predicate (label-blind extraction)

```sql
FROM hold_decisions h
JOIN hold_decision_labels l
  ON l.hold_decision_id = h.decision_id
 AND l.barrier_spec = 'tau1.0-floor0.30-v1'          -- sole primary spec
WHERE h.raw_final IS NOT NULL                        -- capture-start, AUTHORITATIVE (§1.2)
  AND h.decided_at <= 1789718400                     -- T_END, inclusive
  AND h.suppression_reason = 'below_threshold'       -- support [-55, +40], contiguous
  AND h.would_be_side <> 0
  AND h.exchange IS NOT NULL
  AND h.timeframe <> '1m'                            -- retired lane
  AND l.low_vol_history = FALSE                      -- same criterion as the emitted arm (§1.4)
  AND l.computed_at <= to_timestamp(LABEL_FREEZE)    -- §1.2, value in §1.7
```

The following are applied in the driver from registered maps, and each drop is reported by name:
- **served-bar maturity:** `l.computed_at ≥ ceil(decided_at / served)·served + W·served`, with `served` from the served-interval map (§1.5) and `W = EVAL_CANDLES[tf]`. This excludes races run on a partial final bar.
- **faithful `(venue, tf)` only**, per `isTimeframeFaithful`.
- **the test-window population rule** (§1.3).
- **coarser-served cells excluded:** `(venue, tf)` pairs whose served bar is longer than `tf` (3m served on 5m bars on GATE, MEXC, HTX, PHEMEX, WEEX and XT). The labeler fetches only `(W+2)·tf` ahead there and drops every label-0 race (`backfill-hold-decision-labels.ts:463`, `:490`), so these cells can never hold a timeout. They are decided-only by construction.
- **WEEX rows decided before `1788431453`** (2026-09-03T10:30:53Z) excluded. That is when the V3 adapter went live (commit `2828ac00`, deploy run `33744270607`). WEEX inputs are non-stationary across the cutover: the Hurst not-evaluated share flips 0.3 % → 99.7 % on 30m, and the volume −70 share rises on every timeframe.
- **frozen-price `(venue, coin)` series excluded:** `price_at_decision` takes ≤ 2 distinct values across ≥ 5 distinct UTC days over all post-capture parts rows with `decided_at ≤ T_END`. The race entry price is stale there. The window is clock-closed like the corpus, so the list cannot move after registration. Measured 217 pairs at `≤ T_END`, against 216 without the bound; the difference is one pair, HTX|CVX, which gains a third price only after `T_END`.

**Extraction splits the label into files that are read at different times** (§10): the X-file (every column above except `label` and `ambiguous_candle`), the R-file (`decided = label≠0`, `ambiguous_candle`) and the Y-file (the direction target of §3.1). Each is sha256-recorded at pull time.

### 1.2 Bounds

| Bound | Value | Derivation |
|---|---|---|
| start | `h.raw_final IS NOT NULL` ⇔ `decided_at ≥ 1788172475` (2026-08-31T10:34:35Z) | Measured 2026-09-21: the parts columns are all-or-none, with 0 mixed rows and 0 parts-less rows at or after 1788172475. **The `2026-08-31T10:37:58Z` literal is superseded.** It is 203 s late and would drop 7 labelled rows per spec; a column predicate is the right instrument anyway. |
| `T_TEST` | `1789086632` (2026-09-11T00:30:32Z) | `max(h.decided_at)` over tau1.0 labels computed inside the three authorised drain intervals whose per-leg counters were published to the vault or read: 2026-09-05 18:30–20:44Z, 2026-09-09 18:00:31–21:27:01Z and 2026-09-10T18:00:31Z–2026-09-11T03:37:42Z. Measured 2026-09-21T08:11Z, label-blind. **Test rows are `decided_at > T_TEST`**: the time after the last drain whose outcome counters anyone has seen. |
| `T_END` | `1789718400` (2026-09-18T08:00:00Z) | `floor_hour(1789978246 − 259200)`. 72 h = `EVAL_CANDLES['1d']` (3) × 24 h. |
| `LABEL_FREEZE` | the end of the §1.6 pass (value in §1.7) | Fixed before landing. It excludes labels the nightly writes after the pass, including its alphabetical-prefix labels. |

**Rows beyond `T_END` belong to a successor and are said to.**

### 1.3 Test-window population rule (`T_TEST < decided_at ≤ T_END`), de-alphabetised and day-spread

Each `(venue, stored coin)` maps to a normalised coin `c` through the registered map `audits/scorer-predictive-ceiling-coin-map-2026-09-21.json` (sha256 in §1.7). **The key is `VENUE|COIN`, never the stored coin alone.** Ten stored tickers name different instruments on different venues (e.g. `CAT`, `ON`, `AI`), and the map splits them on price evidence. `c` gets a hash day `k(c) = uint32(md5('EDGE-SCORER-PREDICTIVE-CEILING-W1|day|' + c)[:8]) mod 7`. The day starts are `D = [T_TEST+1, 2026-09-12T00:00Z, 2026-09-13T00:00Z, 2026-09-14T00:00Z, 2026-09-15T00:00Z, 2026-09-16T00:00Z, 2026-09-17T00:00Z]`.

**The test-window population is, for every `(venue, coin, timeframe, side)`, the OLDEST decision with `decided_at ≥ D[k(c)]` and `≤ T_END`** that satisfies §1.1's `h.*` filters. Ties are broken by `decision_id` ascending. A test-window row enters the corpus only if it is that population row. Extra depth written by the nightly labeler (its alphabetical coin prefix) is outside the population by predicate.

This is an X-only rule. It is a function of coin identity, time and the capture sampler, and never of an outcome. Rows with `decided_at ≤ T_TEST` enter as labelled, with no population rule; their selection history (SELL-only drains, oldest-first nightly) is disclosed as a stated limit.

### 1.4 The resolution-time liveness predicate, re-pinned

`hold_decision_labels.low_vol_history` is computed by the **same code and the same criterion** as `directional_labels.low_vol_history`: `computeSigmaW` with fewer than 30 non-overlapping W-windows, over the same `(60W+2)`-candle fetch (`backfill-hold-decision-labels.ts:476-480` ≡ `backfill-directional-labels.ts:572-576`). It measures trailing-history depth, not forward liveness.

The table has **no forward-liveness column**: races with no forward klines, or short-window timeouts, are never written. The resolution-time predicate this registration pins is therefore `low_vol_history = FALSE` plus the served-bar maturity predicate (§1.1). The latter is the actual resolution-time hole: a HOLD label can be computed on a partial final bar and written once.

### 1.5 Registered maps (artifacts, committed with this file)

- `audits/scorer-predictive-ceiling-coin-map-2026-09-21.json` — normalised coin. Rules are cited to source, every merge group is listed, and the file carries its own sha256. **A normalisation applied but not recorded is a silent degree of freedom; this file is the record.**
- `audits/scorer-predictive-ceiling-served-map-2026-09-21.json` — per `(venue, tf)`: served interval, `W`, `H_eff = W × served`, and `faithful`.

### 1.6 The single authorised labelling pass (architect Q5a)

It runs once, **before this registration lands**, label-blind, on both sides, in the deploy-free window 2026-09-21T18:00Z → at the latest 02:45Z, and never across the 03:41Z nightly.

- **Unit:** one standard CLI call per `(venue, coin, side)`: `backfill-hold-decision-labels --venue V --coin C --side S --since D[k(c)] --per-cell 1 --require-parts --max-decisions 200`. No `--time-budget-min`, so no call truncates internally.
- **Order: de-alphabetised.** Coins are taken in `md5('EDGE-SCORER-PREDICTIVE-CEILING-W1|order|' + venue + '|' + coin)` order, both sides consecutively. A global cut therefore truncates a hash-random coin set, never an alphabetical prefix.
- **Venues:** the drain's declared list of 13 (HL and WEEX are excluded for measured batch saturation). Their test-window population rows enter only if already labelled, and are reported per venue.
- **Sealing:** every call's output passes through a filter that deletes the `wins`, `losses` and `timeouts` keys **before anything is written to disk**. Logs are sha256-recorded. No outcome aggregate is produced.
- Labeling computes outcomes and therefore cannot select on them. That is what makes the pass label-blind, the same property that justified the two prior authorised drains.
- **Alphabetical reach has now shaped a sample in three waves and been worked around three times** (the attribution arc, `EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2`, and the post-2026-09-12 nightly). This pass is the last call-site workaround. **The next wave to hit it must fix the labeler's worklist ordering itself** (`EDGE-LABELER-BREADTH-ORDERING-W{NEXT}`), never work around it again.

### 1.7 Values fixed after the pass and before landing

| Item | Value |
|---|---|
| `LABEL_FREEZE` (epoch, UTC) | `1790036701` = 2026-09-22T00:25:01Z, the launcher's `end` line |
| pass start / end (`date -u`) | 2026-09-21T18:02:28Z → 2026-09-22T00:25:01Z. `PREFLIGHT_VERDICT=PASS`. **All 14,268 planned calls ran**, including the 238 deferred 1d calls released at 00:00Z. No deadline cut, and 0 labeler processes left in the container. `EDGE_PASS_VERDICT=INDETERMINATE` is worst-wins over the per-call labeler tokens: 13,883 PASS, 157 FAIL (`no_klines`, dead or delisted symbols), 228 INDETERMINATE (symbol fetch errors). These are instrument-availability drops, reported in §1.8, and not an integrity failure of the pass |
| pass log sha256s | host manifest `/root/edge-ceiling-w1/SHA256SUMS` (17 files, all `OK`), itself sha256 `f1486531abf2282ad9599f959ee6a0cb40284f736dfb8e2f37f135481ddf1cd4`. The seal holds: 0 `wins`/`losses`/`timeouts` keys on disk. Plan `plan.tsv` sha256 `937f7772fb1a85f4e7e9b4afd13b0e0c40ed456ed15a1348b5ce50dbc834c09e`, `coin_day.tsv` `105b341e4c04df9711eba2c72e70bcb43f0c1b36aa93faaa64c2b7884d019b0a` |
| coin map sha256 · distinct stored → normalised | file `b09f634572ddcbc85e517d273c649417e690c71bea9e52c084f0db6dd3f57f34` · sorted map `6246917c1c647d82f0f4c65c55d472bb7fedaa3ba0547016d115df8bd1d1d135` · 7,681 `(venue, coin)` pairs → 1,741 normalised coins |
| served map sha256 | `b4fa1e473b95a4873d1da20d31c520ed699190ccf179c88515b65f718c567f10` |

### 1.8 Coverage — two denominators

Test window, per side × venue × hash day. Denominator 1 is population rows across all 15 venues; denominator 2 is population rows across the 13 pass venues. The numerator is population rows carrying a tau1.0 label computed ≤ `LABEL_FREEZE`. Named drops: `low_vol_history`, maturity, non-faithful, `no_klines` / never written. Measured label-blind after the pass (`coverage_run.sh`, `COVERAGE_VERDICT=PASS`):

| Denominator | Side | Population | Covered | Share | Covered before the pass | Covered by the pass |
|---|---|---:|---:|---:|---:|---:|
| D1, all 15 venues | both | 73,444 | 69,278 | 94.3 % | 1,377 | 67,901 |
| D1 | BUY | 35,374 | 33,342 | 94.3 % | 638 | 32,704 |
| D1 | SELL | 38,070 | 35,936 | 94.4 % | 739 | 35,197 |
| D2, 13 pass venues | both | 71,886 | 69,264 | 96.4 % | 1,363 | 67,901 |
| D2 | BUY | 34,592 | 33,334 | 96.4 % | 630 | 32,704 |
| D2 | SELL | 37,294 | 35,930 | 96.3 % | 733 | 35,197 |

The pass also labelled 4,398 non-population rows, which are outside the corpus by predicate: 3,715 decided after `T_END`, 466 later rows in an already-covered cell, and 217 not `below_threshold`.

**Corpus after every registered filter** (label-blind build stage, `SCORER_CEILING_STAGE_VERDICT=PASS`):
- 169,888 labelled parts rows at `LABEL_FREEZE`, minus `low_vol_history` 12,305, gives 157,583.
- Sequential drops: maturity 3,015 · non-faithful 0 · test-window non-population 10,015 · coarser-served 65 · WEEX pre-V3 311 · frozen-price pairs 1,605 (217 pairs).
- **Kept 142,572: SELL 100,200, BUY 42,372.** 1,344 normalised coins.
- Instrument identity: max residual 0.0 for both `raw0` and `raw_final` on all 157,583 rows, with 0 orientation violations.

---

## 2. Prior-examination disclosure

The corpus has been read before; nothing below is a test input. A prior look does not invalidate a test; an undisclosed one would. Outcome figures are cited by reference and live in the vault.

| # | Prior examination | Population | Statistic class | Class here |
|---|---|---|---|---|
| 1 | `EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1` (2026-08-30) | SELL withheld, pre-capture, `decided_at ≤ 1788132578` | band DWR (confidence is monotone in `\|raw_final\|`) | seen — not a test input |
| 2 | `EDGE-SELL-FEATURE-ATTRIBUTION-W1` (2026-09-04) | SELL, parts, `[1788172475, 1788505940]` | per-level DWR, rank correlations | seen — not a test input |
| 3 | `EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1` (2026-09-05) | SELL all-labelled ≤ 1788505940; BUY ASTER-only arm | LPM partials; in-sample `P(decided\|X)`; decided-vs-timeout partition (the "~51 %" the spec cites); decided-rate-vs-DWR gradients | seen / coverage ratio |
| 4 | `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1` / `-W2` (2026-09-05 / 09-10) | SELL, `(1788505940, 1788631878]` | LPM partials, `P(decided\|X)`, per-timeframe decided rates | seen — not a test input |
| 5 | `EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2` (2026-09-11) | SELL `below_threshold`, `(1788172475, 1788764400]`, label freeze 1789117355 | **band DWR by confidence**, which is a coarse look at `S`'s discrimination on SELL; same-rows always-BUY; its drain's per-leg win/loss counters (no `decided_at` upper bound, reach ≤ `T_TEST`) | **seen — S-level on SELL, train window only** |
| 6 | `AOE-status.md` band-ordering note (from #1, #5) | SELL withheld | ordering of band DWRs | seen |
| 7 | `EDGE-BDIR-KILLTEST` v1 / v2 / v2.5 (2026-07-04/05/21) | **emitted** arm (`signals ⋈ directional_labels`) | out-of-fold ranking skill of L2-logistic + HistGradientBoosting — **this wave's statistic class, on a different population** | seen — disclosed so "the arc has never measured predictive skill" is not repeated |
| 8 | scorer-input canary `decided_hold_sell_canonical` | SELL tau1.0 since capture-start, no upper bound | a decided count | coverage ratio |
| 9 | This wave's Plan-Mode probes (2026-09-21, vault `audits/EDGE-SCORER-PREDICTIVE-CEILING-W1-endpoint-truth.md`) | label-blind | cardinalities, schema, label-blind ICC of score ranks, synthetic simulations | cardinality |

**Every look in #1–#6 lies at `decided_at ≤ T_TEST`.** The temporal test window (`> T_TEST`) has had **no** feature-level, band-level or S-level outcome examination. The only exposures are the nightly labeler's pooled host-log counters, which nobody has read, and the canary's cumulative SELL decided count. The cluster-arm rows at `≤ T_TEST` are seen at the SELL S-level through #5; the verdict gates on both arms (§8), and the temporal arm is on unseen data.

---

## 3. Targets and the estimand

### 3.1 Targets

- **Direction target (the question):** `y = 1[label = +1]` on `label ≠ 0 ∧ ¬ambiguous_candle`. `label` is **relative to `would_be_side`** (`migrations/032_hold_decision_capture.sql:200`). A same-candle double touch is forced to −1 on **both** sides (`directional-labeler.ts:151-155`), so ambiguous rows are a volatility label and are **excluded** from every direction target. A counted-as-incorrect sensitivity is reported as a diagnostic.
- **Resolution target (diagnostic only, gates nothing):** `y_d = 1[label ≠ 0]` on all corpus rows. Rows with `ema_score = 0` or `volume_score = 0` are excluded by name: they are decision-time dead-book codes, 0 % decided on every prior SELL population, so logistic fits separate on them. Direction AUC measured **within** decided rows cannot be resolution skill in disguise, because resolution is held constant there. The diagnostic bounds generalisation.

### 3.2 Primary estimand — within-side block-stratified AUC

The discrimination null of 0.5 holds **within side only**. With a side-relative label, a pooled fit with `side` as a feature has a null of `0.5 + q(1−q)(2p−1) / (2P_c(1−P_c))`, which is 0.545–0.656 under the W2 tape: the fit would re-learn the drift. So:

- **Blocks** = `side × UTC-day(decided_at) × H_eff × fold`, where fold applies only to cross-fitted arms (§5). Only **within-block** pairs count. The weight of block `b` is `n1_b · n0_b`.
- `S_fixed = |raw_final|` (= `would_be_side · raw_final`), and every family is fitted **within side**. **`side` is not a feature.**
- The pooled AUC (all pairs, both sides) is a **diagnostic only** and gates nothing.
- **Instrument check, stated before the fit:** `raw0 = 0.30·rsi + 0.10·ema + 0.25·funding + 0.15·oi + 0.20·volume` and `raw_final = raw0 + funding_delta + hurst_delta + squeeze_delta` must both hold with **max residual exactly 0** on the pulled corpus (measured 0 on 102,695 rows at Plan Mode). Within side, a linear family then nests `S_fixed`. **If either identity fails, the feature set or the weights are not what this file assumes. That finding outranks the wave: the verdict becomes `INDETERMINATE — INSTRUMENT` and no AUC is read.**

---

## 4. Families and comparators — fixed before any fit

**Inputs-matched feature set `X8`** (the ratified D1 inputs, ÷100 scaling): `rsi_score, ema_score, funding_score, oi_score, volume_score` and `funding_delta, hurst_delta, squeeze_delta`. It is exactly what `S` is computed from.

| Name | Definition | Role |
|---|---|---|
| `S_fixed` | `\|raw_final\|` | the incumbent, oriented within side |
| `S*` | the best univariate function of `S_fixed`: 20 equal-count bins of `S_fixed` on the **train rows of each side** (label-blind edges, ties kept together), add-half-smoothed train bin means `(Σy + 0.5)/(n + 1)` (`bin_map_fit`) | **the decisive comparator (Q8)** |
| **L** | `logistic_irls([1] + X8, y, max_iter=25, tol=1e-8, ridge=1e-8)` within side. Not converged or `separated` ⇒ L is `NOT_ESTIMABLE` on that arm, and no reading can use it | family |
| **T** | `sklearn.ensemble.HistGradientBoostingClassifier(loss='log_loss', learning_rate=0.05, max_iter=300, max_leaf_nodes=15, max_depth=None, min_samples_leaf=200, l2_regularization=1.0, max_features=1.0, max_bins=255, early_stopping=False, random_state=arm_seed)` on `X8` within side. **Hyperparameters are literal; no tuning of any kind.** | family |
| `V` (vol-only control) | `logistic_irls([1, ln(barrier_pct), ln(barrier_pct)²], y)` within side. `barrier_pct` is the tau1.0 label row's outcome-free barrier; it includes at most one post-decision close, which strengthens the control and is conservative for CEILING | **CEILING condition (Q8)** |
| `L_full`, `T_full` | `X8` + timeframe dummies (reference = modal tf) + `hurst_evaluated = 1[hurst_adjust_code ≠ 0]` | diagnostic: the extra-covariate component |
| `L_dir`, `T_dir` vs `S_dir` | `rsi, ema, funding, oi` only, vs `S_dir = side·(0.30·rsi + 0.10·ema + 0.25·funding + 0.15·oi)` | descriptor: directional-only ablation |
| `P(decided\|X)` | L and T on `X8`, target `y_d`, within side × `H_eff` blocks | diagnostic |

### 4.4 Decomposition, reported every time

- **Recombination headroom (the rebuild figure)** = `A(best inputs-matched family) − A(S*)`.
- **Mapping** = `A(S*) − A(S_fixed)`.
- **Extra covariates** = `A(full) − A(inputs-matched)`.
- **Vs the vol-only control** = `A(f) − A(V)`.

Only recombination headroom may feed a rebuild decision.

---

## 5. Holdouts — reported separately, never pooled

| Arm | Train | Test | Role |
|---|---|---|---|
| **cluster** | 5-fold grouped cross-fit on normalised coin over the whole corpus: `fold(c) = uint32(md5('EDGE-SCORER-PREDICTIVE-CEILING-W1|fold|' + c)[:8]) mod 5`. Model k trains on folds ≠ k and scores fold k | all corpus rows | **gating** |
| **temporal** | corpus rows whose race ends by the split, `race_end = ceil(decided_at/served)·served + W·served ≤ T_TEST` (**purged**; the count is reported by name, and `assert_purged` must pass) | corpus rows `decided_at > T_TEST` | **gating** |
| **doubly-held-out** | temporal-train rows with `fold(c) ≠ k` | temporal-test rows with `fold(c) = k`, k = 0..4 | **reported prominently, beside the verdict line; not gating.** It is the only arm resembling what a rebuilt scorer would face |
| split-at-1788764400 | race end ≤ 1788764400 | `decided_at > 1788764400` | sensitivity, diagnostic |
| native-served only | each gating arm restricted to `(venue, tf)` pairs with served = tf | same | sensitivity, diagnostic: when served ≠ tf the labeler's cursor steps by `tf` (`backfill-hold-decision-labels.ts:380`), which can skip one served bar per page |

The day-jackknife (leave-one-test-day-out on the blocked gap) is a registered secondary for each gating arm.

---

## 6. Inference

- **Unit:** normalised coin, with `(venue, coin)` counts printed beside. Coin is the dependence unit: the same coin on two venues shares one price path.
- **Bootstrap:** fit once per arm (per fold). Resample coins with replacement **jointly** for every score set and across all blocks, then recompute the blocked AUCs on each replicate with multiplicity weights. `B = 4,000`. Seed per arm = `uint32(sha256('EDGE-SCORER-PREDICTIVE-CEILING-W1:' + arm)[:8])`. Percentile intervals use the rule implemented in `cluster-perm-stats.py:percentile`. Degenerate replicates (zero within-block pairs) are **counted, never silently dropped**.
- **Levels:** Bonferroni over `{L, T}`, one-sided `α = 0.0125`, for every CEILING bound. One-sided 95 % for the NO-CEILING equivalence bound.
- Beside every AUC: the number of coins and `(venue, coin)` pairs, Kish `G_eff`, `m*`, the modelled and achieved SE, and the number of days. A stratum with `G_eff < 50` is printed as `not decision-grade`.
- **Interpretation:** each interval is conditional on the fitted model and on the test days. It covers sampling of test instruments, not training variability or days beyond the window.

---

## 7. Floor, power and materiality — one number: `δ = 0.05`

**`δ = 0.05` is registered ONCE and serves as both the floor's target precision and the NO-CEILING materiality margin**, so the two cannot drift apart.

**Formula, registered before any fit** (`auc_floor` in `src/scripts/cluster-perm-stats.py`). It is evaluated per arm on the decided, non-ambiguous test rows:
- `D = U_f − U_{S*}`, where `U_x` = within-block midrank of `x`, minus ½, over `n_b`.
- `σ²` = pooled within-block variances; `ρ` = one-way ANOVA ICC(1) of `D` (gap) and of `U_f` (level) within normalised coin; `m* = Σm_g² / Σm_g`.
- **`ρ_e := 1`**, the label-side ICC bound. It is registered and never estimated, so `DEFF = 1 + (m* − 1)·max(ρ, 0)·ρ_e`. A negative ICC counts as 0. An ICC that cannot be measured (fewer than 2 clusters) **fails** the floor.
- `V = 1/(π̲(1−π̲))` with **`π̲ = 0.15`**: the lowest direction base rate on record for this store (prior look #4, long-timeframe SELL), used only as a conservative bound.
- `SE = √(σ²·V·DEFF / n)`. `PASS_f ⇔ K·SE_lvl ≤ δ ∧ K·SE_gap ≤ δ`, with `K = z_{0.9875} + z_{0.80} = 3.0830`. `FLOOR_arm ⇔ PASS_L ∧ PASS_T`. A `NOT_ESTIMABLE` family has no floor, so `FLOOR_arm` is false and the arm reads `P`, with the cause named in the verdict line. **P pre-empts C and N**: the partner family cannot carry a C on that arm (§8.1). The driver calls `auc_floor(…, delta=0.05, pi_lower=0.15, alpha_one_sided=0.0125)` and `family_bounds(…, n_families=2)` always, including when a family is `NOT_ESTIMABLE`, with `S*` as the incumbent and exactly `{L, T}`.

**AC6, as amended by the architect:** "formula registered before any fit; evaluated before any test label is read."
- For the temporal arm: the FLOOR line is written before the Y-file rows of the test window are opened.
- For the cross-fitted arm, every row trains four models, so the operational meaning is per fold. **Fold k's floor terms are computed from scores of a model that never saw fold k, before any fold-k score is compared with a fold-k label.**

**The ICC is PROVEN label-blind, not assumed (Q4 rider).** The checkpoint reads the resolution partition (the R-file: decided, ambiguous), a boundary-class quantity disclosed here, and never a direction sign. The proof is recorded in the FLOOR line:
- (i) The checkpoint function takes no label argument.
- (ii) The temporal FLOOR line is recomputed with the test window's direction labels replaced by a seeded permutation, and must be **byte-identical**.
- (iii) For each fold k, the fold-k floor terms are recomputed with fold k's direction labels permuted, and must be byte-identical.

Any difference means the floor is `INDETERMINATE — INSTRUMENT`, and the wave stops.

**Underpowered branch, registered:** a failed floor makes the arm's reading `P`. The verdict is then `INDETERMINATE — UNDERPOWERED`, naming the arm, its achieved `n_eff` and the `n_eff` needed.

---

## 8. Decision rule — three states, one line

### 8.1 Per-arm reading `R ∈ {C, N, P, U}`

- **P** if `FLOOR_arm` fails, including when a family is `NOT_ESTIMABLE` (§7). P is checked first.
- **C** if some `f ∈ {L, T}` has `CI_lo(A_f) > 0.5 ∧ CI_lo(Δ_f) > 0 ∧ Δ̂_f ≥ δ ∧ CI_lo(A_f − A_V) > 0`, with `Δ_f = A_f − A_{S*}` and every bound at Bonferroni one-sided 0.0125.
- **N** if every `f` has `max(CI_hi95(Δ_f), Δ̂_f) < δ`, with one-sided 95 %. A `NOT_ESTIMABLE` family blocks N.
- **U** otherwise.

C and N are mutually exclusive by construction.

### 8.2 Map `(R_cluster, R_temporal)` → state

Precedence is `P > disagree > unresolved`, and exactly one state is returned per cell.

| Cell | State |
|---|---|
| any P | `INDETERMINATE — UNDERPOWERED` (arm and `n_eff` named) |
| CC, **the same family** qualifying on both arms | **`CEILING EXISTS`** |
| CC with no common family, or CN, or NC | `INDETERMINATE — DISAGREE`, with direction named. L on one arm and T on the other is two findings wearing one verdict |
| NN | **`NO CEILING`**: the functional form was never the defect; the answer is new inputs. Reported as plainly as a hit |
| CU, UC, NU, UN, UU | `INDETERMINATE — UNRESOLVED` (cause named) |

### 8.3 Descriptors that go IN the verdict line (never states)

- **`S_INVERTED`** when `CI_hi95(A_{S_fixed}) < 0.5` on either gating arm, i.e. the inversion `0.5 − A_S` has CI_lo > 0. A scorer that ranks backwards is a first-order finding.
- **`MAPPING-ONLY`** when an arm reads N while `CI_lo(A_{S*} − A_{S_fixed}) > 0` (one-sided 0.025). The inputs are fine and only the mapping is wrong, which is a far cheaper fix than a rebuild, and is called out by name.
- The doubly-held-out arm's gap and interval.

### 8.4 Headroom

**Consumable headroom = `max_f min_arm CI_lo(Δ_f, arm)`** at the Bonferroni level. It is printed as "**within the withheld support (SELL \|S\| ≤ 55, BUY \|S\| ≤ 40)**" on the headline figure itself. Point estimates are printed beside it and are never consumed.

---

## 9. Support stress-test

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| direction target | decided ∧ ¬ambiguous rows, per side | Decided counts are unknown before the pull (boundary class). Labelled corpus rows: SELL 100,200, BUY 42,372 | floor (§7) |
| blocked AUC (primary) | within `side × day × H_eff (× fold)` blocks | Cluster arm: SELL 1,099 blocks (3,655 rows in blocks < 30), BUY 1,013 blocks (6,758). Temporal test: SELL 95 blocks (210), BUY 95 (217) | inside |
| `S_fixed` orientation | `\|raw_final\|` within side | SELL `[1, 55]`, BUY `[1, 40]` on `below_threshold` rows; `sign(raw_final) = would_be_side` on 100 % of rows | inside |
| `S*` bins | 20 equal-count train bins per side | distinct `\|raw_final\|` values: SELL 55 (1–55), BUY 40 (1–40); ≥ 20 required | inside |
| L / T on `X8` | fitted within side; ranks only (no main effect is read, so no zero-point issue) | Levels per side (SELL / BUY): rsi 7/7, ema 3/2, funding 5/5, oi 5/5, volume 7/6, funding_delta 5/5, hurst_delta 4/4, squeeze_delta 2/2. L separation flag checked at fit | inside |
| vol-only control `V` | `barrier_pct` within side | SELL p05/p50/p95 0.69/2.84/10.30 (range 0.30–104.47); BUY 0.71/2.87/10.04 (0.30–104.47) | inside |
| instrument identity | every corpus row | max residual 0 on 102,695 rows (Plan Mode); re-checked at pull | inside |
| cluster arm | 5 coin folds | Coins: SELL 1,338 (Kish 411.3, m* 243.6), BUY 1,307 (Kish 250.8, m* 169.0). Per-fold Kish: SELL 106/89/81/67/75, BUY 96/51/58/36/39 | floor |
| temporal arm | train race-end ≤ `T_TEST`; test `> T_TEST` | Train 79,099 / test 62,200 rows (SELL 67,441 / 31,918; BUY 11,658 / 30,282). 1,273 rows purged (SELL 841, BUY 432; by `H_eff` in the vault build record). Test coverage per §1.8 | floor |
| doubly-held-out | fold × window | Test rows per fold: SELL 7,466 / 5,898 / 6,329 / 5,722 / 6,503; BUY 7,160 / 5,619 / 5,918 / 5,422 / 6,163. Test coins per fold: 243–304 | inside (not gating) |
| floor | checkpoint formula §7 | Required at `δ = 0.05`, `π̲ = 0.15`, `K = 3.0830` (m* = 1, r = 0): gap 4,970, level 2,485. The achieved `n_eff` needs the decided partition and fitted scores, so it is evaluated at the checkpoint | floor |
| day-jackknife | leave-one-test-day-out | Temporal test days: SELL 8, BUY 8 (hash-day spread). ≥ 5 required | inside |
| `P(decided\|X)` diagnostic | all labelled rows excluding `ema_score = 0` / `volume_score = 0` | Excluded: SELL 27, BUY 0 | inside |
| split-at-1788764400 | sensitivity | Train 61,989 / test 75,475 (5,108 purged) | inside |

---

## 10. Order of operations (each step stamped with `date -u`)

1. Methodology commit landed: the pure statistics, fixtures and committed mutation harness in `src/scripts/cluster-perm-stats.py` and `tests/unit/`, **plus both registered maps (§1.5)**, so the hash-day assignment is fixed before the pass. No store is named. Landed `60191b83..7d385ff8` (`43842474` methodology, `7d385ff8` the test-budget declaration), 2026-09-21T14:37Z, `LAND_VERDICT=LANDED`.
2. The §1.6 pass, sealed. Then label-blind coverage (§1.8), `LABEL_FREEZE` fixed, §1.7 and §9 filled.
3. **This file lands** with the fourth-consumer line and the `hold-decision-preregistration-2026-08-26.md` §13 amendment. The landing carries a real `LAND_VERDICT=LANDED` (`--dry-run` also prints LANDED and proves nothing), outside every drain and labeler leg. The landed SHA and time are recorded.
4. Pull. X-, R- and Y-files are sha256-recorded, with the pull's `date -u` recorded beside the landed commit time.
5. Self-tests **before** the fit:
   - `cluster-perm-stats` self-test (the 48 inherited checks plus the new fixtures), `CLUSTER_PERM_SELFTEST=PASS`;
   - the mutation harness, `MUTATION_PROOF caught=14 missed=0` and `MUTATION_PROOF_SUPPLEMENTARY caught=15 missed=0`;
   - the stdlib-AUC vs `sklearn.metrics.roc_auc_score` cross-check (vault driver);
   - the §3.2 instrument identity.
6. The fit and the checkpoint interleave, because the cross-fitted arm must train on test-window labels from other folds. The Y-file is pulled as two sealed files split at `T_TEST`, `y-train` and `y-test`, and a file-identity guard (path, symlink, hard link or case variant) refuses any open of `y-test` before its stage:
   - `fit`: temporal models, using `y-train` only;
   - `checkpoint-temporal`: the temporal FLOOR line and proof (ii), written before `y-test` is opened;
   - `fit-cluster`: `y-test` opened only to train the other folds' models;
   - `checkpoint-cluster`: the per-fold FLOOR terms and proof (iii), before any fold-k score is compared with a fold-k label.
7. `read`: proof (ii) is repeated with the real test labels permuted, then AUCs, intervals, readings, the state and the verdict line are computed.
8. The driver reads back 34 registered constants from this file at its selftest stage and refuses on any mismatch, so a constant cannot drift between registration and run.

---

## 11. Instruments

- **Pure statistics** live in `src/scripts/cluster-perm-stats.py`: stdlib-only, column-free, pinned pure by `tests/unit/cluster-perm-stats.test.ts`. It gains known-answer fixtures (**162 checks**: K1–K11, K13, KP, KT, KS, plus the 48 inherited checks, byte-identical). K3 uses R = 200 and B = 100. K13 uses 100 null corpora (C must be ≤ 7, the binomial 0.995 bound at 0.025) and 10 planted corpora. That is smaller than the 200/200 sketched in the Plan-Mode critique, and is recorded as a deviation from that sketch, not from any registered text. It also gains **a committed mutation harness** `tests/unit/cluster-perm-stats.mutation.py`: `MUTATION_PROOF caught=14 missed=0` (registered M1–M14) and `MUTATION_PROOF_SUPPLEMENTARY caught=15 missed=0` (S1–S15, added by adversarial review). A catch by crash alone counts as MISSED. Both lines are pinned by vitest. An uncommitted mutation proof is the defect that left the predecessor's "14/14" unreproducible.
- **Fitting and orchestration** live in a vault-only driver. `T` runs on **scikit-learn 1.8.0** (numpy 2.4.6, scipy 1.17.1, joblib 1.5.3, threadpoolctl 3.6.0, CPython 3.12.13 arm64). **The pin was resolved before registration, exactly, with no substitution.** `uv run --offline` could not resolve it (index metadata not cached), so the environment was assembled from the uv cache's unpacked wheels with no network. `dist-info/RECORD` sha256 prefixes: scikit-learn `c7bb484598be6147`, numpy `e328d32755a3d86d`, scipy `6a7f843d177af1b2`.
- `computeCellStats` and `validityVerdict` are never called; both hardcode banned comparators. No `max(naive)` and no external-baseline level claim appear anywhere.

---

## 12. Quarantine, deviations, publication

- **Fourth ratified consumer of `hold_decision_labels`**, by resolved ID `EDGE-SCORER-PREDICTIVE-CEILING-W1`, under the same three protections: its own pre-registered hypotheses (this file); **never cited for or against the HOLD-discipline hypothesis**; nothing to public copy, an MCP response, a track-record surface or any customer-facing artifact. It is recorded in `tests/unit/counterfactual-quarantine.test.ts` and the system map. SQL lives under `audits/` and a session-local query layer.
- **HOLD-discipline adjacency:** AUC of `S` (≅ confidence) on withheld decisions is a statement about whether the engine's selection ranks outcomes. It is recorded as a prior examination in `audits/hold-decision-preregistration-2026-08-26.md` §13. **No AUC or DWR is ever reported per confidence stratum**, because the HOLD-discipline headline *is* the top confidence stratum, and a stratified AUC would pre-empt the pre-registered test.
- Deviations are recorded as deviations with their reason, never absorbed. A hypothesis or family the corpus suggests is registered for a successor, never added here.
- Figures are vault-only.

## 13. Inheritors, and conditions registered on them now

- **`EDGE-SCORER-REBUILD-W{NEXT}`**, if named, **must re-measure outside the withheld support before consuming any headroom number**. The withheld band is where `S` is least discriminating, so a model beating `S` there may not beat it in the tails where `S` actually operates. It must also change the emission geometry, and re-opening `TREND_MODE` is a deliberate architect decision, never a side effect.
- **`EDGE-LABELER-BREADTH-ORDERING-W{NEXT}`**: the next wave whose sample the labeler's alphabetical reach would shape **must fix the worklist ordering**, not work around it (§1.6).
- `EDGE-HOLD-DISCIPLINE-W{NEXT}` carries the §13 disclosure. The Sep 19 ablation lane (`EDGE-BDIR-V3-DIAGNOSTIC-W1`, emitted arm) and any future AOE objective may cite this wave's headroom only with its support label.
