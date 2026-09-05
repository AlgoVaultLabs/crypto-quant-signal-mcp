# SELL attribution — CENTERED CHECK on data nobody has seen — PRE-REGISTRATION

**Wave:** `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1` R0 · **Recorded:** `2026-09-05T18:17:24Z` (live `date -u`)
**Authority:** architect ruling 2026-09-05 (GO on Plan-Mode Q1–Q5: Q1=A, Q2=A, Q3=A with a mandatory addition, Q4=A, Q5=C).
**Predecessor:** `EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1` — pre-registration `audits/sell-attribution-collider-control-preregistration-2026-09-05.md` @ `a42aca1c`; instrument `src/scripts/cluster-perm-stats.py` @ `820af00b` (unchanged by this wave).
**Procedure:** `audits/PREREGISTRATION-PROCEDURE.md` — this file is its first inheritor; §8 below is the section that procedure makes mandatory.
**Binding on:** the one authorised labelling write (§3), every R1 run, the R2 verdict, and what `EDGE-SCORING-LADDER-REDESIGN-W2` may consume (§10).

This file is **methodology only**. It carries **no outcome figure**: no coefficient, p-value, DWR, ρ or label sign, from this corpus or the predecessor's. Every number below is a cardinality, a coverage ratio, a schema fact or a clock. Figures live in the private vault (JSON twin beside the R1 audit). Third-consumer terms hold: nothing here may be cited for or against the HOLD-discipline hypothesis; nothing reaches public copy, a track-record surface, an MCP response or the Merkle path.

---

## 0. Ordering, and the disclosures this file owes

**RULE (inherited, now written down in the procedure §1):** cardinalities may be probed before this file lands; outcome statistics may not. This file lands **before a single label of the registered population exists** — the population had **0 labelled rows** at `T_END` (§2, P1) — which is the strongest pre-registration available: the outcomes it will be judged on have not been computed by anything.

**PRIOR-EXAMINATION DISCLOSURE.**

| seen | what | class |
|---|---|---|
| the predecessor's published in-sample figures for `oi`, `ema`, `volume`, `rsi` — partials, IPW, all-labelled, band, the raw main effect and **the corrected in-sample value (the average marginal effect of `oi` in the interaction model)** | read from the vault JSON twin `audits/EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1-results-2026-09-05.json` (`_sensitivities_labelled_non_verdict.ame_sensitivity_UNREGISTERED.oi`) and re-derived against it in Plan Mode | **SEEN, DISCLOSED, NOT A TEST INPUT.** The verdict rests solely on the fresh increment. Precedent: `audits/hold-decision-preregistration-2026-08-26.md` §12 |
| the predecessor's corpus A, re-pulled by its exact predicate (`computed_at ≤ 2026-09-05T03:39:44Z`) | 17,113 rows, byte-identical to the predecessor's file (sha256 `271e25bd…`, recorded in the twin) | held ONLY for the mandatory timeframe-matched in-sample comparison (§4); no statistic computed from it at recording |
| the registered population's cardinalities | §2 tables P1–P7, probed at `T_END` | cardinality |
| the drain's dry-run reach | §3, per venue | cardinality (coverage instrument) |
| labelled rows decided after the bound, at 2026-09-05 11:12Z and 18:07Z | **0** and **0**; 90 rows labelled since the predecessor's pull are all pre-bound | cardinality |

No DWR, win rate, ρ, p, coefficient or label sign of any row outside the predecessor's published record has been computed or read. The corrected in-sample value is reported in the vault for completeness and is excluded from every decision below.

**The correction is not a rescue.** Would the centred check have been proposed had the raw check passed? No. A corrected check applied to the corpus that failed it is therefore a forking path however sound the statistics (procedure §7); the correction is registered here and applied to data nobody has seen.

---

## 1. The defect, and the corrected check — a cardinality fact, not a judgement

The predecessor's registered interaction-stability check compared each family member's **raw main effect** in the interaction model with the main model's cluster-bootstrap CI. In a model with pairwise products the raw main effect of `oi` is its slope **at the other interactors' zero** — `ema = volume = rsi = 0`.

