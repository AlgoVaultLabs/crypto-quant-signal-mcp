# SELL feature-attribution gate — PRE-REGISTRATION

**Wave:** `EDGE-ATTRIBUTION-CORPUS-DRAIN-W1` R0.0 · **Recorded:** `2026-09-04T06:32:57Z` (live `date -u`)
**Authority:** architect ratification 2026-09-04 (Q1b/Q1c of this wave's Plan-Mode HALT), on top of
the 2026-09-04 third-consumer ruling recorded in `ops/monitoring/scorer-input-identity-canary.py`.
**Binding on:** `EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT}`.

## 0. Why this file exists — the defect it closes

The gate this file records was cited as *"pre-registered"* across three waves. It was not. It lived
in a chat message and in a scheduled-task prompt at
`~/Documents/Claude/Scheduled/aoe-0917-attribution-gate-check/SKILL.md` — **outside the vault and
outside this repo, unreadable by the agent executing against it.** Plan-Mode probes on 2026-09-04
returned zero hits for it vault-wide, on `origin/main`, and across 400 commits of history.

That is *prose masquerading as a control*, the exact failure mode this estate's own standard names,
and it has a second edge: **a commitment stored only in a scheduler is a second ledger the executing
agent cannot plan against.** Half the constraints binding a wave lived where no wave could read
them. Both are closed by this artifact — the threshold and every checkpoint date are now in a
committed file, and a successor inherits an artifact rather than a sentence in a prompt.

This file is **methodology and cardinalities only**. No label value, no rate, no return, and no DWR
figure appears here or in anything derived from this gate on a public surface.

## 1. The gate — literal SQL, ratified value

```sql
SELECT count(DISTINCT h.decision_id) AS decided_hold_sell_canonical
  FROM hold_decision_labels l
  JOIN hold_decisions h ON h.decision_id = l.hold_decision_id
 WHERE l.barrier_spec = 'tau1.0-floor0.30-v1'
   AND l.label       <> 0            -- decided: the barrier race resolved, not a timeout
   AND h.would_be_side = -1          -- SELL side
   AND h.raw0      IS NOT NULL;      -- captured parts present (migration 036)
```

**`raw0` and not `raw_final`, and the choice is not arbitrary.** All 13 parts columns are written
in one atomic insert, so any of them answers "is this row captured" — measured 2026-09-04, zero
NULLs across 39 of 39 (arm × column) cells. That makes the choice free, and *therefore* it must be
made once: `scorer-input-identity-canary.py` already keys its captured predicate on `raw0`, so the
counter that scores the gate and the `--require-parts` filter that selects the rows now name the
same column. Two columns would have been two derivations of one question, agreeing today and
drifting later in whichever copy nobody is watching.

| | |
|---|---|
| **Gate** | **≥ 5,000** |
| Live value at recording | **420** (`2026-09-04T06:33:13Z`, run against prod `signal_performance`) |
| Counting unit | **DISTINCT parent `decision_id`** — a parent carries up to three `barrier_spec` labels, so a row count of the label table triple-counts it |
| Instrument | the SQL above, verbatim; published per-run by `ops/monitoring/scorer-input-identity-canary.py` as `decided_hold_sell_canonical`, uncapped and unwindowed |

The gate is a **row count, never a date.** A date is a checkpoint for *reading* the count (§4); it is
never a substitute for it, and the count is never rounded up to meet one.

## 2. Honest scope of 5,000 — it supports ONE read, not two

5,000 was chosen for a **pooled per-indicator** analysis. It does **not** license the regime cut, and
this file states both so that one number cannot silently imply the other.

| Read | cells | rows/cell at n=5,000 | Wilson half-width at p≈0.5 | verdict |
|---|---:|---:|---:|---|
| **pooled per-indicator** | ~30 | ~167 | ≈ ±7.6pp | **SUPPORTED** |
| **per-indicator × regime** | ~90 | ~56 | **≈ ±13pp** | **UNDERPOWERED** |

Arithmetic, so it is checkable rather than asserted: 5000/30 = 166.7; 5000/90 = 55.6;
`1.96 · √(0.25/55.6) = 0.132`.

**Binding on the successor:** the regime cut is reported **marked UNDERPOWERED**, with its own row
count declared separately and its own powered floor derived and stated before it is read. It may not
borrow the pooled read's authority. BH-FDR is applied across the feature × regime family as the
spec already requires — and FDR control does not repair a width problem, so it is not a substitute
for this declaration.

## 3. Population, and the selection effects that must travel with every figure

Population: `hold_decisions` rows with captured parts (`raw0 IS NOT NULL`, i.e. written on or
after `2026-08-31T10:34:35.985Z`, the first parts-bearing row), `would_be_side = -1`, labelled under
`tau1.0-floor0.30-v1`.

1. **The corpus side-mix is DELIBERATELY ENRICHED and is not natural.** `EDGE-ATTRIBUTION-CORPUS-DRAIN-W1`
   R2 drains SELL-first by design. Measured at recording: SELL is **58.75%** of the structurally
   labelable post-capture population (271,882 of 462,816) but **66.2%** of rows actually labelled
   post-capture (1,193 of 1,803), and the drain widens that gap on purpose.
   **Therefore any cross-arm or cross-population rate claim built on this corpus MUST use the
   mix-matched null on the same rows — `q·p_long + (1−q)·p_short`, with `q` the emitted side mix —
   aggregated PER CLUSTER (the day/`(venue,coin)` is the independence unit, never the row), and MUST
   pass an identifiability check first.** A fixed-side or `max(alwaysBUY, alwaysSELL)` comparator is
   forbidden here: it is a marginal, it relocates the coupling, and `max()` is additionally
   selection-coupled. Enforced by `ops/monitoring/population-comparison.schema.json` +
   `scripts/check-population-comparison.mjs`, which refuse (`NOT_IDENTIFIABLE`) rather than repair.
2. Withheld rows are precisely the sub-threshold ones — not a random sample of the tape.
3. The fleet arm is cell-sampled at capture (`uq_hold_decisions_fleet_cell`, first-write-wins per
   UTC-day cell); the request arm is 100%-sampled but covers ~28 assets.
4. `verdict_rule_version = 2` on 100% of the captured emitted corpus — the corpus sits entirely on
   one side of the 2026-08-31 `TREND_MODE` flip. Homogeneous for attribution, and **not comparable
   against pre-flip history.**

## 4. Checkpoints — recorded HERE because a scheduler prompt is not a ledger

| date (UTC) | what | owner |
|---|---|---|
| **2026-09-09** | drain readiness check — is the gate on track, and does the nightly's reserved pre-capture slice still earn its keep (see §5)? | `EDGE-ATTRIBUTION-CORPUS-DRAIN-W1` follow-up |
| **2026-09-17T12:00:00Z** | attribution-gate check — scheduled task `aoe-0917-attribution-gate-check`. **Read the count from `Claude files/canary-results.jsonl`; do not dispatch a wave to measure it.** | scheduled task |
| **~2026-10-07** | earliest possible HOLD-discipline answer | `hold-decision-preregistration-2026-08-26.md` §9 |

**Rule established with this file:** any future commitment that constrains a wave is recorded in a
committed artifact, not only in a task prompt.

## 5. Interaction with the HOLD-discipline pre-registration — measured, not assumed

`EDGE-ATTRIBUTION-CORPUS-DRAIN-W1` redirects most of the nightly labeler's budget to post-capture
rows. `hold-decision-preregistration-2026-08-26.md` is powered by **n ≥ 50 independent `(venue, coin)`
clusters in the headline confidence stratum 50–62** — a CLUSTER floor, and its own §8 records that
"more weeks add rows, not clusters".

Measured `2026-09-04T06:14Z`, stratum `confidence BETWEEN 50 AND 62`, `tau1.0-floor0.30-v1`:

| era | clusters already labelled | clusters still available unlabelled | rows still available |
|---|---:|---:|---:|
| pre-capture | **3,352** (67× the floor) | 2,071 | 5,657 |
| post-capture | **56** (also above the floor) | **4,202** | **16,979** |

**The redirection cannot starve that test.** Its floor is met 67× over by labels that already exist
and cannot be un-labelled, and going forward the post-capture pool is the *richer* source for its own
headline stratum. A minority slice of the nightly is nevertheless reserved for the pre-capture corpus
per the architect's binding condition — its one genuine value is more rows per already-covered
cluster, which tightens a cluster-bootstrapped interval — and the 2026-09-09 readiness check rules on
whether to keep it.

## 6. Coverage — two denominators, drops reported and never filled

Denominator A (raw): all captured rows at the stated bound.
Denominator B (labelable): A minus structural drops — `would_be_side = 0`, `exchange IS NULL`,
`timeframe = '1m'` (retired lane, `OPS-1M-SEED-DECOM-W1`), and rows whose evaluation window has not
closed.

Measured at recording, over the post-capture population (464,363 rows): `would_be_side = 0` **1,547**;
`exchange IS NULL` **0**; `timeframe = '1m'` **0**; labelable **462,816**. Unclosed windows are
counted per run as `unclosed_skipped` and are transient by construction.

## 7. Quarantine — restated, binding

`hold_decision_labels` is the counterfactual store. `EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT}` is its
**third** ratified consumer (architect, 2026-09-04) under the same three protections as the second:

1. It pre-registers its own hypotheses before reading.
2. Its output may **never** be cited for or against the HOLD-discipline hypothesis.
3. Nothing derived from it reaches public copy, an MCP response, a track-record surface, or any
   customer-facing artifact.

What crosses the boundary into this file and into `canary-results.jsonl` is a **cardinality** — never
a label value, never a rate, never a return.

## 8. Deviations

A deviation from this file is recorded here as a deviation, with its reason, and is never silently
absorbed. None at recording.
