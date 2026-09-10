# EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2 — pre-registration of the refreshed withheld-DWR curve

**Write-time clock (live `date -u`):** `2026-09-10T07:49:45Z` (epoch `1789026585`).
**Owner:** `EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2` · **Procedure:** `audits/PREREGISTRATION-PROCEDURE.md`
· **Gate:** `tests/unit/preregistration-support-stress-test.test.ts`
· **Architect ratification:** Plan-Mode HALT answered 2026-09-10 — GO WITH SCOPE CHANGE (Q1=A, Q2=A,
Q2b/Q2c corrections, Q3 confirmed).

This file is **methodology only**. It carries no outcome figure. The cardinalities disclosed in §2
are cardinalities under PROCEDURE §1 and are reproduced here because concealing a prior look is the
thing that invalidates a registration. Every DWR, win rate, baseline and interval derived under this
registration lives in the private vault; the code repo is public.

---

## 0. What is INHERITED, and is not restated

The decision rule is **inherited verbatim and by reference** from
`audits/EDGE-SCORING-LADDER-W2A-PREREGISTRATION-2026-08-30.md` — its §2 branch table (branches A, B,
C and D), its binding shelf constraint, and its §3 riders. That document is `BINDING AND FIXED`,
sealed by Mr.1 at `2026-08-30T11:47:24Z`.

**This registration does not restate, reword, reorder or re-number any branch.** A reworded branch is
a respecified branch. Read the rule there; apply it to the curve produced here.

**What this wave refreshes is the INPUT to that rule, never the rule.** The predecessor's curve
(`EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1`, frozen bound `decided_at ≤ 1788132578`) was measured on a
pre-flip engine and is stale by construction, however clean its own methodology was.

**Not registered here, and not this wave's to decide:** `SELL_THRESHOLD_GATED`, the ladder,
`MAX_RAW_SCORE`, any weight or volume floor, and `TREND_MODE` (ratified and permanent).
**No branch outcome is predicted or expected anywhere in this file.** The shape decides.

---

## 1. Corpus — a literal predicate, closed by a clock

### 1.1 Withheld arm (R2)

```sql
FROM hold_decisions h
WHERE h.decided_at > 1788172475          -- capture-start, exclusive
  AND h.decided_at <= 1788764400         -- T_END, inclusive
  AND h.would_be_side = -1               -- SELL
  AND h.suppression_reason = 'below_threshold'
  AND h.timeframe <> '1m'                -- retired lane
  AND h.exchange IS NOT NULL
JOIN hold_decision_labels l
  ON l.hold_decision_id = h.decision_id
 AND l.barrier_spec IN ('tau0.5-floor0.30-v1','tau1.0-floor0.30-v1','tau2.0-floor0.30-v1')
```

Primary spec `tau1.0-floor0.30-v1`; the other two are the registered robustness arms (§5.5).

### 1.2 Emitted arm (R3)

Same window on `signals.created_at`, joined to `directional_labels` on the same three specs.

### 1.3 The bounds, and why each is what it is

| Bound | Value | Derivation (measured, not asserted) |
|---|---|---|
| start | `1788172475` = 2026-08-31T10:34:35Z | `min(decided_at) WHERE raw0 IS NOT NULL` — the scorer-input capture-start, and the bound the nightly labeler already runs with. Measured live 2026-09-10, **exact**. |
| `T_END` | `1788764400` = 2026-09-07T07:00:00Z | `floor_hour(write-time clock − 72 h)` = `floor_hour(1789026585 − 259200)`. 72 h because `EVAL_CANDLES['1d'] = 3` (`src/lib/pfe-mae.ts`) × 24 h. Satisfies the registered floor `T_END ≥ 1788764400`. |

**Rows beyond `T_END` belong to a successor and are said to.** The nightly labeler
(`41 3 * * *`, no upper bound) keeps labelling past it; those labels are excluded by predicate, not
by anything the instrument happened to reach.

### 1.4 The corpus is post-flip, and the margin does not depend on locating the flip exactly

`TREND_MODE` flipping ON splits `signals.verdict_rule_version` 1 → 2. Measured 2026-09-10 on live
`signals`, the transition is a **band, not a point**:

