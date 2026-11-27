# EDGE-REGIME-15M-BACKTEST-W1 — pre-registration: does the served regime rule read 15m as well as 1h, on T3's fit rows?

Written 2026-11-27 (UTC), before any outcome read. Internal research: no public surface, no serving or scoring change, nothing shipped, no accuracy or edge claim, no tuning after data. This file carries methodology only, and no figure measured on any data: every count, share and outcome of this study, the panel's coin names and every figure derived from the census weights live in the private vault and never in this repository.

Procedure: `audits/PREREGISTRATION-PROCEDURE.md` §1–§9, with §4c, §4d and §4e. Wave spec: `Prompt/EDGE-REGIME-15M-BACKTEST-W1.md` (planning vault). Its test, items 1–6, is reproduced in §6 word for word but for one figure (§8, reading 1); where this file reads or tightens an item, §8 says so. The harness is the sibling `src/scripts/regime-15m/`, built on T3's harness (`src/scripts/regime-diag/**`, `scripts/regime-diag/**`), which it imports and never edits. This file lands on `origin/main` before the read, which runs once.

SERVED_RULE_STUDY: src/lib/market-regime-core.ts · MARKET_REGIME_RULE_VERSION = 2

FIT_VENUE: BINANCE · from 2024-01-01 · check: BYBIT, OKX, BITGET

## 0. What is tested, in one paragraph

The served regime label (`computeMarketRegimeCore`, rule version 2, unchanged) is replayed at 15m on a 100-bar window beside the three timeframes T3 read (1h, 4h and 1d on the served windows), on exactly T3's fit rows: the Binance USDⓈ-M 1 m archives of T3's census panel, 2024-01-01 → 2025-12-31, at T3's seeded entry instants. Every timeframe gets T3's measures, read on the same entries: direction agreement with key A (A4), the TRENDING edge (Δ1, with-side minus against-side target-first rate over T3's 45 bracket cells), flip-flops per 1,000 bars, the median lag to a real turn, and the median TRENDING run, each beside the always-up, always-down and coin-flip baselines. Bar A asks whether 15m keeps at least half of 1h's edge on A4 and on Δ1 (paired one-sided lower bounds over coin × UTC-day clusters) and flips no more often than the most of 1h, 4h and 1d. Before any outcome, the read reproduces T3's label-only fit figures; after the outcomes, T3's path-label figures (parity). The frozen settings then run on Bybit, OKX and Bitget beside a Binance twin at the same bar resolution: a check table that never enters the verdict. One line results: `REGIME_15M_BACKTEST=PASS`, `REGIME_15M_BACKTEST=FAIL` (or `FAIL (underpowered)`, §4b) or `REGIME_15M_BACKTEST=INDETERMINATE (<cause>)`.

## 1. Ordering (PROCEDURE §1)

- This file lands on `origin/main` before any outcome is computed on real archives. At the time of writing no path label and no Δ1 has been computed on real data at any timeframe, and no agreement, flip-flop, lag or run figure at 15m. R0 recomputed, at 1h, 4h and 1d only, the label-only figures T3's fit result already prints, and found them equal (§2, D6): those figures are T3's, seen before (D2), and are not test inputs. At 15m R0 computed cardinalities only.
- The read (`npx tsx src/scripts/regime-15m/r15-run.ts --census F --cache C --overlay O --archives-manifest M --t3-fit F --out DIR`) refuses, logs the refusal, and reads no outcome unless every leg below holds, in this order:
  1. no test-only lever is set (`REGIME_15M_MUTATE`, `REGIME_DIAG_MUTATE`), and the output directory lies outside the repository and outside `~/.cache/algovault`, by identity and not only by spelling, and holds no output of another read;
  2. the checkout's HEAD is an ancestor of `origin/main` and no tracked file is changed; this file is the one file of its name pattern on `origin/main`, and the checkout's copy is identical;
  3. the clock reads after this file's landing commit;
  4. the four inputs hash to the shas this file and the sibling spec register: the census, T3's archive-store manifest, T3's fit result, and the check manifest (§10);
  5. every file pinned in §10 hashes to its pin, and the sibling directory holds exactly the pinned files;
  6. T3's harness is unchanged against `origin/main`;
  7. the one-read seal does not exist (§8 allows one authorized rerun);
  8. T3's fit result is the fit read of T3's registration (commit `22f01dc912beade374ab4bd7c0f6706e07df332e`) at T3's seed, cluster floor and resample counts;
  9. every archive file of the window's months is in the manifest, resolves to the store the manifest names and carries its sha256, and no month outside 2024-01 … 2025-12 is opened;
  10. the check bars are the manifest's, fetched for this census and window at the registered resolutions, each venue inside its 2 h fetching budget (item 6; the manifest's fetch time per venue, against `CHECK_BUDGET_MS`), each file its recorded bytes;
  11. the label-only fit frame reproduces T3's registered skeleton tables, fit-window rows (T3 Tables 2a–2e);
  12. T3's label-only fit figures are reproduced (§4.6, first leg);
  13. the memory plan is within the budget (§5);
  14. every output is shown writable in place before the seal (a rehearsal writes and replaces each name the read will write).
- Then, in this order: the floor record of §5 is written to disk and its sha256 enters the seal; the seal is claimed atomically; only then are outcomes computed. After the seal the read is spent, and every fault is written down: a run that throws reads `INDETERMINATE (throw)`.
- The result records the registration commit, its commit time, the `origin/main` it was read against, the source commit, the four input shas, the floor record's sha256, the months opened, the memory plan, and the start and finish clocks. A `.sha256` file beside the result names the registration commit. The run token is `REGIME_15M_RUN_VERDICT=PASS`, `=REFUSED — <reason>` or `=INDETERMINATE — <reason>` (exit 0, 1, 3); callers gate on the token.
- After landing, this file's body is never edited. A change before the read is an appended, dated amendment (PROCEDURE §8).

## 2. Prior-examination disclosure (PROCEDURE §2)

Every figure the author saw before this file landed. Classes: `cardinality` · `coverage ratio` · `inherited` · `seen — not a test input`. Times are UTC on 2026-11-27. The R0 scripts are scratch files outside the repository; their outputs are in the vault evidence (`audits/EDGE-REGIME-15M-BACKTEST-W1-evidence.md`).

