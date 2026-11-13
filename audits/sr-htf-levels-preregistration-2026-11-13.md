# EDGE-SR-HTF-LEVELS-W1 — pre-registration: do daily/weekly levels or daily volume POCs bounce more often than matched random zones on 2021–2025 Binance candles?

Written 2026-11-13 (UTC), before any outcome read. Internal META research: zero public surface, zero scoring or serving change, nothing shipped, no edge or accuracy claim, no tuning after data. This file carries methodology and label-free cardinalities only; every outcome figure on real candles goes to the private vault and never into this repository. The figures quoted from the null calibration are from seeded synthetic random walks, not from market data.

Procedure: `audits/PREREGISTRATION-PROCEDURE.md` §1–§9. Wave spec: `Prompt/EDGE-SR-HTF-LEVELS-W1.md` (planning vault). Inherited, unchanged unless this file says otherwise: `audits/sr-level-backtest-preregistration-2026-11-12.md` (the closed study: its path label, control rule, grid, presence rule, cell statistic, cluster floors and bootstrap) and its landed harness (`src/scripts/sr-backtest/**`, `scripts/sr-backtest/sr_backtest.py`), imported and never edited.

## 0. What is tested, in one paragraph

Two frozen level sources turn a coin's closed candles into support and resistance zones. **htf** applies the closed study's zone rule Z1 to the coin's daily bars and to weekly bars built from them, and keeps the union: a daily zone that overlaps a weekly zone is served once, as the weekly zone. **vpoc** takes the volume point of control of each of the last 20 complete UTC days and widens each into a zone. Each source serves the nearest three zones on each side of the price at the instants of two cells, 1h and 4h; the cell's timeframe sets the grid, the ATR unit, the entry window and the label horizon, exactly as for the closed study's line sources. There is one primary question per source, H_A for htf and H_B for vpoc: is a served zone that price goes on to enter left by a bounce more often than a zone of the same ATR distance and width laid where the source sees no zone (the closed study's matched control), by at least +3.0pp, with the lower end of a two-sided 97.5% interval on UTC-day clusters above zero, a coin-cluster point above zero and a hold-out point above zero? The corpus is the closed study's 50 Binance USDT perpetuals from 2021-01-01 to 2025-11-12, each coin from its first full day of history plus 300 days; the hold-out is 2025. Every outcome is a hit-first path label read off 15-minute candles; none is a PnL. A descriptive read of the closed study's own Z1 in its 1d cell over this window is reported beside them and decides nothing. If neither hypothesis passes, S/R level construction is closed (§6, the stop rule). The corpus, the sources, the grid, the control, the statistic and the verdict are fixed here; the outcome step refuses to run until this file is on `origin/main` and the code and candles on disk are the ones pinned in §10.

## 1. Ordering (PROCEDURE §1)

- This file lands on `origin/main` before any bounce, break or hit is computed on real candles of this window. The outcome step (`npx tsx src/scripts/sr-htf/htf-run.ts --outcomes --store <store> --out <dir outside the repository> --registration audits/sr-htf-levels-preregistration-2026-11-13.md`) calls `checkPanelGuard` first. That runs the closed study's guard, `checkOutcomeGuard` (`src/scripts/sr-backtest/guard.ts`, unchanged), once per panel coin, with the coin's store label `BINANCE-<COIN>` and this study's pinned-file list `HTF_PINNED`. It refuses, reason named and coin first, unless: the registration path is readable at `origin/main` after a fresh fetch; the commit that last touched it is an ancestor of `origin/main`; every file in `HTF_PINNED` is byte-equal to its sha256 in §10; the coin's store manifest has the sha256 pinned as `store:manifest-BINANCE-<COIN>.json`; the manifest re-derived from the coin's candle files equals the manifest file; and the manifest lists no failed series. The pins are read from the file as it stands on `origin/main`, never from the working tree. An empty panel is refused. `tests/unit/sr-htf-harness.test.ts` proves the refusal both ways on a sandbox repository and a synthetic 50-coin store.
- `registration_landed_at` is the first `date -u` at which this file's commit is seen on `origin/main` (not the committer time). `outcome_read_at` is the outcome run's start time. `sr_htf.py --analyze` refuses unless the first is strictly before the second, to the second.
- Before this file landed, only the reads in §2 were made. The label-free run (`htf-run.ts --skeleton`) executes the same engine with outcomes off: it builds zones, served sets and control placements and counts them; it resolves no entry, bounce, break or timeout. Its columns that would hold an outcome are zero.
- Everything an outcome could bias is pinned in §10 by sha256: the level rule, the zone rule, the closed engine, store reader and guard, this study's config, source registry, sources, store loader, runner and estimator, the closed estimator it imports, the two shared statistics libraries, every coin's store manifest and the calibration artifact.

## 2. Prior-examination disclosure (PROCEDURE §2)

| what was seen | when (UTC) | class |
|---|---|---|
| Each panel coin's first full UTC day of Binance perpetual history: its first 15-minute kline, read from epoch 0 with an end time, and the first UTC midnight at or after it (`fetch-store.ts --listing`) | 2026-11-13T13:26:24Z | cardinality |
| The candle store being filled, one plan and one manifest per coin: per series the range, the bar count, the sha256, the pages read; every coin accepted. PENGU's four series were read at 13:27:01Z by a single-coin trial of the same fetcher, before the two workers started; the worker's run at 14:29Z found them complete and kept them. ETC and JUP were read by a third process once worker 1 had finished, one coin at a time; worker 0's later runs found them complete and rewrote byte-identical manifests | 2026-11-13T13:27:01Z – 14:47:46Z | coverage ratio |
| The closed study's warm-up bars, which lie inside this window: daily bars from 2025-01-16, 4h bars from 2025-09-23, 1h bars from 2025-10-30 and 15m bars from 2025-11-08, each to 2025-11-11. That study built zones from them and read no outcome on them: its first instant is 2025-11-12, this window's end | 2026-11-12 | seen — not a test input |
| Label-free skeleton run on the store (`htf-run.ts --skeleton`): counts of served zones and control placements per source, cell, UTC day and coin; forced-control counts; side counts | 2026-11-13T14:49:10Z – 14:50:14Z | cardinality |
| `sr_htf.py --cardinalities` on that skeleton | 2026-11-13T14:50:15Z | cardinality |
| `sr_htf.py --power` on that skeleton: simulated outcomes drawn on the real label-free counts (§5) | 2026-11-13T14:50:15Z – 14:55:51Z | cardinality |
| Seeded synthetic random walks with seeded volume through the whole harness: known answers, the mirror property, the mutations, the null calibration (100 replications), and the share of served zones entered on those walks, used as the power instrument's entry share (§5) | 2026-11-13 | seen — not a test input |
| End-to-end runs of the outcome step and the analysis on a synthetic 50-coin store (the guard, the refusals, the report shape) | 2026-11-13 | seen — not a test input |
| EDGE-SR-LEVEL-BACKTEST-W1's outcome read on 2025-11-12 → 2026-11-12 (`SR_BACKTEST_VERDICT=NULL`; its per-cell figures are in the private vault and not quoted here): a disjoint, later window. Its result is the reason this wave exists, and its 1d cell is the reason for the descriptive read (§4.5). Read 2026-11-12T14:11:15Z; seen by the author in the wave spec | 2026-11-13 | inherited |
| EDGE-SR-LEVEL-PROBE-W1 (2026-11-11): `SR_PROBE_VERDICT=NULL` on emitted calls — a different corpus and estimand; no bounce, break or hit of a zone was computed there | 2026-11-11 | inherited |
| The wave spec: its sources, tests, bars and stop rule, which this file freezes | 2026-11-13 | inherited |

A search of the planning vault's status ledger (`status.md` and `Old Status/`, 2026-11-13) finds two S/R waves, the two above, and no backtest on candles from 2021 to 2024. No S/R outcome on candles before 2025-11-12 is known to the author.

Two disclosures about the label-free counts, as in the closed study. (1) A control's placement reads prices and zones at instants later than the served instant, because the control sits later in time (§4.4); the forced-control counts are therefore a property of the later path. They are not a bounce, break or hit statistic, and no parameter was chosen from them. (2) Whether a zone is entered is itself a path label, so it was not counted on real candles: every presence figure below uses served zones, an upper bound on entered events. The entry shares that size the power instrument come from the synthetic walks only.

No boundary ratio was examined: no rate of entry, bounce, break or timeout exists for any real candle of this window anywhere before the read.

## 3. Corpus — literal predicate, closed by a clock (PROCEDURE §3)