**`ema` never takes 0 among DECIDED rows**: 0 of the predecessor's 8,310 decided rows; the 84 labelled `ema = 0` rows are **all timeouts** — selected out by differential resolution, which ties the defect to the predecessor's D8 mechanism rather than to coincidence. `volume = 0` likewise: 270 labelled, 0 decided. In this wave's registered population, `ema = 0` carries 201 of 97,266 rows and `volume = 0` 643 (§2, P5); whatever decides, the check's point is expected unoccupied among decided rows and is verified as a cardinality at pull time. The check therefore measured an extrapolation — **undefined, not failed**.

**The corrected check, literally.** Fit the interaction model with the four family covariates (`oi`, `ema`, `volume`, `rsi`, bucket levels ÷ 100) **centred at their means over the rows being fitted**. In a linear-in-parameters model with pairwise products the centred main effect of `i` equals `β_i + Σ_j β_ij·x̄_j`, which is exactly the **average marginal effect** — every term of which is a row-wise slope at an occupied point. Interaction coefficients are unchanged by centring; the main model (no products) is unchanged except for its intercept.

`stable(i)` ⇔ the centred main effect of `i` has the same sign as the main model's partial of `i` on the same rows **and** lies inside that main model's cluster-bootstrap 95 % CI.

The committed instrument needs no change: centring is done by the session-local driver on its design matrix; `src/scripts/cluster-perm-stats.py` stays at `820af00b`.

---

## 2. The fresh increment — a literal predicate, closed by a clock

**Frozen bound.** The predecessor's corpus A reconstructs exactly at `hold_decision_labels.computed_at ≤ '2026-09-05T03:39:44Z'` (its pull instant): 17,113 labelled · 8,310 decided · max `decision_id` 4,034,538 · `decided_at` ∈ [2026-08-31 10:34:35Z, **2026-09-04 07:12:20Z**]. **BOUND := `hold_decisions.decided_at = 1788505940`.**

**T_END := `1788631878` (2026-09-05T18:11:18Z)** — fixed by the host clock at this file's write time, before it lands and before any label of the population exists. The population is closed by this clock, never by what the labeller reaches (architect Q2). **Rows the drain labels beyond `T_END` are excluded from this wave, stay unseen, and belong to a successor — they are not available to this wave under any reading.**

**Predicate (increment), literal SQL:**
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
   AND h.decided_at >  1788505940          -- strictly after the predecessor's bound
   AND h.decided_at <= 1788631878;         -- T_END, fixed here
