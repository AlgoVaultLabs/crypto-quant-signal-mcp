# EDGE-HURST-DISCRIMINATION-PROBE-W1 — pre-registration: does the Hurst term earn its place?

**Write-time clock (live `date -u`):** first written `2026-09-22T06:29:39Z` (epoch `1790058579`); final revision (plan v3, third pre-landing review) `2026-09-22T08:48:13Z` (epoch `1790066893`).
**Owner:** `EDGE-HURST-DISCRIMINATION-PROBE-W1` · **Procedure:** `audits/PREREGISTRATION-PROCEDURE.md` (§4 and the new §4b)
· **Gate:** `tests/unit/preregistration-support-stress-test.test.ts`

**Architect rulings.**
- **First GO, 2026-09-22:** all 11 = A.
- **Second GO, 2026-09-22, after the second Plan-Mode HALT:** Q12–Q14 = A, **and the first GO's Q6 ruling is WITHDRAWN** (see §16).
- **The wave is restructured.** R1, a direct, coin-balanced, label-free test-retest of the estimator, is the primary deliverable, gated on its own operating characteristic. The corpus κ is demoted to a seen descriptor. The outcome arm is confirmatory and may return INDETERMINATE without that being a failure.

**Methodology commit (landed first):** 9fbe5d07993b1a382ba5d7bd44eb6aa45051bdd7.

This file is **methodology only**. It carries cardinalities (PROCEDURE §1), simulation constants describing the estimator on synthetic data, and the registered design. Every κ, AUC, interval or rate that this registration produces on real data lives in the private vault, because the code repo is public.

---

## 0. The question, and what this registration does not decide

`deriveVerdict` adds a Hurst term to the score: ±25 on its mean-reverting (MR) branch, ±10 on its trending (TREND) branch. Does it earn its place? Two arms answer:

- **R1 — PRIMARY, label-free (§3).** Does the estimator's regime code agree with itself, coin by coin, across adjacent non-overlapping 100-bar windows, beyond the common (per-interval, per-time-block) market state? It is tested against ONE a-priori positive control: a population whose coins carry a genuinely persistent, heterogeneous AR(1) φ = ±0.1. Klines are fetched read-only through the shipped adapters, on a registered, coin-balanced plan covering fired AND dead cells over 10 served intervals, 3m…1d (6h is excluded, §3.2). Only live windows count (§3.2b).
- **R2–R3 — confirmatory, outcomes (§5–§8).** On the rows where the term fires, does the score WITH the term rank withheld-decision outcomes better than the score with the Hurst stage removed? The comparison uses identical rows, within side, block-stratified and cluster-bootstrapped.

**Not decided here:**
- Any scorer, ladder, weight, threshold, window, fetch-depth or `MAX_RAW_SCORE` change. **Hurst is not enabled or disabled here.**
- `TREND_MODE`.
- The HOLD-discipline hypothesis (§14).

**Every recommendation other than NO_CHANGE and CONFLICT is a SERVING CHANGE that needs Mr.1's acknowledgement (§15). This wave ships none.**

**Seen-corpus status (architect Q1-A).** The outcome arm's corpus is `EDGE-SCORER-PREDICTIVE-CEILING-W1`'s, and its outcomes were read on 2026-09-22 before this file existed. This wave's outcome estimand has never been computed on it: the paired AUC of the score with vs without the Hurst stage on the fired subgroup. **AC1 is held in its amended form: this file lands before THIS wave's first outcome read.** Seen data weakens a POSITIVE far more than a NULL, so KEEP and MAPPING carry a forward-replication binding (§15). **R1's klines are unseen: no one has computed a Hurst code on the registered plan's fetch.**

---

## 1. Outcome-arm corpus — the ceiling corpus, re-pinned by reference

### 1.1 Base corpus

The base corpus is exactly `audits/scorer-predictive-ceiling-preregistration-2026-09-21.md`:
- **§1.1 literal SQL:** `T_END = 1789718400`, `LABEL_FREEZE = 1790036701`, `barrier_spec = 'tau1.0-floor0.30-v1'`, `raw_final IS NOT NULL`, `suppression_reason = 'below_threshold'`, `would_be_side <> 0`, `exchange IS NOT NULL`, `timeframe <> '1m'`, `low_vol_history = FALSE`, `computed_at <= to_timestamp(LABEL_FREEZE)`.
- **§1.1 driver filters, in order:** served-bar maturity, faithful-only, the §1.3 test-window population rule, coarser-served cells, WEEX pre-`1788431453`, frozen-price pairs.
- **§1.5 maps:** coin map sha256 `b09f634572ddcbc85e517d273c649417e690c71bea9e52c084f0db6dd3f57f34`; served map sha256 `b4fa1e473b95a4873d1da20d31c520ed699190ccf179c88515b65f718c567f10`.

**Kept: 142,572 rows**, reproduced by five independent scripts. The driver asserts it.

**Deviation, recorded as one.** PROCEDURE §3 fixes `T_END` at registration write time. This file reuses the ceiling's `T_END` and `LABEL_FREEZE` for corpus identity, because any later bound admits labels from the nightly labeler's alphabetical prefix (ceiling §13). No labelling pass is in scope.

### 1.2 X-side and the one added column

The X-side is the ceiling's label-blind X-file (sha256 `78fad057965eafbe45fcac56cd9920bd76f9b13b78e9223083d97640c5b4607a`), joined on `decision_id` with a fresh READ-ONLY pull of `h.squeeze_adjust_code` under the identical §1.1 predicate. That pull is taken after this file lands and **after the landing's deploy run concludes**. Any of these refuses with `INDETERMINATE — INSTRUMENT`:
- ids ≠ 157,583, or any symmetric difference;
- a `hurst_adjust_code` mismatch;
- `squeeze_adjust_code = 2` disagreeing with `squeeze_delta ≠ 0` on any row.

**The driver never opens the ceiling's `r-file`, `y-train` or `y-test`.** It holds those three paths on a refusal list, and a read of any of them is an `INDETERMINATE — INSTRUMENT` refusal.

### 1.3 The fired subgroup, defined on the CODE

`hurst_adjust_code` has three states, set by code path:

| State | Code | Meaning |
|---|---|---|
| not evaluated | 0 | `hurstExponent` returned null: fewer than 100 closes, a close ≤ 0 in the window, or fewer than two usable R/S sizes |
| evaluated, zero | 1 (NEUTRAL) | `0.45 ≤ h ≤ 0.55`, **or a non-finite h**, which fails both comparisons |
| evaluated, non-zero | 2 (MR) · 3 (TREND) | delta ±25 or ±10 |

**Fired := code ≠ 0: 57,316 rows (SELL 41,856, BUY 15,460).** The R/S fit uses log-returns 1..96 of the 99 available, so the three most recent closed bars never enter it.

**Firing is predominantly decided by adapter bar-count behaviour:** 0 % or ~100 % per (venue, timeframe) cell almost everywhere, per coin inside MEXC native cells. Flat series are also null, but they are filtered here by the frozen-pair drop. 61.3 % of fired rows are **fetch-and-relabel** cells, where the timeframe is served on finer bars and more than 100 of them are available.

### 1.4 The term is several operators

MR computes `raw > 0 ? raw − 25 : raw + 25`, so it **crosses zero for 0 < |afterFunding| < 25** (87.0 % of corpus MR rows: BUY 93.2 %, SELL 78.7 %). TREND computes `raw > 0 ? raw + 10 : raw − 10`.

