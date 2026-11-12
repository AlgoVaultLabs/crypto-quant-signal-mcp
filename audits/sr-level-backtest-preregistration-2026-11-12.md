# EDGE-SR-LEVEL-BACKTEST-W1 — pre-registration: do our served S/R zones bounce more often than matched random zones on Binance?

Written 2026-11-12 (UTC), before any outcome read. Internal META research: zero public surface, zero scoring or serving change, nothing shipped, no edge or accuracy claim, no tuning after data. This file carries methodology and label-free cardinalities only; every outcome figure on real candles goes to the private vault and never into this repository. The figures quoted from the null calibration are from seeded synthetic random walks, not from market data.

Procedure: `audits/PREREGISTRATION-PROCEDURE.md` §1–§9. Wave spec: `Prompt/EDGE-SR-LEVEL-BACKTEST-W1.md` (planning vault). Arc: `ARC-SR-LEVEL-CHECK`, task T1.

## 0. What is tested, in one paragraph

A frozen zone rule (Z1, §4.2) turns the closed candles of one coin and one timeframe into support and resistance zones, and serves the nearest three on each side of the price. The one primary question (V1) is whether a served zone that price goes on to enter is left again by a bounce more often than a zone of the same ATR distance and width laid where the rule sees no zone (the control, §4.5), by at least +3.0pp, on 50 Binance USDT perpetuals over 365 days and four timeframes (15m, 1h, 4h, 1d). Four secondary tests ask whether the labels order the zones (V2), whether the rule beats three free level sets (V3), whether a take-profit before a zone and a stop beyond one behave better than the same orders where no zone is (V4), and which definition of "broken" follows through (V5). Every outcome is a hit-first path label read off 15-minute candles; none is a PnL. The corpus, the grid, the control, the statistic and the verdict are fixed here; the outcome step refuses to run until this file is on `origin/main` and the code and candles on disk are the ones pinned in §10.

## 1. Ordering (PROCEDURE §1)

- This file lands on `origin/main` before any bounce, break or hit is computed on real candles. The outcome step (`npx tsx src/scripts/sr-backtest/run.ts --outcomes …`) calls `checkOutcomeGuard` first and refuses, reason named, unless: the registration path is readable at `origin/main` after a fresh fetch; the commit that last touched it is an ancestor of `origin/main`; every file in `PINNED_FILES` is byte-equal to its sha256 in §10; the store manifest's sha256 equals the pin `store:manifest-BINANCE.json`; the manifest re-derived from the candle files equals the manifest file; and the manifest lists no failed series. The pins are read from the file as it stands on `origin/main`, never from the working tree. `tests/unit/sr-backtest-harness.test.ts` proves the refusal both ways.
- `registration_landed_at` is the first `date -u` at which this file's commit is seen on `origin/main` (not the committer time). `outcome_read_at` is the outcome run's start time. `sr_backtest.py --analyze` refuses unless the first is strictly before the second, to the second.
- Before this file landed, only the reads in §2 were made. The label-free run (`run.ts --skeleton`) executes the same engine with `outcomes: false`: it builds zones, served sets and control placements and counts them; it resolves no entry, bounce, break, timeout, take-profit or stop. Its output columns that would hold an outcome are zero.
- Everything an outcome could bias is pinned in §10 by sha256: the level rule, the zone rule, the engine, the store reader, the guard, the runner, the estimator, the two shared statistics libraries, the store manifest, the calibration artifact and the parity fixture.

## 2. Prior-examination disclosure (PROCEDURE §2)

| what was seen | when (UTC) | class |
|---|---|---|
| Binance 24h ticker: quote volume per USDT perpetual, used once to order the panel candidates | 2026-11-12T11:07:38Z | seen — not a test input |
| The candle store being filled: per series the range, the bar count, the sha256, the pages read; candidates accepted or rejected for missing bars | 2026-11-12T11:07Z – 12:02Z | coverage ratio |
| Label-free skeleton runs on the store: counts of served zones and control placements per arm, timeframe, UTC day and coin; forced-control counts; side counts. A first run at about 12:06Z used an earlier build and is superseded; the registered counts are the second run's | 2026-11-12T12:39:07Z – 12:40:13Z | cardinality |
| `sr_backtest.py --cardinalities` on that skeleton, and ad-hoc sums of its `served` column (per coin, per timeframe side share, joint presence of two arms on a day) | 2026-11-12T12:40Z – 12:53Z | cardinality |
| `sr_backtest.py --power` on that skeleton: simulated outcomes drawn on the real label-free counts (§5) | 2026-11-12T12:44:00Z – 12:46:23Z | cardinality |
| Seeded synthetic random walks through the whole harness: known answers, the mirror property, the null calibration (100 replications), the half-width mutation, and development measurements of candidate control rules (§4.5) | 2026-11-12, before the store was read by the harness and after | seen — not a test input |
| End-to-end runs of the outcome step and the analysis on a synthetic store (the guard, the refusals, the report shape) | 2026-11-12 | seen — not a test input |
| EDGE-SR-LEVEL-PROBE-W1 (2026-11-11): `SR_PROBE_VERDICT=NULL` on emitted calls — a different corpus (calls, four venues, 27 days) and a different estimand (excess of CLEAR over OPPOSING calls); no bounce, break or hit rate of a zone was computed there | 2026-11-11 | inherited |
| The arc's research note (`Prompt/ARC-SR-LEVEL-CHECK-research-0.md` §4): the proposed tests and pass bars this file freezes | 2026-11-12 | inherited |

Two disclosures about the label-free counts. (1) A control's placement reads prices and zones at instants later than the served instant, because the control sits later in time (§4.5); the forced-control counts are therefore a property of the later path. They are not a bounce, break or hit statistic, and no parameter was chosen from them. (2) Whether a zone is entered is itself a path label, so it was not counted: every presence figure below uses served zones, an upper bound on entered events.

No boundary ratio was examined: no rate of entry, bounce, break, timeout, take-profit or stop exists for any real candle anywhere before the read.

## 3. Corpus — literal predicate, closed by a clock (PROCEDURE §3)

**The clock.** `endMs` = 2026-11-12T00:00:00Z (1794441600000), the last UTC midnight before the candles were read; every bar in the store closed at or before it. `startMs` = `endMs` − 365 days = 2025-11-12T00:00:00Z (1762905600000). The hold-out is the last 92 days by date: UTC days from 2026-08-12 (1786492800000) on. Each series also holds 300 warm-up bars of its own timeframe before `startMs`.

**The panel.** Source: Binance `/fapi/v1/ticker/24hr` through the adapter's `getTicker24hrFullCoalesced`, as of 2026-11-12T11:07:38.548Z. Rule: symbols matching `^[A-Z0-9]+USDT$`, mapped to the adapter's coin names; stablecoin, metal and index bases excluded by the list in `src/scripts/sr-backtest/fetch-store.ts`; ordered by 24h quote volume, descending; walked in that order; a candidate joins when all four of its series hold every planned bar (window plus warm-up); the walk stops at 50. Result: 746 candidates; the first 153 were walked; 50 joined; 103 were rejected, every one for missing daily bars (the daily series needs 665 bars, a listing since about 2025-01-16); 593 were not walked. The plan file records each candidate's fate.

The 50 coins, in volume order: BTC, ETH, ZEC, SOL, XRP, PEPE, NEAR, DOGE, BNB, UNI, ENA, SUI, AVAX, ADA, LINK, AAVE, ONE, WLD, INJ, TAO, XMR, ARB, QNT, LTC, XLM, FIL, ONDO, BCH, ZRO, ICP, ETHFI, DOT, FET, HBAR, DASH, PENGU, TRX, APT, SHIB, TIA, AERO, PYTH, OP, STRK, CRV, FARTCOIN, JUP, CYBER, ETC, BONK.

