# EDGE-SR-LEVEL-PROBE-W1 — pre-registration: does a support/resistance level inside a call's own target separate its outcome?

Written 2026-11-10 (UTC) and last regenerated 2026-11-11T02:39Z, before any outcome query. Internal META research: zero public surface, zero scoring or serving change, nothing shipped, no edge claim, no tuning after data, TREND_MODE untouched. This file carries methodology and label-free cardinalities only; every outcome figure goes to the private vault and never into this repository.

Procedure: `audits/PREREGISTRATION-PROCEDURE.md` §1–§9. Wave spec: `Prompt/EDGE-SR-LEVEL-PROBE-W1.md` (planning vault).

## 0. What is tested, in one paragraph

On calls `get_trade_call` already emitted, a frozen level rule (Level v0, §4.2) marks each call OPPOSING when a qualifying support/resistance level sits strictly between its entry and its target barrier, and CLEAR otherwise. The one primary question (H1) is whether CLEAR calls carry a larger excess over the mix-matched null than OPPOSING calls, by at least +3.0pp, in the 1h, 2h, 4h, 8h and 12h cells. Three secondary hypotheses (H2–H4) ask whether the separation grows with distance, beats a naive 50-bar comparator, and whether a level behind the entry helps. The corpus is bounded at `T_DIAG_END`; the window after it is this study's forward test (§9). A PASS decides only that an arc is worth chartering.

## Architect rulings (Plan Mode, 2026-11-10) — verbatim

These override the wave-spec text copied in §4 wherever they differ.

> ⚖️ **PLAN-MODE RULINGS 2026-11-10 (architect, /a on R0 Q1–Q4) — these override the text below wherever they differ.**
> - **Q1 = A:** corpus bound = `T_DIAG_END` (1790402400; the B-DIR v3 FULL seal holds until `SEAL_LIFT` 2027-01-17T10:00Z); cells = timeframe only; hold-out = the 13 UTC days after the median day. The sealed window (T_DIAG_END, T_REG] is this study's forward test: successor `EDGE-SR-LEVEL-PROBE-W2`, not before SEAL_LIFT, named in registration §9.
> - **Q2 = A:** L2/L3 by served step (`servedIntervalMs`); a layer with no served interval is absent; the per-venue table is registered verbatim.
> - **Q3 = B:** +3.0pp and the house estimand kept; primary = cells with BUY share ≤ 0.80 (1h, 2h, 4h, 8h, 12h), the rest descriptive; §5 registers each cell's raw side-conditional equivalent of +3.0pp and the power; a NULL reads "no ≥ 3.0pp excess lever in the 1h–12h cells at this side mix", never "S/R closed".
> - **Q4 = A:** both signal-1 reads approved; CH2's runs only after the registration is on origin/main.
> - **Corrections accepted:** `Arm` + the gate's bootstrap call, parity-tested against `per_day`; `runAsCaller('sr-level-probe', fn)`; T_FLIP 1788169595; entry = `signals.price_at_signal`; no candle store; a cell-day is absent when an arm is empty or under 30 scored rows; BITGET 2h/8h L1 = the 1H/6H bars. CH3 opens: PASS → ARCHITECT "charter ARC-SR-LEVELS (Mr.1); T1 = W2"; INDETERMINATE → OWED "W2 after SEAL_LIFT"; NULL → no row.

## 1. Ordering (PROCEDURE §1)

- This file lands on `origin/main` before the label statement runs. `scripts/sr-probe/sr-pull.sh --part labels` refuses unless `--registration <sha>` is an ancestor of `origin/main`, that commit adds this file, and its commit time precedes the pull. `T_REG` is that commit's committer time.
- Before this file landed, only the reads in §2 were made. None selected `label`, `ambiguous_candle`, a hit time, a return or any rate. The label-free statement's column list is parsed from the generator's executed output by `tests/unit/sr-level-v0.test.ts` (AC1.4) and holds none of `label, ambiguous_candle, t_hit_candles, mfe_return_pct, mae_return_pct, ret_at_expiry_pct, race_gap_candles`.
- The feature file for the primary cells, both session scripts, the level rule, the feature builder, the fetch plan and the analysis harness are pinned by sha256 in §10. `tests/unit/sr-level-v0.test.ts` fails if any pinned file stops matching the hash written here.

## 2. Prior-examination disclosure (PROCEDURE §2)