| quantity | epoch | UTC |
|---|---:|---|
| first `verdict_rule_version = 2` row | 1788169374 | 2026-08-31T09:42:54Z |
| last `verdict_rule_version = 1` row | 1788169576 | 2026-08-31T09:46:16Z |

The 202-second overlap is rows in flight across a per-process env read. **The registered start
(1788172475) is later than the band's upper bound by 2,899 s = 48.3 minutes, so the corpus is
post-flip regardless of where inside the band the flip landed.** Zero `verdict_rule_version = 1`
rows exist after the start: the corpus is 100 % rule-version 2.

The transition band is the durable artifact. The `/opt/crypto-quant-signal-mcp/.env` mtime is
**discarded as evidence** — that file was rewritten 2026-09-08T11:54:32Z and no longer dates the flip.

### 1.5 Coverage travels with two denominators

Every band reports (a) the registered population and (b) the subset the labelling pipeline reached,
with drops named — `unclosed`, `no_klines`, budget-deferred, residual. Drops are **reported, never
filled**.

---

## 2. Prior-examination disclosure

Every figure the author had seen before this file landed, with its class. All of it was probed during
Plan Mode on 2026-09-10 between 07:17Z and 07:50Z, before this registration and before any outcome
statistic was read.

| # | Figure seen | Class | Note |
|---|---|---|---|
| 1 | Per-band population / population clusters / labelled / labelled clusters, §1.1 predicate | `cardinality` | atom62 3,561/1,360/221/157 · 45–51 22,489/4,709/1,939/911 · 52–61 14,752/3,847/1,176/660 · below-45 437,355/7,217/39,835/6,073 |
| 2 | Per-band **decided counts, decided rates and decided clusters** | `coverage ratio` | atom62 112 / 50.68 % / 91 · 45–51 770 / 39.71 % / 510 · 52–61 510 / 43.37 % / 357 · below-45 18,439 / 46.29 % / 4,005. A decided-vs-timeout partition is the PROCEDURE §1 boundary class: probed because the drain decision and the floor comparison need it, and disclosed rather than concealed. |
| 3 | Decided rows per decided cluster (m̄) | `cardinality` | 1.231 / 1.510 / 1.429 / 4.604 |
| 4 | Drain work-list band mix (`rn ≤ 3`, unlabelled, parts, SELL, since capture-start) | `cardinality` | atom62 1,130 (1.0 %) · 45–51 5,731 · 52–61 3,823 · below-45 105,226 (90.3 %) |
| 5 | Per-venue `--check` backlogs, unfiltered and band-filtered | `cardinality` | unfiltered 107,637 decisions across 13 venues; band-filtered atom62 3,862 · 52–61 14,949 · 45–51 22,136 |
| 6 | Band-filtered reachable rows / clusters in-window | `cardinality` | atom62 2,046/1,158 · 52–61 10,262/3,597 · 45–51 15,556/4,478 |
| 7 | R3 emitted counts | `coverage ratio` | SELL 8,975 emitted / 6,948 labelled / **3,462 decided** / 1,054 decided clusters; BUY 75,440 / 59,620 / 43,245 / 3,110; `q(SELL) = 10.63 %` |
| 8 | Emitted SELL share by timeframe, both eras | `cardinality` | post-flip 1h 18.31 % · 2h 19.62 % · 4h 25.72 %; pre-flip 1h 0.190 % · 2h 0.419 % · 4h 5.373 % |
| 9 | The predecessor's published curve | `inherited` | `audits/EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1-2026-08-30.md` §7. **SEEN, DISCLOSED, NOT A TEST INPUT** — its only use here is §4.1's derivation of the 0.03 half-width target from its inter-band spread. The verdict rests on the post-flip corpus, which nobody has read. |
| 10 | Predecessor drain forensics | `inherited` | MEXC 10.6 cells/min, `no_klines = 514` (`12h/GATE` 384). Used to size budgets, not to test anything. |

**No DWR, win rate, label sign, baseline, interval or edge on this corpus has been computed or seen.**

---

## 3. Bands — the predecessor's cuts, unchanged

| Band | Cut on `hold_decisions.confidence` | Status |
|---|---|---|
| `atom62` | `= 62` — the withheld-confidence atom | W1's cut. Measured live: 62 is the maximum withheld SELL confidence; no row exceeds it. |
| `b52_61` | `52 ≤ c ≤ 61` | W1's cut |
| `b45_51` | `45 ≤ c ≤ 51` | W1's cut |
| `below45` | `c ≤ 44` | W1's cut. **Context band**, per W1. |