```
Same corpus predicate as the predecessor's (A) otherwise; timeouts (`label = 0`) kept for D8. The **decided** increment is `label <> 0`. The emitted arm (`signal_scorer_inputs`) and the withheld BUY arm are **not read** — none of the four registered designs needs them.

**The registered population at `T_END` (cardinalities; P1–P7 probed 2026-09-05T18:11Z, host clock):**

| | value |
|---|---|
| rows / clusters `(venue, coin)` / venues | **97,266 / 6,933 / 15** · fleet 93,308 · request 3,958 · `book_liveness` 172 · **already labelled: 0** |
| by timeframe — rows / clusters / window closed at `T_END` | 1h 23,864 / 6,149 / 20,027 · 2h 17,178 / 5,995 / 11,984 · 4h 13,291 / 5,641 / 2,621 · 15m 10,381 / 1,292 / 10,005 · 30m 8,361 / 1,237 / 7,847 · **12h 8,288 / 4,910 / 0** · **8h 6,912 / 4,482 / 205** · 5m 5,321 / 475 / 5,279 · 3m 3,137 / 212 / 3,132 · **1d 533 / 531 / 0**. Every window is closed by `T_END + 72h` (2026-09-08T18:11:18Z) |
| by venue — rows / clusters | GATE 13,734/947 · MEXC 12,169/1,041 · XT 8,630/847 · BINGX 8,588/973 · KUCOIN 8,281/653 · BINANCE 8,147/250 · ASTER 7,050/495 · BITGET 6,703/354 · HTX 5,113/315 · BYBIT 4,348/291 · WHITEBIT 4,243/359 · OKX 3,859/216 · **HL 2,620/68 · WEEX 1,281/35** (unreachable by the drain — named, §3) · PHEMEX 2,500/89 |
| `oi` level — rows / clusters | −60 24,366/3,060 · −20 29,922/4,645 · 0 10,667/1,366 · +20 22,009/4,686 · +60 10,302/2,964 |
| `ema` / `volume` / `rsi` / `funding` levels — rows | ema −100 60,631 · **0 201** · +100 36,434 · volume −70 57,547 · −30 28,412 · **0 643** · 10 8,449 · 50 1,333 · 80 529 · 100 353 · rsi −100 2,591 · −80 3,687 · −40 15,446 · 0 65,733 · 40 9,437 · 80 269 · 100 103 · funding 0 **91,034 (93.6 %)** · 40 6,119 · −40 48 · −80 35 · 80 30 |
| bands / identity / hurst / regime | `\|raw_final\| ≤ 20`: 45,579 rows / 6,686 clusters · `≤ 10`: 23,719 / 6,006 · `raw0 ≥ 0`: 2,733 · `raw0 + Δf + Δh + Δs = raw_final` violations at 1e-9: **0** · `hurst_adjust_code ≠ 0`: 36,030 (37.0 %) · `raw_final` ∈ [−79, −1] · TRENDING_DOWN 38,020 · TRENDING_UP 30,990 · RANGING 28,256 |

The window is ~35 h of decisions (2026-09-04 07:12Z → 09-05 18:11Z), one regime slice; nothing generalises to the fleet.

---

## 3. The one authorised write — the bounded SELL-only drain, and its coverage

Capture is not the bottleneck (50–82k SELL-with-parts decisions/day); labelling is: the nightly labeler's budget is 4,000 decisions/night across both sides and 15 venues, oldest-first per cell. **Authorised (architect Q1=A): exactly one run of `ops/scripts/hold-decision-drain.sh` with `HOLD_DRAIN_SINCE_EPOCH=1788505941`** (host file == `origin/main` sha256 `f656a38b…`): `--side sell --require-parts`, `PER_CELL 3`, `MAX_PER_VENUE 1500`, `TIME_PER_VENUE_MIN 12`, the script's declared 13 venues (HL and WEEX excluded by its own list), inside the deploy-free window (18:00–02:59Z), **after this file has landed and after that landing's deploy has completed**. Labelling cannot see an outcome before computing it, so the write cannot select on outcomes; it can and does shape the **population reached**, which is why coverage is reported with two denominators.

**Riders, binding:**
- **(a) Coverage.** Report per venue: population rows / clusters in (BOUND, T_END] (P3) · rows the drain reached · clusters reached · the fraction of each. Report which cells the reach rule touched: the labeler's work-list is `ROW_NUMBER() OVER (PARTITION BY exchange, coin, timeframe ORDER BY decided_at ASC) ≤ 3`, then `ORDER BY exchange, coin, timeframe, decided_at LIMIT max-decisions` — so within a venue the cap reaches coins in **alphabetical order**, and rows whose window is not closed at run time are skipped by name (`unclosed_skipped`). Drops are reported, never filled.
- **(b) Resumability, asserted before starting.** Every label is written `INSERT … ON CONFLICT (hold_decision_id, barrier_spec) DO NOTHING` under the table's primary key, in chunks at the end of a leg; the work-list is `NOT EXISTS (label for this spec)`; a leg killed by a container recreation (measured `exit 137` on 2026-09-04 07:2xZ and `container … not running` on 2026-09-05 03:41Z) loses only its unflushed buffer and leaves no partial or duplicate state — the rows stay eligible and a re-run resumes from DB state. `backfill-hold-decision-labels` is classified `safe-to-kill` in `ops/scripts/cron-interlock-registry.json`, so a deploy neither waits for it nor preempts it: the protection is scheduling, not the interlock.
- **(c) Deploy window.** Before launch: no deploy in flight (`gh run list --workflow deploy.yml`), the three containers up, `date -u` inside the deploy-free window, no other `hold-decision` process running; this session lands nothing while a leg runs, and the run must finish before the 03:41Z nightly.

**Dry-run reach at 2026-09-05 18:08Z** (`--dry-run`, nothing written; `decisions` = candidate rows admitted under the caps whose window had closed, `unclosed` = admitted but not yet closed): HTX 941 (559 unclosed) · GATE 773 (727) · WHITEBIT 899 (601) · BYBIT 894 (606) · BITGET 780 (720) · BINANCE 810 (690) · BINGX 822 (678) · ASTER 830 (670) · KUCOIN 867 (633) · PHEMEX 958 (287) · OKX 936 (564) · XT 725 (775) · MEXC 838 (662) — **≈ 11,070 candidate decisions across 13 venues**, all inside the population by construction of `SINCE`.

---

## 4. Timeframe censoring — the mandatory comparison and its registered escalation

The labeler labels a row only after its full barrier window has closed (`EVAL_CANDLES × timeframe`: 8h 32 h, 12h 48 h, 1d 72 h), so there is **no outcome-time censoring within a timeframe**; long timeframes are simply absent or thin at an early pull (P2: 12h and 1d have zero closed windows at `T_END`, 8h has 205 rows). The predecessor's decided corpus carried **2,039 of 8,310 (24.5 %)** in 8h+. Dummies absorb composition, not interaction, and timeframe heterogeneity has been measured elsewhere in this corpus — so a short-only replication compared with a pooled in-sample estimate would be a population mismatch (architect Q3).

**Presence rule (registered):** a timeframe is *present in the increment* iff it carries **≥ 50 decided clusters** in the labelled increment (the instrument's floor predicate, applied to timeframes). Timeframes below it are **named and dropped explicitly** from the increment analysis and from the restricted in-sample fit, so both populations share one timeframe set `S_tf`.

**Mandatory comparison (before the pull of outcomes, after the drain):** refit the predecessor's D1 main model on **its own** train rows (corpus A, re-pulled byte-identical, §0) **restricted to `S_tf`**, and report the `oi` partial beside the pooled in-sample partial — both are in-sample, seen figures, vault-only.

**Materiality (registered now):** the difference is *material* iff the restricted in-sample `oi` partial lies **outside the pooled train model's cluster-bootstrap 95 % CI** (vault twin `D1.family.oi.partial_train.ci95_boot`) **or differs in sign**. If material, heterogeneity is real: **the pull WAITS until `T_END + 72h` = 2026-09-08T18:11:18Z**, a second bounded drain pass with the same `SINCE` and caps labels the long-timeframe rows whose windows closed meanwhile, `S_tf` is re-evaluated, and only then is the increment pulled. Rejected alternative: a fixed-multiple-of-SE criterion — the two fits share rows, so their difference has no clean sampling distribution; the CI test is simple, registered, and errs toward waiting.

Absent timeframes are a **limit** carried with the verdict, never a silent drop. The estimand is conditional on timeframe throughout.

---

## 5. Floor and power — stated before any pull, in the independence unit

Independence unit `(venue, coin)`. Power model (instrument beside the number): `SE(G) = SE_train · √(G_train / G) · κ`, where `SE_train` is the predecessor's train CR1 standard error for the `oi` partial (vault twin `D1.family.oi.partial_train.se_cr1`), `G_train = 786` decided train clusters, and `κ = 1.062` is the inflation that reconciles the cluster-scaled prediction with the predecessor's measured holdout SE (`G = 342`). Two-sided α = 0.05 with the same-sign requirement.

| floor | meaning |
|---|---|
| **G ≥ 153 decided clusters** (~1,130 decided rows at the predecessor's rows-per-cluster) | 80 % power at the predecessor's in-sample `oi` partial — **the registered power floor**; below it the verdict is `indeterminate — underpowered` |
| G ≥ 170 | 80 % power at the in-sample corrected value (AME) |
| G ≥ 301 | 80 % power at the in-sample CI lower bound — the size at which a null becomes decision-grade |
| per level: ≥ 50 clusters in the arm | the instrument's enforced `powered_levels` floor for every marginal permutation test |
| G ≥ 50 | the minimum for CR1 inference at all; below it nothing is tested |

At the 50-cluster floor power is 0.36; at G = 500 it is > 0.99 at the in-sample partial and 0.95 at the CI lower bound. The population holds 6,933 clusters and the drain's dry-run admits ≈ 11,070 candidate decisions, so the floor is expected to clear by a wide margin; **the achieved G is a cardinality, recorded in the R1 audit before any outcome is read.** If G < 153 the wave reports the size and the date at which the nightly (≤ 4,000 decisions/night, both sides, oldest-first) or a successor's drain would reach it.

---

## 6. Instrument — unchanged, re-asserted before the run

`src/scripts/cluster-perm-stats.py` @ `820af00b`, pure, byte-identical on `origin/main`: `perm_test` (exact null centre), `spearman`, `bh`, `powered_levels` (enforced floor), `ols` + `cluster_robust_se` (CR1) + `cluster_bootstrap_ols`, `logistic_irls`, `ipw_weights`, `normal_sf`. Its 48 known-answer assertions **must be re-run green in the executing worktree immediately before the real run** (`CLUSTER_PERM_SELFTEST=PASS`, calibration line printed with trials, B and seed); the 14-mutation proof was re-run in Plan Mode (14 caught / 0 missed). `computeCellStats` and `validityVerdict` are uncalled by construction (Python module, zero TS imports; `validityVerdict` struck — banned comparator); `wilsonInterval` / `excessZP` are never test inputs; the only pooled figure printed is the pooled rate beside each cluster mean, labelled `pooled`. Aggregation per cluster, never pooled; the cell reference is the increment's own cluster-mean DWR, never 0.5. Permutation B = 10,000 for the family marginals, 2,000 for secondary designs; bootstrap B = 2,000. RNG seed = the literal wave id `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W1`.

**No split.** The increment is a **single out-of-sample arm**: the predecessor's corpus is the training set, the increment is the holdout (architect Q4). Splitting a holdout spends power for nothing.

---

## 7. Designs — the corrected check and the four registered designs, row-for-row with the predecessor

All on the labelled increment restricted to `S_tf`; `y = 1[label = +1]` on decided rows unless stated. Regressors as the predecessor's D1: `rsi, ema, funding, oi, volume` (÷100), `funding_delta, hurst_delta, squeeze_delta` (÷100), `hurst_evaluated = 1[hurst_adjust_code ≠ 0]`, timeframe dummies (reference = the modal present timeframe); a zero-variance column in this arm is dropped **by name**, never silently. Cluster `(venue, coin)`; CR1 p is the test input; cluster-bootstrap 95 % CI beside it.

| design | role | what is reported |
|---|---|---|
| **D1 main model** (partial) | verdict input | `oi` partial, CR1 p, bootstrap CI; `ema`, `volume`, `rsi` partials beside it; marginal LPM slope and marginal ρ (`perm_test`, B = 10,000, floor per level) on the same rows |
| **Corrected interaction check** (§1) | verdict input | interaction model with centred family covariates + the six pairwise products; centred main effect (≡ AME) per member; `stable(i)` |
| **D8(a) propensity** | input to (b) | logistic `P(decided \| X)` on all labelled increment rows, `ema = 0` and `volume = 0` rows excluded by name; min/max p̂, separation flag, coefficients |
| **D8(b) IPW re-fit** | verdict input | stabilised `P(S)/p̂`, rows with p̂ < 0.02 reported and excluded; `oi` partial, p, CI |
| **D8(c) all-labelled outcome** | tie-break only | `y' = 1[label = +1]` over all labelled increment rows (timeout = not a win); partial + marginal ρ |
| **D4 band** `\|raw_final\| ≤ 20` | report only | partial + marginals; `≤ 10` marginals only — as in the predecessor (its `≤ 20` was the tightest band with a fitted partial) |
| **Timeframe-matched in-sample** (§4) | comparator | predecessor train and holdout `oi` partial on `S_tf`, beside the pooled ones |
| **Shrinkage** (architect Q4) | reported with the verdict | out-of-sample `oi` partial and CI beside the in-sample discovery estimates (pooled train / holdout, and timeframe-matched); the ratio. Attenuation is expected, not disqualifying |

