# AOE-ADS1-OBJECTIVE-W1 — pre-registration: the forward test of AOE's ADS-1 ranking on the 4-venue panel (a REPORT, not a gate)

**Write-time clock (live `date -u`):** first written `2026-10-15T08:58:06Z` (epoch `1792054686`).
**Owner of the read:** `AOE-ADS1-FORWARD-READ-W1`, earliest 2027-01-24T10:00:00Z · **Registered by:** `AOE-ADS1-OBJECTIVE-W1` CH1 · **Procedure:** `audits/PREREGISTRATION-PROCEDURE.md` (§1–§8, incl. §4c) · **Gate:** `tests/unit/preregistration-support-stress-test.test.ts`
· **Pinned to its generator by:** `tests/unit/ads1-scorecard.test.ts` and `tests/unit/ads1-spec-lock.test.ts` — the corpus SQL (§3) is `ops/ads1-spec.json` `extract_sql_template`, whose instance at `T_DIAG_END` is byte-equal to the ADS-1 registration's §10.3 statement.

**This registration is a REPORT, not a gate.** It binds a read of rows that nobody can read before the seal lifts; it is **NON-PROMOTABLE**: no verdict it produces is consumed by any promotion path, serving change, threshold, weight, emission policy or public figure. **It carries no count, rate or outcome figure** (the code repo is public); every number below is a registered constant, floor, epoch or seed. Figures live only in the private vault (`audits/AOE-ADS1-OBJECTIVE-W1-endpoint-truth.md` and the vault result the read will write).

> **The seal is obeyed by construction, not by discipline.** Every AOE label read in `src/feedback/` passes through ONE horizon: a row's label is readable iff `created_at + (W+1)·max(requested, served) ≤ label_read_horizon(now)`, where `label_read_horizon(now) = T_DIAG_END = 1790402400` while `now < SEAL_LIFT = 2027-01-17T10:00:00Z` and `now` after it. Above the horizon: cardinalities and feature presence only, never a label value or an outcome statistic. Only the `-v2` family (`tau{0.5,1.0,2.0}-floor0.30-v2`) is read; `-v1` is DEPRECATED and read by nothing this wave touches. Nothing promotes to serving: AOE's output stays the DARK Redis set; the p_win map is DARK with no consumer. Figures live in the private vault; the repo registration is figure-free. The B-DIR v3 FULL registration (`src/research/bdir3diag/conventions.py`) is imported, never edited.

---

## 0. What is tested, in one paragraph

From the night `EDGE_OBJECTIVE=ads1_edge` goes live on aoe-1 (`AOE-ADS1-OBJECTIVE-W1` CH2) until the seal lifts, the autonomous-optimizer ranks its 4-venue panel (BINANCE · BYBIT · OKX · BITGET — `src/feedback/panel.py` `AOE_PANEL_VENUES`) on ADS-1 under the label horizon, records every night which keys clear the shadow promotion bar, and fits a DARK per-cell p_win map. Three hypotheses about that record are tested ONCE on rows no reader can see before the lift: **H1** selection skill, **H2** the shadow set has edge, **H3** the p_win map is calibrated. The pre-lift ranks and maps are the **inputs** of the test; the holdout rows are the outcome.

## 1. Ordering (PROCEDURE §1)

This file lands before any post-seal label read, trivially and by construction: every row of the holdout (§3) has `created_at > T_DIAG_END = 1790402400`, and no AOE reader can read such a row's label before `SEAL_LIFT = 1800180000` (2027-01-17T10:00:00Z) — `label_read_horizon(now)` (`src/feedback/label_horizon.py`, autonomous-optimizer) returns `T_DIAG_END` until then and every `src/feedback/` label read carries its predicate (asserted by a static scan test). The landing commit's timestamp and the read's `date -u` are recorded together in the vault result.

## 2. Prior-examination disclosure (PROCEDURE §2)

| Seen | Class | Where recorded |
|---|---|---|
| The ADS-1 scorecard (`EDGE-ADS1-SCORECARD-W1` CH3, 2026-10-15): per-cell edge over the mix-matched null, its day-cluster bound, nEff, identifiability, calibration bins, cost tiers — every unit under `T_CAP` | `seen — H1's INPUT, declared` (the T_CAP ranks are what H1 correlates with the holdout; nothing in it is a holdout outcome) | vault `audits/EDGE-ADS1-SCORECARD-W1-2026-10-15.md` (+ `.json`) |
| The AOE dry run (CH4): the rank-delta table (`dwr_edge` / `decided_mm` / `ads1_edge` per candidate), the side-mix census | `seen — H1's INPUT, declared` | vault `…-2026-10-15-ch4.md` (+ `.json`) |
| The nightly `ads1_edge` ranks and `promote_eligible` sets the loop records from CH2's flip to the last pre-lift night (the `ads1-board` lines) | `H1 / H2 INPUT, declared` — produced after this file lands, under the horizon, on readable rows only | aoe-1 reports dir → vault `Claude files/canary-results.jsonl` |
| LRW CH3's `-v1` / `-v2` disagreement table | `seen — not a test input` (a label-agreement statistic between two referees) | status.md 2026-10-14 12:27 UTC |
| The trend-mode readout gate's daily lines | `seen — not a test input` (a different label) | status / Old Status |
| This wave's R0 cardinalities: seal-exposure counts of the two current readers, `-v2` presence per panel venue, `verdict_rule_version` per panel cell | `cardinality` | vault `audits/AOE-ADS1-OBJECTIVE-W1-endpoint-truth.md` |