| what was seen | when (UTC) | class |
|---|---|---|
| Two `BEGIN READ ONLY` sessions as `aoe_readonly` (Plan Mode): row counts, `-v2` primary-row presence, distinct coins and UTC days, BUY counts, `rule_config_id` nullness, `price_at_signal` validity, per-series bar spans — on this corpus and, as counts only, on the sealed window above `T_DIAG_END` | 2026-11-10 14:18, 14:20 | cardinality · coverage ratio |
| 14 public kline requests for BTC from the operator's machine (does history reach back far enough) | 2026-11-10 ~14:20 | seen — not a test input |
| A simulation, with no data, of the per-day excess's small-arm behaviour under no effect | 2026-11-10 ~14:25 | seen — not a test input |
| The label-free extract: 92,951 rows, columns `id, created_at, exchange, coin, timeframe, side, entry, rule_config_id, barrier_pct, low_vol_history`, and the coverage counts (`registered`, `v1_present`, `v2_present`, `v2_post_adapter`) | 2026-11-10T16:00:36Z | cardinality · coverage ratio; `entry`, `barrier_pct` and `low_vol_history` are fixed when the call is made and are the test's INPUTS, not outcomes — the procedure's classes do not name this case, so it is disclosed here as such |
| Closed candles through the venue adapters' `getCandles` (caller `sr-level-probe`), and from them each primary-cell call's Level-v0 features: arm membership, arm sizes, arm side mix, cell-day sizes | 2026-11-10 16:01 – 16:41 | cardinality (arm sizes and side shares); the candles are the test's inputs |
| The descriptive cells' candles through the same adapters, and the descriptive feature file built from them; of that file only the row count and the status tally (resolved, unresolved by name, not sampled) were read | 2026-11-10 16:41 – 17:12 | cardinality; the candles are the test's inputs |
| A dry run of the feature builder on a partial candle store, and a run of the analysis harness on SYNTHETIC labels drawn at random (no stored label), to exercise the code | 2026-11-10 16:24 – 16:31 | seen — not a test input |
| What earlier registered waves read on rows of this window: pooled directional outcome aggregates (the attempts the wave spec cites as finding no directional edge, among them B-DIR v3's diagnostic window, which ends at `T_DIAG_END`). None conditioned on a price-level feature; no level feature existed in this repository before this wave | before this wave | inherited |

The inherited pooled result (no directional edge) is why the estimand is an excess over the mix-matched null and why §7 states a low expectation. No outcome conditional on any Level-v0 stratum has been computed by anyone.

## 3. Corpus — literal predicate, closed by a clock (PROCEDURE §3)

Emitted BUY/SELL calls on BINANCE, BYBIT, OKX and BITGET, created after `T_FLIP = 1788169595` (2026-08-31T09:46:35Z), carrying a `tau1.0-floor0.30-v2` label row, under the max-form `T_CAP` at `T_DIAG_END = 1790402400` (2026-09-26T06:00:00Z). The label-free session, exactly as run (2026-11-10T16:00:36Z), printed by `npx tsx src/scripts/sr-probe/sr-extract-sql.ts --part labelfree`; its sha256 is in §10:

```sql
\set ON_ERROR_STOP 1
SET statement_timeout = '900s';
SET TIME ZONE 'UTC';
SET DateStyle = 'ISO, YMD';
BEGIN READ ONLY;
SELECT 'TOKEN current_user=' || current_user || ' transaction_read_only=' || current_setting('transaction_read_only');
\echo '===COVERAGE==='
COPY (
  SELECT s.exchange, s.timeframe, count(*)::bigint AS registered,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM directional_labels v1 WHERE v1.signal_id = s.id AND v1.barrier_spec = 'tau1.0-floor0.30-v1'))::bigint AS v1_present,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM directional_labels v2 WHERE v2.signal_id = s.id AND v2.barrier_spec = 'tau1.0-floor0.30-v2'))::bigint AS v2_present,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM directional_labels v2 WHERE v2.signal_id = s.id AND v2.barrier_spec = 'tau1.0-floor0.30-v2' AND v2.computed_at >= to_timestamp(1790864836)))::bigint AS v2_post_adapter
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('PHEMEX', '3m', 300), ('PHEMEX', '12h', 86400), ('HTX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.created_at > 1788169595
    AND s.signal IN ('BUY', 'SELL')
    AND s.exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET')
  GROUP BY 1, 2
  ORDER BY 1, 2
) TO STDOUT WITH (FORMAT csv, HEADER);
\echo '===EXTRACT==='
COPY (
  SELECT s.id, s.created_at, s.exchange, s.coin, s.timeframe, s.signal AS side, s.price_at_signal AS entry,
         s.rule_config_id, d.barrier_pct, d.low_vol_history
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('PHEMEX', '3m', 300), ('PHEMEX', '12h', 86400), ('HTX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = 'tau1.0-floor0.30-v2'
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.created_at > 1788169595
    AND s.signal IN ('BUY', 'SELL')
    AND s.exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET')
  ORDER BY s.id
) TO STDOUT WITH (FORMAT csv, HEADER);
COMMIT;
```

The label session CH2 runs once this file is on `origin/main` (`--part labels`; sha256 in §10) — the same predicate, selecting the label columns:

```sql
\set ON_ERROR_STOP 1
SET statement_timeout = '900s';
SET TIME ZONE 'UTC';
SET DateStyle = 'ISO, YMD';
BEGIN READ ONLY;
SELECT 'TOKEN current_user=' || current_user || ' transaction_read_only=' || current_setting('transaction_read_only');
\echo '===LABELS==='
COPY (
  SELECT d.signal_id, d.label, d.ambiguous_candle, d.barrier_spec
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('PHEMEX', '3m', 300), ('PHEMEX', '12h', 86400), ('HTX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = 'tau1.0-floor0.30-v2'
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.created_at > 1788169595
    AND s.signal IN ('BUY', 'SELL')
    AND s.exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET')
  ORDER BY d.signal_id
) TO STDOUT WITH (FORMAT csv, HEADER);
COMMIT;
```

- **Closed.** Both bounds are fixed integers, and the row set is the 92,951 ids of the extract pinned in §10. A label row for an id outside the extract is ignored and counted; an extract id with no label row at the pull is counted and not scored.
- **Corpus days.** The 27 UTC days 2026-08-31 … 2026-09-26, fixed by the two clocks. Hold-out = the 13 UTC days after the median day (2026-09-13): 2026-09-14 … 2026-09-26.
- **Cells = timeframe.** `rule_config_id` is NULL on every row of the extract (92,951 of 92,951), so the cell key's second part is a constant.
- **Not read.** Rows with `created_at > T_DIAG_END` are another study's sealed hold-out until `SEAL_LIFT = 1800180000` (2027-01-17T10:00:00Z): counts only, no label value. They are W2's corpus (§9).

Coverage chain on this corpus, from the session's `===COVERAGE===` statement (label-row presence only; the per-timeframe table is printed with the findings). `T_ADAPTER = 1790864836`:

| venue | emitted calls in the window (`registered`) | with a `-v1` row | with a `-v2` row | `-v2` row computed at or after `T_ADAPTER` |
|---|---|---|---|---|
| BINANCE | 23,465 | 23,465 | 23,176 | 23,176 |
| BITGET | 32,887 | 32,869 | 32,289 | 32,227 |
| BYBIT | 19,893 | 19,893 | 19,574 | 19,574 |
| OKX | 18,201 | 18,199 | 17,912 | 17,910 |
| all four | 94,446 | 94,426 | 92,951 | 92,887 |

## 4. Methodology

### 4.1 The wave spec's Rulings, Level v0, Hypotheses and Verdict — verbatim

Copied from `Prompt/EDGE-SR-LEVEL-PROBE-W1.md` as written by the architect on 2026-11-10. The Plan-Mode rulings above override them where they differ (the corpus bound, the cell key, the layer ladder, the NULL wording, the `Arm` construction, the candle source).

#### Rulings (Cowork, 2026-11-10)

1. **Estimand = the house comparator.** Excess over the mix-matched null from `population_comparison.Arm` counts, per UTC day, interval by `cluster_bootstrap_ols` (`src/scripts/cluster-perm-stats.py`), bound exactly as `ops/monitoring/verdict-rule-gate.py` binds them (`per_day`). Import; never a second formula. Identifiability through `ops/monitoring/population_comparison.py --declarations`.
2. **Labels.** `directional_labels`, spec `tau1.0-floor0.30-v2` (literal from `BARRIER_SPECS_V2`, `src/scripts/directional-labeler.ts`); barrier = the row's own `barrier_pct`. Drop `ambiguous_candle` and `low_vol_history` rows. Denominator ALL_SCORED (timeouts counted, in no win bucket); decided-only reported beside it.
3. **Arm counts per row.** engine win = `label = +1`; long win = up-first (BUY∧+1 or SELL∧−1); short win = down-first; buy_side = BUY.
4. **Corpus.** Emitted BUY/SELL calls on BINANCE·BYBIT·OKX·BITGET, created after the TREND_MODE flip (re-pin the instant; Cowork memory says 2026-08-31T09:46:35Z), carrying a `-v2` primary row, under a max-form T_CAP at the freeze (the form `src/scripts/ads1/extract-sql.ts` emits). Cells = timeframe × `rule_config_id` (never the version value). Print ADS-1's coverage chain.
5. **Read path = ADS-1's** (`scripts/ads1/ads1-pull.sh` pattern): ssh → `docker exec psql -U aoe_readonly`, `BEGIN READ ONLY`, allow-list SELECT, sha256 → Mac scratch → local compute → vault audit. Candles: the adapters' `getCandles` run on the Mac from the worktree (caller `sr-level-probe`, closed candles only; no production venue budget), or a persisted candle store R0 finds (recorded). Over 20k requests per venue → the registration draws a seeded, venue-stratified coin sample at 2× the §5 floor, before any label read.

#### Level v0 (frozen; no tuning)

- **Timeframes per call:** L1 = the call's; L2, L3 = the smallest venue-served interval ≥ 4× and ≥ 16× it (`src/lib/adapters/_interval.ts`), capped at 1w.
- **History:** closed candles of each L with close ≤ the call's `created_at`; the last 300 bars.
- **Pivot:** bar i is a swing high if high_i ≥ every high in i−3…i+3, a swing low if low_i ≤ every low there; usable only once bar i+3 has closed.
- **Level:** per timeframe, all pivot prices (highs and lows together) sorted and single-link merged while the gap ≤ 0.25·ATR14 (Wilder, that timeframe, as-of); price = member median; touches = members; qualifying = touches ≥ 2; strength = Σ member weights (L1 1 · L2 2 · L3 3), strong ≥ 4.
- **Per call, side-relative** (entry = the price the labeler raced from; R0 names the column): **OPPOSING** = a qualifying level strictly between entry and the target barrier, else **CLEAR**; f = nearest opposing distance ÷ barrier distance; **BEHIND** = a qualifying level within 0.25 barrier distance on the stop side.
- **Naive comparator:** L1's 50-bar highest high (BUY) or lowest low (SELL) inside the target = NAIVE-OPPOSING.

#### Hypotheses (registered; signs expected)

| ID | Contrast | Floor | Role |
|---|---|---|---|
| H1 | excess(CLEAR) − excess(OPPOSING) | +3.0pp | primary |
| H2 | excess across f ∈ (0,⅓], (⅓,⅔], (⅔,1], CLEAR | slope > 0 | secondary |
| H3 | H1's Δ minus the same Δ for NAIVE-OPPOSING | +1.0pp | secondary |
| H4 | excess(BEHIND) − excess(not BEHIND) | +3.0pp | secondary |

H2–H4 under BH-FDR q = 0.10 (`bh` in cluster-perm-stats). Descriptive, no floor: P(decided) per arm (PROCEDURE §2 disclosure); within-side up-rates; strong vs weak opposing; per cell; cross-venue: the share of opposing levels within 0.25·ATR of a level on another venue's candles, same coin (coins pulled on ≥ 2 venues).

#### Verdict

- Daily Δ per cell → scored-weighted mean over the cells present that day → `cluster_bootstrap_ols` intercept on UTC-day clusters, B = 2000, seed registered.
- **PASS** — 95% lower bound > 0, point ≥ +3.0pp, and the same sign on the hold-out (the UTC days after the corpus's median day, fixed by cardinality).
- **NULL** — upper bound < +3.0pp (a reversal, upper bound < 0, is a NULL that names it).
- **INDETERMINATE** — anything else, cause named: < 20 day clusters (schema `min_clusters`), a NOT_IDENTIFIABLE arm, a hold-out sign flip, or an interval holding +3.0pp with lower bound ≤ 0; state what resolves it.
- Identifiability: per arm m = min(q, 1−q), one §4c row per arm; cells where an arm's 2m < 3.0pp are dropped before registering, and listed.
- PASS only decides that the arc is worth chartering. H3 < +1.0pp means the arc builds the naive feature first.

### 4.2 How each frozen line is read — fixed here, before any label

The implementation is `src/scripts/sr-probe/level-v0.ts` at the hash in §10; its known-answer fixtures (AC1.1), its mirror property on the fixtures and 200 seeded random walks (AC1.2) and its two mutants (AC1.3: one bar of look-ahead; k = 2) are `tests/unit/sr-level-v0.test.ts`. Where the frozen text leaves a choice, the reading is:

- **Layers by served step (Q2).** L1 is the series `getCandles` returns for the call's timeframe key. L2 and L3 are the smallest interval the venue serves whose served step is at least 4× and 16× L1's served step; a layer with no such interval is absent for that timeframe. The registered ladder (`step:key` where the served step differs from the key):

| call timeframe | BINANCE | BYBIT | OKX | BITGET |
|---|---|---|---|---|
| 3m | 3m · 15m · 1h | 3m · 15m · 1h | 3m · 15m · 1h | 3m · 15m · 1h |
| 5m | 5m · 30m · 2h | 5m · 30m · 2h | 5m · 30m · 2h | 5m · 30m · 4h |
| 15m | 15m · 1h · 4h | 15m · 1h · 4h | 15m · 1h · 4h | 15m · 1h · 4h |
| 30m | 30m · 2h · 8h | 30m · 2h · 12h | 30m · 2h · 12h | 30m · 4h · 12h |
| 1h | 1h · 4h · 1d | 1h · 4h · 1d | 1h · 4h · 1d | 1h · 4h · 1d |
| 2h | 2h · 8h | 2h · 12h | 2h · 12h | 1h:2h · 12h |
| 4h | 4h · 1d | 4h · 1d | 4h · 1d | 4h · 1d |
| 8h | 8h | not served (no call in the corpus) | not served (no call in the corpus) | 6h:8h |
| 12h | 12h | 12h | 12h | 12h |
| 1d | 1d | 1d | 1d | 1d |

- **BITGET `2h` and `8h`.** L1 is what `getCandles` returns for the key: 1H and 6H bars, the series the labeler raced on. No interval is invented.
- **As-of.** A bar is visible to a call only when its close time (open + served step) is ≤ the call's `created_at`. The last 300 visible bars are used; fewer than 300 → all available (1,184 of the 23,165 eligible primary-cell calls have fewer than 300 L1 bars; 0 have a gap inside the L1 window).
- **Pivot.** k = 3, ties allowed (≥ / ≤), usable only once bar i+3 is visible.
- **Level.** Per layer, highs and lows together, sorted, single-link merged while the gap ≤ 0.25 × ATR14 (Wilder, on that layer's visible bars); price = member median; touches = members; qualifying = touches ≥ 2. A layer with fewer than 15 visible bars seeds no ATR14 and contributes no level. Strength of a level = touches × its layer's weight (L1 1, L2 2, L3 3); strong = strength ≥ 4.
- **Entry and barriers.** entry = `signals.price_at_signal`. Barrier distance D = entry × `barrier_pct` / 100 (the label row's own percentage). Target barrier = entry + D for BUY, entry − D for SELL; the stop side is the mirror.
- **OPPOSING / CLEAR.** OPPOSING = a qualifying level at distance d from entry on the target side with 0 < d < D. f = the nearest such d ÷ D. Bins: F1 = f ≤ ⅓, F2 = ⅓ < f ≤ ⅔, F3 = f > ⅔, CLEAR = no opposing level.
- **BEHIND.** A qualifying level on the stop side with 0 < d ≤ 0.25 × D.
- **NAIVE-OPPOSING.** The highest high (BUY) or lowest low (SELL) of the last 50 visible L1 bars lies strictly inside the target (0 < d < D).
- **Resolved calls.** A call is used only when every layer its ladder gives it was fetched and is current: the newest visible bar closed less than two served steps before the call. A layer that is missing, failed, or has no visible bar at the call is never read as "no level there" — the call is dropped by name (`unresolved_missing_L<n>`, `unresolved_failed_L<n>`, `unresolved_stale_L<n>`). The counts are in §5.
- **Candle reads.** There is no persisted candle store; every bar comes from the adapters' `getCandles` on the operator's machine, paged forward, under caller `sr-level-probe`. A window that holds no bar (a listing younger than the window) is stepped over, never read as the end of the series.
- **Request cap and the coin sample.** Planned requests per venue: BINANCE 8,050 · BITGET 16,070 · BYBIT 7,180 · OKX 23,874. Only OKX exceeds 20,000. Every coin that appears in a primary cell is kept; the venue's remaining coins are shuffled with seed 20261110 and kept in that order while the venue stays within 20,000 requests: 70 of OKX's 95 coins kept, 4,189 OKX calls marked `not_sampled`, all of them in descriptive cells. No primary-cell call is sampled out on any venue (`src/scripts/sr-probe/plan.ts`, pinned in §10).

### 4.3 The statistic

`scripts/sr-probe/sr_analyze.py` at the hash in §10. It imports `Arm` and `declaration_identifiability` from `ops/monitoring/population_comparison.py` and `cluster_bootstrap_ols`, `bh`, `ols` and `arm_seed` from `src/scripts/cluster-perm-stats.py`; it holds no second formula. Its self-test pins `Arm.excess_pp / 100` to `ops/monitoring/verdict-rule-gate.py` `per_day` on a fixture, and is proven able to fail by two mutations (`SR_ANALYZE_MUTATE=swap_wins`, `no_min_arm`).

- **Rows.** Resolved calls, `low_vol_history` rows dropped (label-free), then `ambiguous_candle` rows dropped at the label read (counted). Denominator ALL_SCORED: a timeout (label 0) is scored and sits in no win bucket. Decided-only is reported beside it and decides nothing.
- **Arm counts (Ruling 3).** engine win = label +1; long win = up-first (BUY∧+1 or SELL∧−1); short win = down-first; buy side = BUY. The arm's excess is `Arm.excess_pp`.
- **Cell-day.** For each UTC day and cell, each arm's excess from that cell-day's own counts. A cell-day is ABSENT, never zero, when either arm has fewer than 30 scored rows.
- **Day value.** The scored-weighted mean of the cell-day contrasts over the cells present that day (weight = the two arms' scored rows).
- **Estimate and interval.** The intercept of `cluster_bootstrap_ols` on the day values with UTC-day clusters, B = 2000, seed `arm_seed('EDGE-SR-LEVEL-PROBE-W1', '<hypothesis>')`: H1 2549352157 · H2 2736252770 · H3 936459194 · H4 4048077432. The 95% interval is the bootstrap's percentile interval.
- **H1.** excess(CLEAR) − excess(OPPOSING) per cell-day.
- **H2.** Per cell-day, the OLS slope of bin excess on the bin index (F1 = 1, F2 = 2, F3 = 3, CLEAR = 4) over the bins with at least 30 scored rows; at least two bins, else absent. Units: pp per step.
- **H3.** H1's contrast minus excess(not NAIVE-OPPOSING) − excess(NAIVE-OPPOSING), on cell-days where both are present.
- **H4.** excess(BEHIND) − excess(not BEHIND) per cell-day.
- **Secondary p-values.** One-sided: the share of bootstrap draws ≤ 0, floored at 1 / (draws + 1). H2, H3 and H4 go through `bh` at q = 0.10 together.
- **Hold-out.** The mean of the day values over the hold-out days that are present.
- **Descriptive, no floor, deciding nothing.** P(decided) per arm; within-side up-rates; weak versus strong opposing; the H1 pipeline per cell, including the 3m, 5m, 15m, 30m and 1d cells; the NAIVE contrast alone; the share of opposing levels with a qualifying level within 0.25 × ATR on another venue's candles for the same coin, layer and served step.

### 4.4 What the design drops, and its behaviour with no effect

- **Dropped cell-days.** By call count (an upper bound on scored rows), H1 has 74 cell-days present and 52 absent over the primary cells; 2,385 of the 23,165 eligible calls sit in absent cell-days. Per cell (present / absent): 1h 25/1 · 2h 25/1 · 4h 19/7 · 8h 4/20 · 12h 1/23. The label read can only move a cell-day from present to absent.
- **Coverage loss, descriptive cells.** 580 descriptive-cell calls are `unresolved_failed_L1`: three BYBIT series — XAUT 3m (217 calls) · AVAX 5m (193 calls) · SOL 5m (170 calls) — failed on both fetch runs with venue error 10016 ("svc error: Get kline failed"). The architect accepted them as coverage loss (2026-11-11); no further retry is made. They are dropped by name like every unresolved call. A 3m or 5m series is read only by 3m and 5m calls, so no primary cell is affected. With the 4,189 `not_sampled` OKX calls of §4.2, 65,014 of the 69,783 descriptive-cell calls are resolved.
- **Small-arm shrink.** `Arm.excess_pp` is a within-arm covariance from counts, so its expectation is (n − 1)/n of the true excess: at the 30-row minimum each arm's excess is shrunk toward zero by at most 3.3%. It cannot create a contrast where none exists.
- **Simulated with no effect.** With outcomes simulated on the real label-free skeleton and no effect injected (1,000 runs), the design's mean H1 estimate is +0.03pp (standard deviation across runs 0.62pp) and it returns PASS in 0.0% of runs. Details and the instrument are in §5.

## 5. Floors and power (PROCEDURE §5)

**Cluster floor.** 20 UTC-day clusters (`min_clusters`). The corpus has 27 days; by call count H1 has 25 days with at least one present cell-day, of which 12 are hold-out days. Fewer than 20 scored day clusters is the registered INDETERMINATE.

**Calls and resolution, primary cells** (label-free; `low_vol_history` rows are dropped from the resolved calls to give the eligible calls):

| cell | calls in the extract | resolved | unresolved (by name) | `low_vol_history` dropped | eligible |
|---|---|---|---|---|---|
| 1h | 10,213 | 10,213 | 0 | 0 | 10,213 |
| 2h | 6,197 | 6,194 | unresolved_stale_L2 3 | 0 | 6,194 |
| 4h | 4,262 | 4,262 | 0 | 0 | 4,262 |
| 8h | 1,218 | 1,218 | 0 | 0 | 1,218 |
| 12h | 1,278 | 1,278 | 0 | 0 | 1,278 |
| all primary | 23,168 | 23,165 | 3 | 0 | 23,165 |

**Side mix and the raw equivalent of +3.0pp (Q3).** With no timeouts `Arm` excess = 2q(1 − q) × [P(up | BUY) − P(up | SELL)], so a +3.0pp excess contrast needs a between-arm difference of 3.0 / (2q(1 − q)) pp in that side-conditional separation. Primary cells from the eligible resolved calls; descriptive cells from the extract's calls:

| cell | role | calls | BUY share q | 2q(1 − q) | between-arm side-conditional difference equal to +3.0pp excess (pp) |
|---|---|---|---|---|---|
| 3m | descriptive | 18,292 | 0.954 | 0.088 | 34.0 |
| 5m | descriptive | 23,692 | 0.962 | 0.073 | 41.0 |
| 15m | descriptive | 14,016 | 0.906 | 0.170 | 17.7 |
| 30m | descriptive | 13,353 | 0.871 | 0.224 | 13.4 |
| 1h | primary | 10,213 | 0.772 | 0.352 | 8.5 |
| 2h | primary | 6,194 | 0.751 | 0.374 | 8.0 |
| 4h | primary | 4,262 | 0.763 | 0.362 | 8.3 |
| 8h | primary | 1,218 | 0.741 | 0.383 | 7.8 |
| 12h | primary | 1,278 | 0.830 | 0.282 | 10.6 |
| 1d | descriptive | 430 | 0.988 | 0.023 | 130.5 |

**Arm sizes, primary cells** (eligible calls; `q` = the arm's BUY share):

| cell | CLEAR n (q) | OPPOSING n (q) | F1 n (q) | F2 n (q) | F3 n (q) | BEHIND n (q) | NAIVE-OPPOSING n (q) | OPPOSING-STRONG n (q) |
|---|---|---|---|---|---|---|---|---|
| 1h | 3,743 (0.775) | 6,470 (0.771) | 3,517 (0.742) | 1,966 (0.816) | 987 (0.783) | 2,723 (0.746) | 6,828 (0.727) | 5,733 (0.783) |
| 2h | 3,239 (0.771) | 2,955 (0.729) | 1,612 (0.718) | 871 (0.761) | 472 (0.706) | 1,414 (0.760) | 3,885 (0.678) | 2,237 (0.752) |
| 4h | 2,006 (0.759) | 2,256 (0.766) | 1,244 (0.740) | 674 (0.789) | 338 (0.811) | 1,079 (0.753) | 2,900 (0.695) | 1,734 (0.800) |
| 8h | 802 (0.747) | 416 (0.731) | 219 (0.744) | 125 (0.696) | 72 (0.750) | 198 (0.697) | 799 (0.652) | 160 (0.775) |
| 12h | 897 (0.838) | 381 (0.811) | 214 (0.813) | 119 (0.815) | 48 (0.792) | 196 (0.837) | 805 (0.770) | 132 (0.879) |
| all primary | 10,687 | 12,478 | 6,806 | 3,755 | 1,917 | 5,610 | 15,217 | 9,996 |

**Usable cell-days per hypothesis** (by call count, an upper bound):

| hypothesis | UTC days with a present cell-day | of them hold-out days | cell-days present | cell-days absent | present / absent per cell (1h · 2h · 4h · 8h · 12h) |
|---|---|---|---|---|---|
| H1 | 25 | 12 | 74 | 52 | 25/1 · 25/1 · 19/7 · 4/20 · 1/23 |
| H2 | 24 | 12 | 61 | 65 | 24/2 · 23/3 · 14/12 · 0/24 · 0/24 |
| H3 | 24 | 12 | 68 | 58 | 24/2 · 24/2 · 17/9 · 2/22 · 1/23 |
| H4 | 24 | 12 | 57 | 69 | 24/2 · 19/7 · 14/12 · 0/24 · 0/24 |

**Standard error, lower bound.** Instrument: `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities` (`se_instrument`), the worst-case binomial variance q(1 − q)/n per arm combined exactly as the statistic combines cell-days. On the skeleton it gives a standard error of at least 0.66pp for H1 (95% half-width at least 1.30pp). It holds no between-day variance of the true contrast, so the realised interval can only be wider.

**Simulated behaviour of the design.** Instrument: `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities --sims 1000` (`simulate`): outcomes drawn on the real label-free skeleton, the tape's up-share drawn per day in [0.30, 0.60], 10% timeouts, no skill except an injected lift on CLEAR calls sized to the stated excess at each cell's pooled CLEAR side mix; each run through the H1 pipeline and the §6 rule with B = 400 (the registered read uses B = 2000). A day's own side mix differs from the pooled one and 2q(1 − q) is concave, so the day-level estimand sits under the injected figure; the mean estimate column is what the design returns.

| injected CLEAR excess at the pooled mix (pp) | runs | mean estimate (pp) | sd across runs (pp) | PASS | NULL | INDETERMINATE |
|---|---|---|---|---|---|---|
| 0.0 | 1,000 | 0.03 | 0.62 | 0.0% | 99.0% | 1.0% |
| 3.0 | 1,000 | 2.48 | 0.63 | 19.5% | 13.0% | 67.5% |
| 6.0 | 1,000 | 4.95 | 0.60 | 100.0% | 0.0% | 0.0% |

**Reading.** With no effect the design returns PASS in 0.0% of runs and NULL in 99.0%. A CLEAR lift worth +6.0pp at the pooled mix (a day-level estimate of about 4.95pp) is a PASS in 100.0% of runs. A lift worth +3.0pp at the pooled mix returns a day-level estimate of about 2.48pp — under the floor, because the floor binds the day-level estimand of §4.3 — and reads PASS 19.5%, NULL 13.0%, INDETERMINATE 67.5%: near the floor this corpus mostly cannot decide. The 8h and 12h cells carry 4 and 1 present cell-days of 74, so H1 is in effect a 1h / 2h / 4h read. In raw terms the floor asks for a between-arm side-conditional difference of the size in the side-mix table above; a smaller separation is outside what this study can attribute.

## Support stress-test (PROCEDURE §4)

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| H1 day-cluster floor | 20 UTC-day clusters | 25 of the 27 corpus days carry a present H1 cell-day by call count (an upper bound on scored rows) | inside — 5 days of margin before the label read |
| H1 hold-out sign | the 13 days 2026-09-14 … 2026-09-26 | 12 of the 13 carry a present H1 cell-day by call count | inside |
| cell-day minimum, both arms | 30 scored rows per arm | H1: 74 cell-days reach it, 52 do not (absent, never zero); 2,385 eligible calls sit in the absent ones | inside — the absent count is disclosed in §4.4 |
| primary-cell rule | BUY share ≤ 0.80 | 1h, 2h, 4h and 8h run 0.741 – 0.772; 12h is 0.830 on the registered rows | outside for 12h — kept primary by name (Q3 lists the cell); it carries 1 of the 74 H1 cell-days; §8 correction (10) |
| H1 floor against the arms' side mix | +3.0pp | smallest H1 arm bound 2m is 32.32pp (cell 12h, CLEAR) | inside |
| f bin edges | ⅓ and ⅔ of the barrier distance | F1 6,806 · F2 3,755 · F3 1,917 · CLEAR 10,687 eligible calls — every bin is populated | inside |
| H2 bins per cell-day | ≥ 2 bins at ≥ 30 rows | 61 cell-days on 24 days; the 8h and 12h cells reach it on 0 and 0 cell-days | floor — H2 is a 1h / 2h / 4h read; inside on days |
| H3 both contrasts present | 30 rows in each of four arms | 68 cell-days on 24 days; NAIVE-OPPOSING 15,217 of 23,165 eligible calls | inside |
| H4 BEHIND band | 0.25 × the barrier distance, stop side | BEHIND 5,610 of 23,165 eligible calls; 57 cell-days on 24 days; 8h and 12h reach it on 0 and 0 | floor — H4 is a 1h / 2h / 4h read; inside on days |
| strong level (descriptive) | strength ≥ 4 | 9,996 of the 12,478 OPPOSING calls have a strong opposing level; 2,482 only weak ones | inside |
| lookback | 300 visible L1 bars | 21,981 eligible calls have 300; 1,184 have fewer and use all available (smallest: 120 bars) | inside |
| ATR14 seed | 15 visible bars in a layer | 68 eligible calls have a layer under 15 bars (that layer then gives no level) | inside |
| layer currency | newest visible bar closed < 2 served steps before the call | 3 of 23,168 primary-cell calls fail it and are dropped by name | inside |
| cross-venue share (descriptive) | a level within 0.25 × ATR on another venue | 19,216 opposing levels on 10,128 calls have another venue's candles for the same coin, layer and step | inside |

## Identifiability (PROCEDURE §4c)

Every declared floor is a floor on an excess contrast between two arms, so each arm's side mix must be able to carry it. m = min(q, 1 − q) on the eligible resolved calls of the primary cells (label-free). H2's floor is +1.0pp per step, which is +3.0pp from F1 to CLEAR; its arms are sized against 3.0. No primary cell has an H1 arm whose 2m is under 3.0pp, so no cell is dropped. The same bound is recomputed on the scored rows at the read; an H1 arm that is NOT_IDENTIFIABLE there is the registered INDETERMINATE.

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| H1 — excess(CLEAR) − excess(OPPOSING), primary cells pooled | CLEAR | 0.2259 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 10,687 | 3.0 | 45.18 | IDENTIFIABLE |
| H1 — excess(CLEAR) − excess(OPPOSING), primary cells pooled | OPPOSING | 0.2403 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 12,478 | 3.0 | 48.06 | IDENTIFIABLE |
| H2 — excess across the f bins, primary cells pooled | F1 | 0.2618 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 6,806 | 3.0 | 52.36 | IDENTIFIABLE |
| H2 — excess across the f bins, primary cells pooled | F2 | 0.2053 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 3,755 | 3.0 | 41.06 | IDENTIFIABLE |
| H2 — excess across the f bins, primary cells pooled | F3 | 0.2321 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 1,917 | 3.0 | 46.42 | IDENTIFIABLE |
| H2 — excess across the f bins, primary cells pooled | CLEAR | 0.2259 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 10,687 | 3.0 | 45.18 | IDENTIFIABLE |
| H3 — H1's contrast minus the naive comparator's, primary cells pooled | NAIVE-CLEAR | 0.1197 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 7,948 | 1.0 | 23.94 | IDENTIFIABLE |
| H3 — H1's contrast minus the naive comparator's, primary cells pooled | NAIVE-OPPOSING | 0.2932 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 15,217 | 1.0 | 58.64 | IDENTIFIABLE |
| H4 — excess(BEHIND) − excess(not BEHIND), primary cells pooled | BEHIND | 0.2474 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 5,610 | 3.0 | 49.48 | IDENTIFIABLE |
| H4 — excess(BEHIND) − excess(not BEHIND), primary cells pooled | not-BEHIND | 0.2292 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 17,555 | 3.0 | 45.84 | IDENTIFIABLE |
| H1 — cell 1h | CLEAR | 0.2250 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 3,743 | 3.0 | 45.00 | IDENTIFIABLE |
| H1 — cell 1h | OPPOSING | 0.2294 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 6,470 | 3.0 | 45.88 | IDENTIFIABLE |
| H1 — cell 2h | CLEAR | 0.2288 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 3,239 | 3.0 | 45.76 | IDENTIFIABLE |
| H1 — cell 2h | OPPOSING | 0.2711 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 2,955 | 3.0 | 54.22 | IDENTIFIABLE |
| H1 — cell 4h | CLEAR | 0.2408 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 2,006 | 3.0 | 48.16 | IDENTIFIABLE |
| H1 — cell 4h | OPPOSING | 0.2345 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 2,256 | 3.0 | 46.90 | IDENTIFIABLE |
| H1 — cell 8h | CLEAR | 0.2531 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 802 | 3.0 | 50.62 | IDENTIFIABLE |
| H1 — cell 8h | OPPOSING | 0.2692 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 416 | 3.0 | 53.84 | IDENTIFIABLE |
| H1 — cell 12h | CLEAR | 0.1616 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 897 | 3.0 | 32.32 | IDENTIFIABLE |
| H1 — cell 12h | OPPOSING | 0.1890 — probe `python3 -I scripts/sr-probe/sr_analyze.py --cardinalities`, n = 381 | 3.0 | 37.80 | IDENTIFIABLE |

## 6. Decision rule (PROCEDURE §6) — three states per hypothesis

**H1 (primary) — the wave's verdict, one line `SR_PROBE_VERDICT=PASS|NULL|INDETERMINATE — <cause>`:**

- **PASS** — 95% lower bound > 0, point ≥ +3.0pp, and the hold-out mean > 0.
- **NULL** — upper bound < +3.0pp. It reads "no ≥ 3.0pp excess lever in the 1h–12h cells at this side mix", never "S/R closed as an edge lever". An upper bound < 0 is a NULL that names the reversal.
- **INDETERMINATE** — anything else, cause named: fewer than 20 day clusters · a NOT_IDENTIFIABLE H1 arm on the scored rows · a hold-out sign flip (or no hold-out day present) · an interval holding +3.0pp with its lower bound ≤ 0 · a lower bound > 0 with the point under +3.0pp and the interval holding +3.0pp. What resolves each: W2's larger corpus (§9).

**H2, H3, H4 (secondary, BH-FDR q = 0.10 over the three):**

- `attributable` — rejected by `bh`, lower bound > 0, and the point at or above the hypothesis's bar: H2 slope > 0 (the wave spec's criterion), H3 ≥ +1.0pp, H4 ≥ +3.0pp.
- `not-attributable` — upper bound under the floor the null must exclude: H2 +1.0pp per step, H3 +1.0pp, H4 +3.0pp.
- `indeterminate` — otherwise, or fewer than 20 day clusters. A null counts only when the interval excludes its floor; under the floors the result is underpowered, never negative.

PASS only decides that the arc is worth chartering. H3 under +1.0pp means the arc builds the naive feature first. The descriptive cells and the descriptive reads decide nothing.

## 7. Declared expectations and respecification (PROCEDURE §7)

- Signs expected: H1 > 0, H2 > 0, H3 > 0, H4 > 0.
- Expectation, stated before the read: repeated registered attempts on this window found no directional edge, the side mix compresses any excess, and the §5 simulation shows what this corpus can and cannot resolve — so INDETERMINATE or NULL is expected more often than PASS.
- No threshold, bin edge, lookback, merge width, cell set, minimum arm size or estimator is changed after the label read. A respecification one would not have proposed had the check passed is not applied to these rows: it is registered and applied to W2's corpus, which nobody has read.

## 8. Deviations, quarantine, publication (PROCEDURE §8)

- A deviation from this file is recorded in the findings with its cause and the new sha256 of whatever changed; it is never absorbed. The pinned-hash test makes a silent change to the level rule, the feature builder, the fetch plan or the harness fail.
- Figures live only in the private vault (`audits/EDGE-SR-LEVEL-PROBE-W1-findings.md` and `.json` there). No figure, filtered rate or counterfactual rate enters this repository or any public surface. Outcome win rates stay internal.
- Corrections to the wave spec, all made before any label read: (1) `per_day` never constructs `Arm` → `Arm` per Ruling 3, the gate's `cluster_bootstrap_ols` call, and a parity test; (2) `getCandles` has no caller parameter → `runAsCaller('sr-level-probe', fn)`; (3) `T_FLIP = 1788169595`, entry = `signals.price_at_signal`; (4) no persisted candle store → the adapters on the operator's machine; (5) a cell-day is absent, never zero, when either arm has fewer than 30 scored rows; (6) BITGET 2h / 8h L1 = the 1H / 6H bars; (7) "capped at 1w" never binds — the measured ladder of §4.2 holds no interval above 1d on any of the four venues — so L2/L3 follow that ladder; (8) the coin sample "at 2× the §5 floor" has no reading under the Q1 bound — the §5 floor counts UTC days and a coin sample cannot add days — so the sample is the largest seeded coin set within the request cap, primary cells untouched; (9) H2's "slope > 0" gives a null nothing to exclude, so +1.0pp per step is registered as the floor a `not-attributable` reading must exclude, while `attributable` keeps the spec's criterion; (10) Q3 states the primary rule "BUY share ≤ 0.80" and names the cells 1h, 2h, 4h, 8h, 12h — on the registered rows the 12h cell's BUY share is 0.830 (Plan Mode's count read 0.787), so the rule and the list disagree for 12h. The list is kept: 12h stays primary, its side mix and raw equivalent are in §5, it clears identifiability, and it carries 1 of the 74 H1 cell-days. The per-cell H1 read (descriptive) shows each cell alone.

## 9. Owner, the read, and the forward test (PROCEDURE §9)

- **Owner:** Mr.1. **The read:** this wave's CH2, once, after this file is on `origin/main`; then a fresh-context audit (CH3) recomputes H1 from the persisted files.
- **Forward test — `EDGE-SR-LEVEL-PROBE-W2`.** The same frozen Level v0, harness and hypotheses on calls in (`T_DIAG_END`, `T_REG`], not before 2027-01-17T10:00:00Z (`SEAL_LIFT`). It inherits this file unchanged; anything it changes is its own registration.
- **Records by verdict (CH3):** PASS → register row ARCHITECT "charter ARC-SR-LEVELS (Mr.1); T1 = EDGE-SR-LEVEL-PROBE-W2 after 2027-01-17T10:00Z" · INDETERMINATE → register row OWED "EDGE-SR-LEVEL-PROBE-W2 after 2027-01-17T10:00Z" · NULL → no row.

## 10. Pinned artifacts

| artifact | sha256 |
|---|---|
| label-free session script (`sessionScript('labelfree')`) | `e025896a67913206ba5f860cd893545c53e7d12704cce57dd929befc7bac5e62` |
| label session script (`sessionScript('labels')`) | `a60bb84019c27abd4857bdd58ac4f9812035c73f990343b1fb4df00218622e2b` |
| `src/scripts/sr-probe/level-v0.ts` | `ec57e3215daf2ac510b61d7e2c71563c610e6c45ab02900eda8591f2d6106f40` |
| `src/scripts/sr-probe/sr-features.ts` | `ccc78de1a977c44b845dabed0fed9237319dddb60c419dcb8d31d655b41e854d` |
| `src/scripts/sr-probe/plan.ts` | `47dca59a8d344b802a277b016ca764a3d4ff5cba7cd1a933a0967569cd71a658` |
| `scripts/sr-probe/sr_analyze.py` | `3ad7b9b18f0252583eee42559abe46dad4e7f2ed8b805ef46d1e8c8539df6652` |
| `extract.csv` (92,951 rows) | `6fb3e57f1f6f5c79f87de8ba814f2b5388f671b14f64d5b71eaaec62a7ec4ed4` |
| `coverage.csv` (38 rows) | `1e0b2a8a7a1c38156eb0ed27eab8d70064a0b504e17bdb550a1f94db2c8554dd` |
| `features-primary.csv` (23,168 rows) | `e1e91f632d657e4aa96b9545d5ece3a530f3a3a9628dd10b0ac72241ce73dac6` |
| `features-descriptive.csv` (69,783 rows) | `619ba3805a3a2bd36298dcd4d27393ec8156e45f175d26ec97b0903a5bf7c593` |

`features-descriptive.csv` holds the 3m, 5m, 15m, 30m and 1d cells, which decide nothing; it is built by the same pinned code from the same extract.