`ema` is **reported in every row and not re-adjudicated**: its predecessor state, `indeterminate — failure to replicate` (train significant, holdout not), stands whatever the increment shows; this wave registers no rule for it. `rsi` (not-attributable, collider) and `volume` (resolution) are reported descriptively only, never re-opened. `funding` stays outside the family (93.6 % at level 0 — untestable by coverage).

---

## 8. Support stress-test — every registered check against the corpus support

| check | evaluation point | support / cardinality fact (probed) | verdict |
|---|---|---|---|
| corrected interaction-stability check (§1) | the family covariates' **means** over the fitted rows — every term of the centred main effect is a row-wise slope at an occupied point (AME identity) | occupied by construction; `ema` takes {−100, +100} among decided rows (predecessor 0 / 8,310 at 0); population `ema = 0`: 201 rows, expected 0 decided — verified at pull as a cardinality | **inside** |
| the predecessor's raw main effect (the defect) | slope at `ema = volume = rsi = 0` | `ema = 0`: 0 decided (84 labelled, all timeouts); `volume = 0`: 0 decided (270 labelled) | **outside → replaced by the row above; not used** |
| D1 partial, CR1 inference | the increment's decided rows, all present timeframes | population 6,933 clusters; dry-run reach ≈ 11,070 candidate decisions over 13 venues; **power floor G ≥ 153 decided clusters** (§5), hard floor G ≥ 50 | **floor — G recorded before any outcome** |
| timeframe dummies / presence rule (§4) | each timeframe present in the increment | present ⇔ ≥ 50 decided clusters; population clusters per timeframe 212 (3m) … 6,149 (1h); at `T_END` 12h and 1d have **0** closed windows, 8h 205 rows — expected absent/below floor at the first pull, **named and dropped** | **floor** |
| marginal `perm_test` per family member | ≥ 2 powered levels at the 50-cluster floor, per arm | `oi` population clusters per level 1,366–4,686; `ema 0` (201 rows) and `volume 0` (643) structurally unresolvable — excluded **by name** | **floor** |
| D8(a) propensity | fitted p̂ on all labelled rows | p̂ ∈ (0, 1) required, separation flag refused; `ema = 0` / `volume = 0` rows excluded by name; timeframe dummies drop absent levels by name | **inside** |
| D8(b) IPW | selected rows with p̂ ≥ 0.02 | trimmed rows counted and reported (predecessor: 0) | **inside** |
| D4 band `\|raw_final\| ≤ 20` / `≤ 10` | rows inside the band | population 45,579 rows / 6,686 clusters · 23,719 / 6,006 | **inside** |
| timeframe-matched in-sample comparison (§4) | predecessor train rows on `S_tf` | predecessor decided rows per timeframe 4h 1,658 · 2h 1,595 · 1h 1,532 · 8h 1,054 · 12h 875 · 15m 659 · 30m 539 · 5m 197 · 1d 110 · 3m 91; the same 50-cluster presence rule applied both sides | **floor** |
| the null clause (§9) | the increment CI vs the in-sample CI lower bound | decision-grade only at G ≥ 153 (80 % power at the in-sample partial); G ≥ 301 for 80 % at the lower bound | **floor** |
| `funding` | level contrast | 91,034 of 97,266 rows (93.6 %) at level 0 | **outside the family — descriptive only** |

