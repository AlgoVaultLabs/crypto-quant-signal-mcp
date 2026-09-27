# EDGE-ADS1-SCORECARD-W1 — pre-registration: AlgoVault's own ADS-1 cell scorecard (a REPORT, not a gate)

**Write-time clock (live `date -u`):** first written `2026-09-27T14:41:23Z` (epoch `1790520083`).
**Owner:** `EDGE-ADS1-SCORECARD-W1` (V2-RESUME, chapter CH3 R4) · **Procedure:** `audits/PREREGISTRATION-PROCEDURE.md`
· **Gate:** `tests/unit/preregistration-support-stress-test.test.ts` · **Pinned to its generator by:** `tests/unit/ads1-scorecard.test.ts` (every statement below is byte-equal to `src/scripts/ads1/extract-sql.ts`, the code the read session runs).

**This registration is a REPORT, not a gate.** It measures the live product against a DRAFT standard (ADS-1 `1.0.0-draft`) and is **NON-PROMOTABLE**: no verdict it produces is consumed by any promotion path, serving change, threshold, weight, emission policy or public figure. Every figure it produces lives in the private vault; this file carries methodology, identifiers and declared expectations only — **no count, rate or outcome figure** (the code repo is public). The support facts in §6 are named here and valued in the vault record (`audits/EDGE-ADS1-SCORECARD-W1-endpoint-truth.md`, "CH3 pre-registration support probe").

---

## 1. Ordering (PROCEDURE §1)

This file lands on `origin/main` **before the first outcome query** of the scorecard's read session. The landed commit's timestamp and the pull's `date -u` are recorded together in the vault audit, and the scorecard's own self-check refuses to pass unless `registration commit timestamp < pull start` (`src/scripts/ads1/scorecard.ts` `selfCheck`, row "registration landed before the pull"). Cardinalities were probed before landing (§2); no outcome statistic was.

## 2. Prior-examination disclosure (PROCEDURE §2)

| Seen before landing | Class | Where recorded |
|---|---|---|
| Label counts per barrier spec, window sizes, sealed-row counts, cell / coin / timeframe occupancy, confidence support, census table shapes (R0, 2026-09-27) | `cardinality` | vault endpoint-truth §5 |
| CH1 re-probe: counts per spec under `T_CAP`, the `T_FLIP` rule-version assert, per-venue candle depth and reachable-row counts for the expiry backfill, census unit analysis | `cardinality` / `coverage ratio` | vault endpoint-truth, CH1 addendum |
| The label-free support probe for §6: labelled-row existence per (cell, UTC day, side), emitted side mix, confidence occupancy, under `T_CAP` | `cardinality` | vault endpoint-truth, CH3 support probe |
| The directional family's cumulative tested-cell total (72) | `inherited` | status history (`Old Status/Status July 2026.md`) |
| The digest's decided-basis per-day vs pooled edge on the 2026-09-02 corpus, quoted in the header of `src/scripts/dwr-cluster-edge.ts` | `seen — not a test input` | that file |
| Public per-tier PFE win rates carried by the tier instrument's own response (`/api/performance-public`) | `seen — not a test input` (a different label, already public) | the fetched instrument |
| Decided-share-by-timeframe and emitted-to-decided shares across the flip, from the estate's operating notes (a decided-vs-timeout partition — the §1 boundary class) | `seen — not a test input` | estate notes |
| The B-DIR v3 diagnostic's verdict (2026-09-26) and the scorer predictive-ceiling verdict (2026-09-21) — other tests, other label bases | `seen — not a test input` | their own registrations |

No complete-label hit rate, mix-matched null, edge, calibration statistic, ICC, payoff statistic or verdict of this standard has been computed on the corpus below by anyone.

## 3. Corpus — literal SQL, closed by a clock (PROCEDURE §3)

