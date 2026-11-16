# EDGE-REGIME-DIAG-W1 — pre-registration: does the served market-regime label carry anything a bracket trade can use, and which dial is responsible?

Written 2026-11-16 (UTC), before any outcome read. Internal research: no public surface, no serving or scoring change, nothing shipped, no accuracy or edge claim, no tuning after data. This file carries methodology and label-free cardinalities only. Every outcome figure, every per-coin table, the panel's coin names and every figure derived from the census weights live in the private vault and never in this repository.

Procedure: `audits/PREREGISTRATION-PROCEDURE.md` §1–§9, including §4c and §4d. Wave spec: `Prompt/EDGE-REGIME-DIAG-W1.md` (planning vault). Its §1 frame is reproduced verbatim in §11 with its sha256; where this file departs from the frame, §8 lists the departure as a numbered correction. This wave (W1) registers the study and builds the harness. `EDGE-REGIME-DIAG-W2` runs the read.

SERVED_RULE_STUDY: src/lib/market-regime-core.ts · MARKET_REGIME_RULE_VERSION = 2

## 0. What is tested, in one paragraph

The served regime label (`computeMarketRegimeCore`, rule version 2) is replayed on closed Binance USDⓈ-M bars at randomly drawn entry instants, on the 15 positions of a frozen panel and at three label timeframes (1h, 4h, 1d). At every entry, both sides of 45 brackets (9 stop/target shapes × 5 holds) are labelled from the 1 m path as target first, stop first or time-out. Five questions get one primary statistic each: **A1** do TRENDING labels at confidence ≥ 60 put the target-first rate of the side with the trend above the side against it; **A2** do VOLATILE labels at confidence ≥ 70 see stops hit more often than volatility alone predicts; **A3** is there a shape × label cell whose target-first rate clears the fee-adjusted no-edge line; **A4** does the label's direction agree with a hindsight dating of trends beyond chance; **A5** do TRENDING labels live through larger moves than same-length windows placed elsewhere. Before any dial is judged, each primary is recomputed with two answer keys in place of the served label: key A, the trend dated in hindsight, and key B, the same rule looking 14 bars ahead. A failure then reads as nothing to find, inputs, or lag (PROCEDURE §4d). Twelve slices, each tied to one dial of the rule, are then read as works, broken or too little data. The fit window is 2024-01-01 → 2025-12-31. The hold-out, 2026-01-01 → 2026-10-31, is read once.

## 1. Ordering (PROCEDURE §1)

