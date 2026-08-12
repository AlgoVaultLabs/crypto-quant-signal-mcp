# META-CLAUDEMD-VERIFIER-CORPUS-SET-W1 — endpoint truth

Plan-Mode probe record, factuality corrections, and the falsification matrix.
Measured 2026-08-12 in worktree `claudemd-corpus-set-w1`, based on `origin/main` `e82f888`.

---

## R1 — Step-0 probes

### R1.1 anchors — 0 mismatches (HALT threshold is ≥3)

| Spec description | Live | Verdict |
|---|---|---|
| `const DEFAULT_CORPUS` | L62 | ✅ |
| `const CORPUS_PATH`, env-overridable single path | L63 | ✅ |
| `const LOCK_CLASSES` (8 classes) | L68 | ✅ |
| `claimId` = `class:value` + sorted `points` + rendered `token`/`exit` | L604–617 | ✅ |
| `sameClaimSet` | L625 | ✅ |
| `readFileSync(CORPUS_PATH…)` | L824 `runCheck` · L963 `runMeasure` · L1218 `--sync` — **three** sites | ✅ |
| `vaultDir` is `dirname(CORPUS_PATH)` | L313 (and `vaultReachable` L314) | ✅ |
| `buildLock` strips `line` | L672 | ✅ |
| extraction is heading-agnostic; whitespace spans skipped | L189, L181 — no `^#` regex exists | ✅ |

### R1.2 `in_flight_claims` — `[]`. No HALT.

### R1.3 baseline — pristine snapshot as the instrument

`sha256 23a8bd54dafa353e2b97c2f4a49a7d6d6db9e61f0f0a349c35033dac7f0616f9`, 142,003 B — matches
the spec byte for byte, and re-verified unchanged after the corpus delta.

| | Value |
|---|---|
| Baseline claims / unique ids | **114 / 114** |
| Lockable ids (the 8 `LOCK_CLASSES`) | **90** — equal to the committed lock's 90 |
| Committed lock sha256 | `90ffce5a8e38c2a209bdf654a640092eb4f9576efe23edeab7c65c3c37bd6a04` |
| 7-part merged | 135 raw → **114 ids** (21 cross-part restatements), lockable **90** |
| **AC1 / AC2 delta** | **0 added, 0 removed** |
| Firings with `vaultDir` anchored at the vault root | baseline **0**, 7-part **0** |

Recorded in `audits/META-CLAUDEMD-VERIFIER-CORPUS-SET-W1-baseline.json`; re-checkable at any time
with `node scripts/check-claudemd-claims.mjs --baseline <that file>`.

**A defect in the spec's own R1.3 command, found by running it.** Pointing
`ALGOVAULT_CLAUDEMD_CORPUS` at the snapshot puts `vaultDir` inside `Claude files/rules/`, so the
baseline `--measure` reports **11 spurious `vault-path MISSING` firings** (`status.md`,
`Design.md`, `Prompt/`, …). The claim *set* is unaffected — extraction does not consult the
filesystem — so AC1/AC2 stand. But it is the live demonstration of why R3 requires `vaultDir` to
stay anchored on the CLAUDE.md entry, and it is why the baseline artifact records ids rather than
firings.

### R1.4 invocation points — enumerated

| Site | Invocation |
|---|---|
| `.github/workflows/deploy.yml:443-444` | `--self-test` then `--check` (CI = lock-mode) |
| `tests/unit/claudemd-claims-gate.test.ts` | spawns `--self-test` / `--check` / `--sync` → runs at pre-push |
| `tests/unit/claudemd-claim-precondition.test.ts` | imports `claimId`/`claimIdSet`/`sameClaimSet`/`isBlocking`; spawns the CLI |
| `package.json` `prepublishOnly` | **not listed** — spec correct |
| shared `pre-push` / `pre-commit` (8 blocks) | **no claudemd block** |

### R1.5 corpus identity — no HALT, and the premise was false

