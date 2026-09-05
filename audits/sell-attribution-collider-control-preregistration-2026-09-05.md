# SELL attribution — COLLIDER CONTROL — PRE-REGISTRATION

**Wave:** `EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1` R0 · **Recorded:** `2026-09-05T03:28:57Z` (live `date -u`)
**Authority:** architect ruling 2026-09-04 — GO WITH SCOPE CHANGE, answering this wave's Plan-Mode HALT Q1–Q7.
**Predecessor:** `EDGE-SELL-FEATURE-ATTRIBUTION-W1` (prereg `2aaa2878`; figures vault-only).
**Binding on:** every control run in R1 and the R3 verdict.

This file is **methodology only**. No figure derived under it reaches public copy, a track-record surface,
an MCP response or the Merkle path. Third-consumer terms hold: nothing here may be cited for or against the
HOLD-discipline hypothesis.

---

## 0. Ordering, and the disclosure this file owes

**RULE (architect 2026-09-04, inherited from W1 §0):** *cardinalities* may be probed before this file
commits; *outcome statistics* may not. Every number in this file is a cardinality, a coverage ratio or a
schema fact.

**PRIOR-EXAMINATION DISCLOSURE.** Before this artifact existed, Plan Mode read — and the successor's
verification agents re-read — the following. Nothing directional (no DWR, win rate, ρ or p) was computed.

| seen | value | class |
|---|---|---|
| decided SELL corpus | 8,310 rows · 1,128 clusters · 13 venues | cardinality |
| labelled SELL rows incl. timeouts | **17,113** (decided 8,310 · timeout 8,803 = 51.44%) | cardinality |
| decided-vs-timeout rate by `oi_score` level | −60 45.55% · −20 50.39% · 0 35.53% · +20 52.35% · +60 59.08% | **coverage ratio** |
| same by `ema_score` | −100 47.70% · **0 → 0.00% (84 rows)** · +100 53.52% | coverage ratio |
| same by `volume_score` | −70 46.58% · −30 51.23% · **0 → 0.00% (270 rows)** · 10 51.47% · 50 59.43% · 80 55.32% · 100 60.33% | coverage ratio |
| adjustment activity on the SELL corpus | `funding_delta≠0` 106 · `hurst_delta≠0` 1,657 · `squeeze_delta≠0` 2,785 | cardinality |
| identity `raw0+Δf+Δh+Δs = raw_final` | 0 violations at 1e-9 / 8,310 | schema fact |
| withheld BUY arm | 347 rows · 106 clusters · **1 venue (ASTER)**; ASTER SELL 882 rows / 167 coins | cardinality |
| emitted arm (deduped) | 18,921 decided · 16,546 positive (`raw_final ∈ [+46,+105]`) · 2,375 negative (`[−85,−56]`) · pooled hole `[0,+46)` | cardinality |
| W1's published marginal ρ and level DWRs | known to the author — they are the PREMISE of this wave | inherited |

The decided-rate ratios sit at the boundary of the rule. They are disclosed rather than concealed
(precedent: W1 §0), and **hypothesis H3 in §3 was fixed because of them, before any outcome was read** —
that is the honest order and it is recorded as such.

**Two stale-source failures recorded here so they are not repeated:**
- The spec's *"Hurst is inert"* cited `EDGE-SCORING-LADDER-DECOMPOSITION-W1` §1.3, which
  `EDGE-SCORING-LADDER-REDESIGN-W1` §1.5 had already corrected to *"dead on five venues of eight"*.
  Measured here: `hurst_delta ≠ 0` on 1,657 / 8,310 rows and it is the sole sign-flip mechanism on 139
  of the 203 rows the sentence existed to explain. **Cite the latest correction, not the first statement.**
- `validityVerdict` on R2's reuse list is the **third** instance in this arc of a banned comparator
  (`max(alwaysBuy, alwaysSell)`) arriving on a reuse list. It is STRUCK (§5).

---

## 1. Corpora — literal SQL

All three read the quarantined stores through the ruling's boundary: a pre-registered analysis committed
under `audits/` (outside both firewall scans) and a session-local query layer; statistics run in the PURE
committed module (§5). Timestamps are epoch seconds; `barrier_spec = 'tau1.0-floor0.30-v1'` throughout.

