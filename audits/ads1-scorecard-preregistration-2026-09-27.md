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

_Superseded by §10 (amendment 2026-10-02) — kept for the record._

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

_Superseded by §10 (amendment 2026-10-02) — kept for the record._

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

## 10. Amendment 2026-10-02 — the `-v2` label family, the max-form cap, the coverage chain (pre-read; recorded per §9 / PROCEDURE §8 with its reason)

**Ordering.** This amendment lands before the first outcome query of the scorecard's read session (none has run as of this commit). It is the one amendment this registration admits; after it, deviations go to the vault audit (§9), never to this file. The self-check's row "registration landed before the pull" now tests this commit's timestamp (the later of the two), under its new name "registration and amendment landed before the pull".

**Reason.** `EDGE-LABELER-RACE-WINDOW-V2-W1` R0 (2026-09-28, label-free replay, cardinality): the `-v1` race skipped a candle inside its window and ran past the vertical barrier on a material share of the T_CAP primary rows (a cardinality, valued in the vault LRW endpoint-truth — this file stays figure-free). The corrected generator writes a versioned family beside `-v1`. Scoring the product against the defective referee would measure the labeller, not the calls. Every element below was fixed in rulings dated before any outcome statistic of this corpus or of the `-v2` family was computed by anyone: LRW-Q12 (2026-09-28), LRW-Q15 / LRW-Q16 (2026-09-29), OAH-Q8 (2026-09-30, `status.md` 03:35 UTC entry) — all before the 2026-09-30 09:45Z readout disclosed in §10.6. The amendment is mechanical: §4, §5, §6, §7 and §8 are byte-unchanged (asserted by `scripts/gates/ads1-amend-gate.sh`). The Step-0 completions made at this landing (2026-10-02) — the per-signal presence statement, the two session settings and the family echo, the `pre_cut` / `unstamped` / `not visited` chain classes, the imported fractional `T_CUT_EPOCH`, the figure-free wording of this paragraph — are mechanical and outcome-independent, and each is marked where it occurs.

**10.1 Barrier specs.** Primary **`tau1.0-floor0.30-v2`** (defines the population); sensitivity `tau0.5-floor0.30-v2`, `tau2.0-floor0.30-v2` (L0 / L1 only, on the same rows). The literals are `BARRIER_SPECS_V2` in `src/scripts/directional-labeler.ts` — the one constants module; `src/scripts/ads1/spec.ts` imports them and `ops/ads1-spec.json` (sha256 at this amendment `31e1c67f436888a00f7cdbbbf9f7001938de6a4cba2a6ecdbe84fe2df5eb69b8`, locked by `tests/unit/ads1-spec-lock.test.ts`) carries them to the AOE port. No `-v1` column is read by this study — not its label, not its `race_gap_candles`. Two label-free exceptions, both presence-shaped: the `-v1` primary's PRESENCE (an `EXISTS`, never a value) is read by the label-free presence statement below, as the chain's "`-v1` present" step (10.4); and LRW's own annotation DONE probe (precondition (i) of 10.3, `NULL_V1_GAP` in `src/scripts/lrw/completeness.ts`) selects the `(signal_id, barrier_spec)` keys of `-v1` rows whose `race_gap_candles` IS NULL — a completeness test of LRW's annotation, keys only, never a value.

