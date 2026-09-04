# SELL feature attribution — PRE-REGISTRATION

**Wave:** `EDGE-SELL-FEATURE-ATTRIBUTION-W1` R0 · **Recorded:** `2026-09-04T15:29:45Z` (live `date -u`)
**Authority:** architect ratification 2026-09-04, answering this wave's Plan-Mode HALT Q1–Q5.
**Binding on:** this wave's R2 analysis and its R4 verdict.

This file is **methodology only**. Every resulting figure is internal research: no number derived
here reaches public copy, a track-record surface, an MCP response, or the Merkle path.

---

## 0. Ordering, and a disclosure this file owes

**RULE, binding from here (architect, 2026-09-04):** *cardinalities* may be probed before a
pre-registration commits; *outcome statistics* may not.

It is stated because the spec could not be obeyed as written. R0 said *"Nothing is queried until
this artifact is committed"* while AC2 required *"Corpus re-derived at R0"* — the second cannot be
satisfied without querying. The contradiction is recorded rather than quietly resolved.

**PRIOR-EXAMINATION DISCLOSURE.** At Plan-Mode time, before this artifact existed, the following
were seen:

| Seen | Value | When |
|---|---|---|
| pooled corpus DWR | `0.458243` | 2026-09-04 ~15:20Z |
| `always_sell` | `0.458243` (≡ DWR) | same |
| `always_buy` | `0.496029` | same |
| ambiguous share | `0.045728` | same |

Nothing per-indicator was read: the coverage figures in §4 are row and cluster **counts** only.
The hypothesis family in §3 is per-indicator and was fixed before any per-indicator outcome query.
Precedent for disclosing rather than concealing: `hold-decision-preregistration-2026-08-26.md` §12.

---

## 1. Corpus — literal SQL

```sql
SELECT h.decision_id, h.exchange, h.coin, l.label,
       h.rsi_score, h.ema_score, h.funding_score, h.oi_score, h.volume_score
  FROM hold_decision_labels l
  JOIN hold_decisions h ON h.decision_id = l.hold_decision_id
 WHERE l.barrier_spec = 'tau1.0-floor0.30-v1'
   AND l.label       <> 0        -- decided: the barrier race resolved, not a timeout
   AND h.would_be_side = -1      -- SELL side
   AND h.raw0      IS NOT NULL;  -- captured parts present
```

**`raw0`, not `raw_final`.** The spec's R0.1 says `raw_final`; the artifact it names as its model
registers `raw0`, and `EDGE-ATTRIBUTION-CORPUS-DRAIN-W1` aligned the labeler's `--require-parts`
filter and the canary's gate counter on `raw0` so that one question has one derivation. Measured
2026-09-04: **8,310 rows under either predicate** — identical, and they must not be allowed to
diverge. The artifact is the authority.

| | measured `2026-09-04T15:15Z` | spec claim |
|---|---:|---|
| decided SELL rows with parts | **8,310** | 8,310 ✅ |
| distinct `(venue, coin)` clusters | **1,128** | 1,242 ✗ |
| venues | **13** | 13 ✅ |

**The 1,242 is corrected here.** It is the cluster count over *labelled* SELL rows; the *decided*
corpus has 1,128. It originated in this author's own `status.md` entry and propagated into the
spec unre-derived.

**Rule-version homogeneity is argued from the WINDOW, not a column.** `hold_decisions` has no
`verdict_rule_version` column (measured: `ERROR: column h.verdict_rule_version does not exist`).
Capture began `2026-08-31T10:34:35Z`; `TREND_MODE` flipped at `09:46:35Z` the same day. Every
captured row is therefore post-flip **by construction of the capture window**.

---

## 2. Indicator ladders — from source, not memory

Read from `src/tools/get-trade-call.ts` (the producer) at `origin/main` `24e147a2`:

| indicator | weight | levels | count |
|---|---:|---|---:|
| rsi | 0.30 | −100, −80, −40, 0, 40, 80, 100 | 7 |
| ema | 0.10 | −100, 0, 100 | 3 |
| funding | 0.25 | −80, −40, 0, 40, 80 | 5 |
| oi | 0.15 | −60, −20, 0, 20, 60 | 5 |
| volume | 0.20 | −70, −30, 10, 50, 80, 100 | 6 |

**26 cells, not the ~30** assumed by `attribution-gate-preregistration-2026-09-04.md` §2. At
n = 8,310 that is ~320 rows/cell rather than the ~167 registered, so **the registered power split
was conservative** — corrected here rather than left for a reader to inherit.

⚠️ **`rsi` is regime-conditional.** `TREND_MODE` negates `rsiScore` when
`regime = TRENDING_UP ∧ rsi > 70` or `TRENDING_DOWN ∧ rsi < 30`. Negation is a bijection on the
symmetric level set, so the LEVELS are unchanged — but the map from RSI *value* to level is
regime-dependent, and an `rsi` finding is a finding about the **post-flip ladder**, not about RSI.

---