| Branch stratum (fired) | SELL rows / coins / Kish | BUY rows / coins / Kish |
|---|---|---|
| TREND | 30,358 / 1,175 / 485 | 8,933 / 1,060 / 241 |
| NEUTRAL | 9,736 / 1,120 / 358 | 4,193 / 992 / 225 |
| MR flip or side-creation | 1,386 / 472 / 187 | 2,176 / 657 / 258 |
| MR damp | 376 / 205 / 111 | 158 / 102 / 58 |

Hurst sets `would_be_side` on SELL 1,569 and BUY 2,176 rows. MR with |afterFunding| = 25 returns 0, so the row leaves the corpus by the side predicate: 1,680 capture-window rows exit this way.

---

## 2. Prior-examination disclosure

| # | Prior examination | Population | Statistic class | Class here |
|---|---|---|---|---|
| 1–9 | Ceiling registration §2, rows #1–#9 (inherited by reference) | as listed there | as listed there | inherited |
| 10 | `EDGE-SCORER-PREDICTIVE-CEILING-W1` result | this corpus | within-side AUC of `side·raw_final`; L/T on X8 (includes `hurst_delta`); `L_full`/`T_full` (includes `hurst_evaluated`); resolution AUC | seen — not a test input |
| 11 | `EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1`, vault audit line 109 | withheld SELL | outcome coefficients on `hurst_delta` and `hurst_evaluated` | seen — not a test input. A Plan-Mode subagent's grep printed the line; **values not relayed** |
| 12 | `EDGE-SELL-ATTRIBUTION-CENTERED-CHECK-W2` D1, via ceiling Plan-Mode `probe-prod-cardinality.md:66` | SELL 8h/12h/1d | an outcome coefficient on `hurst_evaluated` | seen — not a test input; values not relayed |
| 13 | This wave's Plan Mode, a context grep | ceiling audit | one table fragment (whole-corpus `T_full`, `V`, `S_dir`) | seen — not a test input |
| 14 | This wave's Plan Mode and pre-landing review, label-free | fired corpus codes | **corpus κ by lag band; the class marginal vs a random-walk null; structure-matched simulations of the corpus-κ reading** | **seen**. The corpus κ is now a DESCRIPTOR (§4), never a test |
| 15 | This wave's R1 design work, label-free, synthetic prices | R1 plan skeleton | the operating characteristic (§11), computed on synthetic data | design, not data |
| 16 | Ladder audit decided rates (memory) | withheld, 30 d | boundary class | planning only |
| 17 | This wave's Plan Mode | fired subgroup | label-blind floor planning; all-pairs reorder share `d` | cardinality |

**Never computed by anyone, on any data:** the R1 κ on the registered plan's klines; the fired-subgroup paired gain; `AUC(side·hurst_delta)`; `P(decided | regime)`.

---

## 3. R1 — PRIMARY: direct test-retest of the estimator (label-free)

### 3.1 Instrument

- **Estimator:** the production `hurstExponent` at `window = 100` (`src/lib/indicators.ts`), mapped to the scorer's code by `deriveVerdict`'s thresholds.
- **Real codes are computed by the TypeScript function itself** (via `tsx`), and cross-checked against the vault Python port. The two must match on 100 % of windows, or `INDETERMINATE — INSTRUMENT`.
- **Simulations use the port.** It is logic-exact with |ΔH| ≤ 5e-15 and code-identical on 3,002 fidelity series, plus a registered set of series built near the 0.45/0.55 thresholds (§12 step 4). It runs on CPython 3.9.6, whose `sum` is naive like JavaScript `reduce`.
- **Instrument files** (vault, sha256 in `SHA256SUMS` of `audits/EDGE-HURST-DISCRIMINATION-PROBE-W1-instruments-2026-09-22/`, whose own hash is recorded in §13):
  - the port;
  - the simulation-controls script;
  - the R1 plan builder, the plan and its summary;
  - the R1 fetch script;
  - the R1 operating-characteristic script, the §11 design files and their outputs;
  - the driver and the query layer.

  **The driver refuses to run unless every file it EXECUTES hashes to its `SHA256SUMS` entry**, and that `SHA256SUMS` must hash to the registered value.

### 3.2 The registered plan (sha256 in §13)

- **Served intervals S (v2):** 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d. **6h is excluded.** Its only venue is Bitget's 8h→6H relabel, whose history paging leaves ~67-bar gaps per page, so no contiguous series can be fetched there. The outcome arm's 6h fired rows (1,365, all relabelled) are therefore outside R1's scope, named.
- **Eligible cells:** the registered served map's faithful `(venue, tf)` pairs with `served_seconds = s` on a venue reachable from the fetch host. Reachable: ASTER, BINGX, BITGET, GATE, HL, HTX, MEXC, OKX, PHEMEX, WEEX, WHITEBIT, XT. BINANCE, BYBIT and KUCOIN TCP-block the fetch host and are excluded, **named**. A native tf is preferred.
- **Excluded listings (v2):**
  - the ceiling's 217 frozen-price `(venue, coin)` pairs;
  - 572 listings the repo's `STATIC_ASSET_CLASS_MAP` classes as non-crypto session markets.

  The per-window liveness rule (§3.2b) is the generic guard for session markets that map omits.
- **Selection:**
  - Within `s`, venues are visited round-robin in name order.
  - Each venue offers its next coin-map listing in `md5(LABEL|r1|s|venue|coin)` order whose normalised coin is not yet taken at `s`.
  - Target **260 series per interval, 2,600 in all**.
  - Planned per venue: OKX 363, ASTER 343, BINGX 343, HL 296, BITGET 294, WEEX 223, GATE 164, MEXC 164, HTX 112, PHEMEX 107, XT 107, WHITEBIT 84.
- **Windows (plan v3, deep):** each series' cap is `K = min(35, VENUE_MAX_K[venue])`, the most windows ONE fetch path of its venue can return:
  - 35 for the backward-paging adapters (GATE, BITGET, ASTER, OKX) and HL (latest 5,000 bars);
  - 19 for MEXC (latest 2,000 bars, probed 2026-09-22T07:24Z);
  - 9 for the latest-only adapters (BINGX, WEEX, WHITEBIT, XT, PHEMEX, HTX; 1,000 bars).

  Planned: 1,460 series at 35, 164 at 19, 976 at 9. A young listing yields fewer windows: **the realized skeleton decides K, never this plan** (§3.2b).
- **Why deep.** The v2 plan capped K at 9 (6 at 12h, 4 at 1d). On its exact skeleton the pooled gate passed at stale share 0 but **failed at the 0.20 liveness cap**, and **no interval group passed its own gate at either stale level** (§11b). A group's precision is bounded by its count of time blocks, not its coins, so every pooled BELOW_PC1 would have carried an empty REMOVE scope (§3.7). v3 changes only K; the series set is identical.
- **Cells:** each series is labelled **fired** or **dead** by its `(venue, tf)` cell's firing share in the kept corpus (≥ 50 % fired → fired), or **unknown** when the cell never occurs in the corpus. Dead cells are covered on purpose: they are where a KEEP would switch the term on.

### 3.2b Contiguity, staleness and liveness — decided from bars alone, before any code exists

Registered constants: `LIVE_MIN_VOL_SHARE = 0.90`, `LIVE_MAX_ZERO_RET = 0.20`, `LIVE_MAX_FLAT_RUN = 8`.