**T_END = T_CAP.** A row is in the population iff its whole price path closed before the B-DIR v3 sealed-holdout floor: `created_at ≤ 1790402400 AND created_at + (W+1)·tf ≤ 1790402400` (ruling Q1 = A — label-independent; never `computed_at`, which would select on the labeller's catch-up order). The bound is fixed by the seal, not by what a pull reaches. On rows above it nothing in this study reads a label value, a win/loss or an outcome statistic.

**Windows, never pooled:** FULL `[first row, T_CAP]` and POST_FLIP `(T_FLIP, T_CAP]`, `T_FLIP = 1788169595` (the final TREND_MODE flip; the earlier rule-v2 row belongs to a rolled-back flip). **Barrier specs:** `tau1.0-floor0.30-v1` (primary; it defines the population) · `tau0.5-floor0.30-v1` · `tau2.0-floor0.30-v1` (sensitivity, L0 / L1 only, on the same rows).

**Exclusions, by name:** `low_vol_history` rows (as the DWR SoT) — counted · `UNRESOLVED` (a timeout with no stored expiry return) and `INCONSISTENT` (a timeout whose expiry lies outside its barrier) — counted, never coerced · `1m` — absent from the label window (the join table has no `1m` row) · rows labelled by a sensitivity spec only — counted by the integrity statement, left out · coins the tier instrument does not list — counted and reported as tier `U`. **Disclosed, kept:** the EDGEX cohort before the adapter fix `e34f95e9` (`created_at < 1781258276`, the fix commit plus one day) — its labels come from the labeller's own sorted candles and are unaffected (D33).

**Coverage travels with two denominators:** the registered population (every extracted row), and the subset whose complete label resolved. The expiry return is filled for existing rows by the one-shot `--expiry-only` backfill (label-independent worklist, forward-only fetch, `T_CAP`-bounded); rows a venue no longer serves stay NULL and read `UNRESOLVED`, disclosed per venue — never estimated. The backfill runs **after** this file lands, so its reach cannot have shaped anything registered here.

### 3.1 The read session (ruling Q5 = A)

`ssh` → `docker exec -i crypto-quant-signal-mcp-postgres-1 psql -U aoe_readonly -At -q`, four parts, each its own `BEGIN READ ONLY` transaction printing the token first: counters-before → extract → label-free → counters-after. `aoe_readonly` holds no write privilege, so the channel is read-only by construction. The extract goes to Mac scratch (never committed, never into the vault; its sha256 is recorded). All reads happen outside 02:20–06:30Z, when the label tables are quiet, so the write-counter delta is an assertion (self-check: unchanged).

Token (first statement of every part):

```sql
SELECT 'TOKEN current_user=' || current_user || ' transaction_read_only=' || current_setting('transaction_read_only')
```

Write counters (counters-before and counters-after):

```sql
SELECT 'COUNTERS relname=' || relname || ' ins=' || n_tup_ins || ' upd=' || n_tup_upd || ' del=' || n_tup_del
  FROM pg_stat_user_tables WHERE relname = 'directional_labels'
```

**The label-bearing extract — the allow-list SELECT:**

```sql
COPY (
  SELECT s.id, s.created_at, s.exchange, s.coin, s.timeframe, s.signal AS side, s.confidence,
         s.regime_rule_version, s.regime, s.verdict_rule_version,
         (s.merkle_batch_id IS NOT NULL) AS anchored,
         d10.label AS label_t10,
         d10.ambiguous_candle AS amb_t10,
         d10.low_vol_history AS lowvol_t10,
         d10.barrier_pct AS barrier_t10,
         d10.ret_at_expiry_pct AS expiry_t10,
         d05.label AS label_t05,
         d05.ambiguous_candle AS amb_t05,
         d05.low_vol_history AS lowvol_t05,
         d05.barrier_pct AS barrier_t05,
         d05.ret_at_expiry_pct AS expiry_t05,
         d20.label AS label_t20,
         d20.ambiguous_candle AS amb_t20,
         d20.low_vol_history AS lowvol_t20,
         d20.barrier_pct AS barrier_t20,
         d20.ret_at_expiry_pct AS expiry_t20
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  JOIN directional_labels d10 ON d10.signal_id = s.id AND d10.barrier_spec = 'tau1.0-floor0.30-v1'
  LEFT JOIN directional_labels d05 ON d05.signal_id = s.id AND d05.barrier_spec = 'tau0.5-floor0.30-v1'
  LEFT JOIN directional_labels d20 ON d20.signal_id = s.id AND d20.barrier_spec = 'tau2.0-floor0.30-v1'
  WHERE s.created_at <= 1790402400 AND s.created_at + (tf.w + 1) * tf.sec <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
  ORDER BY s.id
) TO STDOUT WITH (FORMAT csv, HEADER)
```

| Column | Why it is read | Class |
|---|---|---|
| `s.id`, `s.created_at` | identity; time (windows, UTC-day clusters, `T_CAP`) | key |
| `s.exchange`, `s.coin`, `s.timeframe` | the cell; the tier (via the instrument) | key |
| `s.signal AS side`, `s.confidence` | the emitted call and its conviction (L2 calibration, L3 trimming) | emitted output |
| `s.regime_rule_version`, `s.regime` | the regime breakdown (D30) | label-free state |
| `s.verdict_rule_version` | the `T_FLIP` assert | rule version |
| `s.merkle_batch_id IS NOT NULL` | L5 anchored share — presence only | provenance |
| per spec: `label`, `ambiguous_candle`, `low_vol_history`, `barrier_pct`, `ret_at_expiry_pct` | the race, its barrier, the exclusion flag, the expiry return | label (under `T_CAP` only) |

No scorer-input column is read or named; no `outcome_*`, `mfe_*`, `mae_*` column is read (the complete label is Branch B: the labeller's own expiry return).

**Label-free statements (census, side mix, integrity) — may run to now; they read no label and no outcome column:**

```sql
COPY (
  SELECT 'signals' AS source, CASE WHEN created_at > 1788169595 THEN 'POST' ELSE 'PRE' END AS win, timeframe, coin, count(*)::bigint AS n
     FROM signals WHERE created_at <= 1790402400 GROUP BY 1, 2, 3, 4
  UNION ALL
  SELECT 'band_signals' AS source, CASE WHEN created_at > 1788169595 THEN 'POST' ELSE 'PRE' END AS win, timeframe, coin, count(*)::bigint AS n
     FROM band_signals WHERE created_at <= 1790402400 GROUP BY 1, 2, 3, 4
  UNION ALL
  SELECT 'hold_counts' AS source, CASE WHEN date >= DATE '2026-08-31' THEN 'POST' ELSE 'PRE' END AS win, timeframe, coin, sum(hold_count)::bigint AS n
     FROM hold_counts WHERE date <= DATE '2026-09-26' GROUP BY 1, 2, 3, 4
  UNION ALL
  SELECT 'emit_suppressions' AS source, CASE WHEN date >= DATE '2026-08-31' THEN 'POST' ELSE 'PRE' END AS win, timeframe, coin, sum(suppress_count)::bigint AS n
     FROM emit_suppressions WHERE date <= DATE '2026-09-26' GROUP BY 1, 2, 3, 4
) TO STDOUT WITH (FORMAT csv, HEADER)
```

```sql
COPY (
  SELECT exchange, timeframe, regime_rule_version, regime, signal AS side, count(*)::bigint AS n
  FROM signals WHERE created_at > 1788169595
  GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5
) TO STDOUT WITH (FORMAT csv, HEADER)
```

```sql
COPY (
  SELECT 'v1_after_flip' AS item, count(*)::bigint AS n FROM signals WHERE verdict_rule_version = 1 AND created_at > 1788169595
  UNION ALL
  SELECT 'sensitivity_only_under_tcap', count(DISTINCT s.id)::bigint
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec IN ('tau0.5-floor0.30-v1', 'tau2.0-floor0.30-v1')
  WHERE s.created_at <= 1790402400 AND s.created_at + (tf.w + 1) * tf.sec <= 1790402400
    AND NOT EXISTS (SELECT 1 FROM directional_labels p WHERE p.signal_id = s.id AND p.barrier_spec = 'tau1.0-floor0.30-v1')
) TO STDOUT WITH (FORMAT csv, HEADER)
```

### 3.2 The tier instrument and its timestamp rule (ruling Q7 = A)

Tier = the tier of the coin in `/api/performance-public` `byTier[].assets`, **fetched once at pull time**; its fetch time and the sha256 of the response body are recorded; that one membership is applied to every row of both windows (present-day membership — a disclosed limitation). Tiers are disjoint (a coin in two tiers aborts the run); an unlisted coin is tier `U`, counted. **Headlines are crypto-only (tiers 1, 2, 4)**; tier 3 (TradFi perps incl. tokenized stocks) is reported on its own; an all-tier line is printed as a sensitivity (SoT-comparable).

## 4. Methodology — the five layers (ADS-1 `1.0.0-draft`)

Every constant is `src/scripts/ads1/spec.ts`, serialised to `ops/ads1-spec.json` (sha256 at registration `6b381062c25a10b711fadd259fb9f93b3e2ac0da58e734a10148236f6123bcac`, locked by `tests/unit/ads1-spec-lock.test.ts`). The library is `src/scripts/ads1/{core,layers,rank}.ts` + `clusterEdgeCompleteWithCi` in `src/scripts/dwr-cluster-edge.ts`, known-answer-tested (`ADS1_SELFTEST`) and differential-tested against `src/scripts/cluster-perm-stats.py`.

- **L0 — the complete label.** A decided race passes through (±1). A timeout resolves by its expiry return in the called direction: ≥ +0.30 % WIN, ≤ −0.30 % LOSS, else FLAT. (A timeout's expiry lies inside its barrier, so a floor-bound barrier resolves only to FLAT — a property of the label.) `dwrComplete = W′ / (W′ + L′)`; the decided DWR, FLAT rate, timeout rate and `UNRESOLVED` count print beside it.
- **L1 — edge over the mix-matched null.** `p₀ = share_BUY·q_BUY + share_SELL·q_SELL` on the same scored rows, `q_side` = an always-side caller's complete-label hit rate; an ambiguous same-candle race is a loss for both sides (`deriveRaceOutcome`). **Headline = the per-UTC-day unweighted cluster mean** of (hit − p₀) with a one-sided day-cluster bootstrap lower bound (nearest rank, B = 2000, fixed seed), p and t; the pooled edge prints beside it. `nEff` = Kish with `m* = Σm²/Σm`, ρ = ICC(1) floored at 0 in the design effect (raw ρ reported). **Identifiability:** `NOT_IDENTIFIABLE` iff the scored-row minority share < 0.10 or the Fréchet attainable range < 1.0 pp (a `reason` names which); the Pesaran–Timmermann z is reported.
- **L2 — calibration.** One binning over the emitted support [52, 100] (`CALIB_BIN_EDGES`), shared by the reliability table and ECE; Brier of `confidence/100`, of p₀ and of ½; `BSS = 1 − Brier_impl / Brier_p₀`; Spearman(bin midpoint, realized). FULL-window L2 is floored at the April recalibration (`CALIB_FLOOR_TS`); earlier rows are counted apart.
- **L3 — coverage, emitted arm only (ruling Q3 = A).** The withheld arm is not read; the all-decisions edge is the literal `n/a: WITHHELD_ARM_QUARANTINED`. Coverage and HOLD share are census ratios only where the census units are commensurate — measured before this file (CH1): they are not (the HOLD census counts evaluations, the emitted record counts idempotent emissions), so both print `n/a: COVERAGE_UNITS_INCOMMENSURATE` beside the raw census counts, and a cell prints `n/a: CENSUS_HAS_NO_VENUE`. What L3 does measure: the edge of the emitted arm trimmed by conviction to its top 100 / 75 / 50 % (ties at the cut kept whole) and the direction flip rate.
- **L4 — payoff and cost.** `p* = ½ + c / (2B)` at the unit's median barrier, taker `c = 0.10 %`, maker `0.04 %`; `tradeable ∈ {taker, maker, none}` = the one-sided Wilson lower bound of `dwrComplete` against `p*`; the mean side-signed expiry return in barrier units.
- **L5 — provenance.** Anchored share; live days; the spec version.
- **Verdict** (first match wins): `NOT_IDENTIFIABLE` → `AUDIT` (edge ≥ 5 pp with nEff ≥ 617, or hit rate > 0.60) → `PROVISIONAL` (nEff < 3863, or the headline under-clustered) → `EXCEPTIONAL` (edge ≥ 3 pp ∧ CI-lb > 0 ∧ t ≥ 3 ∧ ≥ 365 live days ∧ ≥ 2 regimes with CI-lb > 0) → `CREDIBLE` (1 ≤ edge < 3 pp ∧ CI-lb > 0) → `NO_CLAIM`. Rendered as the literal `verdict: <TOKEN>`.

**Units.** Cells `(exchange, timeframe, tier)`, side-agnostic; roll-ups `(timeframe, tier)`, `(timeframe)` crypto-only and all-tier, `(tier)`, fleet crypto-only and all-tier; each in both windows, each at the three specs (L0 / L1 only at the two sensitivity specs). Regime is a breakdown keyed `(regime_rule_version, regime)`, never a unit.

## 5. Floors and power (PROCEDURE §5)

The independence unit is the **UTC day**. A unit's headline exists only with ≥ 20 day-clusters of ≥ 30 scored rows each (the estate's `clusterEdge` floors); below that it reads under-clustered and the verdict is `PROVISIONAL`. The standard's claim floor is `nEff ≥ 3863` — the effective trials that separate a 52 % hit rate from 50 % at one-sided α = .05 with power .8 (3862.005, ceiling; the audit floor 617 is the same computation at the audit band). The lower bound's instrument is the day-cluster bootstrap (resampling days, B = 2000, seed 20260927, nearest-rank α percentile); its width scales as 1/√(days). An underpowered unit is reported as `PROVISIONAL` with its nEff and day count — registered here, not improvised.

## 6. Support stress-test

Each registered check, the point at which it is evaluated, the support fact probed before landing (values in the vault's CH3 support probe), and whether the corpus occupies that point.

| Check | Evaluation point | Support / cardinality fact (probed live, 2026-09-27) | Verdict |
|---|---|---|---|
| Headline per-day edge + day-cluster lower bound | each unit's UTC days with ≥ 30 scored rows; ≥ 20 such days | POST_FLIP spans under 30 UTC days in total; every fleet, tier and timeframe roll-up except `1d` clears 20 qualifying days on labelled-row existence; most cells do not | `inside` for roll-ups · `floor` for most cells (read `PROVISIONAL: under-clustered`, declared in §7) · `1d` under-clustered in POST_FLIP |
| `nEff ≥ 3863` (PROVISIONAL floor) | the unit's scored rows (nEff ≤ n) | no POST_FLIP cell that clears the day floor and the minority floor also has n ≥ 3863; a named set of FULL cells does (§7) | `floor` — every POST_FLIP cell is `PROVISIONAL` or `NOT_IDENTIFIABLE` by construction |
| Identifiability — minority share ≥ 0.10 | the scored-row side mix of the unit | measured on the emitted (label-free) mix: several units sit within one point of the floor, the crypto-only headline just below it | `inside` / `outside` per unit; **knife-edge units named in §7** — decided by the scored-row share as coded, both shares printed |
| Identifiability — Fréchet range ≥ 1.0 pp | the unit's (share_BUY, always-BUY rate) | arithmetic: with minority ≥ 0.10 the range is ≥ 1.0 pp for any always-BUY rate in [0.005, 0.995]; it binds only at a near-certain market | `inside` wherever the minority rule passes |
| Calibration bins, ECE, BSS | the ten bins over [52, 101) | BUY occupies the whole support; SELL occupies [63, 96] after the flip ([60, 100] FULL) — SELL's low bins are empty | `inside` for occupied bins; empty bins print `EMPTY`, never interpolated |
| Spearman over bins | ≥ 2 occupied bins | occupied in every roll-up | `inside` |
| Calibration floor | rows ≥ `CALIB_FLOOR_TS` | FULL has rows before the April recalibration | `outside → replaced by` the floored FULL window; earlier rows counted apart |
| Conviction trim at 75 / 50 % | the unit's confidence quantiles | confidence is integer-valued; ties at a cut are kept whole, so the achieved share can exceed the target | `inside` — achieved share printed beside each trim |
| L3 coverage ratio | census counts in commensurate units | the HOLD census counts evaluations, the emitted record idempotent emissions; the HOLD census has no venue column | `outside → replaced by` `n/a: COVERAGE_UNITS_INCOMMENSURATE` (roll-ups) / `n/a: CENSUS_HAS_NO_VENUE` (cells), raw counts printed |
| Complete-label resolution of timeouts | timeouts with a stored expiry return | the backfill's reach is venue- and depth-bound (CH1 plan); rows past a venue's depth stay NULL | `inside` where reached; `UNRESOLVED` counted per unit, never estimated |
| Break-even p* | the unit's median barrier | every barrier is ≥ the 0.30 % floor | `inside` |
| `EXCEPTIONAL` | live days ≥ 365 ∧ ≥ 2 v3 regimes with CI-lb > 0 | the FULL window spans well under a year | `floor` — **unreachable**; any `verdict: EXCEPTIONAL` fails the self-check |
| Regime breakdown | `(regime_rule_version, regime)` groups | POST_FLIP is regime-rule v3 throughout; FULL carries v1 and v3 and a NULL-regime bucket | `inside`; v3 only counts toward the regimes floor; NULL disclosed |
| Tier mapping | every coin in the instrument | 0 unmapped coins in the capped corpus at the probe | `inside`; tier `U` counted if the pull differs |
| `T_FLIP` assert | rule-v1 rows after `T_FLIP` | zero at R0 and CH1 | `inside`; re-asserted at the pull (self-check) |

## 7. Declared expectations (before any outcome is read)

- **Every POST_FLIP cell** reads `PROVISIONAL` (nEff below 3863, or under-clustered) or `NOT_IDENTIFIABLE`. A POST_FLIP cell reading anything else fails the reading of this registration, not the standard.
- **FULL cells that can read beyond `PROVISIONAL`** (they clear the day floor, the minority floor and n ≥ 3863 on the label-free probe): ASTER 15m T4 · ASTER 1h T4 · BINANCE 15m T4 · BINANCE 30m T4 · BITGET 15m T3 · BITGET 15m T4 · BITGET 1h T3 · BITGET 5m T2 · BITGET 5m T4 · BYBIT 1h T4 · BYBIT 30m T4. Every other FULL cell is expected `PROVISIONAL` or `NOT_IDENTIFIABLE`.
- **Knife-edge identifiability** (emitted minority within one point of 0.10; the scored-row share decides, as coded): `fleet:crypto` POST_FLIP (**the headline — expected `NOT_IDENTIFIABLE: minority`**, since its emitted mix sits just below the floor) · `tf:12h:crypto`, `tf:15m:crypto`, `tf:30m:crypto` POST_FLIP · `tier:T4` FULL · cells BINANCE 15m T4, BINANCE 30m T4, BITGET 15m T3 (FULL). If the headline's scored-row share crosses the floor, it is scored and reported as such; the emitted share prints beside it either way.
- **Expected `NOT_IDENTIFIABLE: minority`:** tier 1 and tier 2 in both windows; `tf:3m` and `tf:5m` crypto-only in POST_FLIP; `fleet:crypto` FULL.
- **Expected under-clustered:** `tf:1d` in POST_FLIP.
- **`EXCEPTIONAL` is unreachable** in this corpus (live days < 365).
- **The honest prior:** L1 reads `NO_CLAIM` / `NOT_IDENTIFIABLE` / `PROVISIONAL` in nearly every unit; the new information is L0-complete, L2, L3 (emitted arm) and L4.

## 8. Decision rule and family accounting (PROCEDURE §6)

Per unit, three states: **attributable** (`CREDIBLE`; `EXCEPTIONAL` is unreachable) · **not attributable** (`NO_CLAIM`, cause: an edge below the claim band or a lower bound at or below zero) · **indeterminate** (`PROVISIONAL` — underpowered or under-clustered; `NOT_IDENTIFIABLE` — the null cannot be separated; `AUDIT` — implausible, examine before reading). A `NO_CLAIM` is a negative only where the lower bound excludes +1.0 pp at nEff ≥ 3863; elsewhere it is underpowered and says so. **Nothing here is promotable**: an attributable unit is a candidate for the claim ladder's own registered test on data nobody has seen, never a claim.

**`cells_tested`** = the number of (unit, window, barrier spec) triples whose day-cluster lower bound was computed (the conservative count: every such bound is a one-sided α = .05 look, whatever its verdict). It is logged in the audit JSON and added to the family total in `status.md` as `72 + cells_tested`. Conviction-trimmed and regime-level bounds are **auxiliary looks**, counted and reported separately, never read as claims. This study never writes the AOE gate's own counter.

## 9. Respecification, deviations, quarantine, publication (PROCEDURE §7–§8)

No post-result respecification is permitted on this corpus. A correction a reader would not have proposed had the result been different is registered for data nobody has seen (rows above `T_CAP`, after the seal lifts — not this study) and the in-sample value is disclosed as seen and not a test input. Any deviation from this file is recorded as a deviation with its reason in the vault audit. The withheld arm stays quarantined; nothing here reads it or cites anything for or against the HOLD-discipline hypothesis. Figures are vault-only; nothing reaches public copy (Outcome-WR law).