## 3. Hypothesis family — declared before computing

**FDR family (BH, q = 0.05), exactly four members:**

| # | H0 |
|---|---|
| H1 | `oi_score` level carries no monotone association with SELL DWR |
| H2 | `ema_score` level carries no monotone association with SELL DWR |
| H3 | `volume_score` level carries no monotone association with SELL DWR |
| H4 | `rsi_score` level carries no monotone association with SELL DWR |

**`funding` is OUTSIDE the family, declared UNTESTABLE-BY-COVERAGE.** 7,620 of 8,310 rows (91.7%)
sit at level 0; the remaining levels hold 17, 667 and 6 rows (3, 199 and 4 clusters). There is no
contrast to test. A test would return a near-vacuous null that **reads as "no signal" when it means
"no variation"** — the precise confusion this wave exists to avoid. It is reported descriptively and
may not be cited as evidence either way.

**An untestable INDICATOR is not an underpowered LEVEL, and neither is silently dropped.** `rsi`
and `volume` stay in the family and are tested on their powered levels; every below-floor level is
reported **INDETERMINATE by name** with its counts. Dropping a level changes what is being tested
and the reader cannot see that it happened.

Declared below-floor levels (floor = `VALIDITY_POWERED_FLOOR` = **50 clusters**, shipped in
`src/scripts/edge-stats.ts`):

| indicator | INDETERMINATE levels | clusters |
|---|---|---|
| rsi | 80, 100 | 35, 13 |
| volume | 100 | 49 |
| funding *(outside family)* | −40, 80 | 3, 4 |

---

## 4. Coverage — cardinality only, no outcomes read

Rows / clusters per level over the decided corpus:

| indicator | levels (rows / clusters) |
|---|---|
| **oi** | −60: 2464/708 · −20: 2505/785 · 0: 578/127 · 20: 1969/677 · 60: 794/336 |
| **ema** | −100: 6592/1070 · 100: 1718/617 · *(level 0 absent)* |
| **volume** | −70: 3734/854 · −30: 2972/854 · 10: 1223/543 · 50: 230/182 · 80: 78/66 · **100: 73/49** |
| **rsi** | −100: 202/118 · −80: 359/221 · −40: 635/345 · 0: 5718/1057 · 40: 1330/586 · **80: 45/35** · **100: 21/13** |
| funding | −40: 17/3 · 0: 7620/1081 · 40: 667/199 · 80: 6/4 |

**Informative clusters** — those carrying a within-cluster level contrast, which is what the §5
test is powered by:

| indicator | informative / total |
|---|---|
| oi | 871 / 1128 |
| volume | 847 / 1128 |
| rsi | 770 / 1128 |
| ema | 559 / 1128 |

All are far above the 50-cluster floor, so the test is feasible for every family member.

---

## 5. The test — association, never excess over a baseline

### 5.1 Why there is no external comparator, recorded as a methodological finding

On a corpus that is 100% one side, **every external baseline is the quantity under test, a monotone
transform of it, or a constant.** Measured on the live 8,310:

```
dwr         0.458243
always_sell 0.458243   ≡ dwr EXACTLY
always_buy  0.496029   = (1 − amb 0.045728) − dwr
random      0.477136   = 0.5 × (1 − amb)
```

so `edge vs always-BUY` = `2·dwr − 1`: it cannot move except as the quantity under test moves.
`ops/monitoring/population-comparison.schema.json` independently bans `MAX_NAIVE`, `RANDOM` and
`ALWAYS_LONG` as marginals, and its identifiability rule at BUY share `q = 0` gives an attainable
width of **0.00 pp** — so any cross-population effect claim on this corpus is `NOT_IDENTIFIABLE` by
the estate's own gate. The law's own `MIX_MATCHED_NULL` degenerates too: at `q = 0` it reduces to
`p_short`, which is `dwr`.

**These numbers are recorded here as the FINDING and are published nowhere else.** A degenerate
figure printed "as context" is a figure a future wave will cite.

### 5.2 What is identifiable

Side mix is constant (`q = 0`) across **every** bucket, so it cancels rather than confounds. The
identifiable question is **association**: does DWR vary with the indicator's bucket level?

### 5.3 Statistic, null, and aggregation

- **Aggregation is PER CLUSTER, never pooled.** The `(venue, coin)` cluster is the independence
  unit. Per level, the reported estimate is the **unweighted mean of cluster DWRs**, so the busiest
  cluster cannot carry a level.
- **Primary statistic per indicator:** `rho` = Spearman rank correlation between the indicator
  level value and the binary win indicator (`label = +1`), over all decided rows.
- **Null:** **within-cluster permutation** of level labels, `B = 10,000`, seed below. Permuting
  inside a cluster preserves both that cluster's level composition and its outcome composition, so
  it destroys exactly the level↔outcome association and nothing else. Two-sided p.
- **Interval:** cluster bootstrap (resample `(venue, coin)` clusters with replacement, `B = 10,000`,
  percentile), reported per level alongside a Wilson interval on the pooled cell for reference.
