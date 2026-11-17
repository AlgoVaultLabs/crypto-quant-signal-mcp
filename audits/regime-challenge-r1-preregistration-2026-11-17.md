# EDGE-REGIME-CHALLENGE-R1-W1 — pre-registration: one judge read of round 1's challengers to the served regime rule, paired against it on T3's unread hold-out window

Written 2026-11-17T04:03:08Z and revised in place before landing at 2026-11-17T04:26Z (UTC; 2026-11-17 local, the date in the file name), before any judge read. Internal research: no public surface, no serving or scoring change, nothing shipped, no accuracy or edge claim, no tuning after data. This file carries rules, dates and positions (P01 … P15) only: no estimate, no interval, no cluster count, no census weight and no coin name. Every figure of this round's pre-score, and of the study it challenges, lives in the private vault and never in this repository.

Procedure: `audits/PREREGISTRATION-PROCEDURE.md` §1–§9, including §4c and §4d. Wave spec: `Prompt/EDGE-REGIME-CHALLENGE-R1-W1.md` (planning vault), with the lead's rulings of 2026-11-17T02:23Z and 2026-11-17T03:08Z (10:23 and 11:08 local), which bind over its body.

**T3** is the closed study `EDGE-REGIME-DIAG-W1`, registered in `audits/regime-diagnostic-preregistration-2026-11-16.md` with three appended amendments. "T3 §n" cites a section of that file's body. "T3 part A1 … A4", "T3 part B1 … B4" and "T3 part C1, C2" cite the parts of its three amendments; "T3 reading n" cites a numbered reading of its part A4, and "T3 Dn" a row of its disclosure table. "Table 2a … 2e" are T3's label-free tables (T3 §2). **T9** is `audits/regime-confirmation-preregistration-2026-11-17.md` (`EDGE-REGIME-CONFIRM-W1`), cited for its form and its window only. A bare A1 … A5 is one of T3's five answers (T3 §4.8). A bare C1, C2 or C3 is one of this round's challengers (§0). "Map row n" is row n of T3's component map; the wave spec calls it Mnn. Every T3 rule this file reuses is cited by section and applies unchanged; where a sentence here and the cited T3 text could be read differently on a T3 rule, the T3 text governs. The challengers, the paired statistics, the guards and the decision rule are this file's own. This wave registers the read and makes the judge's store. A later wave of T6 round 1 (the spec's W2) makes the read, once.

SERVED_RULE_STUDY: src/lib/market-regime-core.ts · MARKET_REGIME_RULE_VERSION = 2

## 0. What is tested, in one paragraph

T6 of ARC-REGIME-ACCURACY pits the served regime label (`computeMarketRegimeCore`, rule version 2) against at most three one-dial challengers per round. A challenger is the served rule with one input changed. Round 1 holds three, on the dials of map rows 1, 8 and 12. **C1** (map row 1) changes the ADX smoothing period of `computeRegimeIndicators`, served as `adx(highs, lows, closes, 14, 5)`, to 7 or to 10. **C2** (map row 8) takes direction from ±DI on every trending row: the core's own `classifyRegime`, given a price structure that is neither `HIGHER_HIGHS` nor `LOWER_LOWS`. **C3** (map row 12) moves the label timeframe, the `'4h'` default of `input.timeframe` in `src/tools/get-market-regime.ts`, to `'1h'`. All three were pre-scored in sample on T3's fit window, 2024-01 … 2025-12, under a selection rule fixed before the pre-score ran. C1's round-1 verdict is `KEEP (pre-score)`; C2 and C3 go to the judge (§2, E5). The judge reads each judged challenger once, paired against the served rule on the same entries, in T3's hold-out window, 2026-01-01T00:00Z … 2026-10-31T23:59Z. Nobody has read that window's regime outcomes (§2, E2). The primary is `ΔΔ1 = Δ1(challenger) − Δ1(served)`, T3's A1 statistic computed under each arm's own label and confidence. Three paired guards (A4, A5, coverage) must hold, and Holm's step-down runs over the family {C2, C3}. A challenger `WINS` only when its `ΔΔ1` interval lies wholly above 0 at one-sided 2.5 % under Holm and no guard fails. A `WINS` goes to Mr.1 through Extra gate 2, and nothing is served without it. The result holds paired quantities only: it holds no served-only statistic on 2026, and nothing in it is read as a state of a T3 answer.

## 1. Ordering (PROCEDURE §1)

- **Landing.** This file lands on `origin/main` before the judge read, and before any outcome of the judge window is computed for this round. At the time of writing, no outcome of 2026-01 … 2026-10 has been computed for this round, and no challenger label of any month after 2025-12 has been computed. The pre-score opened 2024-01 … 2025-12 and no other month (§2, E5). The judge's store was made by a sha256 pass over files, with no frame, label or outcome (§2, E6).
- **This wave reads nothing of the judge window.** It runs no `--judge`, and it computes no label, skeleton or outcome of 2026. It opens no archive of a month after 2025-12, except through that sha256 pass.
- **The clocks so far,** all on 2026-11-17 (UTC): the selection rule's three bound points, ruled at 02:23Z (§6); the pre-score, 02:59:14Z to 03:03:35Z; the selection confirmed and the family fixed, 03:08Z; the judge's store, 03:18:20Z to 03:18:21Z; this file, written at 04:03:08Z; the lead's ruling to put the decision's label-only inputs on disk before the seal, 04:19Z; this file's body revised in place on that ruling, before landing, at 04:26Z.
- **The read** is `challenge-run.ts --judge` (§3). Its order is T3's (T3 §1; T3 readings 52 to 54), and every step before the seal reads no outcome:
  1. *The pinned guard*, `checkDiagGuard` of `src/scripts/regime-diag/guard.ts`, asked of this round's study record (`judgeStudyRecord`). The legs are listed in the order the code runs them, under the numbers of the code's own comments. First, no test lever may be set (leg `mutation`). Leg (i): this file is on `origin/main`, and the last commit that touched it is an ancestor of `origin/main`. Leg (ii): every file row of §10 hashes to its pin on disk, and so does the guard's own store manifest in the judge's store. Leg (iv): the census hashes to its pin. Leg (iii): the archive-store manifest in the judge's store hashes to its pin, and it is rebuilt equal from the archives on disk over T3's months 2024-01 … 2026-10, by file name, byte count and sha256 alone. Leg (v): the core-parity fixture reproduces, label for label. Leg (vi): this round's seal does not exist. T9 §1 numbers the legs differently; the names are the same.
  2. *This round's checks after the guard.* Every row of `REQUIRED_PINS` is a row of §10 (leg `pins`). §10 pins `carry:regime-challenge-r1-prescore.json`, and the pre-score result named by the run has that sha256, is a registered pre-score, and names at least one judged challenger (leg `carry`). §10 pins T3's registration, whose tables the frame is checked against (leg `skeleton`). C1's copy of the indicators reproduces the core-parity fixture at period 14 (leg `parity`).
  3. *The frame, labels only.* It is checked against T3's hold-out rows of Tables 2a–2e (leg `skeleton`); a frame with no entry is INDETERMINATE under the same leg. Every entry and the end of its 72 h path must lie in 2026-01 … 2026-10 (leg `window`).
  4. *The challenger columns and each pair's support,* labels only. Each judged challenger's identifiability (§5; the Identifiability section) and coverage ratio are computed. The guard log then receives the line `identifiability`, which holds what the decision reads from the labels (§5, "What is on disk before the seal").
  5. *The seal* `challenge-r1.seal` is claimed in the one seal home (§7).
  6. *`outcome_read_at`* is taken, and then the outcomes are computed (T3 reading 53).
  7. *Holm, the decisions and the result* are written, and the result line is logged with the result's sha256.
- **Refusals.** Each of the following refuses with `REGIME_CHALLENGE_RUN_VERDICT=REFUSED — <reason>` (exit 1) or `INDETERMINATE — <reason>` (exit 3), and reads no outcome:
  - *No log line* (no store has been opened): a CLI usage error, a census file that does not exist (both INDETERMINATE), and a store inside the repository (REFUSED).
  - *Logged in the judge's store, with the leg:* an output directory inside the repository (`out`); a compiled or copied harness (`source`); a pre-score file that is absent (`carry`); no single judge registration on `origin/main`, by the name `regime-challenge-r1-preregistration-<date>.md` (`registration`); every leg of the pinned guard (the guard logs it); and every check of steps 2 and 3.
  - *Logged by the seal's claim:* an existing seal (`seal`).
  - *A throw before the seal*, for instance an output directory that cannot be written, is INDETERMINATE (`the run threw`). It writes no refusal line and does not spend the read.
  - *A run that fails after the seal is claimed* leaves the read spent (T3 reading 54).
- **Two clocks,** recorded together in the result as in T3 §1. `registration_landed_at` holds the landing commit's time and the first time the judge's store saw that commit on `origin/main`. `outcome_read_at` is taken after the seal is claimed and immediately before the first outcome computation.
- **After landing,** this file's body is never edited. A change before the read is an appended, dated amendment section (PROCEDURE §8). If a pinned file changes before the read, an appended pin section re-pins it, and the guard keeps the last row for a name (T3 part A1).

## 2. Prior-examination disclosure (PROCEDURE §2)

Everything the author saw before this file landed that bears on the read. Classes: `cardinality` · `coverage ratio` · `inherited` · `seen — not a test input`. Paths under `audits/` in this table are in the private vault unless the row says otherwise.

