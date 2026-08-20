# OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 — Plan-Mode endpoint truth

**Probed:** 2026-08-20, 15:29–15:5x UTC (box clock read at probe time: `date -u` → `2026-08-20T15:29:50Z`).
**Checkout probed:** `/Users/tank/code/crypto-quant-signal-mcp` (primary), all absence/content claims resolved against **`origin/main`**, never the working tree.
**Worktree for the wave:** `/Users/tank/code/.worktrees/crypto-quant-signal-mcp/serialize-landing-and-deploy-w1`, branch `worktree-serialize-landing-and-deploy-w1`, base `refs/remotes/origin/main` = `ea17177`.

**Verdict: 0 fictional primitives. 6 drift findings (2 material). 5 architect questions.**
Nothing the spec names is fabricated. The `≥3 fictional primitives ⇒ HALT` threshold does **not** fire. The material drift and the questions are below.

---

## 0. Wave Objective, restated

> Every shared mutable resource on this machine and in this repo's CI that can be written by more than one actor at a time must **declare how it serializes**, and a gate must refuse a resource that does not.

Three chapters deliver that: CH1 builds the missing primitive (a lock) and the wrapper that puts the *fetch + rebase + push* inside one critical section; CH2 promotes serialization from an unwritten assumption to a **field on the existing registry** and teaches the existing reconciler to refuse an undeclared one; CH3 closes the CI half by giving all six workflows a `concurrency` group whose key is a function of the **resource**, validated against CH2's declaration in both directions.

The wave is **not** a lock. The lock is one instance. What ships is: a registry field, a reconciler rule, and a disk-enumerating canary — so that a 7th workflow or a 10th hook-block writer *cannot land unserialized*.

---

## 1. Map Anchor — `system-map.md`

**Probe:** `grep -nE '^\| *`?(refs/heads/main|main|\.github|\$GIT_COMMON_DIR|pre-push)' system-map.md`
**Result:** zero matching rows.

| Component touched | Produces | Consumes | Edge mutated? |
|---|---|---|---|
| `refs/heads/main` (git ref) | — *(no system-map row exists)* | — | **No** — serialization changes *how concurrently* an existing edge is written, never what it produces |
| `$GIT_COMMON_DIR/hooks/pre-push` | — *(no row)* | — | **No** |
| `.github/workflows/*.yml` (6) | — *(no row)* | — | **No** — no trigger, job, step, permission or publish target altered |
| `ops/shared-worktree-state.json` | consumed by `scripts/check-shared-state.mjs` only (in-repo, `tight`) | — | **No** — additive field + additive rows |

No API field, MCP tool, postgres column, cron entry, publish target, removed component or repo rename is touched.
⇒ **`system-map.md updated: n-a`.** Spec's Map Anchor is **CONFIRMED**.

---

## 2. Endpoint truth — claim / reality / resolution

Every row was probed with one concrete command. `✓` = spec accurate. `⚠` = drift.

