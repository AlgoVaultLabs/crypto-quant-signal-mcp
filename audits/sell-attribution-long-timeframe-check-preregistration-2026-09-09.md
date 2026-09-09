# Pre-registration — does `oi` hold on the long timeframes? (`EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W2`)

**Written:** `2026-09-09T07:36:31Z` (live `date -u`, host and workstation agree — host `2026-09-09T06:54:20Z` read at Plan Mode, same clock).
**Procedure:** `audits/PREREGISTRATION-PROCEDURE.md` — §1 ordering, §2 disclosure, §3 literal corpus, §4 support stress-test (gated), §5 floors, §6 three-state rule, §7 respecification test, §8 deviations.
**Predecessor:** `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1` (✅ 2026-09-05) · registration `audits/sell-attribution-centered-check-preregistration-2026-09-05.md` · instrument `src/scripts/cluster-perm-stats.py`.
**Instrument:** unchanged, re-asserted in §6.
**This file is methodology only. It carries no outcome figure. Every figure it does carry is a cardinality.** Results live in the private vault; this repo is public.

---

## 0. Why this wave exists — the corrected motivation

The spec that dispatched this wave motivated it as *"those are precisely the timeframes that carry emission"*, citing emitted SELL share **8h 5.660 % · 12h 6.429 % · 1d 5.556 %** against **0.000–4.087 %** across `{3m…4h}`. Those figures are quoted correctly from `audits/EDGE-SCORING-LADDER-DECOMPOSITION-W1-2026-08-29.md` — **and that corpus pre-dates the 2026-08-31 `TREND_MODE` flip.** Re-derived on `signals` in Plan Mode:

| tf | 2026-08-29 (pre-flip, as cited) | W1's own population window | last 14 days |
|---|---:|---:|---:|
| 1h | 0.079 % | 14.664 % | 15.852 % |
| 2h | 0.000 % | 10.859 % | 16.903 % |
| 4h | 4.087 % | **16.396 %** | **19.221 %** |
| 8h | 5.660 % | 11.527 % | 16.275 % |
| 12h | 6.429 % | 12.377 % | 14.257 % |
| 1d | 5.556 % | 8.333 % | 8.307 % |

**Post-flip, 4h and 1h — both inside W1's measured band — carry more SELL emission than any long timeframe, and 1d carries the least of the three.** The 200×-varying-output result was a property of the pre-flip gate, not of the timeframes. The dispatching framing is recorded as a defect in §8 and is not repeated anywhere else in this registration or in the resulting audit.

**The registered motivation, superseding it:** `8h + 12h + 1d` carry **1,043 of the last 14 days' 11,082 SELL emissions = 9.4 % of SELL emission volume**, and W1 §9 forbids `EDGE-SCORING-LADDER-REDESIGN-W2` from consuming *anything* there — verbatim, *"anything for 8h, 12h or 1d (unmeasured out-of-sample)"*. This wave measures that band out-of-sample, or establishes that it cannot be measured on this population. Either answer is decision-grade for the redesign's support.

**The redesign is not blocked by this wave and never was.** W1 §9 reads *"unblocked on these terms and no others"* with support *"timeframes 5m–4h"*. `EDGE-SCORING-LADDER-REDESIGN-W2` may act on 5m–4h today. This wave **expands** its support or narrows it by name; it does not gate its existence.

---

## 1. Ordering, and the disclosures this file owes

**Ordering.** This registration lands **before the first outcome query against the corpus it registers** (procedure §1). Cardinalities were probed before landing; **no outcome statistic of the long-timeframe population has been read** — not a label sign, not a win rate, not a decided-vs-timeout ratio for 12h or 1d.

**AC1 of the dispatching spec asks for something stronger and physically impossible**, and it is the AC that is wrong: it requires the registration to land *before the first label of the new population exists*. The nightly labeler (`ops/cron/hold-decision-labeler.sh`, cron `41 3 * * *`, `--since 1788172475` = 2026-08-31T10:34:35Z) has a window that **contains** this population and has been labelling its long-timeframe rows since their barrier windows closed. The dispatching spec's own R0 states the binding rule — *"Cardinalities may be probed; outcome statistics may not"* — four lines above the AC that contradicts it. W1's clean ordering (land 18:24:59Z, first label ≥ 18:31Z) is not reproducible against a continuously-running shared producer, and pausing that producer is refused: it also serves `audits/hold-decision-preregistration-2026-08-26.md`, and starving one pre-registration to feed another is not this wave's trade.

