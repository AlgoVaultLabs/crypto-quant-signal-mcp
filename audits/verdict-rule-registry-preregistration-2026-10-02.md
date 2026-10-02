# SIGNAL-VERDICT-RULE-REGISTRY-W1 — pre-registration: per-timeframe verdict-rule assignment chosen by forward evidence (cycle 1: trend mode)

**Write-time clock (live `date -u`):** first written `2026-10-02T15:31:03Z` (epoch `1790955063`).
**Owner:** `SIGNAL-VERDICT-RULE-REGISTRY-W1` CH1 · **Procedure:** `audits/PREREGISTRATION-PROCEDURE.md` · **Gate:** `tests/unit/preregistration-support-stress-test.test.ts`
· **Executor:** `ops/monitoring/verdict-rule-gate.py` (CH3). Its query, parameters and decision map must equal this file; CH3 pins that with a test.
· **Rulings:** architect Q1–Q6 (2026-10-01) and the Plan-Mode rulings Q1–Q5 (2026-10-02), both recorded in the private spec.

**This file carries methodology, identifiers and declared parameters only.** It holds no count, rate or outcome figure, because the code repo is public. Every figure it names is valued in the private vault: the Plan-Mode endpoint truth `audits/SIGNAL-VERDICT-RULE-REGISTRY-W1-endpoint-truth.md` and the trend-mode readout entry of 2026-09-30 in `status.md`.

---

## 0. What is decided, and by what

- **Decision unit: the TIMEFRAME** (ruling Q1, 2026-10-02). The 10 live timeframes are 3m · 5m · 15m · 30m · 1h · 2h · 4h · 8h · 12h · 1d.
- **Cells** are (timeframe × regime) for regime ∈ {`TRENDING_UP`, `TRENDING_DOWN`}. Regime comes from `classifyRegimeLabel` under `regime_rule_version = 3` — the exact condition the RSI negation reads in the verdict path (`src/tools/get-trade-call.ts`, `computeIndicatorScores`).
  - A cell is never keyed on the emitted side.
  - The cell key is captured as `signal_scorer_inputs.(timeframe, regime)`: the same local that `recordSignal` and the negation consume.
- **A trend-mode-decisive call** is an emitted call whose side would not be produced with the negation off on the same inputs.
  - Captured at call time from `deriveVerdict`'s own locals (CH2). It is never recomputed afterwards.
- **Variants act only on decisive calls.** Every other call, and every `RANGING` call, is identical under every variant.
  - **M** — today's rule.
  - **F** — fade: the same row, timestamp and `|raw_final|`, on the opposite side.
  - **H** — hold.
- **Cycle-1 assignment space S1 = {(M,M), (F,M), (F,F)}**, written (UP cell, DOWN cell).
  - (M,F) is outside S1: the Plan-Mode census showed it fails rule ① in every timeframe. The gate still prints its ① bound as a diagnostic.
  - Every assignment containing H is outside S1: the registry refuses H until a quarantined H-hold store ships (ruling Q3).
- **Per window, each timeframe gets exactly one of three outcomes:** `SWITCH_TO(A)` · `KEEP_INCUMBENT(cause)` · `INDETERMINATE(cause)`.
  - Recommendations go to Mr.1. The gate never writes the assignment.
  - A separate switch dispatch commits the assignment and deploys it.

## 1. Ordering (PROCEDURE §1)

This file lands on `origin/main` before CH2's deploy.

