# OPS-CLAUDEMD-CLAIM-FRESHNESS-SEVERITY-W1 — CH1 endpoint-truth

**Target ICP tier(s): META.** Plan-Mode probe record + CH1 measurement reconciliation.
**system-map edges: NONE — internal change only.**

Measured 2026-08-08 on the operator machine. Corpus is the vault `CLAUDE.md` (private, outside this
repo). **This document cites claim IDENTIFIERS and file paths only — never corpus prose**, the same
discipline `ops/claudemd-claims.lock.json` declares for itself.

Every id set below was obtained by importing the **real exported** `buildLock` / `claimId` /
`claimIdSet` from `scripts/check-claudemd-claims.mjs` — no re-implementation, no print-cap edit, and
nothing written to the committed lock. Fixture runs drive `ALGOVAULT_CLAUDEMD_CORPUS` /
`ALGOVAULT_CLAUDEMD_LOCK`, the overrides the script documents for exactly this purpose.

---

## 0. Mid-wave state change — recorded first, because it changes two ACs

`origin/main` advanced **twice during this wave's Plan Mode**:

| | ref | what |
|---|---|---|
| Plan-Mode start | `3ac6bb4` | lock 87 ids; fresh extraction 89 ⇒ **+2/−0**, gate FAIL |
| `829f896` | — | `worktree-closedbar-sell-asymmetry` **merged**; `audits/OPS-CLOSEDBAR-SELL-ASYMMETRY-W1-2026-08-08.md` lands on `main` |
| `401b818` | now | lock re-synced to **89 ids** ⇒ **+0/−0**, gate **PASS** |

**The lane fix happened, by another session, while this wave was being planned.** That is not a
reason to stand the wave down — it is the wave's thesis reproducing itself. The spec predicted
precisely this: *"re-sync the lock and the fleet unblocks until the next manual edit … re-syncing it
fixes nothing durable."*

Two consequences, stated plainly rather than worked around:

- **AC2.1 as written is now unsatisfiable.** There is no live stale lock to demonstrate against.
  CH2 proves the contract by fixture (§5), which is stronger anyway: a fixture can be re-run, and
  a live symptom that another session can close at any moment cannot.
- **AC2.2 is now true for the wrong reason.** A push from a previously-failing worktree succeeds
  today because of `401b818`, not because of this wave. CH2/CH5 must not claim credit for it.

**F4 is completely untouched by `401b818`: 6 ids in the freshly-committed lock still render
`[object Object]`** (§4). The value-blindness is live at `origin/main` right now.

---

## 1. Truth table — `claim | reality | resolution`