- `stat` reports **`links=1`**, not 2, on both `CLAUDE.md` and the snapshot.
- **No `CLAUDE.md` in the repo checkout and none git-tracked** → the HALT condition ("a second name
  inside the public repo") is **not met**.
- What is actually loaded is the vault file (inode `46721375`) *plus a separate*
  `~/.claude/CLAUDE.md` (inode `10827309`, 3,316 B) — two different files at two scopes, which is
  almost certainly what "links=2" was reading.

---

## Corpus delta — WI-CONSOLIDATE-032 landed between spec authoring and execution

Every architect-supplied figure re-measured at execution time rather than copied:

| Figure | Architect | Measured | ✅ |
|---|---|---|---|
| `CLAUDE.md` | 25,879 B | 25,879 B (260 lines) | ✅ |
| rules corpus, excl. snapshot | 147,931 B | 147,931 B across 6 files | ✅ |
| snapshot | 142,003 B / `23a8bd54…` | identical | ✅ |
| `WIS-PENDING.md` | 1,938 B | 1,938 B (archive 851,409 B) | ✅ |

**AC2 re-verified post-delta: 0 added, 0 removed.** Per-part claim counts are byte-identical to
the pre-delta measurement (17 · 8 · 19 · 26 · 17 · 10 · 38), confirming the architect's claim that
all 60 promoted lines were authored path-free and mint no claim-bearing spans.

---

## Factuality corrections

| # | Claim | Live | Disposition |
|---|---|---|---|
| F1 | Spec: `CLAUDE.md` "reports `links=2`" | `links=1`; no second name; no repo copy | HALT condition not met; premise retired |
| F2 | Spec R2: a glob including the snapshot would "**double every claim**" | Raw 135 → 249, **unique ids 114 → 114, 0 added** — dedupe absorbs it | Rule **stands**, rationale **replaced** with the temporal one (below) and recorded on `_parts_semantics` |
| F3 | Spec: `CLAUDE.md` is 252 lines | 251 at spec time, 260 now | Cosmetic; no consumer |
| F4 | `system-map.md`: "127,589 B moved", "142,003 → 22,913 B" | Section-body bytes vs 129,667 B with headers; 22,913 was never correct | Corrected in place this wave with measured figures |
| F5 | Spec R1.3 says write "the `sha256`"; the gate reads `.lock_sha256` | — | Field named `lock_sha256` |
| F6 | `system-map.md`: "`--sync` is FORBIDDEN until this wave lands" | Self-retiring; false once landed | Clause **dropped** (Q1 = Y) |
| F7 | Spec R4 / AC1: the regression bar lives in `--self-test` | `--self-test` runs in CI where the vault is unreachable by design | Split per Q3 into `--baseline` (local, own token) + a corpus-independent self-test bar |

**F2 — the corrected reason, since this is the durable artifact.** A glob is wrong not because it
doubles the count, but because it is **temporally unsafe**: the snapshot is a frozen historical
document, so the first time a live part edits a claim the glob resurrects the superseded claim as
if still prescribed. The claim set could never shrink, and the gate would verify history as
prescription — the same law the `_( … )_` correction-block stripper already encodes.

---

## Defect found while reading the merge path (not modelled by the spec)

`printFinding` rendered `corpusLines?.[claim.line - 1]` from ONE line array. With claims arriving
from seven files, `claim.line` is per-part, so that lookup returns a **confident wrong source
line** — the third recorded sign of the "instrument measures a different quantity" class. Fixed by
stamping each claim with its `part` and indexing per part. `part` is treated exactly like `line`:
location, never identity — excluded from `claimId`, stripped by `buildLock`, and asserted absent
from the lock in both the self-test and vitest.

---

## Rejected hardenings (Q4) — measured, not argued

The architect's optional hardening was "assert that no part is a superset of another". Two obvious
forms were built, measured, and **rejected**:

| Form | Measurement | Verdict |
|---|---|---|
| **(a)** one part's TEXT contains another's | Does **not** fire on the live snapshot: `CLAUDE.md` gained a Rule Router and every rule body gained a header, so nothing is a substring | **Rejected** — it would have advertised coverage it did not have. It was written, shipped green, and caught nothing; the failure was found by pointing it at the real artifact |
| **(b)** some part contributes ZERO unique claim ids | Clean today (real parts contribute 2–26 unique ids; adding the snapshot drives every part to 0) | **Rejected** — the moment a live part edits a claim the snapshot starts contributing the *superseded* id as unique, so the signal disappears exactly when the harm begins. A guard that fires while harmless and goes silent once dangerous is worse than none |
| **(c) shipped:** a non-anchor part carrying ≥2 of the manual's top-level LAW sections | anchor 4/4 · frozen snapshot 4/4 · all six rule bodies **0/4** | **Shipped** — threshold-free, and it keeps firing after the snapshot diverges. Plus an exact byte-identical-parts check |

Form (a) is recorded rather than deleted because it is the lesson: a guard tested only against a
synthetic fixture it was built to satisfy will pass while being unable to catch its motivating
case — the hermetic-seam blindness, inside a wave whose own subject is that law.

---

## AC5 — falsification matrix

Every new assertion broken deliberately on a throwaway copy of the script (`scripts/__mutant-*.mjs`,
created and deleted within one command, never committed), so the real gate was never in a broken
state. All mutations REPORT via `SELF-TEST: FAIL (n)`; none abort the suite.

| Mutation | Detected | Assertion that fired |
|---|---|---|
| each part loses its FIRST line | exit 1 | `MERGE` · **`MOVE-INVARIANCE` (7 → 5 ids)** · dedupe-vacuity |
| merge only the first part | exit 1 | `MERGE: got 1, union 3` |
| remove the dedupe | exit 1 | `DEDUPE: produced 2 claims, expected 1` |
| `readCorpusParts` swallows a missing part | exit 1 | `MISSING PART: an absent part was not reported missing` |
| `vaultDir` follows the LAST part | exit 1 | `vaultDir ANCHORING: got …/Claude files/rules` |
| `part` enters `claimId` | exit 1 | `REGRESSION BAR: one-part merge does not reproduce single-path extraction` |
| lock keeps `part` | exit 1 | ``the lock carries a `part` field`` |
| `duplicateManualParts` disabled | exit 1 | `DUPLICATE-MANUAL: a RENAMED full-manual snapshot was not refused` |

One mutation that was **not** a real mutation is recorded because it nearly passed as one: dropping
each part's LAST line changed nothing, since a trailing newline makes the final split element an
empty string. It was replaced with the first-line variant rather than counted.

---

## Acceptance criteria

| # | Check | Result |
|---|---|---|
| AC1 | single-path vs R1.3 baseline | ✅ `CLAUDEMD_BASELINE_VERDICT=PASS`, 0/0 |
| AC2 | 7-part corpus vs R1.3 baseline | ✅ 0 added, 0 removed (re-verified post-delta) |
| AC3 | `--check` over 7 parts | ✅ `CLAUDEMD_CLAIMS_VERDICT=PASS` — **114 claims, 114 OK, 0 blocking, lock fresh** (was 17 verified + 85 `STALE_DROPPED` → PASS) |
| AC4 | `--sync` no-op | ✅ `lock already fresh — claim set unchanged (90 claim ids)`; lock sha256 byte-identical |
| AC5 | self-test scenarios | ✅ 8 scenarios, each demonstrated able to fail (matrix above) |
| AC6 | missing part | ✅ INDETERMINATE / exit 3 on `--check`, `--sync` and `--baseline`, end-to-end through the real CLI |
| AC7 | `npx vitest run` | ✅ 424 files / 5765 tests, 0 failures (warm). The cold first run in a fresh worktree failed 6 files — the recorded cold-start flake class; re-run warm was clean, and no gate was downgraded |
| AC8 | `check-source-greppable.mjs --check` | ✅ `SOURCE_GREPPABLE_VERDICT=PASS` |
| AC9 | `git diff --stat` scope | ✅ verifier · config · `tests/**` · `audits/**` only |

Wave gate: **`W1_GREEN`**.

## Q2(b) — the new seam has no committed setter

```
$ git grep -n 'ALGOVAULT_CLAUDEMD_CORPUS_PARTS'
scripts/check-claudemd-claims.mjs        [definition]
tests/unit/claudemd-claims-gate.test.ts  [test fixtures]
```

No workflow, hook, installer, package script or ops artifact sets it.