**`T_START` := the `StartedAt` instant of the first production container running the registry code** (CH2's deploy). It is recorded at CH2, as an epoch, in `status.md` and the vault audit.

No row of the forward corpus can exist before `T_START`. So no outcome statistic on that corpus can predate this landing. The landed commit's timestamp and each look's live `date -u` are recorded together.

**The spec's two branches, and which one is realized:**
- `T_START` was to be this file's landed-commit time if the capture-era replay reproduced the would-be (TREND_MODE-off) verdict on every row, and CH2's deploy instant otherwise.
- The Plan-Mode replay (identity checks only) reproduced the SERVED verdict on every row. It could not reproduce the would-be verdict on most rows, because the capture never stored the RSI value or the funding z-score.
- **The second branch is realized.** CH2 captures both fields, so that from `T_START` the decisive flag can be re-verified from stored inputs.

## 2. Prior-examination disclosure (PROCEDURE §2)

| Seen before landing | Class | Where recorded |
|---|---|---|
| The trend-mode readout (2026-09-30): v1 and v2 daily excess over the mix-matched null, its t-statistic and negative-day count, the per-side selection edges, the timeframe × side crossing, emission rates and the emission-gap figures | `seen — not a test input` | vault `status.md` (`SIGNAL-TREND-MODE-READOUT-W1` entry); the spec's "Why this exists" mirror table |
| The readout's arm-level daily dispersion — used in §5 for power planning, and nowhere else | `seen — not a test input` | same |
| The share of rows whose price did not move, as stated in the spec | `inherited` — unverified, because reading it needs an outcome query | vault spec |
| Plan-Mode identity replay of the capture era (2026-08-31 → 2026-10-02): reproduction of the served verdict; would-be-verdict determinability by class | `cardinality` (identity check, no outcome read) | vault endpoint truth §3 |
| Plan-Mode census per cell: rows, days, negation-image candidates, decisive-if-negated side composition and per-day rates; per-timeframe side shares under each candidate assignment; capture join coverage | `cardinality` | vault endpoint truth §3 |
| Scored share of mature rows per timeframe (the NULL-ness of the outcome column only) | `coverage ratio` | vault CH1 entry, `status.md` |
| The predecessor gate's B/C/D readings, its trigger-A refusal and its once-ever marker time | `cardinality` / operational | vault endpoint truth §2 |

**No outcome statistic has been computed on the forward corpus (`created_at > T_START`) by anyone** — it does not yet exist.

The capture era is SEEN. It generated the hypotheses in §7 and is never a test input.

## 3. Corpus — a literal predicate, closed by window clocks (PROCEDURE §3)

**Stores.**
- `signal_scorer_inputs` (ssi) — the emitted arm's capture sibling, keyed `(signal_hash, exchange)`.
- `signals` — the outcome column `outcome_return_pct`.

**Capture columns registered here; CH2 implements exactly these names.** Every one is additive and nullable; NULL means "written before the registry".

| store | column | meaning |
|---|---|---|
| `signals`, `signal_scorer_inputs` | `rule_config_id TEXT` | hash of the committed assignment plus the kill-switch state that produced the row |
| `signal_scorer_inputs` | `trend_decisive BOOLEAN` | the call is trend-mode-decisive (§0) |
| `signal_scorer_inputs` | `v1_signal TEXT`, `v1_raw_final DOUBLE PRECISION` | the would-be verdict and raw score with the negation off |
| `signal_scorer_inputs` | `verdict_m TEXT`, `verdict_f TEXT`, `verdict_h TEXT` | each variant's verdict for the row (equal to `verdict_m` on every non-decisive row) |
| `signal_scorer_inputs` | `rsi_value DOUBLE PRECISION`, `rsi_score_pre SMALLINT`, `funding_z DOUBLE PRECISION` | the inputs the would-be verdict needs, so the decisive flag is re-checkable from stored parts |

**`verdict_rule_version` becomes a function of the served variant** (M → 2, F → 3; 1 is never produced again). It is written by all three writers from one derivation (ruling Q4).

**The per-window read, literal; CH3's query is byte-equal to it:**

```sql
SELECT ssi.scorer_input_id, ssi.regime, ssi.trend_decisive, ssi.verdict_m, ssi.verdict_f,
       ssi.signal AS served_side, ssi.decided_at, o.outcome_return_pct
FROM signal_scorer_inputs ssi
LEFT JOIN LATERAL (
  SELECT s.outcome_return_pct
  FROM signals s
  WHERE s.signal_hash = ssi.signal_hash AND s.exchange = ssi.exchange
    AND s.regime_rule_version = 3
  ORDER BY s.id
  LIMIT 1
) o ON TRUE
WHERE ssi.timeframe = :tf
  AND ssi.decided_at >= :window_start AND ssi.decided_at < :window_end
  AND ssi.exchange <> 'BITMART'
  AND ssi.rule_config_id IS NOT NULL;
```

**The read, line by line.**
- One row per captured decision. The lateral picks the earliest `signals` row of a double-written decision, which de-duplicates on `scorer_input_id`.
- A row is **scored** when `o.outcome_return_pct IS NOT NULL`.
- `outcome_return_pct` is the raw price return in percent from entry to the close of the last candle of the evaluation window (`src/lib/pfe-mae.ts`). It is not side-adjusted.

**Windows, per timeframe.**
- Window k is `[W_k, W_k + L_tf days)` in whole UTC days.
- `W_1` is the first UTC midnight strictly after `T_START`. Rows between `T_START` and `W_1` are a burn-in and belong to no window.
- The window's own clock closes it at `W_k + L_tf` — never what a backfill happened to reach.
- **Look for window k:** the first weekly gate run at or after `W_k + L_tf + H_tf + 24h`.
  - `H_tf` is the maturity horizon, `EVAL_CANDLES × TF_MS` in `src/lib/pfe-mae.ts`.
  - The 24h covers the backfill's slack.
- **The decision instant is that look.** `W_{k+1}` is the first UTC midnight strictly after it.
  - Rows between `W_k + L_tf` and `W_{k+1}` belong to no window.
  - No row is ever reused across windows, or pooled between them.

**Coverage travels with two denominators:** the window's rows, and its scored rows. Drops are reported by name and never filled.

## 4. Instrument

**The incumbent `I`** is the assignment in force at the window's first row. It is read from the served side of the decisive rows: served = `verdict_m` ⇒ M, served = `verdict_f` ⇒ F.

**Every member of S1 is evaluated counterfactually on every scored row**, the incumbent included. This is exact for M and F because:
- the price return does not depend on the side served;
- both verdicts are captured.

**Side under assignment A (row i):** `side_A(i) = verdict_f(i)` when `trend_decisive(i)` and A assigns F to the cell of row i. Otherwise `side_A(i) = verdict_m(i)`.

**Per UTC day d of timeframe tf, over its scored rows (N_d rows):**
- hit: `h_A(i) = [side_A(i) = BUY ∧ r_i > 0] ∨ [side_A(i) = SELL ∧ r_i < 0]`, the readout's side-aware sign win;
- up-rate `u_d = mean[r_i > 0]`, down-rate `w_d = mean[r_i < 0]`, BUY share under A `q_{A,d} = mean[side_A(i) = BUY]`;
- **excess over the mix-matched null:** `E_{A,d} = mean h_A(i) − (q_{A,d}·u_d + (1 − q_{A,d})·w_d)`;
- **magnitude excess (bps):** `M_{A,d} = mean g_A(i) − (2·q_{A,d} − 1)·mean(100·r_i)`, where `g_A(i) = +100·r_i` on a BUY and `−100·r_i` on a SELL.

**The paired improvement of A over the incumbent:**
- `Δ_d(A) = E_{A,d} − E_{I,d}`;
- `ΔM_d(A) = M_{A,d} − M_{I,d}`.

Same rows, same day. Only decisive rows in the cells A switches can move. A switch applied to a random subset of rows has expectation **zero by construction**, because the null absorbs the side-mix change.

The raw hit-rate difference is NOT the statistic. It is market-coupled: flipping calls against the window's prevailing direction "improves" it with no selection quality at all — the comparator defect `CLAUDE.md` § Data Integrity names.

**Aggregation is per cluster, never pooled.**
- The estimate `Δ̄(A)` is the unweighted mean of `Δ_d(A)` over the window's days.
- **Clusters:** UTC days for 3m–4h; blocks of `b_tf` consecutive days from `W_k` for 8h, 12h and 1d (§5). Their evaluation windows (32h, 48h, 72h) overlap consecutive days. A final block may be shorter.

**Inference** — `src/scripts/cluster-perm-stats.py`, no second implementation:
- the call is `cluster_bootstrap_ols(X = [[1.0]] per day, y = Δ_d, clusters = cluster id of d, B = 10000, rng = random.Random(arm_seed("<tf>|window<k>", "<A>")))`;
- the intercept is `Δ̄(A)`;
- the one-sided p-value `p⁺(A)` is the fraction of bootstrap draws ≤ 0, read off `same_sign_frac` and the sign of the point estimate;
- the same call with `y = ΔM_d` gives the magnitude draws.

**Per-cell transparency** (descriptive; never decided on). The M decisive-call edge of each cell = mean over days of `mean(h_M(i) − base_d(i))` over the cell's decisive rows, with `base_d(i) = u_d` on a BUY and `w_d` on a SELL — the crossing's measure. It is printed beside the timeframe line.

## 5. Floors and power (PROCEDURE §5)

| timeframe | maturity horizon H | cluster | window L (days) | minimum clusters | status |
|---|---|---|---|---|---|
| 3m | 36 min | day | 21 | 17 | decided |
| 5m | 1 h | day | 21 | 17 | decided |
| 15m | 3 h | day | 14 | 12 | decided |
| 30m | 4 h | day | 14 | 12 | decided |
| 1h | 8 h | day | 14 | 12 | decided |
| 2h | 12 h | day | 14 | 12 | decided |
| 4h | 24 h | day | 21 | 17 | decided |
| 8h | 32 h | 2-day block | 49 | 20 | decided |
| 12h | 48 h | 2-day block | 56 | 23 | decided |
| 1d | 72 h | 3-day block | 56 | — | **WATCH** |

**What each window is powered for:** a decisive-call selection edge of 5pp in the switched cells, at power 0.80, one-sided, at the most stringent Holm step (FWER 0.025 over at most 20 tests). That gives `k = z(1 − 0.025/20) + z(0.80)`.

**The instrument beside each number** (values in the vault, never quoted here):
- per-day standard error of the edge = `√(0.25 / n_D + σ_b²)`:
  - `n_D` is the smaller trending cell's decisive rate per day, from the Plan-Mode census;
  - `σ_b` is the readout's arm-level daily dispersion, disclosed in §2;
- the error scales as `1/√clusters`;
- slow timeframes are inflated by their block length, assuming worst-case correlation within a block;
- required days are rounded up to whole weeks, with a 14-day minimum.

**Floors, branches and cadence.**
- **Minimum clusters** = `⌈0.8 · L / block days⌉` clusters carrying at least one scored row. A window that closes below it reads `INDETERMINATE — underpowered`, naming the next window's look date. This branch is registered, not improvised.
- **Coverage floor:** scored rows ≥ 95% of window rows at the look; below it, `INDETERMINATE — coverage`.
- **WATCH:** 1d cannot reach the powered edge within 8 weeks, so it is report-only. Its windows print statistics and read `INDETERMINATE — WATCH`.
- **Cadence:** the gate runs weekly on Monday, at a canonical off-:00 minute fixed in CH3 per `ops/monitoring/schedule-boundary-rule.json`. Weekly runs before a window's look print `INDETERMINATE — window open` (progress only).

## Support stress-test

Each registered check, the point at which it is evaluated, and the support fact probed before landing (values in the vault endpoint truth and the CH1 entry).

| Check | Evaluation point | Support / cardinality fact (probed live, 2026-10-02) | Verdict |
|---|---|---|---|
| Paired improvement Δ̄(A) per (timeframe × alternative) | the window's clusters; the decisive rows of the cells A switches | decisive-if-negated rows occur on every day in every trending cell; per-day rates are large in 3m–12h and very small in 1d DOWN (vault §3, R0.4) | `inside` for 3m–12h · `floor` for 1d (WATCH) |
| Magnitude veto on ΔM̄(A) | the same rows; `outcome_return_pct` present | the scored share of mature rows is near-complete on every timeframe (coverage probe) | `inside` |
| Rule ① bound per alternative | the window's pooled post-assignment BUY share | (F,M) and (F,F) leave every timeframe two-sided with a wide 2m; (M,F) collapses the SELL share to near zero in every timeframe; the incumbent's own bound is wide | `inside` for (F,M) and (F,F) · `outside → replaced by` exclusion from S1 for (M,F) (ruled), its bound printed as a diagnostic |
| Holm family | admissible tests per look | at most 20 (10 timeframes × 2 alternatives); windows of different lengths close at different looks, so a look usually carries fewer | `inside` |
| Cluster structure for 8h, 12h, 1d | b-day blocks per window | evaluation windows of 32h, 48h and 72h (`EVAL_CANDLES × TF_MS`) overlap consecutive days; 49/2 and 56/2 give at least 24 blocks | `inside` |
| Day admission (maturity) | look time ≥ window end + H_tf + 24h | the backfill fills a row only after its full window has elapsed (`src/scripts/backfill-outcomes.ts`) | `inside` |
| Coverage floor 95% | scored rows / window rows at the look | the mature-row scored share sits above the floor on every timeframe | `inside` |
| Minimum-cluster floor | clusters with ≥ 1 scored row | every timeframe emits on every day in the census | `inside` |
| Per-cell M edge (descriptive) | each cell's decisive rows per day | as row 1 | `inside`; 1d DOWN printed with its n |
| H refusal | the committed assignment | the registry refuses H (CH2 test), so no H-served row can exist | `inside` |
| Capture completeness | rows after `W_1` with `rule_config_id` NULL | the writer stamps every row; expected zero | `inside`; non-zero ⇒ `INDETERMINATE — capture` |
| De-duplication | `(signal_hash, exchange)` unique on ssi; double-written `signals` rows | ssi carries one row per decision; the census found every signals row joinable | `inside` |
| `T_START` realization | CH2 container `StartedAt` | recorded at CH2 | `inside` |

## Identifiability

(PROCEDURE §4c. Rule ① is the only rate floor this registration declares. Decisions on Δ̄ read an interval against zero, and the windows and clusters are §5 floors.)

**How each row reads.**
- `m` is the registered **minimum** minority share an alternative must leave its timeframe at: `2·m ≥ 3.0 pp ⇔ m ≥ 0.015`.
- An alternative below it is not admissible, so every admissible alternative is identifiable by construction.
- The 3.0 pp floor is the one this estate already declared for the same comparison (`ops/monitoring/trend-mode-readout-gate.py`, `EDGE_FLOOR_DROP_PP`).
- On the Plan-Mode census the admissible set does not depend on the floor's exact value over a wide range (range in vault §3).
- At each look the bound is computed through `attainable_bound_from_share` in `ops/monitoring/population_comparison.py` — one formula.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| rule ① — timeframe excess over its own mix-matched null under an admissible alternative | 3m | `0.015` — registered minimum; measured at each look by probe `SELECT avg((side_A = 'BUY')::int)` over the window's scored rows | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 5m | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 15m | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 30m | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 1h | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 2h | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 4h | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 8h | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 12h | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |
| rule ① — same | 1d | `0.015` — same probe | 3.0 | 3.0 | IDENTIFIABLE |

## 6. Decision rule (PROCEDURE §6)

At each look, for each timeframe whose window closed (S1 ∖ {I} = its alternatives):

1. **Gates in order:** capture completeness → coverage floor → minimum clusters → WATCH. The first that fails yields `INDETERMINATE` with that cause.
2. **Rule ①:** an alternative is admissible iff `attainable_bound_from_share(q̄_A) ≥ 3.0`, where `q̄_A` is its BUY share over the window's scored rows. This is decided from cardinalities, before any outcome is read.
3. **The family** is every admissible (timeframe × alternative) at this look. Holm step-down at FWER 0.025, one-sided, on `p⁺(A)` — equivalently, `CI_lower > 0` at the Holm-adjusted level.
4. **Magnitude veto, applied after Holm:** a rejected alternative is vetoed when fewer than 5% of its `ΔM` draws are above zero, i.e. its one-sided 95% upper bound is below zero.
5. **Recommendation:**
   - **`SWITCH_TO(A)`** for the rejected, un-vetoed alternative with the largest `Δ̄(A)`. On a tie, the one switching fewer cells wins.
   - Otherwise **`KEEP_INCUMBENT`**, with the cause named: `① unattainable` (no alternative admissible) · `magnitude veto` · `no admissible improvement`.

**Map onto PROCEDURE §6:**
- `SWITCH_TO` = attributable;
- `KEEP_INCUMBENT` = not attributable, cause named;
- `INDETERMINATE` = indeterminate, cause named.

A KEEP is a statement about this window's evidence, not a claim that the variant does nothing. A null counts only when the interval excludes the powered edge.

The next window tests the then-live assignment against S1 again, so a switch-back needs its own window's evidence. **Both sides beat hit rate:** rule ① is never traded against Δ.

## 7. Declared expectations (before any forward row exists)

- (M,F)'s diagnostic ① bound reads below 3.0 pp in every timeframe.
- 1d reads `INDETERMINATE — WATCH` at every look.
- **First looks**, at about `T_START` + window + horizon + 1 day, then the next Monday:
  - 15m, 30m, 1h and 2h after about two and a half weeks;
  - 3m, 5m and 4h after about three and a half;
  - 8h after about eight;
  - 12h after about nine.
- **Hypotheses from the SEEN corpus** (not tests; only the forward windows decide):
  - DOWN-cell decisive SELLs anti-select where the readout found the bleed (8h, 3m, 5m, 12h, 4h), making (F,F) the likeliest switch there;
  - 1h leans the other way;
  - UP-cell edges are small, so (F,M) is unlikely to clear Holm alone.

## 8. Respecification, deviations, quarantine, publication (PROCEDURE §7–§8)

- **Re-registration.** Before `T_START`, any change to the statistic, S1, rule ①, the floors, the windows or α is a re-registration of this file. After `T_START`, a change is a new registration applied to windows that have not opened. A correction after a look applies to later windows only.
- **Read scope.** The gate is the sanctioned reader of `signal_scorer_inputs` for this purpose (its quarantine-allowlist row lands in CH3).
  - It reads the emitted arm only. It never pools it with a withheld arm.
  - It never reads `hold_decisions`, `hold_decision_labels` or `band_signals`.
- **Figures** live in the vault only: `Claude files/canary-results.jsonl`, `status.md` and vault audits. Nothing reaches public copy, and `/api/performance-public` is untouched.
- **B-DIR v3 FULL test.** Every switch changes the emitted population inside its sealed holdout (`created_at > 1790402400`). `rule_config_id` and `verdict_rule_version` make that population partitionable for `aoe-2027-0117-bdir-v3-full`.
- **§4b does not apply.** Every decision here reads an interval against zero; nothing is read against a reference arm.