- **One calendar anchor.** Every series is cut at `T0`, the fetch's start time, which is written to the fetch log BEFORE the first request. A log whose status is not `complete` (an interrupted fetch) is never read: `INDETERMINATE — FETCH_INCOMPLETE`, and the fetch is never re-taken into the same run. Every series is fetched after it, so window k of every series of an interval covers the same calendar period (a later-fetched series would otherwise shift its windows by up to an hour, i.e. 20 bars at 3m). Only bars **closed by T0** (`open + served ≤ T0`) are used. A series fetched before T0 is an `INDETERMINATE — INSTRUMENT` refusal.
- **Stale:** the newest bar closed by T0 must sit within two bars of T0, or the series drops as `stale`.
- **Contiguity:** only the tail ending at the newest closed bar in which every step equals exactly one served interval is used. K = min(plan K, ⌊tail / 100⌋). If a gap cuts the tail below K ≥ 4 while the raw count would have allowed it, the series drops as `gap`. A series whose fetch errored after returning some bars drops as `partial_error`, never kept.
- **Windows** are the consecutive non-overlapping 100-bar blocks of that tail, ending at the newest closed bar. Pairs are adjacent windows (k, k+1).
- **A window is LIVE** if all four hold:
  - every close > 0;
  - ≥ 90 % of its bars carry volume > 0;
  - ≤ 20 % of its returns are exactly zero;
  - no run of ≥ 9 identical closes. That is a frozen book: `hurstExponent` does not null on it but silently drops zero-variance R/S blocks, so H would come from fewer blocks.

  **A pair counts only if BOTH windows are live** and, once codes exist, neither window's code is 0 (a registered drop). This removes the frozen, thin and session-closed books that make the code self-agree for reasons that are not persistence. The second pre-landing review measured a null that read ABOVE_PC1 up to 85 % of the time without this rule.
- Drops are printed by cause: `venue_stopped`, `empty_response` (the venue answered with no bars; never filed as staleness), `fetch_error`, `partial_error`, `stale`, `gap`, `k_below_min`, `no_live_pair`, `dead_pairs`, `code0_pairs`.

### 3.3 Fetch riders (architect Q13, binding)

- **Pacing:** per venue, at or below 50 % of the documented limit for the kline endpoint, **with headroom for one adapter transient retry per minute** (`upstreamFetch` retries once, outside the budget ledger). Requests/min: HL 6, GATE 200, BITGET 240, MEXC 60, XT 60, WHITEBIT 60, HTX 60, PHEMEX 4, ASTER 200, BINGX 60, WEEX 20, OKX 150. The documented limits come from `src/lib/venue-budget-registry.ts`.
  - HL is weight-limited: a deep call returns ~3,505 items, which is weight 20 + ⌈3505/60⌉ = 79 (`weightFor`). 6 × 79 = 474, plus one retry = 553 ≤ 600. A deep call measured 452 ms against the adapter's 3 s timeout (probe 2026-09-22T08:02Z).
  - PHEMEX: 4 + one retry = 5 of 10 kline requests/min.
  - OKX and Bitget historical calls issue two requests, each still ≤ 25 % / 8 %. OKX runs **two lanes that share ONE pacer**: slots are reserved before awaiting, so the combined rate never exceeds 150 calls/min. Otherwise the two sequential round trips per call make OKX latency-bound at ~3 h.
  - A paging series makes at most ⌈(100K + 2) / page⌉ + 3 calls: OKX 39, the others 21.
- **Measured, not assumed.** The run publishes, per (venue, endpoint path), the maximum request count in any rolling 60 s window (HL: weight), set against 50 % of the documented cap. `rider_ok` is false if any breaches. Every HTTP request is counted, adapter retries included.
- **A 418 or 429** (HTTP, or the adapters' typed `UpstreamRateLimitError` / budget skip) **stops that venue for the rest of the run and is never retried.** A rate limit is recognised **by type only**: the wrapper's own ban set, `code === 'UPSTREAM_RATE_LIMIT'`, or `WeightBudgetSkipError`. **Never by digits in a message** (amendment, §16.5). The global-`fetch` wrapper **refuses any further request to a banned venue without calling the network**, and that includes an adapter's own transient retry, whatever its `banStatuses` (HL types only 429). A mocked HL-418 harness measured exactly 1 HTTP request and the retry refused. The venue's remaining series are recorded as `venue_stopped` and are drops.
- **Every HTTP request is counted per venue, attributed by the URL's HOSTNAME** (a query string naming another venue's coin, e.g. OKX `instId=ASTER-USDT-SWAP`, can never move a request or a ban across venues). Per-venue request counts, statuses, first/last request time and achieved requests/min are published in the audit.
- **MEXC** signals a rate-limit breach as body code 510 with HTTP 200 (`venue-budget-registry`). The wrapper treats it exactly like a 429: the venue stops and the breach is counted as `body510`.
- **HL dex routing matches production:** `getDexForCoin`'s logic, over the live xyz symbol set that `warmTierCaches` warms (one `metaAndAssetCtxs` request with `dex: 'xyz'`). 5 of the plan's 61 HL coins route to xyz (XYZ100, NBIS, CXMT, DRAM, SKHY, probed 2026-09-22T08:02Z). An empty xyz set refuses the fetch.
- **Paging:** the forward-from-startTime adapters (GATE, BITGET, ASTER at 200 bars per call; OKX at 100) page BACKWARD from the newest page. Each later page is requested to end exactly at the oldest bar already held. Measured on mocked venues:
  - the second pre-landing review, both documented readings of OKX/Bitget paging: 0 gaps, full K;
  - the third review's v3.1 harness at K = 35: OKX (2 lanes) and Bitget 0 gaps and full depth; the OKX series of the coin ASTER attributed to OKX; MEXC 510 stopping the venue, with the next request refused and no HTTP call; HL XYZ100 on xyz, BTC on standard, an unlisted coin recorded as `empty_response`; every rolling-60 s rate within 50 %;
  - the v3.2 harness (§16.5) adds BingX: a `109418` symbol-offline envelope is a `fetch_error` and does NOT stop the venue, a valid symbol fetches, an HTTP 429 stops BingX, and the next series is refused with 0 HTTP calls.

  HL, MEXC and the latest-only adapters answer in one call.
- The fetch computes no Hurst code.

### 3.4 Statistic

- **κ_s:** `stratified_kappa` over all adjacent pairs, with strata = **time block** `(s, j)`. The pair index `j` counts back from the anchor T0, and every series of one interval shares it, so the block is a calendar period. Chance agreement comes from each block's own marginals, so a market-wide swing in class shares cancels. What remains is **per-coin agreement beyond the common state**, the property the positive control models.
- **Interval:** `twoway_cluster_bootstrap_kappa(…, units1 = normalised coin, units2 = time block, strata = time block)`, `B = 2000`, seed `arm_seed(LABEL, 'r1')`, one-sided bounds at 0.025.

- **Descriptor (non-gating):** the UNSTRATIFIED two-way-bootstrapped κ, with its own operating characteristic. It does NOT condition away the common state, so it is the only R1 view on market-wide persistence, and it is noisy (§11b).

### 3.5 Positive control, threshold and the realized-skeleton gate

- **Truths simulated on the REALIZED skeleton.** The skeleton carries every included series' interval, coin, K, **live pair indices**, and **measured zero-return share**, which is applied to the synthetic path as P(close repeats): the microstructure residual that survives §3.2b. Windows are aligned per interval, with common factor λ = 0.8. Truths:
  - null: iid returns plus a common factor;
  - **PC1**: per-coin AR(1) φ ∈ {+0.1, −0.1}, fixed over time;
  - PC2: φ = ±0.2;
  - regime-switching PC1: sign flip at hazard 1/200 per bar;
  - heterogeneous tails: half the coins with Student-t(3) shocks, no persistence;
  - common regime: every coin of an interval shares φ_t = ±0.1, flipping at hazard 1/1000. The stratification removes this by construction;
  - PC1 on served ≥ 4h only, null below.