**Survivorship, disclosed.** The panel is chosen on volume at the END of the window and on a full history, so it holds coins that were listed for at least 665 days and are liquid now. Coins delisted during the window, and the 103 higher-volume recent listings (mostly tokenized-equity perpetuals), are absent. The result speaks for these 50 coins over this window; it is not a claim about a coin picked at the start of the window.

**The store.** 200 series (50 coins × 4 timeframes), 0 failed, 2,377,750 bars: per coin 35,340 bars of 15m, 9,060 of 1h, 2,490 of 4h and 665 of 1d. Read through `getAdapter('BINANCE').getCandles` under `runAsCaller('sr-level-backtest', …)` on the operator's machine, into a directory outside the repository and the vault. The manifest (per series: range, bars, sha256; failures listed) is pinned in §10.

**The grid — the literal predicate.** For each panel coin and each timeframe, the instants are `t = startMs + n × stride` for n = 0, 1, 2, … while `t + horizon ≤ endMs`. A row is a served zone of one source at one instant whose timeframe has an ATR14.

| timeframe | stride (15m units) | stride | horizon (bars of the timeframe) | instants per coin | last instant (UTC) | of which in the hold-out |
|---|---|---|---|---|---|---|
| 15m | 13 | 3 h 15 m | 144 | 2,685 | 2026-11-10T11:00Z | 669 |
| 1h | 49 | 12 h 15 m | 144 | 704 | 2026-11-05T19:45Z | 169 |
| 4h | 221 | 55 h 15 m | 144 | 149 | 2026-10-18T17:00Z | 30 |
| 1d | 1,181 | 12 d 7 h 15 m | 72 | 24 | 2026-08-21T22:45Z | 1 |

The stride is one entry window (12 bars of the timeframe) plus an offset of 1, 1, 29 and 29 fifteen-minute units, so entry windows never overlap, and each stride is coprime with 96 and with the timeframe's own length, so the instants rotate through the UTC day and through every position inside the timeframe's bar. The horizon is the control's lag and window plus the longest label (§4.5, §4.4). In all: 3,562 instants per coin and 178,100 instants; the label-free run tallies their served zones and entries into 950,449 counts of arm × timeframe × UTC day × coin.

**Coverage, two denominators.** Of the planned series: 200 of 200 complete. Of the planned grid instants: 178,100 of 178,100 evaluated. Of the served zones: every one has a control (847,562 of 847,562 for Z1), 10,253 of them forced (§4.5). Nothing is dropped by name; the events the estimator cannot use are named in §4.7 (a zone never entered; a cell-day under the minimum).

## 4. Methodology

### 4.1 The wave spec's zone rule, tests, control, estimand, verdict and decision map — quoted

The words are the spec's. Its tests table is set here as a list: test — measure — pass bar.

> **Zone rule Z1 (frozen in the registration)**
> - Level v0 imported, never edited: `asOfBars`, `pivotPrices` (k 3), `wilderAtr` (14), `layerLevels`, `V0` — closed bars, last 300, merge ≤ 0.25·ATR14, qualifying = touches ≥ 2.
> - Timeframes 15m · 1h · 4h · 1d, each served for BINANCE (R0: `resolveVenueInterval` / `servedTimeframesOf`, `src/lib/adapters/_interval.ts`).
> - Registered before any outcome read: zone = cluster [min, max] floored to an ATR width; W/M/S cut points (as-of strength only); Super Strong = overlap with a qualifying zone on another chosen timeframe at the same instant (pairs, triple); served set = nearest ≤ 3 supports below, ≤ 3 resistances above; round-number grid; break-rule candidates and how V5 picks one.
> - Pure module `src/scripts/sr-backtest/zones.ts`, exported for T2.
>
> **Tests (research §4; the registration fixes N, k, buffer, panel, windows, seeds)**
> Outcomes: hit-first path labels on candles, never PnL; every test three-state.
> - V1 primary — served zone first entered within N bars: bounce (out by k·ATR before 2 closes beyond) vs break; same on its control — Δ ≥ +3.0pp; 95% LB > 0, UTC-day and coin clusters; positive on hold-out
> - V2 labels — bounce by label — Strong − Weak ≥ +2.0pp; Super Strong ≥ Strong
> - V3 free versions — V1 on floor pivots, previous-day high/low, round numbers — ours ≥ best + 1.0pp
> - V4 TP / stop — seeded entries, both sides: (a) TP before the next opposing zone hit before the stop; (b) stop beyond zone + buffer hit, then price recovers; each vs control — (a) ≥ +3.0pp; (b) ≤ −3.0pp
> - V5 break rule — next zone reached after a 2-close vs 1-close break — reported; picks "broken" by the registered rule
>
> - **Control = MATCHED_CONTROL** (control counts supplied): same coin, timeframe, side, UTC day, ATR distance and width, at a seeded other instant, disjoint from every qualifying zone then (same instant + distance = the tested zone). Δ zero by construction — AC1.4.
> - **Estimand:** Δ = bounce(served) − bounce(control); daily Δ per timeframe cell → scored-weighted mean over cells present → `cluster_bootstrap_ols` intercept, UTC-day clusters, B 2000, seed registered; again on coin clusters. V2–V4 under BH-FDR q 0.10 (`bh`).
> - **SR_BACKTEST_VERDICT:** PASS = V1's bar · NULL = UTC-day upper bound < +3.0pp (a reversal named) · INDETERMINATE = else, cause named (< 20 clusters, NOT_IDENTIFIABLE arm, hold-out sign flip, interval holding +3.0pp with LB ≤ 0) and what resolves it.
> - **Decision map** (into the registration): V1 not PASS → arc closes. V2 fails → no W/M/S words. V4 fails → no TP/stop ideas. V3 fails → simpler rule considered. The last three go to Mr.1 (arc Extra gate) and never change V1.
> - **Panel/windows:** ~50 Binance USDT perps by quote volume (rule, source, as-of registered; survivorship disclosed); ~12 months of closed bars ending before the registration commit, plus 300-bar warm-up; hold-out = last ~3 months by date; grid stride registered.

The sections below fix how each line is read. Where they differ from the wording above, they are the registered reading; the differences are listed as corrections in §8, and the one that matters is the control (§4.5).

### 4.2 Zone rule Z1, as frozen (`src/scripts/sr-backtest/zones.ts`)

- **As-of cut.** Level v0's `asOfBars`: only bars of the timeframe that have closed by the instant, the last 300 of them. The bar in progress is never visible.
- **Clusters.** Level v0's `pivotPrices` (k = 3: a bar whose high, or low, is the extreme of the 3 bars either side) and `layerLevels` (single-link: two neighbouring pivot prices join when their gap is at most 0.25 × ATR14, Wilder's ATR of the as-of bars). Z1 adds no second clustering; it reads each cluster's extent off the sorted pivot prices using the touch counts `layerLevels` returns.
- **Zone.** The cluster's [min, max], widened about its centre to at least 0.25 × ATR14. A cluster wider than that keeps its own extent.
- **Qualifying.** Touches (pivots in the cluster) ≥ 2.
- **Labels — the as-of touch count only.** WEAK = 2 touches, MEDIUM = 3, STRONG = 4 or more. Nothing after the instant enters a label.
- **Round flag.** The zone holds a multiple of 10^(⌊log10 level⌋ − 1), where level is Level v0's price for the cluster: a price with at most two significant digits. Descriptive only.
- **Served set.** Per timeframe: the nearest ≤ 3 qualifying zones wholly below the price (supports, rank 1 = nearest) and the nearest ≤ 3 wholly above it (resistances). A zone that holds the price is reported as `at` and is neither.
- **Super Strong.** A served zone that overlaps (closed intervals: a shared edge counts) a qualifying zone of another chosen timeframe at the same instant: PAIR with one agreeing timeframe, TRIPLE with two or more. In this backtest all four timeframes are chosen, so a zone is checked against the other three (§8, correction 5).
- **Price at an instant.** The close of the 15-minute bar that ends there.