| # | what was seen | when | class | use |
|---|---|---|---|---|
| D1 | T3's registration and its three amendments (this repository): methodology and label-free cardinalities of these fit rows, Tables 2a–2e included | before R0 | inherited | the constants inherited by name (§4); the skeleton the fit frame must reproduce |
| D2 | T3's fit result, vault `audits/regime-diag-read-2026-11-16/fit/regime-diag-fit.json`, sha256 `46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312`, read in full: T3's 1h, 4h and 1d figures on these rows, among them A4 pooled over the three timeframes, Δ1 by timeframe × hold, the label-timeframe map row, flip-flops, lag and runs | before R0 | inherited | the parity reference (§4.6). It holds no 15m figure |
| D3 | T3's findings, vault `audits/regime-diagnostic-findings-2026-11-16.md` | before R0 | inherited | context; 15m was never read |
| D4 | the census, vault `audits/regime-census-2026-11-16.json`, sha256 `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a` | before R0 | inherited | panel and weights, read at run time |
| D5 | T3's archive store, located from T3's evidence, and its manifest, sha256 `b177bd0d4cba9ff46f4a8bc8e2f44b57c0f996457e8a2f3f0b21308b33e6ae1a` | R0 | inherited | the 1 m archives, checked file by file at the read; nothing is re-fetched |
| D6 | R0, label-only, on the registered inputs: the three input shas; the archive and skeleton checks; T3's label-only figures recomputed at 1h, 4h and 1d and compared with D2 (every field equal at the printed precision); entries, comparison entries, per-timeframe row counts, Kish-effective clusters, labelled coin-days and side mixes at all four timeframes (the floor record of §5); 15m row drops by reason; the months opened; the process's resident memory | 07:34–07:37 | cardinality; the recomputed T3 figures are D2's, seen — not a test input | the floor record and the side mixes are recomputed by the read before any outcome. R0 computed no path label and no Δ1, and no 15m agreement, flip-flop, lag or run |
| D7 | check-venue probes: each panel coin's listing on Bybit, OKX and Bitget, its first day in the window, history depth at 1, 3, 5 and 15 m at both ends of the window, and each venue's request rate and throttle answers | 06:32–06:44 | coverage ratio | the resolution of each venue (§4.7) |
| D8 | the check-venue fetch: every listed panel coin's bars at the chosen resolution over the window, and its manifest, pinned in §10 (per coin: listed or not, bars in the window or none, first and last bar, row count, file sha256; per venue: requests and throttle answers) | 06:50–08:08 | coverage ratio | the check rows' inputs. No label or statistic was computed on venue bars |

Synthetic runs (the suites, and the memory sizing of §5) read no real data and are not listed.

## 3. Corpus — T3's fit corpus, closed (PROCEDURE §3)

- **Archives.** Binance USDⓈ-M 1 m archives of the census panel's coins (`<COIN>USDT`), months 2024-01 … 2025-12, exactly the files T3's archive-store manifest lists for those months, read from T3's store (`~/.cache/algovault/odds-calibration-study` and its overlay `~/.cache/algovault/regime-diag/archives`, T3 §2 D7). Each file's bytes are checked against the manifest before they are parsed.
- **The clock.** The grid is T3's, cut at the end of the fit window: it ends at 2026-01-01T00:00Z, no bar opening at or after it is read, and no 2026 month is opened. The read records every month it opens and refuses any other. T3's hold-out is spent; rows after T3's `T_END` belong to T9 and T5. Every fit-window quantity of T3's harness is bounded by the window (entries need their 72 h path inside it, series and key A are built inside it, key B needs its lead inside it), so the cut changes none of them; the skeleton check and the parity legs verify it.
- **Entries.** T3's: T3's `buildFrames`, unchanged, draws them with T3's seed label at 24 per eligible coin-day on T3's eligibility rule (10,080 unbroken minutes of history and an unbroken 72 h path inside the window).
- **Drops** are reported by name, with two denominators, as T3's: T3's reasons, and the 15m ones (`no_15m_history`, `core_refusal_15m`, `key_b_beyond_window_15m`, `undated_15m`).

## 4. Methodology

### 4.1 The rule and the four timeframes

- **Timeframes.** 15m with `REGIME_15M_WINDOW_BARS` = 100 bars (I = 15 minutes), and T3's three at `CANDLE_COUNTS`: 1h 168, 4h 42, 1d 100 bars. The 15m window is exported once, from `src/scripts/regime-15m/r15-spec.ts`; REGIME-15M-SERVE-W1 serves the same number. 100 bars of 15m is 25 h, inside T3's history floor.
- **The call** is T3's (T3 §4.1), at 15m: 1 m rows aggregated to UTC-aligned 15m bars; at an entry `t`, the pinned core on the bars covering `[t − 100·15 min, t)` plus the bar in progress, on the closed basis. A 15m row needs every 1 m row of that span and an answer from the core, else it is dropped by name. The 15m per-closed-bar series is the same call at every 15m close with an unbroken window.
- **Keys at 15m.** Key A is T3's construction on 15m bars (turning points within 7 bars on each side, the smallest swing removed while below 6σ of that coin × 15m × window; T3 §4.9); an entry takes the phase of its last closed 15m bar. Key B is the pinned core on a window that ends 14 bars after the call (T3 §4.10).
- **Called, never re-implemented.** The 15m rows use T3's `aggregate`, `buildSeries`, `served`, `buildKeyA`, `phaseAt` and `keyBAt` with the 15m timeframe; the 1h, 4h and 1d rows are T3's `buildFrames` output, unchanged. A statistic is read through T3's engine and T3's statistic functions on a view: a frame of the same entries, clusters and outcome table whose row slots hold the timeframes compared, so T3's code reads a 15m row exactly as it reads its own.

### 4.2 The rows

- **Comparison rows** are the entries that carry a served label at all four timeframes. Every measure of every timeframe, both paired comparisons and both δs are read on them, so "the same rows" holds by construction.
- **Weights** are T3's (T3 §4.5): coin weight × timeframe weight from the census field `t3_weights`. 15m has no census weight and takes the factor 1. Each statistic is a ratio of weighted sums over one timeframe's rows, in which a constant timeframe factor cancels; a paired comparison reads each arm's own ratio.