- **Replicates:** R = 200 for null and PC1, 100 for the others, B = 200 each, seeds `arm_seed(LABEL, 'realized-<truth>-<rep>')`.
- **κ_PC1 := the mean κ̂ under PC1 on the realized skeleton.**
- **The gate, evaluated BEFORE any real Hurst code is computed:** `oc_gate(P(BELOW_PC1 | PC1), P(BELOW_PC1 | null))` must PASS. If it fails, **R1 = NOT_IDENTIFIABLE**. It is then reported with its operating characteristic, and the recommendation falls to the outcome arm (§8).

### 3.6 Reading and wording (committed `reliability_reading`)

| Reading | Rule |
|---|---|
| `NOT_IDENTIFIABLE` | the realized-skeleton gate did not pass |
| `BELOW_PC1` | `CI_hi < κ_PC1` |
| `ABOVE_PC1` | `CI_lo ≥ κ_PC1` |
| `UNRESOLVED` | otherwise |

**Wording, fixed now:**
- **`BELOW_PC1`:** "the estimator's code does not agree with itself, coin by coin, across adjacent live 100-bar windows **beyond the common (per-interval, per-time-block) state** more than a φ = ±0.1 persistent population would through this estimator, on the served intervals, cells and coins covered". It **removes this estimator's per-coin discrimination**, and **never** implies that "persistence has no value".
- **`ABOVE_PC1`** establishes self-agreement, **not** that the code measures persistence. Book liveness is filtered, and tail shape is bounded by the tails control.
- **R1 is SILENT on:**
  - **regimes shorter than ~200 bars:** on the planned skeleton the regime-switching control reads BELOW_PC1 in 100 % of runs (§11b), so BELOW_PC1 cannot separate "no persistence" from short-lived persistence. The outcome arm is the only check on that, and a contradicting outcome arm turns the recommendation into CONFLICT (§8);
  - **market-wide persistence of any length**, which the stratification removes by construction (§11b common-regime row). The outcome arm is silent on between-day value, so **market-regime timing is untested by either arm**;
  - 6h;
  - non-crypto session markets.

### 3.7 Descriptors (non-gating, printed)

- κ and CI per interval group (≤ 30m · 1h–2h · 4h–8h · 12h–1d), each with its own OC from the same simulated replicates.
- κ for fired-cell vs dead-cell series.
- Per venue.
- Drops by cause (§3.2b), and per-venue request counts and achieved rates (§3.3).
- **A group whose own OC fails is printed "not individually identifiable".**
- **REMOVE scope (committed `remove_scope`):** REMOVE_THIS_ESTIMATOR applies only if the pooled reading is BELOW_PC1, and then **only to the interval groups that pass their OWN realized-skeleton gate AND read BELOW_PC1 on their own data**. Every other group's cells get NO_CHANGE. A pooled reading cannot license removal where the design cannot tell the null from PC1. If no group qualifies, the recommendation is REMOVE_THIS_ESTIMATOR with an **empty scope**, which is NO_CHANGE in effect, and the verdict line says so. On the planned v3 skeleton every group passes its own gate at stale 0 and none does with every series at stale 0.20 (§11b); on v2 none passed at either level. On a synthetic null run end to end, the reading was BELOW_PC1 with scope {≤ 30m, 1h–2h}; 4h–8h and 12h–1d read UNRESOLVED on that draw. **The realized skeleton decides the scope, never this plan.**

---

## 4. The corpus κ — SEEN, DESCRIPTIVE, not load-bearing (architect Q12-A)

The corpus κ is computed on fired-row pairs of the same (venue, coin, tf) at lag [100, 200) served bars, on the ceiling corpus. It is re-computed and printed as a descriptor with its **exact scope**:
- it rejects PC2-scale **permanent** per-coin heterogeneity on served ≤ 1h fired cells;
- it is **silent** on PC1, on regimes shorter than ~200 bars, and on served ≥ 4h (0 pairs on served ≥ 6h; coin Kish 26.8);
- **it cannot carry REMOVE alone.**

The class marginal is printed beside it as a descriptor with its full NEUTRAL/MR/TREND triple. It **differs** from the random-walk null toward MR, which is what per-coin persistence heterogeneity OR fat tails produce. That is weak evidence the classifier detects something, and is stated as such. Its TV has almost no power at PC1 scale.

---

## 5. Outcome arm — targets, scores, estimand

- **Targets.**
  - Direction: `direction_target(label, ambiguous)`, relative to `would_be_side`, with ambiguous races excluded.
  - Resolution (diagnostic): `decided_flag` on all fired rows. 0 fired rows have `ema_score = 0` or `volume_score = 0`.
- **Scores, all oriented `side · x`, never `|x|`:**
  - `S = side·raw_final`;
  - **`S_cf = side·counterfactual_without_stage(raw0 + funding_delta, squeeze_adjust_code ≠ 0, 10, 12)`** (primary);
  - `S_lin = side·(raw_final − hurst_delta)` (diagnostic; it differs from `S_cf` on SELL 3,276 and BUY 2,677 rows);
  - `H = side·hurst_delta`;
  - `R_ord`: MR = −1, NEUTRAL = 0, TREND = +1.
- `S_cf ≤ 0` on SELL 1,569 and BUY 2,176 rows; these are legitimate values. **The ceiling driver's ORIENTATION refusal applies to `S` only.**
- **Instrument identity (refused on failure):** `counterfactual_without_stage(raw0 + funding_delta + hurst_delta, sq ≠ 0, 10, 12) = raw_final` on every kept row (0 violations at Plan Mode).
- **Estimand, per side:**
  - **`G_s = A(S) − A(S_cf)`**, the paired `blocked_auc` on decided ∧ ¬ambiguous rows, blocks = UTC day × `H_eff`;
  - **`A_s = A(H)`**, two-sided about 1/2.

---

## 6. Inference, materiality and floors

- **Joint paired cluster bootstrap:** ONE `cluster_bootstrap_blocked_auc` over `{S, S_cf, S_lin, H}` per side, clusters = normalised coin, `B = 4000`, seed `arm_seed(LABEL, 'primary-' + side)`. The linear diagnostic comes from this same bootstrap. Levels are one-sided α = 0.025 per side (both sides must agree, so this is an intersection-union test). Equivalence bounds are one-sided 0.05 (TOST). No holdout is used, because both rankings are fixed production functions.
- **Reorder share.** `d_s = pair_reorder_share(S, S_cf, blocks)` is the midrank-weighted share of **all** within-block pairs (decided ∧ ¬ambiguous) reordered by the term. It is computed from the R-file before the Y pull.
  - It is a **planning proxy for the cap on |G_s|**, not an exact cap: the exact cap is the share among positive–negative pairs, which needs the labels.
  - Planning values on all fired rows: SELL 0.119, BUY 0.251.
- **Materiality:** `q* = 0.60`, giving `δ_s = materiality_delta(d_s, 0.60)`. For the secondary, `δ_A,s = materiality_delta(u_s, 0.60) / 2` with `u_s = untied_pair_share(H, blocks)`.
- **Floors** (π̲ = 0.15, ρ_e = 1, K = z_{0.975} + z_{0.80}):
  - primary: `auc_floor(U(S), U(S_cf), …, δ_s)`, and **only `pass_gap` gates**;
  - secondary: `auc_floor(U(H), U(S), …, δ_A,s)["pass_lvl"]`, and a failure → `Au`;
  - native arm: the same function with its own `d`, `δ` and floor.
- **Label-blind proof** in the FLOOR line:
  - (i) no label argument;
  - (ii) the recompute is byte-identical;
  - (iii) the Y pull's `MANIFEST` time is strictly after the FLOOR line's write time.
- **Anticipated, registered as a correct outcome, not a failure:** BUY cannot pass the gap floor at δ ≤ 0.03 at any decided rate, and SELL at q* = 0.60 needs roughly 16.5 k decided rows. **An UNDERPOWERED outcome forces INDETERMINATE under the both-sides rule.**