Timeframes: 15m, 1h, 4h, 1d — each a natively served BINANCE interval (`src/lib/adapters/_interval.ts`).

### 4.3 The clock and the path

One 15-minute series per coin is the clock and the path for every timeframe. An instant is a 15-minute boundary; a timeframe's zones come from that timeframe's own closed bars as of the instant; every outcome is read off the 15-minute bars that follow. A 15-minute bar's high and low are unordered and its close is last; the rules below resolve every tie the same way for a served zone and for its control.

### 4.4 V1's path label (`resolveZone`)

N = 12 bars of the zone's timeframe, M = 12 bars of the timeframe, k = 1.0 ATR14 of the timeframe at the instant.

- **Entered.** The first 15-minute bar, among those opening in the N timeframe bars after the instant, whose low is at or under the zone's top (support) or whose high is at or over its bottom (resistance). A zone never entered has no outcome and is not scored.
- **Bounce.** Price is back out of the zone by k ATR from its near edge: for a support, at or over top + k × ATR. On the entry bar only the close can bounce (its high may have come before the entry); on later bars the high (the low, for a resistance) counts.
- **Break.** 2 consecutive closes of the timeframe strictly beyond the zone's far edge; a close back resets the count.
- **Order inside a bar.** The bounce is checked before the close, so a bar that both bounces and closes the break is a bounce.
- **Timeout.** Neither within M timeframe bars after the entry bar (inclusive).

The bounce share of an arm is bounces ÷ entered. Breaks and timeouts are both "not a bounce"; they are reported apart.

### 4.5 The control — and the correction to the wave spec's wording

**The registered rule.** For a served zone at instant t, with price p and ATR a, the control is the same side, the same distance from the price in ATR and the same width in ATR, re-laid from the price and ATR of a later instant t2 of the same coin and timeframe. The candidates are t2 = t + j bars of the timeframe, j = 13 … 108 (15m, 1h, 4h) or 13 … 36 (1d), tried in time order. The control is the first candidate at which the re-laid zone overlaps no qualifying zone of that timeframe and source as of t2. If no candidate is free, the control is the last candidate all the same, flagged `forced`. Every served zone has exactly one control; none is dropped; no random draw is involved. The control's label is read by the same `resolveZone`, from t2, with the ATR of t2.

**Why it differs from the wave spec.** The spec words the control as "same UTC day … at a seeded other instant", implying that a served zone with no free instant is unmatched. That control is not zero by construction, and AC1.4 is the test that showed it. On driftless random walks, where no zone can carry information, the difference must be zero; measured there during development (40 replications each, the same walks as §4.9, not committed):

| control rule | mean Δ on driftless walks (pp) |
|---|---|
| the spec's wording: a seeded other instant of the same UTC day, before or after; unmatched zones dropped | −1.5 to −2.6 across the variants tried |
| later instants only, a seeded pick among the free ones; unmatched zones dropped | about −0.76 ± 0.15 |
| later, a seeded pick at any position inside the timeframe's bar; never dropped | about −0.17 ± 0.08 (the 1d cell −0.81) |
| the registered rule (100 replications, committed: `scripts/sr-backtest/calibration.json`) | −0.10 ± 0.08 |

Three rules remove the three biases, and each is in the code as a stated invariant:

1. **Later, never earlier.** A control placed before t has its outcome read on the very path that went on to form the served zone. The lag is the entry window (12 bars), so the control's clock starts after the served zone's own entry window has closed.
2. **In time order, the first free candidate.** Whether a candidate is free is known at that candidate. Picking among free candidates by any other order lets a later candidate's state choose an earlier one.
3. **Never dropped.** A served zone with no free candidate keeps the last one. Dropping it would select the served arm on the path after t: price that runs away from its zones leaves room for a control, price that stays among them does not.

The candidates sit a whole number of timeframe bars after t, so both arms read zones of the same age and face the same sequence of timeframe closes.

**What "same UTC day" means now.** A served zone and its control are tallied to the UTC day of the served instant t. The control's own instant is later by at most 27 hours (15m), 4.5 days (1h), 18 days (4h) or 36 days (1d). Neighbouring day clusters therefore share path; §5 and the stress-test table say what that does to the interval.

**Forced controls.** A forced control overlaps a qualifying zone, so it is partly a zone itself and pulls Δ toward zero. It is kept because dropping it is worse (rule 3); its share is registered per arm in §5 and reported at the read.

**Half-width mutation.** A control laid at half the served zone's width is entered less often and bounces differently; the calibration then fails (`controlWidthMult` 0.5: mean Δ over +0.5pp, verdict FAIL). The test suite runs it.

### 4.6 V2–V5, as frozen