**The clock.** `endMs` = 2025-11-12T00:00:00Z (1762905600000), the closed study's `startMs`. The grid stops where every bar a label or a control reads has closed by `endMs` (t + horizon ≤ `endMs`, below), so no outcome on or after it is read. `startMs` = 2021-01-01T00:00:00Z (1609459200000): 1,776 UTC days. The hold-out is the UTC days from 2025-01-01 (1735689600000) on: 315 days. Every bar in the store closed at or before `endMs`.

**The panel.** The closed registration's 50 coins (its §3), in its order: BTC, ETH, ZEC, SOL, XRP, PEPE, NEAR, DOGE, BNB, UNI, ENA, SUI, AVAX, ADA, LINK, AAVE, ONE, WLD, INJ, TAO, XMR, ARB, QNT, LTC, XLM, FIL, ONDO, BCH, ZRO, ICP, ETHFI, DOT, FET, HBAR, DASH, PENGU, TRX, APT, SHIB, TIA, AERO, PYTH, OP, STRK, CRV, FARTCOIN, JUP, CYBER, ETC, BONK. Per coin: its first full UTC day of Binance perpetual history (the first UTC midnight at or after its first 15-minute kline; `fetch-store.ts --listing`, 2026-11-13T13:26:24Z, `SR_BACKTEST_LISTING_VERDICT=PASS`, 50 of 50 found). Its plan starts 300 days later, so 300 closed daily bars, at least 42 complete weeks, precede its first instant. Its first instant in a cell is the first grid instant at or after the later of `startMs` and its plan start. Each of its series holds 300 warm-up bars of its own timeframe before the plan start and runs to `endMs`.

| coin | first full day | first evaluated day | coin | first full day | first evaluated day |
|---|---|---|---|---|---|
| BTC | 2019-09-09 | 2021-01-01 | ETH | 2019-11-28 | 2021-01-01 |
| ZEC | 2020-02-06 | 2021-01-01 | SOL | 2020-09-15 | 2021-07-12 |
| XRP | 2020-01-07 | 2021-01-01 | PEPE | 2023-05-06 | 2024-03-01 |
| NEAR | 2020-10-16 | 2021-08-12 | DOGE | 2020-07-11 | 2021-05-07 |
| BNB | 2020-02-11 | 2021-01-01 | UNI | 2020-09-19 | 2021-07-16 |
| ENA | 2024-04-03 | 2025-01-28 | SUI | 2023-05-04 | 2024-02-28 |
| AVAX | 2020-09-24 | 2021-07-21 | ADA | 2020-02-01 | 2021-01-01 |
| LINK | 2020-01-18 | 2021-01-01 | AAVE | 2020-10-17 | 2021-08-13 |
| ONE | 2021-03-19 | 2022-01-13 | WLD | 2023-07-25 | 2024-05-20 |
| INJ | 2022-08-18 | 2023-06-14 | TAO | 2024-04-12 | 2025-02-06 |
| XMR | 2020-02-04 | 2021-01-01 | ARB | 2023-03-24 | 2024-01-18 |
| QNT | 2022-10-21 | 2023-08-17 | LTC | 2020-01-10 | 2021-01-01 |
| XLM | 2020-01-21 | 2021-01-01 | FIL | 2020-10-17 | 2021-08-13 |
| ONDO | 2024-01-21 | 2024-11-16 | BCH | 2019-12-20 | 2021-01-01 |
| ZRO | 2024-06-21 | 2025-04-17 | ICP | 2022-09-28 | 2023-07-25 |
| ETHFI | 2024-03-19 | 2025-01-13 | DOT | 2020-08-23 | 2021-06-19 |
| FET | 2023-01-18 | 2023-11-14 | HBAR | 2021-03-18 | 2022-01-12 |
| DASH | 2020-02-05 | 2021-01-01 | PENGU | 2024-12-18 | 2025-10-14 |
| TRX | 2020-01-16 | 2021-01-01 | APT | 2022-10-20 | 2023-08-16 |
| SHIB | 2021-05-11 | 2022-03-07 | TIA | 2023-11-01 | 2024-08-27 |
| AERO | 2024-12-05 | 2025-10-01 | PYTH | 2023-11-23 | 2024-09-18 |
| OP | 2022-06-02 | 2023-03-29 | STRK | 2024-02-21 | 2024-12-17 |
| CRV | 2020-09-02 | 2021-06-29 | FARTCOIN | 2024-12-21 | 2025-10-17 |
| JUP | 2024-02-01 | 2024-11-27 | CYBER | 2023-08-22 | 2024-06-17 |
| ETC | 2020-01-17 | 2021-01-01 | BONK | 2023-11-23 | 2024-09-18 |

**Survivorship and thinning, disclosed.** The panel was chosen on volume as of 2026-11-12 and on a daily history of at least 665 bars, so it holds coins that are listed and liquid now. Coins delisted between 2021 and 2025 are absent, and so are coins that were liquid then and are not now. The panel fills in as coins list: 14 coins are evaluated from 2021-01-01; by first evaluated day, 23 coins start in 2021, 3 in 2022, 6 in 2023, 11 in 2024 and 7 in 2025. AERO, PENGU and FARTCOIN start in October 2025, with 70, 45 and 39 1h instants, 8, 3 and 1 4h instants, and no 1d instant. The result speaks for these 50 coins over this window; it is not a claim about a coin picked at the start of the window. Both arms share all of it.

**The store.** 200 series (50 coins × 15m, 1h, 4h, 1d), store version 2 (each bar also carries the venue's base-asset volume, kline field 5), 0 failed, 7,120,184 bars, every planned bar present and every bar with a finite volume. Each coin's manifest, re-derived from its candle files by the guard's own functions (`buildManifest`, `manifestText`), equals the manifest file, for all 50 coins (2026-11-13T14:48Z). Read through `getAdapter('BINANCE').getCandles` under `runAsCaller('sr-level-backtest', …)` (the closed study's caller tag at its one call site, `fetch-store.ts`) on the operator's machine, into a directory outside the repository and the vault, with one plan and one manifest per coin (`plan-BINANCE-<COIN>.json`, `manifest-BINANCE-<COIN>.json`). The 50 manifests (per series: range, bar count, sha256; failures listed) are pinned in §10.

**The grid — the literal predicate.** For each panel coin and each cell, the instants are t = `startMs` + n × stride for n = 0, 1, 2, …, from the coin's first instant on, while t + horizon ≤ `endMs`. A row is a served zone of one source at one instant at which the source is defined: for htf, the cell, the daily layer and the weekly layer each have an ATR14 and at least 30 complete weeks have closed; for vpoc, the cell has an ATR14 and each of the 20 complete UTC days before the instant's day has a POC.

| cell | stride (15m units) | stride | horizon (bars of the cell) | instants for a coin evaluated from `startMs` | last instant (UTC) | of which in the hold-out |
|---|---|---|---|---|---|---|
| 1h | 49 | 12 h 15 m | 144 (6 days) | 3,468 | 2025-11-05T14:45Z | 605 |
| 4h | 221 | 55 h 15 m | 144 (24 days) | 762 | 2025-10-18T21:15Z | 127 |
| 1d (descriptive) | 1,181 | 12 d 7 h 15 m | 72 (72 days) | 139 | 2025-08-25T16:30Z | 20 |