---

## 7. Decision rule — total, per side, then intersection-union (architect Q3-A as amended by Q14-A)

### 7.1 Per-side readings (committed)

**`gap_reading` → G+ / G− / Gs / G0 / Gu**, in that precedence:

| State | Rule |
|---|---|
| G+ | `CI_lo(0.025) > 0 ∧ point ≥ δ_s` |
| G− | `CI_hi(0.025) < 0` |
| **Gs** | `(CI_lo(0.025) > 0 ∨ CI_lo(0.05) > 0) ∧ point < δ_s`: statistically real, below materiality |
| G0 | the 95 % TOST lies inside ±δ_s (with the point) |
| Gu | otherwise |

**`level_reading` → A+ / A− / As / A0 / Au**, two-sided about 1/2, in that precedence. A level floor that is not literally True → Au. **As** is significant only at the TOST's own 0.05 level: it never reads A0, and the side map treats it as Au.

**α, recorded as an architect-acknowledged interpretation of Q3-A:** one-sided **0.025** governs G+ / G− / A+ / A− (the IUT significance level). The TOST equivalence halves use one-sided **0.05**. Gs and As catch anything significant at 0.05 but not at 0.025, so the TOST can never certify "no gain" or "no signal" for a quantity it itself calls significant.

**`term_side_reading`** (floor `pass_gap` false → **P**):

| | A+ | A− | A0 | Au |
|---|---|---|---|---|
| **G+** | KEEP | DISAGREE | KEEP | KEEP |
| **G−** | DISAGREE | MAPPING_INVERT | REMOVE_HARMFUL | REMOVE_HARMFUL |
| **Gs** | **NOT_IDENTIFIABLE** | **NOT_IDENTIFIABLE** | **NOT_IDENTIFIABLE** | **NOT_IDENTIFIABLE** |
| **G0** | MAPPING | MAPPING | **REMOVE** | UNRESOLVED |
| **Gu** | MAPPING_PROVISIONAL | MAPPING_PROVISIONAL | UNRESOLVED | UNRESOLVED |

**REMOVE is reachable only through G0 × A0.** Gs is not actionable either way (Q14-a).

### 7.2 `term_verdict` (committed; every input validated, a malformed value is REFUSED)

Precedence:

1. any P → **INDETERMINATE_UNDERPOWERED**;
2. any DISAGREE → **INDETERMINATE_DISAGREE**;
3. any NOT_IDENTIFIABLE → **INDETERMINATE_NOT_IDENTIFIABLE**;
4. any UNRESOLVED → **INDETERMINATE_UNRESOLVED**;
5. sides in different families → **INDETERMINATE_DISAGREE**;
6. **MAPPING with the term-alone sign differing across sides → INDETERMINATE_DISAGREE** (Q14-c);
7. a side failing §7.3 → **INDETERMINATE_UNSTABLE**;
8. **the native arm's CI excluding 0 against the verdict → INDETERMINATE_DISAGREE** (Q14-b): `native_sign` NEG under KEEP, POS under REMOVE or MAPPING, at α with no materiality, **whether or not the native floor passed** (a significance-based contradiction needs no power floor). A point-sign disagreement is printed in the headline, non-gating;
9. otherwise the common family: KEEP → **KEEP_AND_FIX**, MAPPING → **MAPPING_ONLY** (provisional if either side is), REMOVE → **REMOVE**.

### 7.3 Stability — leave-one-day-out, GATING, at the full B (Q8-A, Q14-d)

- For each UTC day of a side (19; Kish-effective 7.6 SELL, 7.0 BUY), that day is dropped and G and A are recomputed at **B = 4000**, seed `arm_seed(LABEL, 'lodo-' + side + '-' + <day as integer>)`, with `δ` and floors fixed at their full-data values. `lodo_stable` must hold on both sides.
- **Accepted in writing, before the run:** an equivalence REMOVE near its margin will often read UNSTABLE at B = 4000. A synthetic null run read REMOVE on both sides and turned UNSTABLE on a single-day deletion. **B is never reduced after the fact.**

### 7.4 Native arm and licence (Q5-A)

- The native arm is fired ∧ served = tf: SELL 16,092 (1,124 coins, Kish 289.5), BUY 6,079 (1,098, Kish 138.8). It has its own `d`, `δ`, floor and bootstrap (`B = 4000`, seed `arm_seed(LABEL, 'native-' + side)`).
- `native_sign(lo, hi)` feeds §7.2 and §8 for both sides, regardless of the native floor. Only the dead-cell licence requires the native floor.
- `keep_licence`: KEEP_AND_FIX licenses **"keep firing where it fires"**. Enabling on dead cells needs native G+ on both sides with floors passed, **plus** the §15 successor re-measure.

---

## 8. Recommendation (committed `recommendation`, per-side contradiction)

**`outcome_contradicts` is judged per side, never on the verdict state.** The outcome arm contradicts "the estimator carries nothing" if any of these holds. **Floors play no part: the driver passes the level state and the native sign computed WITHOUT floor gating.**
- any side reads G+ or Gs;
- any side reads A+, A− or As (the term alone ranks outcomes either way);
- the native arm is POS.

| R1 reading | Outcome arm | RECOMMENDATION |
|---|---|---|
| BELOW_PC1 | contradicting | **CONFLICT** — no serving change; the seen-data positive must forward-replicate |
| BELOW_PC1 | verdict REMOVE, not contradicting | **REMOVE_THIS_ESTIMATOR** (outcome supporting) |
| BELOW_PC1 | any other verdict, not contradicting | **REMOVE_THIS_ESTIMATOR** (outcome non-contradicting) |
| ABOVE_PC1 / UNRESOLVED / NOT_IDENTIFIABLE | KEEP_AND_FIX / MAPPING_ONLY / REMOVE | that verdict, with §15 bindings |
| ABOVE_PC1 / UNRESOLVED / NOT_IDENTIFIABLE | any INDETERMINATE_* | **NO_CHANGE** — cause named, plus what would resolve it |

- **Flip-driven** (`flip_driven`): the primary is recomputed on fired rows excluding the MR flip/side-creation stratum (SELL 40,470, BUY 13,284), at B = 4000, seed `arm_seed(LABEL, 'flip-' + side)`, with full-data `δ` and floors. G, A and the side reading are all recomputed. A KEEP that does not survive is **flip-driven**. It licenses a **contrarian rule, not "enable Hurst"**, and the verdict line says so.
- **Headline, one line:** `R1=<reading> κ_s=<est> [<lo>, <hi>] vs κ_PC1 <thr> (OC: P(below|null) <p0>, P(below|PC1) <p1>; coverage <series>/<coins>/<blocks>, fired <n> dead <n>) | OUTCOME=<state> (SELL …; BUY …) | RECOMMENDATION=<…> | licence=<…> | flip-driven=<…> | corpus κ (seen, scope-limited)=<…> | outcome arm within the withheld support (SELL |S| ≤ 55, BUY |S| ≤ 40) AND the Hurst-fired cells only`.

---

## 9. Sensitivities and descriptors (non-gating; B = 4000 each)