**(A) Withheld SELL, ALL labelled rows** — timeouts kept, because H3 needs them:
```sql
SELECT h.decision_id, h.exchange, h.coin, h.timeframe, h.regime, h.suppression_reason,
       l.label,                                   -- +1 win / -1 loss / 0 TIMEOUT (kept)
       h.rsi_score, h.ema_score, h.funding_score, h.oi_score, h.volume_score,
       h.raw0, h.funding_delta, h.hurst_delta, h.squeeze_delta, h.raw_final,
       h.hurst_adjust_code
  FROM hold_decision_labels l
  JOIN hold_decisions h ON h.decision_id = l.hold_decision_id
 WHERE l.barrier_spec = 'tau1.0-floor0.30-v1'
   AND h.would_be_side = -1
   AND h.raw0 IS NOT NULL;
```
Expected: **17,113** rows, of which **8,310** decided (`label <> 0`) — the W1 corpus, re-derived.

**(B) Withheld BUY, all labelled rows** — identical to (A) with `h.would_be_side = 1`. Expected 610 labelled
/ **347** decided, all ASTER. D2 uses the ASTER subset of (A) and (B).

**(C) Emitted arm, decided, DE-DUPLICATED on `scorer_input_id`** (the `(signal_hash, exchange)` join fans
out: 18,927 rows for 18,921 inputs):
```sql
SELECT DISTINCT ON (i.scorer_input_id)
       i.scorer_input_id, i.exchange, i.coin, i.timeframe, i.regime, dl.label,
       i.rsi_score, i.ema_score, i.funding_score, i.oi_score, i.volume_score,
       i.raw0, i.funding_delta, i.hurst_delta, i.squeeze_delta, i.raw_final, i.hurst_adjust_code
  FROM signal_scorer_inputs i
  JOIN signals s            ON s.signal_hash = i.signal_hash AND s.exchange = i.exchange
  JOIN directional_labels dl ON dl.signal_id = s.id
 WHERE dl.barrier_spec = 'tau1.0-floor0.30-v1' AND dl.label <> 0 AND i.raw0 IS NOT NULL
 ORDER BY i.scorer_input_id, dl.computed_at DESC;
```
Expected **18,921** rows (16,546 positive / 2,375 negative). **POOLING (C) WITH (A) OR (B) IS FORBIDDEN**
(architect Q7): the pooled support has a 46-value hole at `[0,+46)`, sign stays perfectly separable by a
magnitude threshold, and no side effect is identified.

---

## 2. The conditioning — two conjuncts, two numbers (AC4)

Membership in the decided SELL corpus is
`(raw_final < 0) ∧ (below_threshold ∨ book_liveness) ∧ (label ≠ 0) ∧ captured ∧ (fleet-sampled ∨ request)`.

| conjunct | observed from the scorer parts? | share |
|---|---|---|
| **score-side** `raw_final < 0` | **YES — 100.000%**: `raw0 = Σ wᵢ·bucketᵢ` exactly, and `raw0 + funding_delta + hurst_delta + squeeze_delta = raw_final` with 0 violations at 1e-9 on 8,310 rows | 100% |
| entry channel | 8,279 `below_threshold` (score-gated, needs `timeframe` for the threshold) · **31 `book_liveness`** (not score-gated) | 99.63% score-gated |
| **outcome-side** `label ≠ 0` | **NO** — barrier resolution is a function of the realized price path; no scorer part expresses it. Drops 8,803 of 17,113 labelled rows (51.44%) | **0% observed from X** |

**AC4 is answered by BOTH numbers, printed adjacent with their scopes.** A bare "100%" would license R3 to
treat the collider as fully adjustable while the outcome-side conjunct sits uncontrolled.

---

## 3. Three hypotheses, co-equal, and the sign mapping (the trap)

| | hypothesis | mechanism |
|---|---|---|
| **H1** | indicator signal | the indicator carries directional information of its own |
| **H2** | collider on the sum | the marginal association is BORROWED from another component through the `raw_final < 0` conditioning (Berkson: 9 of 10 pairwise indicator correlations negative, W1) |
| **H3** | differential barrier resolution | an indicator predicts *whether a barrier resolves* (e.g. via volatility), so the decided set is selected, and its attrition rate co-moves with the gradient (§0) |

**Sign mapping, written before any arm is read.** Let ρ_corr be the association between an indicator and
*call correctness* within an arm, and ρ_dir its association with *downward price direction*
(SELL: ρ_dir = ρ_corr; BUY: ρ_dir = −ρ_corr).