Strides and horizons are the closed study's (`strideUnits`, `maxHorizonBars`), unchanged: each stride is one entry window plus an offset, coprime with 96 and with the timeframe's length, so the instants rotate through the UTC day and through every position inside the bar. Over the panel: 134,186 instants, 106,712 in 1h, 23,298 in 4h and 4,176 in 1d (the skeleton's `run-meta.json` counts the same 134,186).

**Coverage, two denominators.** Of the planned series: 200 of 200 complete. Of the planned grid instants: 134,186 of 134,186 evaluated. Of the served zones: every one has a control (§4.4), 1,300,982 of 1,300,982 over htf, vpoc and the descriptive z1; 120,366 of them forced (§5). A source undefined at an instant serves nothing there, for both arms: htf never at a coin's first instant (at least 42 complete weeks by the plan start); vpoc in a late coin's first ~7.5 days (§8, correction 8). The events the estimator cannot use are named in §4.5: a zone never entered; a cell-day under the minimum.

## 4. Methodology

### 4.1 The wave spec's stop rule, sources, tests and window — quoted

The words are the spec's. Its tests table is set here as a list: test — contrast — pass bar.

> **Stop rule (registered)**
> No PASS → S/R level construction is closed: no further level-rule wave; only a new information source (liquidations, order book) chosen by Mr.1 reopens it. A PASS → Mr.1 decides whether to reopen the level tool on that source, with labels, advice and a forward test earned again.
>
> **Sources (frozen in the registration)**
> - **htf**: the backtest's Z1 rule (`zoneSetOf`, level v0 unchanged) on 1d bars and on 1w bars (UTC-Monday weeks aggregated from the adapter's 1d bars: open first, high max, low min, close last, volume sum; all complete weeks up to 300, at least 30). Served set: nearest ≤ 3 supports and ≤ 3 resistances from the union; a 1d zone overlapping a 1w zone is served once, as the 1w zone.
> - **vpoc**: the point of control of each of the last 20 complete UTC days. Each 1h bar's volume is spread evenly over [low, high] into bins 0.25·ATR14(1d, as of that day) wide; POC = centre of the fullest bin (tie → lower price). The 20 lines → `linesToSet` (the line sources' helper) → zones.
> - Both are evaluated in the **1h and 4h cells** with the backtest's registered N, M, k, break rule, control rule and grid (`BT`, `strideUnits`, `controlWindow`), unchanged.
> - Descriptive only: the backtest's z1 on its 1d cell, on coin clusters (does the 2025–26 lead appear in 2021–25?).
>
> **Tests**
> - H_A — V1 Δ for htf: bounce(served) − bounce(control), cells 1h + 4h — point ≥ +3.0pp; **97.5%** lower bound > 0 on UTC-day clusters (two primaries); coin-cluster point > 0; hold-out point > 0
> - H_B — the same for vpoc — the same
>
> Estimator, presence rule (`minArm` 30), cluster floor (20) and bootstrap (B 2000) as the backtest's registration. `SR_HTF_VERDICT`: PASS = H_A or H_B meets its bar (each named) · NULL = both UTC-day 97.5% upper bounds < +3.0pp (a reversal named) · INDETERMINATE = else, cause named, with what resolves it.
>
> **Window, panel, hold-out**
> - Panel: the backtest's registered 50 coins, each from its first full day of Binance perp history; 300 bars of warm-up per timeframe (1w: at least 30 weeks). Survivorship (chosen on 2026 volume) disclosed; both arms share it.
> - `startMs` 2021-01-01T00:00Z · `endMs` 2025-11-12T00:00Z, the backtest's `startMs`: no outcome on or after it is read. Hold-out: 2025-01-01 → `endMs`.
> - PROCEDURE §2 lists every earlier look at these candles; no S/R outcome on them is known.

The sections below fix how each line is read. Where they differ from the wording above, they are the registered reading; the differences are listed as corrections in §8.

### 4.2 Source htf, as frozen (`src/scripts/sr-htf/sources.ts`)

- **Daily layer.** Z1 as the closed registration's §4.2 freezes it (`zoneSetAsOf`, `src/scripts/sr-backtest/zones.ts`; level v0 unchanged) on the coin's daily bars closed by the instant, the last 300 of them: pivots with k = 3, single-link merging at 0.25 × ATR14, qualifying at 2 touches, each cluster's [min, max] widened about its centre to at least 0.25 × ATR14 of the daily bars.
- **Weekly bars.** UTC-Monday weeks aggregated from the venue's daily bars (`weeklyBars`): the first day's open, the highest high, the lowest low, the last day's close, the volumes summed. A week is a bar only when all seven of its days are in the series. A week is visible at an instant only once it has closed, its Monday 00:00 UTC plus seven days at or before the instant (level v0's `asOfBars` on the weekly series, `weeksAsOf`). The week in progress is never seen.
- **Weekly layer.** Z1 (`zoneSetOf`) on the complete weeks closed by the instant, the last 300 of them at most; the weekly bars' own ATR14 is the merge and width unit. The source is undefined with fewer than 30 complete weeks; every coin has at least 42 at its first instant (§3).
- **Union.** Every weekly zone, and every daily zone that overlaps no weekly zone (closed intervals: a shared edge counts). A daily zone that overlaps a weekly zone is served once, as the weekly zone (`unionZones`).
- **Served set.** The closed rule (`servedOf`) on the union: the nearest ≤ 3 zones wholly below the price (supports, rank 1 = nearest) and the nearest ≤ 3 wholly above it (resistances); a zone that holds the price is neither.
- **Undefined** at an instant where the daily or the weekly layer has no ATR14, or fewer than 30 complete weeks have closed.

No test reads a label, the round flag or Super Strong.

### 4.3 Source vpoc, as frozen (`src/scripts/sr-htf/sources.ts`)

- **A day's POC** (`dayPoc`, `pocOf`). For one UTC day, its 24 1h bars, every one present, else the day has no POC. Bin width w = 0.25 × ATR14 of the daily bars closed at the day's end: Wilder's ATR (level v0's `wilderAtr`) of the last 300 daily bars, the day's own bar included. The bins are centred on the midpoint `mid` of the day's range (the lowest low and the highest high of its 1h bars): bin j holds the prices in [mid + (j − ½)·w, mid + (j + ½)·w). Each 1h bar's volume is spread evenly over [low, high]: a bin receives volume × (its overlap with [low, high]) ÷ (high − low); a bar with high = low puts its volume in the bin holding that price. POC = the centre of the fullest bin; a tie goes to the lower bin. A day whose total volume is zero, or whose volume is missing, negative or not finite, has no POC.
- **The lines at an instant** (`pocLines`). The POCs of the 20 complete UTC days before the day that holds the instant. The day in progress is never read. If any of the 20 has no POC, the source is undefined at that instant.
- **Zones.** The 20 lines go through `linesToSet` (`src/scripts/sr-backtest/engine.ts`, the closed study's helper for its line sources): each line becomes a zone 0.25 × ATR14 of the cell wide, centred on the line, and overlapping zones merge. The served set is the closed rule (`servedOf`) on these zones.
- **Undefined** where the cell has no ATR14 or any of the 20 days has no POC.

### 4.4 The cells, the clock, the path label and the control — the closed study's, unchanged

- **Cells.** 1h and 4h. In a cell, the ATR14 of the cell's timeframe as of the instant (the ATR of the closed study's Z1 set on that timeframe: Wilder, the last 300 closed bars) is the unit of a zone's distance, width and label, as it is for the closed study's line sources (`floor`, `pdhl`, `rnd`). A source is undefined where the cell has no ATR14.
- **The clock and the path** (closed §4.3). One 15-minute series per coin is the clock and the path; an instant is a 15-minute boundary; every outcome is read off the 15-minute bars that follow. The price at an instant is the close of the 15-minute bar that ends there.
- **The path label** (closed §4.4, `resolveZone`). N = 12 bars of the cell's timeframe, M = 12, k = 1.0 ATR14; break = 2 consecutive closes of the cell's timeframe strictly beyond the far edge. Entered, bounce, break and timeout as defined there; the bounce share of an arm is bounces ÷ entered.
- **The control** (closed §4.5, `placeControl`). The same side, distance and width in ATR, re-laid from the price and ATR of a later instant t2 = t + j bars of the cell, j = 13 … 108, tried in time order. The control is the first candidate at which the re-laid zone overlaps no zone of the same source at t2 (for htf, the union of §4.2; for vpoc, the zones of §4.3). If no candidate is free, it is the last one, flagged `forced`. Never dropped; no seed. A served zone and its control are tallied to the served instant's UTC day.
- **The descriptive 1d read** runs the closed study's own z1 source in its 1d cell over this window (j = 13 … 36), unchanged.

### 4.5 The statistic (`src/scripts/sr-htf/sr_htf.py`, importing `scripts/sr-backtest/sr_backtest.py`)

- **Cells and clusters.** Cells 1h and 4h. Clusters: the UTC day of the served instant, and separately the coin.
- **Presence.** A (cell, cluster) is present for a source only when the served arm and the control arm each hold at least 30 entered events there (`minArm`). An absent cell is absent, never zero; the count of absent cells is reported.
- **Δ in a cell and cluster.** 100 × bounce share (served) − 100 × bounce share (control). Weight = entered served + entered control. **Per cluster:** the weighted mean of Δ over the cells present. These are the closed estimator's own functions (`delta`, `margin`, `series`), imported.
- **Interval.** `cluster_bootstrap_ols` (`src/scripts/cluster-perm-stats.py`), intercept only, one observation per cluster, B = 2000, seed `arm_seed('EDGE-SR-HTF-LEVELS-W1', name)` with `name` = `htf-day`, `htf-coin`, `vpoc-day`, `vpoc-coin` (per cell `htf-1h-day`, …; the descriptive read `D-z1-1d-day`, `D-z1-1d-coin`). **Read at 97.5%, two-sided:** the 26th and the 1,976th of the 2,000 sorted draws (indices `int(0.0125 × 2000)` = 25 and `min(int(0.9875 × 2000), 1999)` = 1975). `cluster_bootstrap_ols` returns only its 95% interval, so `boot975` replays its draws (the same seed, resampling order, sum and division) and raises unless the replay's point and 95% interval are the function's own, bit for bit, on every call.
- **Coin-cluster point.** The same intercept on coin clusters.
- **Hold-out point.** The mean of the daily values on UTC days from 2025-01-01 on.
- **Identifiability at the read.** The bound of §Identifiability is recomputed from the outcome run's own side counts (`sides.json`) through the closed estimator's `identifiable` (`declaration_identifiability`, `ops/monitoring/population_comparison.py`); a source that is NOT_IDENTIFIABLE there makes its hypothesis INDETERMINATE.
- **Seeds.** Null calibration 20261113; bootstrap seeds as above. The real-data control uses no seed.
- **Descriptive only, deciding nothing:** Δ per cell with its own interval; the in-sample (2021–2024) mean; pooled entry, bounce, break and timeout shares per arm, over the window and in the hold-out; the forced share; and the closed study's z1 in its 1d cell over this window on UTC-day and coin clusters (the spec's question, read on coin clusters).