- This file lands on `origin/main` before any outcome is computed on real archives. At the time of writing no path label, target-first or stop-first rate, agreement, lag, flip count, run length or swing has been computed on real data. R0 computed served labels, key-A turning points (a function of price alone), the entry skeleton and σ inputs. All of it is disclosed in §2.
- This wave computes no outcome statistic on real archives. Its harness tests run on synthetic fixtures; the guard refuses and logs anything else.
- The harness refuses an outcome run unless all of the following hold, and logs each refusal: (i) this file is on `origin/main` and the last commit that touched it is an ancestor of `origin/main` (`checkOutcomeGuard`, `src/scripts/sr-backtest/guard.ts`, called unmodified); (ii) every file pinned in §10 and in the appended pin section hashes to its pin on disk; (iii) the archive store's manifest hashes to its pin; (iv) the census file hashes to its pin; (v) the core-parity fixture reproduces label for label; (vi) for a hold-out run, the hold-out seal does not exist yet. The seal is created atomically before the hold-out is computed, so a second read is refused.
- The read records two clocks together in its result: `registration_landed_at` (the landing commit's time, and the first `date -u` at which that commit was seen on `origin/main`) and `outcome_read_at` (`date -u` immediately before the first outcome computation).
- After landing, this file's body is never edited. A change before the read is an appended, dated amendment section (PROCEDURE §8). The pins of the harness files are such a section, landed before any read.
- Order of the read: (1) reproduce the skeleton and compare it with §2 — any difference stops the read and is recorded as an amendment before anything else runs; (2) fit window: answer keys, primaries, component map; (3) the hold-out identifiability and floor checks on the realized hold-out skeleton; (4) the hold-out, once.

## 2. Prior-examination disclosure (PROCEDURE §2)

Every figure the author saw before this file landed. Classes: `cardinality` · `coverage ratio` · `inherited` · `seen — not a test input`. All times are UTC on 2026-11-16. The R0 scripts are scratch files outside the repository; their commands, sha256 and outputs are in the vault evidence (`audits/EDGE-REGIME-DIAG-W1-evidence.md`).

| # | what was seen | when | class | use |
|---|---|---|---|---|
| D1 | `DECISION-CALL-V2-W4` (odds-v1) read the same hold-out months, 2026-01-01 → 2026-10-31, once and unconditionally (no regime conditioning), on eight coins. Its field verdicts are public in `src/lib/pre-trade-odds-calibration.ts`: `timeout` uncalibrated, `target_first` uncalibrated, `liquidation` calibrated | before this wave | inherited | enters only as baseline (b), which is odds-v1's own output. This study is the first regime-conditioned read of 2026 |
| D2 | the frozen census, vault `audits/regime-census-2026-11-16.json`, sha256 `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a`, read in full: the 15-coin panel and the field `t3_weights` | before R0 | inherited | panel and weights, read at run time; no census figure is in this file |
| D3 | archive coverage: one HEAD request per panel coin × month, 2024-01 … 2026-10 | 05:34:09–05:34:27 | coverage ratio | 429 of 510 registered coin-months exist (282 of 360 in the fit window, 147 of 150 in the hold-out). 11 positions are complete. 4 are partial and account for all 81 missing coin-months (78 fit, 3 hold-out); 2 of the 4 have no fit-window month. No position has a missing month after its first |
| D4 | archive fetch into W4's cache: 157 files; the other 272 were already cached by W4 | 05:35:09–05:35:32 | cardinality | data, verified against the venue's `.CHECKSUM` |
| D5 | a first skeleton run on the cached archives | between 05:35 and 06:02; start not retained | seen — not a test input | superseded: its outputs were overwritten after D7, and every figure in this file comes from D8 |
| D6 | aggregation parity: 1 m rows aggregated to 1h, 4h and 1d against the venue's own archives, 2 positions × 2 months × 3 timeframes = 12 files, 1,922 bars, open/high/low/close equal on every bar | 05:56:49 | cardinality | the aggregation rule of §4.1 |
| D7 | gap probe and checksum freshness probe. 8 cached archives (the 2026-10 files of W4's eight coins) lacked one UTC day. The venue's current `.CHECKSUM` equals the cached copy for 421 of 429 files and differs for those 8. The 8 current files were fetched to an overlay and verified | 06:01:58 (gaps), 06:03:02–06:03:16 (checksums), 06:03:33–06:03:40 (fetch) | cardinality | §3's checksum clause. W4's hold-out read used the 8 older copies; owner `DECISION-CALL-V2-W4`; not routed around here — this study reads the current files |
| D8 | the skeleton: 1,284,833 calls of the pinned core, no refusal; 18,688,530 one-minute rows on the grid, 0 rejected, 0 duplicates, 0 gaps inside any position's span. Tables 2a–2e below | 06:04:27–06:05:09 | cardinality | occupancy for the support table, §5 and the identifiability table. Served labels are outputs of the rule on its inputs; key-A turning points are a function of price alone. No label was tabulated against a key or against a path |
| D9 | the core on synthetic step series: bars from the step to the first trending label, median 6 to 17 across settings | 05:59:37 | seen — not a test input | synthetic data only; informs key B's 14-bar lead (§4.10) |
| D10 | power arithmetic on the skeleton (Kish effective counts; no simulation, no outcome) | 06:19:12 | cardinality | §5 |
| D11 | inert-cell probe: for every entry and every shape × hold cell, the no-edge probabilities from σ alone (`noEdgeOdds`, long side). Inputs only. Null odds: 0 in every cell; entries without a σ: 0. Cells in which more than half the entries have a no-edge target-first probability below 1%: 6 of 45 in the fit window, 8 of 45 in the hold-out | 06:32:32–06:33:07 | cardinality | the inert-cell row of the support table |
| D12 | the per-position versions of every table, the coin names, the σ quantiles and per-cell no-edge means behind D11, and the design-weighted versions of §5 (Kish-effective clusters, direction mix, detectable effect) | with D8, D10, D11 | cardinality · inherited (weights) | vault only. This file carries pooled values |
| D13 | re-runs of D6, of D7's gap probe and of D9, to capture their output for the vault evidence; every figure identical to the first runs | 07:06:03–07:06:21 | cardinality | none beyond D6, D7 and D9 |

Positions are numbered P01–P15 in census panel order. P01–P08 are W4's eight coins (D1); P09–P15 are the other seven.

**Table 2a — served label per closed bar** (one call of the core at every bar close with a full, unbroken window). `T≥60` = TRENDING at confidence ≥ 60; `V≥70` = VOLATILE at confidence ≥ 70.

| positions | timeframe | window | calls | TRENDING_UP | TRENDING_DOWN | RANGING | VOLATILE | T≥60 | V≥70 |
|---|---|---|---|---|---|---|---|---|---|
| all | 1h | fit | 202,682 | 45,429 | 53,716 | 101,310 | 2,227 | 60,217 | 1,121 |
| all | 1h | hold-out | 106,272 | 24,436 | 27,840 | 53,556 | 440 | 31,906 | 214 |
| all | 4h | fit | 50,670 | 13,685 | 15,214 | 15,981 | 5,790 | 19,726 | 3,680 |
| all | 4h | hold-out | 26,567 | 7,340 | 7,825 | 9,850 | 1,552 | 10,018 | 892 |
| all | 1d | fit | 7,235 | 1,703 | 2,121 | 484 | 2,927 | 2,335 | 2,821 |
| all | 1d | hold-out | 4,241 | 1,190 | 1,016 | 427 | 1,608 | 1,400 | 1,410 |
| P01–P08 | 1h | fit | 139,008 | 31,603 | 37,751 | 68,375 | 1,279 | 42,923 | 587 |
| P01–P08 | 1h | hold-out | 58,368 | 12,489 | 16,012 | 29,819 | 48 | 17,336 | 24 |
| P01–P08 | 4h | fit | 34,752 | 9,316 | 10,688 | 11,333 | 3,415 | 13,767 | 2,203 |
| P01–P08 | 4h | hold-out | 14,592 | 3,744 | 4,526 | 5,928 | 394 | 5,424 | 134 |
| P01–P08 | 1d | fit | 5,048 | 1,148 | 1,489 | 322 | 2,089 | 1,608 | 1,984 |
| P01–P08 | 1d | hold-out | 2,432 | 611 | 697 | 250 | 874 | 872 | 747 |
| P09–P15 | 1h | fit | 63,674 | 13,826 | 15,965 | 32,935 | 948 | 17,294 | 534 |
| P09–P15 | 1h | hold-out | 47,904 | 11,947 | 11,828 | 23,737 | 392 | 14,570 | 190 |
| P09–P15 | 4h | fit | 15,918 | 4,369 | 4,526 | 4,648 | 2,375 | 5,959 | 1,477 |
| P09–P15 | 4h | hold-out | 11,975 | 3,596 | 3,299 | 3,922 | 1,158 | 4,594 | 758 |
| P09–P15 | 1d | fit | 2,187 | 555 | 632 | 162 | 838 | 727 | 837 |
| P09–P15 | 1d | hold-out | 1,809 | 579 | 319 | 177 | 734 | 528 | 663 |

**Table 2b — key A on closed bars** (price only; §4.9). `dated` = bars lying between two turning points; `up-phase` = dated bars lying between a trough and the next peak.

| timeframe | window | full closed bars | turning points | dated | up-phase |
|---|---|---|---|---|---|
| 1h | fit | 204,866 | 3,042 | 203,726 | 103,456 |
| 1h | hold-out | 106,608 | 1,649 | 105,687 | 49,548 |
| 4h | fit | 51,216 | 846 | 50,153 | 25,941 |
| 4h | hold-out | 26,651 | 435 | 25,833 | 11,566 |
| 1d | fit | 8,535 | 158 | 7,912 | 3,739 |
| 1d | hold-out | 4,441 | 85 | 3,594 | 1,966 |

**Table 2c — the entry skeleton** (§4.2).

| window | eligible minutes | entries | entries also eligible at 1d | positions with entries | entries per complete position |
|---|---|---|---|---|---|
| fit | 12,104,833 | 201,748 | 172,567 | 13 | 17,304 |
| hold-out | 6,311,565 | 105,193 | 100,717 | 15 | 7,224 |

**Table 2d — row sets** (a row is one entry at one timeframe; §4.5). Clusters are coin × UTC day. `m` is the unweighted share of the minority label direction among the set's TRENDING rows.

| window | row set | rows | clusters | positions | 1h rows | 4h rows | 1d rows | m |
|---|---|---|---|---|---|---|---|---|
| fit | all | 576,063 | 8,407 | 13 | 201,748 | 201,748 | 172,567 | n/a |
| fit | TRENDING | 305,506 | 8,110 | 13 | 98,747 | 115,546 | 91,213 | 0.4606 |
| fit | TRENDING, confidence ≥ 60 | 195,503 | 6,912 | 13 | 60,246 | 79,420 | 55,837 | 0.4555 |
| fit | TRENDING, confidence < 60 | 110,003 | 7,289 | 13 | 38,501 | 36,126 | 35,376 | 0.4698 |
| fit | RANGING | 175,350 | 7,340 | 13 | 100,764 | 63,007 | 11,579 | n/a |
| fit | VOLATILE | 95,207 | 4,128 | 13 | 2,237 | 23,195 | 69,775 | n/a |
| fit | VOLATILE, confidence ≥ 70 | 83,155 | 3,645 | 12 | 1,098 | 14,796 | 67,261 | n/a |
| fit | VOLATILE, confidence < 70 | 12,052 | 1,066 | 13 | 1,139 | 8,399 | 2,514 | n/a |
| hold-out | all | 311,103 | 4,384 | 15 | 105,193 | 105,193 | 100,717 | n/a |
| hold-out | TRENDING | 164,434 | 4,223 | 15 | 51,662 | 60,334 | 52,438 | 0.4963 |
| hold-out | TRENDING, confidence ≥ 60 | 105,169 | 3,613 | 15 | 31,703 | 40,151 | 33,315 | 0.4999 |
| hold-out | TRENDING, confidence < 60 | 59,265 | 3,795 | 15 | 19,959 | 20,183 | 19,123 | 0.4901 |
| hold-out | RANGING | 102,064 | 3,879 | 15 | 53,080 | 38,846 | 10,138 | n/a |
| hold-out | VOLATILE | 44,605 | 1,922 | 15 | 451 | 6,013 | 38,141 | n/a |
| hold-out | VOLATILE, confidence ≥ 70 | 36,802 | 1,607 | 15 | 206 | 3,411 | 33,185 | n/a |
| hold-out | VOLATILE, confidence < 70 | 7,803 | 513 | 15 | 245 | 2,602 | 4,956 | n/a |

**Table 2e — slices** (rows, pooled over positions). ADX buckets, slope categories and confidence bins are over TRENDING rows. `exhaustion` = RANGING rows with ADX above 25. `structure` = TRENDING rows with ADX above 25 whose direction came from the price structure; `disagree` = those of them whose ±DI direction is the opposite one. VOLATILE confidence starts at 60 by construction (§4.8).

| window | timeframe | ADX 18–25 | 25–30 | 30–40 | 40+ | slope RISING | FLAT | FALLING | exhaustion | structure | disagree | conf < 50 | 50–59 | 60–69 | 70–79 | 80+ | VOLATILE 60–69 | 70–79 | 80+ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fit | 1h | 8,860 | 24,855 | 37,579 | 27,453 | 48,743 | 28,232 | 21,772 | 6,063 | 57,651 | 7,126 | 30,714 | 7,787 | 13,763 | 16,149 | 30,334 | 1,139 | 495 | 603 |
| fit | 4h | 7,609 | 20,798 | 43,523 | 43,616 | 42,925 | 30,710 | 41,911 | 8,388 | 70,109 | 10,439 | 25,735 | 10,391 | 17,099 | 21,110 | 41,211 | 8,399 | 5,809 | 8,987 |
| fit | 1d | 6,945 | 24,052 | 39,302 | 20,914 | 42,169 | 29,050 | 19,994 | 5,406 | 44,225 | 4,643 | 28,146 | 7,230 | 14,687 | 16,878 | 24,272 | 2,514 | 3,675 | 63,586 |
| hold-out | 1h | 4,595 | 12,838 | 20,169 | 14,060 | 25,110 | 15,097 | 11,455 | 3,142 | 30,525 | 4,101 | 15,835 | 4,124 | 7,735 | 8,501 | 15,467 | 245 | 79 | 127 |
| hold-out | 4h | 4,361 | 11,916 | 21,648 | 22,409 | 23,633 | 15,435 | 21,266 | 4,390 | 34,110 | 5,333 | 15,038 | 5,145 | 8,951 | 10,430 | 20,770 | 2,602 | 1,813 | 1,598 |
| hold-out | 1d | 3,902 | 12,039 | 19,697 | 16,800 | 24,194 | 14,515 | 13,729 | 3,798 | 26,783 | 4,678 | 14,707 | 4,416 | 7,296 | 7,760 | 18,259 | 4,956 | 4,821 | 28,364 |

Not probed in R0, and so carried as `floor` rows in the support table: label age, the joint occupancy of served TRENDING rows with a dated key-A phase, flip-flop counts, run counts for A5, the per-coin percentile line of the volatility slice, and the cluster count of every slice (rows were counted; clusters are counted at run time against §5's floor).

## 3. Corpus — literal predicate, closed by a clock (PROCEDURE §3)

A row is in the corpus if and only if every clause holds:

```
the row is a kline row of the file  <SYMBOL>-1m-<YYYY-MM>.zip  served at
    https://data.binance.vision/data/futures/um/monthly/klines/<SYMBOL>/1m/<SYMBOL>-1m-<YYYY-MM>.zip
AND <SYMBOL> = <COIN>USDT for a <COIN> of the census panel (field t3_weights; 15 coins)
AND <YYYY-MM> is one of the 34 months 2024-01 … 2026-10
AND sha256(file) = the value in the venue's <file>.CHECKSUM as probed on 2026-11-16 (D7)
AND open_time is a whole minute with  2024-01-01T00:00:00Z <= open_time <= T_END
AND open > 0 AND high > 0 AND low > 0 AND close > 0

T_END = 2026-10-31T23:59:00Z
```

- **Stores.** W4's archive cache holds 421 of the files; an overlay directory holds the 8 files of D7 and is resolved first. The reader is W4's form (`scripts/odds-calibration-study.py`, `ensure_archive`, `load_month`): same URL, same checksum verification, same row rules. The archive-store manifest (file name, sha256, row count) stays outside the repository because file names carry coin names; CH2 pins its sha256, and the guard refuses a store that differs by one byte.
- **Windows.** Fit: entries with `2024-01-01T00:00Z <= t` and `t + 72 h <= 2026-01-01T00:00Z`. Hold-out: entries with `2026-01-01T00:00Z <= t` and `t + 72 h <= 2026-11-01T00:00Z`. History is read only from inside the corpus; a hold-out entry's history may reach into 2025, a fit entry's path never reaches into 2026. Rows after `T_END` belong to a successor registration.
- **Two denominators.** Registered: 510 coin-months, 22,356,000 grid minutes. Reached: 429 coin-months, 18,688,530 one-minute rows. The share of the census design weight carried by the reached coin-months is reported per window in the vault. A coin counts only in the months its archive exists.
- **Drops, by name, counted and never filled.** `no_archive` (a coin-month the venue does not serve: 81) · `short_history` (fewer than 10,080 unbroken minutes before the entry — the 1h and 4h label windows) · `path_beyond_window` (the 72 h path would cross the window's end) · `gap` (a missing 1 m row inside the history or the path; R0 found none inside any position's span) · `no_1d_history` (fewer than 144,000 unbroken minutes: the entry has no 1d row) · `core_refusal` (the core throws; R0: none) · `both_touch` (§4.4) · `null_odds` (§4.7; R0: none) · `undated` (§4.9) · `key_b_beyond_window` (§4.10) · `censored_run` (§4.8, A5) · `di_tie` (component map, row 7).

## 4. Methodology

### 4.1 The replay — the landed rule is called, never re-implemented

For a coin `c`, a label timeframe `τ` with interval `I_τ` (60, 240 or 1,440 minutes) and `n_τ = CANDLE_COUNTS[τ]` bars (168, 42, 100), and an instant `t` that is the open of a 1 m bar:

- **Bars.** 1 m rows are aggregated to UTC-aligned `τ`-bars: open = first, high = max, low = min, close = last, volume = sum. D6 checked this rule against the venue's own 1h, 4h and 1d archives; the harness repeats the check on a fixture.
- **Window.** The candle window is what the serving path holds at `t`: the bars that cover `[t − n_τ·I_τ, t)`, plus the bar in progress, whose close is the 1 m open at `t`. Away from a bar boundary that is `n_τ − 1` closed bars and one bar in progress; on a boundary it is `n_τ` closed bars and a zero-length bar in progress.
- **Call.** `served(c, τ, t) = computeMarketRegimeCore({ coin, exchange: 'BINANCE', timeframe: τ, candles, intervalMs, startTime: t − n_τ·I_τ, nowMs: t, candleBasis: 'closed' })`. On the closed basis the core drops the bar in progress, so closed bars alone decide the label. The study reads `regime`, `confidence`, `slopeCategory` and the unrounded `volatilityRatio` from the result, and `adxVal`, `adxSlope`, `plusDI`, `minusDI` and `structure.structure` from `computeRegimeIndicators` on the same closed bars.
- **Eligibility.** A call needs every 1 m row of `[t − n_τ·I_τ, t)`. An instant that lacks one has no row at `τ` and is counted.
- **Per-closed-bar series.** For each coin × timeframe × window, the same call at every bar close with an unbroken window. It carries label age, runs, flips and lags. An entry inside a bar sees one bar fewer than the series does at that bar's close, so the two can differ; where they do, the entry's own call is the label and the series supplies only the age (0 in that case).

### 4.2 Entries and N

- **Eligible instants.** A 1 m open `t` in a window is eligible when it has 10,080 unbroken minutes of history inside the corpus, an unbroken 72 h path, and `t + 72 h` inside the window (§3).
- **Draw.** One seeded draw per window × position, without replacement, of `round(24 × eligible minutes / 1,440)` instants: 24 entries per eligible coin-day. The stream is mulberry32 seeded from the first four bytes of `sha256("20261116|<window>|P<nn>")`, with a partial Fisher–Yates shuffle; the draw is uniform over the eligible instants.
- **N.** The draw gives 17,304 fit and 7,224 hold-out entries per complete position (Table 2c). Every entry is evaluated at each timeframe it is eligible at, on both sides, in all 45 cells. So N per coin × timeframe is the entry count of that coin, less the `no_1d_history` entries at 1d.
- **Why 24 a day.** §5 shows the study is limited by coin-days, not by entries. One entry an hour on average samples every part of the UTC day, and more entries per day would add rows without adding clusters.

### 4.3 σ

`σ_1h(c, t) = sigma1hFromVolatilityRatio(v)`, where `v` is the unrounded `volatilityRatio` of `served(c, 1h, t)`: the production estimator, on 1h bars closed before the entry. `σ_H = σ_1h · √(hold in hours)`. Production reads the same ratio from a rounded snapshot row; the replay uses the unrounded value. Every entry is eligible at 1h, so every entry has a σ (D11: none missing).

### 4.4 Shapes, holds and the path label

Nine shapes (stop %, target %), in this order: S1 (0.5, 0.75) · S2 (1, 2) · S3 (2.5, 5) · S4 (5, 10) · S5 (1σ_H, 2σ_H) · S6 (0.5, 0.5) · S7 (1σ_H, 1σ_H) · S8 (1, 0.5) · S9 (1σ_H, 0.5σ_H). Five holds: 0.5, 4, 8, 24, 72 h. A cell is one shape at one hold: 45 cells, 90 with the side.

The entry price `P` is the 1 m open at `t`. A long's target is `P·(1 + target)` and its stop `P·(1 − stop)`; a short's are mirrored. The path is the 1 m bars from `t` to the end of the hold. Scanning in time order, the first bar whose high or low touches a barrier decides: **target first**, **stop first**; no touch by the end of the hold is a **time-out**. A bar that touches both barriers is ambiguous at 1 m resolution: that entry × cell × side is excluded and counted (`both_touch`), as in W4. Labels come from the path only. No PnL is computed anywhere.

### 4.5 Rows, weights and the estimator

- A **row** is one entry at one timeframe. Its weight is `ω = w_coin · w_timeframe`, both read from the census field `t3_weights` at run time, never renormalised. The census gives the 9 shapes and the 5 holds equal weights, which is the plain mean over cells below.
- **Cell-averaged statistic.** For a quantity `x(row, cell)` that is defined on some rows of a row set and on a list of cells `K`:

  `S = (1 / |K|) · Σ_{cell ∈ K} [ Σ_rows ω·x·1{defined} / Σ_rows ω·1{defined} ]`

  The ratio is taken cell by cell because `both_touch` exclusions differ from cell to cell. A cell with no defined row makes `S` undefined, and its state is then too little data.
- Rates and differences of rates are reported in percentage points (pp).

### 4.6 Clusters, resampling, seeds

- **Cluster.** Coin × UTC day of the entry instant (for A5, of the run's first close).
- **Bootstrap.** Clusters are resampled with replacement inside each coin, so each coin keeps its number of clusters. `B = 10,000` (20,000 for A3's cell family). Each resample recomputes the statistic and every comparator from the same resampled clusters, so an excess over a baseline is a paired quantity. Intervals are percentile intervals read with `ci_lower(values, 0.025)` and `ci_upper(values, 0.025)` of `src/scripts/cluster-perm-stats.py`. Below, `LB` and `UB` are those bounds and `point` is the full-sample value.
- **Effective clusters.** `kish_eff` applied to the clusters' weight totals `Σ ω` over the statistic's rows. The floor is `FLOOR_CLUSTERS = 50`.
- **Seeds.** Every stream derives from `20261116`. Entry draws are §4.2's. Every other stream is seeded with `arm_seed('20261116', '<window>|<statistic id>|<purpose>')`, purpose one of `bootstrap`, `shuffle`, `perm`. The statistic ids are the keys of the harness's statistic registry, pinned with the harness.
- **Instrument.** The resampling loop is the harness's own, built on the primitives named here. The module has no weighted-ratio cluster bootstrap of its own (§8, correction 10).

### 4.7 Baselines — an effect counts only when it beats every applicable one on the same rows

For an entry, a cell and a side, `o = noEdgeOdds({ side, stopPct, targetPct, sigmaHoldPct: σ_H in percent, liqDistancePct: null })` (`src/lib/pre-trade-calc.ts`). If any of `o.raw.targetFirst`, `o.raw.stopFirst`, `o.pTargetFirst`, `o.pStopFirst` is null, that entry × cell × side is dropped and counted (`null_odds`).

- **(a) The no-edge line with fees.** `f = 0.10` (percent of notional: two taker fills at `takerFeeBps('BINANCE')` = 5 bps each, `src/lib/venue-fees.ts`). For a target-first rate the line is `a_T = min(1, o.raw.targetFirst + (o.raw.targetFirst + o.raw.stopFirst) · f / (stop + target))`, with stop and target in percent as realized for that entry. Among decided brackets a target-first share `p` breaks even when `p·(target − f) = (1 − p)·(stop + f)`, that is at `(stop + f)/(stop + target)`: the fee lifts the no-edge decided share by `f/(stop + target)`. For a stop-first rate the line is `a_S = o.raw.stopFirst`; a fee does not move a stop-first probability.
- **(b) odds-v1's σ-only odds, as served.** `b_T = o.pTargetFirst`, `b_S = o.pStopFirst`. odds-v1 was fitted by W4 on its fit window for its eight coins, and W4's own verdict on both fields is `uncalibrated` (D1). It is used here as what the product currently expects from σ alone, not as a truth.
- **(c) Block-shuffled labels.** Inside each coin × timeframe × window, the time-ordered sequence of labels is cut into runs of equal label and the runs are permuted. A run moves whole: label, confidence and indicator values travel together; outcomes, σ and comparators stay where they are. Label frequencies and run lengths are kept exactly; timing is destroyed. Entry-level statistics shuffle the sequence of entry labels; bar-level statistics (A5, lag, flips) shuffle the per-closed-bar series. `B_c = 1,000` shuffles give the statistic's null values `T*`; `p = (1 + #{T* ≥ S}) / (1 + B_c)` in the expected direction. The label beats (c) when `p ≤ 0.025` and the statistic's interval excludes the mean of `T*`.
- **(d) Always-long, always-short, random side.** For a directional statistic these are computed on the same rows with the side fixed, or averaged over the two sides; the answer states the algebra. For a side-blind statistic the long-only and the short-only version must each clear the criterion.

### 4.8 The five answers — one primary statistic each

`I_T` is 1 when a bracket's label is target first and `I_S` is 1 when it is stop first; both are defined unless the bracket is excluded. `F` is the floor of §6: 3.0 pp for A1–A4, a ratio of 1.10 for A5.

**A1 — TRENDING, with the side minus against it.** Rows: TRENDING at confidence ≥ 60 (the `REGIME_AGAINST_SIDE` trigger). The with-side is long under TRENDING_UP and short under TRENDING_DOWN. `x1 = I_T(with) − I_T(against)`, defined when neither side is excluded. **Primary: `Δ1`**, the cell-averaged `x1` over the 45 cells. Expected sign: positive. Secondary: `Δ1` on all TRENDING rows. Comparators: (a) the same delta of `a_T` — in a with-minus-against delta the fee term cancels to first order, and what remains is the small no-edge asymmetry between a long and a short bracket of equal percentages; the fee-inclusive level test of the with-side is A3's TRENDING-with cells; (b) the same delta of `b_T`; (c) the shuffle; (d) write `Δ1 = U + D`, where `U` is the cell-averaged mean of `x1·1{TRENDING_UP}` and `D` of `x1·1{TRENDING_DOWN}` over the same rows. An always-long caller scores `U − D`, an always-short caller `D − U`, a random side 0. The label beats all three exactly when `LB(Δ1) > 0`, `LB(U) > 0` and `LB(D) > 0`: it has to work in both directions. Read off the code, with no data: confidence ≥ 60 needs ADX above 30, because the 18–25 branch caps confidence at 50 and the 25–30 branch at 55.

**A2 — VOLATILE, stops against the σ-only expectation.** Rows: VOLATILE at confidence ≥ 70 (the `REGIME_VOLATILE` trigger). `x2 = I_S − b_S`, one observation per side. **Primary: `S2`**, the cell-averaged `x2` over the 45 cells and both sides. Expected sign: positive — stops are hit more often than σ alone predicts. Secondary: `S2` on all VOLATILE rows. Comparators: (a) the mean of `I_S − a_S`; (b) is the statistic's own reference, so the test is `LB(S2) > 0`; (c) the shuffle; (d) the long-only and the short-only `S2` each have `LB > 0`. Read off the code: a VOLATILE label always has confidence ≥ 60, and confidence ≥ 70 is the same event as `volatilityRatio ≥ 0.03475`.

**A3 — shape × label against the no-edge line.** 36 cells: the 9 shapes × four label groups, in this order: `TRENDING-with` (TRENDING rows, the side with the label), `TRENDING-against` (the other side), `RANGING` (both sides), `VOLATILE` (both sides). The five holds are pooled with equal weight. Cell statistic: `E(shape, group)` = the hold-averaged ω-weighted mean of `I_T − a_T`. The family is tested at a per-cell one-sided level of `0.025 / 36`; `LB_adj` and `UB_adj` are the bootstrap bounds at that level. **Selection, fit window only:** among cells with at least 50 effective clusters, the cell with the largest `LB_adj`; ties go to the lower shape index, then to the group order above. **Primary: `S3`** = `E` in the selected cell. Expected sign: positive. Comparators in the selected cell: (a) is the statistic's own reference; (b) the mean of `I_T − b_T` has `LB_adj > 0`; (c) the shuffle at `p ≤ 0.025 / 36`; (d) in the two TRENDING groups the cell's excess over the same statistic with the side fixed long, fixed short and averaged over both sides each has `LB_adj > 0`; in the two side-blind groups the long-only and the short-only `E` each have `LB_adj > 0`. Secondary: every one of the 36 cells gets its own state from Benjamini–Hochberg at q = 0.10 over the 36 (§4.11).

**A4 — agreement with key A.** Rows: TRENDING rows whose last closed bar has a dated key-A phase (§4.9). `g = 1` when the label's direction is the phase. `A = Σ ω·g / Σ ω`. With `p_L` the weighted share of TRENDING_UP labels and `p_K` the weighted share of up-phases on the same rows, chance agreement is `A_0 = p_L·p_K + (1 − p_L)(1 − p_K)`, recomputed in every resample. **Primary: `S4 = A − A_0`**, in pp. Expected sign: positive. Comparators: (a) and (b) do not apply (no bracket outcome enters); (c) the shuffle, phases left in place; (d) an always-up label agrees `p_K` of the time, an always-down label `1 − p_K`, a random one one half, so `LB(A − p_K) > 0`, `LB(A − (1 − p_K)) > 0` and `LB(A − 0.5) > 0`. Descriptive, no verdict: **lag** — for each key-A turning point, the closed bars from the turn to the first bar of the per-closed-bar series whose label points the new way, censored at the next turn; median over uncensored turns and the censored share, per timeframe. **Flip-flops** — in the per-closed-bar series, a label that changes and changes back within `N_ff = 3` bars; rate per 1,000 bars. **Confidence monotonicity** — `perm_test` (B = 1,000) of `g` over the five confidence bins (below 50, 50–59, 60–69, 70–79, 80 and above), reported as rho and p.

**A5 — persistence and swing size.** In the per-closed-bar series, a TRENDING run goes from the close `j0` at which a TRENDING label first appears to the close `j1` at which a different label first appears; its length is `j1 − j0` bars. A run cut by a window edge, a span edge or an ineligible bar is excluded and counted (`censored_run`). `y = |ln(C_j1 / C_j0)| ÷ σ_bar(j0)`, with `σ_bar(j0) = volatilityRatio(j0) ÷ ATR_RANGE_PER_SIGMA` at the label's timeframe. Reference `c`: the same quantity for a window of the same length at the place the run lands under shuffle (c) of that series, averaged over the 1,000 shuffles; the move and its σ are read at the shuffled place. A run's weight is `w_coin · w_timeframe`. **Primary: `R5 = Σ ω·y / Σ ω·c`**. Expected: above 1. Comparators: (c) is built into the ratio, and its p-value comes from the same shuffles; (a), (b) and (d) do not apply — no bracket outcome, and the swing is unsigned. Descriptive: run length in bars (weighted mean and median, per timeframe), and the signed move in the label's direction ÷ σ.

### 4.9 Key A — the trend dated in hindsight (CEILING)

Pagan–Sossounov turning points with a Lunde–Timmermann filter, on the log closes of full closed bars, per coin × timeframe, inside each window separately. A bar is a candidate peak (trough) when its log close is the maximum (minimum) of the bars within `w = 7` bars on each side; the first bar wins a tie and a flat stretch has no candidate. Peaks and troughs are made to alternate by keeping the more extreme of two neighbours of the same kind. Then, repeatedly, the smallest swing between adjacent turns is removed while it is below `θ = λ·σ`, `λ = 6`, `σ` = the standard deviation of one-bar log returns of that coin × timeframe × window: an end swing drops its end point, an interior swing drops both of its points. This is the frame's "thresholds scaled by each coin's σ at the label's timeframe".

A bar is in an **up-phase** when it lies at or after a trough and before the next peak, in a **down-phase** when it lies at or after a peak and before the next trough, and is **undated** before the first and after the last turn. An entry takes the phase of its last closed bar; undated rows are excluded and counted. Key A dates direction only. Its volatility leg, used where a primary conditions on VOLATILE, is the mean true range of the 14 bars after the call divided by the entry price, above 0.03 (above 0.03475 where the primary's scope is confidence ≥ 70) — the served rule's own quantity, read forward instead of back. Key A has no ranging state.

### 4.10 Key B — the same rule, seeing bars after the call (NO_LAG)

`keyB(c, τ, t) = served(c, τ, t + 14·I_τ)`: the pinned core, unchanged, on a window that ends 14 bars after the call. The ADX the rule reads is a 14-bar Wilder average of a 14-bar Wilder average, so its memory is about 28 bars; a 14-bar lead centres that memory on the call. This is the frame's "centred window" (§8, correction 3). Key B's label, confidence and indicators replace the served ones for row selection and direction; outcomes are still the brackets opened at `t`. A row needs `t + 14·I_τ` inside the window and an unbroken window, else it is excluded and counted. For bar-level statistics key B's series is the served series read 14 bars later. Leads of 7 and 28 bars are reported beside it, descriptively.

### 4.11 Secondary cells, multiple testing, sensitivity flags

- **Secondary family.** 14 cells: the 12 rows of the component map, A1 on all TRENDING rows, A2 on all VOLATILE rows. Each has a statistic `θ`. `p_works = (1 + #{θ* ≤ 0}) / (1 + B)` and `p_broken = (1 + #{θ* ≥ F}) / (1 + B)` over the bootstrap resamples `θ*`. `bh(pvals, 0.10)` is applied to the 14 `p_works` and, separately, to the 14 `p_broken`. A cell **works** when its point is at least `F` and its `p_works` is BH-significant; it is **broken** when its `p_broken` is BH-significant; otherwise **too little data**. A cell below 50 effective clusters, on either arm of a contrast, is too little data whatever its p-values. Row 7 tests a suppression and exchanges the names: it works when its `p_broken` is BH-significant, and is broken when its point is at least `F` and its `p_works` is BH-significant. Rows 8 and 9 are sign tests: `F` is replaced by 0, so works is "above 0 after BH" and broken is "below 0 after BH". Row 12 has two contrasts: `p_broken = min(1, 2·min(p_a, p_b))` with `p_x = (1 + #{θ_x* ≥ 0}) / (1 + B)`, and `p_works = max(p'_a, p'_b)` with `p'_x = (1 + #{θ_x* ≤ −3.0}) / (1 + B)`.
- **A3's 36 cells** are their own BH family, with the same two-sided construction at q = 0.10.
- **Descriptive tables carry no verdict:** lag, flip-flops, confidence monotonicity, run length, signed swing, `Δ1` by timeframe × hold, key B at leads 7 and 28.
- **Sensitivity flags, reported beside each primary, never replacing it.** `CLUSTER_SENSITIVE`: the state would change with UTC-day clusters pooled across coins, or with coin × 7-day blocks. `WEIGHT_SENSITIVE`: the state would change with every row weight set to 1. `PANEL_SENSITIVE` (hold-out only): the hold-out state would change on the 13 positions that have fit-window rows.

## Answer-key ceiling (PROCEDURE §4d)

| key | role | construction | reading if it fails |
|---|---|---|---|
| A | CEILING | the trend dated in hindsight from bars on both sides of each call: Pagan–Sossounov turning points with a Lunde–Timmermann filter on closed-bar log closes, window 7 bars, threshold 6σ of that coin × timeframe (§4.9); its volatility leg is the true range of the 14 bars after the call | NO_ROOM: with the true phase in hand the statistic still does not clear its baselines, so there is nothing to find and no change to the rule can help |
| B | NO_LAG | the pinned core, unchanged, on a window that ends 14 bars after the call, so it sees bars after the call (§4.10) | INPUTS: the ceiling wins and the rule's own inputs cannot reach it even without lag, so the inputs are the defect |
| S | SERVED | the label a caller would have received at the call: the pinned core at rule version 2 on closed bars (§4.1) | LAG: the inputs carry the answer when they may look ahead and the live label does not deliver it, so the lag is the defect |

Diagnoses: `NO_ROOM` (CEILING fails), `INPUTS` (CEILING wins, NO_LAG fails), `LAG` (NO_LAG wins, SERVED fails).

**How each primary is recomputed under a key.** The key replaces the served label for both row selection and direction; outcomes are unchanged.

- **A1.** CEILING: every row with a dated phase, the with-side being the phase's direction; key A has no confidence, so there is no confidence filter. NO_LAG: rows that key B labels TRENDING at confidence ≥ 60, the with-side being key B's direction.
- **A2.** CEILING: rows whose forward volatility leg is above 0.03475. NO_LAG: rows that key B labels VOLATILE at confidence ≥ 70.
- **A3.** In the fit-selected cell. A TRENDING group is keyed as A1, with no confidence filter under either key. The VOLATILE group is keyed as A2 at 0.03 and at any confidence. Key A has no ranging state, so a RANGING cell has no CEILING: its ladder reads NO_LAG and SERVED only, and reports `LAG` or "not separable: `NO_ROOM` or `INPUTS`".
- **A4.** The CEILING agrees with itself by construction; it is not a test. The informative step is NO_LAG: the agreement of key B's direction with the phase at the call.
- **A5.** The CEILING's runs are key A's phases, each a swing of at least the threshold by construction; it is not a test. NO_LAG: the runs of key B's series.

**Reading rule, fit window only.** Each key's statistic gets a state by §6. Then: CEILING `broken` → `NO_ROOM`. CEILING `works` and NO_LAG `broken` → `INPUTS`. NO_LAG `works` and SERVED `broken` → `LAG`. All three `works` → no defect at that answer. A `too little data` state is reported at the key where it occurs and the ladder stops there. A key that works below one that does not is reported as `INCONSISTENT`, with no diagnosis. A CEILING that holds by construction counts as `works`. The keys are scored before any map row is read. Under `NO_ROOM` the answer's map rows are still reported, marked as read under `NO_ROOM`, and nominate no dial.

## Component map (PROCEDURE §4d)

Fit window only. `Δ1` and `S2` are A1's and A2's statistics (§4.8), recomputed on the slice. Rows 1 to 8 use TRENDING rows at any confidence. "After BH" is §4.11's rule over the 14 secondary cells. Every row is reported as exactly one of works, broken, too little data; none is dropped or pooled.

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

Dials outside the core (§8, correction 1): rows 10 to 12 name constants in `src/lib/pre-trade-rules.ts` and `src/tools/get-market-regime.ts`. The study uses the values 60, 70 and 4h as registered constants and imports neither file.

Four rows state their own criteria, and §4.11 gives the arithmetic for each. Row 7 tests a suppression, so its states are the general ones with the names exchanged: it works when the general rule would say broken, and is broken when the general rule would say works. Rows 8 and 9 are sign tests. Row 12 reads two contrasts against the default; its point criterion is both contrasts at least 0.

## 5. Floors, N and power (PROCEDURE §5)

- **Independence unit and floor.** The unit is the coin × UTC-day cluster. The floor is 50 Kish-effective clusters (`FLOOR_CLUSTERS`), counted under the design weights on the rows a statistic uses. It applies to every primary, every key reading, every A3 cell and each arm of every map row. A statistic below it is too little data, by name. There is no row floor.
- **N.** §4.2: 24 entries per eligible coin-day.
- **Instrument.** Kish arithmetic on the R0 skeleton (D10). No simulation and no outcome. The standard error of a cluster-bootstrapped mean lies between `SD/√K_rows` (rows independent inside a cluster) and `SD/√K_clusters` (a cluster carries one row's information), with `K` the Kish-effective count. The detectable effect at 80% power and a one-sided 2.5% level is `2.80·SD/√K`. Planning SDs: 0.7 for A1's paired delta, 0.35 for a rate minus its expectation, 0.5 otherwise. A row's value is an average over 45 cells, so these are conservative. No calibration is applied.

Equal-weight instance (every row weight 1), from Table 2d:

| window | row set | rows | clusters | Kish-effective clusters | detectable effect if rows were independent (pp) | detectable effect if a cluster carried one row (pp) |
|---|---|---|---|---|---|---|
| fit | all | 576,063 | 8,407 | 7,956 | 0.18 | 1.57 |
| fit | TRENDING | 305,506 | 8,110 | 6,318 | 0.35 | 2.47 |
| fit | TRENDING, confidence ≥ 60 | 195,503 | 6,912 | 5,006 | 0.44 | 2.77 |
| fit | RANGING | 175,350 | 7,340 | 5,158 | 0.23 | 1.36 |
| fit | VOLATILE | 95,207 | 4,128 | 3,497 | 0.32 | 1.66 |
| fit | VOLATILE, confidence ≥ 70 | 83,155 | 3,645 | 3,175 | 0.34 | 1.74 |
| hold-out | all | 311,103 | 4,384 | 4,200 | 0.25 | 2.16 |
| hold-out | TRENDING | 164,434 | 4,223 | 3,290 | 0.48 | 3.42 |
| hold-out | TRENDING, confidence ≥ 60 | 105,169 | 3,613 | 2,609 | 0.60 | 3.84 |
| hold-out | RANGING | 102,064 | 3,879 | 2,793 | 0.31 | 1.85 |
| hold-out | VOLATILE | 44,605 | 1,922 | 1,725 | 0.46 | 2.36 |
| hold-out | VOLATILE, confidence ≥ 70 | 36,802 | 1,607 | 1,475 | 0.51 | 2.55 |

- **What the table says.** The study is limited by clusters, not by entries. With equal weights the fit window brackets a 3.0 pp effect on both sides; the hold-out's upper bracket for A1 is above 3.0 pp. The verdict uses the design weights, which concentrate weight on fewer coins and timeframes. The design-weighted instance is in the vault (D12) and is less favourable than this one in every row set. Under the design weights the row sets of A1's and A2's primaries clear the 50-cluster floor in both windows, the lowest above 100, and so does every row set of Table 2d, the lowest above 60. A3's cells, A4's rows and A5's runs were not counted in R0; they are counted at run time (support table).
- **The underpowered branch, registered.** An effect equal to the floor may therefore return too little data in the fit window or `NOT_CONFIRMED` in the hold-out. That is a live outcome of this design, not a failure of the study. Such a result is reported as `too little data — underpowered` (the procedure's `indeterminate — underpowered`), with the interval's half-width `h`, the effective cluster count, the multiple of coin-days `(h / F)²` that would bring the half-width to the floor, and the calendar month by which the panel supplies them at about 450 coin-days a month (15 positions). The hold-out cannot be extended. What resolves an underpowered hold-out is a successor registration on months after `T_END`.
- **Floors are checked before outcomes.** The harness recomputes the effective clusters and the direction mix of every row set from the realized skeleton, under the design weights, before any outcome is computed in that window.

## Support stress-test (PROCEDURE §4)

Every registered check, the point at which it is evaluated, and what R0 found there. Occupancy figures are the pooled ones of §2, probed by the skeleton run D8 unless a row names another probe.

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| A1 primary `Δ1` | TRENDING rows at confidence ≥ 60, 45 cells, both sides | fit 195,503 rows in 6,912 clusters on 13 positions; hold-out 105,169 rows in 3,613 clusters on 15 positions; both label directions occupied, minority share 0.4555 and 0.4999 (Table 2d) | inside |
| A1 secondary | all TRENDING rows | fit 305,506 rows in 8,110 clusters; hold-out 164,434 rows in 4,223 clusters | inside |
| A2 primary `S2` | VOLATILE rows at confidence ≥ 70, 45 cells, both sides | fit 83,155 rows in 3,645 clusters on 12 of 13 positions; hold-out 36,802 rows in 1,607 clusters on 15 positions. By timeframe the rows are 1,098 / 14,796 / 67,261 (fit) and 206 / 3,411 / 33,185 (hold-out) at 1h / 4h / 1d: the statistic is carried by the 1d label | inside — also reported per timeframe; a timeframe below the cluster floor is named too little data |
| A2 secondary | all VOLATILE rows | fit 95,207 rows in 4,128 clusters; hold-out 44,605 rows in 1,922 clusters | inside |
| A3 cells | each of the 36 shape × label-group cells | fit rows: TRENDING 305,506, RANGING 175,350, VOLATILE 95,207; every shape is defined on every entry (no null odds, D11); effective clusters per cell are counted at run time | floor — a cell below 50 effective clusters is named and cannot be selected |
| A3 nearly inert shape × hold cells | cells in which the no-edge target-first probability is below 1% for more than half the entries | fit, 6 of 45: S2 at 0.5 h; S3 at 0.5 h and 4 h; S4 at 0.5 h, 4 h and 8 h. hold-out, 8 of 45: those six, S3 at 8 h and S4 at 24 h (D11) | inside — occupied but nearly inert. No cell is dropped; the equal hold weights dilute S2, S3, S4 and every pooled statistic, and the CEILING reading measures the level these cells can reach at all |
| A4 primary `S4` | TRENDING rows whose last closed bar has a dated key-A phase | dated share of closed bars 99.4% / 97.9% / 92.7% (fit) and 99.1% / 96.9% / 80.9% (hold-out) at 1h / 4h / 1d; up-phase share of dated bars between 0.44 and 0.55 in every timeframe × window (Table 2b); the joint count with TRENDING rows was not probed | floor |
| A4 lag | each key-A turning point | 3,042 / 846 / 158 turns (fit) and 1,649 / 435 / 85 (hold-out) at 1h / 4h / 1d | inside — descriptive; reported with its count |
| A4 flip-flops | label changes reversed within 3 bars of the per-closed-bar series | series lengths as Table 2a; flips were not counted | floor — descriptive; reported with its count |
| A4 confidence bins | the five confidence bins of TRENDING rows | every bin occupied at every timeframe in both windows; smallest bin 7,230 rows (fit, 1d, 50–59) and 4,124 rows (hold-out, 1h, 50–59) (Table 2e) | inside |
| A5 primary `R5` | uncensored TRENDING runs of the per-closed-bar series | TRENDING bar closes 99,145 / 28,899 / 3,824 (fit) and 52,276 / 15,165 / 2,206 (hold-out) at 1h / 4h / 1d (Table 2a); runs were not counted | floor |
| baselines (a) and (b) | every entry × cell × side | `noEdgeOdds` is non-null for every entry in every cell on the long side (D11); the short side is counted at run time | inside |
| baseline (c) | runs of equal label inside each coin × timeframe × window | all four labels occur at every timeframe in both windows (Table 2a); runs were not counted | floor — a coin × timeframe × window with fewer than 2 runs cannot be shuffled and is named |
| baseline (d) | both label directions inside a directional row set | minority direction share between 0.4555 and 0.4999 (Table 2d) | inside |
| key A as CEILING | rows with a dated phase; rows with a forward volatility leg above the line | dated shares as in the A4 row; the forward volatility leg was not probed | floor |
| key B as NO_LAG | rows whose 14-bar lead stays inside the window | the lead removes the last 14 h, 56 h or 14 days of a window at 1h, 4h, 1d: 14 of 731 fit days and 14 of 304 hold-out days at 1d; key B's label occupancy was not probed | floor |
| map row 1, label age | TRENDING rows with a label at most 14 bars old | not probed | floor |
| map rows 2–5, ADX buckets | TRENDING rows in each of the four ADX buckets | all four occupied at every timeframe; smallest bucket 6,945 rows (fit, 1d, 18–25) and 3,902 rows (hold-out, 1d, 18–25) (Table 2e) | inside |
| map row 6, slope | TRENDING rows with a RISING and with a FALLING slope | fit RISING 48,743 / 42,925 / 42,169 and FALLING 21,772 / 41,911 / 19,994 at 1h / 4h / 1d | inside |
| map row 7, exhaustion | rows meeting the exhaustion condition | fit 6,063 / 8,388 / 5,406 rows at 1h / 4h / 1d, counted in R0 as RANGING rows with ADX above 25 (§8, correction 17) | inside |
| map row 8, structure against ±DI | structure-decided TRENDING rows on which ±DI points the other way | fit 7,126 / 10,439 / 4,643 rows at 1h / 4h / 1d | inside |
| map row 9, volatility line | non-trending rows flagged by each line | fit non-trending rows 103,001 / 86,202 / 81,354 at 1h / 4h / 1d, of which the fixed line flags 2,237 / 23,195 / 69,775; the percentile line flags the same share by construction; its per-coin occupancy was not probed | floor |
| map row 10, TRENDING confidence | both arms | fit 195,503 rows at confidence ≥ 60 and 110,003 below, in 6,912 and 7,289 clusters | inside |
| map row 11, VOLATILE confidence | both arms | fit 83,155 rows at confidence ≥ 70 in 3,645 clusters and 12,052 below in 1,066 clusters | inside |
| map row 12, label timeframe | entries eligible at all three timeframes | 172,567 fit entries and 100,717 hold-out entries; the three timeframes are compared on the same entries | inside |
| fit and hold-out position sets | the positions that carry rows in each window | fit 13 positions, hold-out 15 (D3) | inside — the two windows differ by 2 positions; `PANEL_SENSITIVE` reports the hold-out on the common 13 |
| hold-out floors | the realized hold-out skeleton | recomputed before any hold-out outcome; it must equal Tables 2c and 2d | floor |

## Identifiability (PROCEDURE §4c)

A floor on a directional comparison is bounded by the side mix of the arm it constrains. The mix is the share of the minority label direction among the arm's TRENDING rows, or the minority phase share for A4's fixed-key comparators.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| A1 primary against the fixed-side and random-side callers | fit window, TRENDING at confidence ≥ 60 | 0.4555, probe: the skeleton's count of TRENDING_UP and TRENDING_DOWN rows (Table 2d) | 3.0 | 91.10 | IDENTIFIABLE |
| A1 primary against the fixed-side and random-side callers | hold-out, TRENDING at confidence ≥ 60 | 0.4999, probe: the same count on the hold-out skeleton | 3.0 | 99.98 | IDENTIFIABLE |
| A1 secondary and A3's two TRENDING groups against the fixed-side callers | fit window, all TRENDING rows | 0.4606, probe: the same count | 3.0 | 92.12 | IDENTIFIABLE |
| A1 secondary and A3's two TRENDING groups against the fixed-side callers | hold-out, all TRENDING rows | 0.4963, probe: the same count | 3.0 | 99.26 | IDENTIFIABLE |
| A4 primary against the always-up and always-down labels | TRENDING rows with a dated phase, both windows | 0.4477, probe: the smallest up- or down-phase share of dated bars over timeframes × windows (Table 2b); the row-level share is recomputed at run time | 3.0 | 89.54 | IDENTIFIABLE |
| A2 primary and secondary, A3's two side-blind groups | both sides of every entry | 0.5, by construction: every entry is taken long and short, so the probe is the entry × side count being twice the entry count | 3.0 | 100.0 | IDENTIFIABLE |

The shares above are unweighted. The design-weighted shares of the four TRENDING row sets are in the vault (D12); each is above 0.40, so each bound is above 80 pp. The A4 share was probed on closed bars, not on rows, and has no design-weighted value yet. Before any outcome is computed in a window, the harness recomputes each share under the design weights and its bound through `attainable_bound_from_share` (`ops/monitoring/population_comparison.py`). An arm whose bound is below its floor is reported as `NOT_IDENTIFIABLE` and is not computed. A5's floor is a ratio of an unsigned quantity and follows no side mix, so it has no row here.

## 6. Decision rule (PROCEDURE §6)

Three states per statistic. In the procedure's words, `works` is attributable, `broken` is not-attributable with the cause named, and `too little data` is indeterminate with the cause named.

**The floor.** `F` is 3.0 pp for A1–A4 and a ratio of 1.10 for A5. 3.0 pp is about the shift the round-trip fee itself puts on the break-even decided share of the (1, 2) shape, `f / (stop + target)` = 0.10 / 3: an effect below it is smaller than the cost it would have to carry. 1.10 is a swing one tenth larger than a window of the same length placed elsewhere.

**Fit-window state of a primary and of each key reading.** `S` is the statistic and `e_k` its paired excess over each applicable comparator `k` of §4.8.

- **works** — `point(S) ≥ F`; and `LB(e_k) > 0` for every applicable comparator (a), (b) and (d); and the shuffle (c) gives `p ≤ 0.025` with the interval of `S` excluding the shuffle mean.
- **broken** — `UB(S) < F`: the interval excludes the floor. Or `UB(e_k) < 0` for an applicable comparator, or `UB(S)` below the shuffle mean: the label is reliably no better than a baseline.
- **too little data** — neither of the two. Also: fewer than 50 effective clusters, or a §4c bound below the floor (then reported as `NOT_IDENTIFIABLE`).

For A5 the reference value is 1, not 0: works is `R5 ≥ 1.10`, `LB(R5) > 1` and shuffle `p ≤ 0.025`; broken is `UB(R5) < 1.10`. For A3 the bounds are `LB_adj` and `UB_adj` (§4.8): works is `S3 ≥ F` with `LB_adj > 0` against every comparator in the selected cell; broken is `UB_adj(E) < F` in every cell that has at least 50 effective clusters, so no cell can hold the floor; with no such cell the state is too little data.

A null counts only when the interval excludes the floor. A point below the floor whose interval reaches it is too little data, not broken.

**What is expected under each state.**

| answer | primary | works | broken | too little data |
|---|---|---|---|---|
| A1 | `Δ1` | positive and at least 3.0 pp, and positive in both label directions (`U`, `D`) | an interval wholly below 3.0 pp (zero, negative, or positive but under the floor), or a reliably negative `U` or `D` | an interval that reaches 3.0 pp while a criterion for works is unmet |
| A2 | `S2` | positive and at least 3.0 pp, on the long and on the short side | an interval wholly below 3.0 pp, or reliably negative on one side or against the fee-free line | an interval that reaches 3.0 pp while a criterion for works is unmet |
| A3 | `S3` | positive and at least 3.0 pp in the selected cell after the 36-cell adjustment | every eligible cell's adjusted interval wholly below 3.0 pp | some eligible cell's adjusted interval reaches 3.0 pp, without the selected cell meeting works |
| A4 | `S4` | positive and at least 3.0 pp above chance, and above each constant label | an interval wholly below 3.0 pp, or agreement reliably below a constant label's | an interval that reaches 3.0 pp while a criterion for works is unmet |
| A5 | `R5` | at least 1.10 and reliably above 1 | an interval wholly below 1.10 | an interval that reaches 1.10 while a criterion for works is unmet |

**Hold-out.** Only the five primaries are tested, each carrying its fit-window state. The order is fixed.

1. `NOT_IDENTIFIABLE` — on the realized hold-out skeleton the primary's rows have fewer than 50 effective clusters, or its §4c bound is below the floor. This is checked before any hold-out outcome is computed, and the primary is then not computed. A3 with no fit-selected cell is `NOT_IDENTIFIABLE`.
2. `CONFIRMED` — the hold-out estimate has the fit-window sign (the sign of `S` for A1–A4, of `R5 − 1` for A5), and its 95% cluster-bootstrap interval excludes every baseline's value on that side: for each applicable comparator (a), (b) and (d) the interval of the paired excess excludes 0 on the side of the fit-window sign, and the shuffle gives `p ≤ 0.025` in that tail.
3. `NOT_CONFIRMED` — anything else.

A3's hold-out test is the fit-selected cell alone, whatever its fit-window state, at plain 95% bounds: nothing is selected in the hold-out. `CONFIRMED` confirms the fit-window finding whatever it was; a fit-window estimate with the unexpected sign that is confirmed is a confirmed adverse finding. The floor is not part of `CONFIRMED`. The hold-out estimate and its interval are reported beside the state, the shrinkage from fit to hold-out is reported explicitly, and the hold-out figure is the usable one.

The result carries two lines. The second is the frame's; the first is added (§8, correction 11).

```
REGIME_DIAG_FIT=A1:<works|broken|too_little_data>;A2:<…>;A3:<…>;A4:<…>;A5:<…>
REGIME_DIAG_VERDICT=A1:<state>;A2:<state>;A3:<state>;A4:<state>;A5:<state>
```

What follows from a state is not decided here. T4 and the later waves of the arc read the states; this file only fixes how they are reached.

## 7. The post-result respecification test (PROCEDURE §7)

After the read, any proposed change to a statistic, a row set, a slice, a comparator, a weight, a cluster definition or a constant of this file (`w`, `λ`, the 14-bar lead, `F`, `N_ff`, the shapes, the holds, the entry rate, the seed) is put to one question: **would this have been proposed had the check passed?**

- If not, it is a correction. It is registered in a new file and applied only to rows after `T_END`, which nobody has seen. The corrected value on the windows of this file may be disclosed as `seen — not a test input`, and never as a result.
- The hold-out is spent by one read. The seal refuses a second one, and no respecification reopens it.
- This does not cover a defect found before any outcome exists: one found by the skeleton reproduction or by the pre-read audit is fixed, and recorded as an appended amendment, before the read.

## 8. Deviations, quarantine, publication (PROCEDURE §8)

- A deviation from this file is recorded with its reason: before the read as an appended amendment here, during the read in the result. It is never absorbed, and rows computed under a deviation are reported apart.
- **Figures are vault-only.** Every outcome figure of the read goes to the private vault. This repository receives none: not under `audits/`, not in a fixture, not in a commit message. W2 writes the findings. This wave writes the registration, the harness and an evidence file of cardinalities.
- **Publication.** Answers 1 to 3 are internal. Answers 4 and 5 may be published only through T7 of the arc and with Mr.1's explicit approval.
- **No census figure in this repository.** The panel's coin names, its weights and every figure derived from the weights stay in the vault. This file cites the census by path and sha256, and the harness reads it at run time.
- **Prior consumers.** The archives are public venue data. The only earlier consumer of the hold-out months is W4 (D1).

**Corrections to the frame of §11.** The frame was fixed before R0. Where this file departs from it or completes it, the point is listed here; the frame is reproduced unchanged.

1. **Dials outside the core.** The frame's map names the 60 and 70 triggers and the 4h default. They are not in `src/lib/market-regime-core.ts`: `REGIME_AGAINST_MIN_CONFIDENCE = 60` and `VOLATILE_MIN_CONFIDENCE = 70` are in `src/lib/pre-trade-rules.ts`, and the `'4h'` default is in `src/tools/get-market-regime.ts`. The study carries the three values as registered constants. §10 cites both files by git blob; they are not guard pins. A harness test fails when a file's value differs from the registered constant.
2. **The slope fit.** The frame says "5-bar slope fit". The call is `adx(highs, lows, closes, 14, 5)`, and the slope is a least-squares line through the last 6 ADX values (`slopeLen + 1`).
3. **Key B's "centred window".** It is the pinned core on a window ending 14 bars after the call (§4.10).
4. **One entry draw.** The frame sets N per coin × timeframe. This file draws one seeded set of entries per window × position, at 24 per eligible coin-day, and evaluates every entry at each timeframe it is eligible at (§4.2). N per coin × timeframe follows from the draw.
5. **History.** "At least the core's `CANDLE_COUNTS` history" is applied per timeframe: an entry needs the 1h and 4h windows (10,080 minutes each) and has a 1d row only with 144,000 minutes.
6. **Coverage.** 429 of the 510 coin-months exist. Two positions have no fit-window month, so the fit window runs on 13 positions and the hold-out on 15 (D3). `PANEL_SENSITIVE` reports the hold-out on the common 13.
7. **The guard.** `checkOutcomeGuard` also checks a store manifest whose builder is bound to the support/resistance study's series store. The harness calls it unmodified, satisfies that leg with an empty plan (no coins) kept in the study's own store directory, and adds its own legs: the archive-store manifest, the census sha256, the core-parity fixture and the hold-out seal (§1).
8. **The fee line.** `noEdgeOdds` takes no fee. Baseline (a) adds the fee as the shift of the break-even decided share (§4.7) and leaves the stop-first line unshifted.
9. **Public tables are pooled.** Positions appear here as P01–P15 and in two groups. Names and per-position tables are in the vault.
10. **Resampling.** `src/scripts/cluster-perm-stats.py` has no weighted-ratio cluster bootstrap. The harness's loop is its own and uses the module's `ci_lower`, `ci_upper`, `kish_eff`, `arm_seed`, `bh`, `perm_test` and `FLOOR_CLUSTERS`.
11. **Additions to the readout.** The `REGIME_DIAG_FIT` line, and the three sensitivity flags of §4.11.
12. **Republished archives.** The venue republished 8 of the cached files after W4 fetched them. This study reads the current files from an overlay (D7).
13. **Twelve map rows.** The frame's seven slice families become 12 rows: four ADX buckets, two confidence rows. The 40+ bucket adds a fourth literal, `adxVal > 40`, to the frame's 25, 30 and 18.
14. **Key A beyond direction.** A turning-point dating has no volatile and no ranging state. A2's CEILING uses a forward volatility leg (§4.9); a RANGING cell of A3 has no CEILING; A4's and A5's CEILING hold by construction.
15. **σ.** The replay uses the unrounded volatility ratio; production reads a rounded snapshot value (§4.3).
16. **Import closure.** §10 pins the core and the modules whose arithmetic it uses. Modules the closure reaches only for error copy or for the list of timeframes are not pinned byte for byte; the core-parity fixture covers the behaviour instead.
17. **Exhaustion.** R0 counted the slice as RANGING rows with ADX above 25 (Table 2e). The registered slice is the branch condition of map row 7. The two differ by rows that reach RANGING through an exact ±DI tie. The skeleton reproduction reports both counts; Table 2e's is the one compared.

## 9. Owner, the read, and the inheritors (PROCEDURE §9)

- **Owner** of this registration and of the harness: `EDGE-REGIME-DIAG-W1`.
- **The read:** `EDGE-REGIME-DIAG-W2`, once, under this file and its appended amendments.
- **Inheritors,** ARC-REGIME-ACCURACY: T4 (answers 1 and 2) · T5 and T6 (the scorecard and the harness; each challenger round registers under PROCEDURE §4d and inherits the keys, the floors and the seal) · T7 (answers 4 and 5, the only route to publication). A successor on months after `T_END` inherits §5's underpowered branch.

## 10. Pinned artifacts

sha256 of the file bytes at commit `0c6cf777271bfc03b77707ffd94b7366e39a3cda`, the base of this wave. Each pinned file is byte-identical on the `origin/main` commit this file lands on; that is re-checked immediately before landing. `pinsOf` (`src/scripts/sr-backtest/guard.ts`) reads every row whose first two cells are backticked. The harness hands the file rows of this table, and of the pin section appended in CH2, to `checkOutcomeGuard` as its pinned list. A pinned file that differs by one byte refuses the read.

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
| `census:regime-census-2026-11-16.json` | `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a` | the frozen census in the vault; checked by the harness's own leg |
| `spec:EDGE-REGIME-DIAG-W1.md#section-1` | `bbb1769eaa92327a700fb80824eb54d087265e2354213b0e66f062c092c7dd60` | the frame reproduced in §11 |

**Cited, not pinned.** The first cell is not backticked, so `pinsOf` skips these rows.

| file | identity | why it is cited |
|---|---|---|
| scripts/odds-calibration-study.py | sha256 `fda34fec72c3c7df4f0922d1638b1314845a11183bdc6c230a1ddaf3af51c857` | W4's archive reader: the URL form, the checksum check and the row rules that §3 states. The harness does not import it |
| src/lib/pre-trade-rules.ts | git blob d0cc2f30f516eee9cf888ff4665241db43566597 | holds the 60 and 70 triggers (§8, correction 1) |
| src/tools/get-market-regime.ts | git blob 57a8e733d7648434d0cbedae4044d55b833b03f1 | holds the 4h default (§8, correction 1) |
| audits/PREREGISTRATION-PROCEDURE.md | sha256 `c1f65e138690a7c1c07881df981b751b7c1931749f217ae2416e15f26c3c5fe0` | the procedure as read for this file |
| tests/unit/preregistration-support-stress-test.test.ts | sha256 `7b675487c95fd907ffb6d152586b2f00d585c6568909b26a06e8f1cd9581663f` | the gate this file passes |

**Not pinned byte for byte** (§8, correction 16). The core's closure also reaches `src/lib/capabilities.ts` (the list of timeframes) and, through its refusal type, `src/lib/nudge-copy.ts`, `src/lib/quota-notice.ts`, `src/lib/plans.ts`, `src/lib/referral-constants.ts` and `src/lib/utc-day.ts` (error copy). The guard's closure reaches `src/scripts/sr-probe/store.ts`, `src/scripts/sr-backtest/spec.ts` and `src/scripts/sr-probe/level-v0.ts` for its own store leg. None of them enters a label or a statistic of this study. The core-parity fixture pinned in CH2 refuses the read if the core's output changes for any reason.

**Who enforces what.** `checkOutcomeGuard` enforces the file rows and its own store manifest. The harness's legs enforce the census row, the archive-store manifest, the core-parity fixture and the seal. The spec row is a citation, reproducible by the command in §11.

**Still to come,** as an appended pin section before any read: the harness files under `src/scripts/regime-diag/` and `scripts/regime-diag/`, the statistic registry, the core-parity fixture, the archive-store manifest and the guard's store manifest.

## 11. The wave spec's §1 frame, verbatim

Lines 6–46 of `Prompt/EDGE-REGIME-DIAG-W1.md` (planning vault) as they stood when this file was written: 5,179 bytes, sha256 `bbb1769eaa92327a700fb80824eb54d087265e2354213b0e66f062c092c7dd60`. The block between the two fence lines below reproduces them byte for byte. Its first line is the frame's own heading, not a section of this file. To reproduce the hash from this file:

`` awk '/^## 11\. /{s=1;next} s&&/^[`]{3}/{n++;next} s&&n==1' audits/regime-diagnostic-preregistration-2026-11-16.md | shasum -a 256 ``

```
## 1. Pre-registration frame (fixed now; CH1 completes it into the registration file and lands it before any outcome is computed)
- **Rule under study:** `computeMarketRegimeCore` in `src/lib/market-regime-core.ts`. The replay CALLS the landed core at the pinned blob on closed bars and never re-implements it. First line: `SERVED_RULE_STUDY: src/lib/market-regime-core.ts · MARKET_REGIME_RULE_VERSION = 2`.
- **Data:** Binance USDⓈ-M 1 m monthly archives in W4's URL form and cache (`scripts/odds-calibration-study.py` `ensure_archive`, `load_month`). 1h, 4h and 1d bars are aggregated from 1 m and parity-checked against Binance's own 1h, 4h and 1d archives.
- **Panel and weights:** the frozen census, vault `audits/regime-census-2026-11-16.json`, sha256 `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a`, field `t3_weights`. It supplies 15 coins, the timeframe weights, equal weights over the 9 shapes, and equal weights over the holds {0.5, 4, 8, 24, 72} h. Cited by path and sha256 and read at run time; no census figure enters the public repo. A coin counts only in months its archive exists; coverage carries two denominators (§3).
- **Entries:** uniform random 1 m bar opens with at least the core's `CANDLE_COUNTS` history behind each, both sides at every entry, seed `20261116`. N per coin × timeframe is set in CH1 from §5 power, before any outcome.
- **σ and shapes:** σ_1h is the production estimator (`sigma1hFromVolatilityRatio`, `src/lib/pre-trade-calc.ts`) on 1h bars closed before the entry; σ_H = σ_1h·√hold. Shapes (stop %, target %): {(0.5, 0.75), (1, 2), (2.5, 5), (5, 10), (1σ_H, 2σ_H), (0.5, 0.5), (1σ_H, 1σ_H), (1, 0.5), (1σ_H, 0.5σ_H)}.
- **Labels from the 1 m path, as W4:** target or stop touched by the high or low; time-out at hold end; a bar touching both is excluded and counted. Path labels only, never PnL.
- **Baselines:** an effect counts only when it beats every one of them on the same rows:
  - (a) the no-edge line with Binance round-trip taker fees (`noEdgeOdds`, `takerFeeBps`);
  - (b) odds-v1's σ-only odds (`src/lib/pre-trade-odds-calibration.ts`), so the label must add information beyond volatility;
  - (c) block-shuffled labels, which keep each coin's label frequencies and run lengths and destroy their timing;
  - (d) always-long, always-short and random side (`CLAUDE.md` benchmark-before-publish).
- **Answer keys, first (PROCEDURE §4d):**
  - CEILING is key A: the true regime dated afterwards (Pagan–Sossounov turning points with a Lunde–Timmermann filter, thresholds scaled by each coin's σ at the label's timeframe).
  - NO_LAG is key B: the same core on a centred window, which sees bars after the call.
  - SERVED is the replayed label.
  - Readings: NO_ROOM, INPUTS, LAG.
- **The five answers.** CH1 fixes one primary statistic for each, within these definitions:
  - A1: the target-first rate with the side minus against it, for TRENDING labels, both overall and at confidence ≥ 60 (the `REGIME_AGAINST_SIDE` trigger);
  - A2: the stop-first rate under VOLATILE minus its σ-only expectation, both overall and at confidence ≥ 70;
  - A3: shape × label against the no-edge line;
  - A4: agreement with key A, lag (bars from a key-A turn to the label's flip), flip-flops (flips reversed within N bars), and whether confidence bins are monotone;
  - A5: persistence (label run length) and swing size (|move| over a label's life, divided by σ).
- **Component map (§4d): the slices, read on the fit window only**, each ending works, broken or too little data. Each slice isolates one dial:
  - label age (`regime_since_ms`) → ADX(14) and the 5-bar slope fit;
  - ADX bucket 18–25 · 25–30 · 30–40 · 40+ → the `25`, `30` and `18` literals;
  - slope falling / flat / rising → `ADX_SLOPE_RISING`, `ADX_SLOPE_FALLING`, `0.8`, `-1.0`;
  - price structure vs ±DI disagreeing → the tie-break;
  - volatility, fixed `0.03` vs a per-coin percentile → the `0.03` line;
  - confidence bins → the confidence formulas and the 60 and 70 triggers;
  - label timeframe vs hold → the 4h default.

  CH1 confirms every dial name against the pinned blob.
- **Clusters:** coin × UTC day, with cluster bootstrap and permutation from `src/scripts/cluster-perm-stats.py`. Secondary cells are corrected with BH.
- **Windows:** fit 2024-01-01 → 2025-12-31. Hold-out 2026-01-01 → 2026-10-31, read once. §2 discloses W4's single unconditional read of 2026; this is the first regime-conditioned read of 2026.
- **Hold-out test (fixed here):** only the five primary statistics, each carrying its fit-window verdict.
  - CONFIRMED: the hold-out estimate has the fit-window sign, and its 95% cluster-bootstrap CI excludes every baseline's value.
  - NOT_CONFIRMED: otherwise.
  - NOT_IDENTIFIABLE: its §4c bound or its §5 floor fails on the realized hold-out skeleton. This is checked before the statistic is computed.
  - One line, `REGIME_DIAG_VERDICT=A1:<state>;A2:<state>;A3:<state>;A4:<state>;A5:<state>`.
- **Who sees what:** answers 1–3 stay internal; 4–5 can be published only through T7 and Mr.1's OK. Figures vault-only (counterfactual-quarantine pattern).
```

## Amendment 2026-11-16 — the harness pins, the statistic registry, one correction and the harness's readings (pre-read; recorded per §1 and §8 / PROCEDURE §8 with its reason)

**Write-time clock (live `date -u`):** 2026-11-16T10:44:04Z.

**Ordering.** Pre-read. No outcome statistic has been computed on real archives. On real archives the harness has run `--init-store` (the two manifests pinned below), `--skeleton` (labels and cardinalities only; it reproduced Tables 2a–2e of §2 with no difference, again with the files pinned here) and two `--fit` attempts, each refused by the guard at leg (ii) because this section had not landed. The study store's guard log holds exactly those two entries, both refusals. Every harness test runs on synthetic series. The body above is unchanged: its 80,855 bytes (sha256 `4cec7d3088b4c4e95793453140e9bad0c16978862b8a9f0807d97a1bd2688325`, as landed at commit `3935d83c5bb18edd852bed5ec712a3f2187308ec`) open this file, and `tests/unit/regime-diag-guard.test.ts` holds that.

**Reason.** §1 and §10 announce this section: the harness files, the statistic registry, the core-parity fixture, the archive-store manifest and the guard's store manifest are pinned before any read. Writing the harness test-first on synthetic fixtures also found one registered value at which a check cannot be evaluated (A2), and reached places where the body is silent or admits more than one reading (A4). Each is fixed here while no outcome exists, so that none can be chosen by a result. PROCEDURE §7 does not apply: there is no result to respecify after.

### A1. Pins

sha256 of the file bytes as committed with the harness, immediately before this section. The guard re-hashes each file on disk before every read. If a pinned file changes before the read, a later appended pin section re-pins it: `pinsOf` keeps the last row for a name.

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-diag/archive.ts` | `99b2c1407f000c4bd75d4bdaeba3b28f555461dc59f8aadc6a350e3b57061710` | the 1 m archive reader: the row rules of §3, the minute grid, the bars of §4.1, the archive-store manifest |
| `src/scripts/regime-diag/bars.ts` | `9aa62d3d082e76516b399dfd3d92c9e87c29f708185be84e124dc1dc52ff7687` | the bar-level statistics: A5, lag, flip-flops |
| `src/scripts/regime-diag/decide.ts` | `fcc5c410282c8515b9ec8b267b8a7aa5901d9e0ba054e5f30693a874fb919f94` | the decision rule: the states of §6, A3's selection, the secondary families, the ladder, the result lines |
| `src/scripts/regime-diag/diag-spec.ts` | `e7c400a4f4a64f676203a8c8c0d7bad5afb073d160480ac948f90eb0fb573dc5` | the registered constants and the statistic registry (A3 below) |
| `src/scripts/regime-diag/engine.ts` | `5c16b35bcd48e6b2a12d7058d621585c761b2337e938595587fe9d35dc1b78b7` | clusters, the cluster bootstrap, the block shuffle, the paired comparators |
| `src/scripts/regime-diag/frame.ts` | `641442922a0570ff03f519667333e9c410531cfa77851445be00a00c4db48bc8` | the frame of a window, Tables 2a–2e and their comparison with §2, the census reader |
| `src/scripts/regime-diag/guard.ts` | `a12e63d8609bd9940695cc2c3c3211fbd0a2a64ca03afaa16d913766c912dce6` | the outcome guard and the hold-out seal (§1) |
| `src/scripts/regime-diag/keys.ts` | `d5a77768ff2f9bfc03f545b84579ff38d9f8edfec0e17e996e7f1e828efcd9c5` | key A and key B (§4.9, §4.10) |
| `src/scripts/regime-diag/labeler.ts` | `e1caa44ababfe3a6edc1016be93468b7ef3f3ed645775418a11c2b06a3d3f3ce` | the entry draw, the 1 m path label, baselines (a) and (b) (§4.2, §4.4, §4.7) |
| `src/scripts/regime-diag/mutate.ts` | `dbeeccbefc8904e570c1488052c6bfb3f203201fdc979a0159ed15beebffb004` | the test-only mutation lever; the guard refuses when it is set |
| `src/scripts/regime-diag/parity.ts` | `b67ba354d06e7938b4e236e75ed2b0a3edcff751147acf64773501bbcf9fc223` | the core-parity check (§1, leg v) |
| `src/scripts/regime-diag/prims.ts` | `c48851bc54be05e2677aa0ea8185f7ac53279146f4d6b2d12616542f20f34d01` | the bridge to `scripts/regime-diag/prims.py` |
| `src/scripts/regime-diag/replay.ts` | `21f18c3a5c15704d67828d09d80419f2ef2415c294a7d57bff0c8e12a8ab40a5` | the replay: the served label at an instant, by calling the pinned core |
| `src/scripts/regime-diag/rng.ts` | `0600473fab31d7e5ac65c7067a16a6250a6378a97cd99e09edfb732809dbe01e` | the seeded streams (§4.2, §4.6) |
| `src/scripts/regime-diag/run.ts` | `45faeea71b2b67ec836997f2572129134b305fe44f3972ae153ed6865ec8541c` | the run CLI and the order of the read (§1) |
| `src/scripts/regime-diag/stats.ts` | `0526b8e7f5ce9d0844da6fed2b8d78db51c91d4d36aee2e021963f44dd047fb1` | the five statistics, their key readings and the component-map slices (§4.8–§4.11) |
| `src/scripts/regime-diag/synth.ts` | `c53c571f1962e9b9f665fd9d8456c190d458d46e63f3daefd3e78b38a4b5afa1` | the synthetic series the core-parity fixture replays; the tests build on it |
| `scripts/regime-diag/prims.py` | `3cff7107bfe6352be605b8109ef21f0763acf5f8f6fe744f9dfcecc243686037` | calls the pinned primitives of `cluster-perm-stats.py` and `population_comparison.py`; no statistic of its own |
| `tests/fixtures/regime-diag/core-parity.json` | `75026a14853b8043fed4755a1550a84cfe1e702c5f715984aa65fdf491e4b9a7` | the core-parity fixture: 70 calls on one synthetic series (40 at 1h, 20 at 4h, 10 at 1d) |
| `store:regime-diag-archives.json` | `b177bd0d4cba9ff46f4a8bc8e2f44b57c0f996457e8a2f3f0b21308b33e6ae1a` | the archive-store manifest: every 1 m archive the panel resolves to, with its sha256 (429 files: 421 from the cache, 8 from the overlay of §2 D7) |
| `store:manifest-BINANCE.json` | `57c995bbfb65cf07fb210b64b94c6e9e99d866543b5842d52da59cca8d755e53` | the store manifest `checkOutcomeGuard` checks, over an empty plan: this study reads no candle store (§8, correction 7) |

The archive-store manifest and the guard's store manifest live in the study store, outside this repository (§8: the manifest's file names carry the panel). `run.ts --init-store` writes both and prints the two sha256 above. The harness's own legs enforce the first row of the two; `checkOutcomeGuard` enforces the second.

### A2. Correction — A3's shuffle count (a deviation, with its reason)

§4.7 (c) fixes `B_c = 1,000` shuffles, and §4.8 reads A3's shuffle at `p ≤ 0.025 / 36`. With 1,000 shuffles the smallest value `p = (1 + #{T* ≥ S}) / (1 + B_c)` can take is `1 / 1,001`, which is above `0.025 / 36`: the criterion could not be met by any data. A check evaluated at a value the statistic cannot take is undefined, not failed (PROCEDURE §4). A3's selected-cell reading therefore uses `B_c = 20,000` shuffles (smallest `p` = `1 / 20,001`), for `A3.S`, `A3.B`, `A3.A` and A3's sensitivity variants, in both windows. Every other statistic keeps `B_c = 1,000`, and A5's reference (§4.8) keeps its 1,000 shuffles. Found while writing the decision rule's tests on synthetic fixtures. Nothing else in §4.6–§4.8 changes.

### A3. The statistic registry (§4.6)

The ids below are the `<statistic id>` of every seed `arm_seed('20261116', '<window>|<statistic id>|<purpose>')`; `<window>` is `fit` or `holdout`, `<purpose>` is `bootstrap`, `shuffle` or `perm`. A count of 0 means the stream does not exist for that id. The table is `STATISTICS` of `src/scripts/regime-diag/diag-spec.ts`; a test holds the two together.

| statistic id | bootstrap | shuffle | perm | what it is |
|---|---|---|---|---|
| `A1.S` | 10,000 | 1,000 | 0 | Δ1 on served TRENDING rows at confidence ≥ 60 |
| `A2.S` | 10,000 | 1,000 | 0 | S2 on served VOLATILE rows at confidence ≥ 70 |
| `A3.cells` | 20,000 | 0 | 0 | E(shape, group) in the 36 cells, served labels |
| `A3.S` | 20,000 | 20,000 | 0 | S3 = E in the fit-selected cell, served labels |
| `A4.S` | 10,000 | 1,000 | 0 | S4 = A − A_0 on served TRENDING rows with a dated phase |
| `A5.S` | 10,000 | 1,000 | 0 | R5 on the TRENDING runs of the served per-closed-bar series |
| `A1.B` | 10,000 | 1,000 | 0 | Δ1 under key B (NO_LAG) |
| `A1.A` | 10,000 | 1,000 | 0 | Δ1 under key A (CEILING) |
| `A2.B` | 10,000 | 1,000 | 0 | S2 under key B (NO_LAG) |
| `A2.A` | 10,000 | 1,000 | 0 | S2 under key A (CEILING: the forward volatility leg) |
| `A3.B` | 20,000 | 20,000 | 0 | S3 in the fit-selected cell under key B |
| `A3.A` | 20,000 | 20,000 | 0 | S3 in the fit-selected cell under key A |
| `A4.B` | 10,000 | 1,000 | 0 | S4 under key B (NO_LAG) |
| `A5.B` | 10,000 | 1,000 | 0 | R5 on the runs of key B's series |
| `A4.mono` | 0 | 0 | 1,000 | confidence monotonicity of the agreement g |
| `A1.all` | 10,000 | 0 | 0 | secondary: Δ1 on all TRENDING rows |
| `A2.all` | 10,000 | 0 | 0 | secondary: S2 on all VOLATILE rows |
| `A2.tf.1h` | 10,000 | 0 | 0 | descriptive: S2 on the 1h rows of A2's primary |
| `A2.tf.4h` | 10,000 | 0 | 0 | descriptive: S2 on the 4h rows of A2's primary |
| `A2.tf.1d` | 10,000 | 0 | 0 | descriptive: S2 on the 1d rows of A2's primary |
| `M01` | 10,000 | 0 | 0 | young labels |
| `M02` | 10,000 | 0 | 0 | ADX (18, 25] |
| `M03` | 10,000 | 0 | 0 | ADX (25, 30] |
| `M04` | 10,000 | 0 | 0 | ADX (30, 40] |
| `M05` | 10,000 | 0 | 0 | ADX above 40 |
| `M06` | 10,000 | 0 | 0 | slope RISING minus FALLING |
| `M07` | 10,000 | 0 | 0 | exhaustion |
| `M08` | 10,000 | 0 | 0 | structure against ±DI |
| `M09` | 10,000 | 0 | 0 | volatility line |
| `M10` | 10,000 | 0 | 0 | TRENDING confidence |
| `M11` | 10,000 | 0 | 0 | VOLATILE confidence |
| `M12` | 10,000 | 0 | 0 | label timeframe |
| `A1.S@day` | 10,000 | 1,000 | 0 | Δ1 on served TRENDING rows at confidence ≥ 60 — sensitivity variant day |
| `A1.S@week` | 10,000 | 1,000 | 0 | Δ1 on served TRENDING rows at confidence ≥ 60 — sensitivity variant week |
| `A1.S@unit` | 10,000 | 1,000 | 0 | Δ1 on served TRENDING rows at confidence ≥ 60 — sensitivity variant unit |
| `A1.S@panel13` | 10,000 | 1,000 | 0 | Δ1 on served TRENDING rows at confidence ≥ 60 — sensitivity variant panel13 |
| `A2.S@day` | 10,000 | 1,000 | 0 | S2 on served VOLATILE rows at confidence ≥ 70 — sensitivity variant day |
| `A2.S@week` | 10,000 | 1,000 | 0 | S2 on served VOLATILE rows at confidence ≥ 70 — sensitivity variant week |
| `A2.S@unit` | 10,000 | 1,000 | 0 | S2 on served VOLATILE rows at confidence ≥ 70 — sensitivity variant unit |
| `A2.S@panel13` | 10,000 | 1,000 | 0 | S2 on served VOLATILE rows at confidence ≥ 70 — sensitivity variant panel13 |
| `A3.cells@day` | 20,000 | 0 | 0 | E(shape, group) in the 36 cells, served labels — sensitivity variant day |
| `A3.cells@week` | 20,000 | 0 | 0 | E(shape, group) in the 36 cells, served labels — sensitivity variant week |
| `A3.cells@unit` | 20,000 | 0 | 0 | E(shape, group) in the 36 cells, served labels — sensitivity variant unit |
| `A3.cells@panel13` | 20,000 | 0 | 0 | E(shape, group) in the 36 cells, served labels — sensitivity variant panel13 |
| `A3.S@day` | 20,000 | 20,000 | 0 | S3 = E in the fit-selected cell, served labels — sensitivity variant day |
| `A3.S@week` | 20,000 | 20,000 | 0 | S3 = E in the fit-selected cell, served labels — sensitivity variant week |
| `A3.S@unit` | 20,000 | 20,000 | 0 | S3 = E in the fit-selected cell, served labels — sensitivity variant unit |
| `A3.S@panel13` | 20,000 | 20,000 | 0 | S3 = E in the fit-selected cell, served labels — sensitivity variant panel13 |
| `A4.S@day` | 10,000 | 1,000 | 0 | S4 = A − A_0 on served TRENDING rows with a dated phase — sensitivity variant day |
| `A4.S@week` | 10,000 | 1,000 | 0 | S4 = A − A_0 on served TRENDING rows with a dated phase — sensitivity variant week |
| `A4.S@unit` | 10,000 | 1,000 | 0 | S4 = A − A_0 on served TRENDING rows with a dated phase — sensitivity variant unit |
| `A4.S@panel13` | 10,000 | 1,000 | 0 | S4 = A − A_0 on served TRENDING rows with a dated phase — sensitivity variant panel13 |
| `A5.S@day` | 10,000 | 1,000 | 0 | R5 on the TRENDING runs of the served per-closed-bar series — sensitivity variant day |
| `A5.S@week` | 10,000 | 1,000 | 0 | R5 on the TRENDING runs of the served per-closed-bar series — sensitivity variant week |
| `A5.S@unit` | 10,000 | 1,000 | 0 | R5 on the TRENDING runs of the served per-closed-bar series — sensitivity variant unit |
| `A5.S@panel13` | 10,000 | 1,000 | 0 | R5 on the TRENDING runs of the served per-closed-bar series — sensitivity variant panel13 |

A sensitivity variant (`@day`, `@week`, `@unit`, `@panel13`) has its own streams and the counts of its primary. `A3.cells` is the 36-cell family of §4.8: selection, the every-cell rule and the BH family read its resamples.

### A4. Readings — where the body is silent or admits more than one reading

Each line is what the pinned harness does. None was chosen with an outcome in hand.

**Archives, replay, entries (§3, §4.1, §4.2).**

1. Every kline field passes a strict decimal pattern before it becomes a number; a row that fails is not kept.
2. A seed value — the first four bytes of the sha256 of §4.2 for an entry draw, the value of `arm_seed` for every other stream — seeds mulberry32.
3. Minute-level drops carry one name each. A window minute that holds a 1 m row and is not eligible counts `path_beyond_window` when `m + 4,320` passes the window's end; otherwise `short_history` when `m − 10,080` falls before the later of the grid origin and the coin's first row; otherwise `gap`.
4. The per-closed-bar series is computed over the whole span, not per window. A label's age (map row 1) is the number of consecutive closes, ending at the latest bar boundary at or before the entry, that carry the entry's label; it is 0 when the series' label at that boundary differs from the entry's.
5. The outcome frame is the skeleton-checked, label-free frame with outcomes added. The replay is not run a second time.
6. Entries per complete position, used when the skeleton is compared with §2: `round(24 · (hi − 4,320 − max(lo, 10,080) + 1) / 1,440)` for a window `[lo, hi)` in grid minutes. The comparison reads Tables 2a–2e from this file's own text.

**Path labels and baselines (§4.4, §4.7).**

7. The entry bar is part of the path. A hold of `H` hours is `round(H · 60)` 1 m bars. A long's target is touched at `high ≥ level` and its stop at `low ≤ level`, mirrored for a short. A bracket is `both_touch` when the first bar to touch the target is also the first bar to touch the stop.
8. `null_odds` is checked before `both_touch`, so a bracket is dropped under one name. Null odds are counted per side.
9. A2's "45 cells and both sides" is the plain mean over the 90 cell-sides. In A3, a side-blind group averages a shape's 10 hold-sides and a TRENDING group its 5 holds.
10. A1's (d) is read as the body states it: `LB(Δ1) > 0`, `LB(U) > 0`, `LB(D) > 0`. The paired excesses over the always-long, always-short and random-side versions of the same delta are `2D`, `2U` and `Δ1`.
11. A1 to A4 are computed in percentage points and compared with `F = 3.0`.

**Clusters, bootstrap, shuffle (§4.6, §4.7).**

12. The bootstrap resamples the statistic's own clusters — those carrying at least one selected row — inside each coin.
13. If any bootstrap replicate of an output is undefined, that output's bounds are undefined and its state is too little data; the count of undefined replicates is reported. An undefined shuffle draw counts against the statistic in both tails.
14. The block shuffle: the blocks are the maximal runs of equal label in the sequence, and a draw is a uniform (Fisher–Yates) permutation of the blocks. A block travels whole. Two blocks of the same label may come to abut, so run lengths are kept block by block.
15. A coin × timeframe sequence with fewer than two blocks cannot be shuffled; it stays in place and is named by position and timeframe in the result, for row sequences and for bar sequences.
16. A key reading's shuffle permutes that key's own label sequence. Rows with no label under the key are outside the sequence.
17. `A4.mono` is `perm_test`, unweighted, on `A4.S`'s rows: the level is the confidence bin, the win is `g`, the cluster is coin × UTC day.

**Key A and key B (§4.9, §4.10).**

18. Key A's series is the window's full closed bars in time order, with holes closed up, as in R0. A bar is dated when it lies at or after the first turn and before the last. An entry takes the phase of the last bar closed at or before it.
19. Key A's volatility leg is the mean true range of the 14 bars that open at or after the call (each true range uses the previous bar's close), divided by the entry price. A row without 14 such bars has no leg: it is outside every reading that uses the leg and is counted `undated_volatility_leg`, apart from `undated`.
20. Key B for bar-level statistics: a close needs its own call (its close and its volatility ratio), the call 14 bars later, and that later instant inside the window.
21. Key B at leads 7 and 28 is reported as the point values of `Δ1`, `S2` and `S4` under those leads. A slice below the cluster floor is named too little data and not reported.
22. A key reading (`*.B`, `*.A`) whose rows have fewer than 50 effective clusters is named too little data and not computed. Key readings carry no §4c bound: the identifiability table lists primaries and secondaries.

**A3 (§4.8).**

23. A cell below 50 effective clusters, or NOT_IDENTIFIABLE (a TRENDING group reads the direction mix of all TRENDING rows), is left out of the selection and enters the BH family with `p = 1`.
24. A3 works is read on `A3.S`, the selected cell's own resamples at the adjusted level, and also needs the shuffle's mean to lie outside the adjusted interval, on the side (c) expects. A3 broken is the every-cell rule on `A3.cells`.
25. `A3.B` and `A3.A` are read in the fit-selected cell by the general rule at the family level. The served rung of A3's ladder is A3's own state. With no selected cell the ladder is not read.
26. `A3.S` uses the registry's counts in both windows. The hold-out reads the fit-selected cell at a plain 95% interval.

**A5 and the bar-level tables (§4.8).**

27. `C_j` is the close of the bar that closes at boundary `j`. `σ_bar(j0)` comes from the served series' volatility ratio at `j0` under every key.
28. The shuffled sequence of a coin × timeframe × window is its eligible boundaries in time order; a block ends at a hole. A run's reference in a draw needs a whole window of the run's length at the place the run lands, with positive σ there; otherwise that draw gives the run no reference.
29. `c` of a run is the mean of its references over the draws that give it one. A draw's null ratio is `Σ ω·(that draw's reference) / Σ ω·c` over the runs with a reference in the draw. A run with no reference in any draw is left out of the ratio and counted (`unreferenced`).
30. A run whose `σ_bar(j0)` is not positive, or whose move is not finite, is excluded and counted with `censored_run`.
31. A5's shuffle reports both tails, an undefined draw counting in both, so that a hold-out can confirm a ratio below 1.
32. The run-length median is the ω-weighted lower median: the smallest length at which the cumulative weight reaches half.
33. Lag. For a turn at bar `k`, the closes after `k` are searched up to the next turn's bar, inside the window; the lag is the number of closed bars from the turning bar to the first bar at whose close the series is TRENDING the new way. A turn with no such bar is censored, and the window's last turn is censored at the window's end. The median is the plain median over the pooled uncensored turns of every coin, per timeframe (the mean of the two middle values when their number is even).
34. Flip-flops. Over consecutive labelled closes inside the window, a label change counts once when the previous label is back within 3 closes. The rate is per 1,000 labelled closes.
35. Lag and flip-flops are descriptive and carry no shuffle null.

**The decision rule, the secondary families, the ladder (§4.11, §6, PROCEDURE §4d).**

36. A statistic whose bounds would satisfy works and broken together is too little data. So is a statistic with no shuffle run or with bounds not computed.
37. "The statistic's interval excludes the mean of `T*`" is read on the side (c) expects: the shuffle mean lies below `LB`.
38. A primary, in either window, whose label-free rows have fewer than 50 effective clusters, or whose §4c bound is below the floor, is not computed: too little data with that cause in the fit window, NOT_IDENTIFIABLE in the hold-out.
39. Secondary families. A cell that is too little data by the cluster floor, by identifiability or by an undefined resample is not judged on its p-values and enters its BH family with `p = 1` on both sides. The family size stays 14 (36 for A3).
40. Map row 8's "±DI points the other way" is strict: an exact DI tie is not counted. Table 2e's disagree column counts a tie under its own definition, and the skeleton comparison keeps the table's.
41. Map row 9's percentile line. `q` is the share, by count, of fit-window non-trending rows at a timeframe (pooled over coins) that the fixed line marks. For each coin × timeframe the line marks the `round(q · n)` rows of largest volatility ratio; a tie goes to the earlier entry.
42. A map row carries the ladder diagnosis of its answer (rows 9 and 11 and `A2.all` belong to A2, the rest to A1) and nominates no dial under `NO_ROOM`.
43. The ladder is read from the top. The first key that is too little data stops it. The first broken key gives the diagnosis, unless a key below it works, which is `INCONSISTENT` at the broken key.
44. A2 is also reported per timeframe (`A2.tf.1h`, `A2.tf.4h`, `A2.tf.1d`; descriptive, bootstrap only). A descriptive slice — these, `Δ1` by timeframe × hold, the key B leads, `A4.mono` — below 50 effective clusters is named too little data and not reported. `Δ1` by timeframe × hold uses map row 12's rows and averages the shapes inside each hold.

**Sensitivity variants (§4.11).**

45. A variant reruns its primary's whole rule under the changed clusters, weights or panel. `@day` pools UTC days across coins into one stratum; `@week` uses coin × 7 consecutive UTC days counted from the grid origin; `@unit` sets every row weight to 1; `@panel13` is the reading on the kept positions alone, with the full panel's weights.
46. In the fit window A3's variants rerun the cells, the selection and the selected cell. In the hold-out A3's variants read the default fit-selected cell.
47. A hold-out variant is compared with the fit point read under the same variant (`@day`, `@week`, `@unit`); `@panel13` and A3 use the default fit points.

**The hold-out (§5, §6).**

48. The hold-out's sign test compares `sign(estimate − reference)` in the two windows, the reference being 0 for A1 to A4 and 1 for A5. A fit estimate equal to the reference, or undefined, is NOT_CONFIRMED.
49. A5 in the hold-out: its interval excludes 1 on the fit-window side. The shuffle reference is its only baseline.
50. Hold-out effective clusters, for the pre-outcome floor check, are counted on the label-free rows of each primary (for A5: all runs, including ones later left unreferenced).
51. The underpowered report (§5) is attached where the half-width is above the floor, to a computed primary that is too little data in the fit window or NOT_CONFIRMED in the hold-out. `h = (UB − LB) / 2`; the multiple is `(h / F)²`, with `F = 0.10` for A5. The fit window needs `(multiple − 1)` times its coin-days carrying entries; the hold-out cannot be extended, so a successor needs `multiple` times the hold-out's. The month is the last month of the span advanced by `ceil(needed / 450)`.

**The order of a run, the guard, the result (§1).**

52. Before any outcome in a window, every label-free check of that window is made on the label-free frame: the Table 2d row sets (effective clusters and direction mix under the design weights), each primary's floor and §4c bound, A3's cells or the fit-selected cell, A5's effective clusters, and every variant.
53. `outcome_read_at` is taken immediately before the outcome frame is built; the path labeler is the first outcome computation. In the hold-out the seal is claimed before that.
54. The hold-out refuses, before the seal is claimed, a fit result that is absent, is not a fit result, belongs to another study, or was read under another registration commit. Everything else that can be validated without an outcome is validated before the claim too. A hold-out run that fails after the claim leaves the hold-out spent: the seal records the claim.
55. The descriptive tables of a window are produced in that window's step; the hold-out's only after the seal.
56. Additions to the guard. Each refusal is logged, with one exception. (a) The registered study is read only by `src/scripts/regime-diag/run.ts` of the repository the guard reads, run from source; a compiled or copied harness is refused before the guard is asked (leg `source`). (b) The guard refuses while the test-only lever `REGIME_DIAG_MUTATE` is set (leg `mutation`). (c) A skeleton that differs from §2, and an unusable fit result, are refusals (legs `skeleton`, `fit-result`). (d) An output directory inside this repository is refused (leg `out`). (e) A study store inside this repository is refused before anything is written, its guard log included: this is the one refusal that leaves no log line. No figure can be written into the repository.
57. The run commands, from the repository root, with `S` (the study store) and `DIR` (the output directory) outside the repository:

```
npx tsx src/scripts/regime-diag/run.ts --skeleton --census F --cache C --overlay O
npx tsx src/scripts/regime-diag/run.ts --fit      --store S --census F --cache C --overlay O --out DIR
npx tsx src/scripts/regime-diag/run.ts --holdout  --store S --census F --cache C --overlay O --out DIR --fit-result DIR/regime-diag-fit.json
```

Each prints one line, `REGIME_DIAG_RUN_VERDICT=PASS`, `REGIME_DIAG_RUN_VERDICT=REFUSED — <reason>` or `REGIME_DIAG_RUN_VERDICT=INDETERMINATE — <reason>`, and exits 0, 1 or 3. A caller gates on the token. The result files (`regime-diag-fit.json`, `regime-diag-holdout.json`) are written to `DIR` and carry the `REGIME_DIAG_FIT` and `REGIME_DIAG_VERDICT` lines of §6.

**The aggregation check (§4.1).**

58. "The harness repeats the check on a fixture" is a harness test, not a step of a run: `tests/unit/regime-diag-replay.test.ts` writes venue-format 1h, 4h and 1d klines from a synthetic 1 m series, compares them with the aggregate bar for bar, and proves that one changed kline is seen. Its helper lives with the tests (`tests/fixtures/regime-diag/synth-study.ts`), outside the pinned files; no guard leg depends on it. The aggregation a run uses is the pinned `archive.ts`.

## Amendment 2026-11-16 — audit fixes (amendment 2): the key readings' shuffle sequence, map row 9's fixed arm, the hold-out seal's place, and the re-pins (pre-read; recorded per §1 and §8 / PROCEDURE §8 with its reason)

**Write-time clock (live `date -u`):** 2026-11-16T12:42:53Z.

Below, "amendment 1" is the section above (the harness pins, the statistic registry, one correction and the harness's readings); this section is amendment 2.

**Ordering.** Pre-read. No outcome statistic has been computed on real archives. Since amendment 1 landed (commit `c7b0b2e976bdeeae67989afed4c9ce90d6f1f601`), this wave has run no mode of the harness on real archives: the study store's guard log still holds exactly the two refusals amendment 1 records, and the store holds no seal and no result. The audit's evidence and every test of the changes below are on synthetic series. The body and amendment 1 are unchanged: the first 107,648 bytes of this file (sha256 `5bf1161eb61c6806311a5f0c5695c984cd126ca3e802066ebd03cbb42ac7e79b`, as landed at that commit) open it, and this section is appended after them.

**Reason.** An independent audit of the harness against this registration, made before any read (wave spec, chapter 3), returned three findings. In two the pinned harness did not do what the registration says (B1, B3): the code is brought to the registered text and re-pinned (B4), and the registered text stands. In one the registration contradicts itself (B2): the text is settled here, and no code changes. Each is fixed while no outcome exists, so none can be chosen by a result. PROCEDURE §7 does not apply: there is no result to respecify after.

### B1. The key readings' shuffle sequence (the code is brought to reading 16)

Reading 16 of amendment 1 stands as written: a key reading's shuffle permutes that key's own label sequence, and rows with no label under the key are outside the sequence.

The harness pinned in amendment 1 did not do this. It drew each key reading's shuffle over every row a coin × timeframe holds, and the rows with no label under the key formed runs of their own, so labelled runs and unlabelled rows changed places. That is a different null from the registered one. It applied to baseline (c) of every key reading: `A1.A`, `A1.B`, `A2.A`, `A2.B`, `A3.A`, `A3.B`, `A4.B`.

The harness now builds a key reading's sequence, per coin × timeframe, from the rows that carry a label under that key, in time order. A row with no label under the key never enters a draw and never moves. Readings 14 and 15 apply to that sequence: its blocks are its maximal runs of equal label, and a sequence with fewer than two blocks stays in place.

Served readings are not changed. Every row of the frame carries a served label, so a served reading's sequence is every row, as before. The harness tests hold this byte for byte for `A1.S`, `A2.S`, `A4.S`, `A3.S` in three cells, the A3 family, the two all-rows cells and the twelve map rows: their draws equal an independent re-statement of the shuffle, and their digest equals the one recorded from the engine pinned in amendment 1.

Reading 15's names are what they were in the harness pinned in amendment 1: the result names the coin × timeframe sequences of the served label, and the bar sequences, that could not be shuffled. A key's own sequence with fewer than two blocks stays in place in every draw and is not separately named in the result. This is recorded as a limit of the result's reporting (PROCEDURE §8); no statistic depends on it.

The test-only mutation lever gains one value, `keyseq`, which widens a key reading's sequence back to every row. The test of this section is red under it and green without it. The guard refuses while the lever is set (reading 56 b).

### B2. Map row 9's fixed arm, and the support row that mis-stated it (text only; no code change)

The registration says two different things about the rows the fixed volatility line marks.

- The component map (row 9) and reading 41 of amendment 1 define the arm by the line: among non-trending rows, the fixed line marks those whose volatility ratio is above `0.03`.
- The Support stress-test row for map row 9 gives, as the count "the fixed line flags", 2,237 / 23,195 / 69,775 rows at 1h / 4h / 1d. Those are the fit window's served-VOLATILE rows (Table 2d).

The two sets differ. A non-trending row with a ratio above `0.03` can be served RANGING, through the exhaustion rule (map row 7); such a row is in the first set and not in the second.

The harness pinned in amendment 1 follows the component map and reading 41, and that is what is registered:

1. **Population.** The fit-window rows whose served label is not a trending label, at any confidence.
2. **Fixed arm.** The rows of that population whose volatility ratio is above `0.03`, whatever their served label. The arm isolates the `0.03` line, the dial of map row 9. It does not isolate the served VOLATILE label.
3. **Percentile arm.** Drawn from the same population, by reading 41: `q` is the share of the population at a timeframe that the fixed arm marks, and each coin × timeframe marks its `round(q · n)` rows of largest ratio, a tie going to the earlier entry.
4. **Statistic and criteria.** Unchanged: θ is S2 on the fixed arm minus S2 on the percentile arm, read as component-map row 9 states.

**Support.** In the Support stress-test row for map row 9, the clause "of which the fixed line flags 2,237 / 23,195 / 69,775" is withdrawn as mis-stated: it counted served-VOLATILE rows, not the fixed arm. No figure replaces it. The fixed arm's count was not probed before registration and is not probed now. The rest of the row stands, including the population counts (103,001 / 86,202 / 81,354, which are Table 2d's fit rows less its TRENDING rows) and the verdict, `floor`.

Each arm's support is counted at run time, as the support rows of A3, A4 and A5 already say of theirs: the arm's effective coin × UTC-day clusters, from the rows the arm marks. The count is a function of the labels, the volatility ratio and the design weights; no outcome enters it. The harness takes it in the fit window's secondary step, before the row's statistic is read. Below 50 effective clusters on either arm the row is too little data and enters its family with `p = 1` on both sides (§4.11, reading 39). Reading 52's list of the checks made on the label-free frame is unchanged.

The harness was not run on real archives to settle this, and no harness file changes for it.

### B3. The hold-out seal has one place (the code is brought to §1 and §7)

§1 (leg vi) and §7 stand as written: the hold-out is spent by one read, and the seal refuses a second one.

The harness pinned in amendment 1 kept the seal in the study store a run names, `S/holdout.seal`, and `S` is an argument. `--init-store` in a second directory reproduces both pinned manifests from the same archives; that directory holds no seal; a hold-out run naming it would have been a second read. The audit showed this on a synthetic study. No second store was made for the registered study.

The seal now has one place, which no argument of a run and no environment variable moves:

`<home>/.cache/algovault/regime-diag/store/holdout.seal`

`<home>` is the home directory of the account that runs the harness, as the operating system's user database gives it, not the `HOME` variable. Leg (vi) of the guard reads that file, and the claim of reading 53 creates it there, exclusively, whatever `--store` names. A claim and a refused claim are still logged in the guard log of the store the run named. The seal's record is unchanged.

**The study store.** There is one study store, and the read uses it: `/Users/tank/.cache/algovault/regime-diag/store`. It holds the two manifests pinned in amendment 1 and the guard log with its two refusals, and it is the seal's place. Reading 57's commands stand, with `S` that path. Naming another `S` does not reopen the hold-out.

**Scope of the seal.** The seal is a file under one account on one machine. It refuses a second read made from that account, which is the account that holds the study store and the archive cache.

**Synthetic studies.** A study injected by a test names its own seal home, and is refused before the guard is asked when it names none (leg `seal-home`, logged). The run CLI injects no study, so the registered study cannot name another home. No test reads or writes the registered seal's place.

### B4. Re-pins

sha256 of the file bytes as committed with the fixes, in the two commits immediately before this section. By the rule of amendment 1's pin section, the last row for a name is its pin: these four rows replace the rows of the same names, and every other pin of amendment 1 stands.

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-diag/engine.ts` | `bd28d8f31cd77848890126431da31acec2d67e1c7b7343239db73154d02a0cf0` | clusters, the cluster bootstrap, the block shuffle and its sequences (B1), the paired comparators |
| `src/scripts/regime-diag/guard.ts` | `5f27242172c91fc05db5bf6ea769632b8c1d04f1afe583759fefdd8c8105b568` | the outcome guard, and the hold-out seal and its place (§1, B3) |
| `src/scripts/regime-diag/mutate.ts` | `fe9638b2b871a9b48ce64d822b9b810f763f8f28c8932b553417989660a667a5` | the test-only mutation lever, now with `keyseq` (B1); the guard refuses when it is set |
| `src/scripts/regime-diag/run.ts` | `c306af4969e36a37147bff14250c8e856ab8975040068ca94e7c8653daf74473` | the run CLI and the order of the read (§1); it passes the seal's place to the guard (B3) |

The two test files that carry the fixes are recorded here with their bytes as committed in the same two commits. They are not pins: no test file is a pin of this registration, and no guard leg depends on one.

- tests/unit/regime-diag-stats.test.ts, sha256 `6775978262802ee5421bfcc3d2f3a96b7789870169e3bd9767cb857d891635c7`: B1. Every key reading against reading 16, the served readings byte for byte, and the `keyseq` proof.
- tests/unit/regime-diag-guard.test.ts, sha256 `bc746d53ffe011b9f6fdcce61ef9e1b757f2166d5d8c6a08ed7522b07d408157`: B3. A second store that reproduces both manifests is refused; the seal's place; the `seal` proof.

## Amendment 2026-11-16 — amendment 3: where a key reading's floor count is taken, and what "not computed" means (pre-read, text only; recorded per §1 and §8 / PROCEDURE §8 with its reason)

**Write-time clock (live `date -u`):** 2026-11-16T14:21:58Z.

Below, "amendment 1" and "amendment 2" are the two sections above; this section is amendment 3. It is written by `EDGE-REGIME-DIAG-W2`, the wave that runs the read (§9), as that wave's first step.

**Ordering.** Pre-read. No outcome statistic has been computed on real archives. Since amendment 2 landed (commit `3a994a64c14a44716a9d9f2758fd0bd9d544909e`), the study store's guard log still holds exactly the two refusals amendment 1 records, and the store holds no seal and no result. Before writing this section, this wave has run no mode of the harness on real archives; the tests it has run are on synthetic series. The body and amendments 1 and 2 are unchanged: the first 117,857 bytes of this file (sha256 `16177be8fc5ae7d14c9dbf5e92d85355e3e08a66929f3e2e7cb48ed57335440d`, as landed at that commit) open it, and this section is appended after them.

**Reason.** The re-check of amendment 2's fixes, made before any read, left one finding, rated plausible and minor. The registered text can be read two ways on where a key reading's floor is counted, and it calls a key reading below the floor "not computed" while the pinned harness forms that reading's point in memory before dropping it. No number can move under either reading of the text. Only an amendment made before the read can align the text with the pinned code, so the text is settled here, while no outcome exists and none can choose between the readings. PROCEDURE §7 does not apply: there is no result to respecify after.

**Scope.** Text only, and two statements. No harness file changes and nothing is re-pinned: every pin of amendments 1 and 2 stands, and this section adds no pin, no registry row and no table.

### C1. Key readings: where the floor count is taken

B2 states an order for an arm's support: it is counted at run time, in the fit window's secondary step, before the row's statistic is read. That statement extends to key readings (`*.A`, `*.B`). In the fit window, a key reading's effective clusters are counted after the outcome frame is built and before that reading's statistic is read (`src/scripts/regime-diag/run.ts`, lines 264, 271 and 551 of the pinned file).

The count is outcome-free. It is the Kish-effective count of the per-cluster weight totals `Σ ω` of the rows the reading's statistic takes. Whether a row is taken is a function of the labels and the key, and its weight is its design weight; for A3 this is said of the cell the reading is taken on. Per-cluster weights do not depend on outcomes.

This settles §5 against reading 52. §5 applies the floor to "every key reading", and its last bullet says "Floors are checked before outcomes". Reading 52 lists the checks made on the label-free frame before any outcome in a window, and that list holds no key reading. For a key reading the two are read together as above: its floor is checked before its statistic is read, on a count that no outcome enters, and it is not one of the checks made on the label-free frame. Reading 52's list is unchanged.

### C2. "Not computed"

Reading 22 says a key reading below the floor "is named too little data and not computed". "Not computed" means that no reading is formed into any output. To count the clusters of a key reading or of an arm, `accumulate` (`src/scripts/regime-diag/engine.ts`, lines 82 and 83 of the pinned file) also forms that statistic's point in memory. Below the floor that point is discarded unwritten: the result holds `reading: null` for the key reading, and a null point and null bounds for the map row.
