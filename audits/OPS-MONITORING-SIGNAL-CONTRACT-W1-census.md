# OPS-MONITORING-SIGNAL-CONTRACT-W1 CH1 — monitoring detector census

**Read-only.** Scored by `scripts/monitoring-census.mjs`; base `origin/main` @ `86192f6`. Counts
refreshed after the §6 correction and after CH2 added two inventory rows of its own.
Reproduce with `node scripts/monitoring-census.mjs` (table) or `--cite` (one line per failure).

```
MONITORING_CENSUS_VERDICT=PASS          ← corrected; see §6
CENSUS_SIZING=CLASS_ESTABLISHED         ← 39/39 detectors fail ≥1 property; threshold is 3
```

> ⚠️ **CORRECTION, 2026-08-22, applied during CH2.** The first committed run of this census
> reported `MONITORING_CENSUS_VERDICT=FAIL` on the claim that two inventory rows named artifacts
> absent from the tree. **That claim was FALSE and the rows were right.** Both carry
> `install_state: "retired"`, `retired_at`, and `retired_by: OPS-RECALIBRATE-HARNESS-RETIRE-W1`,
> and both scripts were deleted by `799eedb` in that same wave — so absence is precisely the state
> a retired row should be in. The census was treating a correct retirement as a defect. See §6.

> The two tokens are separate on purpose. "The class is real" is not a health verdict about this
> repo, and overloading one token with two meanings is the defect this wave exists to retire.

---

## 1. Enumeration (AC1.1) — three sources, unioned, never sampled

| Source | Population | Kept | Why the rest were dropped |
|---|---|---|---|
| **S1** `ops/monitoring/**` + `ops/cron/**` | 47 code files | 33 | 14 never reach an operator (§2) |
| **S2** `monitoring-inventory.json` | 71 rows | 5 additional | 12 inert data declarations · 5 `external:` rows owned by another repo · 2 **retired** (§6) |
| **S3** `src/scripts/*` marker producers | 1 | 1 | `backfill-directional-labels.ts` — its `[capacity-shortfall]` marker is read by `directional-label-freshness.py` |
| **Cross-reference** `alert-registry.json` | 60 rows | — | joined for `alert_id` ownership (46 at CH1 time; CH2 closed the 14-id source gap) |

**Total scored: 39 detectors — 27 `load-bearing`, 12 `advisory`.**

### "Detector" is derived from behaviour, not from a hand-list

The ratified definition is *an artifact that emits an operator-visible signal a human acts on.*
The census implements it as a **union of two behaviours**, both required:

1. it invokes the alert transport (`send_telegram` / `$WRAPPER` / `sendDigest` / `CRITICAL_PERSISTENT`), **comments stripped first** — a transport named in prose is documentation, not a call; **or**
2. its operator signal **is** a documented multi-state exit contract (`EXIT_SILENT=0 … EXIT_FRAMEWORK_ERROR=3`), which a cron wrapper pages on.