### Prior-examination disclosure (procedure §2)

| when | what | class |
|---|---|---|
| before landing, Plan Mode 2026-09-09 06:5x–07:3xZ | every cardinality in §3 and §4 below: row / cluster / venue / cell counts, level occupancy, band occupancy, identity-violation counts, `decided_at` range, closed-window counts, and `hold_decision_labels.computed_at` extrema | **cardinality** |
| before landing, Plan Mode | **434 rows / 163 clusters of the registered population already carry a `tau1.0-floor0.30-v1` label**, written by the nightly labeler: 8h 185 rows / 120 clusters (first 2026-09-05 20:44), 12h 231 / 138 (first 2026-09-07 03:43), 1d 18 / 18 (first 2026-09-08 03:45). **Their label values were not read.** They are INCLUDED (§3) and a robustness fit EXCLUDING them is registered in §7 | **cardinality — existence and count only** |
| before landing, Plan Mode | emitted SELL share by timeframe on `signals` (§0). A property of the emitted arm, not of `hold_decision_labels`; it is not a regressor, not an outcome of this corpus, and not a test input | **seen — not a test input** |
| inherited from W1's audit | 8h in W1's increment: 5 labelled, **3 decided**. A decided-vs-timeout ratio on 3 rows of a timeframe this wave re-measures — the procedure §2 boundary case, disclosed rather than concealed. It is not a test input and it is superseded by this wave's own labelling | **coverage ratio — disclosed** |
| inherited from W1's audit | W1's full result set: OOS `oi` partial **+0.0883** [+0.029, +0.145], CR1 p 0.0034, G 1,107, n 3,691; corrected AME +0.0642; IPW +0.0865; all-labelled +0.0531; in-sample discovery +0.1687 / +0.2397; achieved CR1 SE **0.030137** | **inherited — the comparison basis and the power anchor, registered as such in §5 and §7** |

No other figure derived from the long-timeframe population has been seen by the author.

---

## 2. The corpus — a literal predicate, on the SAME frozen window

**`T_END` is NOT re-fixed.** W1 froze the population at `hold_decisions.decided_at ∈ (1788505940, 1788631878]` (2026-09-04T07:12:20Z → 2026-09-05T18:11:18Z). This wave measures the **long-timeframe subset of that same frozen window** — a subset W1 registered, could not measure, and named as absent. Re-fixing the bound would create a second population and make the §7 comparison a cross-population comparison rather than a same-window stratum contrast.

Consequence, registered: **the population is capped and cannot grow.** No later date adds a 1d row to it. That is why §5's underpowered branch resolves to a *successor wave on a new frozen window*, never to a date.

**Predicate, literal SQL** — W1's predicate with one added clause:

```sql
SELECT h.decision_id, h.exchange, h.coin, h.timeframe, h.regime, COALESCE(h.suppression_reason,''),
       l.label,
       h.rsi_score, h.ema_score, h.funding_score, h.oi_score, h.volume_score,
       h.raw0, h.funding_delta, h.hurst_delta, h.squeeze_delta, h.raw_final, h.hurst_adjust_code
  FROM hold_decision_labels l
  JOIN hold_decisions h ON h.decision_id = l.hold_decision_id
 WHERE l.barrier_spec = 'tau1.0-floor0.30-v1'
   AND h.would_be_side = -1
   AND h.raw0 IS NOT NULL
   AND h.decided_at >  1788505940
   AND h.decided_at <= 1788631878
   AND h.timeframe IN ('8h','12h','1d');   -- the only clause this wave adds
```

Timeouts (`label = 0`) are kept for D8. The **decided** subset is `label <> 0`. The emitted arm (`signal_scorer_inputs`) and the withheld BUY arm are not read.

**The registered population (cardinalities, probed 2026-09-09 06:5x–07:3xZ, host clock):**

