# OPS-PREREG-IDENTIFIABILITY-GATE-W1 — endpoint truth (Plan Mode, R0)

**Written:** 2026-10-01T07:53:42Z (`date -u` at write time) · **Base:** `origin/main` `dfbcfa4c` · **Worktree:** `.worktrees/crypto-quant-signal-mcp/ops-prereg-identifiability-gate-w1`, branch `worktree-ops-prereg-identifiability-gate-w1`

Methodology and code facts only. No outcome statistic was read; the only figures below are the ones this repo already publishes (the 2026-09-02 trigger-A counts in `population_comparison.py`'s self-test and the registry/schema prose).

## 1. Wave Objective (restated)

Make "can this declared floor ever be reached by this arm?" a precondition of DECLARING a floor on a rate, edge or excess comparison, on both declaration surfaces — pre-registrations (`audits/PREREGISTRATION-PROCEDURE.md` §4c, gated by `tests/unit/preregistration-support-stress-test.test.ts`) and population-comparison registry sites (`scripts/check-population-comparison.mjs`). The bound is computed from a cardinality only (the minority-side share `m`), by ONE Python function next to `Arm.attainable_pp`, which both TypeScript/JS surfaces reach by subprocess.

## 2. The bound, re-derived (not trusted)

For an arm with BUY share `q` and up-share `u` on its rows (binarised up / not-up, the same table `Arm.attainable_pp` uses), the joint `a = P(BUY ∧ up)` ranges over the Fréchet interval `[max(0, q+u−1), min(q, u)]`, and the hit rate is `2a + 1 − q − u`. So the attainable width is

`1 − |q − u| − |q + u − 1|`, and since `|x| + |y| = max(|x+y|, |x−y|)`, it equals `1 − max(|2q−1|, |2u−1|) = 2·min(q, 1−q, u, 1−u)`.

Hence width `≤ 2·min(q, 1−q)` (the cardinality bound), with equality exactly when `u ∈ [min(q,1−q), max(q,1−q)]`. Ties (zero-return rows) are in the denominator and in no win bucket, which only narrows the true 3-outcome range.

**Measured against the live code** (`Arm.attainable_pp` at `origin/main`, stdlib Python, grid q, u ∈ {i/1000} ∪ {0.0053, 0.9947}, scored = 10,000):

| check | result |
|---|---|
| grid points | 1,004,003 |
| `attainable_pp > 200·min(q,1−q)` | **0** |
| equalities | 503,979 |
| `attainable_pp ≡ 200·min(q,1−q,u,1−u)` | 0 violations |
| trigger-A v1 counts (buy_side 27,995 / scored 28,144) | `m = 0.00529`, bound = attainable = **1.0588 pp** < declared 3.0 pp ⇒ NOT_IDENTIFIABLE |

Consequence for the property test: assert `bound ≥ attainable` everywhere AND `bound = attainable` on the equality region. The first catches a downward mutation of the bound, the second an upward one; asserting only `≥` would let `300·min(q,1−q)` pass.

## 3. Truth table — claim · reality · resolution

| # | Claim (spec) | Reality (probe) | Resolution |
|---|---|---|---|
| R0a | `attainable_pp()` in `population_comparison.py` | A `@property` on class `Arm(label, scored, engine_wins, long_wins, short_wins, buy_side)` (`population_comparison.py:107-118`); `q = buy_side/scored`, `pL = long_wins/scored`; returns pp; `None` when `scored == 0` | Property test builds `Arm`s from counts. New `attainable_bound_from_share(q)` returns **pp** (same unit), `None` on non-finite / out-of-`[0,1]` input |
| R0b | gate parses `## Support stress-test` + `## Operating characteristic` | §4: discovery `/preregistration.*\.md$/i` over top-level `audits/` (also matches `PREREGISTRATION-PROCEDURE.md`, which passes via its example table); heading `^#{2,6}\s+.*support stress-test`; section ends at the next same-or-higher heading; header substrings `check · evaluation point · support · verdict`; ≥1 row with 4 non-empty cells. §4b: trigger regex; FIRST contiguous table; columns found by `findIndex`; null + control rows; numbers checked against their own bounds; `OC_EXEMPT` = the procedure | §4c reuses §4b's model (columns by name, numbers checked) and §4's grandfather mechanics |
| R0c | the registry declares a site's floor; records a side share? | The ledger is `ops/monitoring/population-comparison.registry.json` (the spec cites the **schema** path; the schema is the contract). **0 of 10 sites declare a floor; no side share is recorded anywhere.** Floors are code constants (`ops/monitoring/trend-mode-readout-gate.py:69` `EDGE_FLOOR_DROP_PP = 3.0`) passed at readout to `compare_arms`; `q` is measured at readout from counts | New optional site fields `declared_floor_pp` + `sized_against[]` (`arm`, `minority_side_share`, `probe`) on registry rows; the checker enforces them. Forward-only — see §5 D3 |
| R0d | grandfather allowlist mechanism | `GRANDFATHERED: Map<path, reason>` — asserted non-empty, no glob characters, reason ≥ 40 chars, file exists, and stale in both directions (a grandfathered file that gains a passing section fails the suite) | `IDENT_GRANDFATHERED`, same mechanics, one exact reasoned row per landed registration (12); `IDENT_EXEMPT` = the procedure itself |
| R0e | wired runners | Prereg vitest: CI (`deploy.yml` full vitest step) **and** pre-push (`check_test_baseline.sh`). Registry checker: **pre-push only**, through node:test `tests/unit/population-comparison.test.mjs` (excluded from vitest; `deploy.yml`'s `node --test` step runs two geo files only) | A vitest leg runs the checker's `--self-test` so the registry surface is enforced in CI as well |
| F1 | "zero public surface" ⇒ a repo-only change | `population_comparison.py` and the schema are **host-installed on signal-1** (`/opt/algovault-monitoring/`, regular files, sha `c167f6df…` / `ef8906da…` = inventory = `origin/main`), load-bearing, imported daily `19 7 * * *` by `trend-mode-readout-gate.py`; host Python 3.12.3. Both rows are `repo_resident: true`, so `HASH_DRIFT` / `REGISTRY_PARITY` / `NO_BACKUP` SKIP them — a stale host copy would be silent. `tests/unit/monitoring-primitive-parity.test.mjs` blocks a push whose inventory artifact changed without a re-stamp | Re-stamp the `population-comparison-derivation` and `population-comparison-registry` rows in the same commit. Host install = architect question Q2. Schema left untouched (D2) |
| F2 | "never a second formula" | `src/scripts/ads1/core.ts:292` `frechetAttainablePp` is an existing TS port of `attainable_pp` (EDGE-ADS1-SCORECARD-W1) with **0** parity tests against the Python | Architect question Q3 (parity pin on this wave's grid, test-only) |
| F3 | the verification gate decides the wave | Run on the untouched tree: vitest 6/6 + checker PASS ⇒ `W1_GREEN` with **zero** wave work — vacuous | Gate amended: also require the new positive lines (§6) |
| F4 | objective: `attainable_pp` proved trigger A undecidable "only at readout, 30 days later" | It first refused trigger A on 2026-09-02 (`EDGE-POPULATION-COMPARISON-W1`, ~2 days after the 2026-08-31 declaration, after a false rollback page); the 2026-09-30 readout re-confirmed it | The generator point stands — the check ran after declaration. Recorded corrected |
| F5 | (docstring) `population_comparison.py` names `src/lib/population-comparison.ts` and `population-comparison.fixtures.json` | Neither file exists on `origin/main` | Docstring corrected; no behaviour change |
| F6 | system-map edge? | 0 mentions of population-comparison / preregistration in `system-map.md` | `system-map.md updated: n-a` |
| F7 | parallel overlap | 0 unmerged refs and 0 dirty worktrees touch this wave's files; 0 in-flight registrations off `main` | none |
| F8 | vault mirror | `_verify.sh` → `PREREG_MIRROR_VERDICT=PASS` (13 files); it mirrors FROM `origin/main` | Re-sync after landing |

Fabricated primitives: **0**. Plan Mode is required by the risk markers (host-installed artifact; identifiers cited in more than one place; contract choices that bind the next registration).

## 4. Identifier diff

| Identifier | Cited at | Live | Used as |
|---|---|---|---|
| `attainable_bound_from_share(q)` | Method, R2 | new | module-level fn, `population_comparison.py`, returns pp |
| `attainable_pp()` | Objective, Method, R0a, R2, AC1 | `Arm.attainable_pp` (property) | `Arm.attainable_pp` |
| population-comparison registry | Objective (schema path), R4 | `…registry.json` (sites) vs `…schema.json` (contract) | site fields live in the registry |
| `NOT_IDENTIFIABLE` | Method, R3, R5 | `population_comparison.NOT_IDENTIFIABLE` | reused, never re-spelled |
| `## Identifiability` | R3 | new | heading anchored on the word, numbering allowed |
| verdicts `IDENTIFIABLE` / `NOT_IDENTIFIABLE → restated as …` | R3 | new | `→` or `->` accepted |
| trigger-A fixture `m = 0.0053`, floor `3.0` pp | Method, R5 | counts give `m = 0.00529` | fixture uses `0.0053` ⇒ bound `1.06` pp |
| `PREREG_MIRROR_VERDICT=PASS` | Context, AC5 | emitted by `_verify.sh` | gate token |

## 5. Decisions taken in Plan Mode (no answer needed)

- **D1 — one row per (declared floor × arm it constrains).** A cross-arm delta therefore carries one row per arm; each arm is checked against its own `2m`, so "the binding arm is the narrower one" is enforced by construction. A single row naming "the binding arm" cannot be verified by the gate.
- **D2 — the declaration-time site rule lives in the registry**, which is repo-side only (`reconcile_exempt_reason: REPO-SIDE ONLY`). The schema stays untouched, so no host-synced declaration changes.
- **D3 — no live registry row is back-annotated.** Writing trigger A's floor and share into its row would turn the live checker FAIL (3.0 pp > 1.06 pp). The readout-time refusal (`compare_arms`) still covers it.
- **D4 — the registry refuses outright; a registration documents.** A site whose floor exceeds its bound is a FAIL. A §4c row may record `NOT_IDENTIFIABLE → restated as …`, because the spec defines that verdict; the gate checks that the stated verdict equals the recomputed one and that a refusal names its restatement.
- **D5 — the comparison is `floor > bound + 1e-9`**, so float noise at exact equality never refuses an attainable design. Equality passes, as in `compare_arms`.
- **D6 — `m` is the minority share, stated as a fraction in `[0, 0.5]`, first number in its cell, followed by its probe** (a backticked command / SQL or the word `probe`). A percentage or `m > 0.5` is a named shape failure.

## 6. Verification gate (amended — the spec's is green on the untouched tree)

```bash
bash -c 'set -euo pipefail
npx vitest run tests/unit/preregistration-support-stress-test.test.ts
out=$(node scripts/check-population-comparison.mjs)
grep -qx "POPULATION_COMPARISON_GATE_VERDICT=PASS" <<<"$out"
grep -q "^\[population-comparison\] identifiability:" <<<"$out"
st=$(node scripts/check-population-comparison.mjs --self-test)
grep -qx "POPULATION_COMPARISON_GATE_VERDICT=PASS" <<<"$st"
py=$(python3 ops/monitoring/population_comparison.py)
grep -qx "POPULATION_COMPARISON_VERDICT=PASS" <<<"$py"
echo W1_GREEN'
```

## 7. Execution plan (single session, sequential)

1. **Python** — `attainable_bound_from_share`, `declaration_identifiability(floor_pp, shares)`, a stdin-JSON `--declarations` mode (the no-argument run stays the self-test); self-test gains the grid property (both directions), the trigger-A refusal, the valid case and malformed input; docstring corrected. Mutation proof: `100·min` and `300·min` each turn `SELF-TEST: FAIL`, then restore. Inventory row re-stamped.
2. **Procedure §4c** (after §4b): scope (floors on an edge or excess over the mix-matched null, or a cross-arm delta of such; NOT cluster, row or coverage floors), columns, D1, D6, verdict vocabulary, the subprocess recomputation, grandfathering.
3. **Vitest gate** — `identifiabilityVerdict(md)` for shape plus ONE batched Python subprocess for arithmetic; every spawning block declares `{ timeout }`; `IDENT_GRANDFATHERED` (12) + `IDENT_EXEMPT`; two-way self-tests; the registry-surface leg.
4. **Registry + checker** — `_site_floor_doc`; floor ⇒ `sized_against` required; a floor above the narrowest bound ⇒ FAIL `NOT_IDENTIFIABLE`; Python unreachable with ≥1 floor-declaring site ⇒ INDETERMINATE; a positive `identifiability:` line on every run; self-test through the REAL Python evaluator. Registry row re-stamped.
5. **Fixtures** `tests/fixtures/identifiability/` — trigger A (refused) and a valid design (passes), one per surface, read by both self-tests.
6. Land via `scripts/land.sh` (outside the 18–03Z deploy-free window; `audits/`, `tests/`, `scripts/` are not `paths-ignore`d, so the standard deploy runs); host install per Q2; mirror re-sync + `_verify.sh`; `status.md`, WIS, monitoring-results-sync.

**Destructive commands:** none. **Host mutation:** at most one reviewed install (Q2).

## 8. Architect rulings (received 2026-10-01T14:06:55Z, recorded at the top of the vault spec)

- **Q1 = A.** `## Identifiability` is mandatory on every non-grandfathered registration; a registration with no rate floor writes the single line `NO_RATE_FLOOR_DECLARED - <reason>` instead of the table.
- **Q2 = A.** Install the edited `population_comparison.py` on signal-1 after landing, outside the `19 7` window, via `ops/scripts/install-monitoring-artifact.sh` (dry run, then `--apply`), then the module self-test and `trend-mode-readout-gate.py --self-test` under `ALGOVAULT_TG_TEST_INERT=1`, and confirm the next scheduled 07:19Z verdict is unchanged. **Correction to the ruling's premise:** the `population-comparison-derivation` row ALREADY declares `installed_at: [{signal-1, /opt/algovault-monitoring/population_comparison.py}]`. The blind spot is the reconciler's `repo_resident` skip (`check_hash_drift` and the `REGISTRY_PARITY` check both `continue` on `repo_resident`), so it is recorded as this wave's one follow-up, owner `monitoring-inventory-reconcile.py`, and the reconciler is not edited.
- **Q3 = B.** `src/scripts/ads1/**` is untouched; the unpinned twin is logged in `status.md` against its owner.
- All eight corrections and five decisions above were accepted as written.