### 4.6 Frozen values

The harness and this file read these values from `src/scripts/sr-backtest/spec.ts` (`params`) and `src/scripts/sr-htf/config.ts` (the rest); `tests/unit/sr-htf-harness.test.ts` fails if the block below stops matching them.

<!-- sr-htf:frozen -->
```json
{
 "params": {
  "v0": {
   "pivotK": 3,
   "lookbackBars": 300,
   "atrPeriod": 14,
   "mergeAtrMult": 0.25,
   "minTouches": 2,
   "strongMin": 4,
   "behindFrac": 0.25,
   "naiveBars": 50,
   "lookaheadBars": 0
  },
  "minWidthAtr": 0.25,
  "maxServed": 3,
  "mediumTouches": 3,
  "strongTouches": 4,
  "entryBars": 12,
  "resolveBars": 12,
  "bounceAtr": 1,
  "breakCloses": 2,
  "bufferAtr": 0.25,
  "raceBars": 24,
  "controlLagBars": 12,
  "controlWindowBars": 96,
  "controlWindowDays": 24,
  "controlDisjoint": true,
  "controlWidthMult": 1
 },
 "study": {
  "startMs": 1609459200000,
  "endMs": 1762905600000,
  "holdoutStartMs": 1735689600000,
  "warmupDays": 300,
  "cells": [
   "1h",
   "4h"
  ],
  "descriptiveCell": "1d",
  "floorPp": 3,
  "ciLevel": 0.975
 },
 "hp": {
  "weekMinBars": 30,
  "weekMaxBars": 300,
  "pocDays": 20,
  "pocBinAtr": 0.25,
  "openWeek": false,
  "pocCurrentDay": false
 },
 "calibration": {
  "replications": 100,
  "walks": 50,
  "warmupDays": 300,
  "evalDays": {
   "1h": 40,
   "4h": 60
  },
  "startMs": 1609459200000,
  "seed": 20261113,
  "volumeMax": 1000
 },
 "panel": ["BTC", "ETH", "ZEC", "SOL", "XRP", "PEPE", "NEAR", "DOGE", "BNB", "UNI", "ENA", "SUI", "AVAX", "ADA", "LINK", "AAVE", "ONE", "WLD", "INJ", "TAO", "XMR", "ARB", "QNT", "LTC", "XLM", "FIL", "ONDO", "BCH", "ZRO", "ICP", "ETHFI", "DOT", "FET", "HBAR", "DASH", "PENGU", "TRX", "APT", "SHIB", "TIA", "AERO", "PYTH", "OP", "STRK", "CRV", "FARTCOIN", "JUP", "CYBER", "ETC", "BONK"]
}
```

`params` is the closed study's `BT`, unchanged; this study reads its N (`entryBars`), M (`resolveBars`), k (`bounceAtr`), break rule (`breakCloses`), control rule (`controlLagBars`, `controlWindowBars`, `controlWindowDays`, `controlDisjoint`, `controlWidthMult`), `minWidthAtr` and `maxServed`. `openWeek` and `pocCurrentDay` exist only so a test can break the as-of cut (a weekly bar that includes the unfinished week; a POC that reads the current day); the registered values are `false`. `controlDisjoint` and `controlWidthMult` are test-only switches; the registered values are `true` and `1`.

### 4.7 Behaviour with no effect: the null calibration (AC1.5)

100 seeded replications, each of 50 driftless integer random walks: the closed study's walks (`synth.ts`: 15-minute bodies uniform on ±500 ticks, wicks uniform on 0–300, start 5,000,000), each 15-minute bar carrying a volume uniform on 1–1,000 from its own seeded stream (`synthv.ts`), summed into the 1h, 4h and 1d aggregates. Each walk holds 300 daily bars of warm-up, 40 evaluation days in the 1h cell and 60 in the 4h cell, and the horizon. The walks run through the whole harness: sources, grid, control, labels, estimator, verdict. Result, committed as `src/scripts/sr-htf/calibration.json` and reproduced from the seed by the test suite (the 100 replications' counts have sha256 `209c5f74148d1acf4a3f43cab521b7cfcbb21fec475597d53c5b29f7f519069a`; two generations on 2026-11-13 gave the same bytes):

| quantity | htf (H_A) | vpoc (H_B) | bar |
|---|---|---|---|
| mean Δ over the 100 replications | −0.10pp (standard error 0.18pp) | +0.01pp (standard error 0.07pp) | within ±0.5pp |
| share of replications whose hypothesis is PASS | 0.03 | 0.00 | ≤ 0.05 |
| standard deviation of one replication's Δ (42–49 day clusters, 50 independent walks) | 1.82pp | 0.74pp | — |
| share of replications whose 97.5% interval excludes zero | 0.09 | 0.00 | — (nominal 0.025) |
| share of served zones entered, 1h · 4h (controls the same to ±0.001) | 0.102 · 0.198 | 0.440 · 0.571 | — |
| forced share of controls, 1h · 4h | 12.55% · 5.52% | 0.06% · 0.16% | — |

`SR_HTF_CALIBRATION_VERDICT=PASS`. The 100 study verdicts: 49 NULL, 48 INDETERMINATE and 3 PASS (all three by htf). 47 of the 48 INDETERMINATE ones are the registered underpowered branch, an interval that holds +3.0pp with its lower bound at or under zero (htf in 43, vpoc in 5, both in 1): a replication holds only 42–49 day clusters. The 48th is an htf UTC-day pass with a hold-out point at or under zero. The htf interval is anti-conservative on these walks, excluding zero in 0.09 of the replications against a nominal 0.025: an htf zone is wide in the cell's ATR and is entered about one time in ten in the 1h cell, so a replication's day clusters hold few htf events, unevenly. PASS also needs the point at or over +3.0pp, a positive coin-cluster point and a positive hold-out point; 3 of 100 replications passed, inside the bar of 0.05. The real read pools up to 50 coins in a UTC day, over up to 1,776 days (§5).

**Mutations.** A control laid at half the served zone's width (`controlWidthMult` 0.5) fails the calibration (`SR_HTF_CALIBRATION_VERDICT=FAIL`, a mean Δ beyond ±0.5pp); a control that ignores disjointness (`controlDisjoint` false) breaks the control rule's reference check; a weekly bar that includes the unfinished week (`openWeek`) and a POC that reads the current day (`pocCurrentDay`) break their known answers and the as-of property (AC1.3). The test suite runs each.

## 5. Floors and power (PROCEDURE §5)

**Cluster floors.** 20 UTC-day clusters and 20 coin clusters (`minClusters`), per hypothesis. Never a row floor: the 30-per-arm minimum decides whether a cell is present in a cluster, not whether a test is read.

**Label-free cardinalities** (`python3 -I src/scripts/sr-htf/sr_htf.py --cardinalities <skeleton dir>`, run 2026-11-13T14:50:15Z on the skeleton of 14:49:10Z–14:50:14Z; skeleton sha256 in §10). 50 coins, 134,186 grid instants (106,712 in 1h, 23,298 in 4h, 4,176 in the descriptive 1d cell: the planned count, §3), 1,770 UTC days with a served row (the last six days of the window hold no instant), 309 of them in the hold-out. Entry is an outcome and is not counted on real candles, so "days at ≥ n served" is the presence proxy. On the null walks (§4.7) a served zone is entered about 0.10 of the time for htf in 1h, 0.20 for htf in 4h, 0.44 for vpoc in 1h and 0.57 for vpoc in 4h; 30 entered events per arm then need about 300, 150, 75 and 75 served zones in a cell-day, hence the four thresholds. The real entry share is an outcome and is not known.