| # | what was seen | when | class | use |
|---|---|---|---|---|
| E1 | T3's fit result, vault `audits/regime-diag-read-2026-11-16/fit/regime-diag-fit.json`, sha256 `46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312`, and T3's findings, vault `audits/regime-diagnostic-findings-2026-11-16.md` (the fit-window sections and the result lines): the fit-window states, points and intervals of the five answers, the answer-key readings and the component map's rows | after T3's fit read, before this round's spec; this file's author read the findings' result lines and §10 | inherited | the round's dials were chosen on the key readings and the map rows (spec §1). None of their values is named here, and none enters a statistic of the judge |
| E2 | findings §10, the record of T3's one hold-out run: the run claimed T3's seal on 2026-11-16 and then failed (exit 3, `REGIME_DIAG_RUN_VERDICT=INDETERMINATE — the run threw`). No hold-out state, estimate, interval or result file exists. Its outcomes were formed only inside the ended process, and none was written, printed, logged or read | before this file | seen — not a test input | why the judge window's regime outcomes are unread. T3's hold-out stays spent (§7) |
| E3 | T3's label-free tables (Tables 2a–2e, both windows) and its Support stress-test and Identifiability rows, public in T3's registration in this repository | before this file | inherited | this file's support and identifiability rows, cited by table and row; the skeleton check of the judge's frame (§1, step 3). No table is restated here |
| E4 | the frozen census, vault `audits/regime-census-2026-11-16.json`, sha256 `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a` (T3 D2) | before T3 | inherited | panel and weights, read at run time. No census figure and no coin name is in this file |
| E5 | this round's pre-score result, vault `audits/regime-challenge-r1-prescore-2026-11-17.json`, sha256 `3f9402d0f0b6f038b5bcb99c6bcdd9b8fa8b1d809e7aeb6a660866d0a4e3700a`, and its rendered note `audits/regime-challenge-r1-prescore-2026-11-17.md`. Per candidate: the in-sample `ΔΔ1` with its interval and both arms; the guards; coverage; effective clusters, minority shares and bounds; the judge-window power arithmetic; the selection; and the served arm's agreement with T3's fit-window points | run 2026-11-17T02:59:14Z to 03:03:35Z from commit `0dab4aa5991ed2a2785583165338a56ade7ca453`; read by the lead and by this file's author before writing | inherited | carried by sha256 (§10). It decides which challengers are judged, and it supplies each judged challenger's in-sample `ΔΔ1` point to the underpowered label (§5). Nothing else in it enters the judge. It opened 2024-01 … 2025-12 and no other month |
| E6 | the judge's store, made by `challenge-run.ts --init-store` at 2026-11-17T03:18:20Z from commit `0dab4aa5991ed2a2785583165338a56ade7ca453` (exit 0, `REGIME_CHALLENGE_RUN_VERDICT=PASS`): the sha256 of its two manifests | 2026-11-17 | cardinality | the two `store:` rows of §10. A sha256 pass over files, with no frame, label or outcome (ruling 02:23Z). Its archive manifest is byte-identical to T3's |
| E7 | the selection rule (spec §1) and its three bound points (ruling 02:23Z), fixed before E5 ran | before E5 | inherited | §6 |
| E8 | CH1's tests: synthetic series, synthetic archives and a sandbox repository | 2026-11-17 | seen — not a test input | no statistic was computed on a real archive in CH1 |
| E9 | T9's registration, public in this repository. Its window is entries after T3's `T_END` | before this file | inherited | the form of this file. No outcome of this round touches T9's rows |
| E10 | T3 D1: `DECISION-CALL-V2-W4` (odds-v1) read the same months, 2026-01 … 2026-10, once and with no regime conditioning, on eight coins. Its field verdicts are public in `src/lib/pre-trade-odds-calibration.ts` | before T3 | inherited | none of it enters `ΔΔ1` or a guard. No regime-conditioned outcome of these months has been read (E2) |
| E11 | the change to `challenge-run.ts` after the pre-score. The pre-score (E5) and the judge's store (E6) ran at `0dab4aa5991ed2a2785583165338a56ade7ca453`. The change, made before this file landed, touches only the judge's pre-seal `identifiability` line, which now holds the decision's label-only inputs (§5). `prescoreRun` is byte-identical, and so are the judge's result file, its order and its decision | 2026-11-17, after E6 | seen — not a test input | §10 pins `challenge-run.ts` at the changed bytes. The pre-score result stands as carried, because nothing it computes changed |

In this wave the author fetched no kline row, computed no label, skeleton or outcome of 2026-01 … 2026-10, and read no archive of a month after 2025-12. The product's live service computes none of this round's outcomes and writes nothing this round reads.

## 3. Corpus — literal predicate, closed by a clock (PROCEDURE §3)

A row is in the corpus if and only if every clause holds:

```
the row is a kline row of the file  <SYMBOL>-1m-<YYYY-MM>.zip  served at
    https://data.binance.vision/data/futures/um/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-<YYYY-MM>.zip
AND <SYMBOL> = <COIN>USDT for a <COIN> of the census panel (field t3_weights; 15 coins)
AND <YYYY-MM> is one of the 34 months 2024-01 … 2026-10
AND the file is the one T3 read: its name, byte count and sha256 are a row of T3's archive-store
    manifest, pinned in §10 as store:regime-diag-archives.json
AND open_time is a whole minute with  2024-01-01T00:00:00Z <= open_time <= T_END
AND open > 0 AND high > 0 AND low > 0 AND close > 0

T_END = 2026-10-31T23:59:00Z   T3's bound. No month after 2026-10 is opened by this round.
```

**Three uses of the months, and no fourth.**

- *The guard's pass, 2024-01 … 2026-10.* The pinned guard rebuilds T3's archive-store manifest from the archives on disk and compares it with the pin. The manifest holds each file's name, source directory, byte count and sha256, so the pass hashes every file and reads no bar. It is the pass every study of this harness makes (CORRECTION 1).
- *Label-free history, 2025-09 … 2025-12.* These months are opened only because a served call needs the bars before it. The 1d window holds 100 daily bars (T3 §4.1), and 100 days before 2026-01-01T00:00Z falls in 2025-09. No entry, outcome path or statistic lies in them. T3's hold-out frame was built the same way (T3 §3: "a hold-out entry's history may reach into 2025").
- *Outcomes, 2026-01 … 2026-10.* Every entry, every outcome path and every statistic lies in these months.

Code enforces all three: `monthRefusal` and `monthsOpened` (`challenge-spec.ts`), the record loader `recordLoader` (`challenge-guard.ts`), and `windowRefusal` (`challenge-spec.ts`). The tests prove each refusal (`tests/unit/regime-challenge-spec.test.ts`: the judge refuses every month outside 2026-01 … 2026-10; before the window it opens label-free history only; the loader never opens 2026-11; a record of any form throws before it resolves a month after 2026-10).

- **The window.** T3's hold-out window (T3 §3): entries with `2026-01-01T00:00Z <= t` and `t + 72 h <= 2026-11-01T00:00Z`. The frame is T3's hold-out frame. It uses T3's grid and T3's eligibility (T3 §4.2), and the entry draw keeps T3's seed label `20261116`, so the entries are T3's hold-out entries. Its label-free tables must equal T3's hold-out rows of Tables 2a–2e before the seal (§1, step 3).
- **Two denominators.** T3's, unchanged (T3 §3).
- **Drops, by name, never filled.** T3 §3's drops and T3 reading 3's minute-level names apply as registered. The frame is T3's hold-out frame, so its drops are T3's hold-out drops, and the skeleton check holds the frame to T3's tables. The judge's result records the frame's entry count; it does not list the drops. Two exclusions inside the A5 guard are named in §4: runs cut by a window edge (`censored_run`) and runs with no shuffle reference.

**The read procedure.** No step has an earliest date beyond the landing of this file: the window's rows exist, and the guard refuses the read until this file is on `origin/main`.

1. *The store.* The judge's own store was made by `npx tsx src/scripts/regime-challenge/challenge-run.ts --init-store --census <census> --cache <cache> --overlay <overlay> --store <store>`, at commit `0dab4aa5991ed2a2785583165338a56ade7ca453` (§2, E6). It holds the archive-store manifest, the guard's empty-plan store manifest and its plan, and the sha256 of each manifest is a `store:` row of §10. T3's store directory is never named as `<store>`. The only file this round ever writes there is its seal (§7).
2. *The read.* `npx tsx src/scripts/regime-challenge/challenge-run.ts --judge --census <census> --cache <cache> --overlay <overlay> --store <store> --prescore-result <the pinned pre-score result> --out <output directory>`. It runs from a checkout of this repository in which every pinned file hashes to its pin; the commit this file lands on is such a checkout. `<cache>` and `<overlay>` are T3's archive stores (T3 §3). `<store>` and `<output directory>` lie outside the repository. The run reads this file from `origin/main` and hashes the pinned files on disk.
3. *The record.* The read wave puts in its vault evidence the run's stdout (the result line, the result path and the token), the result file's sha256 and the judge store's guard log after the run.

## 4. Methodology — T3's, carried by section, and the round's own

| T3 rule | what it fixes | in this round |
|---|---|---|
| T3 §4.1; T3 readings 4, 5 | the replay: the pinned core called on closed bars aggregated from 1 m rows | unchanged, for the served arm and inside every challenger replay |
| T3 §4.2 | eligible instants and the entry draw | unchanged: T3's hold-out entries, under T3's seed label |
| T3 §4.4 | the 9 shapes, the 5 holds and the path label, on both sides | unchanged |
| T3 §4.5 | rows, the census design weights (`t3_weights`) and the cell-averaged estimator | unchanged |
| T3 §4.6 | coin × UTC-day clusters; the bootstrap resampled inside each coin, `B = 10,000`; percentile bounds; Kish-effective clusters | unchanged, with this round's seed label (below) |
| T3 §4.8, A1 | `Δ1` on TRENDING rows at confidence ≥ 60, 45 cells, both sides | each arm's `Δ1`, under its own label and confidence; `ΔΔ1` is their difference |
| T3 §4.8, A4; T3 §4.9 | `S4 = A − A_0` against key A's hindsight phase | each arm's `S4`; the A4 guard is their difference |
| T3 §4.8, A5; T3 §4.7 (c) | `R5` on uncensored TRENDING runs, against shuffled references | each arm's `R5`; the A5 guard is their ratio |
| T3 §5 | the cluster floor, and the power instrument | unchanged (§5) |
| T3 Identifiability; PROCEDURE §4c | the attainable range of an arm's directional comparison | per arm of each pair (Identifiability) |
| T3 part B3 | the seal has one place | unchanged: this round's seal is `challenge-r1.seal` in that place (§7) |

**Not run here:** T3's comparators (a), (b) and (d), which `ΔΔ1` does not need because its reference is 0 on the same rows; key B; A2 and A3; the secondary family, BH and the sensitivity flags; and every served-only outcome statistic.

**The challengers, as the harness replays them** (`challenger-replay.ts`). Each label goes through the core's own `projectRegime` → `classifyRegime`, so the rule is called and never rewritten.

- **C2.** The core's `computeRegimeIndicators` runs on the call's closed bars, and the price structure is then set to `MIXED`. On a trending row whose served direction came from the price structure, the direction comes from ±DI. An exact ±DI tie there leaves the trending branch, exactly as the served rule treats a ±DI-decided row (`directionFromDI` → `classifyNonTrending`), so the row is not among C2's trending rows. Everywhere else, label and confidence are the served ones. A test proves it: C2 equals the served rule where the structure is neither `HIGHER_HIGHS` nor `LOWER_LOWS`, and elsewhere only the direction differs (`tests/unit/regime-challenge-replay.test.ts`).
- **C3.** There is no replay: C3 is the served label at 1h, on the frame's own 1h rows.
- **C1** (not judged) uses a harness copy of `computeRegimeIndicators` that takes the ADX period. At period 14 it reproduces the served rule label for label, and the judge checks that parity before the seal (§1, step 2).