| # | Spec claim | Reality (measured) | Resolution |
|---|---|---|---|
| 1 | F1: operative delta **+2/−0** | ✅ **CONFIRMED** vs `origin/main`@`3ac6bb4` lock (87 ids → fresh 89) | Was correct; now closed by `401b818` |
| 2 | F1: *"the reported 9 stale claims did not reproduce"* | 🛑 **FALSE — reproduces exactly.** Primary checkout `/Users/tank/code/crypto-quant-signal-mcp` is at `6816033`, **28 commits behind**, carrying an older lock (80 ids, provenance `74c4106c…`, `corpus_lines` 451) vs `origin/main`'s (87 ids, `c62058ac…`, 467). `--check` there prints **+9/−0** | **Q1 = (a).** NOT the print cap — 9 < 10. `scripts/check-claudemd-claims.mjs`, `ops/claudemd-claim-config.json`, `tests/unit/claudemd-claims-gate.test.ts` and `scripts/check-canaries-wired.mjs` are **byte-identical** across the 28-commit gap, so the lock was the only variable |
| 3 | F2: `audits/OPS-CLOSEDBAR-SELL-ASYMMETRY-W1-2026-08-08.md` *"present on no ref"* | 🛑 **FALSE.** Committed `829f896`, pushed on `origin/worktree-closedbar-sell-asymmetry`, present in `.claude/worktrees/closedbar-sell-asymmetry`. Has since **merged** | **Q2 = (d) no action.** `buildLock` stamped `in_flight: origin/worktree-closedbar-sell-asymmetry`; `isBlocking` → **`false`**. **CH3 R3.7's branch structure dissolves** |
| 4 | F2: one prose line *"hard-blocks every worktree"* | ✅ Block real and fleet-wide — **mechanism is purely F3.** `verifyClaim` → `MISSING`, `isBlocking` → **`false`**; strip the marker and it returns `true` | The ladder got the right answer and never ran. Strongest evidence **for** F3 |
| 5 | F3: freshness `FAIL` precedes the ladder | ✅ **CONFIRMED** — `runCheck` returns at the `sameClaimSet` guard, before `lockedVerified` marking and before the per-claim loop. Reproduced by fixture in §5 **at `401b818`** | CH2 proceeds |
| 6 | F4: `.map(String)` over `{code, meaning}` → `[object Object]`, **6 of 113** ids | ✅ **CONFIRMED, exactly 6**, identical in fresh extraction and in the committed lock — symmetric, so not what fails the gate | CH3 proceeds |
| 7 | F4/M4: `2=INDETERMINATE` → `7=INDETERMINATE` leaves the id byte-identical | ✅ **CONFIRMED** (§4) | CH3 R3.4 is the right test |
| 8 | F4: *"collision surface: two 1-code claims on one subject → same id"* | ⚠️ **Surface real, ZERO live instances** across all 89 lockable ids | CH3 R3.5 is a **forward-guard**, not a remediation — labelled as such |
| 9 | F5: `corpus_lines` 467 vs 468, provenance-only | ✅ **CONFIRMED.** Never compared | Do not "fix" |
| 10 | Self-test fixtures are `codes: [2]` / `codes: [3]` raw numbers | ✅ **CONFIRMED** — passes only because `String(2) !== String(3)`, a shape `extractClaims` never produces | CH3 R3.3 stands |
| 11 | CH2: *"one prose line wedges **~43 worktrees**"* | 🛑 **FALSE — 22** (13 under `.claude/worktrees/`, 8 elsewhere, + primary) | 43 was lifted from an unrelated 2026-08-07 gate-staleness measurement. Corrected in CH5 |
| 12 | CH1 R1.1: *"the **pristine** primary checkout … on `origin/main`"* | 🛑 **FALSE.** Clean tree, but 28 commits behind. `git diff --name-only origin/main` there lists **54 files**, so **CH1's own gate false-REDs in the checkout the spec names** | Wave runs in a fresh worktree off `origin/main`. **Q6** |
| 13 | R2.1's delta table has two path states | ⚠️ **GAP** — `buildLock` has **three** (`tracked` / `in_flight` / `unpublished`) and the live motivating claim was the **third** | Add `STALE_IN_FLIGHT`. **Q4** |
| 14 | Map Anchor: no `system-map` row for this gate | ✅ CONFIRMED — sole hit is the `algovault-monitoring` row's `DOC_PATH_CLAIM` sentence, describing `ops/monitoring/doc-host-path-claims.json`, untouched here | `system-map.md updated: n-a` |
| 15 | Wiring: pre-push (vitest) + CI | ✅ CONFIRMED — `tests/unit/claudemd-claims-gate.test.ts` is **not** in `audits/test-baseline-known-failures.txt` (declared "GREEN — zero known-failing files"), so its red is a NEW failure and `scripts/check_test_baseline.sh` blocks; `.github/workflows/deploy.yml` runs `--self-test` + `--check` | — |
| 16 | vitest `^3.1.1`; `tests/unit/` exists; `ALGOVAULT_CLAUDEMD_LOCK`/`_CORPUS`/`_GATE` overrides exist; `--self-test` green; CH5 anchor resolves | ✅ ALL CONFIRMED | — |