| arm | cell | served zones | forced controls | forced share | UTC days | days at ≥ 30 / 75 / 150 / 300 served | hold-out days at ≥ 75 / 300 | coins |
|---|---|---|---|---|---|---|---|---|
| htf | 1h | 535,956 | 104,918 | 19.58% | 1,770 | 1,770 / 1,756 / 1,572 / 843 | 309 / 296 | 50 |
| htf | 4h | 116,931 | 13,807 | 11.81% | 762 | 762 / 688 / 378 / 0 | 127 / 0 | 50 |
| vpoc | 1h | 520,029 | 78 | 0.01% | 1,770 | 1,770 / 1,764 / 1,614 / 720 | 309 / 293 | 50 |
| vpoc | 4h | 108,546 | 107 | 0.10% | 762 | 762 / 701 / 273 / 0 | 127 / 0 | 48 |
| z1 (descriptive) | 1d | 19,520 | 1,456 | 7.46% | 139 | 139 / 125 / 51 / 0 | 20 / 0 | 47 |

Every served zone has a control (served = matched in every row). vpoc has no 4h zone for PENGU and FARTCOIN (their few 4h instants fall in their first ~7.5 days, §8 correction 8); the descriptive 1d cell has no instant for AERO, PENGU and FARTCOIN.

**Presence by year.** A cell-day pools the coins of the UTC day, and the panel fills in as coins list (§3). Served zones per 1h cell-day, median by year: htf 165 (2021), 261 (2022), 303 (2023), 380 (2024), 470 (2025); vpoc 164, 258, 279, 357, 473. UTC days at the proxy in either cell (1h ≥ 300 or 4h ≥ 150 for htf; ≥ 75 for vpoc): htf 861 — 0 in 2021, 19 in 2022, 209 in 2023, 333 in 2024, 300 in 2025 (all 300 in the hold-out); vpoc 1,764 — 359, 365, 365, 366, 309. At the null walks' entry share H_A is in effect a 2023–2025 read; vpoc covers the window.

**Per coin.** Served zones per coin, minimum / median / maximum: htf 1h 207 / 12,595 / 18,749 · htf 4h 5 / 2,762 / 4,115 · vpoc 1h 109 / 13,062 / 17,347 · vpoc 4h 20 / 2,753 / 3,645 (48 coins) · z1 1d 50 / 524 / 678 (47 coins). Coins at the proxy over the window: htf 48 in 1h (≥ 300) and 47 in 4h (≥ 150); vpoc 50 in 1h and 47 in 4h (≥ 75).

**Where the weight sits.** Of the served zones, htf 82.1% in 1h and 17.9% in 4h; vpoc 82.7% and 17.3%. The cell-weighted mean is in effect a 1h read; per-cell estimates are reported beside it and decide nothing.