**The pairs** (`pairOf`, `paired-stats.ts`):

- **C2.** Every row of the frame. The served arm is the rows TRENDING at confidence ≥ 60 under the served label; the challenger arm is the rows TRENDING at confidence ≥ 60 under C2's label. Each arm takes its direction from its own label.
- **C3.** The entries that have a row at all three timeframes, which are map row 12's entries. The challenger arm is their 1h rows TRENDING at confidence ≥ 60, and the served arm is their 4h rows TRENDING at confidence ≥ 60.

**The paired statistics.** Both arms are recomputed on every resample of the same coin × UTC-day clusters (T3 §4.6), and each statistic is reported as one paired quantity.

- **`ΔΔ1`, the primary:** `Δ1(challenger arm) − Δ1(served arm)`, in pp. `Δ1` is T3 §4.8's A1 primary on that arm's rows: the cell-averaged `x1 = I_T(with) − I_T(against)` over the 45 cells, under the census weights. A cell of a row is excluded where either side is excluded by `both_touch` (T3 §4.4).
- **A4 guard:** `S4(challenger arm) − S4(served arm)`, in pp. Each arm's `S4` is read on that arm's TRENDING rows at any confidence whose last closed bar has a dated key-A phase (T3 §4.8, §4.9). For C3 these are the 1h rows and the 4h rows of the three-timeframe entries.
- **A5 guard:** `R5(challenger arm) ÷ R5(served arm)`. Each arm's `R5` is T3 §4.8's ratio on the uncensored TRENDING runs of that arm's per-closed-bar series inside the window. For C2, the series are C2's labelled series and the served series, at all three timeframes. For C3, they are the 1h series and the 4h series, at every close in the window: this is a bar-level statistic, not limited to the entries. Each arm's shuffle references come from its own 1,000 block shuffles (T3 §4.7 (c)). A run cut by a window edge is excluded (`censored_run`, T3 §4.8), and so is a run that no shuffle gave a reference; the reading's row count is the referenced runs of both arms. The bootstrap resamples the union of both arms' clusters together; a run's cluster is the coin × UTC day of its first close.
- **Coverage guard:** the challenger arm's design-weighted share of TRENDING ≥ 60 rows among the rows that arm has, divided by the served arm's share. For C2, both arms have every row of the frame. For C3, the shares are taken over the 1h rows and the 4h rows of the three-timeframe entries. The guard reads labels only.

**Intervals.** The bounds are T3 §4.6's percentile bounds at one-sided 2.5 % (`ci_lower`, `ci_upper` of `src/scripts/cluster-perm-stats.py`), so a pair of bounds is a two-sided 95 % interval. A statistic with any undefined bootstrap replicate has no interval: its bounds are undefined.

**Seeds.** Every resample stream of this round is `arm_seed('regime-challenge-r1', <name>)` of `cluster-perm-stats.py`. The names are `challenge-r1|<challenger>|ddelta1|bootstrap`, `challenge-r1|<challenger>|a4|bootstrap`, `challenge-r1|<challenger>|a5|bootstrap`, `challenge-r1|<challenger>|a5|shuffle` and `challenge-r1|served|a5|shuffle`. The entry draw keeps T3's derivation and label (T3 §4.2), which is why the frame is T3's.

## Answer-key ceiling (PROCEDURE §4d)

The answer keys are T3's (T3 Answer-key ceiling, §4.9, §4.10, parts B1, C1 and C2). The table is reproduced as T3 registered it; "§4.1", "§4.9" and "§4.10" in its cells are T3's sections. T3 read the key ladder once, in its fit window, and those readings stand in T3's fit result (§2, E1). This round scores no key and reads no ladder: a diagnosis of `NO_ROOM`, `INPUTS` or `LAG` is a fit-window reading of T3, and the judge does not reopen it. The round's dials were chosen on those readings and on the map rows. The judge asks one thing of each judged challenger: does it do better than the served rule, paired, on rows nobody has read? It diagnoses nothing. Key A enters the read in one place, as the hindsight dating inside the A4 guard (T3 §4.8).

| key | role | construction | reading if it fails |
|---|---|---|---|
| A | CEILING | the trend dated in hindsight from bars on both sides of each call: Pagan–Sossounov turning points with a Lunde–Timmermann filter on closed-bar log closes, window 7 bars, threshold 6σ of that coin × timeframe (§4.9); its volatility leg is the true range of the 14 bars after the call | NO_ROOM: with the true phase in hand the statistic still does not clear its baselines, so there is nothing to find and no change to the rule can help |
| B | NO_LAG | the pinned core, unchanged, on a window that ends 14 bars after the call, so it sees bars after the call (§4.10) | INPUTS: the ceiling wins and the rule's own inputs cannot reach it even without lag, so the inputs are the defect |
| S | SERVED | the label a caller would have received at the call: the pinned core at rule version 2 on closed bars (§4.1) | LAG: the inputs carry the answer when they may look ahead and the live label does not deliver it, so the lag is the defect |

Diagnoses: `NO_ROOM` (CEILING fails), `INPUTS` (CEILING wins, NO_LAG fails), `LAG` (NO_LAG wins, SERVED fails).

## Component map (PROCEDURE §4d)

The component map is T3's (T3 Component map, §4.11, part B2). The table is reproduced as T3 registered it; in its cells `θ`, `Δ1`, `S2` and "after BH" are T3's (T3 Component map, first paragraph; T3 §4.8, §4.11). T3 read it in its fit window only, and each row's state stands in T3's fit result (§2, E1). This round recomputes no row. Its three challengers change the dials of rows 1, 8 and 12, and only those; the dial of every other row is the served one in both arms. A judged state changes no row's state: a `WINS` is promotion input for Mr.1 (§6), not a map reading.

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

C3's primary is row 12's first contrast with its sign reversed (1h minus 4h), on row 12's entries. Rows 10 to 12 name constants outside the core, in `src/lib/pre-trade-rules.ts` and `src/tools/get-market-regime.ts` (T3 §8, correction 1). Both files are cited, not pinned (§10). C3 uses the frame's 1h rows and imports neither file.

## 5. Floors, N and power (PROCEDURE §5)

- **Independence unit and floor.** T3 §5, unchanged. The unit is the coin × UTC-day cluster. The floor is 50 Kish-effective clusters (`FLOOR_CLUSTERS`, read from `cluster-perm-stats.py` at run time), counted under the design weights on each arm's `ΔΔ1` rows. There is no row floor. The guards carry no cluster floor of their own, because the spec registers none; §6 says how a guard on few clusters reads.
- **N.** The entries are T3's hold-out entries (T3 §4.2; Table 2c, hold-out row).
- **Checked before outcomes.** Before the seal, the harness computes on the realized frame, under the design weights, each arm's effective clusters and its minority share, and the share's §4c bound through `attainable_bound_from_share` of `ops/monitoring/population_comparison.py`. It does this for both arms of every judged pair, and from these it decides each challenger's identifiability (§6, step 1).
- **What is on disk before the seal.** The guard log's `identifiability` line is written before the seal is claimed. Beside the two floors (`floor_clusters`, the cluster floor, and `floor_pp`, the 3.0 pp attainable floor) it holds, for each judged challenger: `identifiable`; for each arm, `challenger` and `served`, its Kish-effective clusters (`eff`), its minority share (`share`) and its §4c bound (`bound`), each null where it is undefined; and the coverage ratio (`coverage`). These are the values the decision uses: the same support object decides `identifiable`, and the same ratio decides the coverage guard. Every one of them is computed from labels, and none reads an outcome. A test proves that the line precedes the seal and equals the decision's inputs (`tests/unit/regime-challenge-run.test.ts`). The window is not an accruing corpus, because its label-free frame must equal T3's registered hold-out tables before the seal; the challenger arms' rows are not rows of those tables, and this line puts their support on record before any outcome.
- **The instrument** is T3 §5's: `SE = h / 1.96`, and the detectable effect at 80 % power and a one-sided 2.5 % level is `2.80 · SE`. At the judge, `h` is half the width of the judged challenger's `ΔΔ1` interval in the read, `(UB − LB) / 2` at the plain one-sided 2.5 % bounds. The effect tested is half that challenger's in-sample `ΔΔ1` point, carried by the pinned pre-score. The multiple is `(2.80 · SE / |effect|)²`, and the challenger is underpowered when the multiple is above 1. With no interval, or no finite carried point, no power is computed.

**The underpowered expectation, registered before the read.** At CH2, T3 §5's instrument was applied to each candidate's in-sample `ΔΔ1`: `h` of the in-sample interval, scaled by `sqrt(D_pre / D_judge)` in coin-days at about 450 coin-days a month (24 months in sample, 10 at the judge), and tested at half the in-sample point. It flagged both judged challengers, C2 and C3, as underpowered on the judge window. Their multiples are in the vault (§2, E5); no figure is given here. §1's selection rule does not read power, and the decision rule already has an underpowered branch, so the judge proceeds (ruling 03:08Z). A non-`WINS` result is therefore expected to read `KEEP — underpowered`. The expectation is not a rule: the label is decided at the read by §6, on the read's own interval. Nothing is respecified on this account (T3 §7).

**The underpowered branch, registered.** A `KEEP` whose `ΔΔ1` interval reaches 0 while the instrument says the challenger is underpowered is reported as `KEEP — underpowered`, with the instrument's figures beside it in the result. That is a live outcome of this design, not a failure of the read. What resolves it is a later registration on rows nobody has read. This read is not extended and not repeated.

## Support stress-test (PROCEDURE §4)