| | value |
|---|---|
| rows / clusters `(venue, coin)` / venues | **15,733 / 5,563 / 15** · already labelled **434 rows / 163 clusters** · `book_liveness` 17 |
| drainable (ex `HL`, `WEEX` — refused by `resolve_venues`) | **15,487 rows / 5,473 clusters / 13 venues** · already labelled 428 |
| by timeframe — rows / clusters / **closed windows now** | 12h **8,288 / 4,910 / 8,288** · 8h **6,912 / 4,482 / 6,912** · 1d **533 / 531 / 533**. Every window in the population is closed: `T_END + 72h` = 2026-09-08T18:11:18Z passed before this file was written |
| by timeframe — drainable clusters (ex HL/WEEX) | 12h **4,861** · 8h **4,398** · 1d **498** |
| by venue — 1d rows / coins | BITGET 218/218 · BYBIT 110/110 · OKX 91/91 · BINANCE 81/79 · **HL 33/33 (refused)**. `PHEMEX` and `WEEX` carry **zero** 1d rows |
| `oi` level — rows / clusters | −60 2,767 / 1,625 · −20 4,067 / 2,422 · 0 2,430 / 916 · +20 4,204 / 2,562 · +60 2,265 / 1,453 |
| `ema` / `volume` / `rsi` / `funding` levels — rows | ema −100 8,743 · **0 114** · +100 6,876 · volume −70 8,618 · −30 4,979 · **0 380** · 10 1,397 · 50 194 · 80 106 · 100 59 · rsi −100 684 · −80 640 · −40 2,621 · 0 10,540 · 40 1,196 · 80 42 · 100 10 · funding **0 14,866 (94.5 %)** · 40 808 · −80 22 · −40 21 · 80 16 |
| bands / identity / hurst / regime | `\|raw_final\| ≤ 20`: 7,646 rows / 4,042 clusters · `≤ 10`: 3,853 / 2,608 · `raw0 + Δf + Δh + Δs = raw_final` violations at 1e-9: **0** · `raw0 ≥ 0`: 489 · `hurst_adjust_code ≠ 0`: 7,909 (50.3 %) · `raw_final` ∈ **[−66, −1]** · RANGING 5,792 · TRENDING_DOWN 5,531 · TRENDING_UP 4,410 |
| `decided_at` range | 1788508982 → 1788631876 (2026-09-04T08:03:02Z → 2026-09-05T18:11:16Z) |

Same ~35 h regime slice as W1, post-`TREND_MODE`-flip. Nothing generalises to the fleet.

---

## 3. The one authorised write — the second bounded drain pass

**Authorised (architect, 2026-09-09, "GO WITH SCOPE CHANGE — run NOW"): one bounded pass of `ops/scripts/hold-decision-drain.sh`**, extended in this wave with a `--timeframe` / `--per-cell` / `--max-decisions` / `--time-budget-min` passthrough (§3.1). `HOLD_DRAIN_SINCE_EPOCH=1788505941`; `--side sell --require-parts` are hardcoded in the script and are not caller-settable; the script's declared 13 venues, `HL` and `WEEX` refused by its own list.

**Three changes from W1's pass, each registered with its reason:**

1. **Per-timeframe legs, `1d → 12h → 8h`, scarcest first.** 1d's whole drainable population is 500 rows across four venues and it can never grow (§2), so it is drained first and exhaustively. W1's untargeted pass reached 0 of it.
2. **`--per-cell 1`, against W1's 3.** The analysis is powered by `(venue, coin)` clusters, and the instrument's own self-test asserts *"CR1 with one row per cluster == HC0 × the small-sample factor"* — one row per cluster carries no within-cluster correlation penalty. It cuts the work from ~15,500 rows to **9,489 unlabelled cells** (12h 4,726 · 8h 4,283 · 1d 480) for strictly more cluster breadth per unit time. Its cost is registered in §5: ~1 decided row per cluster against W1's 3.33, so precision is reported achieved-versus-modelled, never assumed.
3. **`--max-decisions` set ABOVE each leg's measured `--check` backlog, so the outer `ORDER BY exchange, coin, timeframe, decided_at LIMIT` never truncates.** This is how the alphabetical reach is broken: **complete reach removes the ordering as a variable rather than re-shuffling it.** The generator half — reordering the outer select by `rn` first — is **NOT** this wave's: it is owned by `EDGE-LABELER-BREADTH-ORDERING-W{NEXT}` under standing architect ruling (c) (`status.md`, unique substring `"call-site loop now, generator fix in its own wave"`), because it changes default worklist SQL and re-baselines `tests/unit/hold-decision-label-filters.test.ts`. **This wave claims no generator-level fix.**

**Riders, binding:**