- **Reference for a cell** is the **corpus DWR 0.4582**, never 0.5.
- **Secondary, descriptive only:** heterogeneity (max−min across powered levels), same null.

**Reused, not rebuilt** — all from `src/scripts/edge-stats.ts`: `benjaminiHochberg(q)`,
`wilsonInterval`, `excessZP`, `dwrFromLabels`, `VALIDITY_POWERED_FLOOR = 50`,
`VALIDITY_HOLDOUT_ALPHA = 0.05`.

🚫 **`computeCellStats` (`src/scripts/dwr-baseline.ts`) MUST NOT be called.** It hardcodes
`benchmark = max(alwaysBuyDwr, alwaysSellDwr)` and `edge = dwr − benchmark`; invoking it would
import the exact comparator this wave requires to be provably absent.

---

## 6. The split — cluster-wise, seed fixed here

- **Unit:** `(venue, coin)` cluster. **Never by row** — rows from one cluster on both sides is
  leakage.
- **Seed:** the literal string `EDGE-SELL-FEATURE-ATTRIBUTION-W1`. Chosen as the wave id, so it
  cannot have been tuned.
- **Algorithm:** order clusters by `md5(seed || '|' || cluster_key)` ascending; the first **70%**
  are TRAIN, the remainder HOLDOUT. Deterministic and re-derivable by any reader.
- **Use:** discover on TRAIN; a finding is real only if it survives HOLDOUT.

---

## 7. Decision rule — written before any number is seen

A **HIT** for indicator *I* requires **both**:

1. **TRAIN:** BH-FDR-adjusted p < **0.05** across the four-member family of §3, and
2. **HOLDOUT:** the *same-signed* `rho` with unadjusted p < **0.05**
   (`VALIDITY_HOLDOUT_ALPHA`).

Anything satisfying (1) but not (2) is reported as **DISCOVERY-ONLY, not a finding**. Anything
satisfying neither is a **null for that indicator**.

**Wave verdict:**
- **≥1 HIT** → some input carries SELL directional signal; reweighting is live as a hypothesis, and
  `EDGE-SCORING-LADDER-REDESIGN-W2` may use it **as an input, never as a public figure**. Given
  repeated independent pre-registered attempts that found no directional edge, winner's curse
  remains the leading alternative explanation for a single hit.
- **0 HITS** → SELL scoring is not repairable by reweighting these inputs. That retires the ladder
  redesign as an edge play and moves the question to new inputs or to dropping directional SELL
  claims. **This is the more likely outcome and it is not a failure of the wave.**

No hypothesis may be added after seeing data. If the corpus suggests one, it is registered for a
**future** wave and said so.

---

## 8. The regime cut — declared UNDERPOWERED, run descriptively

Reported in its **own family, outside FDR control**. No cell in it may be cited as a finding, and
its own counts are named for a future powered run. Declaring it beforehand is what stops a
promising-looking cell being promoted after the fact.

---

## 9. Selection effects — stated before results

1. **The corpus side-mix is MANUFACTURED.** `EDGE-ATTRIBUTION-CORPUS-DRAIN-W1` drained SELL-first
   by design. Within-SELL attribution is unaffected — that is the question — but **no figure
   depending on the side mix generalises to the fleet.**
2. Withheld rows are precisely the sub-threshold ones: this measures whether sub-threshold reads
   carry information, **not product accuracy**.
3. The fleet arm is cell-sampled at capture (`uq_hold_decisions_fleet_cell`); the request arm is not.
4. 13 of 15 venues are represented: HL and WEEX carry no post-capture labels, because the drain
   excluded them on measured batch saturation.
5. **Third-consumer terms hold.** This may **not** be cited for or against the HOLD-discipline
   hypothesis (ratified 2026-09-03), and nothing derived reaches public copy.

---

## 10. Spec clauses superseded by the 2026-09-04 ruling

R1 was rewritten; its downstream consumers were not. Recorded so a later reader does not mistake
compliance with the ruling for a violation of a stale clause.

| Spec clause | Superseded by |
|---|---|
| R0.1 `raw_final IS NOT NULL` | `raw0` (§1) |
| R0.2 "each of the **five** indicators" | four-member family; funding outside (§3) |
| R0.6 "Comparators — name them here" | there are none; the framing is association (§5) |
| **AC2** "8,310 / **1,242** / 13" | 1,128 clusters (§1) |
| **AC3** "Comparators are random + always-BUY" | **directly contradicts the rewritten R1**, which bans both |
| R4 "`AOE-status.md` entry" | vault-root `status.md` |
| R4 WIS "the comparator must be random and the opposite side" | contradicts R1; the lesson is that **no** external comparator exists here |
| R4 WIS "eight pre-registered attempts" | count dropped as unverifiable; stated qualitatively |

---

## 11. Deviations

A deviation from this file is recorded here as a deviation, with its reason, and is never silently
absorbed. None at recording.