Every registered check, the point at which it is evaluated, and what is known of the support there. 2026's label-free support of the served rule is T3's, registered in T3 §2 (Tables 2a–2e, hold-out rows) and cited here by table and row, not restated. No challenger label of 2026 has been computed (§1), so a challenger arm's occupancy is known only from T3's tables, as a bound or a proxy. A check whose support is known only at the read has the verdict `floor`.

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| C2's primary `ΔΔ1` | each arm's TRENDING rows at confidence ≥ 60 on the judge window's entries, 45 cells, both sides: the served label, and C2's label (direction from ±DI) | the served arm is T3's hold-out row set "TRENDING, confidence ≥ 60" (Table 2d), with both directions occupied (T3 Identifiability, row 2). C2's arm is the same rows less exact ±DI ties among the rows whose served direction came from the price structure. Its direction differs from the served one only on the hold-out `disagree` rows of Table 2e | floor — each arm's Kish-effective clusters and §4c bound are computed on the realized frame under the design weights before the seal. Either arm below 50 clusters or below 3.0 pp makes C2 `NOT_IDENTIFIABLE` (§6) |
| C3's primary `ΔΔ1` | the entries with a row at all three timeframes; their 1h rows (challenger) and 4h rows (served) TRENDING at confidence ≥ 60; 45 cells, both sides | the entries are T3's hold-out entries also eligible at 1d (Table 2c). The hold-out row set "TRENDING, confidence ≥ 60" has rows at 1h and at 4h (Table 2d), and both directions occur at both timeframes (Table 2a). The restriction to three-timeframe entries is not tabulated | floor — as for C2 |
| Holm's family | C2 and C3, as the pinned pre-score lists them | the pre-score's judged list is C2, C3 (§2, E5), and the judge accepts the pre-score only by the sha256 of §10 | inside — the family has two members whatever either one reads |
| A4 guard | each arm's TRENDING rows at any confidence whose last closed bar has a dated key-A phase (for C3, the 1h and the 4h rows of the three-timeframe entries) | the dated shares and up-phase shares of closed bars in T3's hold-out (T3 Support stress-test, A4 primary row; Table 2b). The joint count with each arm's rows was not probed | floor — no cluster floor of its own. The guard fails only on an interval wholly below −3.0 pp; with no interval it is `unreadable`, which is not a hold |
| A5 guard | the uncensored TRENDING runs of each arm's per-closed-bar series inside the window: C2's series and the served series at all three timeframes; for C3, the 1h series and the 4h series | the TRENDING bar closes of T3's hold-out, by timeframe (T3 Support stress-test, A5 primary row; Table 2a). Runs were not counted | floor — a run cut by a window edge (`censored_run`) and a run with no shuffle reference are excluded; the reading's row count is the referenced runs. An undefined replicate makes the guard `unreadable` |
| coverage guard | the design-weighted share of TRENDING ≥ 60 rows among each arm's rows, challenger over served (C2: every frame row for both arms; C3: the 1h and the 4h rows of the three-timeframe entries) | label-only; the rows are those of the two `ΔΔ1` checks above | inside — computed from labels, and on disk before the seal (the `identifiability` line, §5); the guard fails below 0.5, and a ratio that cannot be formed is `unreadable` |
| the underpowered label | a judged challenger that is not `WINS` and whose `ΔΔ1` interval reaches 0 | T3 §5's instrument on the read's half-width, at half the in-sample point the pinned pre-score carries | inside — a label on `KEEP`; it changes no other state |
| the frame | the judge window's label-free frame: T3's grid, T3's eligibility, and the entry draw under T3's seed label | T3 registered the hold-out rows of Tables 2a–2e before either of its windows was read | inside — before identifiability and the seal, a frame whose tables differ refuses the read (leg `skeleton`), and a window with no entry is INDETERMINATE |
| the months | every entry and the end of its 72 h path; every archive opened | outcomes 2026-01 … 2026-10; archives 2025-09 … 2026-10, before 2026-01 as label-free history; the guard's sha256 pass over 2024-01 … 2026-10 reads no bar (§3) | inside — a frame with an entry or a path end outside 2026-01 … 2026-10 refuses (leg `window`), and the loader opens no other month |
| history depth | 10,080 unbroken minutes before an entry for the 1h and 4h labels, and 144,000 for the 1d label | the loader opens from 2025-09, the first month a call in the window can need (§3). T3's hold-out frame has the same depth (Table 2c, hold-out row) | inside — otherwise the drops `short_history` and `no_1d_history` apply by name, and a frame that differs from T3's tables is refused |
| challenger parity | T3's core-parity fixture, replayed under the served dial through C1's copy | the fixture is a pinned harness file (§10) | inside — a mismatch refuses before the seal (leg `parity`) |

## Identifiability (PROCEDURE §4c)