- **(a) Coverage, two denominators.** Report per venue **and** per timeframe: population rows / clusters, rows and clusters the drain reached, the fraction of each, and the **union** with the 428 pre-existing labels. `unclosed_skipped` is expected to be 0 — every window in the population is already closed. Drops reported by name, never filled.
- **(b) Resumability, asserted before starting.** Unchanged from W1 and re-asserted: `INSERT … ON CONFLICT (hold_decision_id, barrier_spec) DO NOTHING` under the primary key; the work-list is `NOT EXISTS (label for this spec)`; a leg killed by a container recreation loses only its unflushed buffer. `backfill-hold-decision-labels` is `safe-to-kill` in `ops/scripts/cron-interlock-registry.json` — the protection is scheduling, not the interlock.
- **(c) Deploy window.** Before launch: no deploy in flight (`gh run list --workflow deploy.yml`), the three containers up, `date -u` inside the deploy-free window **18:00–02:59Z**, no other `hold-decision` process running; nothing lands from this session while a leg runs; the run finishes before the **03:41Z** nightly.
- **(d) Budget sized from W1's measurement, as instructed.** W1's `HOLD_DRAIN_VERDICT=INDETERMINATE` came from 7 of 13 legs hitting a 12-minute budget. Measured W1 throughput: completed legs **92–191 rows/min** (BINGX 851/9.3, BYBIT 911/11.9, HTX 917/9.8, PHEMEX 930/5.6, WHITEBIT 900/4.7, XT 738/6.6); truncated legs **13–64 rows/min**. Registered: **`--time-budget-min 25`** per leg, and any leg that still truncates is reported as truncated with its elapsed time and its realised reach — the verdict is reported either way, `PASS` or `INDETERMINATE`.

### 3.1 The script change, and why it is at the call site

`ops/scripts/hold-decision-drain.sh` parses only `--dry-run` and `--venues` and returns `HOLD_DRAIN_VERDICT=INDETERMINATE` / exit 3 on any other argument. `src/scripts/backfill-hold-decision-labels.ts` already carries `--timeframe`. This wave adds passthrough to the **drain script**, not a second launcher: a wave-specific launcher would give `combine_verdict` and `leg_was_container_fault` a second derivation, which the single-derivation rule forbids. The unknown-timeframe case **REFUSES** through the script's existing exit-3 / `INDETERMINATE` contract; it does not throw. Every new self-test row is proven able to fail by deliberately breaking the logic once and recording the red.

`ops/scripts/**` is in `deploy.yml`'s `paths-ignore`, so this commit does **not** rebuild the image or recreate the container. The host copy is refreshed by an explicit `git -C /opt/crypto-quant-signal-mcp pull` and its sha256 re-verified against the **new** `origin/main`. W1's recorded `f656a38b…` is stale by design from that point.

---

## 4. Support stress-test — every registered check against the corpus support

