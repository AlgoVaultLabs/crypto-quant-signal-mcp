# EDGE-REGIME-CONFIRM-W1 — pre-registration: one confirmation read of the regime diagnostic's five answers, on months after its hold-out

Written 2026-11-16T21:55:31Z (UTC; 2026-11-17 local, the date in the file name), before any kline row after `T_END` has been fetched for this study. Internal research: no public surface, no serving or scoring change, nothing shipped, no accuracy or edge claim, no tuning after data. This file carries rules, dates and positions (P01 … P15) only: no estimate, no interval, no cluster count, no census weight and no coin name. Every figure of this study, and of the study it succeeds, lives in the private vault and never in this repository.

Procedure: `audits/PREREGISTRATION-PROCEDURE.md` §1–§9, including §4c and §4d. Wave spec: `Prompt/EDGE-REGIME-CONFIRM-W1.md` (planning vault).

**T3** is the closed study `EDGE-REGIME-DIAG-W1`, registered in `audits/regime-diagnostic-preregistration-2026-11-16.md`. "T3 §n" cites a section of that file's body. "T3 A1 … A4", "T3 B1 … B4" and "T3 C1, C2" cite the parts of its three amendments. "T3 reading n" cites a numbered reading of its A4, and "T3 Dn" a row of its disclosure table. Inside a table or a quotation reproduced from T3, a section, table or reading number is T3's own. This file registers T3's successor on months after T3's `T_END` (T3 §3, §5, §9). Every T3 rule it reuses is cited by section and applies unchanged, with the two substitutions §4 names. Where a sentence here and the cited T3 text could be read differently, the T3 text governs. This wave registers the study and adds its record, its clock and its absence probe to the harness. A later wave runs the one read.

SERVED_RULE_STUDY: src/lib/market-regime-core.ts · MARKET_REGIME_RULE_VERSION = 2

## 0. What is tested, in one paragraph

T3 read the served regime label (`computeMarketRegimeCore`, rule version 2) in a fit window and once in a hold-out. It is closed and its hold-out is spent (T3 §7). This successor asks one question of each of T3's five answers: does the fit-window finding hold on rows that did not exist when T3 was registered? It runs exactly T3 §6's hold-out test on entries after T3's `T_END`, through `T_END2 = 2027-05-31T23:59:00Z`: the same five primaries (T3 §4.8), comparators (T3 §4.7), shapes, holds and path label (T3 §4.4), weights (T3 §4.5, the census), clusters and resampling (T3 §4.6), floors (T3 §5) and order of states. Each primary carries its fit-window state, point and sign from T3's fit result, which this file pins by sha256 (§10). Nothing is re-fit and nothing is selected: A3 is read in T3's fit-selected cell alone. There is one read, at a date registered here (§5), behind a seal of its own. The read can confirm a finding or fail to confirm it. It cannot tune, extend or repeat.

## 1. Ordering (PROCEDURE §1)

- **Landing.** This file lands on `origin/main` before any kline row after `T_END` is fetched for this study and before any outcome is computed on one. At the time of writing neither archive store holds an archive of a month after 2026-10 (§2, E8), and nothing of this study's window has been computed: no label, no skeleton, no outcome.
- **This wave reads nothing.** It computes no statistic on real archives and makes no harness run on real archives of any kind. Its tests run on synthetic fixtures.
- **What the harness refuses.** The read is `run.ts --study confirm --holdout` (§3). Every refusal below is logged, with its leg, in the guard log of the store the run names.
  - Before the guard: a run that names no study or an unknown one, a read this study does not have (it has no fit read: nothing is re-fit), and T3 named as the study (T3 is closed) — leg `study`. An output directory inside the repository — `out`. A compiled or copied harness — `source`. No fit result named — `fit-result`. A clock before `not_before` — `clock`. A store inside the repository is refused first and is never written to.
  - The guard (`checkDiagGuard`, which calls `checkOutcomeGuard` of `src/scripts/sr-backtest/guard.ts` unmodified) requires: (i) this file is on `origin/main`, and the last commit that touched it is an ancestor of `origin/main` (`registration`); (ii) no test lever is set (`mutation`), and every repository file pinned in §10 hashes to its pin on disk (`pins`); (iii) §10 pins the fit result that the study record carries (`carry`); (iv) the census file hashes to its pin (`census`); (v) the archive-store manifest of T3's months hashes to its pin and is rebuilt equal from the archives on disk, and every panel coin × outcome month is a verified archive or a recorded absence (§3) (`archives`); (vi) the core-parity fixture reproduces label for label (`parity`); (vii) this study's seal does not exist (`seal`).
  - After the guard: the fit result must be the carried file by sha256, of kind `fit`, of the registered T3 study, read under T3's registration commit (`fit-result`).