No holdout row's label or outcome has been read by anyone, and none can be before the lift. A corrected reading of any seen corpus is recorded as SEEN, DISCLOSED, NOT A TEST INPUT; the verdict rests on data nobody has seen (§7).

## 3. Corpus — literal SQL, closed by a clock (PROCEDURE §3)

**The holdout** = every emitted BUY/SELL call on a panel venue with `created_at ∈ (T_DIAG_END, SEAL_LIFT − 7 d] = (1790402400, 1799575200]` whose race window, in the ruled max form, closed by `SEAL_LIFT − 7 d` (2027-01-10T10:00:00Z), carrying a primary-spec `-v2` label; the sensitivity specs on the same rows. The bound is fixed by the seal and a clock, never by what a labeller or a pull reaches.

**Literal SQL** = `ops/ads1-spec.json` `extract_sql_template` — the ONE generator (`src/scripts/ads1/extract-template.ts` `buildExtractSql`), whose instance at `$1 := 1790402400` is byte-equal to the ADS-1 registration's §10.3 statement (pinned by `tests/unit/ads1-scorecard.test.ts`) — **instantiated at `$1 := 1799575200`**, with two filters the reader applies on the result and states as predicates: the lower bound `created_at > 1790402400` and the panel filter `exchange ∈ AOE_PANEL_VENUES`. Session: `aoe_readonly`, `BEGIN READ ONLY`, the token line first, the label table's write counters before and after — the registered ADS-1 session shape (its §3.1 / §10.3).

**Windows closed before the read:** the template's own `created_at + (W+1)·max(requested, served) ≤ $1` bounds every holdout window at `SEAL_LIFT − 7 d`, before the earliest read (2027-01-24T10:00:00Z). Rows beyond the bound (`created_at > 1799575200`) belong to a successor read and are said to.

**Barrier specs:** `tau1.0-floor0.30-v2` (primary; it defines the population) · `tau0.5-floor0.30-v2` · `tau2.0-floor0.30-v2` (sensitivity, L0 / L1 only, on the same rows) — imported constants (`src/scripts/ads1/spec.ts` ← `BARRIER_SPECS_V2`), never typed here. No `-v1` column is read.

**Coverage travels with two denominators:** registered rows under the predicate (label-free), and rows carrying a `-v2` primary label; per `(exchange, timeframe)` and per cell; drops by name, never filled.

**Per-cell rule version (D6):** a cell's test uses the rows under its CURRENT `verdict_rule_version` at the read (`signals.verdict_rule_version`, the registry's stamp); a cell whose version changed inside the holdout is reported with both segments and tested on the current one.

**Not read:** `hold_decision_labels` (quarantined); any row above the read's horizon; any scorer input.

## 4. Methodology — D3 · D4 · D8 · D9 of the wave spec, verbatim

**D3 — the cell and the key.** Gate verdict unit = **side-agnostic `(venue, tf)` cell** on the ADS-1 complete label vs its mix-matched null (identifiability, CI-lb, nEff as ADS-1 computes them; tier pooled, tier-3 share printed). Ranking unit = the existing **`<SIDE>__<tf>` key**, scored by **`ads1_side_excess` = hit_side − q_side** on the cell's rows with that emitted side (q_side = the always-side complete-label hit rate ADS-1 already computes for p₀), day-cluster bootstrap lower bound, same seed discipline. Both are projections of quantities the ADS-1 library already outputs — no new statistic.