**False premises: 4 (#2, #3, #11, #12) → ≥3 → HALT-class per Plan-Mode law.**
**Structural findings F3/F4/F5: 3 of 3 CONFIRMED → the design is sound. Correction set, not a rewrite.**

---

## 2. R1.2 — complete delta sets (no print cap involved)

Against the **primary checkout**'s lock (`6816033`, 80 ids) — the "9", reproduced in full:

```
+ basename:closedbar-w1-liveness.sh
+ basename:install_test_gate_hook.sh
+ repo-path:audits/OPS-CLOSEDBAR-SELL-ASYMMETRY-W1-2026-08-08.md
+ repo-path:scripts/check-jq-truthiness.mjs
+ repo-path:scripts/lib/branch-work-landed.sh
+ repo-path:src/lib/aoe-config-reader.ts
+ repo-path:src/tools/get-trade-call.ts
+ script-content:check_test_baseline.sh=exit:[object Object]
+ script-content:scripts/check-jq-truthiness.mjs=token:JQ_TRUTHINESS_VERDICT=
(removed: 0)
```

Against `origin/main`@`3ac6bb4`'s lock (87 ids) — the spec's F1, confirmed:

```
+ repo-path:audits/OPS-CLOSEDBAR-SELL-ASYMMETRY-W1-2026-08-08.md
+ repo-path:src/lib/aoe-config-reader.ts
(removed: 0)
```

Seven of the nine are simply claims `origin/main` had already locked. Zero removed in either
direction. **AC1.7's halt trigger is met on its own terms** (added ids outside `repo-path`, in the
checkout the spec names) — and the resolution is #12: do not work in that checkout.

---

## 3. R1.4 — existence, settled across every ref and worktree

| Probe | `audits/OPS-CLOSEDBAR-SELL-ASYMMETRY-W1-2026-08-08.md` | `src/lib/aoe-config-reader.ts` |
|---|---|---|
| `git log --all --oneline -- <path>` | `829f896` | present |
| `git cat-file -e origin/main:<path>` (at `3ac6bb4`) | ABSENT | present |
| every `refs/remotes` ref | **FOUND on `origin/worktree-closedbar-sell-asymmetry`** | present |
| every worktree working tree | **FOUND in `.claude/worktrees/closedbar-sell-asymmetry`** | present |
| `git ls-files --error-unmatch` | n/a | **TRACKED** |
| status | **merged to `main` at `829f896` during this wave** | unchanged |

`status.md` recorded that branch as *"pushed, NOT merged (merging rebuilds prod — architect's
call)"* — a deliberate hold, not a lost file. The spec's F2 and the `status.md` report that seeded
it both measured a working tree and **never consulted remote refs**.

---

## 4. R1.5 — `[object Object]`, and the value-blindness

Six ids, in the extraction **and** in the lock committed at `401b818`:

```
script-content:/opt/algovault-monitoring/postgres-cpu-autopilot.py=exit:[object Object]/[object Object]/[object Object]/[object Object]
script-content:check_test_baseline.sh=exit:[object Object]
script-content:check_test_baseline.sh=exit:[object Object]/[object Object]/[object Object]/[object Object]/[object Object]/[object Object]/[object Object]
script-content:scripts/check-claudemd-claims.mjs=exit:[object Object]
script-content:scripts/check-source-greppable.mjs=exit:[object Object]
script-content:scripts/install_test_gate_hook.sh=exit:[object Object]/[object Object]/[object Object]
```

**Value-sensitivity test (M4), in memory — the real corpus was never written.** Mutating one
exit-code digit on the line producing the 7-pair `check_test_baseline.sh` claim:

- `codes` array **changed**: `2=INDETERMINATE` → `7=INDETERMINATE` (re-sorted)
- claim id: **byte-identical**
- full **113-id set: unchanged**

The gate is structurally incapable of detecting an exit-code change — the exact drift class the
subsystem exists for, and the class `check_test_baseline.sh`'s own recorded 2-vs-3 incident belongs
to. The id encodes the **number** of pairs and nothing about their values.