**No band is new.** Any future cut differing from these is a new band and must be named as one.

---

## 4. Floors and power — before the pull, in the independence unit

### 4.1 The target half-width, and where 0.03 comes from

A Wilson interval at `p̂ = 0.5` with `z = 1.96` has half-width `hw = z / (2·√(n + z²))`.

`hw ≤ 0.03  ⟹  n + z² ≥ (z/0.06)²  ⟹  n ≥ 1067.111 − 3.8416  ⟹  **n_eff ≥ 1064**`.

**0.03 is not arbitrary and is not re-tuned here.** It is anchored to the predecessor's measured
**inter-band spread of 0.047** (its three withheld bands sat at 0.4803 / 0.4670 / 0.5139): a floor
that cannot discriminate a ~0.05 separation cannot answer the question the sealed rule asks of the
curve's shape. Two ±0.03 intervals is the loosest bar that still separates that spread.

### 4.2 The independence unit is the cluster, so `ρ = 1`

The cluster is `(exchange, coin)`. CLAUDE.md's population-comparison law and this wave's own reading
procedure both require aggregation **per cluster, never pooled** — the cluster IS the independence
unit. That is `DEFF = m̄`, i.e. `ρ = 1`, and therefore `n_eff = G`:

> **`G_floor = 1,064 decided clusters`, per band.**

**A smaller `ρ` was considered and is REFUSED.** `ρ` is a nuisance parameter that cannot be estimated
without reading outcomes, so it would have to be registered; and the only effect of registering
`ρ = 0.10` would be to move three floors below their bands' reach. Choosing an analysis parameter
because it clears is the forking path PROCEDURE §7 forbids — one would not have proposed it had
`ρ = 1` cleared. Refused on that ground, independent of which is statistically nicer.

### 4.3 Application — by name, never by omission

A band whose decided-cluster count is below `G_floor` is reported **`INDETERMINATE` by name**. It is
never dropped, never pooled into a neighbour, and its point estimate is never promoted to a finding.

### 4.4 The `atom62` band cannot reach the floor at any budget — registered NOW, not discovered

Stated **before** the drain, from cardinalities alone:

| quantity | measured | source |
|---|---:|---|
| atom62 population clusters in-window | 1,360 | §2 row 1 |
| atom62 clusters reachable by the authorised drain (`rn ≤ 3`, in-window) | **1,158** | §2 row 6 |
| already-labelled decided clusters | 91 | §2 row 2 |
| decided rows per cluster in this band | 1.231 | §2 row 3 |

A cluster becomes a *decided* cluster only if at least one of its labelled rows resolves. At the
band's own 50.68 % decided rate and 1.23 rows per cluster, `P(≥1 decided) ≈ 1 − 0.4932^1.23 ≈ 0.58`,
so the attainable ceiling is **≈ 0.58 × (1,158 + 91) ≈ 725 decided clusters** — and the hard ceiling,
even at a 100 % decided rate on every population cluster, is 1,360.

**≈725 against a floor of 1,064 ⇒ `atom62` is registered here as `INDETERMINATE` — structurally, in
advance, and not as a result.** This is the same shape as the identifiability refusal in §5.2: a
floor wider than a band's attainable range makes that band inert, and no budget repairs it.

**The band is still drained**, for three reasons that are not power: it is the cheapest band (3,862
decisions), it feeds the corpus the successor waves inherit, and its point estimate is qualitatively
informative even when its interval is not admissible. **Its budget is sized to complete reach and
then stop** — never to chase a floor it cannot reach.

### 4.5 The branch under-power is registered as a state, not as an expectation

If the **readable** bands cannot discriminate, the sealed §2 rule's underpowered branch fires
honestly. That is a state this registration provides for; it is **not** predicted, and the absence of
one band of four is not by itself a reason for it. The branch is read from what is readable.

---

## 5. The reading procedure — stated before any number

### 5.1 Primary reading: a LEVEL test against 0.5

For each band and barrier spec: aggregate **per `(exchange, coin)` cluster**, then test the band's
directional win rate against `0.5` with a Wilson interval on the cluster count. The question is
*is this band's CI-lower above coin-flip?* **It is not a cross-population delta and must never be
reported as one.**