- **Order of the one read.** The guard. Then the skeleton of the window, labels only, rebuilt and logged by its sha256 (leg `skeleton`). Then the pre-outcome checks of §5 and of the Identifiability section, with the achieved effective clusters logged against the floor (leg `floors`). Then the seal is claimed (leg `seal`). Then `outcome_read_at` is taken and the outcomes are computed (leg `outcomes`). Then the result is written and logged by its sha256 (leg `result`).
- **No skeleton to register, and no look.** T3 §1 opens its read by comparing the rebuilt skeleton with registered tables. The rows of this study do not exist yet, so there is no table to register: the realized skeleton is recorded in the result, and its sha256 is logged before the seal. The harness serves this study no skeleton look ahead of the read (`run.ts --study confirm --skeleton` is refused): a look at an accruing window before its read date is an interim look.
- **Two clocks,** recorded together in the result as in T3 §1: `registration_landed_at` (the landing commit's time, and the first time the store saw that commit on `origin/main`) and `outcome_read_at` (taken immediately before the first outcome computation, after the seal is claimed: T3 reading 53).
- **After landing,** this file's body is never edited. A change before the read is an appended, dated amendment section (PROCEDURE §8). If a pinned file changes before the read, an appended pin section re-pins it: the guard keeps the last row for a name (T3 A1).

## 2. Prior-examination disclosure (PROCEDURE §2)

Everything the author saw before this file landed that bears on the study. Classes: `cardinality` · `coverage ratio` · `inherited` · `seen — not a test input`. Paths under `audits/` in this table are in the private vault unless the row says otherwise.

| # | what was seen | when | class | use |
|---|---|---|---|---|
| E1 | T3's fit result, vault `audits/regime-diag-read-2026-11-16/fit/regime-diag-fit.json`, sha256 `46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312`: the fit-window states, points and intervals of the five answers, A3's selected cell, the variants and the descriptives | after T3's read, before this file | inherited | carried by sha256 (§10). Its states, points, signs and selected cell are the fit-window half of §6's test. Its A4 reading is the input of §5's power rule. Nothing in it is a row after `T_END` |
| E2 | T3's hold-out result and its findings, vault `audits/regime-diagnostic-findings-2026-11-16.md` and `.json`: the five hold-out states, estimates, intervals, flags and descriptives on 2026-01 … 2026-10. They were open to the author and to the architect, and are disclosed as seen in full | after T3's read, before this file | seen — not a test input | none of it enters a test here. No entry of 2026-01 … 2026-10 is an outcome of this study, and the fit-window half of every test comes from E1 alone |
| E3 | T3's label-free tables (T3 §2, Tables 2a–2e) and its support and identifiability rows, public in T3's registration in this repository | before this file | inherited | the support and identifiability rows of this file, cited by table and row. No table is restated here |
| E4 | the frozen census, vault `audits/regime-census-2026-11-16.json`, sha256 `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a` (T3 D2) | before T3 | inherited | panel and weights, read at run time. No census figure and no coin name is in this file |
| E5 | the power computation on E1's A4 reading, vault `audits/regime-confirm-power-2026-11-17.md`: the fit-window points, half-widths and cluster counts of A4's four legs, and the months each leg would need | 2026-11-16 | inherited | fixes `T_END2` and the read date (§5). It reads fit-window figures of a closed study and no row after `T_END` |
| E6 | two HEAD requests to the archive host, made by the architect: one for a month the venue has not published (2030-01), answered 404, and one for a served month (2026-10), answered 200 | 2026-11-16, about 20:25Z (the architect's log) | cardinality | the absence probe's rule (§3): 404 at an archive's URL means the venue does not serve it |
| E7 | the file modification times of the first copies of the eight 2026-10 archives of T3 D7, in the archive cache | 2026-11-16 | cardinality | those copies were fetched on day 5 of the following month and lacked one UTC day; the venue republished the files, and the copies T3 fetched on day 16 were complete (T3 D7). `not_before` is therefore `T_END2` + 16 days |
| E8 | a listing of the two archive stores (T3's cache and its overlay) | 2026-11-16T21:51:07Z | cardinality | neither holds an archive of a month after 2026-10, and neither holds an absence record: no row after `T_END` has been fetched for this study |
| E9 | this wave's harness tests | 2026-11-16 | seen — not a test input | synthetic coins and synthetic prices only. No statistic was computed on a real archive in this wave |

The product's live service reads current candles to serve labels. It computes none of this study's outcomes and writes nothing this study reads. In this wave the author fetched and read no kline row, no served label and no statistic dated after `T_END`.

## 3. Corpus — literal predicate, closed by a clock (PROCEDURE §3)

A row is in the corpus if and only if every clause holds:

```
the row is a kline row of the file  <SYMBOL>-1m-<YYYY-MM>.zip  served at
    https://data.binance.vision/data/futures/um/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-<YYYY-MM>.zip
AND <SYMBOL> = <COIN>USDT for a <COIN> of the census panel (field t3_weights; 15 coins)
AND <YYYY-MM> is one of the 41 months 2024-01 … 2027-05
AND for a month 2024-01 … 2026-10 (history):
        the file is the one T3 read: its name, sha256 and row count are a row of T3's archive-store
        manifest, pinned in §10 as store:regime-diag-archives.json
AND for a month 2026-11 … 2027-05 (the outcome months):
        sha256(file) = the value in the venue's <file>.CHECKSUM, fetched with the file on or after
        not_before and kept beside it
AND open_time is a whole minute with  2024-01-01T00:00:00Z <= open_time <= T_END2
AND open > 0 AND high > 0 AND low > 0 AND close > 0

T_END      = 2026-10-31T23:59:00Z   T3's bound. A row up to it is history here, never an outcome.
T_END2     = 2027-05-31T23:59:00Z   this study's bound, fixed at write time by §5's rule.
not_before = 2027-06-16T00:00:00Z   the earliest instant of the read, and of every fetch and probe for it.
```

- **The window.** Entries with `2026-11-01T00:00Z <= t` and `t + 72 h <= 2027-06-01T00:00Z` (`T_END2` plus one minute). It is the study's only window. No entry at or before `T_END` is an outcome of this study. An entry's history may reach into T3's months: history is label-free input (T3 §3, "History is read only from inside the corpus"). An entry's 72 h path never passes `T_END2`. Rows after `T_END2` belong to a further successor registration.
- **Stores and reader.** T3's stores and T3's reader form (T3 §3): the same URL, the same checksum verification, the same row rules (T3 reading 1). The harness verifies an outcome month's archive against the `.CHECKSUM` file beside it at read time, records the verified files in the result (`archives_verified_at_read`), and refuses the read on a mismatch (leg `archives`). File names carry coin names, so that list stays in the vault.
- **Unserved coin-months.** A panel coin × outcome month with no archive is the named drop `no_archive` (T3 §3). It counts as absent only on a checked record of the pinned probe (below). A coin-month with neither an archive nor a record, or with both, refuses the read.
- **Two denominators.** Registered: 15 positions × 41 months = 615 coin-months and 26,935,200 grid minutes, of which the outcome months are 105 coin-months and 4,579,200 grid minutes. Reached: for 2024-01 … 2026-10, the coin-months T3 reached (T3 §3), held by the pinned manifest; for the outcome months, counted at the read from the verified archives and the recorded absences, and reported in the vault with the share of the census design weight they carry. A coin counts only in the months its archive exists (T3 §3).
- **Drops, by name, counted and never filled.** T3 §3's drops and T3 reading 3's minute-level names apply as registered: `no_archive` · `short_history` · `path_beyond_window` · `gap` · `no_1d_history` · `core_refusal` · `both_touch` · `null_odds` · `undated` · `key_b_beyond_window` · `censored_run` · `di_tie`.

**The read procedure.** Every step is taken on or after `not_before`. The read is owed from `not_before`, and its wait for a complete file ends at `2027-06-30T00:00:00Z`.

1. *Served coin-months.* For each panel coin × month 2026-11 … 2027-05 that the venue serves: fetch the archive and its `.CHECKSUM` in T3's reader form into an archive store directory, keep the `.CHECKSUM` beside the archive, and verify the archive's sha256 against it.
2. *The rest.* For each coin-month with no archive, run the pinned probe: `tsx src/scripts/regime-diag/probe-absent.ts --coin <COIN> --month <YYYY-MM> --dir <archive store directory>`. It makes one HEAD request for the archive's URL at the venue's origin. On HTTP 404 it writes `<archive>.ABSENT`, holding exactly `{url, status, probed_at}`, and prints `REGIME_DIAG_PROBE_VERDICT=ABSENT`. On any other answer it writes nothing: `SERVED` (exit 1) means the archive is to be fetched, `INDETERMINATE` (exit 3) means the question is to be asked again. The guard accepts a record only if it holds exactly those three keys, the archive's own URL, status 404 and a `probed_at` on or after `not_before`.
3. *The gap probe* (T3 D7's probe, over the whole month), on every served archive of an outcome month. Every UTC day of the file's month must hold at least one row. A day missing before the first row, between rows or after the last row means the file is fetched again later and no run starts.
4. *When the wait ends.* From `2027-06-30T00:00:00Z` the run proceeds on the files as they are, and T3's `gap` drop applies as registered.
5. *Disclosure.* The time of every fetch and of every probe is disclosed in the read's evidence (PROCEDURE §2).
6. *The store.* `tsx src/scripts/regime-diag/run.ts --study confirm --init-store --store <store> --census <census> --cache <cache> --overlay <overlay>` writes the two store manifests into a store directory of this study's own, outside the repository. T3's store directory stays as T3's read left it: this study's manifests and guard log are never written there, and only the seal file sits in it (§7). The sha256 of the two manifests must equal the two `store:` pins of §10; the guard refuses otherwise.
7. *The read.* `tsx src/scripts/regime-diag/run.ts --study confirm --holdout --store <store> --census <census> --cache <cache> --overlay <overlay> --out <output directory> --fit-result <the pinned fit result>`, from a checkout of this repository in which every pinned file hashes to its pin. The commit this file lands on is such a checkout. The guard reads this file from `origin/main` and hashes the pinned files on disk.

## 4. Methodology — T3's, carried by section

The method is T3's. This section cites each rule and states the two substitutions; it restates no rule.

| T3 rule | what it fixes | in this study |
|---|---|---|
| T3 §4.1; T3 readings 4, 5 | the replay: the pinned core is called on closed bars aggregated from 1 m rows, never re-implemented | unchanged. The per-closed-bar series is computed over the whole span (T3 reading 4), which now runs from 2024-01-01 through `T_END2` |
| T3 §4.2; T3 readings 2, 3, 6 | eligible instants and the entry draw: 24 entries per eligible coin-day, one seeded draw per window × position | unchanged, in this study's window and under its seed label (substitutions 1 and 2) |
| T3 §4.3 | σ | unchanged |
| T3 §4.4 | the 9 shapes, the 5 holds and the path label from the 1 m path, on both sides | unchanged |
| T3 §4.5 | rows, the design weights of the census (`t3_weights`) and the estimator | unchanged |
| T3 §4.6; T3 A3; T3 readings 12 to 17 | coin × UTC-day clusters, the bootstrap, the shuffles, the statistic registry and its counts | unchanged, under this study's seed label (substitution 2) |
| T3 §4.7 | the baselines (a) to (d): an effect counts only when it beats every applicable one on the same rows | unchanged |
| T3 §4.8 | the five answers, one primary statistic each, and their descriptives | unchanged. Only the five primaries are tested (T3 §6); the descriptives carry no verdict |
| T3 A2; T3 reading 26 | A3's selected-cell reading: its shuffle count, and a plain 95% interval on the fit-selected cell in the hold-out | unchanged |
| T3 §4.9 | key A, the trend dated in hindsight | unchanged. It enters here only as the dating inside A4's statistic and in the descriptives |
| T3 §4.10; T3 B1, C1, C2 | key B and the key readings | T3's, read in T3's fit window only. No key ladder is read here (see Answer-key ceiling) |
| T3 §4.11; T3 readings 45 to 47 | the sensitivity flags and their variants | unchanged: `CLUSTER_SENSITIVE`, `WEIGHT_SENSITIVE` and `PANEL_SENSITIVE` are reported beside each primary and never replace it. `PANEL_SENSITIVE` reads the window on the positions the fit result lists as carrying fit-window rows. No secondary cell is tested |
| T3 readings 38, 48 to 50, 52 | the hold-out's pre-outcome checks, its sign test and A5's hold-out test | unchanged |
| T3 readings 53 to 55 | the clocks, the refusals before the seal, and the descriptives after it | unchanged. A run that fails after the seal is claimed leaves the read spent |
| T3 B3 | the seal has one place, which no store argument moves | unchanged: this study's seal is `confirm.seal` in that place (§7) |

**Substitution 1 — the window.** Where a cited T3 rule says "hold-out", read this study's window (§3). The harness keeps the name `holdout` for it, in seeds and in the result. "Fit window" always means T3's fit window, and reaches this study only through the pinned fit result.

**Substitution 2 — the seed label.** Every stream derives from `20261117`, the date in this file's name, in place of T3's `20261116`. The derivations are T3's (T3 §4.2, §4.6, T3 reading 2): the entry draw of position `P<nn>` is seeded from the first four bytes of `sha256("20261117|holdout|P<nn>")`, and every other stream with `arm_seed('20261117', 'holdout|<statistic id>|<purpose>')`.

**What is not run here.** T3's fit-window procedures were read once, in T3: the selection of A3's cell, the key ladder, the component map and the secondary family. Their readings stand in the pinned fit result. This study repeats none of them.

## Answer-key ceiling (PROCEDURE §4d)

The answer keys are T3's (T3 Answer-key ceiling, §4.9, §4.10, B1, C1, C2). The table is reproduced as T3 registered it; "§4.1", "§4.9" and "§4.10" in its cells are T3's sections. T3's reading rule is "fit window only", and T3 read the ladder once, in its fit window. Those readings stand in the pinned fit result. This study scores no key again and reads no ladder: a diagnosis of `NO_ROOM`, `INPUTS` or `LAG` is a fit-window reading of T3 and is not reopened by a confirmation. Key A enters this study in one place, as the hindsight dating inside A4's statistic and its descriptives (T3 §4.8).

| key | role | construction | reading if it fails |
|---|---|---|---|
| A | CEILING | the trend dated in hindsight from bars on both sides of each call: Pagan–Sossounov turning points with a Lunde–Timmermann filter on closed-bar log closes, window 7 bars, threshold 6σ of that coin × timeframe (§4.9); its volatility leg is the true range of the 14 bars after the call | NO_ROOM: with the true phase in hand the statistic still does not clear its baselines, so there is nothing to find and no change to the rule can help |
| B | NO_LAG | the pinned core, unchanged, on a window that ends 14 bars after the call, so it sees bars after the call (§4.10) | INPUTS: the ceiling wins and the rule's own inputs cannot reach it even without lag, so the inputs are the defect |
| S | SERVED | the label a caller would have received at the call: the pinned core at rule version 2 on closed bars (§4.1) | LAG: the inputs carry the answer when they may look ahead and the live label does not deliver it, so the lag is the defect |

Diagnoses: `NO_ROOM` (CEILING fails), `INPUTS` (CEILING wins, NO_LAG fails), `LAG` (NO_LAG wins, SERVED fails).

## Component map (PROCEDURE §4d)

The component map is T3's (T3 Component map, §4.11, B2). The table is reproduced as T3 registered it. In its cells `θ`, `Δ1`, `S2` and "after BH" are T3's (T3 Component map, first paragraph; T3 §4.8, §4.11). It is read in T3's fit window only, and each row's state stands in the pinned fit result. This study recomputes no row and nominates no dial: confirming or failing to confirm a primary changes no row's state.

| slice | dial | works | broken | too little data |
|---|---|---|---|---|
| 1 · young labels: TRENDING rows whose label is at most 14 bars old (consecutive closes of the per-closed-bar series carrying the entry's label; the replay analogue of `regime_since_ms`). θ = Δ1 on the slice; Δ1 on older labels is reported beside it | `adx(highs, lows, closes, 14, 5)`: the 14-bar smoothing and the 6-value slope fit | θ at least 3.0 pp and above 0 after BH: a fresh label is already usable | θ below 3.0 pp after BH: a label is not usable while it is fresh | fewer than 50 effective coin × UTC-day clusters, or neither criterion met |
| 2 · early trend: TRENDING rows with ADX above 18 and at most 25. θ = Δ1 | `adxVal > 18` with `adxSlope > 0.8` | θ at least 3.0 pp and above 0 after BH | θ below 3.0 pp after BH: the early-trend branch admits labels that carry nothing | fewer than 50 effective coin × UTC-day clusters, or neither criterion met |
| 3 · just past the gate: TRENDING rows with ADX above 25 and at most 30. θ = Δ1 | `adxVal > 25` | θ at least 3.0 pp and above 0 after BH | θ below 3.0 pp after BH: the gate is too low | fewer than 50 effective coin × UTC-day clusters, or neither criterion met |
| 4 · moderate: TRENDING rows with ADX above 30 and at most 40. θ = Δ1 | `adxVal > 30`, the tier whose confidence is `Math.round(adxVal * 2)` | θ at least 3.0 pp and above 0 after BH | θ below 3.0 pp after BH | fewer than 50 effective coin × UTC-day clusters, or neither criterion met |
| 5 · strong: TRENDING rows with ADX above 40. θ = Δ1 | `adxVal > 40`, the tier whose confidence is `Math.min(90, Math.round(adxVal * 2))` | θ at least 3.0 pp and above 0 after BH | θ below 3.0 pp after BH: the highest-confidence tier carries nothing | fewer than 50 effective coin × UTC-day clusters, or neither criterion met |
| 6 · slope: θ = Δ1 on RISING-slope rows minus Δ1 on FALLING-slope rows | `ADX_SLOPE_RISING` and `ADX_SLOPE_FALLING`, with the confidence adjustment `Math.round(adxSlope * 5)` | θ at least 3.0 pp and above 0 after BH: a rising slope marks better labels, as the adjustment assumes | θ below 3.0 pp after BH: the slope does not separate labels | fewer than 50 effective coin × UTC-day clusters on either arm, or neither criterion met |
| 7 · exhaustion: rows on which ADX is above 25 and below 30, the slope is FALLING and `adxSlope < -1.0`, served as RANGING. Direction as the normal branch would give it: price structure, else ±DI; an exact DI tie is excluded and counted. θ = Δ1 with that direction | `adxSlope < -1.0` with `adxVal < 30` | θ below 3.0 pp after BH: suppressing the trend label loses nothing usable | θ at least 3.0 pp and above 0 after BH: the suppression discards a usable label | fewer than 50 effective coin × UTC-day clusters, or neither criterion met |
| 8 · structure against ±DI: TRENDING rows with ADX above 25 whose direction came from the price structure while ±DI points the other way. θ = Δ1 with the served direction | the precedence of `priceStructure === 'HIGHER_HIGHS'` and `'LOWER_LOWS'` over `directionFromDI` | θ above 0 after BH: the structure was right to override | θ below 0 after BH: ±DI was right | fewer than 50 effective coin × UTC-day clusters, or neither criterion met |
| 9 · volatility line: non-trending rows. The fixed line against a per-coin × timeframe percentile line that flags the same share of rows at that timeframe (the coin's fit-window quantile; in sample, so not tradable). θ = S2 on the fixed line's rows minus S2 on the percentile line's rows, at any confidence | `volatilityRatio > 0.03` | θ above 0 after BH: the fixed line finds stop-prone rows better | θ below 0 after BH: a per-coin line finds them better | fewer than 50 effective coin × UTC-day clusters on either arm, or neither criterion met |
| 10 · TRENDING confidence: θ = Δ1 at confidence ≥ 60 minus Δ1 below 60 | `REGIME_AGAINST_MIN_CONFIDENCE = 60`, with the confidence formulas `Math.round(adxVal * 2)` and `Math.round(adxVal * 1.5)` | θ at least 3.0 pp and above 0 after BH: confidence orders the labels and the trigger keeps the better side | θ below 3.0 pp after BH: confidence does not order the labels | fewer than 50 effective coin × UTC-day clusters on either arm, or neither criterion met |
| 11 · VOLATILE confidence: θ = S2 at confidence ≥ 70 minus S2 below 70 | `VOLATILE_MIN_CONFIDENCE = 70`, with `Math.min(85, Math.round(volatilityRatio * 2000))` | θ at least 3.0 pp and above 0 after BH | θ below 3.0 pp after BH: the trigger's threshold separates nothing | fewer than 50 effective coin × UTC-day clusters on either arm, or neither criterion met |
| 12 · label timeframe: entries eligible at all three timeframes, TRENDING at confidence ≥ 60. Two contrasts: Δ1 at 4h minus Δ1 at 1h, and Δ1 at 4h minus Δ1 at 1d. Δ1 by timeframe × hold is reported beside them | the `'4h'` default of `input.timeframe` in `src/tools/get-market-regime.ts` | both contrasts at least 0 and both above −3.0 pp after BH: no other timeframe beats the default by the floor | a contrast below 0 after BH: another timeframe is better than the default | fewer than 50 effective coin × UTC-day clusters at any of the 3 timeframes, or neither criterion met |

Rows 10 to 12 name constants outside the core, in `src/lib/pre-trade-rules.ts` and `src/tools/get-market-regime.ts` (T3 §8, correction 1). Both files are cited, not pinned (§10).

## 5. Floors, the read date and power (PROCEDURE §5)

- **Independence unit and floor.** T3 §5, unchanged: the unit is the coin × UTC-day cluster, and the floor is 50 Kish-effective clusters (`FLOOR_CLUSTERS`), counted under the design weights on the rows a statistic uses. There is no row floor. The floor applies to each of the five primaries, with A3 counted in its fit-selected cell (T3 §6 step 1; T3 readings 38 and 50).
- **N.** T3 §4.2: 24 entries per eligible coin-day. The window is 212 UTC days. T3 reading 6 gives the entries of a complete position from the window's two ends: 5,016.
- **Floors are checked before outcomes, and logged.** T3 §5 and T3 reading 52: before any outcome is computed, the harness recomputes the effective clusters and the direction mix of every row set on the realized skeleton, under the design weights. This corpus accrues after registration, so the achieved effective clusters go on record against the floor before the seal is claimed (PROCEDURE §4, the accruing-corpus clause): the guard log's `floors` line carries the floor, the effective clusters of every row set of T3's Table 2d, and those of A3's fit-selected cell.

**The read date.** One read, of all five answers, of the window that ends at `T_END2 = 2027-05-31T23:59:00Z`, made on or after `not_before = 2027-06-16T00:00:00Z`.

- **The rule** (wave spec §1). `T_END2` is the earliest month-end at which A4's `CONFIRMED` test reaches at least 80% power at half its fit-window excess, capped at 2027-05-31. Every other answer is read at the same date.
- **The test** is T3 §6 step 2, a conjunction. Its legs are the four outputs of A4's reading: `S`, and the paired excesses `e_always_up`, `e_always_down` and `e_coin` over the three labels of T3 §4.8, A4, comparator (d): the always-up label, the always-down label and the random one.
- **The instrument** is T3 §5's: arithmetic on fit-window figures, with no simulation, no outcome and no row after `T_END`. A leg's standard error in the fit window is `h / 1.96`, with `h` the half-width of its 95% interval in the fit result. It scales as `sqrt(D_fit / D)` in coin-days, with `D_fit` the coin × UTC-day clusters of A4's fit-window rows. The detectable effect at 80% power and a one-sided 2.5% level is `2.80 · SE`. A leg tested at half its fit-window point `e` therefore needs `D >= D_fit · (2.80 · h / (0.98 · |e|))²` coin-days. The panel supplies about 450 coin-days a month (T3 §5), and month 1 is 2026-11. The power of a conjunction is at most the power of its weakest leg; the shuffle leg and the joint distribution are not modelled, so the month at which every leg reaches 80% is a lower bound on the rule's month.
- **The inputs** are fields of the pinned fit result: `.primaries.A4.reading.names`, `.point`, `.lb`, `.ub`, `.alpha` and `.clusters`. The computation and its figures are in the vault (§2, E5); anyone holding the fit result reproduces it from this paragraph.
- **The result.** The cap binds: `T_END2 = 2027-05-31T23:59:00Z`. The outcome months are the seven months 2026-11 … 2027-05.
- **`not_before`** is `T_END2` plus 16 days. A month's archives were measured complete on day 16 of the following month and incomplete on day 5 (§2, E7). A run before `not_before` is refused (leg `clock`).
- **No interim look, no extension, no second read.** The harness has no skeleton look for this study (§1), `T_END2` is a constant of the pinned study record, and the seal refuses a second read (§7).

**The underpowered branch, registered.** T3 §5's branch is inherited (T3 §9), in T3's words:

> - **The underpowered branch, registered.** An effect equal to the floor may therefore return too little data in the fit window or `NOT_CONFIRMED` in the hold-out. That is a live outcome of this design, not a failure of the study. Such a result is reported as `too little data — underpowered` (the procedure's `indeterminate — underpowered`), with the interval's half-width `h`, the effective cluster count, the multiple of coin-days `(h / F)²` that would bring the half-width to the floor, and the calendar month by which the panel supplies them at about 450 coin-days a month (15 positions). The hold-out cannot be extended. What resolves an underpowered hold-out is a successor registration on months after `T_END`.

Here "the hold-out" is this study's window and the "successor" is a further one, on months after `T_END2`. T3 reading 51 fixes the arithmetic, and the harness applies it to every primary that reads `NOT_CONFIRMED`: where `(h / F)² > 1` the result carries the label `too little data — underpowered`, the half-width, the effective clusters, the multiple, the coin-days of the window, the coin-days needed, and the month, counted from 2027-05 at 450 coin-days a month. `F` is 3.0 pp for A1 to A4 and 0.10 for A5.

**A4 at the cap.** The cap is a calendar bound, not a power target. At the cap, by the instrument above, one leg of A4's test is below 80% power at half its fit-window excess: the paired excess over the always-up comparator. A4 may therefore read `NOT_CONFIRMED` because that leg's interval reaches 0, and such a result is underpowered, not negative (PROCEDURE §6). T3's report measures the interval of `S` against the floor and says nothing of a paired excess. So A4's verdict also carries a leg report, registered here. It is a report: it changes no state and no statistic. It is computed from recorded fields alone — the read's `primaries.A4.reading` and the same field of the pinned fit result — and recomputes no outcome.

- For each leg `k` of `S`, `e_always_up`, `e_always_down`, `e_coin`: `h_k` is half the width of its 95% interval in the read, and `e_k` is its point in the fit result.
- The leg is `met` when its interval in the read excludes 0 on the side of the fit-window sign, `contrary` when it excludes 0 on the other side, and `open` otherwise.
- `m_k = (2.80 · h_k / (0.98 · |e_k|))²` is the multiple of the read's coin-days at which the leg reaches 80% power at half its fit-window excess. A leg with `m_k > 1` is named `too little data — underpowered`, with `h_k`, `m_k`, the coin-days needed (`m_k` times the coin × UTC-day clusters of A4's rows in the read, the reading's `clusters`), and the month: 2027-05 advanced by `ceil(needed / 450)`.
- If A4 reads `NOT_CONFIRMED` with at least one `open` leg, no `contrary` leg, and `m_k > 1` on every `open` leg, the result is reported as `NOT_CONFIRMED — too little data — underpowered`. Otherwise it is reported as the state alone, with the leg table beside it. The result line carries T3 §6's three states and nothing else.

What resolves an underpowered answer is a further successor registration on months after `T_END2`. This read is not extended and not repeated.

## Support stress-test (PROCEDURE §4)

Every registered check, the point at which it is evaluated, and what is known of the support there. No row after `T_END` exists, so no occupancy can be probed. The rule and the panel are T3's, so T3's label-free occupancy (T3 §2, Tables 2a–2e; T3 Support stress-test) is the inherited fact, cited by table and row and not restated. A check whose support is known only at the read has the verdict `floor`: its achieved effective clusters are logged against the 50-cluster floor before the seal is claimed (§5).

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| A1 primary `Δ1` | TRENDING rows at confidence ≥ 60 among entries after `T_END`, 45 cells, both sides | no row exists yet (E8). Under the same rule on the same panel both label directions were occupied in both of T3's windows (T3 Table 2d) | floor — effective clusters and direction mix are recomputed on the realized skeleton before any outcome; below 50 effective clusters, or with a §4c bound below 3.0 pp, the primary is `NOT_IDENTIFIABLE` and is not computed |
| A2 primary `S2` | VOLATILE rows at confidence ≥ 70, 45 cells, both sides | no row exists yet. In T3 the statistic was carried by the 1d label (T3 Support stress-test, A2 primary row), and this window holds 212 daily bars a position against 304 in T3's hold-out | floor — as A1; also reported per timeframe, and a timeframe below the cluster floor is named |
| A3 primary `S3` in the fit-selected cell | the one shape × label-group cell the fit result names (`.primaries.A3.selected`), at plain 95% bounds | no row exists yet. Every shape is defined on every entry (T3 D11); the cell's label group decides its rows | floor — the cell's effective clusters are logged before the seal (`a3_selected` of the `floors` line); below 50, or with no fit-selected cell in the fit result, the answer is `NOT_IDENTIFIABLE` (T3 §6 step 1) |
| A4 primary `S4` | TRENDING rows whose last closed bar has a dated key-A phase | no row exists yet. Key A dates a phase between turning points, so the last bars before `T_END2` can be undated (drop `undated`); T3's dated share was lowest at 1d in its shorter window (T3 Support stress-test, A4 primary row) | floor |
| A5 primary `R5` | uncensored TRENDING runs of the per-closed-bar series in the window | no run exists yet. A run cut by a window edge is excluded and counted (`censored_run`) | floor — below 50 effective clusters the answer is `NOT_IDENTIFIABLE` |
| baselines (a) and (b) | every entry × cell × side of the window | `noEdgeOdds` was non-null for every entry in every cell on the long side of T3's skeleton (T3 D11). The rule is unchanged; this window's nulls are counted at the read | floor — a null is the named drop `null_odds`, never filled |
| baseline (c), the shuffle | runs of equal label inside each coin × timeframe of the window | all four labels occurred at every timeframe in both of T3's windows (T3 Table 2a); this window's runs are not counted yet | floor — a coin × timeframe sequence with fewer than two blocks cannot be shuffled, stays in place and is named by position and timeframe (T3 reading 15) |
| baseline (d) | both label directions inside a directional row set | T3's minority direction shares, carried into the Identifiability table | floor — the realized mix is recomputed before any outcome |
| the fit-window half of each test | the state, point and sign of each primary in the fit result, and A3's selected cell | the file is pinned by sha256 and was read under T3's registration commit; the harness refuses any other file (legs `carry`, `fit-result`) | inside — a fit point equal to its reference, or undefined, makes the answer `NOT_CONFIRMED` (T3 reading 48) |
| sensitivity variants `@day`, `@week`, `@unit` | each primary re-read under the changed clusters or weights, against the fit point read under the same variant (T3 readings 45 and 47) | the fit result holds the variants' fit points (`.variants`); no row of the window exists yet | floor — a variant below the floor is named; a flag never replaces a primary |
| sensitivity variant `@panel13` | the positions the fit result lists as carrying fit-window rows (`.positions`) | 13 of the 15 positions carried fit-window rows, and all 15 carried rows in T3's hold-out (T3 D3; T3 Support stress-test, "fit and hold-out position sets") | floor — `PANEL_SENSITIVE` reports the window on those positions; the positions that carry rows after `T_END` are counted at the read |
| history depth | 10,080 unbroken minutes before an entry for the 1h and 4h labels, 144,000 minutes for the 1d label | the corpus holds T3's months as history: an entry after `T_END` has the first depth on every position with a complete 2026-10 archive, and the second on every position whose rows began at least 144,000 minutes before it | inside — otherwise the drops `short_history` and `no_1d_history` apply by name |
| outcome-month archives | each panel coin × month 2026-11 … 2027-05 | neither store holds one (E8). In T3 no position had a missing month after its first (T3 D3) | floor — at the read each is a verified archive or a recorded absence (§3); a coin-month that is neither refuses the read |
| the gap probe | every UTC day of the month of a served outcome-month file | measured once: the day-5 copies of eight archives lacked one UTC day, the day-16 copies were complete (E7; T3 D7) | floor — a missing day defers the run until the wait ends (§3); after that T3's `gap` drop applies |
| the read clock | the instant of the run against `not_before` | `not_before` is a constant of the pinned study record; the harness's tests prove the refusal on an injected clock | inside — a run before it is refused (leg `clock`) |
| descriptives | lag, flip-flops, confidence monotonicity and run lengths in the window (T3 §4.8) | no row exists yet | floor — descriptive; reported with their counts, after the seal, with no verdict (T3 reading 55) |
| floors of the window | the realized skeleton | recomputed before any outcome, and logged against the 50-cluster floor before the seal: every row set of T3's Table 2d and A3's fit-selected cell | floor |

## Identifiability (PROCEDURE §4c)

A floor on a directional comparison is bounded by the side mix of the arm it constrains (T3 Identifiability). T3 §6 step 1 compares that bound with the floor of 3.0 pp before any outcome, so the floor is declared here as in T3. No row after `T_END` exists, so each share below is T3's, measured under the same rule on the same panel: class `inherited`.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| A1 primary against the fixed-side and random-side callers | this window, TRENDING at confidence ≥ 60 | 0.4555, inherited: the smaller of the two shares T3 measured on this row set (T3 Identifiability, rows 1 and 2); probe: T3's skeleton count of TRENDING_UP and TRENDING_DOWN rows | 3.0 | 91.10 | IDENTIFIABLE |
| A3 in the fit-selected cell against the fixed-side callers, if that cell is one of the two TRENDING groups | this window, all TRENDING rows | 0.4606, inherited: the smaller of T3's two shares on this row set (T3 Identifiability, rows 3 and 4); probe: the same count | 3.0 | 92.12 | IDENTIFIABLE |
| A4 primary against the always-up and always-down labels | this window, TRENDING rows with a dated phase | 0.4477, inherited: T3's smallest up- or down-phase share of dated bars over timeframes × windows (T3 Identifiability, row 5); probe: T3 Table 2b | 3.0 | 89.54 | IDENTIFIABLE |
| A2 primary, and A3 in the fit-selected cell if that cell is one of the two side-blind groups | both sides of every entry | 0.5, by construction (T3 Identifiability, row 6): every entry is taken long and short, so the probe is the entry × side count being twice the entry count | 3.0 | 100.0 | IDENTIFIABLE |

The shares above are unweighted and are T3's. The share of this window is not known until its rows exist. Before any outcome is computed, the harness recomputes each share under the design weights on the realized skeleton, and its bound through `attainable_bound_from_share` (`ops/monitoring/population_comparison.py`). An arm whose bound is below its floor is reported as `NOT_IDENTIFIABLE` and is not computed (T3 §6 step 1; T3 reading 38). A5's floor is a ratio of an unsigned quantity and follows no side mix, so it has no row here (T3 Identifiability).

## 6. Decision rule (PROCEDURE §6)

The rule is T3 §6's hold-out rule, in T3's words:

> **Hold-out.** Only the five primaries are tested, each carrying its fit-window state. The order is fixed.
>
> 1. `NOT_IDENTIFIABLE` — on the realized hold-out skeleton the primary's rows have fewer than 50 effective clusters, or its §4c bound is below the floor. This is checked before any hold-out outcome is computed, and the primary is then not computed. A3 with no fit-selected cell is `NOT_IDENTIFIABLE`.
> 2. `CONFIRMED` — the hold-out estimate has the fit-window sign (the sign of `S` for A1–A4, of `R5 − 1` for A5), and its 95% cluster-bootstrap interval excludes every baseline's value on that side: for each applicable comparator (a), (b) and (d) the interval of the paired excess excludes 0 on the side of the fit-window sign, and the shuffle gives `p ≤ 0.025` in that tail.
> 3. `NOT_CONFIRMED` — anything else.
>
> A3's hold-out test is the fit-selected cell alone, whatever its fit-window state, at plain 95% bounds: nothing is selected in the hold-out. `CONFIRMED` confirms the fit-window finding whatever it was; a fit-window estimate with the unexpected sign that is confirmed is a confirmed adverse finding. The floor is not part of `CONFIRMED`. The hold-out estimate and its interval are reported beside the state, the shrinkage from fit to hold-out is reported explicitly, and the hold-out figure is the usable one.

How it applies here:

- **The floor** `F` is T3's: 3.0 pp for A1 to A4 and a ratio of 1.10 for A5. It is not part of `CONFIRMED`. It enters step 1 through the §4c bound, and the underpowered report of §5.
- **The fit-window half** of each test is read from the pinned fit result and from nothing else: the point whose sign is carried (`.fit_points.A1` … `.A5`), the state reported beside it (`.primaries.A1.state` … `.A5.state`), A3's cell (`.primaries.A3.selected`, `.selected_index`), the variants' points (`.variants`) and the positions with fit-window rows (`.positions`). This file names none of their values: T3's answers are internal (T3 §8).
- **The sign test** is T3 reading 48: the sign of the estimate minus its reference, 0 for A1 to A4 and 1 for A5, in the two windows. A fit point equal to its reference, or undefined, is `NOT_CONFIRMED`.

| state | what it says | the estimate under it |
|---|---|---|
| CONFIRMED | the fit-window finding, whatever it was, holds on rows after `T_END`. A fit-window estimate with the unexpected sign that is confirmed is a confirmed adverse finding (T3 §6) | on the fit-window side of its reference, with the interval of every applicable paired excess on that side and the shuffle at `p ≤ 0.025` in that tail |
| NOT_CONFIRMED | anything else. It is not a finding that the label fails: §5's reports say whether the read was underpowered | on either side: the other side of the reference, or the fit-window side with an interval or a shuffle that does not exclude a baseline |
| NOT_IDENTIFIABLE | the primary's rows were below the cluster floor or its §4c bound was below the floor, or A3 had no fit-selected cell. Decided before any outcome | none: the primary is not computed |

The result carries one line, in a file named `regime-confirm.json`:

```
REGIME_CONFIRM_VERDICT=A1:<state>;A2:<state>;A3:<state>;A4:<state>;A5:<state>
```

Beside each state the result reports the estimate and its interval, the fit point and the fit-window state it carries, the shrinkage from fit to this window, the sensitivity flags and §5's reports. The estimate of this window is the usable one (T3 §6). What follows from a state is not decided here.

## 7. The post-result respecification test (PROCEDURE §7)

T3 §7 applies unchanged. After the read, any proposed change to a statistic, a row set, a comparator, a weight, a cluster definition, a constant, the window or the read date is put to T3's question: would this have been proposed had the check passed?

- If not, it is a correction. It is registered in a new file and applied only to rows after `T_END2`, which nobody has seen.
- **The read is spent by one run.** The seal is the file `confirm.seal` in the seal's one place (T3 B3): `<home>/.cache/algovault/regime-diag/store/`, with `<home>` the account's home directory from the OS user database, not from `HOME`. It sits beside T3's `holdout.seal`, which it neither reads nor replaces. No store argument moves it, so no second store reopens the read. A run that fails after the seal is claimed leaves the read spent (T3 reading 54). The seal's scope is T3 B3's: a file under one account on one machine.
- **No extension.** `T_END2` and `not_before` are constants of the pinned study record. A later month is a further successor's.
- **This study itself is not a respecification of T3.** It changes no statistic, comparator, floor, cell or state of T3, and it does not reopen T3's hold-out, whose states stand as read. It adds rows that did not exist.
- A defect found before any outcome exists is fixed, and recorded as an appended amendment, before the read (T3 §7).

## 8. Deviations, quarantine, publication (PROCEDURE §8)

- A deviation from this file is recorded with its reason: before the read as an appended amendment here, during the read in the result. It is never absorbed, and rows computed under a deviation are reported apart (T3 §8).
- **Figures are vault-only.** Every figure of the read goes to the private vault. This repository receives none: not under `audits/`, not in a fixture, not in a commit message. The same holds for T3's figures, its fit-window states and its selected cell.
- **Publication.** T3 §8's rule applies unchanged to the five answers and to their confirmation.
- **No census figure in this repository.** The panel's coin names, its weights and every figure derived from the weights stay in the vault. This file cites the census by path and sha256, and the harness reads it at run time.

**Where this file completes or departs from the wave spec.**

1. *The read day.* The spec fixes the rule for `T_END2` and asks for a registered read date. `not_before` is `T_END2` plus 16 days, on the measured basis of §2, E7.
2. *The spec's frame is not reproduced.* It names T3's fit-window states and the fit-selected cell, which are internal (T3 §8). This file cites them by their fields in the pinned fit result.
3. *The seed label* is `20261117`, the date in this file's name, as T3's label was its own.
4. *Names.* The spec names no result line, result file or seal for the successor. They are `REGIME_CONFIRM_VERDICT`, `regime-confirm.json` and `confirm.seal`.
5. *Commands.* The read is `--study confirm --holdout`. A run names its study; this study has no fit read and no skeleton look.
6. *Absence is a checked record.* The spec calls an unserved coin-month a named drop. The harness counts one as absent only on the pinned probe's record (§3), so a missing download cannot pass for an unserved month.
7. *The `floors` line.* The achieved effective clusters are logged before the seal (PROCEDURE §4, the accruing-corpus clause). T3 had registered tables to compare with instead.
8. *A4's leg report* (§5) is added by this file. The harness attaches T3's report to the interval of `S` and has none for a paired excess, which is the leg the cap leaves underpowered.
9. *The keys and the map* are carried from T3 and are not read again (Answer-key ceiling, Component map).
10. *The file-name date* is the local date, fixed in the study record when the harness landed. The UTC time of writing is in the header.
11. *The archive-store manifest pin* is T3's, carried. This wave made no harness run on real archives, so it did not rebuild that manifest; the read's `--init-store` must reproduce the pin before the guard passes.
12. *The import closure* is pinned as T3 pinned it (T3 §8, correction 16; §10, "Not pinned byte for byte").
13. *The gap probe covers the whole month* (§3, step 3). The spec's ruling words it as a whole UTC day missing between a file's first and last row. Here every UTC day of the file's month must hold a row, because a copy cut short at either end would pass the narrower check. Step 3 took this scope at 2026-11-16T22:11Z, before this file landed.

## 9. Owner, the read, and the inheritors (PROCEDURE §9)

- **Owner** of this registration and of the study record: `EDGE-REGIME-CONFIRM-W1`.
- **The read:** a later wave of ARC-REGIME-ACCURACY, once, under this file and its appended amendments, on or after `not_before`.
- **Inheritors,** ARC-REGIME-ACCURACY, as T3 §9 names them: T4 (answers 1 and 2) · T5 and T6 (the scorecard and the harness) · T7 (answers 4 and 5, the only route to publication). Each reads this study's states beside T3's. A further successor on months after `T_END2` inherits §5's underpowered branch.

## 10. Pinned artifacts

sha256 of the file bytes at commit `f7a1813cb23f86be70abfaf1c23b0cc7ab230d23`, the commit on which this wave's harness changes landed. Each pinned file is byte-identical on the `origin/main` commit this file lands on; that is re-checked immediately before landing. `pinsOf` (`src/scripts/sr-backtest/guard.ts`) reads every row whose first two cells are backticked, and keeps the last row for a name. A pinned file that differs by one byte refuses the read.

**The harness.** Every file of the harness's own list (`HARNESS_FILES`), the absence probe included.

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-diag/archive.ts` | `0d2891b4469dabae7b98b1c68332ae0a18ef37a471a305e14882434c4e09ca43` | the 1 m archive reader: the row rules, the minute grid, the bars, the archive-store manifest, and the name and URL of an archive |
| `src/scripts/regime-diag/bars.ts` | `9aa62d3d082e76516b399dfd3d92c9e87c29f708185be84e124dc1dc52ff7687` | the bar-level statistics: A5, lag, flip-flops; unchanged since T3 |
| `src/scripts/regime-diag/decide.ts` | `19bc12aa756b3c8312873c6104733968f8f7154affa104fe74e96f7d124b89d6` | the decision rule: the states of T3 §6 and the result lines |
| `src/scripts/regime-diag/diag-spec.ts` | `f9b83db8f7c338ad6e4c65088266d7c1e78172f15ba2ec3fa1d3dd2044de0686` | the registered constants, the statistic registry and the study records: T3's, closed, and this study's, with its window, seed label, carried fit result, seal name and `not_before` |
| `src/scripts/regime-diag/engine.ts` | `bd28d8f31cd77848890126431da31acec2d67e1c7b7343239db73154d02a0cf0` | clusters, the cluster bootstrap, the block shuffle, the paired comparators; unchanged since T3 |
| `src/scripts/regime-diag/frame.ts` | `bac646463ef8dba1d74b19c192e82561b1ccdf9d5a8a5a2c526ac5b6295a72f2` | the frame of a window, the skeleton tables, the census reader |
| `src/scripts/regime-diag/guard.ts` | `dc911f9d82bccc2dc44bffe07708a23afb4d795be71a06883135a1bfa5d269f0` | the outcome guard: its legs, the archive checks of the outcome months, the seal |
| `src/scripts/regime-diag/keys.ts` | `d5a77768ff2f9bfc03f545b84579ff38d9f8edfec0e17e996e7f1e828efcd9c5` | key A and key B; unchanged since T3 |
| `src/scripts/regime-diag/labeler.ts` | `b14b0e93e9ce82b40a9d6d1e0a2c9d921b8fd9d4e5bdb889ea2a30d41493f742` | the entry draw, the 1 m path label, baselines (a) and (b) |
| `src/scripts/regime-diag/mutate.ts` | `c934e569674626816a1e6ca438a3b32e28045678296f86c152da6846fa8f6eca` | the test-only mutation lever; the guard refuses when it is set |
| `src/scripts/regime-diag/parity.ts` | `b67ba354d06e7938b4e236e75ed2b0a3edcff751147acf64773501bbcf9fc223` | the core-parity check; unchanged since T3 |
| `src/scripts/regime-diag/prims.ts` | `285e75bcb50f902346577730aae788ce38e8284be84133f9bd42a1dc601216cb` | the bridge to `scripts/regime-diag/prims.py` |
| `src/scripts/regime-diag/probe-absent.ts` | `468469b51e0cb9033e0e4bc1d60042c325ada3c3ab95b42ec57287de9399f913` | the absence probe of §3; new in this wave |
| `src/scripts/regime-diag/replay.ts` | `21f18c3a5c15704d67828d09d80419f2ef2415c294a7d57bff0c8e12a8ab40a5` | the replay: the served label at an instant, by calling the pinned core; unchanged since T3 |
| `src/scripts/regime-diag/rng.ts` | `0600473fab31d7e5ac65c7067a16a6250a6378a97cd99e09edfb732809dbe01e` | the seeded streams; unchanged since T3 |
| `src/scripts/regime-diag/run.ts` | `70226beab45d580de8f2d92a68c4305d4a6e1cf1f038b102fdf6fc50b021dfcc` | the run CLI: the refusals, the order of the read, the result |
| `src/scripts/regime-diag/stats.ts` | `0526b8e7f5ce9d0844da6fed2b8d78db51c91d4d36aee2e021963f44dd047fb1` | the five statistics, their key readings and the component-map slices; unchanged since T3 |
| `src/scripts/regime-diag/synth.ts` | `c53c571f1962e9b9f665fd9d8456c190d458d46e63f3daefd3e78b38a4b5afa1` | the synthetic series the core-parity fixture replays; the tests build on it; unchanged since T3 |
| `scripts/regime-diag/prims.py` | `3380b3e600b59db58e3b56ef6357a6331a6bade1563bd08a6987f2a349f68f25` | calls the pinned primitives of `cluster-perm-stats.py` and `population_comparison.py`; no statistic of its own |
| `tests/fixtures/regime-diag/core-parity.json` | `75026a14853b8043fed4755a1550a84cfe1e702c5f715984aa65fdf491e4b9a7` | the core-parity fixture; unchanged since T3 |

"Unchanged since T3" means byte-identical to the last pin of that file in T3's registration. The other harness files changed in two landed commits: `931cbb3d` (the bridge request is framed and every call bounded: `prims.ts`, `prims.py`) and `f7a1813c` (this wave: the study records, the clock, the carried fit result, the outcome-month archive checks, the absence probe, the seed label as a parameter). T3's statistics, engine, keys, bars, replay and random streams are the files T3 read with.

**Outside the harness.** Each is byte-identical to T3's pin of it (T3 §10).

| pin | sha256 | role |
|---|---|---|
| `src/lib/market-regime-core.ts` | `6cbf10ed4ac5846fa590fa31051a9879c1e22b63f7d65d4ff68731207d4c4004` | the rule under study, rule version 2; git blob d501ca93121b61b8be086fb00d2b9f85f756b802 |
| `src/lib/indicators.ts` | `484c44a6f870e3655fbe28bffe5c3cce49a4feac9ce1488e71a64bda2cca0157` | ADX, ATR, the price structure |
| `src/lib/candle-window.ts` | `19a59198c980e816587e9acd20035eb6441e952ef0a286cfce5249a3694ce8d0` | the closed-basis window split |
| `src/lib/candle-guard.ts` | `aae23242f8e70484d43677db1af03b507fe4fde1bfae8cfcbbaad7cc733177f0` | interval arithmetic of the core |
| `src/lib/serving-windows.ts` | `592caa34ce46acf2470c50970888ece2134bc98add4aa096ab716ed14384ae25` | `CANDLE_COUNTS` |
| `src/lib/errors.ts` | `7539e6060ddd32dde5fe09145490419c6f413c250215d07960299dca8be6f99f` | the core's refusal type |
| `src/lib/pre-trade-calc.ts` | `e6e2c5d5caccda18ef85ffb75d1f609aa430d8cb91e136354a530ba44b63e1f5` | `sigma1hFromVolatilityRatio`, `noEdgeOdds`, `ATR_RANGE_PER_SIGMA` |
| `src/lib/pre-trade-odds-calibration.ts` | `d6b1d65ba862f146fb6316b48f0c52c99ca3cd5bab26f7493a9eb19dfb6971a1` | odds-v1, baseline (b) |
| `src/lib/venue-fees.ts` | `c34a314208b4275947606eb253529d9d35fdc3397d245a7d17114a05f191f726` | `takerFeeBps`, baseline (a) |
| `src/lib/funding-venues.ts` | `1c5e3ff154e56a98cfa67b064a8945de78d69b3f46076d5d7fbc65627ce20076` | the venue fee table read by `takerFeeBps` |
| `src/scripts/cluster-perm-stats.py` | `6d82c1601a9ce1121deecaa1c88ac4685abef328ff27d35047fad37d69f60100` | interval, Kish, seed, BH and permutation primitives |
| `ops/monitoring/population_comparison.py` | `282587c48242601ca3d94f6d748742d7722d49e57f5b975f6da85a94e0e258fb` | `attainable_bound_from_share`, the §4c bound |
| `src/scripts/sr-backtest/guard.ts` | `977ada54406f20140599f82934a7e481d9defbfffd6dfee4a71ddc77a8626ee1` | `checkOutcomeGuard`, `pinsOf` |
| `src/scripts/sr-backtest/store.ts` | `1446732b7d5cfb78cfcbe7b40c6db24980db1874ecfa2072a298b803f3021d04` | the store manifest the guard checks |

**Carried and stored.** These are not repository files.

| pin | sha256 | role |
|---|---|---|
| `carry:regime-diag-fit.json` | `46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312` | T3's fit result, in the vault (§2, E1), read under T3's registration commit `22f01dc912beade374ab4bd7c0f6706e07df332e`. The fit-window half of every test |
| `census:regime-census-2026-11-16.json` | `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a` | the frozen census in the vault: the panel and the weights. T3's pin, unchanged |
| `store:regime-diag-archives.json` | `b177bd0d4cba9ff46f4a8bc8e2f44b57c0f996457e8a2f3f0b21308b33e6ae1a` | the archive-store manifest of the months 2024-01 … 2026-10: T3's pin, carried (§8, point 11) |
| `store:manifest-BINANCE.json` | `12f534f22f64550d8781a5a3a33901e9132f45d99bc16e013bbca92bd093bcc7` | the guard's own store manifest over this study's empty plan. It differs from T3's because the plan names this study's wave and span |

The archives of the outcome months cannot be pinned: they do not exist yet. They are verified at read time (§3), and the result records the verified list and its sha256.

**Cited, not pinned.** The first cell is not backticked, so `pinsOf` skips these rows.

| file | identity | why it is cited |
|---|---|---|
| audits/regime-diagnostic-preregistration-2026-11-16.md | sha256 `f5c54aeb1fe3bc5f788bfd1a49267d77a4317d95ef7ee3df966b3a59ce8581ee` | T3's registration with its three amendments, as cited throughout. T3 is closed and nothing more is appended to it |
| scripts/odds-calibration-study.py | sha256 `fda34fec72c3c7df4f0922d1638b1314845a11183bdc6c230a1ddaf3af51c857` | the archive reader whose form §3 uses: the URL, the checksum check and the row rules. The harness does not import it |
| src/lib/pre-trade-rules.ts | git blob d0cc2f30f516eee9cf888ff4665241db43566597 | holds the 60 and 70 triggers (T3 §8, correction 1) |
| src/tools/get-market-regime.ts | git blob 57a8e733d7648434d0cbedae4044d55b833b03f1 | holds the 4h default (T3 §8, correction 1) |
| audits/PREREGISTRATION-PROCEDURE.md | sha256 `c1f65e138690a7c1c07881df981b751b7c1931749f217ae2416e15f26c3c5fe0` | the procedure as read for this file |
| tests/unit/preregistration-support-stress-test.test.ts | sha256 `7b675487c95fd907ffb6d152586b2f00d585c6568909b26a06e8f1cd9581663f` | the gate this file passes |

**Not pinned byte for byte.** T3 §10 names the files that the core's and the guard's import closures reach and that T3 did not pin byte for byte (T3 §8, correction 16). They are not pinned here either, and this file does not enumerate the closure again. The core-parity fixture covers the behaviour: the guard refuses the read if a label of the fixture changes for any reason (leg `parity`).

**Who enforces what.** `checkOutcomeGuard` enforces the file rows and its own store manifest. The harness's legs enforce the carried fit result, the census, the archive-store manifest, the outcome-month archives, the core-parity fixture, the clock and the seal. A test of the repository (`tests/unit/regime-diag-guard.test.ts`) holds this table to the harness's own list and to T3's pins.