| Item | Definition |
|---|---|
| common support | fired rows where `S_cf` lies in the same side's withheld band: SELL 40,269, BUY 13,230 |
| (venue, tf) blocks | blocks = side × day × (venue, tf) |
| linear ablation | `S_lin` in place of `S_cf` |
| tau0.5 / tau2.0 | **NEW** diagnostics, not a re-pin. tau2.0 is missing 381 corpus rows (358 unfired, 23 fired), named |
| test-window sub-window | `decided_at > 1789086632`: SELL 13,042, BUY 11,968 |
| branch strata · side-driver strata | the paired gain per stratum. A stratum below `FLOOR_CLUSTERS = 50` coins (decided rows) is reported by name and not read. Opposite-signed strata under a pooled null are reported as a mis-integration descriptor, never as REMOVE |
| resolution | `AUC(R_ord)` for `y_d` within side × day × `H_eff` (B = 2000, seed `arm_seed(LABEL, 'res-' + side)`), and its increment over the ceiling's `V`. `V` and `V + R_ord` are 5-fold coin cross-fitted with `grouped_fold(coin, LABEL, 5)`, and the paired bootstrap uses the same seed. **`VOLATILITY_DETECTOR`** is printed only when `CI_lo(AUC(R_ord)) > 0.5`, the increment's CI_lo ≤ 0, and the outcome state is REMOVE or INDETERMINATE. Descriptor only. BUY is underpowered (n_required 17,235 > 15,460 at δ 0.05) |
| exit channels | rows TREND pushed out of the band (unobservable here) and 1,680 rows MR zeroed |

---

## 10. Support stress-test

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| R1 stratified κ (primary) | adjacent LIVE window pairs of the registered plan, strata = (interval, pair index counted back from T0) | planned 2,600 series, 260 per interval over 10 intervals, 12 venues; up to K − 1 pairs per series (34 for the 1,460 at K = 35, 18 for the 164 at 19, 8 for the 976 at 9); the realized counts, which the realized skeleton decides, are recorded before any code is computed | floor (the realized-skeleton gate, §3.5) |
| R1 per interval group | ≤30m · 1h–2h · 4h–8h · 12h–1d | planned 1,040 / 520 / 520 / 520 series (6h excluded); on the planned v3 skeleton each group passes its own gate at stale 0 and fails with every series at 0.20 (§11b); realized counts are recorded | floor (each group's own realized OC decides whether it can enter REMOVE's scope) |
| R1 liveness / contiguity | every window | thresholds 0.90 volume share, 0.20 zero returns, a flat run < 9; drops recorded by cause before any code is computed | inside |
| R1 fired vs dead cells | per series, from its cell's corpus firing share | both classes are present in the plan (e.g. BINGX, OKX and ASTER are dead; GATE, HL and BITGET are fired) | inside (descriptor) |
| R1 positive control / threshold | PC1 simulated on the realized skeleton, R = 200 | planned v3 skeleton: PC1 κ̂ 0.0315 (SD 0.0030) at stale 0, 0.0207 (SD 0.0030) at stale 0.20 | inside |
| R1 fetch riders | per venue | 12 venues reachable (probe 2026-09-22T06:26Z); pacing ≤ 50 % of documented limits | inside |
| corpus κ (descriptor) | fired pairs at lag [100, 200) | 44,208 pairs, 790 coins, coin Kish 26.8; 0 pairs at served ≥ 6h | inside (descriptor, scope-limited) |
| primary gain, SELL | decided ∧ ¬ambiguous fired SELL, day × H_eff | 41,856 fired rows, 201 blocks (808 in blocks < 30), 19 days; the decided count is read at the checkpoint | floor |
| primary gain, BUY | same | 15,460 rows, 190 blocks (1,089 in blocks < 30), 19 days | floor |
| `S_cf` counterfactual | every fired row | stage identity: 0 violations on 142,572 rows | inside |
| orientation | every score | `S_cf ≤ 0`: SELL 1,569, BUY 2,176 (occupied) | inside |
| `d_s` / `δ_s` | decided partition, before Y | planning d on all fired rows: SELL 0.119, BUY 0.251 | inside |
| secondary `A(H)` | 4-level ranker | levels SELL −25:376, 0:9,736, +10:30,358, +25:1,386; BUY 158 / 4,193 / 8,933 / 2,176 | inside |
| secondary level floor | `pass_lvl` at `δ_A,s` | at the planning δ_A (all fired rows): SELL u 0.391, δ_A 0.0391, n_required 12,980; BUY u 0.562, δ_A 0.0562, n_required 7,072. SELL A is expected Au unless ≥ 31 % of fired SELL rows are decided and non-ambiguous | floor |
| leave-one-day-out | 19 days per side | Kish days 7.6 / 7.0 | inside |
| native arm | fired ∧ served = tf | SELL 16,092 / 1,124 coins; BUY 6,079 / 1,098 coins | floor |
| flip-driven | fired minus MR flip/creation | SELL 40,470; BUY 13,284 | inside |
| branch strata | per side | smallest: BUY MR damp 158 rows / 102 coins / Kish 58 (fired rows; decided subset read at the checkpoint against FLOOR_CLUSTERS) | floor |
| side-driver strata | per side | smallest: SELL HURST_SET 1,569 rows / 530 coins (fired rows) | floor |
| common support · (venue, tf) blocks · linear · tau specs · test window | as in §9 | cardinalities in §9 | inside |
| resolution `R_ord` | all fired rows | levels SELL 1,762 / 9,736 / 30,358; BUY 2,334 / 4,193 / 8,933; BUY under floor | inside (descriptor) |
| served-interval coverage (outcome arm) | fired native / fired relabelled / dead | 3m 150/0/692 · 5m 550/0/1,782 · 15m 1,492/0/6,431 · 30m 1,390/0/7,782 · 1h 7,851/17,367/23,791 · 2h 82/0/11,775 · 4h 5,623/10,704/16,096 · 6h 0/1,365/0 · 8h 3,924/5,709/8,782 · 12h 1,095/0/7,085 · 1d 14/0/1,040 | inside (headline) |

---

## 11. Operating characteristic

This is the registered design, plan v3, simulated on synthetic prices (label-free) with the registered instrument `EDGE-HURST-DISCRIMINATION-PROBE-W1-r1-oc-2026-09-22.py` (hash in the instruments bundle, §13). The skeleton is the plan's own: 2,600 series, each at its planned K, 60,400 pairs, 910 coins, 340 time blocks. Settings: common factor λ = 0.8, the time-block-stratified κ, a two-way bootstrap at B = 200, R = 200 per truth. It is run twice: with no stale closes, and with **every** series at the liveness cap of 20 % repeated closes (the worst case §3.2b admits). κ_PC1 = 0.0315 and 0.0207 respectively. The gate is re-evaluated on the REALIZED skeleton, with each series' measured stale share, before any real code is computed (§3.5). That realized evaluation, not this table, decides.

| truth | P(reads below the control) | required | result |
|---|---|---|---|
| null (iid + common factor λ 0.8), stale 0 | 1.000 | ≥ 0.80 | PASS |
| control PC1 (per-coin φ ±0.1), stale 0 | 0.000 | ≤ 0.20 | PASS |
| null, every series at stale 0.20 | 1.000 | ≥ 0.80 | PASS |
| control PC1, every series at stale 0.20 | 0.000 | ≤ 0.20 | PASS |

### 11b. What the test can and cannot detect (reported, not gated)