- **V2a — Strong minus Weak.** Δ of the STRONG served zones minus Δ of the WEAK ones, each against its own controls. Floor +2.0pp.
- **V2b — Super Strong against Strong.** Δ of the served zones with at least one agreeing timeframe (PAIR or TRIPLE, any label) minus Δ of the STRONG zones with no agreeing timeframe. The two arms are disjoint. Floor 0.0pp: PASS needs the difference above zero, lower bound > 0.
- **V3 — free versions.** Three free level sets go through the same served rule, the same control rule (free of that set's own zones) and the same label: classic floor pivots of the last closed day (P, R1–R3, S1–S3); the previous day's high and low; the multiples of 10^(⌊log10 price⌋ − 1) within four steps of the price. Each line becomes a zone 0.25 × ATR14 of the timeframe wide; overlapping ones merge. The comparator is the one of the three with the highest UTC-day point estimate on the full window — picking the largest of three noisy estimates leans against our zones. The statistic is Δ(Z1) − Δ(comparator). Floor +1.0pp.
- **V4 — entries at the grid instants, long and short, against the rank-1 zone each way.** The spec's "seeded entries" are the registered grid (§3); nothing is drawn. Buffer = 0.25 ATR; race window = 24 bars of the timeframe; recovery window = 12 bars.
  - **(a) take-profit.** The take-profit sits 0.25 ATR before the near edge of the opposing rank-1 zone (a long's resistance, a short's support); the stop sits the same distance the other way. An entry with a take-profit distance of zero or less is not made. Hit = the take-profit is touched first within the race window; a bar touching both is the stop. Control: the same race with the same ATR distances at the control instant of that opposing zone. Statistic: hit share (served) − hit share (control). Floor +3.0pp.
  - **(b) stop.** The stop sits 0.25 ATR beyond the far edge of the protecting rank-1 zone (a long's support, a short's resistance). Hit = the stop is touched within the race window and price is back at the entry within the recovery window (the stop bar's own close, or any later bar's range). Control likewise. The spec's "≤ −3.0pp" is registered as control − served ≥ +3.0pp: the stop beyond our zone is knocked out and recovered less often.
  - The denominator is every entry made, so a V4 cell-day's presence is known before the read.
- **V5 — which break follows through.** Among entered served Z1 zones with a next qualifying zone beyond the far edge: after the first timeframe close beyond the zone (1-close break), and after the close that completes V1's break (2-close break), is that next zone reached within 12 timeframe bars before a timeframe close back on the original side? Statistic: follow-through share after a 1-close break minus after a 2-close break, per cell-day with at least 30 breaks of each kind. Rule: "broken" is the 2-close rule unless the UTC-day lower bound is above zero, in which case it is the 1-close rule. Fewer than 20 day clusters: INDETERMINATE, and the 2-close rule stands.

### 4.7 The statistic (`scripts/sr-backtest/sr_backtest.py`)

- **Cell.** A timeframe. **Cluster.** A UTC day (of the served instant), and separately a coin.
- **Presence.** A (cell, cluster) is present for an arm pair only when the served arm and the control arm each hold at least 30 entered events there. An absent cell is absent, never zero; the count of absent cells is reported.
- **Δ in a cell and cluster.** 100 × (bounces ÷ entered, served) − 100 × (bounces ÷ entered, control). Weight = entered served + entered control.
- **Per cluster.** The weighted mean of Δ over the cells present.
- **Interval.** `cluster_bootstrap_ols` (`src/scripts/cluster-perm-stats.py`), intercept only, one observation per cluster, B = 2000, seed `arm_seed('EDGE-SR-LEVEL-BACKTEST-W1', name)` with `name` = `V1-day`, `V1-coin`, `V2a-day`, … — one seed per statistic and cluster kind. 95% percentile interval. One-sided p = the share of draws at or under zero.
- **Hold-out.** The mean of the daily values on UTC days from 2026-08-12 on.
- **V2–V4.** Benjamini–Hochberg (`bh`) at q = 0.10 over the five UTC-day p-values V2a, V2b, V3, V4a, V4b.
- **Identifiability at the read.** The bound of §Identifiability is recomputed from the outcome run's own side counts through `declaration_identifiability` (`ops/monitoring/population_comparison.py`); an arm that is NOT_IDENTIFIABLE there makes its test INDETERMINATE.
- **Seeds.** Null calibration 20261112; parity fixture 20261112; bootstrap seeds as above. The real-data control uses no seed.
- **Descriptive only, deciding nothing:** Δ per timeframe cell; per label; per side; per rank; round flag on and off; PAIR-or-TRIPLE and TRIPLE; each free version; V4 long and short; rates of entry, bounce, break and timeout per arm; forced share.

### 4.8 Frozen values

The harness, the parity fixture and this file read these values from `src/scripts/sr-backtest/spec.ts` and `synth.ts`; `tests/unit/sr-backtest-harness.test.ts` fails if the block below stops matching them.

<!-- sr-backtest:frozen -->
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
 "timeframes": [
  {
   "key": "15m",
   "stepMs": 900000,
   "units": 1,
   "gridOffset": 1
  },
  {
   "key": "1h",
   "stepMs": 3600000,
   "units": 4,
   "gridOffset": 1
  },
  {
   "key": "4h",
   "stepMs": 14400000,
   "units": 16,
   "gridOffset": 29
  },
  {
   "key": "1d",
   "stepMs": 86400000,
   "units": 96,
   "gridOffset": 29
  }
 ],
 "study": {
  "windowDays": 365,
  "holdoutDays": 92,
  "warmupBars": 300,
  "panelSize": 50,
  "minArm": 30,
  "minClusters": 20,
  "bootstrapB": 2000,
  "fdrQ": 0.1,
  "floorV1": 3,
  "floorV2": 2,
  "floorV3": 1,
  "floorV4": 3
 },
 "calibration": {
  "replications": 100,
  "walks": 50,
  "warmupDays": 300,
  "evalDays": {
   "15m": 25,
   "1h": 25,
   "4h": 40,
   "1d": 240
  },
  "startMs": 1609459200000,
  "seed": 20261112
 }
}
```

`controlDisjoint` and `controlWidthMult` are test-only switches; the registered values are `true` and `1`. `lookaheadBars` exists only so a test can break the as-of cut; the registered value is `0`.

### 4.9 Behaviour with no effect: the null calibration (AC1.4)

100 seeded replications, each of 50 driftless integer random walks (15-minute bodies uniform on ±500 ticks, wicks uniform on 0–300, start 5,000,000; 58,848 bars per walk: 300 daily bars of warm-up, 240 evaluation days and the horizon), aggregated to 1h, 4h and 1d and run through the whole harness — zones, grid, control, labels, estimator, verdict. Evaluation days per timeframe: 25 (15m), 25 (1h), 40 (4h), 240 (1d). Result, committed as `scripts/sr-backtest/calibration.json` and reproduced from the seed by the test suite:

| quantity | value | bar |
|---|---|---|
| mean Δ over the 100 replications | −0.10pp (standard error 0.08pp) | within ±0.5pp |
| share of replications with `SR_BACKTEST_VERDICT=PASS` | 0.00 | ≤ 0.05 |
| standard deviation of one replication's Δ (48 day clusters, 50 independent walks) | 0.80pp | — |
| share of replications whose 95% interval excludes zero | 0.07 | — (nominal 0.05) |
| mean V4a statistic · mean V4b statistic | −0.04pp · −0.02pp | — |
| share of served zones entered · of controls entered | 0.43 – 0.44 in every cell · the same | — |

The 100 verdicts: 99 NULL and 1 INDETERMINATE. The interval is slightly anti-conservative for zero (0.07 against 0.05); PASS also needs the point at +3.0pp, the coin-cluster bound and the hold-out sign, and no replication passed.

## 5. Floors and power (PROCEDURE §5)

**Cluster floors.** 20 UTC-day clusters and 20 coin clusters (`minClusters`). Never a row floor: the 30-per-arm minimum decides whether a cell is present in a cluster, not whether a test is read.

**Label-free cardinalities** (`python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`; skeleton sha256 in §10). "Days at ≥ 75 served" is the proxy for presence: at the 0.43 entry share of the synthetic walks, 75 served zones give about 32 entered. The real entry share is an outcome and is not known.

| arm | cell | served zones | forced controls | forced share | UTC days | days at ≥ 30 served | days at ≥ 75 served | hold-out days at ≥ 75 |
|---|---|---|---|---|---|---|---|---|
| floor | 15m | 760,641 | 0 | 0.00% | 364 | 364 | 364 | 91 |
| floor | 1h | 199,327 | 0 | 0.00% | 359 | 359 | 359 | 86 |
| floor | 4h | 41,700 | 0 | 0.00% | 149 | 149 | 149 | 30 |
| floor | 1d | 5,710 | 406 | 7.11% | 24 | 24 | 24 | 1 |
| pdhl | 15m | 265,761 | 0 | 0.00% | 364 | 364 | 364 | 91 |
| pdhl | 1h | 68,899 | 0 | 0.00% | 359 | 359 | 359 | 86 |
| pdhl | 4h | 14,224 | 0 | 0.00% | 149 | 149 | 149 | 30 |
| pdhl | 1d | 1,999 | 0 | 0.00% | 24 | 24 | 22 | 1 |
| rnd | 15m | 805,476 | 33 | 0.00% | 364 | 364 | 364 | 91 |
| rnd | 1h | 211,056 | 208 | 0.10% | 359 | 359 | 359 | 86 |
| rnd | 4h | 44,154 | 1,148 | 2.60% | 149 | 149 | 149 | 30 |
| rnd | 1d | 5,226 | 1,820 | 34.83% | 24 | 24 | 24 | 1 |
| v4a | 15m | 190,831 | 2,455 | 1.29% | 364 | 364 | 364 | 91 |
| v4a | 1h | 49,763 | 479 | 0.96% | 359 | 359 | 349 | 84 |
| v4a | 4h | 10,544 | 110 | 1.04% | 149 | 149 | 47 | 10 |
| v4a | 1d | 1,666 | 62 | 3.72% | 24 | 24 | 8 | 1 |
| v4a.long | 15m | 97,289 | 1,186 | 1.22% | 364 | 364 | 364 | 91 |
| v4a.long | 1h | 25,740 | 194 | 0.75% | 359 | 350 | 180 | 45 |
| v4a.long | 4h | 5,496 | 33 | 0.60% | 149 | 130 | 0 | 0 |
| v4a.long | 1d | 980 | 29 | 2.96% | 24 | 24 | 0 | 0 |
| v4a.short | 15m | 93,542 | 1,269 | 1.36% | 364 | 364 | 364 | 91 |
| v4a.short | 1h | 24,023 | 285 | 1.19% | 359 | 348 | 132 | 39 |
| v4a.short | 4h | 5,048 | 77 | 1.53% | 149 | 116 | 0 | 0 |
| v4a.short | 1d | 686 | 33 | 4.81% | 24 | 14 | 0 | 0 |
| v4b | 15m | 237,177 | 3,110 | 1.31% | 364 | 364 | 364 | 91 |
| v4b | 1h | 62,181 | 636 | 1.02% | 359 | 359 | 359 | 86 |
| v4b | 4h | 13,056 | 149 | 1.14% | 149 | 149 | 126 | 25 |
| v4b | 1d | 2,072 | 87 | 4.20% | 24 | 24 | 19 | 1 |
| v4b.long | 15m | 116,413 | 1,598 | 1.37% | 364 | 364 | 364 | 91 |
| v4b.long | 1h | 30,212 | 377 | 1.25% | 359 | 352 | 276 | 68 |
| v4b.long | 4h | 6,304 | 99 | 1.57% | 149 | 130 | 0 | 0 |
| v4b.long | 1d | 891 | 46 | 5.16% | 24 | 19 | 0 | 0 |
| v4b.short | 15m | 120,764 | 1,512 | 1.25% | 364 | 364 | 364 | 91 |
| v4b.short | 1h | 31,969 | 259 | 0.81% | 359 | 354 | 312 | 70 |
| v4b.short | 4h | 6,752 | 50 | 0.74% | 149 | 140 | 0 | 0 |
| v4b.short | 1d | 1,181 | 41 | 3.47% | 24 | 24 | 0 | 0 |
| z1 | 15m | 639,690 | 7,858 | 1.23% | 364 | 364 | 364 | 91 |
| z1 | 1h | 167,593 | 1,816 | 1.08% | 359 | 359 | 359 | 86 |
| z1 | 4h | 34,909 | 372 | 1.07% | 149 | 149 | 149 | 30 |
| z1 | 1d | 5,370 | 207 | 3.85% | 24 | 24 | 24 | 1 |
| z1.M | 15m | 127,235 | 48 | 0.04% | 364 | 364 | 364 | 91 |
| z1.M | 1h | 33,852 | 2 | 0.01% | 359 | 359 | 302 | 75 |
| z1.M | 4h | 7,041 | 1 | 0.01% | 149 | 142 | 0 | 0 |
| z1.M | 1d | 1,281 | 10 | 0.78% | 24 | 24 | 1 | 0 |
| z1.S | 15m | 276,789 | 7,782 | 2.81% | 364 | 364 | 364 | 91 |
| z1.S | 1h | 70,311 | 1,812 | 2.58% | 359 | 359 | 353 | 85 |
| z1.S | 4h | 14,357 | 371 | 2.58% | 149 | 149 | 114 | 22 |
| z1.S | 1d | 1,708 | 193 | 11.30% | 24 | 24 | 12 | 1 |
| z1.S0 | 15m | 52,607 | 463 | 0.88% | 364 | 363 | 328 | 72 |
| z1.S0 | 1h | 3,906 | 10 | 0.26% | 358 | 10 | 0 | 0 |
| z1.S0 | 4h | 1,177 | 0 | 0.00% | 146 | 1 | 0 | 0 |
| z1.S0 | 1d | 421 | 27 | 6.41% | 24 | 2 | 0 | 0 |
| z1.SS | 15m | 468,895 | 7,376 | 1.57% | 364 | 364 | 364 | 91 |
| z1.SS | 1h | 148,539 | 1,805 | 1.22% | 359 | 359 | 359 | 86 |
| z1.SS | 4h | 29,921 | 372 | 1.24% | 149 | 149 | 149 | 30 |
| z1.SS | 1d | 3,452 | 177 | 5.13% | 24 | 24 | 24 | 1 |
| z1.SSS | 15m | 229,626 | 4,731 | 2.06% | 364 | 364 | 364 | 91 |
| z1.SSS | 1h | 82,494 | 1,563 | 1.89% | 359 | 359 | 359 | 86 |
| z1.SSS | 4h | 18,147 | 331 | 1.82% | 149 | 149 | 145 | 30 |
| z1.SSS | 1d | 1,704 | 111 | 6.51% | 24 | 23 | 10 | 0 |
| z1.W | 15m | 235,666 | 28 | 0.01% | 364 | 364 | 364 | 91 |
| z1.W | 1h | 63,430 | 2 | 0.00% | 359 | 359 | 357 | 85 |
| z1.W | 4h | 13,511 | 0 | 0.00% | 149 | 149 | 125 | 24 |
| z1.W | 1d | 2,381 | 4 | 0.17% | 24 | 24 | 19 | 1 |
| z1.r1 | 15m | 237,177 | 3,110 | 1.31% | 364 | 364 | 364 | 91 |
| z1.r1 | 1h | 62,181 | 636 | 1.02% | 359 | 359 | 359 | 86 |
| z1.r1 | 4h | 13,056 | 149 | 1.14% | 149 | 149 | 126 | 25 |
| z1.r1 | 1d | 2,072 | 87 | 4.20% | 24 | 24 | 19 | 1 |
| z1.r2 | 15m | 212,513 | 2,639 | 1.24% | 364 | 364 | 364 | 91 |
| z1.r2 | 1h | 55,662 | 624 | 1.12% | 359 | 359 | 358 | 85 |
| z1.r2 | 4h | 11,573 | 110 | 0.95% | 149 | 149 | 100 | 16 |
| z1.r2 | 1d | 1,770 | 68 | 3.84% | 24 | 24 | 11 | 1 |
| z1.r3 | 15m | 190,000 | 2,109 | 1.11% | 364 | 364 | 364 | 91 |
| z1.r3 | 1h | 49,750 | 556 | 1.12% | 359 | 359 | 353 | 84 |
| z1.r3 | 4h | 10,280 | 113 | 1.10% | 149 | 149 | 56 | 8 |
| z1.r3 | 1d | 1,528 | 52 | 3.40% | 24 | 24 | 3 | 1 |
| z1.res | 15m | 331,529 | 3,798 | 1.15% | 364 | 364 | 364 | 91 |
| z1.res | 1h | 88,734 | 706 | 0.80% | 359 | 357 | 350 | 82 |
| z1.res | 4h | 18,662 | 126 | 0.68% | 149 | 146 | 136 | 19 |
| z1.res | 1d | 3,491 | 107 | 3.07% | 24 | 24 | 24 | 1 |
| z1.rnd0 | 15m | 571,356 | 4,637 | 0.81% | 364 | 364 | 364 | 91 |
| z1.rnd0 | 1h | 132,926 | 631 | 0.47% | 359 | 359 | 359 | 86 |
| z1.rnd0 | 4h | 21,548 | 41 | 0.19% | 149 | 149 | 145 | 27 |
| z1.rnd0 | 1d | 1,882 | 18 | 0.96% | 24 | 24 | 14 | 1 |
| z1.rnd1 | 15m | 68,334 | 3,221 | 4.71% | 364 | 364 | 364 | 91 |
| z1.rnd1 | 1h | 34,667 | 1,185 | 3.42% | 359 | 358 | 276 | 70 |
| z1.rnd1 | 4h | 13,361 | 331 | 2.48% | 149 | 149 | 116 | 26 |
| z1.rnd1 | 1d | 3,488 | 189 | 5.42% | 24 | 24 | 24 | 1 |
| z1.sup | 15m | 308,161 | 4,060 | 1.32% | 364 | 364 | 364 | 91 |
| z1.sup | 1h | 78,859 | 1,110 | 1.41% | 359 | 357 | 342 | 85 |
| z1.sup | 4h | 16,247 | 246 | 1.51% | 149 | 140 | 122 | 30 |
| z1.sup | 1d | 1,879 | 100 | 5.32% | 24 | 23 | 13 | 1 |

Arms: `z1` all served Z1 zones · `z1.W`, `z1.M`, `z1.S` by label · `z1.SS` at least one agreeing timeframe · `z1.SSS` two or more · `z1.S0` STRONG with none · `z1.sup`, `z1.res` by side · `z1.r1`–`z1.r3` by rank · `z1.rnd1`, `z1.rnd0` round flag on and off · `floor`, `pdhl`, `rnd` the free versions (floor pivots, previous-day high and low, round numbers) · `v4a`, `v4b` the V4 entries, with `.long` and `.short`. A V4 row counts entries, not zones.

**Per coin.** Served Z1 zones per coin, minimum / median / maximum: 15m 12,475 / 12,763 / 13,400 · 1h 3,259 / 3,352 / 3,533 · 4h 646 / 696 / 755 · 1d 84 / 106 / 132. All 50 coins clear 75 served zones in every cell.

**Where the weight sits.** Of the 847,562 served Z1 zones, 75.5% are 15m, 19.8% are 1h, 4.1% are 4h and 0.6% are 1d. The cell-weighted mean is in effect a 15m and 1h read; the 4h cell is present on 149 days and the 1d cell on 24. Per-cell estimates are reported beside it and decide nothing.

**Power — instrument 1:** `python3 -I scripts/sr-backtest/sr_backtest.py --power <skeleton dir> --sims 400` (run 2026-11-12T12:44Z). V1's UTC-day leg on the real label-free counts with simulated outcomes: each served zone and each control entered with probability 0.45, the control bouncing with probability 0.55 and the served zone with 0.55 plus the injected difference; 400 simulations per difference; 400 bootstrap draws; the coin-cluster leg assumed to pass.

| injected Δ | mean estimate (pp) | spread of the estimate (pp) | PASS | NULL | INDETERMINATE |
|---|---|---|---|---|---|
| 0.0 | 0.00 | 0.11 | 0.00 | 1.00 | 0.00 |
| +3.0 | 3.00 | 0.12 | 0.48 | 0.02 | 0.50 |
| +4.0 | 4.00 | 0.13 | 1.00 | 0.00 | 0.00 |
| +5.0 | 5.00 | 0.11 | 1.00 | 0.00 | 0.00 |

**What that instrument cannot see.** It draws every event independently, so its spread (0.11–0.13pp) is a floor and its power a ceiling: it holds no market move shared by the coins of a day, and none of the path shared by neighbouring days (§4.5). **Instrument 2**, the null calibration (§4.9), carries the harness's own dependence but independent walks: 0.80pp at 48 day clusters, about 0.29pp if scaled by √(48/364). Real coins move together, so the realised spread will be wider than both; how wide is not knowable before the read.

**Reading at +3.0pp.** PASS needs the point itself at or over +3.0pp, so at a true difference of exactly +3.0pp PASS is at most about one half whatever the sample. With a realised standard error s of the UTC-day mean, and while 1.96 × s < 3.0, P(PASS) ≈ Φ((Δ − 3.0) ÷ s) (normal arithmetic, not an instrument run): at s = 0.5pp, 0.98 for a true +4.0pp; at s = 1.0pp, 0.84 for +4.0pp and 0.98 for +5.0pp; at s = 1.5pp, 0.75 for +4.0pp and 0.91 for +5.0pp. A true zero reads NULL when the upper bound is under +3.0pp: near certain at s ≤ 0.5pp, about 0.85 at s = 1.0pp, about one half at s = 1.5pp.

**The registered underpowered branch.** An interval that holds +3.0pp with its lower bound at or under zero is INDETERMINATE — underpowered, never a negative. So is a UTC-day result that passes while the coin-cluster lower bound is at or under zero.

## Support stress-test (PROCEDURE §4)

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| V1 UTC-day cluster floor | 20 UTC-day clusters | 364 UTC days carry at least 75 served Z1 zones in the 15m cell (359 in 1h, 149 in 4h, 24 in 1d) — an upper bound on entered events | inside — the entered counts are read at the outcome; under 20 present days is the registered INDETERMINATE |
| V1 coin-cluster floor | 20 coin clusters | 50 coins; the smallest holds 84 served Z1 zones in the 1d cell and 12,475 in the 15m cell | inside |
| V1 hold-out sign | UTC days from 2026-08-12 on | 91 hold-out days at ≥ 75 served in 15m, 86 in 1h, 30 in 4h, 1 in 1d | inside — the hold-out is a 15m / 1h / 4h read; the 1d cell reaches it on 1 day |
| cell-day minimum, both arms | 30 entered events per arm | entry is an outcome and was not counted; proxy 75 served: every Z1 cell-day reaches it (364 / 359 / 149 / 24) | inside — absent cell-days are counted and reported at the read |
| cell weights of the V1 mean | weight = entered served + entered control | served Z1 zones: 15m 75.5%, 1h 19.8%, 4h 4.1%, 1d 0.6% | floor — V1 is in effect a 15m / 1h read; per-cell estimates are descriptive; no cell is reweighted or dropped after the read |
| timeframe 1d as a cell | 24 instants per coin, stride 12.3 days | 5,370 served Z1 zones on 24 UTC days; 207 forced controls (3.85%) | floor — present, with 0.6% of the weight; it cannot move V1 alone |
| V2a, both labels present in a cell-day | 30 entered per arm in STRONG and in WEAK | days with both at ≥ 75 served: 364 (15m), 351 (1h), 96 (4h), 8 (1d) | inside for 15m / 1h / 4h; floor for 1d |
| V2b, both arms present in a cell-day | 30 entered per arm in Super Strong and in STRONG-with-no-agreement | days with both at ≥ 75 served: 328 (15m), 0 (1h), 0 (4h), 0 (1d); the second arm is 8.2% / 2.3% / 3.4% / 7.8% of served zones | floor — V2b is a 15m read on at most 328 days; the other cells are absent, never zero |
| Super Strong as a distinction | overlap with any of the other three timeframes | 73.3% (15m), 88.6% (1h), 85.7% (4h), 64.3% (1d) of served zones are PAIR or TRIPLE; 35.9% / 49.2% / 52.0% / 31.7% are TRIPLE | inside — the flag marks the majority of served zones; reported to Mr.1 with V2b whatever its state |
| V3, Z1 and each free version present | 30 entered per arm in each | days with both at ≥ 75 served: floor pivots 364 / 359 / 149 / 24 · previous-day high and low 364 / 359 / 149 / 22 · round numbers 364 / 359 / 149 / 24 | inside |
| V3, forced controls of the comparators | a control free of that set's own zones | forced share: floor pivots 0% (7.11% in 1d) · previous-day high and low 0% · round numbers 0.00% / 0.10% / 2.60% / 34.83% (1d) | inside — the round-number 1d cell holds 0.5% of that arm's zones; a forced control pulls that comparator's own Δ toward zero, which, if that Δ is positive, leans toward Z1 by at most that cell's weight; reported with V3 |
| V4a, entries per cell-day | 30 entries (every entry is scored) | days at ≥ 30 entries: 364 / 359 / 149 / 24 — known exactly before the read | inside |
| V4b, entries per cell-day | 30 entries (every entry is scored) | days at ≥ 30 entries: 364 / 359 / 149 / 24 — known exactly before the read | inside |
| V5, breaks per cell-day | 30 breaks of each kind | a break is an outcome; no count exists before the read | floor — the presence rule is 30 breaks of each kind per cell-day and 20 day clusters; the count is read at the outcome; under 20 is INDETERMINATE and the 2-close rule stands |
| lookback | 300 closed bars of the timeframe | every series holds 300 warm-up bars before the first instant (manifest: 0 failed series, 0 missing bars) | inside — every zone set is built on a full 300 bars |
| ATR14 seed | 15 closed bars | never fewer than 300 | inside |
| control window | 96 candidates (15m, 1h, 4h), 24 (1d) | forced controls of Z1: 1.23% / 1.08% / 1.07% / 3.85%; of STRONG zones 2.81% / 2.58% / 2.58% / 11.30% | inside — forced controls are kept and pull Δ toward zero |
| day clusters as independent units | a control up to 27 h (15m), 4.5 d (1h), 18 d (4h), 36 d (1d) after its served instant | on driftless walks 0.07 of 95% intervals exclude zero (nominal 0.05) | floor — the UTC-day interval is slightly narrow; PASS also needs the coin-cluster bound, which does not rest on days |
| grid rotation | strides of 13, 49, 221 and 1,181 fifteen-minute units | each is coprime with 96 and with the timeframe's length | inside — instants cover every time of day and every position inside a bar |
| panel selection | volume as of 2026-11-12, full history required | 50 of the first 153 candidates; 103 rejected for a daily history under 665 bars | floor — survivorship; the result is about these 50 coins (§3) |
| round flag (descriptive) | a multiple of 10^(⌊log10 level⌋ − 1) inside the zone | 10.7% / 20.7% / 38.3% / 65.0% of served zones carry it | inside — descriptive only |

## Identifiability (PROCEDURE §4c)

Every declared floor is a floor on a difference between two arms' rates, so each arm's side mix must be able to carry it. Here the two sides are support and resistance (long and short for V4), and m is the smaller side's share of the arm's served rows (label-free; the counts are the run's `sides.json`, printed by the probe below; the per-timeframe rows use the `z1.sup` and `z1.res` rows of the same output). No arm's bound 2m is near its floor. V2b's floor is 0.0pp. The same bound is recomputed on the outcome run's rows at the read; a V1 arm that is NOT_IDENTIFIABLE there is the registered INDETERMINATE. Each verdict below was recomputed through `python3 ops/monitoring/population_comparison.py --declarations`.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| V1 — bounce(served) − bounce(control), cells pooled | served Z1 | 0.4780 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 847,562 | 3.0 | 95.60 | IDENTIFIABLE |
| V1 — cell 15m | served Z1 | 0.4817 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 639,690 | 3.0 | 96.34 | IDENTIFIABLE |
| V1 — cell 1h | served Z1 | 0.4705 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 167,593 | 3.0 | 94.10 | IDENTIFIABLE |
| V1 — cell 4h | served Z1 | 0.4654 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 34,909 | 3.0 | 93.08 | IDENTIFIABLE |
| V1 — cell 1d | served Z1 | 0.3499 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 5,370 | 3.0 | 69.98 | IDENTIFIABLE |
| V2a — Δ(STRONG) − Δ(WEAK) | STRONG | 0.4841 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 363,165 | 2.0 | 96.82 | IDENTIFIABLE |
| V2a — Δ(STRONG) − Δ(WEAK) | WEAK | 0.4744 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 314,988 | 2.0 | 94.88 | IDENTIFIABLE |
| V2b — Δ(Super Strong) − Δ(STRONG, no agreement) | Super Strong | 0.4786 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 650,807 | 0.0 | 95.72 | IDENTIFIABLE |
| V2b — Δ(Super Strong) − Δ(STRONG, no agreement) | STRONG, no agreement | 0.4757 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 58,111 | 0.0 | 95.14 | IDENTIFIABLE |
| V3 — Δ(Z1) − Δ(best free version) | served Z1 | 0.4780 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 847,562 | 1.0 | 95.60 | IDENTIFIABLE |
| V3 — Δ(Z1) − Δ(best free version) | floor pivots | 0.4994 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 1,007,378 | 1.0 | 99.88 | IDENTIFIABLE |
| V3 — Δ(Z1) − Δ(best free version) | previous-day high and low | 0.4834 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 350,883 | 1.0 | 96.68 | IDENTIFIABLE |
| V3 — Δ(Z1) − Δ(best free version) | round numbers | 0.5000 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 1,065,912 | 1.0 | 100.00 | IDENTIFIABLE |
| V4a — take-profit hit share, served − control | entries, long and short | 0.4877 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 252,804 | 3.0 | 97.54 | IDENTIFIABLE |
| V4b — stop-then-recover share, control − served | entries, long and short | 0.4891 — probe `python3 -I scripts/sr-backtest/sr_backtest.py --cardinalities <skeleton dir>`, n = 314,486 | 3.0 | 97.82 | IDENTIFIABLE |

The single-side cuts (supports only, resistances only, V4 long only, V4 short only) have m = 0 by definition; they are descriptive and carry no floor.

## 6. Decision rule (PROCEDURE §6) — three states per test

**V1 (primary) — the wave's verdict, one line `SR_BACKTEST_VERDICT=<PASS, NULL or INDETERMINATE> — <cause>`:**

- **PASS** — on UTC-day clusters the point is at or over +3.0pp and the 95% lower bound is above zero; on coin clusters (at least 20) the 95% lower bound is above zero; and the hold-out mean is above zero.
- **NULL** — the UTC-day upper bound is under +3.0pp. It reads "our zones bounce no more than matched random zones by +3.0pp" — as plain as a pass. An upper bound under zero is a NULL that names the reversal.
- **INDETERMINATE** — anything else, cause named and what resolves it: no cell-day with both arms at 30 entered events · fewer than 20 UTC-day clusters · a NOT_IDENTIFIABLE arm · the UTC-day leg passing with fewer than 20 coin clusters, or with the coin-cluster lower bound at or under zero · a hold-out sign flip (or no hold-out day present) · an interval holding +3.0pp with its lower bound at or under zero · a lower bound above zero with the point under +3.0pp and the interval holding +3.0pp. What resolves each: more scored UTC days (a longer window or the forward test, T3) or a wider panel.

A null counts only because the interval excludes the floor. An interval that still holds +3.0pp is underpowered, never negative.

**V2a, V2b, V3, V4a, V4b (BH-FDR q = 0.10 over the five):**

- PASS — rejected by `bh`, UTC-day lower bound above zero, and the point at or over the floor (V2a +2.0pp · V2b 0.0pp · V3 +1.0pp · V4a +3.0pp · V4b +3.0pp as control − served).
- NULL — the UTC-day upper bound is under the floor.
- INDETERMINATE — otherwise; or fewer than 20 day clusters; or a NOT_IDENTIFIABLE arm.

**V5:** PASS (the 1-close break follows through more, lower bound above zero → "broken" is the 1-close rule) · NULL (→ the 2-close rule) · INDETERMINATE (fewer than 20 day clusters → the 2-close rule stands).

**Decision map.**

- V1 PASS → the arc continues: T2 builds the tool on zone rule Z1 and T3's forward test starts. V1 NULL or INDETERMINATE → the arc closes with nothing published.
- V2a not PASS → no Weak / Medium / Strong words. V2b not PASS → no Super Strong word.
- V4a or V4b not PASS → no take-profit or stop ideas for the failed part.
- V3 not PASS → the simpler rule is considered.
- V5 → which rule the word "broken" uses.
- The V2, V3 and V4 lines go to Mr.1 (arc Extra gate). None of V2–V5 changes V1.

Whatever the verdict, the tool never claims edge or accuracy (arc premise: EDGE-SR-LEVEL-PROBE-W1 was NULL on direction).

## 7. Declared expectations and respecification (PROCEDURE §7)

- Signs expected if the zones carry information: V1 > 0, V2a > 0, V2b ≥ 0, V3 > 0, V4a > 0, V4b > 0 (as control − served), V5 ≤ 0 (the 2-close break is a subset of the 1-close break, so the default is expected to stand).
- Expectation, stated before the read: none. No bounce figure has been seen for any real candle. The control is built to be a hard comparator (a zone-free spot at the same ATR distance, read by the same rule), so a NULL is a likely and acceptable outcome, and the arc's close condition is written for it.
- No parameter in §4.8, no cell set, no arm definition, no minimum, no estimator and no verdict rule is changed after the read. A respecification one would not have proposed had the check passed is not applied to these rows: it is registered and applied to data nobody has read — T3's forward window.

## 8. Deviations, quarantine, publication (PROCEDURE §8)

- A deviation from this file is recorded in the findings with its cause and the new sha256 of whatever changed, and the verdict is then given both ways; it is never absorbed. The pinned-hash test and the outcome guard make a silent change to the level rule, the zone rule, the engine, the estimator or the candles fail.
- Figures live only in the private vault (`audits/EDGE-SR-LEVEL-BACKTEST-W1-findings.md` and `.json` there). No bounce, break, hit or follow-through rate on real candles enters this repository or any public surface. The outcome step refuses an output directory inside the repository.
- Corrections to the wave spec, all made before any outcome read:
  1. **The control (§4.5).** "Same UTC day … at a seeded other instant", unmatched zones dropped, is not zero by construction (measured: −1.5 to −2.6pp on driftless walks). Registered instead: later, same position inside the timeframe's bar, first free candidate in time order, never dropped, deterministic. "Same UTC day" is the served instant's day; the control itself is later.
  2. "Disjoint from every qualifying zone then" is read as the qualifying zones of the same timeframe and the same source at the control's instant.
  3. V4's "seeded entries" are the registered grid instants, long and short at each; nothing is drawn.
  4. V4b's "≤ −3.0pp" is registered as control − served ≥ +3.0pp.
  5. Super Strong is checked against the other three registered timeframes (the parity fixture covers one to three chosen timeframes); V2b compares Super Strong (any label) with STRONG zones that have no agreeing timeframe, floor 0.0pp.
  6. V1's INDETERMINATE causes add the coin-cluster ones (fewer than 20 coin clusters; coin-cluster lower bound at or under zero), which follow from V1's own bar, and "lower bound above zero with the point under +3.0pp".
  7. The Binance adapter's `getCandles` does not read the adapter interface's optional end time (it returns up to 200 bars from the start time); the fetcher bounds the paging itself and keeps only bars inside the planned range.
  8. `tests/unit/sr-backtest-harness.test.ts` checks byte equality of every pinned file of this wave and of `src/scripts/sr-probe/`; for the two shared statistics libraries (`src/scripts/cluster-perm-stats.py`, `ops/monitoring/population_comparison.py`) it checks only that a pin exists, so another wave's later edit does not turn this suite red. The outcome guard enforces their bytes at the read.
  9. V2's "bounce by label" is read as a difference of two Δs, each label against its own controls, not as a difference of raw bounce shares.

## 9. Owner, the read, and the inheritors (PROCEDURE §9)

- **Owner:** Mr.1. **The read:** this wave's CH2, once, after this file is on `origin/main`; then a fresh-context audit (CH3) re-runs the tests and mutations, recomputes V1 from the persisted files with its own code, and regenerates the parity fixture byte for byte.
- **T2 (the level-check tool)** inherits zone rule Z1 through `src/scripts/sr-backtest/zones.ts#levelCheck` and must reproduce `ops/sr-level-parity-fixture.json` (800 seeded windows, 200 per timeframe, one to three chosen timeframes each: served zones, labels, round flag, rank, Super Strong and agreeing timeframes).
- **T3 (the forward test)** re-runs V1, V2 and V4 with this harness, unchanged, on bars that do not exist yet. It inherits this file; anything it changes is its own registration.
- **T5 (other venues)** runs the same harness with `--venue` and a registered panel file for that venue; it inherits the rule and the estimator and registers its own corpus.
- **Records by verdict (CH3):** PASS or NULL → no register row · INDETERMINATE → register row OWED naming what resolves it.

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
| `src/scripts/sr-backtest/run.ts` | `4d0c7e3982b9a2aad612495a58f45716289511c6b067b559452564f0a04b1a2b` |
| `scripts/sr-backtest/sr_backtest.py` | `4b0e1bb0dd36f07308ae19a3d668257ece4a677fd30f0437c1644cf09989018b` |
| `src/scripts/cluster-perm-stats.py` | `6d82c1601a9ce1121deecaa1c88ac4685abef328ff27d35047fad37d69f60100` |
| `ops/monitoring/population_comparison.py` | `282587c48242601ca3d94f6d748742d7722d49e57f5b975f6da85a94e0e258fb` |
| `store:manifest-BINANCE.json` | `eb33e177280259519f5aca49c95933f7f470ca273eb1440da844af980169f475` |
| `scripts/sr-backtest/calibration.json` | `fdd11287a3c99f477fca595e9951096e27dc6392f7ce10e2c93e46c3bb148af5` |
| `ops/sr-level-parity-fixture.json` | `73c3144e7cf638367dc5b54a5929fe2a14cf3f74d85ba2e4a5d43e75c2d835ff` |
| `src/scripts/sr-backtest/synth.ts` | `79d4d8a66006ddb71375e25854544bfcb036c9c07051155eba072f5ee57e3cb8` |
| `src/scripts/sr-backtest/fixture.ts` | `ba40c423c3208546ab9db35d9284aac5da67b23e8317aa73f46925d0264f99f5` |
| `src/scripts/sr-backtest/fetch-store.ts` | `384301cb5ad59a12d6ba6b25b29f03ae04e7b804a7898c0eb6e8f449e2d0ffdd` |
| `store:plan-BINANCE.json` | `b3d54ed842e2852c7ee8ed5c1129c4ca9d46981d4263a25dd69e44d46a7cef2a` |
| `skeleton:skeleton.csv` | `0e9b3e0e3ee9d9db964c9295167c1562c0b76943cf5a0ed35bab609a0288661d` |
| `skeleton:sides.json` | `874724ef4a14222c2a472ef575d5e93247e5c8d310de353fcec7199e85509616` |

`store:manifest-BINANCE.json` is the candle store's manifest (200 series, each with its range, bar count and sha256); `store:plan-BINANCE.json` is the fetch plan with every candidate's fate; the two `skeleton:` rows are the label-free run §5 was computed from.

Who enforces what: the outcome guard refuses unless the first eleven rows and the store manifest match byte for byte. The test suite checks, on every run, the first nine rows and `calibration.json`, the parity fixture, `synth.ts` and `fixture.ts`; for the two shared statistics libraries it checks only that a pin exists (§8, correction 8). `fetch-store.ts`, the plan and the skeleton rows are a record of how the store and §5 were made; nothing reads them at the outcome. The store was read on 2026-11-12 (11:07Z – 12:02Z) by `fetch-store.ts` under its first name, `fetch-candles.ts`; it was renamed before landing because the repository's caller-tag gate refuses two entrypoints with one basename, and only its header comment and usage line changed with the name.
