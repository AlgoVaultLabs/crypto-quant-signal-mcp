# EDGE-LABELER-RACE-WINDOW-V2-W1 — pre-registration: the `-v1` vs `-v2` label disagreement under `T_CAP` (a DATA-QUALITY MEASUREMENT, not a directional test)

> ## ⚠️ HEADER CLAUSE — REPRODUCE VERBATIM AT THE TOP OF EVERY REPORT THIS WAVE WRITES
>
> **A `-v1` label is never edited, overwritten or deleted.** The corrected race is a new, versioned label series (`tau{0.5,1.0,2.0}-floor0.30-v2`) written **beside** `-v1`; every consumer migrates by an explicit wave of its own; nothing switches silently (AVS-1 §5, §9: values preserved, methodology versioned, changes published before they take effect).
>
> **The seal is respected in full.** Writing `-v2` for rows above `T_DIAG_END` is a mechanical label write, exactly like the nightly labeler's. Reading a label value above `T_CAP` is not: the disagreement table is computed **under `T_CAP` only**; above it, cardinalities (rows written, holes counted) and nothing else.
>
> **Three foreign consumers are flagged, not routed around:** the B-DIR v3 FULL test (registered on `-v1`; owner B-DIR v3 FULL / Cowork Main-AOE), the HOLD-discipline pre-registration (earliest read 2026-10-07; owner EDGE-HOLD-DISCIPLINE) if R0 finds the hold labeler shares the defect, and the DWR SoT digest / `dwr_baseline_runs` / AOE `edge_gate` + retune (pinned to `-v1`). Each gets a migration row in the consumer registry and a line in `status.md`; none is changed here.

**Write-time clock (live `date -u`):** first written `2026-09-28T14:47:16Z` (epoch `1790606836`).
**Owner:** `EDGE-LABELER-RACE-WINDOW-V2-W1` (CH1 registration; the read is CH3) · **Procedure:** `audits/PREREGISTRATION-PROCEDURE.md` · **Gate:** `tests/unit/preregistration-support-stress-test.test.ts` · **Rulings folded in:** Q8–Q11 (2026-09-28) and LRW-Q1…Q14 (2026-09-28, architect).
**Pinned to its generator by:** CH3 emits every statement in §3 byte-equal from its pull code, and a unit test pins that equality before the pull runs (the ADS-1 precedent, `tests/unit/ads1-scorecard.test.ts`).

**This registration is a MEASUREMENT, not a test.** It records what the corrected race changed on rows a defective race already labelled. It makes no directional claim, computes no confidence interval, p-value or edge, and its `cells_tested` is **0** — the directional family total is untouched. Nothing it produces is consumed by any promotion path, gate, threshold, weight, serving change or public figure; every consumer migrates by its own wave. Every figure it produces lives in the private vault; this file carries methodology, identifiers and declared expectations only — **no count, rate or outcome figure** (the code repo is public). Support facts in §6 are named here and valued in the vault record (`audits/EDGE-LABELER-RACE-WINDOW-V2-W1-endpoint-truth.md`, §6).

---

## 0. What is measured

The `-v1` directional labels were raced on a group candle cache whose extension started off the candle grid (`backfill-directional-labels.ts` `processGroup`, since `20129e14`), so one or more candles inside a row's window could be missing; the race scanned `forwardAsc.slice(0, W)` **by index** (`directional-labeler.ts:206`), skipping the missing candle and running past the vertical barrier. The same holes sit in the trailing σ history of later rows.

`-v2` (`tau{0.5,1.0,2.0}-floor0.30-v2`) is defined by the rulings, not by this file:

- **Window by time on the served grid:** `open_0` = the first cached candle with `entry ≤ open < entry + s` (s = the venue's served step for the timeframe; taken from the data, never `ceil(entry/s)·s` — six venue × interval pairs open on UTC+8 boundaries), then W consecutive served-grid candles; the vertical barrier is the close of candle W−1.
- **Contiguity over ALL W candles** (LRW-Q2 = A). A window with a missing candle is **refused**: no `-v2` row, counted in the run's cardinality line and in a sha-pinned per-row refusal manifest. A window not yet closed at fetch (`entry + (W+1)·s > fetch start`, the `directional-labeler.ts:132` predicate) is **deferred**: no row, retried.
- **σ = the `-v1` formula on corrected inputs** (LRW-Q1 = A): `computeSigmaW` over a gap-free served-grid trailing history; fewer than 30 contiguous windows ⇒ no `-v2` row (`unreachable:history`).
- Same barriers `max(τ·σ_w, 0.30 %)`, same −1 conservative same-candle rule, same floor.
- **Coarser-served pairs** (the venue serves a coarser candle than the timeframe) race W served candles (LRW-Q4 = A) — a longer horizon than `-v1`, which raced a window cut at `(W+2)·requested` and could write only decided labels there. They are their own cells here, never pooled with same-grid cells.

The measurement asks, on the same rows under `T_CAP`: where does the `-v2` label differ from the `-v1` label, by how much, and does the difference concentrate where the replay says the `-v1` race had holes?

## 1. Ordering (PROCEDURE §1; ruling LRW-Q12 = A)

1. This file lands on `origin/main` **before any `-v2` row exists** (the `-v2` writer lands in CH2) and therefore before the first `-v2` label read.
2. The ADS-1 `-v2` amendment lands on `origin/main` **before** the pull registered here, so no figure of this study is ever a prior examination for ADS-1.
3. The pull runs only after CH3's historical relabel and `race_gap_candles` annotation report DONE, outside 02:20–06:30Z, with no labeller or runner alive; the write-counter assertion in §3.1 proves no concurrent writer.

The landed commit's committer timestamp and the pull's `date -u` are recorded together in the vault audit; CH3's gate refuses unless `merge-base --is-ancestor <registration commit> origin/main` holds, the commit contains this file, and its timestamp precedes the pull.

## 2. Prior-examination disclosure (PROCEDURE §2)

| Seen before landing | Class | Where recorded |
|---|---|---|
| R0 label-free cardinalities: label rows per spec, `T_CAP` membership (both forms), groups, eligible signals without a `-v1` row, partial spec sets, rows above the seal (2026-09-28) | `cardinality` | vault endpoint-truth §6.1 |
| The label-free replay: per-row race-window holes (ideal window), σ-history holes, the crossed stratum, the model-L-vs-upper-bound ambiguity, the forming-candle flag, grid class (sha-pinned artifacts, §3.2) | `cardinality` | vault endpoint-truth §6.2 + artifact dir |
| A structural inference, not a read: a `-v1` row whose cached forward window held fewer than W candles can only carry ±1 (`backfill-directional-labels.ts:791-795` drops a label-0 race on a short window) — a decided-vs-timeout partition (the §1 boundary class) derived from code and the label-free replay | `seen — not a test input` (boundary class, disclosed) | vault endpoint-truth §8 |
| Reach, page and throughput sizing; venue candle phase (one public kline per pair); deploy cadence | `cardinality` / `coverage ratio` | vault endpoint-truth §6.4–§6.9 |
| Hold-arm hole prevalence (label-free) — a different corpus, never read here | `cardinality` | vault endpoint-truth §6.3 |
| Aggregate wins / losses / timeouts counters of the 2026-09-23 … 09-28 nightly `-v1` runs (rows incl. sealed ones), seen incidentally in the labeller's `DONE` log lines while measuring step durations; not recorded, not used | `seen — not a test input` | vault endpoint-truth §8 |
| `-v1` label statistics on these rows computed by earlier studies: the DWR SoT digest (`dwr_baseline_runs`), withheld-DWR W2, the hurst discrimination probe, the scorer predictive-ceiling audit, the sell-attribution studies (attribution gate, sell-feature attribution, centered check, long-timeframe check, collider control), the B-DIR v3 diagnostic | `inherited` — the `-v1` side of §4 has been seen by other studies | their own registrations / audits |

**No `-v2` label exists at registration, and no `-v1` vs `-v2` comparison has been computed by anyone.**

## 3. Corpus — literal SQL, closed by a clock (PROCEDURE §3)

**T_END = T_CAP, in the ruled form (Q11 / LRW-Q8):** a row is in the population iff `created_at ≤ 1790402400 AND created_at + (W+1)·max(requested, served) ≤ 1790402400`. `max(requested, served)` differs from the requested interval only on the coarser-served pairs, which the statement lists literally. On rows above the bound nothing in this study reads a label value.

**T_CUT — which `-v1` rows are defective-cache rows.** After CH2 deploys, new `-v1` rows come from the corrected cache (ruling Q9), so they are not the object measured. `T_CUT` = the `StartedAt` epoch of the first `crypto-quant-signal-mcp-mcp-server-1` container running the CH2 generator commit, recorded in the vault audit at deploy. The population takes `-v1` rows computed **before** `T_CUT`; `-v1` rows under `T_CAP` computed at or after it are counted apart and never read. `T_CUT` is the only literal substituted at pull time, from that recorded clock.

**Specs:** the three `-v1` specs, each paired with its own `-v2` spec. **Twins:** a `-v1` row with a `-v2` row for the same signal and τ. **Windows, never pooled:** FULL `[first row, T_CAP]` and POST_FLIP `(T_FLIP, T_CAP]`, `T_FLIP = 1788169595`.

**Exclusions, by name:** `-v1` rows with `low_vol_history` (as the DWR SoT) — counted · rows on retired venues (BITMART, EDGEX) — no `-v2` is written, counted · `-v2` rows whose signal has no `-v1` row (ruling LRW-Q5 = B writes them) — outside the twins, counted.

**Coverage travels with its denominators** (ruling Q11): registered (`-v1` rows in the population) · reached (twins) · refused (the refusal manifest: a hole inside the W-window) · unreachable (by reason: venue depth, σ history, retired, and the cell **"unreachable pending OPS-ADAPTER-HISTORY-ANCHOR-W1"** holding every BITGET 2h / 8h row, whose historical candles the shipped adapter cannot fetch contiguously) · deferred (none expected under `T_CAP`: every window closed long before the relabel). Nothing is filled or estimated.

### 3.1 The read session

`ssh` → `docker exec -i crypto-quant-signal-mcp-postgres-1 psql -U aoe_readonly -At -q`, three parts, each its own `BEGIN READ ONLY` transaction printing the token first: counters-before → extract → counters-after. `aoe_readonly` holds no write privilege, so the channel is read-only by construction. The extract goes to Mac scratch (its sha256 recorded; never committed). The write-counter delta must be zero (no concurrent writer).

```sql
SELECT 'TOKEN current_user=' || current_user || ' transaction_read_only=' || current_setting('transaction_read_only')
```

```sql
SELECT 'COUNTERS relname=' || relname || ' ins=' || n_tup_ins || ' upd=' || n_tup_upd || ' del=' || n_tup_del
  FROM pg_stat_user_tables WHERE relname = 'directional_labels'
```

**The label-bearing extract — the allow-list SELECT (`:T_CUT` substituted from the recorded clock):**

```sql
COPY (
  SELECT s.id, s.created_at, s.exchange, s.coin, s.timeframe, s.signal AS side,
         v1.barrier_spec AS spec_v1,
         v1.label AS label_v1,
         v1.ambiguous_candle AS amb_v1,
         v1.low_vol_history AS lowvol_v1,
         v1.barrier_pct AS barrier_v1,
         v1.race_gap_candles AS gap_v1,
         extract(epoch FROM v1.computed_at)::bigint AS computed_v1,
         (v2.signal_id IS NOT NULL) AS has_v2,
         v2.label AS label_v2,
         v2.ambiguous_candle AS amb_v2,
         v2.barrier_pct AS barrier_v2
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('HTX', '3m', 300), ('PHEMEX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900), ('PHEMEX', '12h', 86400)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN (VALUES ('tau1.0-floor0.30-v1', 'tau1.0-floor0.30-v2'), ('tau0.5-floor0.30-v1', 'tau0.5-floor0.30-v2'), ('tau2.0-floor0.30-v1', 'tau2.0-floor0.30-v2')) AS sp(v1, v2) ON TRUE
  JOIN directional_labels v1 ON v1.signal_id = s.id AND v1.barrier_spec = sp.v1
  LEFT JOIN directional_labels v2 ON v2.signal_id = s.id AND v2.barrier_spec = sp.v2
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
    AND v1.computed_at < to_timestamp(:T_CUT)
  ORDER BY s.id, v1.barrier_spec
) TO STDOUT WITH (FORMAT csv, HEADER)
```

| Column | Why it is read | Class |
|---|---|---|
| `s.id`, `s.created_at` | identity; windows; UTC-day clusters | key |
| `s.exchange`, `s.coin`, `s.timeframe` | the cell; grid class; phase pairs | key |
| `s.signal AS side` | the always-side comparators (§4) | emitted output |
| `v1.barrier_spec` | the spec pairing | key |
| `label`, `ambiguous_candle`, `barrier_pct` (both versions) | the race outcome, the same-candle rule, the barrier (σ channel) | label (under `T_CAP` only) |
| `v1.low_vol_history` | the exclusion flag | barrier construction |
| `v1.race_gap_candles`, `v1.computed_at` | the provenance stratum; the `T_CUT` / delta-replay split | provenance |
| `has_v2` | twin presence | cardinality |

No `mfe_*`, `mae_*`, `ret_at_expiry_pct`, `outcome_*`, scorer-input or hold column is read or named.

**Counts apart (label-free, may run to now):**

```sql
COPY (
  SELECT sp.v1 AS spec_v1, s.exchange, s.timeframe,
         (v1.computed_at >= to_timestamp(:T_CUT)) AS after_cut,
         count(*)::bigint AS n
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('HTX', '3m', 300), ('PHEMEX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900), ('PHEMEX', '12h', 86400)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN (VALUES ('tau1.0-floor0.30-v1'), ('tau0.5-floor0.30-v1'), ('tau2.0-floor0.30-v1')) AS sp(v1) ON TRUE
  JOIN directional_labels v1 ON v1.signal_id = s.id AND v1.barrier_spec = sp.v1
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
) TO STDOUT WITH (FORMAT csv, HEADER)
```

```sql
COPY (
  SELECT sp.v2 AS spec_v2, s.exchange, s.timeframe, count(*)::bigint AS n_v2_without_v1
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('HTX', '3m', 300), ('PHEMEX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900), ('PHEMEX', '12h', 86400)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN (VALUES ('tau1.0-floor0.30-v1', 'tau1.0-floor0.30-v2'), ('tau0.5-floor0.30-v1', 'tau0.5-floor0.30-v2'), ('tau2.0-floor0.30-v1', 'tau2.0-floor0.30-v2')) AS sp(v1, v2) ON TRUE
  JOIN directional_labels v2 ON v2.signal_id = s.id AND v2.barrier_spec = sp.v2
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
    AND NOT EXISTS (SELECT 1 FROM directional_labels v1 WHERE v1.signal_id = s.id AND v1.barrier_spec = sp.v1)
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
) TO STDOUT WITH (FORMAT csv, HEADER)
```

### 3.2 The off-DB strata (sha-pinned, label-free)

Joined on `(signal_id, barrier_spec)` after the pull; every file lives in the private vault artifact directory `audits/EDGE-LABELER-RACE-WINDOW-V2-W1-planmode-2026-09-28/replay/`:

| Artifact | sha256 | Columns used |
|---|---|---|
| `race-gap-worklist.csv.gz` (the canonical replay; also the source of the historical `race_gap_candles` annotation, ruling LRW-Q3) | `58dcff766db9d120aa64b6ef8486fdd9742e304521447f1beced7a67e1df6022` | `gap_served_L`, `sigma_holes_L`, `tail_served_L`, `ambiguous_L_Uc`, `forming` |
| `strata-crossed.csv.gz` (holes the index race actually ran over; two implementations, 0 mismatches) | `9b36df47d0abf8429b3055939ba273ad67b0c57c8799f00e0dc5b8022282848e` | `crossed_L`, `fwd_len_L` |
| `retired-uc-understated.csv` (upper-bound sensitivity on retired venues) | `227fdbd62094ad62a17a6a1e06c9be8bd59d2f36e335bf2d6efc2a7d4a6a4aca` | membership |
| the delta replay (rows computed between the replay snapshot `1790598051` and `T_CUT`, same code) | recorded in CH3 before the pull | `gap_served_L`, `sigma_holes_L` |
| the relabel's per-row refusal manifest (CH3) | recorded in CH3 before the pull | class: refused / unreachable:{depth, history, retired, adapter-pending} / deferred |

Model of the replay (stated, a lower bound): calls split at > 2 s (one call = one INSERT instant), labelled-row to-do lists, served grid at phase 0, unlimited pages, WEEX 30m / 12h served 15m / 4h before `1788432900`.

## 4. Measures (descriptive)

For each spec × window × timeframe × venue × stratum cell (§4.1), on twins unless stated:

- **n** registered / twins / refused / unreachable (by reason) / low-vol excluded / after-`T_CUT` (counted apart).
- **P(differ)** = share of twins with `label_v2 ≠ label_v1`.
- **Transition matrix** `label_v1 ∈ {+1, −1, 0}` × `label_v2 ∈ {+1, −1, 0}`, plus `label_v1` × {refused, unreachable} counts for non-twins.
- **Decided-share delta** = share(`label_v2 ≠ 0`) − share(`label_v1 ≠ 0`); **same-candle share delta** (`ambiguous_candle`).
- **Barrier ratio** `barrier_v2 / barrier_v1`: median and the share ≠ 1 (the σ channel's size).
- **Comparators only** (timeframe and fleet roll-ups, twins, both versions): always-BUY hit share `q_BUY`, always-SELL hit share `q_SELL` (a same-candle race is a loss for both sides — `deriveRaceOutcome`), and the mix-matched null `p₀ = share_BUY·q_BUY + share_SELL·q_SELL`, each under `-v1` and `-v2` and their deltas; per-UTC-day unweighted cluster mean with the pooled value beside it. **Never `max(q_BUY, q_SELL)`, never an engine hit rate, never an edge, never a headline.**
- **One headline line:** *"of N `-v1` labels under `T_CAP` with a `-v2` twin, K (x %) differ; flips concentrate at hole-count ≥ …"* (FULL window, primary spec; the others as sensitivity lines).

### 4.1 Strata (ruling LRW-Q14-d)

| Axis | Levels | Source |
|---|---|---|
| race gap | `race_gap_candles` = 0 · 1 · 2 · 3+ (and 1…12 in detail) | the annotated column (= replay `gap_served_L`, or the delta replay) |
| σ input changed | `sigma_holes_L > 0` OR coarser-served pair (its `-v1` history was bounded on the requested step) | worklist |
| crossed | among race gap > 0: `crossed_L = 0` (the index race ran over no hole) vs `> 0` | strata-crossed |
| grid class | same · finer-served · coarser-served | the served table |
| WEEX pre-2026-09-03 | WEEX 30m / 12h rows computed before `1788432900` (raced on 15m / 4h) | `computed_v1` |
| phase pairs | OKX 12h / 1d · BITGET 8h / 12h / 1d · HTX 1d (UTC+8 candle opens) | exchange × timeframe |
| BITGET 2h / 8h | the adapter-pending cell | exchange × timeframe |
| model ambiguity | `ambiguous_L_Uc = 1` or on the retired list | worklist |
| provenance | replay-annotated · delta-replay | `computed_v1` vs the snapshot |

## 5. Floors

The independence unit for the comparator deltas is the **UTC day**; a roll-up's per-day mean exists only with ≥ 20 days of ≥ 30 twins each, else it reads *under-clustered* and only the pooled value prints. A stratum cell with < 30 twins prints counts only (*thin*), never a share. No interval or test is computed; there is no power statement because nothing is tested.

## 6. Support stress-test

Each registered check, the point at which it is evaluated, the support fact probed before landing (values in the vault endpoint-truth §6), and whether the corpus occupies that point.

| Check | Evaluation point | Support / cardinality fact (probed live, 2026-09-28, label-free) | Verdict |
|---|---|---|---|
| E1 — noise floor | twins with race gap 0 ∧ σ input unchanged ∧ same grid ∧ not WEEX-pre ∧ not a phase pair ∧ not model-ambiguous ∧ not forming | the replay places a large same-grid population with a gap-free window and a gap-free σ history | `inside` (the realized twin count after relabel reach is printed) |
| E2 — race-invariant stratum | race gap > 0 ∧ `crossed_L = 0` ∧ σ input unchanged | the crossed stratum is occupied (two implementations agree); a subset of it also has σ holes | `inside` |
| E3 — monotone in race gap | same-grid, σ-unchanged twins at race gap 1, 2, 3+ | every level 1…12 is occupied in the primary `T_CAP` population; 12 is sparse | `inside` for 1, 2, 3+ · levels ≥ 10 read *thin* |
| E4 — coarser cells | the 8 coarser-served pairs with rows (WHITEBIT 3m has none) | occupied; every such row's `-v1` window was truncated | `inside`, reported apart · `-v1` row "0" of the matrix is empty by construction (8 of 9 pairs) |
| E5 — adapter-pending cell | BITGET 2h / 8h | no row can reach a full served σ history through the shipped adapter | `outside → replaced by` the count in the cell "unreachable pending OPS-ADAPTER-HISTORY-ANCHOR-W1" |
| Finer-served cells | 2h→1h, 8h→6h/4h, 12h→8h/4h pairs | occupied; page-boundary skips are outside the replay model | `inside`, flagged model-exposed |
| WEEX pre-2026-09-03 stratum | WEEX 30m / 12h rows raced on 15m / 4h | occupied; the 30m rows are largely beyond WEEX's current depth | `inside` where reached; unreachable counted |
| Phase-pair stratum | OKX 12h / 1d, BITGET 8h / 12h / 1d, HTX 1d | occupied | `inside` |
| Model-ambiguity stratum | `ambiguous_L_Uc = 1` or retired list | occupied | `inside`, reported apart |
| POST_FLIP window | `(T_FLIP, T_CAP]` | occupied on every timeframe; 1d is sparse | `inside` · 1d may read *thin* |
| Comparator deltas (per-day) | timeframe and fleet roll-ups with ≥ 20 days of ≥ 30 twins | FULL spans far more than 20 days; POST_FLIP spans under 30 days | `inside` where the floor holds, else *under-clustered* (pooled only) |
| Per-venue × timeframe cells | each (venue, timeframe) | some cells have zero reach after relabel (short venue depth) | `inside` where reached · zero-reach cells print `UNDEFINED`, never 0 % |
| After-`T_CUT` rows | `-v1` rows under `T_CAP` computed at or after `T_CUT` | exists only if the nightly labels old rows after CH2 | `outside → replaced by` a count |

## 7. Declared expectations (before any `-v2` label exists)

- **E1 — noise floor.** P(differ) ≈ 0 in the E1 stratum: there, the `-v1` race by index over a gap-free window and the `-v2` race by time are the same race on the same candles with the same σ. Any excess measures candle revisions or venue nondeterminism between the `-v1` labelling and the relabel; it is reported as the floor and never subtracted inside any statistic.
- **E2 — race invariance.** In the race-invariant stratum (holes in the ideal window that the index race never reached), P(differ) is at the E1 floor where σ is unchanged; excess there belongs to the σ channel, not the window.
- **E3 — dose.** Among same-grid, σ-unchanged twins, P(differ) is non-decreasing in race gap (1 ≤ 2 ≤ 3+). A violation is reported with its cells.
- **E4 — coarser cells.** `-v1` has no timeout on 8 of the 9 coarser-served pairs (a construction of the truncated window; PHEMEX 12h by data) and `-v2` adds them; the horizon change is disclosed per pair and these cells are never pooled with same-grid cells.
- **E5 — adapter-pending.** BITGET 2h / 8h show no twins; the cell fills only under `OPS-ADAPTER-HISTORY-ANCHOR-W1`'s own registration line.
- **No directional expectation is registered.** Whether flips favour +1 or −1 is recorded, not predicted.

## 8. Decision rule (PROCEDURE §6)

Per expectation, three states: **consistent** · **inconsistent — cells named** · **indeterminate — thin or under-clustered, cause named**. There is no attributable / not-attributable reading because nothing is tested; `cells_tested = 0` is logged in the audit JSON and the directional family total is unchanged. Migration decisions belong to each consumer's own wave, which reads this table as input, never as a verdict.

## 9. Respecification, deviations, quarantine, publication (PROCEDURE §7–§8)

No post-result respecification is permitted: a stratum, floor or exclusion proposed after seeing the table goes to data nobody has seen (rows above `T_CAP`, after the seal lifts) and the in-sample reading is disclosed as seen and not a test input. Any deviation is recorded with its reason in the vault audit. Nothing here reads the hold corpus (the hold `-v2` series is written, never read, in this wave). Nothing above `T_CAP` is read except the cardinalities of §3 ("Counts apart"). Figures are vault-only; nothing reaches public copy.