**10.2 Corpus predicate — `T_CAP` in the ruled max form** (ruling Q11; LRW-Q8): a row is in the population iff `created_at ≤ 1790402400 AND created_at + (W+1)·max(requested, served) ≤ 1790402400`, where `served` differs from `requested` only on the coarser-served pairs, listed literally: `GATE 3m, MEXC 3m, HTX 3m, PHEMEX 3m, WEEX 3m, XT 3m → 300 s · WHITEBIT 3m, WHITEBIT 5m → 900 s · PHEMEX 12h → 86 400 s` (the same nine rows as `audits/labeler-race-window-v2-preregistration-2026-09-28.md` §3.1; derived in code from `servedCandleStepMs` as `COARSER_SERVED` in `src/scripts/ads1/spec.ts`, asserted equal as a set by test; the generated `VALUES` list carries them in the derivation's order). In code the population predicate is `withinTCapMax`; the requested-form `withinTCap` stays byte-unchanged because the nightly labeller's seal edge (`sealEdgeRow`) is defined against it. Windows, `T_FLIP`, exclusions by name — unchanged. The EDGEX pre-cohort disclosure (§3, D33) and BITMART: both venues are retired; their rows reach no `-v2` label and are counted `unreachable:retired` (10.4).

**10.3 The read session.** §3.1's four parts stand (tokens first; counters-before → extract → label-free → counters-after; `aoe_readonly`, `BEGIN READ ONLY`; Mac scratch; sha256 recorded). **Preconditions, asserted before the first statement and recorded in the audit:** (i) LRW's historical relabel reports CONVERGED and its `race_gap_candles` annotation reports complete — measured by LRW's own read-only DONE probes (`src/scripts/lrw/completeness.ts`), run by this session, tokens recorded; (ii) no labeller, relabel runner or annotation process alive on signal-1 (process census), and the `directional_labels` write counters unchanged across the session; (iii) outside 02:20–06:30Z and outside 18:30–02:15Z; (iv) `_verify.sh` reports `PREREG_MIRROR_VERDICT=PASS` for this file. Any precondition false → `ADS1_PULL_WAIT: <which>`, exit 3, nothing read (precondition (i) is itself measured by LRW's two label-free probe statements, `node dist/scripts/lrw/completeness.js --emit MISSING_V2 | NULL_V1_GAP`, each in its own `BEGIN READ ONLY` behind LRW's token statement — keys only; "nothing read" means no statement of the four registered parts runs). The session runner is `scripts/ads1/ads1-pull.sh` (committed with this amendment); every statement of the four registered parts is printed by `node dist/scripts/ads1-scorecard.js --print-session <part>` from the generator, and the precondition probes are LRW's own.

**The label-bearing extract — the allow-list SELECT (replaces §3.1's; the generator `src/scripts/ads1/extract-sql.ts` changed in this commit; pinned byte-equal by `tests/unit/ads1-scorecard.test.ts`):**

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
         d10.computed_at AS computed_t10,
         d10.race_gap_candles AS gap_t10,
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
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('PHEMEX', '3m', 300), ('PHEMEX', '12h', 86400), ('HTX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN directional_labels d10 ON d10.signal_id = s.id AND d10.barrier_spec = 'tau1.0-floor0.30-v2'
  LEFT JOIN directional_labels d05 ON d05.signal_id = s.id AND d05.barrier_spec = 'tau0.5-floor0.30-v2'
  LEFT JOIN directional_labels d20 ON d20.signal_id = s.id AND d20.barrier_spec = 'tau2.0-floor0.30-v2'
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
  ORDER BY s.id
) TO STDOUT WITH (FORMAT csv, HEADER)
```

| New column | Why it is read | Class |
|---|---|---|
| `d10.computed_at AS computed_t10` | the provenance split (relabel / nightly), the `T_ADAPTER` split on BITGET 2h/8h — a first-write stamp, never a label | provenance |
| `d10.race_gap_candles AS gap_t10` | the generator's own contiguity assertion (expected 0 on every row; the self-check asserts it) | provenance |

Two session settings, no statement change: each part sets `TIME ZONE 'UTC'` and `DateStyle 'ISO, YMD'` before its transaction, so `computed_t10` prints in the one form the parser accepts (any other form is refused, never guessed); and the extract part prints a `===FAMILY===` line — the primary literal of the generator that emitted the SQL — which the scorecard and the AOE port both assert equals the registered primary.

**Label-free presence statement (added to the label-free part; reads no label or outcome column — `EXISTS` only; its one provenance predicate is `computed_at` inside the `v2_post_adapter` `EXISTS`, a boolean against `T_ADAPTER`, never a value):**

```sql
COPY (
  SELECT s.id, s.exchange, s.coin, s.timeframe, CASE WHEN s.created_at > 1788169595 THEN 'POST' ELSE 'PRE' END AS win,
         EXISTS (SELECT 1 FROM directional_labels v1 WHERE v1.signal_id = s.id AND v1.barrier_spec = 'tau1.0-floor0.30-v1') AS v1_present,
         EXISTS (SELECT 1 FROM directional_labels v2 WHERE v2.signal_id = s.id AND v2.barrier_spec = 'tau1.0-floor0.30-v2') AS v2_present,
         EXISTS (SELECT 1 FROM directional_labels v2 WHERE v2.signal_id = s.id AND v2.barrier_spec = 'tau1.0-floor0.30-v2' AND v2.computed_at >= to_timestamp(1790864836)) AS v2_post_adapter
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('PHEMEX', '3m', 300), ('PHEMEX', '12h', 86400), ('HTX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
  ORDER BY s.id
) TO STDOUT WITH (FORMAT csv, HEADER)
```

_Correction at Step 0, before landing (recorded, not ruled): the dispatch drafted this statement grouped by `(exchange, timeframe, window)` with four counts. Grouped, it cannot carry what 10.4 registers — the chain per unit (a unit's tier comes from the coin), the `no_v1_twin` class (`-v2` present, `-v1` absent) and the placement of LRW's refusal manifest, which is keyed by signal id alone. It is therefore emitted one row per registered signal under the same predicate, with the same literals and the same three presences; every grouped count is a projection of it in code (`buildCoverage`, `src/scripts/ads1/scorecard.ts`). No column beyond presence is added._

**The integrity statement** `sensitivity_only_under_tcap` reads the `-v2` sensitivity literals and the max-form predicate (same shape as §3.1, family and predicate substituted):

```sql
COPY (
  SELECT 'v1_after_flip' AS item, count(*)::bigint AS n FROM signals WHERE verdict_rule_version = 1 AND created_at > 1788169595
  UNION ALL
  SELECT 'sensitivity_only_under_tcap', count(DISTINCT s.id)::bigint
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('PHEMEX', '3m', 300), ('PHEMEX', '12h', 86400), ('HTX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec IN ('tau0.5-floor0.30-v2', 'tau2.0-floor0.30-v2')
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND NOT EXISTS (SELECT 1 FROM directional_labels p WHERE p.signal_id = s.id AND p.barrier_spec = 'tau1.0-floor0.30-v2')
) TO STDOUT WITH (FORMAT csv, HEADER)
```

The census statements of §3.1 are unchanged.

**10.4 Coverage travels with its denominators — the chain** (ruling Q11; LRW-Q15/Q16): per `(exchange, timeframe)` and per unit, both windows: **registered** (every BUY/SELL signal under the predicate, label-free) → **`-v1` present** (presence only; the relabel's input) → **`-v2` present** = the population, n, in three provenance classes counted apart and pooled in the population: `relabel` (`computed_at` ≥ the relabel launch epoch LRW records), `nightly` (`[T_CUT, launch)`, `T_CUT` = `T_CUT_EPOCH` = 1790754894.743475 = 2026-09-30T07:54:54Z, imported from `src/scripts/lrw/registered.ts`), `no_v1_twin` (LRW-Q16) — plus `pre_cut` (a `-v2` row first written before `T_CUT`: impossible by construction, printed, expected 0) and `unstamped` (a `-v2` row present in the label-free part but absent from the extract — a write between the two parts; expected 0, and the self-check fails on it) → **refused** (LRW's sha-pinned refusal manifest: a hole inside the W-window, `UNRESOLVED_GAP`) → **unreachable** by reason (`depth`, `history`, `retired`, `adapter-pending` for rows attempted before `T_ADAPTER`) → **deferred** / held back (expected 0 under `T_CAP`: every window closed long before the relabel) → **not visited** (no manifest line: a signal outside the relabel's own population, `src/scripts/lrw/relabel-sql.ts`, split by whether a `-v1` row exists — so every registered row lands in exactly one class). Refusal and reach are venue-data facts (a function of venue and `created_at`), never of an outcome; the FULL window's pre-flip reach is bounded by venue depth at relabel time and is printed per unit beside n (`reach = -v2 present / registered`) — no verdict rule is attached to it. The second denominator of §3 (rows whose complete label resolved) is now the whole population: the `-v2` race writes the expiry return from the same served-grid window, so **`UNRESOLVED` and `INCONSISTENT` are expected 0 by construction**; a non-zero count is printed, the rows excluded as registered, and the count escalated to the LRW owner as a generator finding — never coerced, never estimated. §6's row "Complete-label resolution of timeouts" reads `inside` by construction; the `--expiry-only` backfill's reach is not an input of this study.

**10.5 BITGET 2h / 8h** (OAH-Q8 analogue): in these two cells a `-v2` row with `computed_at ≥ T_ADAPTER = 1790864836` (2026-10-01T14:27:16Z, the first container on the `OPS-ADAPTER-HISTORY-ANCHOR-W1` CH2 commit; pinned once as `T_ADAPTER` in `src/scripts/ads1/spec.ts`; the two cells are this study's own registered set `ADAPTER_SPLIT_CELLS` there — deliberately not LRW's `ADAPTER_PENDING_CELLS`, which LRW changes when its relabel reaches them) was raced on a served σ history the shipped adapter could reach; rows with `computed_at < T_ADAPTER` on these pairs print apart as `pre-adapter-fix` (expected few: the relabel runs after the stamp). Both counts print; the cells are reported with the split; nothing else changes.

**10.6 Prior-examination addendum (PROCEDURE §2) — seen between 2026-09-27 and this landing:**

| Seen | Class | Where recorded |
|---|---|---|
| LRW R0 label-free replay: race-window hole prevalence, σ-history holes, the crossed stratum, grid class (sha-pinned) | `cardinality` | vault LRW endpoint-truth §6 |
| ADS-1 CH2 AC3: expiry-coverage table per venue × window; the fixed-nightly `bool_or` booleans | `cardinality` / `coverage ratio` | vault ADS-1 endpoint-truth |
| LRW CH2 first-nightly counters (`v2Labeled`, refused, unreachable, `V2_HELDBACK`, `V2_NO_V1_TWIN`, `-v2` rows since `T_CUT`, `-v2` rows on T_CAP-era signals) | `cardinality` | status.md 2026-10-01 07:05 UTC |
| OAH first-nightly spot-check: BITGET 2h twins reached before / after `T_ADAPTER` | `cardinality` | status.md 2026-10-02 06:23 UTC |
| `SIGNAL-TREND-MODE-READOUT-W1` (2026-09-30 09:45Z): daily and pooled excess over the mix-matched null of the side-aware `outcome_return_pct` win predicate, per timeframe and timeframe × side, post-flip window, regime-rule v3, ex-BITMART — **a different label** (the PFE outcome column, not the barrier race or the complete label), the same null shape, on a corpus overlapping this one | `seen — not a test input` | status.md 2026-09-30 09:45 UTC (private figures) |
| LRW CH3's disagreement table (`-v1` vs `-v2`): **not seen** at this landing (its pull waits on this commit). Whichever of the two registered pulls runs first, the other's audit records what had been published, as `seen — not a test input` | — | the two vault audits |

No expectation in §7 is added, removed or reworded on account of anything above; `hold_decision_labels` has still never been read by this study.

**10.7 Family accounting, publication — unchanged** (§8, §9): `cells_tested` logged and added as `72 + cells_tested`; figures vault-only; nothing promotable.

## Identifiability

(PROCEDURE §4c; this file leaves the grandfather list in this commit.)

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| L1 edge of the emitted arm over its own mix-matched null (within-arm; §4) | emitted calls, per unit, both windows — every scored unit has m ≥ 0.10 by the registered rule (§4: a unit below it is `NOT_IDENTIFIABLE: minority` before any floor is evaluated), so the least admissible share binds | `0.100` — the registered floor `src/scripts/ads1/spec.ts` `MINORITY_SIDE_FLOOR` (probe: `node -e "console.log(require('./dist/scripts/ads1/spec.js').MINORITY_SIDE_FLOOR)"`) | 1.0 (`CREDIBLE`) | 20.0 | `IDENTIFIABLE` |
| same | same | `0.100` (same probe) | 3.0 (`EXCEPTIONAL`) | 20.0 | `IDENTIFIABLE` |
| same | same | `0.100` (same probe) | 5.0 (`AUDIT`) | 20.0 | `IDENTIFIABLE` |

The per-unit scored-row share and the Fréchet range are computed at the read and gated by §4 (`frechetAttainablePp`, parity-tested against `attainable_bound_from_share` by subprocess, `tests/unit/ads1-frechet-parity.test.ts`); the headline's probed emitted share stays a vault cardinality (§2).