**Forced controls.** htf's controls are forced more often than on the null walks (19.58% and 11.81% against 12.55% and 5.52%). The forced share is a property of the later path (§2), and no cause is claimed for the difference. A forced control overlaps a zone of the source, so it is partly a zone itself and pulls htf's Δ toward zero. It is kept (the closed rule's rule 3: dropping it selects the served arm on the later path), and the forced share is reported at the read.

**Power — instrument 1:** `python3 -I src/scripts/sr-htf/sr_htf.py --power <skeleton dir> --enter <1h>,<4h>` (run 2026-11-13T14:50:15Z – 14:55:51Z; defaults: 200 simulations per difference, 400 bootstrap draws, base 0.55). Each hypothesis's UTC-day leg on the real label-free counts with simulated outcomes: every served zone and every control is entered with the null walks' entry share for its source and cell (§4.7: htf 0.10 in 1h and 0.20 in 4h, `--enter 0.10,0.20`; vpoc 0.44 and 0.57, `--enter 0.44,0.57`); the control bounces with probability 0.55 and the served zone with 0.55 plus the injected difference; the 97.5% interval is `boot975`'s replay at 400 draws; the coin-cluster leg is assumed to pass; the hold-out leg is read on the real hold-out days.

| hypothesis | injected Δ | mean estimate (pp) | spread of the estimate (pp) | PASS | NULL | INDETERMINATE |
|---|---|---|---|---|---|---|
| H_A (htf) | 0.0 | −0.02 | 0.36 | 0.000 | 1.000 | 0.000 |
| H_A (htf) | +3.0 | 3.00 | 0.33 | 0.515 | 0.000 | 0.485 |
| H_A (htf) | +4.0 | 4.03 | 0.39 | 0.995 | 0.000 | 0.005 |
| H_A (htf) | +5.0 | 5.00 | 0.39 | 1.000 | 0.000 | 0.000 |
| H_B (vpoc) | 0.0 | 0.03 | 0.15 | 0.000 | 1.000 | 0.000 |
| H_B (vpoc) | +3.0 | 3.01 | 0.16 | 0.530 | 0.020 | 0.450 |
| H_B (vpoc) | +4.0 | 3.99 | 0.15 | 1.000 | 0.000 | 0.000 |
| H_B (vpoc) | +5.0 | 5.00 | 0.14 | 1.000 | 0.000 | 0.000 |

Each hypothesis's rows come from its own source's entry shares: H_A from the `--enter 0.10,0.20` run and H_B from the `--enter 0.44,0.57` run (each run also simulates the other source at the wrong entry share; those rows are not the registered instrument and are not shown). At a true zero both read NULL in every simulation. At the floor's own value, +3.0pp, about half pass, as they must: PASS needs the point itself at or over +3.0pp. At +4.0pp H_A passes in 0.995 of the simulations and H_B in all of them.

**What that instrument cannot see.** It draws every event independently, so its spread is a floor and its power a ceiling: it holds no market move shared by the coins of a day, and none of the path shared by neighbouring days (a control sits up to 4.5 days after its served instant in 1h and 18 days in 4h, §4.4). **Instrument 2**, the null calibration (§4.7), carries the harness's own dependence but independent walks: one replication's spread is 1.82pp for htf and 0.74pp for vpoc at 42–49 day clusters of 50 walks; scaled by √(D ÷ N) from the replications' median D day clusters (48 for htf, 49 for vpoc) to the N days at the presence proxy (861 for htf, 1,764 for vpoc), about 0.43pp and 0.12pp. That scaling assumes a real day carries as much as a synthetic one; early real days hold fewer coins (§3), and real coins move together, so the realised spread will be wider than both instruments; how wide is not knowable before the read.

**Reading at +3.0pp.** PASS needs the point itself at or over +3.0pp, so at a true difference of exactly +3.0pp PASS is at most about one half whatever the sample. With a realised standard error s of the UTC-day mean, and while 2.24 × s < 3.0 (2.24 is the normal quantile of a two-sided 97.5% interval), P(PASS) ≈ Φ((Δ − 3.0) ÷ s) (normal arithmetic, not an instrument run): at s = 0.5pp, 0.98 for a true +4.0pp; at s = 1.0pp, 0.84 for +4.0pp and 0.98 for +5.0pp. A true zero reads NULL when the upper end is under +3.0pp, P ≈ Φ((3.0 − 2.24 × s) ÷ s): near certain at s ≤ 0.5pp, about 0.78 at s = 1.0pp, about one half at s = 1.34pp.

**The registered underpowered branch.** An interval that holds +3.0pp with its lower end at or under zero is INDETERMINATE — underpowered, never a negative. So is a UTC-day leg that passes while the coin-cluster point or the hold-out point is at or under zero.

## Support stress-test (PROCEDURE §4)

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| H_A UTC-day cluster floor | 20 UTC days with a present htf cell (1h or 4h) | 861 UTC days carry at least 300 served htf zones in 1h or 150 in 4h (843 and 378), the proxy for 30 entered at the null walks' entry shares; 0 of them in 2021, 19 in 2022 — an upper bound on entered events | inside — the entered counts are read at the outcome; under 20 present days is the registered INDETERMINATE |
| H_B UTC-day cluster floor | 20 UTC days with a present vpoc cell | 1,764 UTC days carry at least 75 served vpoc zones in 1h or 4h | inside |
| H_A coin-cluster floor | 20 coin clusters | 50 coins serve htf zones in both cells; 48 reach 300 served in 1h and 47 reach 150 in 4h over the window; the smallest holds 207 (1h) and 5 (4h) | inside |
| H_B coin-cluster floor | 20 coin clusters | 50 coins serve vpoc zones in 1h, 48 in 4h; 50 and 47 reach 75 served | inside |
| H_A hold-out sign | UTC days from 2025-01-01 | 300 hold-out days at the htf proxy (296 in 1h, 127 in 4h) | inside |
| H_B hold-out sign | UTC days from 2025-01-01 | 309 hold-out days at the vpoc proxy in 1h, 127 in 4h | inside |
| cell-day minimum, both arms | 30 entered events per arm | entry is an outcome and was not counted; proxies 300 / 150 served (htf 1h / 4h) and 75 / 75 (vpoc), from the null walks' entry shares | inside — absent cell-days are counted and reported at the read |
| cell weights of the pooled mean | weight = entered served + entered control | served zones: htf 82.1% in 1h, 17.9% in 4h; vpoc 82.7% and 17.3% | floor — H_A and H_B are in effect 1h reads; per-cell estimates are descriptive; no cell is reweighted or dropped after the read |
| panel thinning in early years | the coins of a UTC day, pooled in a cell-day | 14 coins evaluated from 2021-01-01, 23 by 2021-08-13, 50 by 2025-10-17 (§3); median served htf zones per 1h cell-day 165 in 2021, 470 in 2025 | floor — at the null walks' entry share H_A rests on 2023–2025 days (19 in 2022, none in 2021); a day is a cluster only where present, never filled |
| weekly layer depth | at least 30 complete weeks; at most 300 read | at least 42 complete weeks at every coin's first instant (plan start = first full day + 300 days; every planned daily bar present) | inside |
| vpoc's 20 days | 24 1h bars with volume on each of the 20 complete UTC days before the instant's day | 56,192 complete UTC days in the 1h series, 0 with zero total volume, 0 zero-volume bars, 0 bars with high = low; a late coin's first ~7.5 days are undefined (1h warm-up 12.5 days) | inside |
| lookback and ATR seed | 300 closed bars of each timeframe; 15 for ATR14 | every series holds 300 warm-up bars before its plan start; 200 of 200 series complete, 0 failed | inside — every zone set is built on a full 300 bars |
| control window | 96 candidates (1h, 4h) | forced controls: htf 19.58% (1h), 11.81% (4h); vpoc 0.01%, 0.10%; on the null walks htf 12.55% / 5.52% | inside — forced controls are kept; they pull htf's Δ toward zero; the forced share is reported at the read |
| day clusters as independent units | a control up to 4.5 days (1h) or 18 days (4h) after its served instant | on the null walks 0.09 (htf) and 0.00 (vpoc) of 97.5% intervals exclude zero, nominal 0.025 | floor — the htf UTC-day interval is narrow on the null walks; PASS also needs the point at or over +3.0pp, a positive coin-cluster point and a positive hold-out point, and the calibration's P(PASS) is 0.03 |
| grid rotation | strides of 49 and 221 fifteen-minute units | 49 and 221 are each coprime with 96 and with 4 and 16 | inside — instants cover every time of day and every position inside a bar |
| panel selection | the closed study's 50 coins, chosen on volume as of 2026-11-12 with ≥ 665 daily bars | coins delisted or no longer liquid are absent | floor — survivorship (§3) |
| descriptive 1d read | 139 instants for a coin evaluated from `startMs`, stride 12.3 days | z1 in 1d: 19,520 served zones on 139 UTC days (125 at ≥ 75 served), 47 coins (46 at ≥ 75 served), forced 7.46% | floor — descriptive only, decides nothing; its UTC days are few, so the coin-cluster read is the one the spec asks for |
| the 97.5% interval | 2,000 draws; the 26th and 1,976th sorted | the replay equals `cluster_bootstrap_ols`'s point and 95% interval bit for bit on every call; the self-test's `replay-seed` and `ci95` mutations fail it | inside |

## Identifiability (PROCEDURE §4c)

Each declared floor (+3.0pp on H_A and on H_B) is a floor on a difference between two arms' bounce shares, so the served arm's side mix must be able to carry it. The two sides are support and resistance, and m is the smaller side's share of the source's served rows over both cells (label-free; the counts are the skeleton's `sides.json`, printed by the probe below). Both bounds are far above the floor. The same bound is recomputed from the outcome run's own side counts at the read; a NOT_IDENTIFIABLE arm there is the registered INDETERMINATE. Each verdict below was recomputed through `python3 ops/monitoring/population_comparison.py --declarations`.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| H_A — bounce(served) − bounce(control), cells 1h + 4h | served htf zones | 0.4954 — probe `python3 -I src/scripts/sr-htf/sr_htf.py --cardinalities <skeleton dir>`, n = 652,887 (323,471 supports, 329,416 resistances) | 3.0 | 99.08 | IDENTIFIABLE |
| H_B — bounce(served) − bounce(control), cells 1h + 4h | served vpoc zones | 0.4920 — probe `python3 -I src/scripts/sr-htf/sr_htf.py --cardinalities <skeleton dir>`, n = 628,575 (309,240 supports, 319,335 resistances) | 3.0 | 98.40 | IDENTIFIABLE |

The descriptive 1d read declares no floor (its side share is 0.4916 on 19,520 rows).

## 6. Decision rule (PROCEDURE §6) — three states per hypothesis

**H_A (htf) and H_B (vpoc), each:**

- **PASS** — on UTC-day clusters (at least 20) the point is at or over +3.0pp and the 97.5% lower bound is above zero; on coin clusters (at least 20) the point is above zero; and the hold-out point is above zero.
- **NULL** — with at least 20 UTC-day clusters and an identifiable arm, the UTC-day 97.5% upper bound is under +3.0pp. It reads "this source's zones bounce no more than matched random zones by +3.0pp", as plain as a pass. An upper bound under zero is a NULL that names the reversal.
- **INDETERMINATE** — anything else, cause named and what resolves it: no cell-day with both arms at 30 entered events · fewer than 20 UTC-day clusters · a NOT_IDENTIFIABLE arm · the UTC-day leg passing with fewer than 20 coin clusters or the coin-cluster point at or under zero · a hold-out point at or under zero, or no hold-out day present · an interval holding +3.0pp with its lower bound at or under zero · a lower bound above zero with the point under +3.0pp and the interval holding +3.0pp. What resolves each: more scored UTC days (a forward window), a wider panel, or a served set that carries both sides, as the cause names.

**The study, one line `SR_HTF_VERDICT=<PASS, NULL or INDETERMINATE> — <cause>`:**

- **PASS** — H_A or H_B is PASS; each one that passes is named.
- **NULL** — both are NULL, i.e. both UTC-day 97.5% upper bounds are under +3.0pp; a reversal in either is named.
- **INDETERMINATE** — neither passes and at least one is not NULL; each open hypothesis's cause and what resolves it are named.

A null counts only because its interval excludes the floor. An interval that still holds +3.0pp is underpowered, never negative.

**The stop rule, applied.**

- **PASS** → Mr.1 decides whether to reopen the level tool on the passing source, with labels, advice and a forward test earned again; nothing is built or published before that ruling. Record (CH3): register row ARCHITECT "reopen the level tool on <source>? (Mr.1)".
- **NULL** → S/R level construction is closed: no further level-rule wave; only a new information source (liquidations, order book) chosen by Mr.1 reopens it. Record: no register row; the status entry states "S/R level construction closed (stop rule)".
- **INDETERMINATE** → there is no PASS, so the stop rule closes level construction as well. Record: register row OWED, naming what resolves it.

The descriptive 1d read decides nothing, whatever it shows. Whatever the verdict, nothing here claims edge or accuracy.

## 7. Declared expectations and respecification (PROCEDURE §7)

- Signs expected if a source's zones carry information: Δ > 0 for H_A and for H_B. No sign is expected of the descriptive read.
- Expectation, stated before the read: none. No bounce figure has been seen for any real candle of this window. The closed study's result on the later window is known to the author (§2, inherited) and set nothing here beyond the existence of the descriptive read. The control is built to be a hard comparator, so a NULL is a likely and acceptable outcome, and the stop rule is written for it.
- No parameter in §4.6, no cell set, no source definition, no minimum, no estimator and no verdict rule is changed after the read. A respecification one would not have proposed had the check passed is not applied to these rows: it is registered and applied to data nobody has read, a forward window.

## 8. Deviations, quarantine, publication (PROCEDURE §8)

- A deviation from this file is recorded in the findings with its cause and the new sha256 of whatever changed, and the verdict is then given both ways; it is never absorbed. The pinned-hash test and the outcome guard make a silent change to the level rule, the zone rule, the engine, the sources, the estimator or the candles fail.
- Figures live only in the private vault (`audits/EDGE-SR-HTF-LEVELS-W1-findings.md` and `.json` there). No bounce, break, hit or entry rate on real candles enters this repository or any public surface. The outcome step refuses an output directory inside the repository.
- Corrections to the wave spec, all made before any outcome read:
  1. **The source registry is `src/scripts/sr-htf/registry.ts`, not `engine.ts`.** The spec places "a source registry in `engine.ts`". `engine.ts` is pinned by sha256 in the closed registration's §10 (enforced by its outcome guard), by the closed test suite and by the closed calibration artifact's harness hash: a byte added there turns `tests/unit/sr-backtest-*.test.ts`, part of this wave's own CH1 gate, red and breaks AC1.4. The registry reproduces the closed engine's non-z1 path line for line and adds the two sources as providers; `engine.ts` is untouched. `tests/unit/sr-htf-harness.test.ts` proves that the four registered sources through the registry reproduce the closed engine's counts byte for byte on a synthetic store (AC1.4).
  2. **The 97.5% interval** is a bit-checked replay of `cluster_bootstrap_ols`'s draws, which returns only its 95% interval (§4.5).
  3. **One plan and one manifest per coin.** The closed guard takes one store label and one manifest re-derived from one plan range; each coin's window starts at its own first full day plus 300 days. The fetcher writes one plan and one manifest per coin (`--label BINANCE-<COIN>`), the guard runs once per coin (`checkPanelGuard`), and §10 pins 50 store manifests.
  4. **The vpoc bin grid** is anchored on the day's range midpoint, which the spec leaves open. The grid then maps onto itself under p → K − p, so the mirror (AC1.2) holds exactly except on an exact tie, where "tie → lower price" is itself asymmetric; a test fixture shows the tie both ways.
  5. **"ATR14(1d, as of that day)"** is the daily ATR14 with that day's own bar included, at its close. A day's POC is used only once the day has closed, so either reading is causal; this one uses the day it describes.
  6. **htf control disjointness** is checked against the source's own zones at the candidate instant, the deduped union, as the closed rule checks a source's own zones ("disjoint from every qualifying zone then", its correction 2).
  7. **The caller tag is the closed study's `sr-level-backtest`**, at its one call site in `fetch-store.ts`: the repository's caller-tag gate treats every `src/scripts/**.ts` as an entrypoint and refuses one tag reached from two. No `sr-htf` file imports the fetcher.
  8. **Late coins and vpoc.** Each series holds 300 warm-up bars of its own timeframe, so a late coin's 1h series starts 12.5 days before its first instant and vpoc, which needs 20 complete days of 1h bars, is undefined for its first ~7.5 days. Both arms share it. For a coin evaluated from `startMs` the 1h series reaches further back and nothing is lost.
  9. **"97.5% lower bound" and "97.5% upper bounds"** are read as the two ends of one two-sided 97.5% interval: the 1.25th and 98.75th percentiles of the draws. This is the stricter reading both ways: PASS needs the lower end above zero, NULL needs the upper end under +3.0pp.
  10. **§4c identifiability** is recomputed at the read, as the closed registration did; a NOT_IDENTIFIABLE arm makes its hypothesis INDETERMINATE.
  11. **NULL is decided per hypothesis** (its UTC-day 97.5% upper bound under +3.0pp, with at least 20 day clusters and an identifiable arm), and the study is NULL when both are, as the spec's "both UTC-day 97.5% upper bounds" says.
  12. **The null calibration's hold-out.** Synthetic walks carry no calendar; the calibration's hold-out leg uses the last share of each replication's present days equal to the real hold-out's share of the window (315 / 1,776).
  13. **The pinned-file test** (`tests/unit/sr-htf-harness.test.ts`) checks byte equality of every file in `HTF_PINNED` and of the calibration artifact; for the two shared statistics libraries it checks only that a pin exists, so another wave's later edit does not turn this suite red. The outcome guard enforces their bytes at the read, as in the closed study (its correction 8).
  14. **The audit model.** The spec names "Fable 5.1 · Extra" for CH3; Fable 5.1 is not an available model in the session that executes this wave. The fresh-context audit runs on `fable` (Fable 5.2) at effort `xhigh`, given only what the spec lists. A deviation of tooling, not of method.

## 9. Owner, the read, and the inheritors (PROCEDURE §9)

- **Owner:** Mr.1. **The read:** this wave's CH2, once, after this file is on `origin/main`. Then a fresh-context audit (CH3) re-runs the tests and mutations, AC1.4 and AC1.5, recomputes H_A and H_B from the persisted files with its own code, and checks the order, §8 and the files written.
- **Inheritors.** A later level source (liquidation clusters, anchored VWAP, order-book walls) plugs into `src/scripts/sr-htf/registry.ts` as a provider and gets the same matched-random verdict; it registers its own source and corpus. If Mr.1 reopens the level tool on a passing source, its forward test inherits this file; anything it changes is its own registration.
- **Records by verdict (CH3):** NULL → no register row, and the entry states "S/R level construction closed (stop rule)" · PASS → register row ARCHITECT "reopen the level tool on <source>? (Mr.1)" · INDETERMINATE → register row OWED naming what resolves it.

## 10. Pinned artifacts

| artifact | sha256 |
|---|---|
| `src/scripts/sr-probe/level-v0.ts` | `ec57e3215daf2ac510b61d7e2c71563c610e6c45ab02900eda8591f2d6106f40` |
| `src/scripts/sr-probe/store.ts` | `11c68af03e8534393ab4021c461aa2f0768fcc9972d7af698a42db17f8f55d14` |
| `src/scripts/sr-backtest/spec.ts` | `eb716ec7fcd2bbadf2a1f24754480a8978062dd3a1b7443684b006e99623444a` |
| `src/scripts/sr-backtest/zones.ts` | `fd8b4c6396c5b7f2050e5d7651897a93247fb3288bf85fd3282ce570c473f1f7` |
| `src/scripts/sr-backtest/engine.ts` | `30a59a7bdb6198dfe14515558b7ac177042af971a5a68fe8745a8f3d5c7f1366` |
| `src/scripts/sr-backtest/store.ts` | `1446732b7d5cfb78cfcbe7b40c6db24980db1874ecfa2072a298b803f3021d04` |
| `src/scripts/sr-backtest/guard.ts` | `977ada54406f20140599f82934a7e481d9defbfffd6dfee4a71ddc77a8626ee1` |
| `src/scripts/sr-backtest/synth.ts` | `79d4d8a66006ddb71375e25854544bfcb036c9c07051155eba072f5ee57e3cb8` |
| `scripts/sr-backtest/sr_backtest.py` | `4b0e1bb0dd36f07308ae19a3d668257ece4a677fd30f0437c1644cf09989018b` |
| `src/scripts/sr-htf/config.ts` | `cad14da993136ab2d6400ac232d7d469cd91e6fe0ddb5078850c88ba8b19a81e` |
| `src/scripts/sr-htf/registry.ts` | `1d086c883717f48bc31fae1fd998c3d60475d2361f69009548ab24d9656acd92` |
| `src/scripts/sr-htf/sources.ts` | `0d468d022272427020f8cdbbee6a9480d3bbab36b25fc64fc0f693b3cc6380ba` |
| `src/scripts/sr-htf/htf-store.ts` | `2515dbb9d872b5f9a9a6fa17c816aa1519c9a7ee2330f757bae043e5d0f6d428` |
| `src/scripts/sr-htf/synthv.ts` | `487788ac84bcac2a1e0e4509eb325d1abccf6e9de47948757c5068c92d2c5c81` |
| `src/scripts/sr-htf/htf-run.ts` | `b9c82dd47223e7ecd3112b3a7f8c10bb9e3443b9fc201a0ed36265d877552650` |
| `src/scripts/sr-htf/sr_htf.py` | `6fa9053b9ea3b93f12f9aee0aa1d9366a53ee439db0553f07b5e2bf2f3b97cfe` |
| `src/scripts/cluster-perm-stats.py` | `6d82c1601a9ce1121deecaa1c88ac4685abef328ff27d35047fad37d69f60100` |
| `ops/monitoring/population_comparison.py` | `282587c48242601ca3d94f6d748742d7722d49e57f5b975f6da85a94e0e258fb` |
| `src/scripts/sr-htf/calibration.json` | `a6c992c326327c1a5996354385d70ccb541cf809769817dcf2c47095ba3cd7f7` |
| `store:manifest-BINANCE-BTC.json` | `d0e72c22bc5c0a180ac3589f5f1c62a98bb36c716548e990dd9297833d5d0f2d` |
| `store:manifest-BINANCE-ETH.json` | `f53f01e8f6579fcb7e8bc5142466c262cf12679a6770e8e88466d8a1b6251abc` |
| `store:manifest-BINANCE-ZEC.json` | `36ac99fd4179fb2450f56183214fcc52d4c9cf6f8fde60904c1a039dbe9b18bf` |
| `store:manifest-BINANCE-SOL.json` | `3a03be68fe7a86d7e676419b01aa6e1d9299b820ebb6a938b5237e4bbf2fd545` |
| `store:manifest-BINANCE-XRP.json` | `0a6facefba6de9f6ba1cc6b13a12cb05ba292d539f5ff848311d566252b23a13` |
| `store:manifest-BINANCE-PEPE.json` | `174441fd5d267c9658f58b59f9e52f5c7433befd7d867620490dd877db1e62cb` |
| `store:manifest-BINANCE-NEAR.json` | `03c9a849195f409c37f7137f42fc3c173c9ce11fcc504e149101b23823d5b685` |
| `store:manifest-BINANCE-DOGE.json` | `036552ac42c63b1fd92f74eaf88336b5bd3384da62232be7fe51d88f48edf0d4` |
| `store:manifest-BINANCE-BNB.json` | `0c802c49b5b1e66adc6def94cce3eb951a2d0bfd2d8c5bfb4f95b39e284d5072` |
| `store:manifest-BINANCE-UNI.json` | `0f30c33ec27903b00444f34c3e699689607d98fe7dff42b8b2ad0526ab8d1e4a` |
| `store:manifest-BINANCE-ENA.json` | `29815e2e610db94cc33ceb0798da7ae615e1d09b9909c2cae407a49fec903411` |
| `store:manifest-BINANCE-SUI.json` | `a1294963558004b7a1d283426ee4e7fa120bc68d50b8c709985e51a2692bab77` |
| `store:manifest-BINANCE-AVAX.json` | `5ecb35e7ad4ace6cb03e786075964f29bcbbd9c612fd526defa0c501f7f60f24` |
| `store:manifest-BINANCE-ADA.json` | `0c9f2f28de4618910739879c54e4f10b517b0c679b5dd431b3fbcbdb71fe654b` |
| `store:manifest-BINANCE-LINK.json` | `848bda64215ccee5476f045fa8466c0dad18c44f592001330272d6e64aa9aa89` |
| `store:manifest-BINANCE-AAVE.json` | `42b8d2cb3cb6c80315bf9a2e50abec90b7e68ccb316a1dc41fd64983ae38277e` |
| `store:manifest-BINANCE-ONE.json` | `71e9983f73c590dc658dc588afe564ae19bce7bfa5d879355f51129bc4a4bf05` |
| `store:manifest-BINANCE-WLD.json` | `c5872ccd6142e82d7e87bf638e34f476d5ee1b7d572c485274cefa6c56fb61eb` |
| `store:manifest-BINANCE-INJ.json` | `890b99877eee79dc3f91aaeab802a77cca1eae40a59a9c99f1ca7414161cc622` |
| `store:manifest-BINANCE-TAO.json` | `7a9d6b6766f63be76944f760b7372971123acc19f8bf3556bb0347953357515d` |
| `store:manifest-BINANCE-XMR.json` | `b766664fffb244b179de13a79a282deb748f5415a38fe3db09073f103803fa40` |
| `store:manifest-BINANCE-ARB.json` | `92782349762378506d8735c19c6e8f87bd850541ad0582e774d877f385d10ad8` |
| `store:manifest-BINANCE-QNT.json` | `41501003b560f8cf014f54ea77ce7783ecbc0bbaea939fa9d1cf6852f99422ca` |
| `store:manifest-BINANCE-LTC.json` | `247dcff0c76e409c0893213fe6be4ed6e6a7a7bf1f03495c0b7f59ffb45ea930` |
| `store:manifest-BINANCE-XLM.json` | `c7ebffb3b8f530649b60ce642c371d8d7b48b793c9fc5a867c0d17dca9d2261f` |
| `store:manifest-BINANCE-FIL.json` | `99c1e8d2040f7d0e7d23877f8075adde37c16fdd623e796805de06f1c2ade1a1` |
| `store:manifest-BINANCE-ONDO.json` | `dbb3866b656473ff88ad94c22a85452c1130257a020542086a8d262473c2a8d8` |
| `store:manifest-BINANCE-BCH.json` | `8a3f381deebd66a5aee1cb9667ba53294fa2bf4fab05cfaf75f304069904d362` |
| `store:manifest-BINANCE-ZRO.json` | `f4be35d043ff89e2e6b8216eee99315d68d3a59a8f4a5300547db49494867b8c` |
| `store:manifest-BINANCE-ICP.json` | `7b5cc8bf6a3d59b45b1f5469125d5324c1c3410b122b0c109b016263fe0e6052` |
| `store:manifest-BINANCE-ETHFI.json` | `780d44d586ebe690ae3e4c1c55828060ce7dcf7bf25b21d830619b65f5034561` |
| `store:manifest-BINANCE-DOT.json` | `5d2bc17a445bea9d93fcd95b379ff3a93928e0f3b8dc1dfc16c2c514bb8132df` |
| `store:manifest-BINANCE-FET.json` | `14fe7b105c926eacb4686cbde6ad12226c3f45f068d970bf61c1f068bee45930` |
| `store:manifest-BINANCE-HBAR.json` | `297d12470daf3ab2d5e18c5fd1c16552a5018b1452c5735640226021395fb4ac` |
| `store:manifest-BINANCE-DASH.json` | `1e52c99ccd520d759dec149ae44634cf991f50b9602975a5d5fb3f57202a11d4` |
| `store:manifest-BINANCE-PENGU.json` | `3905860124553322eb0b7d52ee08c842c243e58f71e5f18270d76ef2ccdcc0ca` |
| `store:manifest-BINANCE-TRX.json` | `39414a10faccbd94850fd5b082a63a638f6dc3a8632a285b72a4c1403b2091d4` |
| `store:manifest-BINANCE-APT.json` | `ebc35eb0984f8887830a1db042f7e7a9525ab67afae2f78b9da59efe4a1b0b12` |
| `store:manifest-BINANCE-SHIB.json` | `1f5181053540c805b83dd861f5d16dd860d42a3efeaecd8478db575a49673627` |
| `store:manifest-BINANCE-TIA.json` | `bb7afe57d6a3b903dc4f6feb8afa6634934eb04a0c807ed3c1d1dfa62182d5f3` |
| `store:manifest-BINANCE-AERO.json` | `445f264fcf5e13208ae7fd9712db66b600ed2a6ebe926ae55a16d91d1d6f04d2` |
| `store:manifest-BINANCE-PYTH.json` | `f971f1f5e37cb14c107740a46c17b9a0da3d5bb05167f4db0264516dad9a5b35` |
| `store:manifest-BINANCE-OP.json` | `345ae28b6ad47575a06f794ae358d29d76453a56131c25a4907a98538a207cd3` |
| `store:manifest-BINANCE-STRK.json` | `895b094fa9244bff8ad93e7baf9eb2560708ab4da57814276759c78ea358a6d5` |
| `store:manifest-BINANCE-CRV.json` | `fdb88f3406e7e13978944506209628c7041d8679c5524d7eb77dcfe5699b613f` |
| `store:manifest-BINANCE-FARTCOIN.json` | `c939d1650b10684f271baf8cfec55046ae03f8b9b59f6d725c019fac0ded620b` |
| `store:manifest-BINANCE-JUP.json` | `869547bb673b767f8b3afdc488f10df6871eefd9497a1f8306745e82172dd9db` |
| `store:manifest-BINANCE-CYBER.json` | `988cd374aa83271513b79fc09558ca07f4cb5eaeff7ce9bfab7afb22c431d813` |
| `store:manifest-BINANCE-ETC.json` | `908977dd99e6f4e0f12ad905849b55e53ba74e80625595e3cd13c1bea186705a` |
| `store:manifest-BINANCE-BONK.json` | `aec553fd812db02a90cbfbe18b3bf1548b14602d589cbf17e985343d2bf3f331` |
| `src/scripts/sr-backtest/fetch-store.ts` | `597f3230611ae80b5938536c30c61dc42e55f40368b39789503139210e19e429` |
| `store:panel.json` | `c32689e9ec556342a0408835f76d8d8a8433f577e6d4786727d223a51b949ffa` |
| `skeleton:skeleton.csv` | `fbf30ac3c325be017317349e435cbf94fc482e6bb1f708a53ddec40fdd168ed4` |
| `skeleton:sides.json` | `59235e432990e35707bb70addae073e9d3330731eb2f077f54be86f5dd2a2bb8` |

The 50 `store:manifest-BINANCE-<COIN>.json` rows are the coins' candle-store manifests (per series: range, bar count, sha256; failures listed). `store:panel.json` is the panel file of the listing probe (§2). The two `skeleton:` rows are the label-free run that §5 was computed from.

Who enforces what. The outcome guard refuses, coin by coin, unless the first 18 rows (`HTF_PINNED`) and that coin's store manifest match byte for byte. The test suite checks on every run that each file of `HTF_PINNED`, `calibration.json` and each of the 50 manifests has a pin here, and that every pinned file except the two shared statistics libraries equals the checkout (§8, correction 13). `fetch-store.ts`, the panel file and the skeleton rows are a record of how the store and §5 were made; nothing reads them at the outcome. The closed study's files among the first rows carry the sha256 its own registration's §10 pins: they are unchanged.