### 4.3 The measures (item 3), per timeframe on the comparison rows

- **A4.** T3's A4 statistic on one timeframe's rows (T3 pooled the three): TRENDING rows at any confidence whose last closed bar has a dated key-A phase; `A` is the weighted share whose label direction is the phase. Baselines on the same rows: always-up agrees `p_K` of the time (the weighted up-phase share), always-down `1 − p_K`, a coin flip 50 %. Reported: `A` and its excess over each baseline, each with its interval.
- **Δ1.** T3's A1 statistic on one timeframe's rows: TRENDING at confidence ≥ 60 (`REGIME_AGAINST_MIN_CONFIDENCE`); `Δ1` is the cell-averaged with-side minus against-side target-first rate over the 45 cells (T3 §4.8), pooled over holds as T3 pools it, and by hold. With `Δ1 = U + D` (T3 §4.8 (d)), always-up scores `U − D`, always-down `D − U` and a coin flip 0, so the excesses are `2D`, `2U` and `Δ1`.
- **Flip-flops per 1,000 bars.** T3's rule, a label change reversed within `N_FF` bars, on each coin's per-closed-bar series inside the window, pooled: flip-flops ÷ bars × 1,000. Baselines: a constant label never flips (always-up, always-down: 0); a fair coin drawn at every labelled close has the exact expectation ½·(1 − ½^k) per change-eligible close, `k` the consecutive labelled closes after it up to `N_FF`.
- **Lag.** T3's table: for each key-A turning point, the closed bars from the turn to the first bar of the series whose label points the new way; the median in bars and in hours (bars × the timeframe's minutes ÷ 60), with turns and censored turns counted.
- **Runs.** T3's A5 runs of each timeframe's served series: TRENDING runs, their length in bars (weighted mean, and the median at half the weight) and the signed move ÷ σ; weights coin × timeframe (1 at 15m).

### 4.4 Clusters, resampling, seeds (T3 §4.6)

- **Cluster:** coin × UTC day of the entry instant. **Bootstrap:** clusters resampled with replacement inside each coin, `B_BOOT` = 10,000 resamples, through T3's engine; bounds are percentile bounds, one-sided at `ALPHA` = 0.025 (`ci_lower`, `ci_upper` of `src/scripts/cluster-perm-stats.py`). **Effective clusters:** Kish, over the clusters' weight totals on a statistic's rows.
- **Paired.** Both arms of a comparison are read from one resample of the same clusters, so `θ = arm(15m) − arm(1h)` is a paired quantity with its own interval.
- **Seeds.** Every bootstrap stream is `arm_seed('20261116', 'r15|<run>|<statistic>|bootstrap')`, with run one of `main`, `check:<venue>`, `twin:<venue>`, `alone:<venue>`. The `r15|` prefix keeps every stream of this study apart from T3's `<window>|<statistic>|<purpose>`. The entry draws are T3's; the parity legs read T3's statistics under T3's own seeds.

### 4.5 Bar A (item 4)

- **A4:** `θ_A4 = A4₁₅ₘ − A4₁ₕ` (pp), paired. Holds when `LB(θ_A4) > −δ_A4`, `δ_A4 = 0.5 × (A4₁ₕ − max(50 %, always-up₁ₕ))`: half of the smaller of 1h's two excesses, over the coin flip and over always-up.
- **Δ1:** `θ_Δ1 = Δ1₁₅ₘ − Δ1₁ₕ` (pp), paired. Holds when `LB(θ_Δ1) > −δ_Δ1`, `δ_Δ1 = 0.5 × Δ1₁ₕ`.
- **Flip-flops:** holds when 15m's rate is at most the highest of 1h's, 4h's and 1d's.
- The δs are read from 1h's point estimates on the comparison rows. The bounds are strict as written: a lower bound equal to −δ fails; a 15m rate equal to the highest of the three holds.
- Beside A4 and Δ1 the readout prints an `underpowered` note when the interval's lower half is at least δ wide (`point − LB ≥ δ`), so that an arm equal to 1h would fail too. The note never changes a state. A FAIL whose every failing criterion carries it reads `REGIME_15M_BACKTEST=FAIL (underpowered)`, in the result line and in the findings: 15m was not shown non-inferior, and the read could not tell it from 1h at δ (§4b; §8, reading 10). A FAIL holding any resolved failure — flip-flops, which carry no interval, or A4 or Δ1 resolved at δ — reads plain `FAIL`.

### 4.6 Parity (item 5)