### 5.2 The `max(naive)` leg is `NOT_IDENTIFIABLE`, by name

Every withheld band is ~100 % SELL. On a single-side band, `edge = DWR − max(naive)` is degenerate:
the same-rows always-SELL baseline **is** the quantity under test, so the `max()` always contains it
and the edge can never exceed zero. The mix-matched null `q·p_long + (1−q)·p_short` does not rescue
it either — at `q ≈ 0` it collapses to always-SELL and is degenerate for the same reason.

**Therefore the leg is reported `NOT_IDENTIFIABLE`.** Not zero, not "degenerate ≈ 0", not a footnote
attached to a number. No comparator repair fixes a one-sided band; only the refusal is honest.

**Enforced, not intended.** The shipped instrument `computeCellStats` (`src/scripts/dwr-baseline.ts`)
always returns `benchmark = max(alwaysBuyDwr, alwaysSellDwr)` and `edge = dwr − benchmark` as numeric
fields. The driver **projects both keys out** of every emitted artifact and substitutes
`"max_naive_leg": "NOT_IDENTIFIABLE"`, and an assertion over every emitted artifact checks that
`benchmark` and `edge` are **absent** and that `max_naive_leg` carries that exact token. That
assertion is proven able to fail by deliberately re-adding one key.

### 5.3 always-BUY is a MARGINAL

The same-rows always-BUY rate is the informative opposite-side comparator and is reported as a
**marginal**. It is never subtracted into an "edge".

### 5.4 Pooled figures are context

Pooled (row-weighted) figures may be printed for context and are used **for no test**. The day-vs-row
pooling hazard applies here in the `(venue, coin)` substrate: pooling weights the busiest cluster.

### 5.5 Robustness

Every reading is repeated across `tau0.5-floor0.30-v1`, `tau1.0-floor0.30-v1` and
`tau2.0-floor0.30-v1`, as the predecessor reported. `tau1.0` is primary.

### 5.6 R3 — the emitted arm

Reported on the same frozen window: emitted SELL rows, DWR-decided count, decided rate, clusters, and
whether the sealed prereg's **400 DWR-decided SELL rows** threshold is met. The emitted-SELL arm is
one-sided, so §5.2's refusal applies to it **verbatim**. The mix-matched null
`q·p_long + (1−q)·p_short` is computed **only** on the full emitted corpus (BUY + SELL), where `q` is
non-degenerate, and is reported as a separate, clearly-labelled arm.

**Benchmark-before-publish is binding:** no SELL win rate leaves the vault without its naive baselines
on the same rows. Everything in this wave is vault-only regardless.

---

## 6. Seeded RNG — one seed per arm, arm-independent

Any cluster bootstrap or permutation draw uses a **per-arm** stream so a re-run is byte-identical and
no arm's draw can shift because another arm's row count changed. The predecessor arc measured
bootstrap endpoints drifting ~0.002 across re-runs from a single sequential stream; that ambiguity is
not acceptable in a gate input.

`seed(arm) = uint32( first 8 hex of sha256("EDGE-WITHHELD-COUNTERFACTUAL-DWR-W2:" + arm) )`

| arm | hex | seed |
|---|---|---:|
| `atom62` | `83c37ff4` | 2210627572 |
| `b52_61` | `efa1ab83` | 4020349827 |
| `b45_51` | `21025216` | 553800214 |
| `below45` | `c65bedd4` | 3327913428 |
| `emitted_sell` | `4151c78c` | 1095878540 |
| `emitted_full` | `a11c4031` | 2702983217 |

---

## 7. Decision rule — three states per band, then the sealed rule

Per band: `readable` / `INDETERMINATE — below the registered cluster floor` /
`NOT_IDENTIFIABLE — one-sided comparator`. Then the curve's shape is read from the **readable** bands
and exactly one branch of the sealed §2 table is named, by reference, with the shelf value it
implies under that document's own binding shelf constraint.

**This wave names the branch and stops.** It changes no threshold. If the sealed branches conflict on
this curve, the conflict is reported as the finding; adjudicating between sealed branches would be
respecification and is forbidden.

---

## 8. Support stress-test

Every registered check, the point of the covariate space at which it is evaluated, and whether the
corpus occupies that point — probed live 2026-09-10, before any outcome was read.

