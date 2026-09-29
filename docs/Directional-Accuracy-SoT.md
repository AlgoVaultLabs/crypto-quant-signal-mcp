# Directional Accuracy — Metric Source of Truth

**Wave:** EDGE-DWR-METRIC-SOT-W1 · **Status:** internal measurement layer · **Created:** 2026-07-02

> **INTERNAL-ONLY — no public surface until the claim ladder passes.**
> Every definition, column, and number in this document — and every value in the
> `directional_labels` table (including `mfe_return_pct` / `mae_return_pct`) — is the
> same data class as `outcome_return_pct`: **never** exposed via MCP, `/api/*`, landing,
> README, or any response path. Public directional/accuracy copy stays frozen (and the
> `/track-record` "Directional Accuracy" mislabel remains parked) until a defined,
> symmetric, ungameable metric produces a benchmark-positive, FDR-corrected,
> out-of-sample-stable edge. This wave builds the ruler; it does not authorize a claim.

## 0. Why this exists

PFE Win Rate (~0.92) is a *peak-favorable-excursion base rate*: it has no adverse barrier,
so an always-BUY strategy scores identically (CRYPTO-EDGE-METRIC-W1: 0/130 cells held a real
edge; AOE-OBJECTIVE-PROBE-W1: 21/21 promoted configs BUY). Before a model can *improve*
directional accuracy, directional accuracy must *exist* as a symmetric, realized, ungameable
metric. **Directional Win Rate (DWR)** is that metric. Expected baseline: **DWR ≈ benchmark
(~50%) in most/all cells — the honest zero, which is SUCCESS for this measurement wave.**

## 1. The label — symmetric triple-barrier race (per signal)

For each crypto BUY/SELL signal, race two symmetric price barriers against a vertical
(time) barrier, using candle high/low on the signal's own venue/symbol/timeframe klines.

- **Barriers:** upper/lower at `entry × (1 ± barrier_pct)`, symmetric.
- **Vertical barrier (`W`):** the signal's PUBLISHED evaluation window (identical to
  `backfill-outcomes.ts` `EVAL_CANDLES`):

  | tf | 3m | 5m | 15m | 30m | 1h | 2h | 4h | 8h | 12h | 1d |
  |----|----|----|-----|-----|----|----|----|----|-----|----|
  | W  | 12 | 12 | 12  | 8   | 8  | 6  | 6  | 4  | 4   | 3  |

  **`1m` is never labeled** — the 1m lane was retired (OPS-1M-SEED-DECOM-W1) and the 3m floor
  is permanent per the latency ruling; 1m signals are counted under coverage reason
  `timeframe_retired` and excluded from the FDR family.

- **`barrier_pct = max(τ · σ_w, 0.30%)`** (stored in **percent**). The `0.30%` floor ≈ 3×
  round-trip taker (2 × 0.05%), so a "win" is a tradeable move, not noise.
- **σ_w** = **sample** stdev (n−1) of `ln(close[t] / close[t−W])` over the trailing **60
  non-overlapping W-candle windows** ending at entry (same venue/symbol/timeframe klines).
  Fewer than **30** windows available → the label is still written with
  `low_vol_history = true` (barrier falls back to the floor) and is **excluded from cell stats**.
- **Ternary outcome (`label`):** **+1** target-touched-first · **−1** adverse-touched-first ·
  **0** timeout (neither inside `W`). Touch test uses candle **high/low**.