| # | Spec claim | Probe | Reality | Verdict / resolution |
|---|---|---|---|---|
| 1 | `flock(1)` is util-linux, **not** on the macOS base system — probe, do not hardcode | `command -v flock` | **not found** (rc=1). `python3` present at `/usr/bin/python3`, `import fcntl` OK (`LOCK_EX=2`). `uname` → Darwin 25.5.0 arm64; **`bash 3.2.57`** | ✓ **CONFIRMED.** R1a resolves to the **`mkdir`-atomic (POSIX)** primitive — dependency-free, works in bash 3.2, no python3 process-spawn per acquire. Recorded in the file header per R1a. bash 3.2 ⇒ **no `mapfile`**, and `${a[@]}` on an empty array dies under `set -u` |
| 2 | Live pre-push block order is `push-safety < session-drift < shared-state < source-greppable < test-gate`; "**the 4 existing pre-push blocks are frozen**" | `grep -n '^# >>> algovault' "$(git config --get core.hooksPath)/pre-push"` | **NINE blocks**, canonical `LC_ALL=C`: `dark-exports` · `gate-staleness` · `push-safety` · `quota-surface` · `session-drift` · `shared-state` · `source-greppable` · `test-gate` · `worktree-root`. **The first block is `dark-exports`, not `push-safety`** | ⚠ **MATERIAL DRIFT.** Changes the new block's naming constraint (see Q1). All **nine** are treated as frozen, not the four the Taxonomy names |
| 3 | "75 checkouts (`$GIT_COMMON_DIR` worktrees)" | `git worktree list \| wc -l` | **49** (48 worktrees + primary) | ⚠ drift, immaterial. The registry's `_consumers_policy` forbids a hand-maintained count outright, so `ref-main` carries a `writers_derived_from` command, never the digit |
| 4 | 0 of 6 workflows declare `concurrency` | `git show origin/main:<f> \| grep -c '^concurrency:'` ×6 | **0/6**, and `cancel-in-progress` **0/6** | ✓ CONFIRMED |
| 5 | 6 workflow files | `git ls-tree --name-only origin/main .github/workflows/` | **6**: `deploy` · `monitoring-schedules` · `postgres-lane` · `publish-npm` · `regenerate-landing` · `release-knowledge` | ✓ CONFIRMED |
| 6 | `queue: single\|max` is a real, documented `concurrency` key — **EXTERNAL FIRST USE** | `WebFetch` of the how-to page **and** the workflow-syntax reference (both official, fetched 2026-08-20) | **CONFIRMED on BOTH pages.** Syntax reference: *"To allow more than one `pending` job or workflow run to wait in the same concurrency group, use the optional `queue` property."* How-to: `single` (default) / `max` (≤100 pending); *"The combination of `queue: max` and `cancel-in-progress: true` is not allowed and will result in a workflow validation error."* | ✓ **NOT FICTIONAL.** Live-acceptance probe is CH3-R1's own gate (scratch branch), by design |
| 7 | The literal `cancel-in-progress: false` appears **nowhere** in GitHub's docs | same two pages | **CONFIRMED absent.** Only `cancel-in-progress: true` (and the expression form) is documented. Pending-run cancellation is governed by `queue`, not by this key | ✓ CONFIRMED — the prior Cowork recommendation was indeed wrong |
| 8 | Workflow-level `concurrency` expressions may use only `github`, `inputs`, `vars` | workflow-syntax reference | **CONFIRMED verbatim.** All six proposed keys use only `github` | ✓ |
| 9 | Concurrency group names are case-insensitive | workflow-syntax reference | **CONFIRMED verbatim** (*"`prod` and `Prod` will be treated as the same concurrency group"*) | ✓ |
| 10 | `check-shared-state.mjs` reconciles through a pure `evaluate(registry, facts)` | `grep -nE '^export function' scripts/check-shared-state.mjs` | `export function evaluate(registry, facts)` at **:90**; also exported: `mapCode(token, mode='block')` :54, `loadRegistry(path)` :71. Returns `findings[]` of `{check, severity, message, remediation}`, `severity ∈ ok\|report\|block` | ✓ CONFIRMED |
| 11 | Token `SHARED_STATE_VERDICT=PASS\|FAIL\|INDETERMINATE`; exits `0\|1\|3`; `ALGOVAULT_SHARED_STATE=warn` downgrades the **code only** | read :32-39, :51-68, :402-403 | CONFIRMED verbatim, and the self-test already asserts the token→code **mapping** (`mapCode('INDETERMINATE')===3`) | ✓ |
| 12 | Registry enumerates **14** resources with `id · path · kind · writers · consumers_derived_from · invariant · severity · sha256 · notes` | `json.load` + iterate | **14 rows** exactly, schema confirmed. `writers` is a **list of repo-relative writer scripts** | ✓ CONFIRMED — *and see §3, Finding B* |
| 13 | "there is no lock primitive in the repo at all (probed: zero flock/mutex/semaphore files)" | `git grep -nE '\bflock\b\|mkdir[^\|]*\.lock\|LOCK_EX\|fcntl\.flock' origin/main -- scripts/** ops/** src/**`, minus npm-lockfile hits | **ZERO genuine mutexes.** Every superficial hit (`check-lockfile-resolvable.mjs`, `lockfile-resolvability-canary.sh`, …) is the **npm lockfile**, a different noun | ✓ CONFIRMED |
| 14 | Install via `hook_block_install` in `scripts/lib/hook-block.sh` | read :239 | `hook_block_install <hook> <name> <wave-id> <script> <comment> <invocation> [legacy-regex]`. Sorts by `ls block.* \| LC_ALL=C sort`; takes a timestamped `.bak` before the first mutation; emits the inline if/else skip-guard + ledger row | ✓ CONFIRMED |
| 15 | `check-push-safety.sh` consumes the hook's stdin; a future stdin-reading block must `tee`, **never reorder** | read its header :55-59 | CONFIRMED verbatim: *"CONSEQUENCE: it CONSUMES the hook's stdin … If one is ever added, tee stdin here rather than making it sort earlier."* | ✓ — and the new block **does not read stdin**, so sorting it first is consistent with that instruction, not in tension with it |
| 16 | "`tests/unit/` holds **451** `.test.ts` and 24 `.test.mjs`" | `git ls-tree -r --name-only origin/main tests/…` | `tests/unit/` = **291** `.test.ts` + **24** `.test.mjs`; repo-wide `tests/` = **452** `.test.ts` + 24 `.test.mjs` | ⚠ minor drift — the 451 is a repo-wide figure attributed to `tests/unit/`. **Design unaffected**: the split is real, `vitest run` still does not execute the `.test.mjs` files, every new test is `.test.ts` |
| 17 | `npm test` is `vitest run` | `package.json.scripts` | CONFIRMED. `vitest.config.ts` **anchors discovery at `tests/`** (nested-worktree pathology) and **excludes** the node:test `.test.mjs` files — except `snapshot-capabilities.test.mjs`, a genuine vitest file | ✓ |
| 18 | `alloc-port.sh` is dual-mode (sourceable **or** executable) — mirror it | read the file | CONFIRMED: `bash scripts/lib/alloc-port.sh <task>` **or** `. scripts/lib/alloc-port.sh`. Its header states the two rules to copy: **no `set -e` at file scope** (it changes the caller's shell) and **portable to macOS bash 3.2** | ✓ |
| 19 | `monitoring-schedules.yml` shared target = "**monitoring host**" | its own header, lines 1-30 | **FALSE.** *"Here, on the monitoring paths, it runs alone: no build, no image, no SSH, no deploy — a static lint over committed JSON."* It mutates **nothing** | ⚠ **MATERIAL DRIFT** — see Q3 |
| 20 | `postgres-lane.yml` shared target = "per-branch" | header + `on:` | It spins an **ephemeral postgres service container inside the runner**. No shared external mutable target | ⚠ same class as #19 — see Q3 |
| 21 | `regenerate-landing.yml` trigger = `repository_dispatch` | `on:` block | Also `workflow_dispatch` **and** `push: branches:[main] paths:[skills/manifest.json, integrations/manifest.json]` | ⚠ minor. Does not change the group key (one landing ⇒ one global group) |
| 22 | `monitoring-schedules.yml` trigger = push→main (paths) | `on:` block | Also **`pull_request`** (same paths) and `workflow_dispatch` | ⚠ minor. Group key unchanged |
| 23 | `publish-npm.yml` trigger = tag `v*.*.*`; `release-knowledge.yml` = tag `v*` | `on:` blocks | CONFIRMED exactly | ✓ |
| 24 | Only `deploy.yml` writes the Hetzner host | grep for `git push` / commit actions across all 6 | **`regenerate-landing.yml` is the only workflow that pushes a ref** — it commits regenerated landing surfaces and `git push`es to `main` with a **PAT** (so the push *does* re-trigger `deploy.yml`) | ✓ new fact, and it is load-bearing: it makes CI a **real writer of `ref-main`**, confirming residual-risk #2 as fact rather than hypothesis |

---

## 3. The 9th probe — *does the underlying tool ALREADY do this?*

Asked before specifying **anything**, and answered by measurement, not by the vendor page.

**(a) Does git provide a usable client-side mutex spanning fetch→rebase→push?**
No. `git worktree lock` — the only "lock" git exposes here, and the one `cc-session.sh` already uses (`collect_locked_paths`, :95) — refuses `worktree remove`; it is a removal guard, not mutual exclusion. `--force-with-lease` is a *detector* of a moved ref, not a lock, and `land.sh` is forbidden from passing any force flag. Server-side ref-update locking exists but is exactly what produces the non-fast-forward refusal this wave is about. **Nothing to reuse.**

**(b) Does `scripts/lib/hook-block.sh` or `cc-session.sh` already provide one?**
No. `hook_block_install` takes a timestamped backup and is idempotent + order-independent, which is a *different* property from mutual exclusion (see Finding B). `cc-session.sh` has no mutex.

**(c) Would GitHub **merge queue** subsume CH3 — or CH1?**

| Probe | Result |
|---|---|
| `gh api graphql … repository{mergeQueue{id}}` | `null` — **not enabled** |
| `gh api …/branches/main/protection` | `404 Branch not protected` |
| `gh pr list --state merged --limit 5` | 5 merges total, **newest 2026-07-04** — PRs are the exception here, not the flow |

**Merge queue does NOT subsume either chapter, and adopting it would violate a standing LAW.** It serializes *PR merges into a protected branch*; this repo's LAW is auto-commit + auto-push where merges land as plain fast-forwards, and `check-push-safety.sh`'s own header records why a conventional main-protection hook is refused: *"a conventional main-protection hook would halt every wave."* Enabling merge queue means branch protection + PR-only landing for every wave — a strictly larger change than the one specced. And it is structurally incapable of the CH3 half: a merge queue cannot serialize an **SSH deploy to Hetzner**, an **npm publish**, or an **MCP-registry write**. `concurrency` is the only mechanism GitHub offers for those.

**Conclusion: build it. Both halves are genuinely unprovided.**

---

## 4. Two findings the spec's own Acceptance Criteria trip over

### Finding A — **three of this wave's ban-greps match their own docstrings.** *(fix inline; the law is already codified)*

CLAUDE.md `build-and-runtime.md` already records this exact class: *"Strip comments before grepping source for a banned construct. A gate asserting 'no XXXXXX template with a trailing suffix' false-positives on the script's own docblock quoting the historical buggy form — the explanatory prose is the most valuable line in the file and a naive grep demands its deletion."* It recurs **three times** in this wave as written:

| Gate | Written as | Why it self-trips |
|---|---|---|
| CH3 | `cip=$(grep -rc 'cancel-in-progress' .github/workflows/)` want **0** | CH3-R2 *instructs* carrying the reasoning **into each file's comment**, and that reasoning contains the literal `cancel-in-progress` three times |
| CH1 | `unsafe=$(grep -cE '\-\-force\|\-\-no-verify\|\-\-delete' scripts/land.sh)` want **0** | `land.sh`'s header must state *"never passes `--force`, `--force-with-lease`, `--no-verify` or `--delete`"* — the most valuable line in the file |
| CH1 | `copies=$(grep -rlE 'flock\|mkdir .*\.lock\|fcntl\.flock' scripts/ --include='*.sh' \| grep -v with-lock.sh)` want **0** | `land.sh` must document *which* primitive it delegates to, and R1a requires the **probe result** be recorded in a header |

**Resolution (fact-honest gate relaxation, logged in three places per the manual):** every one of these greps is run over a **comment-stripped** stream. The repo already owns the primitive — `scripts/lib/strip-comments.mjs`, used by `check-canaries-wired.mjs` for precisely this reason (*"a mention in a comment is not an invocation"*). Shell/YAML both use `#`, so the strip is `grep -vE '^[[:space:]]*#'` where the mjs helper does not apply. The relaxation is recorded in the gate's own comment, in the commit body, and in `status.md` under **documented relaxations** — never silently widened.

### Finding B — **two pre-existing registry rows already have ≥2 writers, so CH2's new rule turns the gate RED on arrival.**

CH2-R3 says: *a resource with ≥2 writers and `serialization.mechanism` absent ⇒ **FAIL***. CH2's AC says `--check` must be **green** at chapter end. Measured, those two requirements collide today:

| Row | `writers` | Serialization it actually has |
|---|---|---|
| `hook-pre-push` | **3** — `install_test_gate_hook.sh`, `install_session_drift_hook.sh`, `install_source_greppable_hook.sh` | *(none declared)* — but each write is a full read-modify-rewrite that is **idempotent, keyed on block name, canonically `LC_ALL=C`-ordered, and backed up before mutation**. Two simultaneous installs are a genuine last-writer-wins race; the residual is detected by `MISSING_BLOCK` and recoverable from the `.bak` |
| `ledger-hook-skip` | **3** — the three emitted hook blocks appending skip rows | Single-`printf` `O_APPEND` line writes, well under `PIPE_BUF` |

Neither is `none-single-writer` (that would be a false statement), and neither can be given the landing lock without editing the three installers — which **every chapter's `Must NOT write` firewall forbids**. So the spec's three-value `mechanism` enum is insufficient for the corpus it must validate. See **Q2**.

---

## 5. Identifier diff — Requirements vs Acceptance Criteria vs Verification-gate bash

### 5a. CH3 concurrency group keys

| Workflow | R2 table key | `queue` | Contended target *(measured)* | AC / gate coverage | Match |
|---|---|---|---|---|---|
| `deploy.yml` | `${{ github.workflow }}` | `max` | Hetzner host `204.168.185.24` (SSH) | `withgrp` == `total` | ✓ |
| `publish-npm.yml` | `${{ github.workflow }}-${{ github.ref }}` | `max` | npm registry (OIDC publish) | `perref` want 2 | ✓ |
| `release-knowledge.yml` | `${{ github.workflow }}-${{ github.ref }}` | `max` | GitHub Release assets for the tag | `perref` want 2 | ✓ |
| `monitoring-schedules.yml` | `${{ github.workflow }}` | `max` | **none — read-only lint** | `withgrp` | ⚠ Q3 |
| `postgres-lane.yml` | `${{ github.workflow }}-${{ github.ref }}` | `max` | **none — ephemeral runner service** | `withgrp` | ⚠ Q3 |
| `regenerate-landing.yml` | `${{ github.workflow }}` | `max` | landing surfaces **+ `refs/heads/main`** (pushes with a PAT) | `withgrp` | ✓ |

**No mismatch between R2 and AC on any key.** The `perref` gate greps only `publish-npm` + `release-knowledge` and wants 2 — correct even though `postgres-lane` also uses `github.ref`, because that grep names its two files explicitly.
**One gap:** the AC says *"**zero** occurrences of `cancel-in-progress` **repo-wide**"* while the gate greps only `.github/workflows/`. The measurable reading (the workflows dir) is the one implemented, comment-stripped per Finding A.

### 5b. CH2 registry identifiers

| Identifier | R-section | AC-section | Gate bash | Match |
|---|---|---|---|---|
| `ref-main` | R2: kind `contended-ref` | "`ref-main` … present" | `unser` list | ✓ |
| kind `ci-workflow` | R2: one row per workflow | "6 `ci-workflow` rows" | `reg` == `wf` (6) | ✓ |
| `serialization.key` | R1: non-empty | "non-empty `serialization.key`" | `(r.get('serialization') or {}).get('key')` | ✓ |
| `serialization.scope` | R1: **mandatory**, load-bearing | "an explicit `scope`" | **not checked by the gate bash** | ⚠ gate widened to assert `scope` too, else the mandate is prose |
| row count | 14 + 1 + 6 | "rows ≥ 21" | `rows` | ✓ = **21** |
| `mechanism` enum | R1: `landing-lock \| gha-concurrency \| none-single-writer` | "all 14 pre-existing rows still validate" | — | ⚠ **collide** — Finding B / **Q2** |

### 5c. CH1 token + exit-code identifiers

| Identifier | R-section | Reality / resolution |
|---|---|---|
| `LANDING_LOCK_VERDICT` | R1c: `ACQUIRED\|RECLAIMED\|TIMEOUT\|BYPASSED` | 4 tokens |
| exit codes | R1c: `0` = ACQUIRED/RECLAIMED · `3` = INDETERMINATE | ⚠ **R1c maps only 2 of 4 tokens.** R1d *mandates* TIMEOUT proceed without the lock ⇒ TIMEOUT **must** be `0` or `land.sh` aborts on its own fail-open. BYPASSED is report-only ⇒ `0`. **Full declared mapping: `0` = ACQUIRED\|RECLAIMED\|TIMEOUT\|BYPASSED · `3` = INDETERMINATE.** Compliant with the token law — exit 0 spans four meanings, and the **token** is what distinguishes them; callers gate on the token. INDETERMINATE stays reachable only for "could not evaluate" (unreadable lock dir, unparseable holder record) |
| new hook-block name | R3: unnamed; *"must sort **first**"* | ⚠ **Q1** — the constraint was derived from a stale 5-block list in which `push-safety` was first. The real first block is `dark-exports` |
| the block's script | R3 + Taxonomy: `scripts/` may add **`land.sh` + ONE hook-block install script** | ⇒ the block invokes **`scripts/lib/with-lock.sh --detect`**, a mode of the ONE lock primitive. This is also the correct single derivation: only the lock primitive can answer *"am I inside a held lock?"*. `scripts/` therefore adds exactly two files: `land.sh` + `install_lock_bypass_hook.sh` |

---

## 6. Constraints discovered that the spec does not mention

1. **`scripts/check-test-budget.mjs` — a test that SPAWNS A PROCESS must declare its own timeout, and the declaration must sit in the OPTIONS ARGUMENT** (between title and callback); a `timeout:` inside the body does not count. New/changed spawning blocks are **blocking today**. Every CH1-R4 concurrency test spawns processes ⇒ all of them carry `{ timeout: N }` in the options arg. *(Not wired into CI or pre-push — verified — but the contract is honoured regardless.)*
2. **`vitest.config.ts` anchors discovery at `tests/`** — a canary placed anywhere else is invisible to `vitest run`. Both new test files go under `tests/unit/`.
3. **Editing `.github/workflows/**` is NOT in `deploy.yml`'s `paths-ignore`** ⇒ CH3's commits **do** trigger a prod rebuild + restart. That is this repo's normal, correct behaviour, but it means CH3 is not literally inert on prod and `status.md` should say so.
4. **`check_system_map.sh` is path-scoped since 2026-06-26** (excludes `**/*.md`, `audits/**`, `docs/**`, `landing/**`, `tests/**`) and carries a reliable env hatch `ALGOVAULT_SKIP_MAP_CHECK=1`. `.github/workflows/**` and `ops/*.json` are **in scope** for the signal scan, so an `n-a` wave may still need the single-line `Last touched:` overwrite or the logged hatch.
5. **macOS `bash 3.2`** — no `mapfile`; `${arr[@]}` on an empty array is an unbound-variable error under `set -u`; BSD `mktemp` needs `XXXXXX` **terminal** (canonical form: `mktemp -d` + fixed names inside + `trap … EXIT`).
6. **A hook or CI wrapper that runs the suite must unset `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_QUARANTINE_PATH`.** `land.sh` spawns `git push`, which spawns the hook; the contention tests spawn git inside a test — both inherit this rule.
7. **`report()` in `check-shared-state.mjs` iterates a HARDCODED `order` array** of check names (`:317`). A new check name **not added to that array prints nothing** — a dark check at a green exit code. CH2 adds `SERIALIZATION` (and any sibling) to that array in the same edit.

---

## 7. Live evidence for the motivating symptom

The premise re-derivation is the cheapest possible HALT, so it was run first — and it **holds**, observed in-session rather than argued:

- `origin/main` was `7c29928` at 15:29 UTC when probing began and **`ea17177`** ~20 minutes later, moved by a *different* parallel session landing `OPS-MONITORING-DECLARATION-SYNC-W1 CH1`. A landing that had begun a ~2-minute gate inside that window would have been refused non-fast-forward.
- The primary checkout was **7 commits behind `origin/main`** at session start.
- **49 checkouts** share **one** `pre-push` file, resolved through an absolute `core.hooksPath` — `git config --show-origin --get core.hooksPath` → `file:.git/config → /Users/tank/code/crypto-quant-signal-mcp/.git/hooks`.
- **Nine** guarded blocks run on every push, the last of which is the full `vitest` suite.

The symptom is real and the mechanism is as specced.

---

## 8. Deferred verification

| Item | Why deferred | Where it closes |
|---|---|---|
| Live acceptance of `queue:` by the Actions validator | Requires pushing a scratch branch — a mutation, and it **is** CH3-R1's own gate | CH3-R1, before any rollout to the other five |
| Measured `BYPASSED` count | Needs an observation window after the detector ships | CH3-R6 `status.md` + the named flip criterion |
| Measured wall-clock of the real ~2-min gate | Not needed for the primary metric; **gate executions per landing** is the number, and its instrument is declared in CH1-R5 | CH1-R5 |