Clause 2 was added after clause 1 alone **dropped `postgres-cpu-autopilot.py`** — the estate's
canonical exit-code detector and the spec's own worked example. A signal that misses the one
artifact a rule was written around is the rule measuring itself. *(H5 applies to the instrument:
this census's first two runs produced a materially different population, and both were wrong.)*

Only four artifacts need a hand-written exemption, each carrying its reason **as data** in
`NOT_A_DETECTOR` and printed on every run: `send_telegram.sh` (the transport itself) and the three
`test-*` harnesses, which need explicit rows precisely because they *do* invoke the transport in
test mode.

---

## 2. Not scored, and why (never silent)

**14 artifacts reach no operator** — `carry-tracker-publish.sh`, `check-docs-samples-live.mjs`,
`check-stripe-webhook-events.mjs`, `host-deploy.sh`, `injector-target-set.mjs`,
`install-monitoring-artifact.sh`, `seed-promoted-ramp.sh`, `served-region-check.mjs`,
`snapshot-landing-daily.sh`, `doc-host-path-claims`-class helpers, plus the 4 hand-exempted.
These are deploy tools, installers, libraries and snapshot producers — their *callers* page.

**12 inert data declarations** (`monitoring-inventory.json`, `alert-registry.json`,
`venue-slo-tiers.json`, `network-posture.json`, the `*.yaml` manifests …) — declarations page
nobody. **5 `external:` rows** are owned by the `algovault-bot` and `autonomous-optimizer` repos
and are absent from this tree by design.

---

## 3. The known-good reference

`ops/monitoring/decision-gate-orphan-canary.py` is the only detector in the estate that was
written to the contract before it existed. What it does that the others do not:

| Line | Behaviour |
|---|---|
| `:61-62` | `DECISION_GATE_ORPHAN_VERDICT=PASS\|FAIL\|INDETERMINATE`, exit `0/0/3` — the token is the verdict, the code is not |
| `:68-71` | unreadable inventory · unreadable `status.md` · an **unrecognised** `retirement_trigger.kind` all resolve to `INDETERMINATE`, never a skip |
| `:77` | zero declared rows ⇒ the declaration is missing ⇒ `INDETERMINATE` — a vacuity guard where the corpus is CONSTRUCTED |
| `:446` | its own self-test asserts the vacuity branch |

It still fails `run_identity` and `evidence`, which is the point: even the best detector in the
estate carries only half the contract.

---

## 4. Scores (AC1.2, AC1.3) — `<file>:<line>` on every failure

`PASS` · `FAIL` · `n-a` (no producer run to summarise). `form` records *how* `verdict` is
satisfied — `token` is the strong form, `exit-code-only` the weaker one that is lossy through
`|| true`, cron wrappers and pipelines.

| Detector | criticality | verdict | form | run_outcome | run_id | evidence |
|---|---|---|---|---|---|---|
| `ops/cron/analytics-drift-canary.sh` | advisory | PASS | token | PASS | **FAIL** | **FAIL** `:49` |
| `src/scripts/backfill-directional-labels.ts` | *(no row)* | **FAIL** | missing | PASS | **FAIL** | PASS |
| `ops/monitoring/book-liveness-canary.py` | advisory | **FAIL** | missing | **FAIL** `:77` | **FAIL** | **FAIL** `:75` |
| `ops/cron/bot-deploy-parity.sh` | load-bearing | PASS | token | n-a | **FAIL** | **FAIL** `:119` |
| `ops/cron/checkout-parity.sh` | load-bearing | PASS | token | n-a | **FAIL** | **FAIL** `:93` |
| `ops/monitoring/closedbar-w1-liveness.sh` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:379` |
| `scripts/db-superuser-canary.sh` | load-bearing | PASS | exit-code-only | **FAIL** `:37` | **FAIL** | **FAIL** `:94` |
| `ops/monitoring/decision-gate-orphan-canary.py` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:124` |
| `ops/monitoring/declaration-sync.sh` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:276` |
| `ops/monitoring/deploy-drift-canary.mjs` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:212` |
| `ops/monitoring/directional-label-freshness.py` | load-bearing | **FAIL** | missing | PASS | **FAIL** | **FAIL** `:169` |
| `ops/cron/docs-drift-canary.sh` | advisory | **FAIL** | missing | **FAIL** `:38` | **FAIL** | PASS |
| `ops/monitoring/equity-launch-readiness.sh` | advisory | **FAIL** | missing | **FAIL** `:25` | **FAIL** | PASS |
| `ops/monitoring/equity-verdict-watch.sh` | advisory | **FAIL** | missing | **FAIL** `:16` | **FAIL** | PASS |
| `ops/monitoring/funnel-leak-detector.py` | load-bearing | **FAIL** | missing | PASS | **FAIL** | **FAIL** `:127` |
| `ops/monitoring/kernel-staleness-canary.sh` | load-bearing | PASS | token | **FAIL** `:28` | **FAIL** | **FAIL** `:45` |
| `ops/monitoring/llm-spend-monitor.py` | load-bearing | **FAIL** | missing | PASS | **FAIL** | PASS |
| `ops/cron/lockfile-resolvability-canary.sh` | load-bearing | PASS | token | **FAIL** `:37` | **FAIL** | **FAIL** `:51` |
| `ops/monitoring/monitoring-inventory-reconcile.py` | load-bearing | **FAIL** | missing | PASS | **FAIL** | **FAIL** `:450` |
| `ops/cron/nav-drift-canary.sh` | advisory | PASS | token | PASS | **FAIL** | **FAIL** `:56` |
| `ops/monitoring/outcome-backfill-freshness.py` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:36` |
| `ops/monitoring/payment-decline-canary.py` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:110` |
| `ops/monitoring/postgres-cpu-autopilot.py` | load-bearing | PASS | **exit-code-only** | PASS | **FAIL** | **FAIL** `:330` |
| `ops/monitoring/postgres-cpu-snapshot.sh` | load-bearing | **FAIL** | missing | **FAIL** `:24` | **FAIL** | PASS |
| `ops/monitoring/quota-exhaustion-canary.py` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:126` |
| `ops/monitoring/recommendation-drift-canary.py` | load-bearing | **FAIL** | missing | PASS | **FAIL** | **FAIL** `:60` |
| `ops/monitoring/registry-conformance-canary.py` | load-bearing | **FAIL** | missing | PASS | **FAIL** | **FAIL** `:7` |
| `ops/monitoring/revenue-meter-canary.py` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:279` |
| `ops/cron/seed-coverage-canary.sh` | load-bearing | **FAIL** | missing | **FAIL** `:27` | **FAIL** | **FAIL** `:57` |
| `ops/monitoring/seed-orchestrator-gate-48h.sh` | advisory | **FAIL** | missing | **FAIL** `:140` | **FAIL** | **FAIL** `:49` |
| `ops/monitoring/shadow-cpu-gate-48h.sh` | advisory | **FAIL** | missing | n-a | **FAIL** | PASS |
| `ops/monitoring/stripe-webhook-events-canary.sh` | load-bearing | **FAIL** | missing | **FAIL** `:15` | **FAIL** | PASS |
| `ops/monitoring/tier-misclassification-canary.sh` | advisory | **FAIL** | missing | **FAIL** `:29` | **FAIL** | **FAIL** `:73` |
| `ops/monitoring/venue-slo-tiers-drift-canary.sh` | advisory | **FAIL** | missing | **FAIL** `:25` | **FAIL** | **FAIL** `:30` |
| `ops/monitoring/webhook-delivery-canary.py` | load-bearing | **FAIL** | missing | PASS | **FAIL** | **FAIL** `:141` |
| `ops/monitoring/website-drift-canary.py` | load-bearing | **FAIL** | missing | **FAIL** `:323` | **FAIL** | **FAIL** `:130` |
| `ops/monitoring/x402-bazaar-canary.py` | advisory | **FAIL** | missing | **FAIL** `:108` | **FAIL** | **FAIL** `:98` |
| `ops/monitoring/x402-claim-liveness-prober.py` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:83` |
| `ops/cron/xrepo-ci-conclusion-canary.sh` | load-bearing | PASS | token | PASS | **FAIL** | **FAIL** `:177` |

**Per-property totals over 39 detectors**

| Property | PASS | FAIL | n-a | Note |
|---|---|---|---|---|
| `verdict` | 17 | **21** | 0 | 15 `token`, **2 `exit-code-only`** (`postgres-cpu-autopilot.py`, `db-superuser-canary.sh`) |
| `run_outcome` | 20 | **15** | 3 | the `n-a` branch is reachable — 3 detectors summarise no producer run |
| `run_id` + `produced_at` | 0 | **39** | 0 | ⚠️ see below |
| `evidence` | 9 | **30** | 0 | 30 detectors carry hardcoded mechanism prose in the emitted body |

> ⚠️ **`run_id` fails on 39 of 39, and that number must not be read as a discovery.** This is the
> property the wave INTRODUCES; nothing in the estate could satisfy it, because the concept does
> not exist yet. A property that fails universally **does not discriminate**, so it carries none
> of the sizing decision. Strike it entirely and the class is still established: **34 detectors
> still fail `verdict`, `run_outcome` or `evidence`** — 24 of them `load-bearing`.

---

## 5. Blast radius (AC1.4) — one concrete false conclusion per failing detector

Each line is what this detector could publish that it did not measure.

**Missing `verdict` — a fail-open run is indistinguishable from a clean one**

| Detector | Concrete false conclusion |
|---|---|
| `backfill-directional-labels.ts` | the measured incident: a run SIGTERM'd at 22% of budget publishes `est_venue_min_short=26` as a capacity ceiling |
| `directional-label-freshness.py` | forwards that marker as a page and exits 0; a reader cannot tell it from a clean night |
| `book-liveness-canary.py` | an unreachable order-book endpoint yields "no staleness detected" rather than "not measured" |
| `docs-drift-canary.sh` | a failed docs fetch reads as "docs match" — drift ships unannounced |
| `equity-launch-readiness.sh` | an unreadable readiness input reports "not ready" and "could not check" identically |
| `equity-verdict-watch.sh` | a dead watch loop is indistinguishable from a watch that saw no verdict change |
| `funnel-leak-detector.py` | a DB timeout yields "no leak" — the funnel looks healthy because nothing was counted |
| `llm-spend-monitor.py` | an API error yields zero spend, and a runaway bill goes unreported as $0 |
| `monitoring-inventory-reconcile.py` | its own measured first-run defect: `INVENTORY_LOAD_FAILED … exit 0`, having reconciled nothing |
| `postgres-cpu-snapshot.sh` | a failed sample writes an absent/zero CPU row that the autopilot then averages as real |
| `recommendation-drift-canary.py` | an unreachable recommendation surface reads as "no drift" |
| `registry-conformance-canary.py` | a registry fetch 429 reads as "conformant", certifying a listing nobody saw |
| `seed-coverage-canary.sh` | an empty query result reads as "coverage complete" rather than "coverage unknown" |
| `seed-orchestrator-gate-48h.sh` | the 48h gate reports GREEN on a window in which it never sampled |
| `shadow-cpu-gate-48h.sh` | same, for the shadow-CPU window — a silent no-sample reads as within-budget |
| `stripe-webhook-events-canary.sh` | a Stripe API failure reads as "all events enabled"; a silently-dropped event type stays dropped |
| `tier-misclassification-canary.sh` | a failed tier join reports zero misclassifications, hiding a revenue-affecting mislabel |
| `venue-slo-tiers-drift-canary.sh` | an unreadable SoT mirror reads as "no drift", so the scheduler and the monitor can silently diverge on the tier set — the H1 incident's own precondition |
| `webhook-delivery-canary.py` | an unreadable delivery table reads as "no permanently-disabled subscription" |
| `website-drift-canary.py` | a fetch failure across the manifest reads as "every metric matches" on a page nobody loaded |
| `x402-bazaar-canary.py` | a Bazaar listing probe failure reads as "listed", certifying discovery that may not exist |

**Missing `run_outcome` — a truncated producer run is scored as a finished one**

| Detector | Concrete false conclusion |
|---|---|
| `book-liveness-canary.py` `:77` | a partial book snapshot is treated as the venue's complete state |
| `db-superuser-canary.sh` `:37` | a psql session killed mid-query reports "no superuser grants found" |
| `docs-drift-canary.sh` `:38` | a build that died halfway yields a docs set that "matches" because the rest was never emitted |
| `equity-launch-readiness.sh` `:25` · `equity-verdict-watch.sh` `:16` | a killed producer's partial output is scored as its final answer |
| `kernel-staleness-canary.sh` `:28` | an interrupted `uname`/package query reads as "kernel current" |
| `lockfile-resolvability-canary.sh` `:37` | an `npm` resolution killed by timeout reads as "lockfile resolvable" |
| `postgres-cpu-snapshot.sh` `:24` | a sampling window cut short is averaged as a full window — the measured 50–90× over-count class |
| `seed-coverage-canary.sh` `:27` | a seeding run stopped at venue 4 of 17 reports the coverage of all 17 |
| `seed-orchestrator-gate-48h.sh` `:140` | a truncated orchestrator run passes the 48h gate on 4 hours of data |
| `stripe-webhook-events-canary.sh` `:15` | a paginated event listing cut short reads as the complete enabled-event set |
| `tier-misclassification-canary.sh` `:29` · `venue-slo-tiers-drift-canary.sh` `:25` | a partial scan's zero findings are published as a clean full scan |
| `website-drift-canary.py` `:323` | a manifest pass that aborted at row 3 reports every later row as matching |
| `x402-bazaar-canary.py` `:108` | a probe loop killed mid-flight reports the venues it never reached as listed |

**Missing `evidence` — the body asserts a mechanism the code does not implement**

The archetype is `directional-label-freshness.py:224`: *"SLO-ordered, so majors were served
first; the shortfall is the long-tail overflow"* — both halves false, and structurally inverted,
since majors carry a 24h SLO against long-tail 72h and are therefore the venues the selector is
**most** likely to name. 30 detectors carry prose of this shape. Each renders an explanation the
reader cannot check against the numbers in the same message, and each will keep rendering it
after the code beneath it changes: `analytics-drift-canary.sh:49`, `bot-deploy-parity.sh:119`,
`checkout-parity.sh:93`, `closedbar-w1-liveness.sh:379`, `decision-gate-orphan-canary.py:124`,
`declaration-sync.sh:276`, `deploy-drift-canary.mjs:212`, `funnel-leak-detector.py:127`,
`monitoring-inventory-reconcile.py:450`, `nav-drift-canary.sh:56`,
`outcome-backfill-freshness.py:36`, `payment-decline-canary.py:110`,
`postgres-cpu-autopilot.py:330`, `quota-exhaustion-canary.py:126`,
`recommendation-drift-canary.py:60`, `revenue-meter-canary.py:279`,
`x402-claim-liveness-prober.py:83`, `xrepo-ci-conclusion-canary.sh:177`, and the rest tabled in §4.

---

## 6. ⚠️ The retracted finding — H5 in the instrument, for the third time

**As first published, this section claimed two inventory rows were stale and that the wave's
enumeration was "provably incomplete". Both halves were wrong.**

| Row `id` | `artifact` | Actual state |
|---|---|---|
| `candle-basis-shadow-report` | `ops/cron/candle-basis-shadow-report.sh` | `install_state: retired`, `retired_at: 2026-08-13T12:46:25Z`, `retired_by: OPS-RECALIBRATE-HARNESS-RETIRE-W1` |
| `closedbar-recalibrate-readiness` | `ops/cron/closedbar-recalibrate-readiness.sh` | same — retired by the same wave |

Both scripts were deleted by `799eedb` — *"retire two orphaned decision gates as a class"* — and
both rows were updated to record it, with a `retirement_trigger` explaining what answered each
gate's question. **That is the convention working exactly as designed.** The census had no notion
of `install_state`, so it read a correct retirement as a missing artifact and escalated it to a
terminal FAIL.

The fix is in `scripts/monitoring-census.mjs`: a retired row's artifact is expected to be absent,
so it is reported under `RETIRED` and never as missing — and, narrowly, a retired row whose
artifact is *still present* keeps its `criticality` and stays scorable, because dropping it would
have silently shrunk the population a second way.

**This is the third time H5 landed on this instrument in one chapter** (the first two are in §1:
scoring inert declarations as detectors, then dropping `postgres-cpu-autopilot.py`). Each time the
census produced a confident number that was wrong, and each time it was caught by looking at what
the flagged rows actually said rather than by trusting the tool. The count that survives all three
corrections is unchanged — 39 detectors, `CLASS_ESTABLISHED` — but the FAIL did not survive, and a
census shipped on any of the three earlier runs would have carried a false finding into CH2 as a
precondition.

---

## 7. Sizing verdict

```
CENSUS_SIZING=CLASS_ESTABLISHED
```

**39 of 39 detectors fail at least one property; 27 are `load-bearing`.** Discounting `run_id`
entirely as non-discriminating (§4), **34 still fail** — 24 of them `load-bearing`. The threshold
is 3. The class is established by an order of magnitude, and the definition of "failing" was not
widened to reach it: every failure in §4 is a specific, cited, reproducible signal.

**CH2 proceeds.**

---

## 8. AC ledger

| # | Check | Result |
|---|---|---|
| AC1.1 | Every detector enumerated from all three sources, stated total, no sampling | ✅ 39 scored; 46 S1 files + 69 S2 rows + 1 S3 producer; every drop reasoned in §2 |
| AC1.2 | Four-property score per detector, each failure cited `<file>:<line>` | ✅ §4; 106 cited failures via `--cite` |
| AC1.3 | `criticality` beside every row | ✅ §4 |
| AC1.4 | One concrete false-conclusion scenario per failing detector | ✅ §5 |
| AC1.5 | Zero writes outside the census script and its artifact | ✅ 3 files: `scripts/monitoring-census.mjs`, this artifact, `tests/unit/monitoring-census.test.ts` |

*(The correction in §6 was applied during CH2 and touches only `scripts/monitoring-census.mjs` and this artifact — still inside CH1's write scope. Factuality outranks the Scope Rule: a false finding in a committed artifact is corrected where it stands, not left to be inherited.)*

**Self-test proven able to fail** — three deliberate mutations, each turning the suite red on
exactly the assertion it should, judged on printed output rather than exit code:

| Mutation | Red assertions |
|---|---|
| `scoreVerdict` always returns `pass` | `BAD verdict`, both `exit-code-only form` cases, the detector-union case |
| `summarisesAProducerRun` always `false` | `GOOD run_outcome`, `BAD run_outcome` (both collapse to `n-a`) |
| transport test stops stripping comments | `transport mentioned in a comment is not a call` |