- **Same-candle ambiguity** (both barriers inside one candle's high–low range): **−1
  conservative** + `ambiguous_candle = true`. Ambiguity rate is reported per timeframe; any
  `3m`/`5m` cell > 10% flags a follow-up refinement wave (this wave does NOT build sub-candle
  resolution).
- **SELL races mirror** (target below entry). **HOLD excluded** (dashboard rule: Total Trade
  Calls = BUY + SELL only; HOLD is not persisted in `signals`).
- **`t_hit_candles`** = 1-indexed candle of first touch; `NULL` on timeout.
- **`mfe_return_pct` / `mae_return_pct`** are REUSED verbatim from `signals.pfe_return_pct` /
  `signals.mae_return_pct` (identical eval window; Q4 architect scope-reduction). They are
  signed **price-perspective** percentages (BUY: mfe ≥ 0, mae ≤ 0; SELL mirror). The labeler
  recomputes them from klines only for a non-fatal sanity WARN; it never fails on mismatch.

### Versioned `barrier_spec`

`tau{X.X}-floor{0.30}-v1` — the primary spec is **`tau1.0-floor0.30-v1`**; sensitivity specs
**`tau0.5-floor0.30-v1`** and **`tau2.0-floor0.30-v1`** are written from the same klines
(τ only changes `barrier_pct`). The primary drives all headline stats.

## 2. The metrics (per cell)

**Family = `timeframe × tier × confidence-bin × regime`** (reused from CRYPTO-EDGE-METRIC-W1):
- tier: `T1` (coin ∈ {BTC, ETH}) else `rest`
- confidence-bin: `c52_59` (<60) · `c60_74` (<75) · `c75_100` (≥75)
- regime: `coalesce(regime, 'none')`
- **Powered floor: `n ≥ 50` decided calls** (wins + losses; timeouts excluded).

- **`DWR = wins / (wins + losses)`**; timeout-rate reported alongside (timeouts excluded from
  the denominator).
- **Benchmarks** from the SAME windows + SAME klines: empirical always-BUY DWR + always-SELL
  DWR (**computed, not assumed complements** — timeouts + conservative ambiguity break the
  complement identity) + analytic 50% reference.
- **`Directional Edge = DWR − max(alwaysBUY, alwaysSELL)`**; Wilson 95% CI on DWR; edge CI vs
  the fixed benchmark.
- **Pesaran-Timmermann** (`edge-stats.pesaranTimmermann`) z/p per cell, computed twice:
  (a) all decided calls, (b) non-overlapping subsample (first call per symbol per window-length
  — serial-dependence control). One-sided upper p (certifies directional skill). **Constant-side
  cells** (all-BUY or all-SELL predictions) → `PT_NA_CONSTANT_SIDE` — the test is undefined by
  design; an all-BUY cell can never certify skill.
- **BH-FDR q = 0.05** across the powered family (`edge-stats.benjaminiHochberg`) + Bonferroni
  cross-check (`edge-stats.bonferroni`). Any FDR survivor → **time-split walk-forward**: first
  **70%** calendar-time (by `created_at`) train-discovery / last **30%** holdout; a cell
  survives only if it keeps the same sign **and** PT p < 0.05 in the holdout.

## 3. Single-derivation stats module

`src/scripts/edge-stats.ts` is the **one** canonical implementation of the edge/directional
statistics — a leaf module importing nothing from the project. It exports `wilsonInterval`,
`benjaminiHochberg`, `bonferroni`, `normalCdf`, `excessZP` (MOVED verbatim from
`calibration-audit.ts`, which now re-exports them — interface-preserved) plus the new
`pesaranTimmermann` and `dwrFromLabels`. E3′ (the meta-model wave) and any future AOE
promotion-gate retrofit import from here — never re-derive the math.

## 4. Gate semantics (what counts as an edge)

A cell holds a **validated** directional edge only if ALL hold on the primary spec:
1. `n ≥ 50` decided calls (powered);
2. `Directional Edge > 0` with the DWR Wilson CI separated from the benchmark;
3. PT survives BH-FDR at q = 0.05 across the family (Bonferroni cross-checked);
4. walk-forward holdout keeps the sign **and** PT p < 0.05.

Zero validated cells is the **expected** and **honest** baseline for the current engine and
counts as SUCCESS for this wave. No public claim, version bump, or copy change is authorized by
a green result here — that is a separate, Mr.1-gated remediation wave.

## 5. `-v2` — the corrected race window (EDGE-LABELER-RACE-WINDOW-V2-W1)

**Why a new version.** The `-v1` labeller (`backfill-directional-labels.ts`, since `20129e14`) extended its
per-group candle cache from `coveredUntil + tf`, where `coveredUntil` is off the candle grid (`created_at` is
arbitrary seconds), so the one candle opening inside that step was never fetched; the race then scanned the
first W cached candles BY INDEX, skipping the missing candle and running past its vertical barrier. The same
holes sat in later rows' σ history, and finer-served pairs lost a candle per page boundary. A material share of
the `-v1` corpus is affected (measured label-free; prevalence classes and figures in the private vault record —
this public doc carries none). `-v1` labels are **never edited**: the corrected race is a new version written
**beside** them, and every consumer migrates by its own wave.

**Definition — same formula, corrected inputs.** Barriers `max(τ · σ_w, 0.30%)`, the σ formula, the −1
same-candle rule, the floor and `W` are exactly §1's. What changes is how the window and the σ history are
taken:

- **Window by time on the served grid.** The race runs on the candle interval the venue actually SERVES for the
  timeframe (30 venue × timeframe pairs are fetch-and-relabel, e.g. 2h served as 1h candles, 3m as 5m). The
  window is the first served candle opening in `[entry, entry + step)` — anchored on the data, never on
  `ceil(entry / step) · step`, because some venues' daily and 12-hour candles open on UTC+8 boundaries — and the
  next W−1 served candles, each exactly one step apart. The vertical barrier is the close of candle W−1.
- **All W or no row.** A window with any missing candle is **refused** — no `-v2` row is written (a label-0 row
  would read as a timeout to every consumer), and the refusal is counted per run. A window that had not closed
  when its candles were fetched (`entry + (W+1)·step` after the fetch) is **deferred** — no row, and retried
  under the retry contract below.
- **σ on a gap-free history.** σ_w uses §1's formula over the contiguous run of served candles ending just before
  the window; fewer than 30 contiguous windows ⇒ **no `-v2` row** (`unreachable:history`), never a floor-barrier
  `low_vol_history` row.
- **Coarser-served pairs** (the served candle is coarser than the timeframe) race W **served** candles, a longer
  horizon than `-v1`, which raced a window cut at `(W+2)·requested` and could only ever write decided labels
  there. Readings on these pairs are reported apart, never pooled with same-grid cells.
- **Specs:** `tau1.0-floor0.30-v2` (primary) · `tau0.5-floor0.30-v2` · `tau2.0-floor0.30-v2`. The nightly writes
  `-v2` for the signals whose `-v1` attempt the same run completes: a written `-v1` row, or — on a coarser-served
  pair — a `-v1` timeout its cut window cannot write, so `-v2` there is never limited to decided outcomes. Such a
  `-v2` row has no `-v1` twin: it is a named, counted class (`V2_NO_V1_TWIN`), written once, and never an input
  to any `-v1`/`-v2` comparison. History is filled by a separate bounded relabel. `mfe_return_pct` /
  `mae_return_pct` and `ret_at_expiry_pct` carry the same values as the `-v1` twin.

**Retry contract.** A `-v2` window that has not closed is retried, never dropped. On a coarser-served pair `-v1`
is due at `(W+1)·requested` but the `-v2` window closes at `(W+1)·served`; a signal in between is **held back
whole** — neither version is written — and the first run after its window closes writes both (`V2_HELDBACK
pending` counts the signals held back in a run; `released` is a clock estimate of those a nominal previous
nightly held back, not a record). The hold-back waits on the clock only: a refused `-v2` window never delays or
removes the `-v1` row. A held-back `-v1` row is computed by the unchanged `-v1` rule in the run that writes it —
from that run's fetch extents and the candles then in hand — so its values can differ from what the run it was
held back from would have written (a `ret_at_expiry_pct` that run would have left empty is filled, for one). The
instant `-v1` becomes writable moves by the pair's **coarser `-v1` lag** `(W+1)·(served − requested)`; rows land
at a nightly, so the row lands at most `⌈lag / 24 h⌉` nightlies later — a per-pair bound, not a constant:

<!-- coarser-v1-lag:begin (must equal renderCoarserV1LagTable() in src/scripts/backfill-directional-labels.ts; tests/unit/lrw-race-window-v2.test.ts fails otherwise — change the code, then paste its output here) -->
| Venue | Timeframe | Served candle | Coarser `-v1` lag | Nightlies late, at most |
|---|---|---|---|---|
| GATE | 3m | 5m | 26 min | 1 |
| MEXC | 3m | 5m | 26 min | 1 |
| PHEMEX | 3m | 5m | 26 min | 1 |
| PHEMEX | 12h | 1d | 3600 min | 3 |
| HTX | 3m | 5m | 26 min | 1 |
| WEEX | 3m | 5m | 26 min | 1 |
| XT | 3m | 5m | 26 min | 1 |
| WHITEBIT | 3m | 15m | 156 min | 1 |
| WHITEBIT | 5m | 15m | 130 min | 1 |
<!-- coarser-v1-lag:end -->

**Provenance column `race_gap_candles`** (migration 045): the number of served-grid slots of the row's true
W-window absent from the candles it was raced on — NULL = not annotated; historical `-v1` rows carry a label-free
replay's lower bound; rows the corrected labeller writes carry the live count (expected 0); `-v2` rows are 0 by
construction.

**`-v1` from the same corrected cache.** After this change the nightly `-v1` rows come from the corrected cache
too (the hole is a bug, never reproduced on purpose), clipped to the union of `-v1`'s own requested fetch extents
so its definition — including the cut window on coarser-served pairs — does not move. The deprecation notice and the consumer
migration table are added with the consumer registry.