A floor on a directional comparison is bounded by the side mix of the arm it constrains (T3 Identifiability). Spec §1, step 1 compares each arm's bound with the floor of 3.0 pp before any outcome. Each `ΔΔ1` row below constrains one arm of one judged pair, so the narrower arm binds. The A4 guard's line, −3.0 pp on a difference of two excesses over each arm's mix-matched chance agreement, constrains each arm too. `S4`'s attainable range is twice the smaller of the arm's label-direction minority share and its phase minority share, so its rows take the smaller one. No challenger label of 2026 exists, so each share below comes from T3's tables. The class is `inherited`, and a share is marked as a lower bound where T3's tables bound it, or as a proxy where they do not.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| C2's `ΔΔ1`: each arm's `Δ1` against its fixed-side callers (T3 §4.8, A1, comparator (d)) | served: TRENDING at confidence ≥ 60, every timeframe, the judge window | 0.4999, inherited: T3's hold-out share of this row set (T3 Identifiability, row 2); probe: T3's skeleton count of TRENDING_UP and TRENDING_DOWN rows (Table 2d) | 3.0 | 99.98 | IDENTIFIABLE |
| C2's `ΔΔ1` | challenger: the same rows under C2, direction from ±DI | 0.3656, a lower bound from T3's tables: the row above's share, at the low end of its rounding, less the share of the hold-out `disagree` rows of Table 2e summed over the three timeframes (at any confidence, a superset of this row set's), which are the only rows whose direction C2 can change. Exact ±DI ties, which leave this arm, are not in T3's tables; probe: Tables 2d and 2e | 3.0 | 73.12 | IDENTIFIABLE |
| C3's `ΔΔ1`: each arm's `Δ1` against its fixed-side callers | served: the 4h rows TRENDING at confidence ≥ 60 of the three-timeframe entries | 0.4840, a proxy, not a bound: the minority share of TRENDING_UP and TRENDING_DOWN closed bars at 4h in T3's hold-out, at any confidence; probe: Table 2a | 3.0 | 96.80 | IDENTIFIABLE |
| C3's `ΔΔ1` | challenger: the 1h rows TRENDING at confidence ≥ 60 of the same entries | 0.4674, a proxy, not a bound: the same share at 1h; probe: Table 2a | 3.0 | 93.48 | IDENTIFIABLE |
| C2's A4 guard: each arm's `S4` against its mix-matched chance agreement | served: TRENDING rows at any confidence with a dated phase | 0.4477, inherited: T3's smallest up- or down-phase share of dated bars over timeframes × windows (T3 Identifiability, row 5), which is below this row set's label share (Table 2d, hold-out TRENDING); probe: Table 2b | 3.0 (the guard's line is −3.0 pp) | 89.54 | IDENTIFIABLE |
| C2's A4 guard | challenger: the same under C2 | 0.4104, a lower bound on C2's label share of all hold-out TRENDING rows (Table 2d's share at the low end of its rounding, less the share of Table 2e's hold-out `disagree` rows), which is below the phase share. The dated subset is not tabulated; probe: Tables 2b, 2d and 2e | 3.0 (the guard's line is −3.0 pp) | 82.08 | IDENTIFIABLE |
| C3's A4 guard | each arm: the 1h and the 4h TRENDING rows at any confidence, dated, of the three-timeframe entries | 0.4477, inherited: the phase share as above, which is below both arms' bar-level label shares at 1h and 4h (Table 2a); probe: Tables 2a and 2b | 3.0 (the guard's line is −3.0 pp) | 89.54 | IDENTIFIABLE |

The shares above are unweighted, and each comes from T3's tables. For the four `ΔΔ1` rows, the decisive check is the harness's. Before the seal it recomputes each arm's share under the design weights on the realized frame, and its bound through `attainable_bound_from_share`, and it writes both in the pre-seal `identifiability` line (§5). An arm whose bound is below 3.0 pp, or that has no TRENDING ≥ 60 row at all, makes its challenger `NOT_IDENTIFIABLE` (§6). The A4 guard's three rows are checked here only, because the pinned harness does not recompute `S4`'s attainable range before the read. A guard whose range could not reach its line would hold by construction, since it can block a `WINS` only by failing; these rows are what shows that the guard can fail. A5's line is a ratio of unsigned quantities and the coverage line is a ratio of row shares. Neither follows a side mix, so neither has a row here (T3 Identifiability).

## 6. Decision rule (PROCEDURE §6)

Each judged challenger is decided in this order (spec §1; `decisionOf`, `challenge-run.ts`):

1. **`NOT_IDENTIFIABLE`** — either arm of its pair has fewer than 50 effective clusters, or either arm's §4c bound is below 3.0 pp (§5; Identifiability). This is decided before the seal. The challenger's `ΔΔ1`, A4 and A5 readings are then not computed; its label-only coverage ratio is still reported.
2. **`WINS`** — Holm's step-down clears 0 for its `ΔΔ1` (below), and every guard holds.
3. **`KEEP`** — anything else. A `KEEP` whose `ΔΔ1` interval reaches 0 (`LB ≤ 0 ≤ UB` at the plain one-sided 2.5 % bounds) while §5's instrument says the challenger is underpowered is **`KEEP — underpowered`**. A `KEEP` with no interval, with an interval wholly below 0, or with one wholly above 0 without a `WINS` (Holm did not clear it, or a guard failed or could not be read), is plain `KEEP`.

**Holm, exactly.** The family is {C2, C3}, as the pinned pre-score lists them, so `m = 2` whatever either member reads. For each member, `p = (1 + #{replicates ≤ 0}) / (1 + B)` over its `ΔΔ1` bootstrap replicates. A member with no replicate, or with any undefined replicate, has an infinite `p`. The members are ordered by `p`; an exact tie keeps the listed order, C2 before C3. The first member tested is tested at `α / 2` and the second at `α`, with `α = 0.025` one-sided. A member clears 0 when the percentile lower bound of its replicates at its level is above 0 and every member tested before it cleared. The first that does not clear stops the rest. Holm reads `ΔΔ1` alone: a guard decides only its own challenger's `WINS`, and it never stops the step-down.

**The three points bound at 2026-11-17T02:23Z**, before the pre-score ran:

- **An unreadable guard does not hold.** At the pre-score, a challenger with such a guard was `KEEP (pre-score)`. At the judge, it cannot be `WINS`.
- **A judged challenger that is `NOT_IDENTIFIABLE` stays in Holm's family and rejects nothing.** Its `p` is infinite, so it is tested last, it clears nothing, and it still counts in `m`.
- **On an exact tie of C1's `ΔΔ1` points, period 7 (listed first) goes forward.** This governed the pre-score's selection within C1. C1 is not judged.

**The guards.** Each guard's bounds are the plain one-sided 2.5 % bounds, not Holm-adjusted.

- The A4 guard fails when its interval lies wholly below −3.0 pp (`UB < −3.0`).
- The A5 guard fails when its interval lies wholly below 1/1.10 (`UB < 1/1.10`).
- The coverage guard fails when its ratio is below 0.5.
- A guard with no interval, or with no ratio, is `unreadable`, and an unreadable guard does not hold.
- A guard read on few clusters has a wide interval and so tends to hold. That is the registered rule: the guards stop a `WINS` that would cost on another answer, and `WINS` itself still needs Holm.

| state | what it says | the paired estimate under it |
|---|---|---|
| WINS | on rows nobody had read, the challenger's `Δ1` exceeds the served rule's on the same entries, under Holm over the family, and it costs nothing a guard measures. It goes to Mr.1 through Extra gate 2; nothing is served on this file or on the read | `ΔΔ1`'s interval wholly above 0 at Holm's level; every guard holds |
| KEEP — underpowered | the read could not have detected half the in-sample point; the served dial stays for round 1 | `ΔΔ1`'s interval reaches 0, and the multiple of §5 is above 1 |
| KEEP | the served dial stays for round 1 | anything else that is not `NOT_IDENTIFIABLE` |
| NOT_IDENTIFIABLE | an arm had too few effective clusters, or an attainable range below 3.0 pp. Decided before any outcome | none: no paired outcome is computed |

The result is the file `regime-challenge-r1.json`, and it carries one line:

```
REGIME_CHALLENGE_VERDICT=C1:KEEP (pre-score);C2:<state>;C3:<state>
```

For each judged challenger the result holds its state and cause; `ΔΔ1` as a paired reading (point, bounds, the rows, clusters and effective clusters of the union of both arms, the replicate count and the undefined replicates); Holm's rank, level, bound and decision; the A4 and A5 paired readings with each guard's state; the coverage ratio with its state; the carried in-sample point; and §5's power. It holds no arm's own value and no served-only key: a test proves this (`tests/unit/regime-challenge-run.test.ts`). What follows from a state beyond §6 is not decided here.

## 7. The post-result respecification test (PROCEDURE §7)

T3 §7 applies unchanged. After the read, any proposed change to a statistic, a row set, a guard or its line, a weight, a cluster definition, a constant, the family, the window or the read is put to T3's question: would this have been proposed had the check passed?

- If not, it is a correction. It is registered in a new file and applied only to rows nobody has seen.
- **The read is spent by one run.** The seal is the file `challenge-r1.seal` in the seal's one place (T3 part B3): `<home>/.cache/algovault/regime-diag/store/`, with `<home>` the account's home directory from the OS user database, not from `HOME`. It sits beside T3's `holdout.seal` and beside T9's `confirm.seal` once that is claimed, and it neither reads nor replaces either. No store argument moves it, so no second store reopens the read. A run that fails after the seal is claimed leaves the read spent (T3 reading 54). The seal's scope is T3 part B3's: a file under one account on one machine. A test proves the seal refuses a second claim whatever store or output it names (`tests/unit/regime-challenge-run.test.ts`).
- **T3's spent hold-out stays spent.** T3 §7 says that "no respecification reopens it", and this read is not a read of T3. It computes the served arm only as one side of a pair. No served-only outcome statistic on 2026 is written, printed or reported. The one served-arm quantity on disk is the pre-seal `identifiability` line (§5): the served arm's effective clusters, minority share and §4c bound, which are label-only, read no outcome and are no state of a T3 answer. Nothing in the result is read as a state of a T3 answer. T3's fit-window states stand. T3's hold-out states do not exist (§2, E2), and nothing here creates one.
- **This round is not a respecification of T3.** It changes no statistic, comparator, floor, cell or state of T3. It asks a different question: does a one-dial change beat the served rule, paired, on the same entries?
- **T9 is untouched.** T9's window is entries after T3's `T_END`, and this round opens no month after 2026-10.
- **The judge window stands in for "live bars registered before they arrive"** (the T6 task's words; lead decision, recorded in the arc). Undoing that decision before the read means an appended amendment that moves the read to a forward window.
- A defect found before any outcome exists is fixed, and recorded as an appended amendment, before the read (T3 §7).

## 8. Deviations, quarantine, publication (PROCEDURE §8)

- A deviation from this file is recorded with its reason: before the read as an appended amendment here, during the read in the result. It is never absorbed.
- **Figures are vault-only.** Every figure of the read, of the pre-score and of T3 goes to the private vault. This repository receives none: not under `audits/`, not in a fixture, not in a commit message.
- **Publication.** None. A `WINS` is promotion input for Mr.1 (Extra gate 2). It changes no public copy and no served rule.
- **No census figure in this repository.** The panel's coin names, its weights and every figure derived from the weights stay in the vault. This file cites the census by path and sha256, and the harness reads it at run time.

**Where this file completes or departs from the wave spec.**

1. *The directory.* The five source files live in `src/scripts/regime-challenge/` (ruling Q1 → A, 02:23Z). Spec §4 names them under `challenge/`.
2. *The history months* (CORRECTION 1). The read opens 2025-09 … 2025-12 as label-free history, and the pinned guard's sha256 pass covers 2024-01 … 2026-10 (§3). Spec §3's month rule and spec §7's checklist item read accordingly: the judge reads no outcome outside 2026-01 … 2026-10, and opens no archive outside 2025-09 … 2026-10 apart from that sha256 pass.
3. *`REQUIRED_PINS`* (CORRECTION 2). The pinned guard asks for `HARNESS_FILES` alone. The judge itself refuses a registration that does not pin this round's five files and the fourteen modules outside the harness list (§10).
4. *The tables row.* T3's registration is a pin of this file, not a citation as in T9, because the judge checks its frame against T3's Tables 2a–2e and refuses tables that are not pinned.
5. *The judge's store* was made in this wave by `--init-store` (ruled ahead at 02:23Z). Its archive row equals T3's pin, and its guard-store row is pinned as the run printed it (§10).
6. *The challenger arms' identifiability* rests on bounds and proxies from T3's tables, because no challenger label of 2026 exists (Identifiability). The harness's recompute before the seal decides.
7. *The pre-seal record.* The judge's `identifiability` line holds, beside the two floors, each judged challenger's `identifiable`, each arm's effective clusters, minority share and §4c bound, and the coverage ratio (§5), all label-only. The line was extended in this wave, before this file landed (lead's ruling of 2026-11-17T04:19Z, 12:19 local), so the decision's label-only inputs are on disk before the seal (PROCEDURE §4). The change touches only that line of the judge. `prescoreRun` is byte-identical, and the pre-score ran at `0dab4aa5991ed2a2785583165338a56ade7ca453`, before the change (§2, E11).
8. *The A4 guard's identifiability* is checked at declaration only (Identifiability).
9. *Seeds.* Resamples use the label `regime-challenge-r1`. The entry draw keeps T3's label, so the frame is T3's hold-out frame (§4).
10. *Names.* The spec names no result line, result file or seal name for the judge. They are `REGIME_CHALLENGE_VERDICT`, `regime-challenge-r1.json` and `challenge-r1.seal`.
11. *Holm's construction.* Spec §1 says "Holm across the challengers judged". This file states its order statistic, its tie rule and its rejection bound (§6).
12. *The file-name date* is the local date (+0800). The UTC time of writing is in the header.

## 9. Owner, the read, and the inheritors (PROCEDURE §9)

- **Owner** of this registration and of round 1's records: `EDGE-REGIME-CHALLENGE-R1-W1`.
- **The read:** a later wave of T6 round 1 (the spec's W2), once, under this file and its appended amendments.
- **Inheritors,** within ARC-REGIME-ACCURACY: Extra gate 2 (promotion of a `WINS`, Mr.1's decision); T6 rounds 2 and 3, which add records to the same module and register under PROCEDURE §4d; and every inheritor T3 §9 names, each of which reads this round's states beside T3's.

## 10. Pinned artifacts

The sha256 of the file bytes at commit `0dab4aa5991ed2a2785583165338a56ade7ca453`, the commit on which this round's harness landed (CH1). The one exception is `src/scripts/regime-challenge/challenge-run.ts`, which is pinned at the bytes committed together with this file: its judge writes the pre-seal line of §5 (§2, E11). Each pinned file is byte-identical on the `origin/main` commit this file lands on; that is re-checked immediately before landing. `pinsOf` (`src/scripts/sr-backtest/guard.ts`) reads every row whose first cell is a backticked name and whose second cell is a backticked sha256, and it keeps the last row for a name. The pinned guard holds file rows to their bytes on disk: first every row of `HARNESS_FILES`, then every row whose name carries none of the prefixes `store:`, `census:`, `spec:` or `carry:`. A pinned file that differs by one byte refuses the read.

**This round.** The five files of `src/scripts/regime-challenge/`, each new in this wave (`REQUIRED_PINS`).

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-challenge/challenge-spec.ts` | `51d403b6e7205213ff4465538007601f0f41efaa61f53f59ad08e9d617949a28` | the candidates and dials, the two records and their months, the month and window refusals, `REQUIRED_PINS`, the judge's study record |
| `src/scripts/regime-challenge/challenger-replay.ts` | `c2caef1010588d46f29811a28905ef5e6a5f1545ed68fa7de66737e188ad8961` | the challenger replays and C1's parity check |
| `src/scripts/regime-challenge/paired-stats.ts` | `02726151327525c3206a76c5e49b85eb06c84edfa7365487d610ff9c3f4151ba` | the pairs, the paired statistics, coverage, identifiability, the guards, Holm and power |
| `src/scripts/regime-challenge/challenge-guard.ts` | `071919eeb23192592591a7e2c6f2bac5f8cf3c892ebf6686746432c1880761b7` | the record loader, the archive and skeleton checks, the landed source, the registration on `origin/main` |
| `src/scripts/regime-challenge/challenge-run.ts` | `75b455ecc4a34d383c20da5eb87c7d78dbee50d6dfea122f2170596223d84bae` | the CLI: the pre-score and its selection, `--init-store`, the judge, its refusals, its order, its pre-seal `identifiability` line and its result. Pinned at the bytes committed with this file; the pre-score ran on the earlier bytes at `0dab4aa5`, and the change touches only the judge's pre-seal line (§2, E11) |

**The harness.** Every file of the harness's own list (`HARNESS_FILES`), as the pinned guard asks for it. Each is byte-identical to its last pin in T9 (T9 §10 and amendment 1, part G5).

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-diag/archive.ts` | `0d2891b4469dabae7b98b1c68332ae0a18ef37a471a305e14882434c4e09ca43` | the 1 m archive reader, the minute grid, the bars, the archive-store manifest |
| `src/scripts/regime-diag/bars.ts` | `9aa62d3d082e76516b399dfd3d92c9e87c29f708185be84e124dc1dc52ff7687` | the bar sequences and the runs of A5 |
| `src/scripts/regime-diag/decide.ts` | `19bc12aa756b3c8312873c6104733968f8f7154affa104fe74e96f7d124b89d6` | T3's decision rule; not called by this round |
| `src/scripts/regime-diag/diag-spec.ts` | `f9b83db8f7c338ad6e4c65088266d7c1e78172f15ba2ec3fa1d3dd2044de0686` | the registered constants: the grid, the windows, the floors, the counts, the seed label, the last month |
| `src/scripts/regime-diag/engine.ts` | `bd28d8f31cd77848890126431da31acec2d67e1c7b7343239db73154d02a0cf0` | clusters, the cluster bootstrap, the block shuffle, the paired contrast |
| `src/scripts/regime-diag/frame.ts` | `bac646463ef8dba1d74b19c192e82561b1ccdf9d5a8a5a2c526ac5b6295a72f2` | the frame of a window, the skeleton tables, the census reader |
| `src/scripts/regime-diag/guard.ts` | `0c0a9bd5a87bff0aa9955748b66af920f7c52a92c2fdb8a7e176b53fdf0ea3c8` | the pinned guard, `--init-store`'s manifests, the seal home and the seal |
| `src/scripts/regime-diag/keys.ts` | `d5a77768ff2f9bfc03f545b84579ff38d9f8edfec0e17e996e7f1e828efcd9c5` | key A, the dating inside the A4 guard |
| `src/scripts/regime-diag/labeler.ts` | `b14b0e93e9ce82b40a9d6d1e0a2c9d921b8fd9d4e5bdb889ea2a30d41493f742` | the entry draw and the 1 m path label |
| `src/scripts/regime-diag/mutate.ts` | `c934e569674626816a1e6ca438a3b32e28045678296f86c152da6846fa8f6eca` | the test-only mutation lever; the guard refuses when it is set |
| `src/scripts/regime-diag/parity.ts` | `b67ba354d06e7938b4e236e75ed2b0a3edcff751147acf64773501bbcf9fc223` | the core-parity check |
| `src/scripts/regime-diag/prims.ts` | `285e75bcb50f902346577730aae788ce38e8284be84133f9bd42a1dc601216cb` | the bridge to `scripts/regime-diag/prims.py`: seeds, bounds, Kish, the attainable bound, the floor |
| `src/scripts/regime-diag/probe-absent.ts` | `468469b51e0cb9033e0e4bc1d60042c325ada3c3ab95b42ec57287de9399f913` | T9's absence probe; not used by this round |
| `src/scripts/regime-diag/replay.ts` | `21f18c3a5c15704d67828d09d80419f2ef2415c294a7d57bff0c8e12a8ab40a5` | the replay: the candle window at an instant, the served series |
| `src/scripts/regime-diag/rng.ts` | `0600473fab31d7e5ac65c7067a16a6250a6378a97cd99e09edfb732809dbe01e` | the seeded streams |
| `src/scripts/regime-diag/run.ts` | `cfe2b5a8835ee20f7cd194968f7733cb1197843e1263b7bbe3c1dc79315ffc0b` | T3's and T9's run CLI; not called by this round |
| `src/scripts/regime-diag/stats.ts` | `0526b8e7f5ce9d0844da6fed2b8d78db51c91d4d36aee2e021963f44dd047fb1` | `Δ1`, `S4` and the trending directions each arm reads |
| `src/scripts/regime-diag/synth.ts` | `c53c571f1962e9b9f665fd9d8456c190d458d46e63f3daefd3e78b38a4b5afa1` | the synthetic series the core-parity fixture replays |
| `scripts/regime-diag/prims.py` | `3380b3e600b59db58e3b56ef6357a6331a6bade1563bd08a6987f2a349f68f25` | calls the pinned primitives of `cluster-perm-stats.py` and `population_comparison.py`; no statistic of its own |
| `tests/fixtures/regime-diag/core-parity.json` | `75026a14853b8043fed4755a1550a84cfe1e702c5f715984aa65fdf491e4b9a7` | the core-parity fixture |

**Outside the harness.** The fourteen modules of `REQUIRED_PINS` outside the harness list, which are the fourteen T3 §10 pins. Each is byte-identical to T3's pin of it. Twelve are in the judge's import closure. `venue-fees.ts` and `funding-venues.ts` are not: they hold the source of the harness's registered fee constant (T3 §4.7 (a)), and they are pinned as T3 pinned them.

| pin | sha256 | role |
|---|---|---|
| `src/lib/market-regime-core.ts` | `6cbf10ed4ac5846fa590fa31051a9879c1e22b63f7d65d4ff68731207d4c4004` | the rule under study, rule version 2: `computeRegimeIndicators`, `projectRegime`, `classifyRegime` |
| `src/lib/indicators.ts` | `484c44a6f870e3655fbe28bffe5c3cce49a4feac9ce1488e71a64bda2cca0157` | ADX, ATR, the price structure |
| `src/lib/candle-window.ts` | `19a59198c980e816587e9acd20035eb6441e952ef0a286cfce5249a3694ce8d0` | the closed-basis window split |
| `src/lib/candle-guard.ts` | `aae23242f8e70484d43677db1af03b507fe4fde1bfae8cfcbbaad7cc733177f0` | interval arithmetic of the core |
| `src/lib/serving-windows.ts` | `592caa34ce46acf2470c50970888ece2134bc98add4aa096ab716ed14384ae25` | `CANDLE_COUNTS` |
| `src/lib/errors.ts` | `7539e6060ddd32dde5fe09145490419c6f413c250215d07960299dca8be6f99f` | the core's refusal type |
| `src/lib/pre-trade-calc.ts` | `e6e2c5d5caccda18ef85ffb75d1f609aa430d8cb91e136354a530ba44b63e1f5` | `sigma1hFromVolatilityRatio`, `noEdgeOdds`, `ATR_RANGE_PER_SIGMA` |
| `src/lib/pre-trade-odds-calibration.ts` | `d6b1d65ba862f146fb6316b48f0c52c99ca3cd5bab26f7493a9eb19dfb6971a1` | odds-v1, reached through `noEdgeOdds` when the frame's cells are labelled; `ΔΔ1` does not read it |
| `src/lib/venue-fees.ts` | `c34a314208b4275947606eb253529d9d35fdc3397d245a7d17114a05f191f726` | `takerFeeBps`, the source of the registered fee constant (T3 §4.7 (a)) |
| `src/lib/funding-venues.ts` | `1c5e3ff154e56a98cfa67b064a8945de78d69b3f46076d5d7fbc65627ce20076` | the venue fee table read by `takerFeeBps` |
| `src/scripts/cluster-perm-stats.py` | `6d82c1601a9ce1121deecaa1c88ac4685abef328ff27d35047fad37d69f60100` | `arm_seed`, `ci_lower`, `ci_upper`, `kish_eff`, `FLOOR_CLUSTERS` |
| `ops/monitoring/population_comparison.py` | `282587c48242601ca3d94f6d748742d7722d49e57f5b975f6da85a94e0e258fb` | `attainable_bound_from_share`, the §4c bound |
| `src/scripts/sr-backtest/guard.ts` | `977ada54406f20140599f82934a7e481d9defbfffd6dfee4a71ddc77a8626ee1` | `checkOutcomeGuard`, `pinsOf` |
| `src/scripts/sr-backtest/store.ts` | `1446732b7d5cfb78cfcbe7b40c6db24980db1874ecfa2072a298b803f3021d04` | the store manifest the guard checks, `writeAtomic` |

**The tables.** The registration whose Tables 2a–2e the judge's frame is checked against. The pinned guard holds it to its bytes as a file row, and the judge refuses a registration that does not pin it.

| pin | sha256 | role |
|---|---|---|
| `audits/regime-diagnostic-preregistration-2026-11-16.md` | `f5c54aeb1fe3bc5f788bfd1a49267d77a4317d95ef7ee3df966b3a59ce8581ee` | T3's registration with its three amendments: the hold-out rows of Tables 2a–2e, and every T3 rule cited here. T3 is closed and nothing more is appended to it |

**Carried and stored.** These are not repository files.

| pin | sha256 | role |
|---|---|---|
| `carry:regime-challenge-r1-prescore.json` | `3f9402d0f0b6f038b5bcb99c6bcdd9b8fa8b1d809e7aeb6a660866d0a4e3700a` | the pre-score result (§2, E5), in the vault; the judge accepts no other file. It fixes the family {C2, C3}, the verdicts and the in-sample points the underpowered label reads |
| `census:regime-census-2026-11-16.json` | `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a` | the frozen census in the vault: the panel and the weights. T3's pin, unchanged |
| `store:regime-diag-archives.json` | `b177bd0d4cba9ff46f4a8bc8e2f44b57c0f996457e8a2f3f0b21308b33e6ae1a` | the archive-store manifest of 2024-01 … 2026-10 in the judge's store, made by `--init-store` (§2, E6): byte-identical to T3's pin |
| `store:manifest-BINANCE.json` | `57c995bbfb65cf07fb210b64b94c6e9e99d866543b5842d52da59cca8d755e53` | the guard's own store manifest over an empty plan, as `--init-store` printed it. It differs from T3's and T9's because its plan names this round's wave |

**Cited, not pinned.** The first cell is not backticked, so `pinsOf` skips these rows.

| file | identity | why it is cited |
|---|---|---|
| audits/regime-confirmation-preregistration-2026-11-17.md | git blob at commit `0dab4aa5991ed2a2785583165338a56ade7ca453` | T9: the form of this file and the last pins of the harness |
| audits/PREREGISTRATION-PROCEDURE.md | sha256 `c1f65e138690a7c1c07881df981b751b7c1931749f217ae2416e15f26c3c5fe0` | the procedure as read for this file |
| tests/unit/preregistration-support-stress-test.test.ts | sha256 `7b675487c95fd907ffb6d152586b2f00d585c6568909b26a06e8f1cd9581663f` | the gate this file passes |
| scripts/odds-calibration-study.py | sha256 `fda34fec72c3c7df4f0922d1638b1314845a11183bdc6c230a1ddaf3af51c857` | the archive reader whose form §3 uses; the harness does not import it |
| src/lib/pre-trade-rules.ts | git blob d0cc2f30f516eee9cf888ff4665241db43566597 | holds the 60 trigger that the TRENDING ≥ 60 rows use (T3 §8, correction 1) |
| src/tools/get-market-regime.ts | git blob 57a8e733d7648434d0cbedae4044d55b833b03f1 | holds the 4h default that C3 moves (T3 §8, correction 1) |

**Not pinned byte for byte.** T3 §10 names the files that the core's and the guard's import closures reach and that T3 did not pin byte for byte (T3 §8, correction 16). They are not pinned here either. This round adds one: `src/types.ts`, which `challenger-replay.ts` imports for a type alone and which is erased at run time. The core-parity fixture covers the behaviour: the guard refuses the read if a label of the fixture changes for any reason (leg (v)), and the judge refuses it if C1's copy at period 14 differs from the fixture (leg `parity`). No test file or test fixture of this round is a pin, and no leg reads one.

**Who enforces what.** `checkOutcomeGuard` enforces the file rows and its own store manifest. The pinned guard's legs enforce the census, the archive-store manifest by its sha256 pass, the core-parity fixture and the seal. The judge enforces `REQUIRED_PINS`, the carried pre-score by its sha256, the tables row, C1's parity, the frame against T3's tables, the months, and identifiability before the seal. The tests that hold each of these are in `tests/unit/regime-challenge-run.test.ts`, `tests/unit/regime-challenge-spec.test.ts`, `tests/unit/regime-challenge-replay.test.ts` and `tests/unit/regime-challenge-stats.test.ts`.

## Amendment 1 — 2026-11-17, before the read: the judge's store is its own, the pre-score never reaches the judge window, and one re-pin

**Write-time clock (live `date -u`):** 2026-11-17T05:46Z (2026-11-17 local, the date in the file name).

Below, "the body" is everything before this section, and the parts of this section are F1, F2, F3 and the re-pin.

**Ordering.** Before the read. The judge has not run. Its store holds the two manifests and the plan that `--init-store` wrote (§2, E6), and no guard log. The seal home holds T3's `holdout.seal` only, and no `challenge-r1.seal`. This round has computed no outcome of 2026-01 … 2026-10. The body is unchanged: the first 70,221 bytes of this file (sha256 `f3e1ebfa2dd50565b0da4527f133f296aa3089b1e196851707d54593f683f6bb`) are as landed at commit `c45097a62362cf5289e8b2a43951c06252e4c253`.

**Reason.** An independent audit of the harness against this file, made before the read (CH4; the lead's ruling of 2026-11-17T05:36Z, 13:36 local), returned one confirmed finding (F1) and two plausible ones (F2, F3). Each is settled here, before any row of the judge window is read, so no result can choose it. None changes the read's statistics, months, seal or decision. PROCEDURE §7 does not apply: there is no result.

### F1. The judge's store is its own (code, and a correction to §10)

- **The correction.** §10's role text for `store:manifest-BINANCE.json` says the manifest "differs from T3's and T9's because its plan names this round's wave". That is false for T3. The guard-store manifest holds the venue, the span, the warm-up, the panel date, and the empty plan's coins, series and failures; it does not hold the plan's wave. The judge store's manifest is byte-identical to T3's: both hash to `57c995bbfb65cf07fb210b64b94c6e9e99d866543b5842d52da59cca8d755e53` (T9's differs). So the store pin cannot tell this round's store from T3's. The row's sha256 stands; its role text is corrected here.
- **The fix.** The judge and `--init-store` now tell the stores apart themselves, through `storeRefusal` in `challenge-run.ts`. Each refuses a store that is the seal home or lies inside it; T3's store directory is the seal home (§7). Each also refuses a store whose `plan-BINANCE.json` names a wave other than this round's, `EDGE-REGIME-CHALLENGE-R1-W1`; the plan names its wave at the head of its `panelSource`. The judge also refuses a store with no plan, which names no wave. Each refusal comes before the first guard-log line and before any write: the judge returns `REFUSED` with nothing written in the store, the seal home or the output directory, and `--init-store` prints `REFUSED` and writes nothing.
- **§3, point 1, is now enforced.** "T3's store directory is never named as `<store>`" was a statement; it is now a refusal on two counts. Named as `<store>`, T3's store directory fails on where it sits (the seal home) and on its plan (it names `EDGE-REGIME-DIAG-W1`).
- **The judge's store passes.** The store made at E6 sits outside the seal home, and its plan names this round's wave: `storeRefusal` called on it at the write-time clock returns no refusal, both as the judge asks it and as `--init-store` asks it.

### F2. The pre-score never reaches the judge window (code)

`prescoreRun` refuses any record whose outcome months overlap the judge window, 2026-01 … 2026-10. The refusal comes before it creates its output directory, writes a log line or builds a frame. Until now an injected study naming such a record was read like any other: outcomes and both arms, with no guard, no registration and no seal. The registered pre-score record, 2024-01 … 2025-12, does not overlap. Its result stands (§2, E5), because the refusal sits on a path the pre-score did not take.

### F3. T9's window

A correction to round 1 never uses T9's window, 2026-11 … 2027-05.

### Re-pin

The sha256 of `challenge-run.ts` as committed with this section, in the same commit. By §10's rule the last row for a name is its pin, so this row replaces the earlier row of the same name; every other pin of §10 stands. The pinned file is byte-identical on the `origin/main` commit this section lands on; that is re-checked immediately before landing.

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-challenge/challenge-run.ts` | `de19cacd2d2f32feeee080660c2143895700c80e101742de34d2d950dd8ccb18` | the CLI: the pre-score and its selection, its refusal of a record that reaches the judge window (F2), `--init-store`, the judge, the store refusal both ask before they write (F1), the refusals, the order, the pre-seal `identifiability` line and the result |

The test file that carries the fixes is recorded here with its bytes as committed in the same commit. It is not a pin: no test file is a pin of this registration, and no guard leg depends on one.

- tests/unit/regime-challenge-run.test.ts, sha256 `f675231d5a51f05430d1e2e7d04c7aba6f4cb94507226ab485a951e76551771e`. For F1: the judge refuses its seal home and a store inside it, with the seal home's listing unchanged; it refuses a store made under T3's record and a store with no plan, with nothing written; `--init-store` refuses T3's record's store and rewrites nothing; and this round's store is accepted. For F2: the judge's record, and a record whose last outcome month is the window's first, are refused with nothing written, and the synthetic pre-score is read.

Each fix was written test-first, and each test failed before its fix. F1's tests also fail with the check removed: removing it from both runs fails the judge's two tests, and removing it from `--init-store` alone fails the `--init-store` assertion.

## Amendment 2 — 2026-11-17, before the read: path containment is identity, not spelling, and one re-pin

**Write-time clock (live `date -u`):** 2026-11-17T06:45Z (2026-11-17 local, the date in the file name).

Below, "the body and Amendment 1" is everything before this section, and the parts of this section are F4 and the re-pin.

**Ordering.** Before the read. The judge has not run. Its store holds the two manifests and the plan that `--init-store` wrote (§2, E6), and no guard log. The seal home holds T3's `holdout.seal` only, and no `challenge-r1.seal`. This round has computed no outcome of 2026-01 … 2026-10. The body and Amendment 1 are unchanged: the first 75,875 bytes of this file (sha256 `96e24031cd07ed0f51d4add087f304d2f87c6d0a886b7389a93230b681c94103`) are as landed at commit `d292ca2ea4f9839b96c1185e8f074774988da1f2`.

**Reason.** The same auditor's re-check of Amendment 1, made before the read (CH4; the lead's ruling of 2026-11-17T06:32Z, 14:32 local), passed F1, F2 and F3 and returned one new confirmed finding (F4). It is settled here, before any row of the judge window is read, so no result can choose it. It changes none of the read's statistics, months, seal or decision. PROCEDURE §7 does not apply: there is no result.

### F4. Path containment is identity, not spelling (code)

- **The finding.** `within(p, root)` in `challenge-guard.ts` decided containment by spelling: both paths with their symlinks resolved by `fs.realpathSync`, which keeps the case it is given. The volume that holds the seal home is case-insensitive, and macOS also names every path on it under the firmlink `/System/Volumes/Data`. So a store named through a case variant of the seal home (`…/regime-diag/STORE/x`), or through the firmlink (`/System/Volumes/Data/Users/…`), was not seen as inside it, and `storeRefusal` (Amendment 1, F1) let the judge and `--init-store` use a store inside the seal home. In a sandbox, the judge passed with its store inside its seal home, named through a case variant, and wrote its guard log there. The repository checks of the pre-score's output and of the judge's store and output had the same blind spot.
- **The fix, in the one function every caller uses.** `within(p, root)` keeps the spelling check and adds identity; either one counts. By identity, `p` lies within `root` when `p`, or an existing ancestor of it, has `root`'s `{dev, ino}` (read by `fs.statSync`, as bigints). A `root` that does not exist has no identity, and only the spelling speaks for it; the seal home and the repository both exist when a run asks. The five callers gain at once: the seal-home check of `storeRefusal`, which the judge and `--init-store` both ask, and the repository checks of the pre-score's output, the judge's store, the judge's output and `--init-store`'s store. `challenge-run.ts` is unchanged, and its pin (Amendment 1) stands.
- **The judge's store passes.** At the write-time clock, `storeRefusal` on the store made at E6 returns no refusal, both as the judge asks it and as `--init-store` asks it. The seal home, and a path inside it, are refused under their own names, through a case variant and through the firmlink. These checks read the judge store's plan and nothing else, and write nothing.

### Re-pin

The sha256 of `challenge-guard.ts` as committed with this section, in the same commit. By §10's rule the last row for a name is its pin, so this row replaces the earlier row of the same name; every other pin of §10 and of Amendment 1 stands. The pinned file is byte-identical on the `origin/main` commit this section lands on; that is re-checked immediately before landing.

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-challenge/challenge-guard.ts` | `499ec70fc92dcaba62d78276254452d2bef02d964aff309e1597bb43076a4b45` | the record loader, the archive and skeleton checks, the landed source, the registration on `origin/main`, and path containment by spelling or by identity (F4) |

The test file that carries the fix is recorded here with its bytes as committed in the same commit. It is not a pin: no test file is a pin of this registration, and no guard leg depends on one.

- tests/unit/regime-challenge-run.test.ts, sha256 `830aa90a8e136d6185b107309e49e1ca013145bebd1dad51b1cf27fde1e87506`. For F4, four tests in a sandbox. The seal home and a store inside it, named through a case variant and through the firmlink, are refused by `storeRefusal` as the judge and `--init-store` ask it; the judge, with an injected study and its own seal home, refuses them with the seal home's listing unchanged and no output; and a sibling named through the same alias is accepted. The repository named through either alias is refused as the pre-score's output and as the judge's store and output, with nothing written. The case-variant tests assert on macOS that the volume is case-insensitive, so they never skip there; on a case-sensitive volume they assert that the variant lies outside. The firmlink tests run where the firmlink of the sandbox exists.

The fix was written test-first, and the tests failed before it. With the spelling-only `within()` put back, the four tests fail; restored, they pass.

## Amendment 3 — 2026-11-17, before the read: containment walks the resolved path too, a matrix closes the class, the last component is checked, and two re-pins

**Write-time clock (live `date -u`):** 2026-11-17T08:10Z (2026-11-17 local, the date in the file name).

Below, "the body and Amendments 1 and 2" is everything before this section, and the parts of this section are F5, the matrix, F6 and the re-pin.

**Ordering.** Before the read. The judge has not run. Its store holds the two manifests and the plan that `--init-store` wrote (§2, E6), and no guard log. The seal home holds T3's `holdout.seal` only, and no `challenge-r1.seal`. This round has computed no outcome of 2026-01 … 2026-10. The body and Amendments 1 and 2 are unchanged: the first 81,057 bytes of this file (sha256 `518aed810f5b55768e2ac032246ae18d888cbc32fb62fb67562587aa7920e791`) are byte-identical to the file as landed at commit `f40b8667f37ec9ad865c628881689332de7c05c4`.

**Reason.** A fresh auditor's re-check of Amendment 2, made before the read (CH4; the lead's ruling of 2026-11-17T07:41Z, 15:41 local), passed F4 for direct aliases and returned one new confirmed finding (F5). F5 is the third fix in one class, after F1 and F4: whether a path lies inside a root. So this section closes the class with a gate, not with one more case. It is settled here, before any row of the judge window is read, so no result can choose it. It changes none of the read's statistics, months, seal or decision. PROCEDURE §7 does not apply: there is no result.

### F5. Containment walks the resolved path too (code)

- **The finding.** Amendment 2's `within(p, root)` walked `{dev, ino}` over the ancestors of `p` as written (`path.resolve(p)`) only, and compared `p` with its symlinks resolved (`real(p)`) by spelling only. So a symlink outside the root whose target is another name of a directory inside it — a case variant (`…/SEAL-HOME/inner`) or the firmlink (`/System/Volumes/Data/…`) — passed both checks: as written, no ancestor is the root; resolved, the spelling differs. In a sandbox, the judge passed with its store reached through such a symlink and wrote inside its seal home, and the pre-score wrote its result into the repository's `audits/` through one. The repository checks of the pre-score's output and of the judge's store and output were open the same way.
- **The fix, in the same one function.** The identity walk covers the ancestors of both `path.resolve(p)` and `real(p)`. The spelling check stays, and either check counts. Every caller gains at once, as in Amendment 2. F5 changes nothing in `challenge-run.ts`; F6 does (below).
- **The judge's store passes.** At the write-time clock, `storeRefusal` on the store made at E6 returns no refusal, both as the judge asks it and as `--init-store` asks it. These checks read the judge store's plan and nothing else, and write nothing.

### The matrix: the gate that closes the class

F1 and F4 each closed the case their finding named, and F5 is a case that F4's fix left open: two checks that each covered one renaming step did not cover the two steps together. The class is now held by one test over the composition, in `tests/unit/regime-challenge-run.test.ts`:
- **written form:** the canonical name; a case variant of the root, on a case-insensitive volume; the root's `/System/Volumes/Data` firmlink, where it exists;
- **link form:** none; a symlink outside the root that points at that form; a chain of two such symlinks;
- **root:** a store inside a sandbox seal home, asked of `storeRefusal` as the judge asks it and as `--init-store` asks it (of the store, and of a store not made yet below it), and of the judge with an injected study and its own seal home; and an output inside a sandbox repository, asked of the pre-score and of the judge.

Every cell is refused, with nothing written: the seal home's listing is unchanged, no result is written, and the repository's status is unchanged. The same forms of directories outside the roots still pass: a sibling whose name shares the root's prefix, a store outside the seal home, and an output outside the repository, into which the pre-score writes through the matrix's last cell (on this Mac, a chain of two symlinks to the firmlink). On macOS the test asserts that the volume is case-insensitive, and that the firmlink column runs wherever `/System/Volumes/Data` exists, so no column is skipped silently.

The matrix was written first. At `f40b8667` it failed in exactly the cells where a symlink, or a chain of two, points at a case variant or at the firmlink, for both roots; the canonical cells and the unlinked cells passed. With the fix it passes. With the walk of `real(p)` dropped, the same cells fail; restored, byte for byte, they pass.

### F6. The last component of a written name (code)

**Write-time clock of this part (live `date -u`):** 2026-11-17T08:40Z. **Reason.** The lead's review of this section before it landed (CH4; 2026-11-17T08:18Z, 16:18 local) accepted F5 and the matrix and confirmed one more case of the same class by a run (F6). This section had not landed, so F6 is a part of it, settled before any row of the judge window is read, like F5. It changes none of the read's statistics, months, seal or decision.

- **The finding.** `within()` holds a directory, and the matrix asks directories. The run then writes fixed names inside the directory it accepted. In the store, it appends the guard log and writes the registration's first sighting (`registration-seen.json`, as `.tmp`, then renamed); `--init-store` writes the three init files (each as `.tmp`, then renamed). In the output directory, the pre-score appends its log, and each run writes its result (as `.tmp`, then renamed). Each write follows a link at its last component: a symlink, live or dangling, carries the write to its target, and a hard link is another name of the target's own bytes. So a plain directory outside every root, holding a link at one of those names to a file inside a root, made the run write inside that root. In a sandbox, the judge appended its guard log and wrote its registration sighting inside its seal home this way, and the pre-score and the judge wrote their logs and results into the repository. It is the class of F1, F4 and F5: whether a write lands inside a root.
- **The fix.** One function, `linkRefusal` in `challenge-guard.ts`, is asked once before the run's first write. When it refuses, nothing is written.
  - **The store.** `storeRefusal` refuses a store any entry of which, at any depth, is a symlink, or a non-directory with more than one link. The judge asks it before its first guard line, and `--init-store` asks it before it writes the store.
  - **The output directory.** The pre-score and the judge each refuse an output directory where a name the run writes there exists as a symlink (live or dangling) or with more than one link: the pre-score's log, the result, and the result's `.tmp`. They ask it before the directory is made.
  - T3's modules are unchanged.
- **Scope.** The check is made once, before the first write. It guards against operator error: a link left at one of these names, or a store copied together with its links. A writer that makes such a link while the run is running is outside it.
- **The judge's store passes.** At the write-time clock of this part, the judge's store holds three plain files, each with one link. `storeRefusal` returns no refusal for it, both as the judge asks it and as `--init-store` asks it, and so does `linkRefusal`. These checks read the store and write nothing.

**The gate: a final-component axis on the matrix.** The directory is plain, and it sits outside every root.
- **written name:**
  - the store, through the judge, with an injected study whose own seal home is the root: `guard.log`, `registration-seen.json` and its `.tmp`;
  - the store, through `storeRefusal` as `--init-store` asks it: every name the judge and `--init-store` write there (those three, and the three init files with their `.tmp`);
  - the store, through the `--init-store` CLI itself: `guard.log`, `registration-seen.json`, and the plan's `.tmp`;
  - the output directory: the pre-score's log, its result and the result's `.tmp`, through the pre-score; the judge's result and its `.tmp`, through the judge, with a store and a seal home of its own.
- **link form:** a symlink to a file inside the root; a symlink to a name inside the root where no file is (dangling); a chain of two symlinks to a file inside the root, the middle one outside every root; a hard link to a file inside the root.
- **root:** a sandbox seal home; a sandbox repository.

All 80 cells are refused with the link's reason and nothing written. The root's tree is byte-identical: every entry's kind, and its sha256 or link target, before and after, and for the repository also its status. No seal is claimed. The legitimate cases still pass: the plain store the sandbox judge reads, with its guard log among its files, in both modes; and a plain output into which the pre-score writes twice, the second time while it holds the plain log and result of the first. Every earlier test's plain stores and outputs pass too.

The axis was written first. At `43fd5da5` all 80 cells failed. The guard log, the registration sighting's `.tmp`, the pre-score's log and both results' `.tmp` were written inside the root through the link. At the other names, nothing refused the link: the run accepted the store or the output, or, at the plan's own name, refused the store for another reason. With the fix, all 80 pass. With the check dropped (`linkRefusal` answering null), the same 80 fail; restored, byte for byte, they pass.

### Re-pin

The sha256 of `challenge-guard.ts` and of `challenge-run.ts` as committed with this section, in the same commit. By §10's rule the last row for a name is its pin, so these rows replace the earlier rows of the same names; every other pin of §10 and of Amendments 1 and 2 stands. The pinned files are byte-identical on the `origin/main` commit this section lands on; that is re-checked immediately before landing.

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-challenge/challenge-guard.ts` | `f09a657d47a5148540ae09b0c4c4cb18251f5381ceb5e5f508cd7f2b6a5ea9f8` | the record loader, the archive and skeleton checks, the landed source, the registration on `origin/main`, path containment by spelling, or by identity over the ancestors of the written path and of the resolved path (F4, F5), and the refusal of a link at a name a run writes (F6) |
| `src/scripts/regime-challenge/challenge-run.ts` | `0b3e6b9445dee17c3a1ea706eec74d612397da0609d8af893df989a150704377` | the CLI: the pre-score and its selection, its refusal of a record that reaches the judge window (F2), `--init-store`, the judge, the store refusal both ask before they write (F1, and F6: no entry of the store is a link), the refusal of an output directory where a name the run writes is a link (F6), the refusals, the order, the pre-seal `identifiability` line and the result. F6 adds refusals made before the first write, and changes no computed quantity |

The test file that carries the fixes and the matrix is recorded here with its bytes as committed in the same commit. It is not a pin: no test file is a pin of this registration, and no guard leg depends on one.

- tests/unit/regime-challenge-run.test.ts, sha256 `a9a5e6910d5e6eec540c7f30e59dcd29428429472ecbdf6cd7b742096dfea51d`. For F6, three tests in a sandbox, together the final-component axis. The store test makes, per cell, a seal home and a store for this round outside it, puts the link in the store, and asks `storeRefusal` in both modes and the judge. The `--init-store` test asks `storeRefusal` as `--init-store` asks it at every name, and runs the CLI at three of them. The output test puts the links in output directories outside the repository, pointing at files inside it, and asks the pre-score and the judge; it then runs the pre-score twice into a plain output. For F5, two matrix tests in a sandbox, one per root. The seal-home test makes a seal home, a store inside it and a sibling store, all for this round; it asks every cell of the store inside of `storeRefusal` in both modes and of the judge, and then asks every form of the sibling and of a store outside the seal home. The repository test asks every cell of an output inside the repository of the pre-score and of the judge (with a store and a seal home of its own), and then asks every form of a sibling of the repository, and runs the pre-score into it.