**D4 — the shadow promotion bar.** A key is `promote_eligible` iff its cell is **identifiable** (minority ≥ 0.10 on scored rows) ∧ the cell's `ads1_edge` CI-lb > 0 ∧ the key's `ads1_side_excess` CI-lb > 0 ∧ cell nEff ≥ **617** (ADS-1's audit-band floor: 55 % vs 50 % at one-sided α .05, power .8) ∧ ≥ 20 qualifying UTC days. Otherwise `hold` (reason named). **This is a shadow bar for a DARK set; CREDIBLE (nEff ≥ 3,863) remains the public claim bar — the two are never conflated in any output.**

**D8 — p_win calibration map (DARK).** Per panel cell: binned map (ADS-1's `CALIB_BIN_EDGES` over [52, 100], Laplace-shrunk to the cell base rate by bin count), fit on `(T_FLIP, horizon − 14 d]`, validated on the last 14 days under the horizon; published to Redis `algovault:aoe:pwin_map:<venue>:<tf>` (TTL 8 d, **no consumer**) only if `BSS_holdout > 0` ∧ every bin ≥ 30 rows; else `RETRAIN_HELD` and the map is the cell base rate (the honest "no information" map). Weekly refit, same gate. Non-monotone maps are allowed.

**D9 — the forward test.** **H1 — selection skill:** Spearman ρ between each panel cell's pre-lift `ads1_edge` rank and its holdout `ads1_edge` rank over identifiable panel cells, one-sided ρ > 0 (the pre-lift rank = the last pre-lift night's board; the T_CAP scorecard rank is reported beside it as the dry run's input). **H2 — the shadow set has edge:** the keys `promote_eligible` on the last pre-lift night form arm S; S's forward `ads1_side_excess` (per-day cluster mean, pooled by day) CI-lb > 0 against the floor **1.0 pp** (§4c, m = 0.100). **H3 — calibration:** `BSS_holdout` of the last pre-lift maps vs the cell base rate > 0, over occupied bins. Every statistic is a projection of the ADS-1 port's outputs (`src/feedback/ads1_objective.py`: `mix_matched_null` → q_side; `cluster_edge` → the day-cluster bootstrap; `identifiability`); no new statistic.

## 5. Floors and power (PROCEDURE §5)

- **Cluster floor:** ≥ **20** qualifying UTC days in the holdout (H2: days with a scored row of arm S; H1 / H3: days with a scored row in the cell).
- **Cell floor:** ≥ **8** identifiable panel cells (minority ≥ 0.10 on the holdout's scored rows) for H1.
- **Bootstrap:** day-cluster, B = **2000**, seed **20270117**, nearest-rank one-sided bound at α = .05 — the port's `cluster_edge` (bit-exact `mulberry32`).
- **Instrument:** the day-cluster bootstrap standard error (scales as 1/√days; ICC floored at 0 in the design effect, raw ρ reported). The attainable detection at the registered floors is a function of the per-day SD, a measured quantity reported beside the result in the vault, never here.
- **Underpowered branch, registered:** fewer than 20 days or fewer than 8 identifiable cells returns `indeterminate — underpowered`, with the count and the date at which the floor would be met at the observed accrual.

## Support stress-test (PROCEDURE §4)

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| H1 — Spearman over identifiable panel cells | ≥ 8 identifiable cells at the read | on the emitted-to-now side mix (label-free; the ADS-1 CH4 census and this wave's R0), the **1h / 2h / 4h / 30m** cells of every panel venue carry a minority side at or above the 0.10 rule; probe = the label-free side-mix statement (`sideMixSql()`) | `inside` |
| H1 — BINANCE's lower timeframes | the cell's scored-row minority share | on the clean mix under `T_CAP` BINANCE's lower timeframes sit at the identifiability knife-edge (the ADS-1 CH4 census); they may enter or leave the H1 set at the read | `floor` — named at the read, never pooled |
| H2 — arm S's day-pooled excess, floor 1.0 pp | arm S = the keys `promote_eligible` on the last pre-lift night | D4 requires an identifiable cell, so S is empty or identifiable by construction; an empty S is the registered branch `indeterminate — no arm` | `inside` (or the registered empty-arm branch) |
| H2 — ≥ 20 qualifying UTC days | per-day pooled mean over S's holdout rows | the holdout spans 2026-09-26T06:00Z → 2027-01-10T10:00Z (106 calendar days); probe = epoch arithmetic on the registered bounds | `inside` |
| H3 — `BSS_holdout` per cell | `CALIB_BIN_EDGES` bins with ≥ 30 rows | bin occupancy is a cardinality read at the read; cells with an unoccupied bin report it empty | `floor` — unoccupied bins are reported, never pooled |
| Identifiability — minority ≥ 0.10 per cell | the holdout's scored-row side mix per cell | the emitted mix is label-free and measured to now; the scored mix is read only at the read; knife-edge cells are named | `inside` per cell, else named |

## Identifiability (PROCEDURE §4c)

The one rate floor this registration declares is H2's 1.0 pp on arm S. H1 (a rank correlation) and H3 (a Brier skill score against the cell base rate) declare no rate floor: their decisions read an interval against zero, and the day and cell floors above are §5 floors. Arm S's minority share at the read is unknown, but every member of S must satisfy D4's registered rule (identifiable ⇔ scored-row minority ≥ 0.10), so the share the floor is sized against is that rule's value.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| H2 — arm S's forward `ads1_side_excess` over its own mix-matched null | arm S (the keys `promote_eligible` on the last pre-lift night) | 0.100 — the registered scored-row minority rule every member of S satisfies (D4); probe: `jq .minority_side_floor src/feedback/ads1_vendor/ads1-spec.json` (vendored byte-for-byte from `ops/ads1-spec.json`) | 1.0 | 20.0 | IDENTIFIABLE |

## 6. Decision rule (PROCEDURE §6) — three states per hypothesis

- **H1:** `attributable` iff ≥ 8 identifiable cells ∧ ≥ 20 days ∧ the one-sided cell-permutation p (B = 2000, seed 20270117) of ρ is < .05 ∧ ρ's bootstrap lower bound > 0 · `not attributable — cause: the pre-lift ranking is uninformative or inverted` iff the floors hold and ρ's bootstrap upper bound < 0 · else `indeterminate — underpowered` (floors unmet) or `indeterminate — interval straddles zero`.
- **H2:** `attributable` iff S is non-empty ∧ ≥ 20 days ∧ the day-cluster bootstrap lower bound of S's excess > 1.0 pp · `not attributable — cause: the shadow bar selected on noise` iff S is non-empty, ≥ 20 days, and the bootstrap upper bound < 1.0 pp · `indeterminate — no arm` iff S is empty · else `indeterminate — underpowered`.
- **H3:** `attributable` iff `BSS_holdout` > 0 over occupied bins with its day-cluster bootstrap lower bound > 0 · `not attributable — cause: the pre-lift map is anti-informative` iff the upper bound < 0 · else `indeterminate` (bins unoccupied or the interval straddles zero).
- **One line:** "AOE auto-tunes" is `attributable` only when H1 and H2 both are; H3 is reported on its own. A null counts only when the interval excludes the registered floor (H2) or zero (H1, H3); below the floors the result is underpowered, never negative. Magnitude shrinkage between the pre-lift and the holdout figure is expected and reported; the holdout figure is the usable one.

## 7. Declared expectations (before any holdout row exists)

The honest prior, from the seen T_CAP record (disclosed in §2): **H1 indeterminate-or-null** (the fleet-level conviction was anti-informative on T_CAP and the engine sat below its own mix-matched null); **H2 not attributable**, most likely through the empty-arm branch (the registered expectation for the last pre-lift night is zero `promote_eligible` keys); **H3 attributable only where bins are occupied**, and only for cells whose map was published (`BSS_holdout > 0` at fit time), never fleet-wide. A result better than this prior is reported with the same words as a result worse than it.

## 8. Respecification, deviations, quarantine, publication (PROCEDURE §7–§8)

No post-result respecification is permitted on this corpus. A correction a reader would not have proposed had the result been different is registered for data nobody has seen (rows beyond `SEAL_LIFT − 7 d`) and the in-sample value is disclosed as seen and not a test input. Any deviation from this file is recorded as a deviation with its reason in the vault result. The withheld arm stays quarantined (`hold_decision_labels` is never read). Figures are vault-only; nothing reaches public copy; nothing serves, promotes or publishes. `cells_tested` is added to the directional family's cumulative total at the read.

## 9. Owner and the read

`AOE-ADS1-FORWARD-READ-W1`, earliest **2027-01-24T10:00:00Z** (7 days after the lift, so the last holdout windows have closed). It reads the holdout once through the template (§3), computes H1 / H2 / H3 per §4 and §6, and writes the vault result. If `B_DIR_V3_PASS` fires on 2027-01-17 and directional promotion opens, this read is the first evidence the switch-on wave must cite; if `B_DIR_V3_FAIL`, AOE stays DARK and the read still runs — the record is the product.

## 10. The cross-repo contract at this registration

`ops/ads1-spec.json` (sha256 at this registration `089223b6d8b624541999295a53e7efdbe4f5547f8b2aa4e9f97b3513e2c3899a`, locked by `tests/unit/ads1-spec-lock.test.ts`) gains two keys and nothing else: `extract_sql_template` (the `$1` horizon template of §3) and `seal_lift_epoch` (1800180000). Every other key and every registered ADS-1 statement is byte-unchanged — the ADS-1 registration's own pin test still quotes its §10 statements verbatim against the generator. The autonomous-optimizer repo vendors these bytes (`src/feedback/ads1_vendor/`, sha256-pinned; `scripts/ads1_drift_check.py`). The ADS-1 registration's §10.1 record of the previous revision stays as history; this file is the lock's newest record.