- The read recomputes, from its own frame, the 1h, 4h and 1d figures of T3's fit result with T3's statistics, rows, weights and seeds, and compares each with D2 field by field, at D2's printed precision.
- **First leg, before the seal:** the label-only figures — entry counts, A4 pooled over the three timeframes, lag, flip-flops and runs. A miss refuses the read before any outcome is computed: nothing is spent, and the lead rules a fix (§8, tightening 1).
- **Second leg, after the seal:** the path-label figures — the label-timeframe contrast (T3's map row 12) and Δ1 by timeframe × hold. A miss fixes the token at `INDETERMINATE (parity)` (item 5).
- The check rows have no parity reference.

### 4.7 The check table (item 6)

- **Bars.** Bybit, OKX and Bitget, from each venue's public historical kline endpoint, fetched before this file landed by `src/scripts/regime-15m/r15-fetch.ts` into `~/.cache/algovault/regime-15m/check/`, with a manifest pinned in §10. The read loads the stored bars; it opens no socket, and the fetcher is outside its import closure.
- **Resolution** (R0, D7): for each venue the finest bar resolution that covers the window in at most 2 h of fetching, from its history depth and its measured request rate: Bybit 1 m, OKX 3 m, Bitget 3 m.
- **On the 1 m grid.** A venue bar of `R` minutes fills its `R` minutes: the first `R − 1` hold its open, the last its open, high, low, close and volume. Aggregation then gives the `R`-minute bar back exactly, and no minute shows a price before its bar has reached it.
- **The Binance twin.** Binance's 1 m archives aggregated to the venue's `R`, kept only where whole, and laid on the grid the same way, on the same coins, so every comparison is like-for-like. At `R` = 1 with the same coin set the twin is the main read itself.
- **Rows.** For each venue × panel coin: `value` (the venue and Binance both carry it), `no Binance test` (the venue does and Binance does not: the same settings run alone and are reported apart), `NO_HISTORY` (listed, no bar in the window), `not listed`. Each venue run and each twin reports every measure, both comparisons and Bar A's three criteria with its own state and causes (no parity leg). The table never enters the verdict; a gap between a venue and its twin is a finding for Mr.1.
- **Venue facts.** No statistic of this study reads a fee: T3's fee enters only its baseline (a), which neither A4 nor Δ1 uses. No per-venue setting exists.

## Answer-key ceiling (PROCEDURE §4d)

Read at 15m on the comparison rows, after the outcomes, and before the component map. Each key's statistic is Δ1 (§4.3) with the key in place of the served label for row selection and direction; outcomes are unchanged.

| key | role | construction | reading if it fails |
|---|---|---|---|
| A | CEILING | key A dated in hindsight on 15m bars (§4.1): every comparison row with a dated 15m phase, the with-side being the phase's direction; key A has no confidence, so no confidence filter (T3's A1 under key A) | NO_ROOM: with the true 15m phase in hand Δ1 does not clear 3.0 pp, so there is nothing to find at 15m and no 15m window can help |
| B | NO_LAG | the pinned core at 15m on a window that ends 14 bars after the call: rows that key B labels TRENDING at confidence ≥ 60, the with-side being key B's direction (T3's A1 under key B) | INPUTS: the ceiling wins and the rule's own 15m inputs cannot reach it even without lag |
| S | SERVED | the live 15m label a caller would receive: TRENDING at confidence ≥ 60, the with-side being its direction (Bar A's 15m Δ1 arm) | LAG: the 15m inputs carry the edge when they may look ahead, and the live 15m label does not deliver it |

States: a key **works** when its Δ1 point is at least 3.0 pp with `LB > 0`, is **broken** when `UB < 3.0` pp, and is **too little data** otherwise or below 50 effective clusters. Diagnoses, read top down: `NO_ROOM` (CEILING broken), `INPUTS` (CEILING works, NO_LAG broken), `LAG` (NO_LAG works, SERVED broken); anything else reads `none`. The keys and the diagnosis are descriptive: Bar A alone decides the token (item 5). Under `NO_ROOM` the findings still report every component-map row, marked as read under `NO_ROOM`.

## Component map (PROCEDURE §4d)

One row per Bar A criterion, each read on its own floor and its own δ, written before any outcome. Every row is reported as exactly one of works, broken, too little data.

| slice | dial | works | broken | too little data |
|---|---|---|---|---|
| 15m TRENDING edge: TRENDING 15m rows at confidence ≥ 60, paired with 1h's on the comparison rows | `REGIME_AGAINST_MIN_CONFIDENCE` (60), at the 15m window | Bar A's Δ1 criterion holds: `LB(Δ1₁₅ₘ − Δ1₁ₕ) > −δ_Δ1` | the criterion fails: 15m loses more than half of 1h's TRENDING edge | fewer than 50 Kish-effective coin × UTC-day clusters at 15m or at 1h, `δ_Δ1 ≤ 0`, or a non-finite input |
| 15m direction: TRENDING 15m rows with a dated key-A phase, paired with 1h's on the comparison rows | `REGIME_15M_WINDOW_BARS` (100) | Bar A's A4 criterion holds: `LB(A4₁₅ₘ − A4₁ₕ) > −δ_A4` | the criterion fails: 15m loses more than half of 1h's agreement over its stronger fixed baseline | fewer than 50 Kish-effective coin × UTC-day clusters at 15m or at 1h, `δ_A4 ≤ 0`, or a non-finite input |
| 15m stability: the 15m per-closed-bar series of every coin inside the window | `REGIME_15M_WINDOW_BARS` (100) | 15m's flip-flops per 1,000 bars are at most the highest of 1h's, 4h's and 1d's | 15m flips more often than all three | fewer than 50 labelled coin-days at any of the four timeframes, or a non-finite input |

## 5. Floors, N and power (PROCEDURE §5)

- **Independence unit and floor** (§8, reading 11 and tightening 4). The coin × UTC-day cluster, and T3's floor: 50 Kish-effective clusters (`FLOOR_CLUSTERS`) under the design weights, on the rows each criterion reads — A4's and Δ1's row sets at each of the four timeframes on the comparison rows. Flip-flops: 50 labelled coin-days at each timeframe (a coin-day with at least one labelled close inside the window). Every floor is in days. A timeframe under any of its floors makes the token `INDETERMINATE (floor)` and its map row too little data. There is no row floor.
- **Before the outcomes.** The floor record — every count above, with the side mixes of §Identifiability — is computed from the label-only frame, written to disk before the seal, and its sha256 enters the seal. Bar A reads that record, never a recomputation after the outcomes.
- **N.** T3's 24 entries per eligible coin-day (T3 §4.2); the comparison rows are those labelled at all four timeframes, so the 1d window binds.
- **Power.** Bar A is a retention test whose margins are read at the read, so its power is the width of each paired interval against its δ, from the paired cluster bootstrap (`B_BOOT` resamples, standard error scaling with the effective cluster count). The `underpowered` note of §4.5 reports it per criterion. No size can be added: the window is T3's fit window, closed, and later months belong to T9 and T5.
- **Memory** (a run that happens once is sized before it lands). The read refuses before the seal when its plan exceeds `MEMORY_BUDGET` (9 GiB, half the host): the arrays of its widest run, counted from their layouts (frame, 15m rows, outcome table, two views, the widest statistic's accumulators), times `MEMORY_GROWTH` (2.5), plus `MEMORY_OVERHEAD` (1 GiB). The growth factor was measured on synthetic panels at four scales, the main run end to end, with the maximum resident set size of `/usr/bin/time -l` around `node --import tsx`; a suite test holds the plan above every measured peak and above their fitted line well past the read's scale.

## Support stress-test (PROCEDURE §4)

Every registered check, the point at which it is evaluated, and what R0 found there. R0's counts are in the vault evidence (D6, D7, D8); this file states occupancy only.

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| A4 per timeframe | TRENDING rows with a dated key-A phase on the comparison rows, at 15m, 1h, 4h and 1d | R0 (D6): Kish-effective clusters above the floor at every timeframe; both phase directions occupied at every timeframe | inside |
| Δ1 per timeframe | TRENDING rows at confidence ≥ 60 on the comparison rows, 45 cells, both sides, at each timeframe | R0 (D6): above the floor at every timeframe; both label directions occupied at every timeframe | inside |
| flip-flops per timeframe | each coin's per-closed-bar series inside the window | R0 (D6): labelled coin-days above the floor at every timeframe | inside |
| A4 paired comparison | comparison rows that are A4 rows at 15m or at 1h, one resample | both arms above the floor (the A4 rows above) | inside |
| Δ1 paired comparison | comparison rows that are Δ1 rows at 15m or at 1h, one resample | both arms above the floor (the Δ1 rows above) | inside |
| δ_A4 | 1h's excesses over the coin flip and over always-up, point estimates | 1h's phase mix occupied on both sides (D6); the excesses are read only at the read | inside — `δ_A4 ≤ 0` is INDETERMINATE (not_identifiable) |
| δ_Δ1 | 1h's Δ1, point estimate | 1h's Δ1 rows above the floor (D6); the value is read only at the read | inside — `δ_Δ1 ≤ 0` is INDETERMINATE (not_identifiable) |
| flip-flop reference | the highest of the 1h, 4h and 1d rates | every T3 timeframe's series occupied (D6) | inside |
| lag | each key-A turning point at each timeframe | turns not counted in R0 | floor — descriptive; reported with its count |
| runs | uncensored TRENDING runs of each timeframe's series | runs not counted in R0 | floor — descriptive; reported with its count |
| key A (CEILING) at 15m | comparison rows with a dated 15m phase | dated 15m rows occupied; undated rows counted by name (D6) | inside |
| key B (NO_LAG) at 15m | comparison rows whose 14-bar lead stays inside the window, labelled TRENDING at confidence ≥ 60 by key B | the lead removes the window's last 3.5 h; key B's label occupancy was not probed | floor |
| SERVED at 15m | the 15m Δ1 rows | as the Δ1 row | inside |
| component map rows | as Bar A's three criteria | as the rows above | inside |
| comparison rows | entries labelled at all four timeframes | counted in R0 (D6); the 1d window binds, as in T3's map row 12 | inside |
| parity, first leg | T3's label-only fit figures | reproduced in R0, every field (D6) | inside |
| parity, second leg | T3's label-timeframe contrast and Δ1 by timeframe × hold | path labels; not computed before the read | floor — a miss is INDETERMINATE (parity) |
| check rows | each venue × panel coin, at the venue's resolution | per venue: listed coins and the first bar in the window (D7, D8) | inside — each row reads `value`, `no Binance test`, `NO_HISTORY` or `not listed`; a check run under a floor reads its own `INDETERMINATE (floor)` |
| the window's months | 2024-01 … 2025-12 | the archive manifest's files for those months (D5) | inside |

## 4b. Discriminating power (PROCEDURE §4b)

Bar A reads 15m against 1h on the same rows, with margins that are half of 1h's own edge there. No operating characteristic can be fixed before δ exists, because δ is a function of 1h's estimate on these rows and only the read computes it: the chance that Bar A passes when 15m equals 1h, or fails when 15m keeps less than half of 1h's edge, depends on δ and on the width of the paired interval, and neither is known before the outcomes. The registered rule for that case is evaluated at read time instead, and it only annotates. A criterion's interval that is too wide to resolve its δ (its lower half at least δ wide, `point − LB ≥ δ`) carries the `underpowered` note, and a FAIL whose every failing criterion carries it reads `REGIME_15M_BACKTEST=FAIL (underpowered)`, in the result line and in the findings, so the reader sees "could not tell" rather than "15m is worse". A FAIL holding any resolved failure — flip-flops, or A4 or Δ1 resolved at δ — is plain `FAIL`: the read did show 15m worse there. That is PROCEDURE §6's null rule, reported beside the state of item 5; it is never a fourth state. The read records each criterion's interval, δ and note.

## Identifiability (PROCEDURE §4c)

Bar A declares no floor on a rate, an edge or an excess. Its two margins are retention margins: each is half of 1h's own edge, read on the comparison rows at the read, so neither is a number declared before the read. Their identifiability is item 5's check, applied at the read before any criterion is judged: `δ_A4 ≤ 0` or `δ_Δ1 ≤ 0` means 1h has no edge to retain, and the token reads `INDETERMINATE (not_identifiable)`, never FAIL. `δ_A4` is half of 1h's excess over its stronger fixed baseline, and an excess over a fixed-side caller is bounded by the side mix (§4c), so `δ_A4` shrinks with a lopsided 1h phase mix; R0 found both phase directions occupied at every timeframe (D6), and the floor record carries each timeframe's minority shares beside the floors. The key readings' 3.0 pp line (T3 §6; descriptive, never in the token) sits on Δ1 itself, a with-side minus against-side difference on the same entries that can reach either sign's full range at any side mix, so no side-mix bound applies to it. The fixed baselines are reported beside every rate, with no floor.

NO_RATE_FLOOR_DECLARED - Bar A's margins are half of 1h's own edge, read at the read and never declared as numbers; a margin at or below zero is INDETERMINATE (not_identifiable) by item 5, and the key readings' descriptive 3.0 pp line on Δ1 has no side-mix bound

## 6. Decision rule (PROCEDURE §6) — the test, verbatim

1. **Rule.** The served rule, unchanged. Windows: 15m = **100 bars** (new; exported once as `REGIME_15M_WINDOW_BARS` from the sibling spec — REGIME-15M-SERVE-W1 serves the same number); 1h · 4h · 1d = `CANDLE_COUNTS` (168 · 42 · 100), unchanged.
2. **Rows.** Binance USDⓈ-M, T3's `FIT` window 2024-01-01T00:00Z → 2025-12-31T23:59Z, T3's 15-coin census-weighted panel, T3's entry grid, `SHAPES` × `HOLDS_H` (9 × 5), `FEE_PCT`, T3's seed and bootstrap constants (`SEED`, `B_BOOT`, `ALPHA`). 15m is scored on exactly T3's fit rows. No 2026 bar is opened: T3's hold-out is spent, and post-T_END rows belong to T9 and T5 (G3).
3. **Measures** — T3's definitions, per timeframe: A4 direction agreement (new cut: per timeframe; T3 pooled it), Δ1 TRENDING edge (with-side minus against-side, pp; per hold and pooled as T3 pools it), flip-flops per 1,000 bars, median lag to a real turn (bars and hours), median TRENDING run. Every rate sits beside the naive baselines on the same rows: always-up, always-down, coin flip.
4. **Bar A (Mr.1, 2026-11-27).** Paired on the same rows; the bootstrap resamples days (the independence unit); one-sided α = `ALPHA`.
   - A4: LB(A4₁₅ₘ − A4₁ₕ) > −δ_A4, with δ_A4 = 0.5 × (A4₁ₕ − max(50 %, always-up₁ₕ)).
   - Δ1: LB(Δ1₁₅ₘ − Δ1₁ₕ) > −δ_Δ1, with δ_Δ1 = 0.5 × Δ1₁ₕ.
   - Flip-flops: 15m's rate ≤ the highest of 1h, 4h and 1d on the same rows (T3's figure: in the private vault; §8, reading 1).
   The 50 % margin is the standard non-inferiority retention rule: 15m keeps at least half of 1h's edge over its baseline.
5. **Three states.** `PASS` = all three hold. `FAIL` = any fails, with parity green. `INDETERMINATE` = parity red (a recomputed 1h, 4h or 1d figure differs from T3's fit result at its printed precision), δ_A4 ≤ 0 or δ_Δ1 ≤ 0 (`NOT_IDENTIFIABLE`, §4c: 1h has no edge to retain), a timeframe under T3's row floor, or a throw. INDETERMINATE is never FAIL: the lead rules a fix and one rerun of the same registered design (a §8 deviation), never a new margin.
6. **Check table** — `FIT_VENUE: BINANCE · from 2024-01-01 · check: BYBIT, OKX, BITGET` (§4e). The frozen settings run on each check venue for the panel coins it lists (else `not listed`), same window, from its public historical kline endpoint. R0 probes each venue's history depth and rate limit and picks the finest bar resolution that covers the window in ≤ 2 h of fetching per venue; the Binance row is recomputed at that same resolution beside it, so every comparison is like-for-like. A venue whose public history cannot cover the window reads `NO_HISTORY` with the probe output. The table never enters the verdict; a gap is a finding for Mr.1.

**The result line.** Exactly one of `REGIME_15M_BACKTEST=PASS`, `REGIME_15M_BACKTEST=FAIL`, `REGIME_15M_BACKTEST=FAIL (underpowered)` (a FAIL whose every failing criterion carries the `underpowered` note, §4b), `REGIME_15M_BACKTEST=INDETERMINATE (<cause>[, <cause>…])`, the causes named in this order: `parity`, `not_identifiable`, `floor`, `non_finite`, `throw`. In the procedure's words, PASS is attributable (15m reads as well as 1h by Bar A), FAIL is not-attributable with the failing criteria named (with `underpowered`, the null is reported as unresolved at δ), and INDETERMINATE is indeterminate with its causes named. The findings report each criterion's estimate, interval and margin, every measure × timeframe beside its baselines, the keys, the map and the check table.

## 7. The post-result respecification test (PROCEDURE §7)

- After the read, any proposed change to a statistic, a row set, a margin, a comparator, a weight, a cluster definition or a constant of this file (the 15m window, the retention share, the floor, the seed, the resample count) is put to one question: **would this have been proposed had the check passed?** If not, it is a correction: it is registered in a new file for rows nobody has seen, and the corrected value on these rows may be disclosed only as `seen — not a test input`. The fit window is T3's and is spent by this read.
- An INDETERMINATE is answered by the lead: a fix and one rerun of the same registered design, recorded as a §8 deviation, never a new margin (item 5).
- A defect found before the seal is fixed, and recorded as an appended amendment, before the read.

## 8. Deviations, quarantine, publication (PROCEDURE §8)

- **Deviations** are recorded with their reason: before the read as an appended amendment here, during the read in the result. None is absorbed.
- **The one rerun.** A rerun after an INDETERMINATE needs an amendment on `origin/main` carrying, at the start of a line, `RERUN_AUTHORIZED: <the deviation and the lead's ruling>` (at least 20 characters). The read then claims a second, separate seal and refuses any read after it.
- **Figures are vault-only.** The read writes to the vault (`audits/regime-15m-read-<date>/`), and the findings go to `audits/regime-15m-backtest-findings-<date>.md` there. This repository receives no figure: not under `audits/`, not in a fixture, not in a commit message. No census figure and no coin name enters it.
- **Publication.** Internal. Nothing public changes in this wave; REGIME-15M-SERVE-W1 lands only on `REGIME_15M_BACKTEST=PASS` (G4).

**Readings and tightenings of the test.** The test is fixed by the wave spec; this file may only read and tighten it.

1. **Reading 1 — one figure withheld.** Item 4's flip-flop bullet quotes T3's 4h rate in the wave spec. This repository carries no figure, so §6 replaces it with a pointer to the vault; the criterion is unchanged.
2. **Reading 2 — "the same rows" for the bar statistics.** Flip-flops, lag and runs are per-closed-bar statistics of each coin's series inside the window (T3's definitions). For them the same rows are the same coins and the same window. A4, Δ1, both paired comparisons and both δs are read on the comparison rows (§4.2).
3. **Reading 3 — A4 per timeframe.** T3's `a4` statistic on one timeframe's rows; T3 pooled the three. The pooled A4 is recomputed only for parity.
4. **Reading 4 — "the bootstrap resamples days".** Clusters are coin × UTC days, resampled inside each coin (T3 §4.6): the day is the independence unit within a coin.
5. **Reading 5 — δ.** Both δs use 1h's point estimates on the comparison rows; always-up₁ₕ is `p_K` on 1h's A4 rows.
6. **Reading 6 — the twin.** "The Binance row is recomputed at that same resolution" is the twin of §4.7: Binance's 1 m archives aggregated to the venue's resolution and laid on the grid as the venue's bars are, on the same coins. At 1 m with the same coins the twin is the main read.
7. **Reading 7 — key B at 15m.** T3's lead of 14 bars, 3.5 h at 15m.
8. **Reading 8 — the key readings.** They read Δ1 against T3's 3.0 pp line (works: point ≥ 3.0 pp and `LB > 0`; broken: `UB < 3.0` pp), without T3 §6's comparator and shuffle legs: they are the §4d ladder, descriptive, and never decide the token.
9. **Reading 9 — `src/lib/venue-fees.ts`.** T3 §10 pinned it for its baseline (a). No module the read loads imports it, and no statistic here reads a fee, so it is cited, not pinned (§10).
10. **Tightening 1 — parity in two legs.** The label-only figures are compared before the seal, and a miss refuses the read with nothing spent; the path-label figures after the seal are item 5's parity.
11. **Tightening 2 — non-finite.** A non-finite input or result of Bar A (NaN, ±∞, an undefined resample) reads `INDETERMINATE (non_finite)`, never a criterion that holds or fails.
12. **Tightening 3 — one read, in order.** The guard legs of §1, the floor record on disk before the seal, and the seal before any outcome, each enforced by the code and refused by a test when violated.
13. **Reading 10 — the underpowered FAIL** (the lead's ruling of 2026-11-27, option (a)). Item 5's states stand: a criterion whose paired interval cannot exclude −δ has not shown 15m non-inferior, so it fails. A FAIL whose every failing criterion carries the `underpowered` note (an interval too wide to resolve its δ) carries its cause, `REGIME_15M_BACKTEST=FAIL (underpowered)`, in the result line and in the findings (§4b); a FAIL holding any resolved failure — flip-flops, or A4 or Δ1 resolved at δ — is plain `FAIL` (ruling R2-F1). The annotation never changes a state.
14. **Reading 11 — "T3's row floor".** Item 5's "a timeframe under T3's row floor" means T3's floor, `FLOOR_CLUSTERS` = 50 Kish-effective coin × UTC-day clusters on the rows each criterion reads (T3 §5: there is no row floor).
15. **Tightening 4 — the flip-flop floor.** The flip-flop criterion reads bars, not entries, so it gets a floor of its own: 50 labelled coin-days at each of the four timeframes (§5). Item 5 names no such floor; a timeframe under it reads `INDETERMINATE (floor)`.

## 9. Owner, the read, and the inheritors (PROCEDURE §9)

- **Owner** of this registration, the sibling harness, the read and the findings: `EDGE-REGIME-15M-BACKTEST-W1`.
- **The read:** CH2 of this wave, once, under this file and any appended amendment.
- **Inheritors:** REGIME-15M-SERVE-W1, which lands only on `REGIME_15M_BACKTEST=PASS` (G4) and serves `REGIME_15M_WINDOW_BARS` from the sibling spec.

## 10. Pinned artifacts

sha256 of the file bytes at the commit that adds this file. The read's `pinsOf` reads every row whose first two cells are backticked; a later row for the same path, in an appended amendment, re-pins it. A pinned file that differs by one byte, a sibling file that is not pinned, or an input that is not its pin refuses the read. This file itself is identified by the commit that adds it: the read requires the checkout's copy to equal the copy on `origin/main`, and records that commit in every output.

| pin | sha256 | role |
|---|---|---|
| `src/scripts/regime-15m/r15-decide.ts` | `268235de9ef68992083ad1cbc4e2315892eb757630693f43358218900e8f38ea` | Bar A, its three states, the component map |
| `src/scripts/regime-15m/r15-fetch.ts` | `71cb8529efdaf2e12cd3a5c0337d52b8bf3b7b35afc3df1b8e28faee280cead6` | the check-venue fetcher (ran before landing; outside the read) |
| `src/scripts/regime-15m/r15-frame.ts` | `dea03b97c8c4f8a1ae393f7c61a48578bcd6639c2360c34d38056b5f417d935d` | the 15m rows, the comparison rows, the views |
| `src/scripts/regime-15m/r15-guard.ts` | `1e7c3fe2c3ca6aa055bd38fb9c4e0aa3f8aa8c4a462b74f75f2e4294d4d2ff71` | the read's guard legs, the seal, the memory plan |
| `src/scripts/regime-15m/r15-parity.ts` | `75188fa0450af87c5c66ebe6b37b2424bccb68ca6a16f04cf8f412fc714ae2a8` | the parity legs against T3's fit result |
| `src/scripts/regime-15m/r15-run.ts` | `35f432ea6bde162860d38ea3272e07d9a5f600936d020e45c83e48a9f8d4f5d0` | the read |
| `src/scripts/regime-15m/r15-spec.ts` | `1a0e2ea49ca190d16920aa1f1ade47f9e4aa3ff739cfa2291d3c35a035d43d37` | the registered constants, `REGIME_15M_WINDOW_BARS` |
| `src/scripts/regime-15m/r15-stats.ts` | `790123583b4b3b6793e2e04957f450e500457abe3bee1eb76b9b03f9dfdf3e2d` | the measures, the floors, the paired comparisons, the keys |
| `src/scripts/regime-15m/r15-venues.ts` | `ec496c0673efd1e2c895777d37dbc30a0ffb8f6620e5e3abc470b8affbb3f355` | the check bars' loader and the twin |
| `src/scripts/regime-diag/archive.ts` | `0d2891b4469dabae7b98b1c68332ae0a18ef37a471a305e14882434c4e09ca43` | T3's harness, import-only |
| `src/scripts/regime-diag/bars.ts` | `9aa62d3d082e76516b399dfd3d92c9e87c29f708185be84e124dc1dc52ff7687` | T3's harness, import-only |
| `src/scripts/regime-diag/diag-spec.ts` | `f9b83db8f7c338ad6e4c65088266d7c1e78172f15ba2ec3fa1d3dd2044de0686` | T3's harness, import-only |
| `src/scripts/regime-diag/engine.ts` | `bd28d8f31cd77848890126431da31acec2d67e1c7b7343239db73154d02a0cf0` | T3's harness, import-only |
| `src/scripts/regime-diag/frame.ts` | `bac646463ef8dba1d74b19c192e82561b1ccdf9d5a8a5a2c526ac5b6295a72f2` | T3's harness, import-only |
| `src/scripts/regime-diag/keys.ts` | `d5a77768ff2f9bfc03f545b84579ff38d9f8edfec0e17e996e7f1e828efcd9c5` | T3's harness, import-only |
| `src/scripts/regime-diag/labeler.ts` | `b14b0e93e9ce82b40a9d6d1e0a2c9d921b8fd9d4e5bdb889ea2a30d41493f742` | T3's harness, import-only |
| `src/scripts/regime-diag/mutate.ts` | `c934e569674626816a1e6ca438a3b32e28045678296f86c152da6846fa8f6eca` | T3's harness, import-only |
| `src/scripts/regime-diag/prims.ts` | `285e75bcb50f902346577730aae788ce38e8284be84133f9bd42a1dc601216cb` | T3's harness, import-only |
| `src/scripts/regime-diag/replay.ts` | `21f18c3a5c15704d67828d09d80419f2ef2415c294a7d57bff0c8e12a8ab40a5` | T3's harness, import-only |
| `src/scripts/regime-diag/rng.ts` | `0600473fab31d7e5ac65c7067a16a6250a6378a97cd99e09edfb732809dbe01e` | T3's harness, import-only |
| `src/scripts/regime-diag/stats.ts` | `0526b8e7f5ce9d0844da6fed2b8d78db51c91d4d36aee2e021963f44dd047fb1` | T3's harness, import-only |
| `scripts/regime-diag/prims.py` | `3380b3e600b59db58e3b56ef6357a6331a6bade1563bd08a6987f2a349f68f25` | T3's harness, import-only |
| `src/lib/market-regime-core.ts` | `6cbf10ed4ac5846fa590fa31051a9879c1e22b63f7d65d4ff68731207d4c4004` | the served rule and the library files T3 pinned for it |
| `src/lib/indicators.ts` | `484c44a6f870e3655fbe28bffe5c3cce49a4feac9ce1488e71a64bda2cca0157` | the served rule and the library files T3 pinned for it |
| `src/lib/candle-window.ts` | `19a59198c980e816587e9acd20035eb6441e952ef0a286cfce5249a3694ce8d0` | the served rule and the library files T3 pinned for it |
| `src/lib/candle-guard.ts` | `aae23242f8e70484d43677db1af03b507fe4fde1bfae8cfcbbaad7cc733177f0` | the served rule and the library files T3 pinned for it |
| `src/lib/serving-windows.ts` | `592caa34ce46acf2470c50970888ece2134bc98add4aa096ab716ed14384ae25` | the served rule and the library files T3 pinned for it |
| `src/lib/errors.ts` | `4f37508ef95a61fb646e2d85c71a82560984903513fb9e8ca079892407b3a234` | the served rule and the library files T3 pinned for it |
| `src/lib/pre-trade-calc.ts` | `e6e2c5d5caccda18ef85ffb75d1f609aa430d8cb91e136354a530ba44b63e1f5` | the served rule and the library files T3 pinned for it |
| `src/lib/pre-trade-odds-calibration.ts` | `d6b1d65ba862f146fb6316b48f0c52c99ca3cd5bab26f7493a9eb19dfb6971a1` | the served rule and the library files T3 pinned for it |
| `src/lib/funding-venues.ts` | `1c5e3ff154e56a98cfa67b064a8945de78d69b3f46076d5d7fbc65627ce20076` | the served rule and the library files T3 pinned for it |
| `src/scripts/cluster-perm-stats.py` | `6d82c1601a9ce1121deecaa1c88ac4685abef328ff27d35047fad37d69f60100` | the statistics primitives behind the bridge |
| `ops/monitoring/population_comparison.py` | `282587c48242601ca3d94f6d748742d7722d49e57f5b975f6da85a94e0e258fb` | the statistics primitives behind the bridge |
| `audits/regime-diagnostic-preregistration-2026-11-16.md` | `f5c54aeb1fe3bc5f788bfd1a49267d77a4317d95ef7ee3df966b3a59ce8581ee` | T3's registration: its skeleton tables |
| `census:regime-census-2026-11-16.json` | `8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a` | the census, vault |
| `store:regime-diag-archives.json` | `b177bd0d4cba9ff46f4a8bc8e2f44b57c0f996457e8a2f3f0b21308b33e6ae1a` | T3's archive-store manifest |
| `carry:regime-diag-fit.json` | `46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312` | T3's fit result, the parity reference, vault |
| `check:check-manifest.json` | `006e47b5c3a16eb6d85643767809a170f1b1b33ee39439f365718676e3a17a59` | the check bars' manifest, `~/.cache/algovault/regime-15m/check/` |

**Cited, not pinned.** The first cell is not backticked, so `pinsOf` skips these rows.

| file | identity | why it is cited |
|---|---|---|
| src/lib/venue-fees.ts | git blob 3f24ef1a722967295788430dc85f97183dc97a37 | T3 §10 pinned it for its baseline (a); no module the read loads imports it (§8, reading 9) |
| src/lib/pre-trade-rules.ts | git blob ab9b06da339c8dd448df5d23acc0f32e94733f8d | holds the served 60 trigger; the study takes the value from T3's `REGIME_AGAINST_MIN_CONFIDENCE` (T3 §8, correction 1) |
| audits/PREREGISTRATION-PROCEDURE.md | sha256 `970c7965a475b8a45678732e10a01d6375f8f40315d3d0996e281cb18a114983` | the procedure as read for this file |
| tests/unit/preregistration-support-stress-test.test.ts | sha256 `86b1aa502488ac1a10808f54558b3c96aa77392c8de1337cc799e2429b43c512` | the gate this file passes |

**Who enforces what.** The read's guard (`src/scripts/regime-15m/r15-guard.ts`) enforces every row of the pin table, the sibling directory's listing, the four inputs and the seal; the sibling spec registers the census, archive-store and fit-result shas a second time, so a registration row alone cannot move them.