---

## 9. Decision rule — three states, evaluated in this order, expected sign `+`

Let `β̂`, `p`, `CI` be the increment D1 `oi` partial, its CR1 p and bootstrap 95 % CI; `AME_c` the centred main effect and `CI_main` the increment main model's CI (§1); `β̂_w`, `p_w` from D8(b); `β̂_all`, `p_all` from D8(c); `G` the decided clusters in the increment on `S_tf`; `LB` the predecessor's train CI lower bound for `oi` (vault twin `D1.family.oi.partial_train.ci95_boot[0]`).

1. **`indeterminate — underpowered`** ⇔ `G < 153`. Report `G`, and the size/date that resolves it.
2. **`not-attributable — cause: sign reversal`** ⇔ `β̂ < 0 ∧ p < 0.05` (the in-sample effect was regime- or selection-specific).
3. **`attributable`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ `AME_c > 0 ∧ AME_c ∈ CI_main` ∧ `β̂_w > 0 ∧ p_w < 0.05` ∧ not (`β̂_all < 0 ∧ p_all < 0.05`).
4. **`not-attributable — cause: resolution`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ ¬(`β̂_w > 0 ∧ p_w < 0.05`).
5. **`indeterminate — cause: resolution not closable from X`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ IPW survives ∧ `β̂_all < 0 ∧ p_all < 0.05` ((b) and (c) disagree).
6. **`not-attributable — cause: interaction-carried, not a main effect`** ⇔ `β̂ > 0 ∧ p < 0.05` ∧ IPW survives ∧ ¬(`AME_c > 0 ∧ AME_c ∈ CI_main`).
7. **`not-attributable — cause: does not replicate out-of-sample`** ⇔ `p ≥ 0.05` ∧ `G ≥ 153` ∧ `CI_hi < LB` (the interval excludes the in-sample estimate's own lower bound — a decision-grade null).
8. **`indeterminate — inconclusive`** ⇔ `p ≥ 0.05` and `CI` covers both 0 and `LB`; report the `G` at which the interval would separate them and the date the data supports it.

**Expected under each:** `attributable` → `+`, attenuated relative to the discovery estimate (shrinkage reported, §7); `sign reversal` → `−`; a decision-grade null → `≈ 0` with a tight interval. **`ema`** is reported beside every row with its predecessor state unchanged. **Wave verdict, one line:** `oi`'s state with its out-of-sample estimate and CI (or the cause / what resolves it and when), then `ema`'s unchanged state.

No hypothesis may be added after seeing data; one the increment suggests is registered for a successor.

---

## 10. What `EDGE-SCORING-LADDER-REDESIGN-W2` may consume — only on `attributable`

The **set** of attributable indicators, the **sign** of each partial, the **ordering** of support-local magnitudes, and — new to this wave — the **out-of-sample magnitude and its interval as the usable figure**: the in-sample discovery estimate is biased upward by selection and may not be consumed. It may **not** consume any partial coefficient as a weight (a partial is a conditional-mean slope on a truncated support, not a ladder weight), any level DWR, any figure from an INDETERMINATE cell or an absent timeframe, or anything from D4 as a magnitude. On any other verdict it consumes nothing and stays blocked.

---

## 11. Selection effects and limits — stated before results

1. One regime slice, ~35 h of decisions post-`TREND_MODE`-flip; the manufactured SELL-first side mix; nothing generalises to the fleet.
2. The drain reaches the population **alphabetically by coin within each venue** up to its cap, skips unclosed windows, and cannot reach HL or WEEX (3,901 rows / 103 clusters) — an X-side selection on cluster identity and time, reported with two denominators, never modelled as random.
3. Long timeframes are absent or thin at the first pull (§4); the estimand is conditional on timeframe, and the timeframe-matched in-sample comparison is what makes the replication a like-for-like one.
4. `hurst_delta` is venue-confounded; its coefficient is not a finding. `funding` is untestable by coverage.
5. D8 closes resolution only to the extent it depends on X; rule 5 above is the honest outcome when it does not.
6. Third-consumer terms hold; figures vault-only; no scoring, ladder, weight, threshold or `MAX_RAW_SCORE` change; this wave measures.

## 12. Deviations

A deviation from this file is recorded here as a deviation, with its reason, and is never silently absorbed. None at recording.