| check | evaluation point | support / cardinality fact (probed 2026-09-09) | verdict |
|---|---|---|---|
| corrected interaction-stability check (§7 D-corr) | the family covariates' **means** over the fitted rows — every term of the centred main effect is a row-wise slope at an occupied point (AME identity) | occupied by construction. `ema = 0`: **114 rows** of 15,733; `volume = 0`: **380** — both expected to contribute ~0 decided rows and excluded **by name**, verified at pull as a cardinality | **inside** |
| the raw main effect in the interaction model (W1's named defect) | slope at `ema = volume = rsi = 0` | `ema = 0` occupies 114 rows (0.72 %); W1 measured 0 decided at that point on its own increment | **outside → replaced by the centred main effect (AME); computed for the record, not used** |
| D1 `oi` partial, CR1 inference, long band pooled | the labelled long-band decided rows, all present timeframes | drainable **5,473** clusters; projected **G ≈ 2,293** decided at W1's 41.9 % decided rate. Floors: hard **G ≥ 50**, inherited power floor **G ≥ 153**, **G ≥ 278** for 80 % at the in-sample discovery +0.1687, **G ≥ 1,013** for 80 % at W1's out-of-sample +0.0883 (§5) | **floor — G recorded before any outcome** |
| per-timeframe fits, `8h` / `12h` | each timeframe's own decided clusters | drainable clusters 8h **4,398**, 12h **4,861** → projected G ≈ 1,843 / 2,037, both above 1,013 | **floor** |
| per-timeframe fit, **`1d`** | 1d's own decided clusters | drainable clusters **498** (four venues; HL's 33 refused; PHEMEX and WEEX have zero) → projected **G ≈ 209**. Clears 153 and 278; **cannot reach 1,013**. Minimum detectable effect at G = 209 is **±0.194**, more than twice W1's out-of-sample point | **floor — a 1d NULL can never be decision-grade on this population; registered as a limit, not discovered as one** |
| presence rule / timeframe dummies | each of `{8h, 12h, 1d}` | present ⇔ **≥ 50 decided clusters** (W1's rule, unchanged). A timeframe below it is named and dropped from the pooled fit, never pooled silently | **floor** |
| marginal `perm_test` per family member | ≥ 2 powered levels at the 50-cluster floor | `oi` clusters per level **916–2,562** — all five levels above the floor in the population. `ema = 0` (114 rows) and `volume = 0` (380) structurally unresolvable, excluded **by name**. `rsi` 80 (42 rows) / 100 (10) expected below floor → INDETERMINATE by name | **floor** |
| D8(a) propensity | fitted `p̂` on all labelled long-band rows | `p̂ ∈ (0,1)` required, separation flag refused; `ema = 0` / `volume = 0` excluded by name; absent timeframe dummies dropped by name | **inside** |
| D8(b) IPW | selected rows with `p̂ ≥ 0.02` | trimmed rows counted and reported (W1: 0) | **inside** |
| D4 band `\|raw_final\| ≤ 20` / `≤ 10` | rows inside the band | **7,646 rows / 4,042 clusters** · **3,853 / 2,608**. Support is `raw_final ∈ [−66, −1]` here against W1's `[−79, −1]` — narrower, stated, and carried with any band figure | **inside** |
| the §7 comparison against W1's `{5m–4h}` estimate | two intervals on two timeframe strata of ONE frozen window | W1: +0.0883 [+0.029, +0.145], G 1,107. This wave: the long band, G recorded before any outcome. **Consistency is stated as interval OVERLAP only** | **inside — and see the refusal below** |
| a cross-arm Δ between the two strata | `Δ = β̂_long − β̂_short` | **NOT REGISTERED AND WILL NOT BE COMPUTED.** A difference between two populations is a statement about the thing under test only if the comparator moves by zero between them, which is not established here. The registered comparator for each arm is its own null | **outside → refused** |
| `funding` | level contrast | **14,866 of 15,733 rows (94.5 %) at level 0** | **outside the family — descriptive only** |
| the pre-existing-label robustness fit (§7) | the long band minus the 428 already-labelled drainable rows | 428 rows / ~160 clusters removed of 15,487 / 5,473 — ~2.8 % of rows | **inside** |

---

## 5. Floors and power — before the pull, in the independence unit

Independence unit `(venue, coin)`, as W1.

**Power model, with its instrument beside the number:** `SE(G) = SE_W1 · √(G_W1 / G)`, where **`SE_W1 = 0.030137`** is W1's **achieved out-of-sample** CR1 standard error for the `oi` partial (vault twin `D1.family.oi.partial.se_cr1`) at **`G_W1 = 1,107`** decided clusters. Two-sided α = 0.05, power 0.80, `z_{α/2} + z_β = 2.8016`.

**Why the achieved SE and not a train-derived projection:** W1 registered `SE(G) = SE_train · √(G_train/G) · κ` and then **measured it optimistic by ~32 %** — 0.0224 modelled against 0.0301 achieved — because rows-per-cluster, not cluster count alone, sets the precision. A measured baseline is meaningless without its instrument; the achieved figure is the one measured on this estimator, this corpus and this drain, so it is the anchor. No `κ` is applied on top of it.

| floor | meaning |
|---|---|
| **G ≥ 50** | the minimum for CR1 inference at all; below it nothing is tested |
| **G ≥ 153** | W1's registered power floor, **inherited unchanged** — the §7 comparison requires the same floor on both sides. Below it the verdict is `indeterminate — underpowered` |
| **G ≥ 278** | 80 % power at the in-sample discovery estimate +0.1687 |
| **G ≥ 1,013** | 80 % power at **W1's out-of-sample point +0.0883** — the size at which "the effect does not carry to the long band" becomes decision-grade against W1's own figure |
| **G ≥ 9,384** | 80 % power at W1's OOS CI lower bound +0.029. **UNREACHABLE — the drainable population holds 5,473 clusters.** Registered now so that no post-hoc reading of a wide interval can be presented as a null at that strength |
| per level: ≥ 50 clusters in the arm | the instrument's enforced `powered_levels` floor for every marginal permutation test |

**Projected, at W1's measured 41.9 % decided rate:** pooled long band **G ≈ 2,293** · 12h ≈ 2,037 · 8h ≈ 1,843 · **1d ≈ 209**. The pooled band and both large timeframes clear 1,013; **1d does not and cannot.**

**The underpowered branch resolves to a SUCCESSOR WAVE, never to a date.** `T_END` is frozen and 1d is capped at 498 drainable clusters permanently (§2), so no later date adds a row. If `G < 153` for a stratum after exhaustive reach, the registered resolver is: **`EDGE-SELL-ATTRIBUTION-LONG-TF-W{NEXT}` on a NEW frozen window with its own `SINCE`**, reported with the cluster count that stratum would need and the accrual rate that reaches it — never a date on this population.

**The achieved `G` and the achieved SE are cardinalities, recorded in the R1 audit before any outcome is read**, and the achieved SE is reported beside the modelled one exactly as W1 did.

---

## 6. Instrument — unchanged, re-asserted before the run

`src/scripts/cluster-perm-stats.py`, byte-identical on `origin/main`: `perm_test` (exact null centre), `spearman`, `bh`, `powered_levels` (enforced floor), `ols` + `cluster_robust_se` (CR1) + `cluster_bootstrap_ols`, `logistic_irls`, `ipw_weights`, `normal_sf`. Its **48 known-answer assertions must be re-run green in the executing worktree immediately before the real run** (`CLUSTER_PERM_SELFTEST=PASS`, calibration line printed with trials, B and seed); the 14-mutation proof is re-run in Plan Mode.

**`computeCellStats` and `validityVerdict` are ABSENT from this module** — the stronger claim, and the accurate one. They are TypeScript symbols in `src/scripts/directional-labeler.ts` and `src/scripts/dwr-baseline.ts`; the instrument is a Python module with zero TS imports, so they are structurally unreachable, not merely uncalled. `validityVerdict` remains struck as a banned comparator. `wilsonInterval` / `excessZP` are never test inputs. The only pooled figure printed is the pooled rate beside each cluster mean, labelled `pooled`.

Aggregation **per cluster, never pooled**; the cell reference is this population's own cluster-mean DWR, never 0.5. Permutation `B = 10,000` for the family marginals, `2,000` for secondary designs; bootstrap `B = 2,000`. **RNG seed = the literal wave id `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W2`.**

**No split.** The long band is a single out-of-sample arm. W1's `{5m–4h}` estimate is the reference, not a training set to be re-fit.

---

## 7. Designs — W1's, row-for-row, on `S_tf = {8h, 12h, 1d}`

All on the labelled long band restricted to the timeframes clearing the presence rule; `y = 1[label = +1]` on decided rows unless stated. Regressors as W1's D1: `rsi, ema, funding, oi, volume` (÷100), `funding_delta, hurst_delta, squeeze_delta` (÷100), `hurst_evaluated = 1[hurst_adjust_code ≠ 0]`, timeframe dummies (reference = the modal present timeframe, expected `12h`); a zero-variance column is dropped **by name**. Cluster `(venue, coin)`; CR1 p is the test input; cluster-bootstrap 95 % CI beside it.

| design | role | what is reported |
|---|---|---|
| **D1 main model** (partial) | verdict input | `oi` partial, CR1 p, bootstrap CI; `ema`, `volume`, `rsi` partials beside it; marginal LPM slope and marginal ρ (`perm_test`, B = 10,000, floor per level) on the same rows |
| **D-corr — corrected interaction check** | verdict input | interaction model with centred family covariates + the six pairwise products; centred main effect (≡ AME) per member; the identity `AME = β_i + Σ_j β_ij·x̄_j` verified numerically; `stable(i)` |
| **D8(a) propensity** | input to (b) | logistic `P(decided \| X)` on all labelled long-band rows, `ema = 0` and `volume = 0` excluded by name; min/max `p̂`, separation flag, coefficients |
| **D8(b) IPW re-fit** | verdict input | stabilised `P(S)/p̂`, rows with `p̂ < 0.02` reported and excluded; `oi` partial, p, CI |
| **D8(c) all-labelled outcome** | tie-break only | `y' = 1[label = +1]` over all labelled long-band rows (timeout = not a win); partial + marginal ρ |
| **D-tf — per-timeframe fits** | reported beside the pooled | the same D1 on each of 8h, 12h, 1d separately, each with its own `G`; a stratum below the presence floor is named and dropped, never pooled silently |
| **D-excl — pre-existing-label robustness** | registered robustness | D1 re-fit with the **428 drainable rows already labelled before this registration landed** removed; the `oi` partial and CI beside the main fit. Registered because those rows are the OLDEST per cell and were selected by a different reach rule |
| **D4 band** `\|raw_final\| ≤ 20` | report only | partial + marginals; `≤ 10` marginals only. Support `[−66, −1]` stated with every figure |
| **Comparison against W1's `{5m–4h}`** | reported with the verdict | W1's OOS `oi` partial **+0.0883 [+0.029, +0.145]** (G 1,107) printed beside this wave's long-band partial and CI. **Consistency is stated as interval overlap.** A cross-arm Δ is refused (§4) |
| **Shrinkage** | reported with the verdict | the long-band partial against **both** W1's out-of-sample +0.0883 **and** the in-sample discovery +0.1687 / +0.2397; both ratios given |

`ema` is **reported in every row and not re-adjudicated** — its state `indeterminate — failure to replicate` stands whatever this band shows. `rsi` (not-attributable, collider) and `volume` (indeterminate, resolution) are reported descriptively only, never re-opened. `funding` stays outside the family (94.5 % at level 0). **`{5m–4h}` is not re-adjudicated**: W1's verdict stands, and the 4h rows labelled since W1's pull are not folded into it.

**Post-result respecification test (procedure §7):** no design here is a correction proposed after seeing a result on this population — every one is W1's, applied unchanged to a stratum W1 declared absent. Nothing may be added after the pull; a hypothesis this band suggests is registered for a successor.

---

## 8. Decision rule — three states, evaluated in this order, expected sign `+`

Let `β̂`, `p`, `CI` be the pooled long-band D1 `oi` partial, its CR1 p and bootstrap 95 % CI; `AME_c` the centred main effect and `CI_main` the long-band main model's CI; `β̂_w`, `p_w` from D8(b); `β̂_all`, `p_all` from D8(c); `G` the decided clusters on `S_tf`; **`LB_oos = +0.029`**, the lower bound of W1's out-of-sample CI — the reference this wave is registered against (**not** the in-sample bound W1 used).

1. **`indeterminate — underpowered`** ⇔ `G < 153`. Report `G`, the cluster count that would reach the floor, and the **successor wave on a new frozen window** that resolves it (§5). Never a date.
2. **`not-attributable — cause: sign reversal on the long band`** ⇔ `β̂ < 0 ∧ p < 0.05`.
3. **`attributable`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ `AME_c > 0 ∧ AME_c ∈ CI_main` ∧ `β̂_w > 0 ∧ p_w < 0.05` ∧ not (`β̂_all < 0 ∧ p_all < 0.05`).
4. **`not-attributable — cause: resolution`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ ¬(`β̂_w > 0 ∧ p_w < 0.05`).
5. **`indeterminate — cause: resolution not closable from X`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ IPW survives ∧ `β̂_all < 0 ∧ p_all < 0.05`.
6. **`not-attributable — cause: interaction-carried, not a main effect`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ IPW survives ∧ ¬(`AME_c > 0 ∧ AME_c ∈ CI_main`).
7. **`not-attributable — cause: the effect is band-specific and does not carry to 8h/12h/1d`** ⇔ `p ≥ 0.05` ∧ `G ≥ 1,013` ∧ `CI_hi < LB_oos`. **This is the only decision-grade null**, and it requires the 1,013 floor, not the 153 one.
8. **`indeterminate — inconclusive`** ⇔ `p ≥ 0.05` and `CI` covers both 0 and `LB_oos`. Report the `G` at which the interval would separate them, and — because this population cannot grow — the successor window that supplies it.

**Per-timeframe verdicts** follow the same ladder on each stratum's own `G`, and inherit the §4 limit: **a `1d` result can reach state 3 but never states 7 or 8's decision-grade form**, because `G_1d ≈ 209` cannot reach 1,013. A 1d non-significant result is `indeterminate — underpowered for a null`, stated as such.

**Expected under each:** `attributable` → `+`, plausibly attenuated further than W1's own 0.52× shrinkage; `sign reversal` → `−`; a decision-grade null → `≈ 0` with an interval below +0.029.

**Wave verdict, one line:** `oi`'s state on the long band with its out-of-sample estimate and CI (or the cause, and what resolves it), the per-timeframe states, and `ema`'s unchanged state.

No hypothesis may be added after seeing data.

---

## 9. What `EDGE-SCORING-LADDER-REDESIGN-W2` may consume — superseding W1 §9 by name

On `attributable`, W1 §9's clause **"anything for 8h, 12h or 1d (unmeasured out-of-sample)"** is **superseded by name** and replaced with this wave's measured terms: the set, the sign, the **out-of-sample magnitude and interval**, and the **exact timeframe support** the verdict earned — never a stratum that returned INDETERMINATE.

Everything else in W1 §9 stands unchanged, in particular: **a partial coefficient is not a weight** — it is a conditional-mean slope on a truncated support (`raw_final ∈ [−66, −1]` on this band). The discovery figures, any level DWR, any figure from an INDETERMINATE cell or an absent timeframe, and anything from D4 as a magnitude remain unconsumable. On any verdict other than `attributable`, the long band yields nothing and W1 §9's exclusion **stands as written**, now measured rather than assumed.

W1 §9's `{5m–4h}` terms are untouched by this wave.

---

## 10. Selection effects and limits — stated before results

1. One regime slice, ~35 h of decisions post-`TREND_MODE`-flip, the manufactured SELL-first side mix; nothing generalises to the fleet.
2. The drain cannot reach `HL` or `WEEX` (246 rows / 90 clusters of this band) — a refusal in `resolve_venues`, reported with two denominators, never modelled as random.
3. **1d rests on four venues** (BITGET, BYBIT, OKX, BINANCE) and 498 clusters that cannot grow. Any 1d figure is a four-venue figure and is labelled as one.
4. The 428 pre-existing labels were selected oldest-first per cell by a different reach rule; they are included and D-excl measures what they are worth.
5. `--per-cell 1` yields ~1 decided row per cluster against W1's 3.33. Cluster count alone therefore overstates the information relative to W1's arm; achieved SE is reported beside modelled SE and the comparison in §7 is between intervals, never between point estimates.
6. Barrier windows are closed by `EVAL_CANDLES × timeframe` (`windowClosed`, 8h 32 h · 12h 48 h · 1d 72 h) — a different derivation from `maturityHorizonMs`'s `(EVAL_CANDLES + 1) × timeframe`, which governs the `signals` PFE lane and not this corpus. The ±1-candle difference is inherited from the committed instrument and is not adjudicated here.

---

## 11. Deviations from the dispatching spec — recorded, never absorbed

Four defects in `Prompt/EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W2.md`, all found in Plan Mode, all architect-ruled 2026-09-09:

| # | spec text | measured reality | disposition |
|---|---|---|---|
| 1 | *"those are precisely the timeframes that carry emission — 8h 5.660 % · 12h 6.429 % · 1d 5.556 % against 0.000–4.087 %"* | quoted correctly from a **pre-`TREND_MODE`-flip** audit. Post-flip, 4h 16.396 % and 1h 14.664 % exceed every long timeframe (§0) | motivation **superseded** by §0's 9.4 %-of-SELL-volume statement; the pre-flip figures appear nowhere else |
| 2 | AC1 — *"Registration landed before the first label of the new population"* | **unsatisfiable**: 434 labels of the population already existed, written by the nightly cron from 2026-09-05 20:44 | read as procedure §1 does — before the first **outcome query**; the 434 disclosed in §1 as cardinality, included, with D-excl as robustness |
| 3 | R1 — *"`--side sell --require-parts`"* passed to the drain | both flags are **hardcoded** in `hold-decision-drain.sh`'s two `docker exec` lines; nothing to pass | dropped from the method; the script has no `--timeframe` either, which §3.1 adds |
| 4 | R2 — *"`computeCellStats` and `validityVerdict` stay uncalled"* | neither symbol **exists** in `cluster-perm-stats.py`; both are TypeScript symbols in other modules | asserted as **absence** (§6), a stronger claim than "uncalled" |

Additionally recorded: the spec's *"GENERATOR-LEVEL FIX"* pillar is **N/A for this wave** — the generator half is owned by `EDGE-LABELER-BREADTH-ORDERING-W{NEXT}` (§3, ruling (c)), and this wave achieves complete reach at the call site instead.

Any further deviation encountered during execution is recorded here as a deviation with its reason, never absorbed.