| check | evaluation point | support / cardinality fact (probed live) | verdict |
|---|---|---|---|
| per-band presence floor | `G = 1,064` decided `(exchange, coin)` clusters, `hw ≤ 0.03` at `p = 0.5` | reachable decided clusters: `b45_51` 4,478 reachable × ~40 % ⇒ ≈1,791 · `b52_61` 3,597 × ~40 % ⇒ ≈1,439 · `below45` 4,005 already · `atom62` ceiling ≈725 | `inside` for `b45_51` / `b52_61` / `below45`; **`floor`** for `atom62` (§4.4, registered in advance) |
| clustered level test vs 0.5 | `p = 0.5`, the cluster-aggregated band rate | every band's decided rate lies in 39.7 %–50.7 %, so 0.5 is interior to the observed range and the test is defined at it | `inside` |
| always-BUY marginal on the same rows | the withheld bands, which are ~100 % SELL | `would_be_side = -1` by predicate ⇒ the always-BUY rate is defined (it is a property of the races, not of the side) while `max(naive)` is not | `inside` — and the `max(naive)` leg is `outside → replaced by NOT_IDENTIFIABLE` (§5.2) |
| mix-matched null `q·p_long+(1−q)·p_short` | the emitted side mix `q` | withheld arm `q ≈ 0` ⇒ degenerate, refused; full emitted corpus `q(SELL) = 10.63 %` (8,975 of 84,415) ⇒ non-degenerate | `outside → replaced by NOT_IDENTIFIABLE` on the withheld and emitted-SELL arms; `inside` on the full emitted corpus only |
| R3 400-DWR-decided-SELL gate | 400 decided rows on the frozen window | 3,462 decided SELL rows, 1,054 decided clusters | `inside` (met 8.66×) |
| barrier-spec robustness | `tau0.5` / `tau1.0` / `tau2.0` | all three specs are written by one labeler invocation (`would_label = decisions × 3`), so every labelled row carries all three | `inside` |
| timeframe presence | bands compared "on the same rows" | one band, one predicate, one row set per band — no cross-band timeframe restriction is applied, so no two populations are compared on differing timeframe sets | `inside` |

---

## 9. Deviations, quarantine, publication

A deviation from this registration is recorded **as a deviation with its reason**, never absorbed.

`hold_decision_labels` stays quarantined on the predecessor's terms: own hypotheses, **never cited
for or against the HOLD-discipline hypothesis** (`audits/hold-decision-preregistration-2026-08-26.md`
§12), nothing to public copy. Figures are vault-only; this file is the methodology and carries none.

**Spec imprecisions corrected in this registration rather than inherited:**

1. The dispatch's global term *"`--max-decisions` set above every leg's measured `--check` backlog"*
   is **unsatisfiable** at 107,637 unfiltered decisions in one deploy-free window. It binds **per
   band-targeted leg**, against that leg's band-filtered backlog.
2. The dispatch names `HOLD_DRAIN_PASS_VERDICT`. The **script** `ops/scripts/hold-decision-drain.sh`
   emits `HOLD_DRAIN_VERDICT`; `HOLD_DRAIN_PASS_VERDICT` is the predecessor audit's **pass-level
   roll-up** over legs. Both are named in the result, each beside the artifact it comes from.
3. The dispatch's pre-flip SELL shares (~0.08 % at 1h, 0.000 % at 2h) are superseded by the
   re-derivation in §2 row 8, measured on this wave's own windows. The premise is unaffected —
   1h moves 0.190 % → 18.31 %, ≈96×.
4. `hw ≤ 0.03` arrived without a derivation; §4.1 supplies one and retains the value.

---

## 10. Inheritors

`EDGE-SCORING-LADDER-W2a-W{NEXT}` (threshold-only; dispatchable only if a branch other than the
underpowered one fires) · `EDGE-SCORING-LADDER-W2b-W{NEXT}` (C3) ·
`EDGE-LABELER-BREADTH-ORDERING-W{NEXT}` (owns the work-list's outer-`ORDER BY` generator fix; **this
wave claims no generator-level fix for it**) · `OPS-LABELER-MEXC-THROUGHPUT-W{NEXT}` ·
`OPS-DRAIN-NOKLINES-VISIBILITY-W{NEXT}`.