**Per interval group on the planned v3 skeleton** (each group's own κ_PC1; cells are P(below) under null / under PC1; R = 200). **This decides what REMOVE can reach (§3.7):**

| group | stale 0 | gate | every series at stale 0.20 | gate |
|---|---|---|---|---|
| ≤ 30m | 1.000 / 0.000 | PASS | 0.785 / 0.000 | FAIL |
| 1h–2h | 0.875 / 0.000 | PASS | 0.345 / 0.000 | FAIL |
| 4h–8h | 0.885 / 0.000 | PASS | 0.370 / 0.005 | FAIL |
| 12h–1d | 0.925 / 0.000 | PASS | 0.365 / 0.000 | FAIL |

The planned 12h–1d depth is nominal: 35 windows of 1d is 9.6 years, so young listings will cut it. The realized skeleton decides.

**The superseded v2 skeleton** (K ≤ 9; 18,720 pairs, 72 blocks; R = 200), the reason for v3 (§3.2):

| v2 skeleton | pooled P(below), null / PC1 | ≤ 30m (null) | 1h–2h (null) | 4h–8h (null) | 12h–1d (null) |
|---|---|---|---|---|---|
| stale 0 | 0.995 / 0.000 PASS | 0.640 FAIL | 0.270 FAIL | 0.360 FAIL | 0.125 FAIL |
| every series at stale 0.20 | 0.635 / 0.000 **FAIL** | 0.130 FAIL | 0.060 FAIL | 0.080 FAIL | 0.035 FAIL |

**Other truths on the planned v3 skeleton** (stale 0, κ_PC1 0.0313; R = 20, from the registered driver's realized-skeleton stage run end-to-end on synthetic klines). The R = 100 runs at stale 0.20, with per-group rows, are recorded in the vault audit:

| truth | P(BELOW_PC1) | P(ABOVE_PC1) | mean κ̂ (SD) | what it means |
|---|---:|---:|---|---|
| PC2 (φ ±0.2) | 0.00 | 1.00 | 0.112 (0.006) | strong per-coin persistence reads ABOVE |
| regime-switching PC1 (hazard 1/200) | **1.00** | 0.00 | 0.014 (0.003) | **BELOW_PC1 cannot separate "no persistence" from ~200-bar regimes** |
| PC1 on served ≥ 4h only, null below | **1.00** | 0.00 | 0.013 (0.003) | **a pooled BELOW can hide persistence confined to some intervals**, hence the per-group REMOVE scope |
| heterogeneous tails, no persistence | 1.00 | 0.00 | −0.000 (0.003) | tail shape does not fake self-agreement |
| common (market-wide) regime, φ_t ±0.1 | 1.00 | 0.00 | −0.000 (0.003) | removed by construction: **the stratified κ is blind to market-wide persistence** |

**The unstratified κ descriptor** (§3.4), its own OC on the same skeleton (R = 20): κ_PC1 0.0283; P(below) null 0.95, PC1 0.00, **common regime 0.10** (mean κ̂ 0.0255). It is the only R1 view that responds to market-wide persistence. It is a descriptor and never gates.

---

## 12. Order of operations (each step stamped with `date -u`)

1. **Methodology commit landed.** Its contents:
   - the term-contribution layer: `pair_reorder_share`, `untied_pair_share`, `materiality_delta`, `counterfactual_without_stage`, `gap_reading`, `level_reading`, `term_side_reading`, `term_verdict`, `native_sign`, `lodo_stable`, `flip_driven`, `keep_licence`, `oc_gate`, `reliability_reading`, `remove_scope`, `outcome_contradicts`, `recommendation`, `cohen_kappa`, `stratified_kappa`, the two κ bootstraps, `total_variation`;
   - known answers (group KH) and mutation set TERM T1–T53;
   - PROCEDURE §4b and its gate.

   Record `METHODOLOGY_SHA` **only** from `git rev-parse HEAD` read after `scripts/land.sh` returns, then prove it with `git fetch && git merge-base --is-ancestor $SHA origin/main`. Re-sync the prereg vault mirror (`prereg-vault-mirror.sh mirror`, then `_verify.sh` → `PREREG_MIRROR_VERDICT=PASS`), because PROCEDURE.md changed.
2. **This file lands.** Together with it: the fifth-consumer comment, and hold prereg §14. Proof is `merge-base --is-ancestor` after a fetch. **No push to main in [03:20Z, 05:15Z)**, the labeler leg plus margin. Neither landing happens in that window.
3. Immediately after step 2: the mirror re-sync again, which must print `PREREG_MIRROR_VERDICT=PASS`. Then the vault system-map card edit. **Wait for both landings' deploy runs to conclude** before any prod pull.
4. Self-tests:
   - `CLUSTER_PERM_SELFTEST=PASS` (≥ 287 checks) and all three mutation lines at missed = 0;
   - port fidelity (the 3,002 series plus a near-threshold set of up to 1,000 series, drawn from a seeded pool, whose TypeScript H lies within ±0.002 of 0.45 or 0.55);
   - the driver reads back every §13 constant from the landed copy of this file. It verifies that `METHODOLOGY_SHA` is an ancestor of origin/main, that `git rev-parse <METHODOLOGY_SHA>:src/scripts/cluster-perm-stats.py` equals the blob it imports, and that the instruments `SHA256SUMS` hashes to `INSTRUMENTS_SHA256SUMS` and matches every file the run executes. **All of this happens before any fetch or outcome read.**
5. **R1:**
   1. the fetch (§3.3), with the log published;
   2. the realized skeleton from bar counts;
   3. the realized-skeleton OC and gate (§3.5);
   4. only if it passes: real codes (TypeScript), the port cross-check, κ_s, CI, reading, `remove_scope` and the §3.7 descriptors, written to `r1.json`.
6. X-side `squeeze_adjust_code` pull and join (§1.2), with the corpus κ descriptor (§4) on the joined X-side. **Enforced, not prose:** every query-layer pull refuses unless the registration is an ancestor of origin/main AND every GitHub Actions run on the landing commit has concluded. The `sq` and `r` pulls, and the driver's `xside` stage, also refuse unless `r1.json` exists.
7. R-file pull (fired rows; decided and ambiguous flags; three specs), then the checkpoint: `d_s`, `δ_s`, `u_s`, `δ_A,s` and all floors in the FLOOR line, **before the Y pull**.
8. Y pull, then the read: readings, LODO, native arm, flip-driven test, verdict, recommendation, sensitivities and descriptors.

---

## 13. Registered constants (read back by the driver)

`LABEL = EDGE-HURST-DISCRIMINATION-PROBE-W1` · `METHODOLOGY_SHA = 9fbe5d07993b1a382ba5d7bd44eb6aa45051bdd7` · `T_END = 1789718400` · `T_TEST = 1789086632` · `LABEL_FREEZE = 1790036701` · `KEPT = 142572` · `FIRED = 57316` · `FIRED_SELL = 41856` · `FIRED_BUY = 15460` · `SPEC = tau1.0-floor0.30-v1` · `DIAG_SPECS = tau0.5-floor0.30-v1, tau2.0-floor0.30-v1` · `Q_STAR = 0.60` · `ALPHA = 0.025` · `ALPHA_EQUIV = 0.05` · `PI_LOWER = 0.15` · `B = 4000` · `B_LODO = 4000` · `B_FLIP = 4000` · `B_KAPPA = 2000` · `B_R1 = 2000` · `STAGE_GATE = 10` · `STAGE_BONUS = 12` · `R1_PLAN_SHA256 = c810263db667e82c00824d32caf44bd1461c53fc780e5a8bf0e418ae906792b3` · `R1_C_TARGET = 260` · `R1_K_MIN = 4` · `R1_OC_REPS = 200` · `R1_OC_LAMBDA = 0.8` · `OC_MAX_UNDER_PC = 0.20` · `OC_MIN_UNDER_NULL = 0.80` · `LIVE_MIN_VOL_SHARE = 0.90` · `LIVE_MAX_ZERO_RET = 0.20` · `LIVE_MAX_FLAT_RUN = 8` · `INSTRUMENTS_SHA256SUMS = f3d24222915a6c82debee14183d1b60641f94de26e0945397a9fa1e976ff6612` · `X_FILE_SHA256 = 78fad057965eafbe45fcac56cd9920bd76f9b13b78e9223083d97640c5b4607a` · `COIN_MAP_SHA256 = b09f634572ddcbc85e517d273c649417e690c71bea9e52c084f0db6dd3f57f34` · `SERVED_MAP_SHA256 = b4fa1e473b95a4873d1da20d31c520ed699190ccf179c88515b65f718c567f10`

---

## 14. Quarantine, disclosure, publication

- **Fifth ratified consumer of `hold_decision_labels`**, by resolved ID (architect Q10-A), under the same three protections:
  - it pre-registers its own hypotheses;
  - it is **never cited for or against the HOLD-discipline hypothesis**;
  - nothing from it reaches public copy, an MCP response, a track-record surface or any customer-facing artifact.

  It is recorded in `tests/unit/counterfactual-quarantine.test.ts` (a comment, no allowlist change) and the vault system map. SQL lives in the vault-only query layer. **R1 reads no counterfactual store.**
- **HOLD adjacency:** disclosed in hold prereg **§14**. No statistic is reported per confidence stratum; none of this wave's strata or sub-populations is a confidence cut.
- Deviations are recorded as deviations. Figures are vault-only.

## 15. Successors — every recommendation other than NO_CHANGE and CONFLICT is a SERVING CHANGE (architect Q11-A)

- **KEEP_AND_FIX** (`EDGE-HURST-TERM-SERVING-W{NEXT}`, if named). It needs Mr.1's ack and inherits:
  - (a) the ceiling §13 re-measure on the emitted arm, outside the withheld support;
  - (b) a forward replication on post-`T_END` rows, labelled breadth-first;
  - (c) the implementation changes **fetch depth per adapter, never the window** (99 vs 100 reclassifies ≈ 18 % of windows in simulation; that is not measured on fired rows). **OKX `limit: 100` blocks the route as written;**
  - (d) the MR flip is decided explicitly;
  - (e) a flip-driven KEEP is a contrarian-rule proposal.
- **REMOVE / REMOVE_THIS_ESTIMATOR** needs Mr.1's ack and is confined to `remove_scope` (§3.7). It removes per-coin discrimination only; market-regime timing is untested by either arm. It moves `rawScore` and published confidence on every fired decision, emitted ones included. It inherits (a). It does not inherit (b), because a label-free R1 basis is not weakened by the seen corpus.
- **MAPPING_ONLY** inherits (a) and (b).
- **CONFLICT and NO_CHANGE** ship nothing. A CONFLICT is resolved only by the forward replication (b).

## 16. Corrections and withdrawals carried by this registration

1. **WITHDRAWN (architect, attributed): the 2026-09-22 Q6 ruling.** That ruling said the label-blind evidence was "decisive on its own" and "stronger than anything the AUC arm can return". Both claims are refuted:
   - the class marginal is NOT the null: its MR share differs from the random-walk null's at a coin-clustered z above 3 (values in the vault endpoint truth). The deviation is weakly in the direction of the classifier detecting something;
   - the corpus-κ reading, as first drafted, returns "unreliable" in 19/20 null AND 19/20 PC1 simulations on the corpus's pair structure. That is an identifiability failure: its discriminating power was not checked before it was promoted.

   **Code's Plan-Mode endpoint truth made the two overstated claims the ruling relied on** ("indistinguishable from its random-walk null"; a near-zero corpus κ as decisive). A mid-session confidence-interval figure came from a permuted-code plumbing test and was wrong. **The generator fix is PROCEDURE §4b and `oc_gate`:** a reliability test is registered only after its structure-matched operating characteristic shows discriminating power.
2. **Spec corrections (architect-acknowledged):**
   - `raw_final − hurst_delta` is not the no-Hurst scorer (`S_cf` is the primary);
   - the four readings let REMOVE absorb the unresolved region (§7 replaces them);
   - δ = 0.05 on the AUC scale was unreachable (q-units replace it);
   - "zero writes, zero deploys" → **zero writes to the serving path; no DDL; no config; no flag change**;
   - "the redesign measured that re-enabling alters every emitted verdict" is decomposition §1.3's **unmeasured** startTime assertion, a stale-source error.
3. **Premise corrections:**
   - ~73 % / ~20 % → 59.8 % not evaluated / 40.2 % fired. The spec's figures came from the collider SELL corpus, and its 20 % was delta-defined;
   - "five of eight venues" → 15 venues in the store, 9 firing;
   - the tau "re-pin" did not exist (§9 registers it as new);
   - "48 assertions" → 287 checks;
   - **erratum in a landed file, recorded rather than silently fixed:** the closing line of `recommendation()`'s docstring in `cluster-perm-stats.py` (landed at `METHODOLOGY_SHA`) counts CONFLICT among the serving changes. Its first line, its code and this registration (§0, §8, §15) all say CONFLICT ships nothing, and **this registration governs**. The docstring is corrected only after the run, because the driver refuses any module blob other than the one at `METHODOLOGY_SHA`;
   - the system-map row cannot sit in a repo commit.
4. **AC8 — the literal allow-list of repo paths this wave writes.** The proof is the union of `git diff-tree --no-commit-id --name-only -r <sha>` over this wave's two landed commits. A range diff from the base would also sweep in other waves' commits that landed in between. The last two entries are the reusable precondition the architect asked for in Q13:
   - `src/scripts/cluster-perm-stats.py`
   - `tests/unit/cluster-perm-stats.selftest.py`
   - `tests/unit/cluster-perm-stats.mutation.py`
   - `tests/unit/cluster-perm-stats.test.ts`
   - `audits/hurst-discrimination-preregistration-2026-09-22.md`
   - `tests/unit/counterfactual-quarantine.test.ts`
   - `audits/hold-decision-preregistration-2026-08-26.md`
   - `audits/PREREGISTRATION-PROCEDURE.md`
   - `tests/unit/preregistration-support-stress-test.test.ts`

   Landing-triggered deploys are accepted (Q9-A).
5. **AMENDMENT 2026-09-22 (pre-data): R1 fetch #1 aborted; instrument fixed; fetch re-taken in a fresh run.**
   - **When and what.** The first R1 fetch started at `2026-09-22T08:59:00Z`, after this file landed (`a01eef2e`) and the driver's selftest passed. The fetch's rate-limit test was a regex (`/RateLimit|418|429|BudgetSkip/`). It matched the "418" inside BingX's symbol-offline envelope code `109418` and stopped BingX with **no** HTTP 418/429 from BingX. 305 of 343 BingX series were recorded as `venue_stopped`.
   - **Why it was the regex.** `UpstreamRateLimitError` sets no `name` and says "rate-limited (429)", so the regex recognised real limits only through the digits. That same digit match is what fired on 109418.
   - **Action.** The fetch was killed at `09:01:08Z` (904 series written). **No Hurst code, κ, reading or outcome had been computed or opened.** The driver never reads a fetch whose log is not `complete` (§3.2b). The partial run dir is kept, unread, as `EDGE-HURST-DISCRIMINATION-PROBE-W1-run-2026-09-22-fetch1-aborted/`.
   - **Checked on the partial fetch before the fix (bar counts only, no codes).** Every other venue behaved as registered: the paging venues and HL at K = 35, MEXC 19, the latest-only venues 9, and HL xyz routing correct. The only defect was the regex.
   - **The fix (fetch v3.2).** Detection is by type (§3.3), and the wrapper's HTTP-layer ban set is the source of truth. It is proven on the v3.2 mocked harness (§3.3). The rider is unchanged: a real 418/429/510 still stops the venue and is never retried.
   - **Effect on the registration.** Only `INSTRUMENTS_SHA256SUMS` changes (the fetch script's hash). The plan, the design, the constants and every decision rule are unchanged. The fetch is re-taken ONCE, into a fresh run dir, anchored at that fetch's own start.
   - **Classification.** This is not a post-result respecification. It fixes an instrument defect, found and fixed before any R1 statistic existed, and the fix would have been made whatever the data held.