| class | ρ_corr SELL→BUY | ρ_dir SELL→BUY | which designs see it |
|---|---|---|---|
| **direction-class** (H1 *or* H2) | **FLIPS** | **same** | D2 — *cannot* separate H1 from H2 |
| **correctness-class** (H3, or any side-symmetric mechanism) | **same** | **flips** | D2 |
| H1 vs H2 | — | — | **D1 only** (partial survives ⇒ H1; vanishes ⇒ H2) |
| H3 vs {H1, H2} | — | — | **D8** (IPW / all-labelled outcome), corroborated by D2's class reading |

**Why the mirror is blind between H1 and H2, derived here so it cannot be claimed otherwise later:** under
H2 the borrowed association is inherited from a component that DOES carry direction; Berkson's negative
dependence holds in both half-spaces (`S<0` and `S>0`), so the proxy's correctness sign flips exactly as a
real signal's would. The mirror therefore separates the direction-class from the correctness-class and
nothing finer. "Same sign ⇒ real, mirrored ⇒ selection" — the framing W1 warned against — is **wrong in
both halves** and is not used.

**A-priori prior, recorded so it cannot be claimed afterwards:** `oi` is the only family member with a
plausible non-price causal story (positioning); `rsi` and `ema` are price-derived and are the most likely
H2 artifacts. **If exactly one survives, `oi` is the predicted survivor.** `rsi` is the weakest: a
significant ρ on a ragged non-monotone gradient driven by one contrast (level 0 = 3,938 of W1's 5,705
train rows). No FDR table may flatten that; §8 carries it as a named caveat.

---

## 4. Family and floor

**FDR family (BH, q = 0.05), exactly four members:** `oi`, `ema`, `volume`, `rsi` — tested on the
PARTIAL (D1) and on the marginal beside it. **`funding` stays OUTSIDE**: 91.7% of the withheld corpus at
level 0 (untestable-by-coverage, W1 §3), and its apparent contrast on the emitted arm is 99.6% collinear with
side — untestable-by-collinearity, which is worse because it looks powered. It is reported descriptively only.

**The floor is a PREDICATE, per arm.** `powered_levels(levels, clusters, floor = 50)` in the committed module
decides what is powered; a level carried by fewer than **50 distinct clusters in the arm being tested** is
reported **INDETERMINATE by name with its count** and excluded from that arm's test. Nothing else may decide
it. The shipped `VALIDITY_POWERED_FLOOR` (`edge-stats.ts`) is 50 decided ROWS; a 50-CLUSTER floor is
strictly stronger and is the unit W1 declared. Levels known at recording to be structurally unresolvable —
`ema 0` (84 labelled, 0 decided) and `volume 0` (270, 0) — are reported by name in every design and are
not data points.

---

## 5. Instrument — committed, pure, mutation-proven

`src/scripts/cluster-perm-stats.py` (commit `820af00b`), pure statistics over arrays: W1's
`perm_test` (exact null centre), `spearman`, `bh`, `split_clusters`, `cluster_level_means` lifted
verbatim; NEW `powered_levels`, `ols` + `cluster_robust_se` (CR1) + `cluster_bootstrap_ols`,
`logistic_irls`, `ipw_weights`, `normal_sf`. Validated by `tests/unit/cluster-perm-stats.selftest.py`
— **48 known-answer assertions**, paired so a one-sided pass is impossible, gated in CI by
`tests/unit/cluster-perm-stats.test.ts`, which also pins the module PURE (no store, no column, no I/O).
**Calibration, reproducible:** noise false-positive rate **10/200 = 0.0500** (B = 400, seed 20260904,
bound ≤ 16 — separates α = 0.05 from 0.10 at ~80% power). **Mutation-proven: 14 / 14 deliberate breaks turn the selftest RED** (simulated-mean centre, broken BH step-up, flipped Spearman sign, pooled cluster means, exclusive floor, rows-for-clusters floor, unsolved OLS, unclustered CR1, dropped small-sample factor, frozen IRLS, IPW ignoring selection, constant IPW weights, seed-blind split, non-resampling bootstrap). One measurement the proof forced into the open: the simulated-mean centre — W1's "caught defect" — is NOT visible to a calibration count at any B this file runs (11/200 = 0.055 vs 10/200 = 0.050 under one seed), so it is pinned by a hand-computed exact-centre assertion instead; W1's "6/40 = 0.15 → 7/120 = 0.058" was sampling noise around a correction that is right by derivation.