**Collisions: 0 live** across all 89 lockable ids. The surface is real; no instance exists today.

**Third emission site, not named by the spec:** `printFinding` renders
``exit ${claim.codes.join('/')}`` — the same `[object Object]`, in the message a human reads. Folded
into CH3. **Q7.**

---

## 5. F3 reproduced at `401b818` — and F6, which the spec did not model

Fixture locks derived from the current committed lock via `ALGOVAULT_CLAUDEMD_LOCK`.

**A — benign staleness blocks.** Remove one claim for a tracked, present file:

```
+ claim not in the lock: repo-path:src/lib/aoe-config-reader.ts
✖ lock is STALE vs the live corpus — the CLAIM SET changed (+1/-0).
CLAUDEMD_CLAIMS_VERDICT=FAIL
```

Nothing is wrong with the repo. The push is refused for bookkeeping.

**B — the dangerous condition, with and without staleness.** Fixture corpus prescribing a missing
`scripts/deleted-thing.mjs`, locked **unmarked** (i.e. verified at sync time):

| case | lock | result |
|---|---|---|
| C1′ | fresh | `1 blocking claim failure(s) — the prescriptive SoT asserts something the repo contradicts` — **names the deleted path** ✅ |
| C2′ | **stale** by one unrelated added claim | `lock is STALE … (+1/-0)` — **the deleted path is never named** 🛑 |

One unrelated prose edit anywhere in the corpus and the only real safety finding this subsystem
produces disappears behind a bookkeeping message.

### F6 — the printed remediation launders a real block into a pass

From C2′, follow the gate's own printed instruction (`--sync`):

```
lock written: 3 claims, 3 ids — commit ops/claudemd-claims.lock.json
  → scripts/deleted-thing.mjs   now carries  "unpublished": true
re-check:  2 OK · 0 blocking · 1 report-only
CLAUDEMD_CLAIMS_VERDICT=PASS
```

**BLOCK → PASS.** `--sync` re-derives the claim from the corpus, finds the path on no ref, and
stamps it `unpublished`, which `isBlocking` correctly treats as non-blocking — so the memory that
the claim was *once verified* is destroyed by the act of refreshing the lock. The `was_verified`
BLOCK is not merely masked by staleness; **the remediation the gate prints deletes it.**

This upgrades CH2 from an ergonomics fix to a safety fix, and it is the single most important
property CH2 must pin: `was_verified` must be carried across a `--sync`, and the dangerous
condition must be reachable while the lock is stale.

---

## 6. Resolutions carried into CH2 / CH3 / CH5

| From | Resolution |
|---|---|
| #2, #12 | Wave runs in a worktree off `origin/main`; the 28-commit-stale primary checkout is a separate hygiene item, **not** fixed here |
| #3 | CH3 R3.7 dissolves — no recovery commit, no `in_flight_claims` row, no HALT |
| #5, F6 | CH2: classify above the freshness predicate; carry `was_verified` across `--sync`; keep the deleted-verified-path BLOCK reachable on a stale lock |
| #13 | CH2 severity ladder gains `STALE_IN_FLIGHT` |
| #6, #7, #8, Q7 | CH3: `claimId` renders `code=meaning`; fix `printFinding`; rebuild self-test fixtures from the real `extractClaims`; collision case labelled a forward-guard |
| #11, §0 | CH5 corrects the worktree count, the "+2/−0 vs 9" reconciliation, and F2 — wrong figures left visible |
| #9 | `corpus_lines` left alone |
| #14 | `system-map.md updated: n-a` |

---

## 7. Provenance

- Worktree `worktree-claudemd-freshness-severity` off `origin/main` `401b818`, clean, real
  `node_modules` (530 entries) from the wrapper's own `npm ci`.
- Mutation count against tracked repo state during CH1: **ZERO** outside this file.
- Fixture artifacts live in the session scratchpad, never in the repo.