- `computeCellStats` is uncalled by construction — the module is Python and imports nothing from the TS
  codebase. `validityVerdict` is **STRUCK** (banned comparator; `ptDefined` false by construction on a
  single-side corpus). `wilsonInterval` / `excessZP` are **not test inputs**; the only pooled figure
  printed is the pooled rate beside each cluster mean, labelled `pooled` and never used for a test.
- Aggregation is per cluster, never pooled. The cell reference is the corpus DWR, never 0.5.
- Permutation `B = 10,000` for the family tests on the withheld SELL arms (D1 marginals, D2), **2,000**
  for secondary designs (D4, supplementary, D8-b). Bootstrap `B = 2,000` for coefficient CIs.

---

## 6. Split — cluster-wise, seed fixed here

Unit `(venue, coin)`. Seed = the literal wave id `EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1`; order by
`md5(seed|cluster)`, first 70% TRAIN. New seed ⇒ a different split from W1's, so **every marginal is
re-derived on this split**; W1's published ρ are quoted beside them, labelled W1.

---

## 7. Designs — in this order, each with its role

**D1 — joint linear-probability model on the decided SELL corpus (PRIMARY).**
`y = 1[label = +1]` on the **eight observed regressors + two structural covariates**:
`rsi, ema, funding, oi, volume` (bucket levels ÷ 100), `funding_delta, hurst_delta, squeeze_delta` (÷ 100),
`hurst_evaluated = 1[hurst_adjust_code ≠ 0]` (mandatory — `hurst_delta = 0` is a MISSING code on 73.2% of
rows, not a neutral one), and `timeframe` dummies (reference = the modal timeframe). Cluster `(venue, coin)`.
Inference: CR1 p (normal approximation, ≥ 700 clusters) — the test input; cluster-bootstrap 95% CI reported
beside it. **Train:** BH q = 0.05 over the four family partials. **Holdout:** same-signed, CR1 p < 0.05.
An **interaction model** adds the six pairwise family interactions; a main effect is *stable* iff its sign is
unchanged and its estimate lies inside the main model's bootstrap CI. **Beside each partial:** the marginal
LPM slope (`y` on that indicator alone) on the same rows, the marginal ρ from `perm_test` on the same
rows, and W1's published ρ.
Per-indicator reading: **OWN** (partial HIT on train + holdout, stable under interactions) ·
**BORROWED** (marginal HIT, partial's 95% CI excludes the marginal slope and includes 0) ·
**INDETERMINATE** (anything else, cause named). Reading follows the measured symmetry: a surviving partial
is the stronger inference, a vanishing one the weaker (collinearity inflates the focal SE).

**D8 — differential-resolution control (CO-EQUAL, architect Q1).**
(a) **Propensity:** `P(decided | X)` by logistic IRLS on all 17,113 labelled SELL rows, D1's regressors,
with `ema 0` and `volume 0` rows excluded by name (structurally unresolvable). Report min / max `p̂` and
the fitted coefficient per family member. (b) **IPW re-fit of D1** with stabilized weights `P(S)/p̂` on
decided rows; rows with `p̂ < 0.02` are reported and excluded (none expected — decided rates are
35–60%). A partial **survives resolution** iff same-signed with CR1 p < 0.05 on train under IPW and
same-signed on holdout. (c) **All-labelled outcome** sensitivity: `y' = 1[label = +1]` over all 17,113
rows (timeout = not a win), marginal `perm_test` + partial; a *different estimand*, tie-break role only.
(d) **The decided-rate gradient printed beside the DWR gradient** for every indicator and level, with the
Spearman between the two across powered levels — so a reader sees whether they move together.
**Residual limit, stated now:** IPW closes resolution only to the extent it depends on X. If (b) and (c)
disagree, or a family member's (a)-coefficient is large while (b) flips it, the verdict for that member is
`indeterminate — cause: resolution not closable from X`, which is a legitimate outcome.

**D2 — withheld-BUY mirror, VENUE-MATCHED (architect Q4a).** ASTER SELL decided rows vs ASTER BUY decided
rows. Per indicator, per arm: `perm_test` over powered levels (predicate, per arm), B = 10,000; ρ_corr and
ρ_dir reported; class read from §3. **Asymmetry, registered:** an underpowered mirror can *falsify* the
direction-class — a SAME-sign ρ_corr in the BUY arm at p < 0.05 — but **cannot establish it; a null from
this arm is INDETERMINATE and will not be reported as evidence of anything.** Fewer than two powered levels
⇒ Spearman undefined ⇒ INDETERMINATE by name. **No comparative "oi survived, the others did not" from
this arm, at any power.** Conditional follow-up: the BUY-side drain (`EDGE-BUY-ARM-DRAIN-W{NEXT}`) is
dispatched only if D1 and D8 together fail to settle the verdict.

**D4 — within-`raw_final`-band stratification (conservative floor).** `|raw_final| ≤ 20` (3,795 rows /
983 clusters) and `≤ 10` (2,140 / 820) strata of the SELL corpus: marginal `perm_test` (B = 2,000) per
indicator with the per-arm floor, and the D1 partial within `≤ 20`. Reported; no verdict role.

**Supplementary — within-emitted BUY-vs-SELL at fixed emission status (architect Q7).** Corpus (C),
deduped. Per indicator, per arm: `perm_test` (B = 2,000), floor per arm. `ema` is zero-variance on emitted
SELL and `oi` collapses there (+20: 8, +60: 1) — INDETERMINATE by name. Estimand: *does the correctness
association flip between emitted sides?* — corroborates D2's class reading only. **Never pooled with (A)/(B).**

---

## 8. Decision rule — three states, per indicator, then one line

For each family member *i*:
- **`attributable(i)`** ⇔ D1 partial HIT (train BH + holdout) **∧** stable under interactions **∧**
  survives D8(b) IPW **∧** D2 does not falsify the direction-class (no same-sign BUY ρ_corr at p < 0.05).
- **`not-attributable(i) — cause: collider`** ⇔ marginal HIT ∧ partial BORROWED.
- **`not-attributable(i) — cause: resolution`** ⇔ D1 partial HIT but fails D8(b), **or** D2 falsifies the
  direction-class at p < 0.05.
- **`indeterminate(i) — cause named`** ⇔ anything else (below floor; (b)/(c) disagreement; interaction
  instability; a residual not closable from X).

**Wave verdict, one line:** the four per-indicator states. `rsi`'s weakness (§3) travels with its state
whatever it is. A null is reported as plainly as a hit. **If and only if ≥ 1 member is `attributable`,**
§10 names what the ladder redesign may consume.

No hypothesis may be added after seeing data; one the corpus suggests is registered for a future wave.

---

## 9. Selection effects and limits — stated before results

1. Corpus window `2026-08-31 10:34Z → 2026-09-04 07:12Z`, post-`TREND_MODE`-flip by construction.
2. The side mix is MANUFACTURED (SELL-first drain); nothing generalises to the fleet. The BUY arm is one
   venue and two days: D2's venue-matching removes the venue confound and nothing else.
3. Fleet arm cell-sampled (`uq_hold_decisions_fleet_cell`); request arm not. 31 rows enter on
   `book_liveness` at `|raw_final|` above the SELL threshold — named, not modelled.
4. D1 is identified on the HOLD band's support (`raw_final ∈ [−75, −1]`) only; a partial is a
   support-local linear projection and does not generalise to emitted rows.
5. Unmodelled interactions are the live threat to a surviving partial (simulated 5× inflation with a pure
   `oi × ema` effect); the interaction model exists for that reason.
6. `hurst_delta` is near-perfectly venue-confounded (five venues 100% NOT_EVALUATED); its own coefficient
   is not a finding of this wave.
7. D8's residual: resolution may depend on path features X does not carry. Closable only by a design that
   observes the path — registered for a future wave if it binds.
8. Third-consumer terms hold; figures vault-only; no scoring, ladder, weight, threshold or
   `MAX_RAW_SCORE` change; this wave measures.

---

## 10. What `EDGE-SCORING-LADDER-REDESIGN-W2` may consume — only on `attributable`

It may consume: the **set** of attributable indicators, the **sign** of each partial, and the **ordering**
of their support-local magnitudes. It may **not** consume: any partial coefficient as a weight (a partial is
a conditional-mean slope on a truncated support, not a ladder weight), any level DWR, any figure from an
INDETERMINATE cell, or anything from D2/D4/supplementary as a magnitude. On any other verdict it consumes
nothing and stays blocked.

---

## 11. Deviations

A deviation from this file is recorded here as a deviation, with its reason, and is never silently
absorbed. None at recording.
