# OPS-CI-MAIN-WRITER-HARDEN-W1 — Plan-Mode endpoint truth

**Probed:** 2026-08-21 · **Worktree:** `/Users/tank/code/.worktrees/crypto-quant-signal-mcp/ci-main-writer-harden-w1` @ `e218590` (== `origin/main`)
**Baseline suite:** `npx vitest run` → **453 files passed / 3 skipped · 6493 tests passed / 12 skipped · exit 0** (the one "Unhandled Error" is vitest's own `Timeout calling "onTaskUpdate"` reporter-RPC artifact, not a test failure).

---

## 1. Wave Objective, restated

Two writers can move `refs/heads/main`, and each is unsafe in a different way.

`OPS-SERIALIZE-LANDING-AND-DEPLOY-W1` made every **local** writer take a lock whose critical section contains the fetch, the rebase and the push. It could not reach a writer that does not run on this Mac, and it declared that gap on the `ref-main` row rather than hiding it. The gap is **one GitHub Actions job**, which checks out with a PAT, regenerates landing surfaces, and pushes to `main` with a bare `git push` — no fetch, no rebase, no retry. It cannot take the laptop's lock and no `concurrency` group can make it wait on one. So the invariant this wave completes is the *other half*: a writer that cannot take the lock must **tolerate losing the race** instead.

The same wave also *created* a second hazard on the release path. `land.sh` rebases and has no tag awareness; the release ritual creates the annotated tag **before** pushing. A release landed through `land.sh` would therefore have its commits rewritten out from under a tag that already exists — and `publish-npm.yml` checks out the **tag tree**, so npm would ship a tree that never landed. Today releases dodge this only by bypassing `land.sh` entirely, which re-opens the push race the last wave just retired. Both options are wrong; the wave adopts the third: **land, then re-read the landed SHA, then tag it, then push the tag alone.**

**One sentence:** every writer of `main` either takes the landing lock or survives losing the race, and a published tag can only ever point at a commit that actually landed.

---

## 2. Endpoint truth — claim / reality / resolution

Every row was probed with one concrete command. `git show origin/main:<path>` is used throughout so nothing is read from a stale working tree (the primary checkout is at `583e8ff`, **11 commits behind** `origin/main`).

### 2.1 The premise (all five of the spec's PRECISION claims)

| # | Claim | Command | Reality | Resolution |
|---|---|---|---|---|
| P1 | Exactly ONE workflow writes a git ref | `for f in $(git ls-tree -r --name-only origin/main .github/workflows/); do git show origin/main:$f \| grep -nE 'git (push\|commit\|tag)'; done` | 6 workflows; hits in **2** files. `publish-npm.yml:31` is `# \`npm version <bump>\` + \`git push --follow-tags\` → this workflow fires.` — a **comment**. `regenerate-landing.yml:115,116` are a real `git commit` + `git push`. | ✅ **CONFIRMED.** One writer. |
| P2 | It pushes with no rebase, no retry, no lease | `git show origin/main:.github/workflows/regenerate-landing.yml \| sed -n '104,119p'` | Line 116 is `git push` — bare, inside `if [[ -n "$(git status --porcelain)" ]]`. No `fetch`, no `rebase`, no loop. | ✅ **CONFIRMED.** |
| P3 | It writes `README.md` | same, line 108 | `git add landing/skills.html landing/index.html landing/llms.txt landing/llms-full.txt README.md` | ✅ **CONFIRMED.** |
| P4 | It authenticates as a PAT, deliberately | same, line 78 | `token: ${{ secrets.MCP_REPO_DISPATCH_TOKEN }}`, with a 9-line comment stating the reason: a `GITHUB_TOKEN` push does not trigger downstream workflows. | ✅ **CONFIRMED.** The two historical failures (runs `24950894981`, `24950929506`, 2026-04-26) are `remote: Permission to AlgoVaultLabs/crypto-quant-signal-mcp.git denied to github-actions[bot] … 403` — the incident that produced the PAT. |
| P5 | `land.sh` has zero tag handling | `git show origin/main:scripts/land.sh \| grep -niE 'tag'` | **1 hit, and it is a false positive**: line 28 `# percentage to quote` — the substring `tag` inside "percen**tag**e". No tag logic anywhere in 257 lines. | ✅ **CONFIRMED**, and see F2 — this false positive is exactly what makes the CH2 gate vacuous. |

### 2.2 R0a — the README write mode *(the spec's named HALT probe)*

| Claim | Command | Reality | Resolution |
|---|---|---|---|
| `build_landing.mjs` may rewrite `README.md` wholesale (⇒ HALT) or replace a delimited region (⇒ proceed) | **read:** `git show origin/main:scripts/build_landing.mjs` in `~/code/algovault-skills`; **measure:** materialise both repos at `origin/main` as the workflow lays them out, run `node algovault-skills/scripts/build_landing.mjs --target .`, diff | **DELIMITED REGION**, proven twice over. **(a) Code:** `replaceBlock(src, name, newInner)` slices between `<!-- BUILD:${name} -->` and `<!-- /BUILD:${name} -->`; on a missing marker it returns `{replaced:false}` and **writes nothing**. **(b) Measurement, run 1:** a real regeneration against `origin/main` left `README.md` **byte-identical** (`diff` exit 0, 301 lines in, 301 out). **(c) Measurement, run 2 — the decisive one:** appending a 13th entry to `integrations/manifest.json` and re-running changed **exactly one line (+1 / −0)**, at line 175, inside the `README_INTEGRATIONS_TABLE` region (markers at 163 / 179). Zero hunks outside it. `## What's new in v1.27.0` (line 257) intact. | ✅ **ONE defect, not two. R0a's HALT does NOT fire.** The v1.19.0 frozen-README class is **structurally unreachable** from the CI side: the regions end at line 224 and the release wave's `What's new` starts at 257, and the writer cannot address bytes outside its own markers. Proceed with R1 only. |

### 2.3 R0b — reproduce the collision

| Claim | Command | Reality | Resolution |
|---|---|---|---|
| With a commit on `main` the runner's checkout lacks, the bare `git push` fails non-ff and the run goes red | Throwaway bare remote + two clones; the runner clone executes the workflow's **verbatim** step script (lines 105–119) after a second clone lands a commit | `! [rejected] main -> main (fetch first)` · `error: failed to push some refs` · **step exit 1**. Remote `main` carries only the other writer's commit; `git log --oneline main \| grep -c 'build(landing)'` = **0** — the regeneration is **LOST**. | ✅ **REPRODUCED.** GHA `run:` steps use `shell: /usr/bin/bash -e {0}` (read from the live failure log of run `24950929506`), so a non-zero step is a red job — confirmed by that run's `##[error]Process completed with exit code 128`. **Live confirmation on a throwaway branch is proposed as Q4** so the *fix* can be shown resolved in the same environment, per the AC's "same scenario". |

### 2.4 R0c — is the failure loud?

| Claim | Command | Reality | Resolution |
|---|---|---|---|
| A red run surfaces somewhere the operator sees | `gh run list --workflow=regenerate-landing.yml --limit 30`; `monitoring-inventory.json` scan for GHA-watching rows; `grep -niE 'if: *failure\|telegram\|notify' .github/workflows/*` | **The failure is effectively SILENT.** (1) The workflow has fired **12 times in ~4 months** (last: 2026-07-21) — a red run has months of cover. (2) It has **no** `if: failure()` step. (3) `ops/monitoring/monitoring-inventory.json` has 69 artifact rows; **4** mention GHA. Only `xrepo-ci-conclusion-canary` polls run conclusions, and its `watches` array holds exactly **one** entry — `AlgoVaultLabs/algovault-skills \| marketplace-check.yml`. **`regenerate-landing.yml` is not watched by anything.** | ⚠️ **HONEST ANSWER: SILENT.** And the precedent is written on that canary's own row: *"algovault-skills' Marketplace Health Check ran RED for 40 consecutive runs (2026-06-27 to 2026-08-05) with nobody knowing."* This is that class, one repo over. **See the 9th probe (§3) — the primitive to close it already exists and takes one row, not a new canary. Scope question ⇒ Q3.** |

### 2.5 R0d — the live `concurrency` group

| Claim | Command | Reality | Resolution |
|---|---|---|---|
| Report the group verbatim; can two dispatches interleave? | `git show origin/main:.github/workflows/regenerate-landing.yml \| sed -n '49,51p'` | ```yaml\nconcurrency:\n  group: ${{ github.workflow }}\n  queue: max\n``` — **global** (not per-ref), `queue: max`, no `cancel-in-progress`, no job-level block. | ✅ **CORRECT AS-IS; CH1 changes nothing here.** Two dispatches **cannot** interleave — they serialise, and `queue: max` means the pending one is not cancelled. **This is load-bearing for R1's design:** the only writer this job can now collide with is a writer *outside* its own group, i.e. a local session. It can never race a second copy of itself, so a rebase-retry can never fight another regeneration for the same delimited regions. |

### 2.6 `land.sh` — current behaviour, and where the guard belongs

| Claim | Command | Reality | Resolution |
|---|---|---|---|
| The critical section is `acquire → fetch → rebase → push` | `sed -n '166,257p' scripts/land.sh` | Confirmed. `git rebase "$DEFAULT_REF"`, then `git push "$REMOTE" "HEAD:$TARGET"` backgrounded under `wait`. `--to <branch>` sets `REBASE=0`. Preconditions (detached HEAD, dirty tree) are checked **before** the lock. Tokens: `LAND_VERDICT=LANDED\|DIRTY\|CONFLICT\|GATE_BLOCKED\|EXHAUSTED\|INDETERMINATE` + `LAND_ATTEMPTS=`. | The tag guard belongs with the **preconditions, before the lock** — refusing without taking a mutex is strictly better. It adds one enum value and touches nothing else. |
| A rebase onto an **unmoved** upstream rewrites nothing | Probe A, throwaway repo | `before == after` — SHAs unchanged. | Informs the guard's predicate (see F5 / Q1). |
| A rebase onto a **moved** upstream orphans a tag | Probe B | Tag at `9137fb4`; `HEAD` after rebase `38cbb7e`; `git merge-base --is-ancestor <tag> HEAD` → **NO, ORPHANED**. | ✅ **The CH2 hazard is MEASURED, not theorised.** |
| The detection predicate works, including annotated tags | Probe C: `git for-each-ref --format='%(refname:short) %(objectname) %(*objectname)' refs/tags/` ∩ `git rev-list $DEFAULT_REF..HEAD` | `DETECTED tag=v9.9.9 -> 9137fb4…`. Annotated tag `objectname=7557409…` (the tag object) vs `*objectname=9137fb4…` (the peeled commit) — **peeling is required**; matching on `objectname` alone would never fire for an annotated tag, which is the only kind the release ritual creates. | ✅ Predicate validated before it is written. |
| The corrected 4-step ordering yields `vX.Y.Z^{} == origin/main` | Probe D: real `land.sh` + a concurrent writer forcing a rebase, then tag the landed SHA and push the tag alone | `LAND_VERDICT=LANDED`, `LAND_ATTEMPTS=1`, rebased **YES** (`d506a318` → `ad6b7069`); tag push rc=0; `v1.0.0^{}` = `ad6b7069…` = `origin/main`. **EQUAL ✓** | ✅ **CH2's end-to-end AC already passes in probe form.** A tag push is a distinct namespace and cannot be refused non-fast-forward. |

### 2.7 Which `.test.ts` files the gate actually executes

| Claim | Command | Reality | Resolution |
|---|---|---|---|
| A new `tests/unit/*.test.ts` will be **observed running**, not merely present | `vitest.config.ts` header + baseline run | `include` is **anchored at `tests/`** (OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1 — the unanchored default collected 1480 stale duplicates from nested worktrees). The 24 `.test.mjs` node:test canaries are **excluded** from vitest. Baseline: **453 files** executed. | ✅ A `tests/unit/*.test.ts` runs. **Build Rule 5 respected: every new test here is `.test.ts`.** |
| vitest runs in CI | `grep -nE 'vitest' .github/workflows/*` | **YES, two lanes**: `deploy.yml:124` (full suite, pre-deploy, verdict via `classify-suite-verdict.mjs`) and `postgres-lane.yml:147` (`npx vitest run`, on `branches: ['**']`). | ⚠️ **Load-bearing for R4** — see F4. A test that hard-fails when the Obsidian vault is absent would red **both** CI lanes on every push. |
| A spawning test must own its budget | `sed -n '1,40p' scripts/check-test-budget.mjs` | New/changed spawning blocks are **BLOCKING today**; the backlog is shrink-only; `{ timeout: N }` must sit in the **OPTIONS argument**. | Both new test files spawn `git` ⇒ every block declares an explicit timeout. |

### 2.8 Map Anchor — the full `system-map.md` row enumeration

The spec forbids assuming `NONE`. Every row naming `README.md`, `regenerate-landing.yml`, the skills→landing render edge, or the npm publish target, with a per-row verdict:

| system-map.md | Row | Names | Does this wave mutate the edge? |
|---|---|---|---|
| L269–277 | `landing/` ASCII node | `↑ signal-MCP /api/* (live JS proxy) · algovault-skills integrations/manifest.json` | **NO.** Producer, consumer and trigger unchanged; only the robustness of the push changes. |
| L313–320 | `ops/cron/snapshot-landing-daily.sh` | "re-bakes `landing/*.html` + `README.md` literals from the live SoT" | **NO.** A different, host-side producer of `README.md`, untouched by this wave. |
| L356 | `crypto-quant-signal-mcp` §3 component row | the repo | **NO.** |
| L363 | `algovault-skills` §3 component row | "`dispatch-landing-rebuild.yml` fires only on `skills/manifest.json` + `integrations/manifest.json`" | **NO.** That is the **dispatcher**, in the sibling repo, explicitly out of scope. The receiving workflow is not named anywhere in `system-map.md`. |
| L388 | `npm registry` §4 integration row | "`.github/workflows/publish-npm.yml` (fires on `v*.*.*` tag) authenticates the auto-`npm publish` via OIDC" | **NO.** CH2 changes the operator's **ordering** of tag creation, not the edge: same trigger (`v*.*.*`), same consumer, same auth. What changes is *which commit the tag points at* — and pointing it at the landed commit is what every reader of this row already assumed. |
| L416 | QuantDinger | `algovault-integrations.examples/quantdinger/README.md` | **NO.** A different repo's README. |
| L458 | TODO comment | `~/code/algovault-mcp/README.md` | **NO.** |
| — | `regenerate-landing.yml` | — | **NOT PRESENT in system-map.md at all** (`grep -nE 'regenerate-landing' system-map.md` → 0 hits). |
| — | `land.sh` / `with-lock.sh` / the landing lock | — | **NOT PRESENT** (0 hits). Consistent with the previous wave, which recorded `system-map.md updated: n-a`. |

**Verdict: `NONE — internal change only`**, with the enumeration above as the evidence the spec demanded. No `Last touched:` overwrite, no map-row edit, and — per system-map.md §5 — **no prepended dated row**, ever.

---

## 3. The 9th probe — does the underlying tool already do this?

Asked in both places this wave would otherwise hand-roll something. It changes one answer.

### 3.1 The rebase-retry loop (R1) — **no maintained primitive fits. Build it.**

| Candidate | Probe | Finding |
|---|---|---|
| `actions/checkout` | already in the workflow | Checkout only. No push semantics whatsoever. Not a candidate. |
| **`stefanzweifel/git-auto-commit-action`** (2.6k ★, v7) — *the* maintained option | read its documentation | It **explicitly declines this responsibility**, verbatim: *"No support for `git rebase` or `git merge`."* and *"No `git pull` when the repository is out of date with remote."* and *"**You** are responsible for keeping the repository up to date in your Workflow runs."* |
| `Artur-Davtyan/git-rebase-push` | read its documentation | Does rebase-retry — but on conflict it *"runs your `yq_command` to re-apply changes"*, i.e. **auto-resolves**. R1 forbids exactly that, and `README.md` is not purely derived. Also **0 ★, 1 contributor, v1.0.1**. |
| GitHub **merge queue** | GitHub docs | Scoped to **pull requests**: *"a user with write access can add the pull request to the queue."* This job pushes directly and never opens a PR, and the Taxonomy forbids changing its trigger. Does not apply. |

**Resolution: hand-roll.** The best-maintained action documents the gap as out of scope; the only one that closes it does so by auto-resolving, which is the defect. There is a second, decisive reason: this job holds `MCP_REPO_DISPATCH_TOKEN` with `contents: write`, and adding a 0★ third-party action to that job hands a stranger the repo's write credential to save ~15 lines of shell. That trade is not worth making.

### 3.2 Alerting on a red run (R0c/R3) — **the primitive EXISTS, and this changes the answer**

`ops/cron/xrepo-ci-conclusion-canary.sh` already polls GitHub Actions conclusions from the monitoring host, on a declared watch list, with a verdict token and two registered alert IDs:

```
# DECLARED watch list. Adding a workflow is a row here, not a code change.
# Format: <owner/repo>|<workflow-file>|<human label>
WATCHED="${XREPO_CI_WATCHED-AlgoVaultLabs/algovault-skills|marketplace-check.yml|Marketplace Health Check}"
```

Daily `41 9 * * *`, `XREPO_CI_VERDICT=`, alert IDs `xrepo_ci_red` / `xrepo_ci_dark`, unauthenticated (the repo is public — no token needed), and it already vacuity-guards an emptied list. **`AlgoVaultLabs/crypto-quant-signal-mcp|regenerate-landing.yml|Landing Regeneration` is one row.** Building a second CI-conclusion canary would be the duplication this manual keeps deleting. **But it is a scope widening ⇒ Q3.**

---

## 4. Identifier diff — Requirements vs Acceptance Criteria vs Verification Gate

| Identifier | R-section | AC-section | Verification Gate | Verdict |
|---|---|---|---|---|
| `algovault-skills/scripts/build_landing.mjs` | CH1 R0a | "R0a answered with measured evidence" | — | ✅ path live, probed |
| bare `git push` | CH1 R1 | "No bare `git push` … (grep-proven)" | `grep -nE '^\s*git push\s*$'` | ✅ `\s` works on this macOS grep (measured: 1 hit) |
| `--force` / `--force-with-lease` | CH1 R1 (on the push) | "no `--force`, no `--force-with-lease` **anywhere in `.github/workflows/`**" | `force=… (want 0)` | ✖ **F1 — UNSATISFIABLE** |
| canary file name | CH1 R2: "`tests/unit/*.test.ts`" | "Canary enumerates from disk … observed running" | `grep -c 'ci-main-writer\|workflow-git-write'` | ⚠️ name pinned only by the gate ⇒ `tests/unit/ci-main-writer.test.ts` |
| `ref-main` `_scope_reason` | CH1 R3 | "narrowed, not emptied" | `python3 … x['id']=='ref-main'` | ✅ key `id` correct; row exists; 1 of 22 |
| `land.sh` tag guard | CH2 R2 | "refuses … proven adversarially, and proven NOT to fire on an ordinary tagless landing" | `guard=$(grep -cE 'tag' scripts/land.sh)` want >0 | ✖ **F2 — VACUOUS today** |
| `land.sh --self-test` | *absent from every R-step* | *absent from every AC* | `bash scripts/land.sh --self-test` | ✖ **F3 — FICTIONAL** |
| `CLAUDE.md`, `Prompt/` | CH2 R3 | "documented in **both**" | `grep -rn 'follow-tags' CLAUDE.md Prompt/` after `cd` to the repo | ✖ **F4 — neither path exists in the repo** |
| ordering-gate file name | CH2 R4 | "observed under `vitest run`" | `grep -c 'tag-order\|release-order'` | ⚠️ name pinned only by the gate ⇒ `tests/unit/release-tag-order.test.ts` |
| `git rev-parse vX.Y.Z^{}` == `git rev-parse origin/main` | CH2 R5 | AC | — | ✅ **measured TRUE** (probe D) |
| verdict tokens "byte-identical except the added guard" | CH2 R2 | AC | — | ✅ one enum value added; no other line of the protocol touched |

---

## 5. Drift findings

**Fictional primitives: 2 (F3, F4). Threshold for HALT is ≥3 — so: fix inline and flag.** Neither is load-bearing for the wave's design; both are defects in the *gate*, and both would have let a chapter print GREEN having verified nothing.

### F1 — CH1's `--force` predicate is UNSATISFIABLE *(would force a false RED, or a scope violation to clear)*
`force(origin/main) = 3`, and the gate demands `0`. All three hits are legitimate and untouchable:
- `deploy.yml:451` — a **comment** quoting CLAUDE.md's own rule (*"Never reset --hard / push --force / branch -D without auth"*)
- `deploy.yml:792` — a **comment** explaining `--force-recreate`
- `deploy.yml:799` — `docker compose up -d --build --force-recreate` — a **docker** flag with no relation to git

`deploy.yml` is outside this wave's Scope, so the gate as written can only be satisfied by lying or by a firewall breach.
**Fix:** the predicate becomes what R1 actually says — *no `git push` line carries `--force` or `--force-with-lease`* — evaluated **comment-immune**, on `git push` lines only. Same class as the previous wave's `cancel-in-progress` comment-immunity requirement. The gate's *stated intent* is preserved exactly; only its instrument is corrected.

### F2 — CH2's tag-guard predicate is VACUOUS *(passes today, with zero work done)*
`grep -cE 'tag' scripts/land.sh` → **1**, today, on `origin/main`, from the substring `tag` inside "percen**tag**e" at line 28. The gate wants `>0`. **It already passes.**
**Fix:** assert the guard **behaviourally**, not lexically — run `land.sh` against a fixture with a tag in the rebase range and require `LAND_VERDICT=TAGGED` + a non-zero exit, and against a tagless fixture and require it does **not** fire. That is the two-way proof the AC asks for, and it cannot be satisfied by a comment.

### F3 — `bash scripts/land.sh --self-test` is a FICTIONAL primitive
`land.sh`'s arg parser handles `--remote`, `--to`, `--dry-run`, `-h|--help`; everything else hits `*) … LAND_VERDICT=INDETERMINATE; exit 3`. There is no self-test mode, and none is required by any R-step or AC.
**Fix:** drop it from the gate. `land.sh`'s falsifiability is already owned by `tests/unit/land-sh.test.ts` (9 cases, real remotes), which the suite line of the same gate covers. Replaced with `bash scripts/land.sh --dry-run` — a real mode, which exercises the guard's own precondition path and emits a real token.

### F4 — CH2's doc predicate reads two paths that DO NOT EXIST at the cited location
The gate does `cd /Users/tank/code/crypto-quant-signal-mcp` and then `grep -rn 'follow-tags' CLAUDE.md Prompt/ 2>/dev/null`. **The repo contains neither.** Both live in the Obsidian vault. `2>/dev/null` swallows both "No such file" errors, so `ft=0` and **the gate passes vacuously**.
Two further facts the corrected predicate must respect:
1. **`Prompt/` holds ~20 HISTORICAL wave prompts carrying `--follow-tags` legitimately** (`npm-publish-v1.18.0-w1.md`, `RELEASE-v1.21.0-W1.md`, …). Per the manual's 3-class vault triage, HISTORICAL files **must NOT** be rewritten. A predicate over all of `Prompt/` can therefore never reach 0 honestly, and would push a future session toward rewriting history to make a gate green.
2. **The LIVE surfaces are exactly two**: vault `CLAUDE.md` line 159 (`## Release cadence`), and `Prompt/release-wave-daily-template.md` R4 (lines 80–81).
**Fix:** the gate resolves the vault via the repo's **existing** resolver rather than a second hardcoded path — `resolveCorpus()` in `scripts/check-claudemd-claims.mjs`, which already owns `DEFAULT_CORPUS = ~/My Drive/Obsidian Vault/AlgoVault MCP/CLAUDE.md`, an `ALGOVAULT_CLAUDEMD_CORPUS` override and a `vaultDir` — and scopes to the two LIVE surfaces by name. See Q2 for the CI-absence half.

### F5 — a design question the spec leaves open: how WIDE should the tag guard be?
R2 says "if any local tag points at a commit inside the range `land.sh` is about to rebase". Probe A measured that a rebase onto an **unmoved** upstream rewrites nothing, so a strictly-literal reading would only refuse when the remote has already moved. **That predicate races itself**: `land.sh` fetches *inside* the lock, so the remote can move between the guard and the rebase, and the narrow guard would wave through the exact case it exists to catch. ⇒ **Q1.**

### F6 — `hook-pre-push` / registry, pre-existing
`ops/shared-worktree-state.json` carries 22 rows and `ref-main` is intact and well-formed. `regenerate-landing.yml` already has a `ci-workflow-regenerate-landing` row (added last wave), so R2's "every workflow that writes a git ref is registered" is **already enforced in both directions** by `check-shared-state.mjs`'s `CI_SERIALIZATION` check. The new canary must therefore assert the **git-write** properties and not re-litigate registration — that file's own header states the ownership split explicitly, and duplicating it is what the manual calls the second copy nobody watches.

---

## 6. What CH1 and CH2 will do (design, for ratification)

**CH1 R1 — chosen strategy: rebase the commit, do not re-run the build.** R1 permits either and requires the choice be stated in a step comment. Rationale, in the comment: the preceding step does `rm -rf algovault-skills`, so re-running the build inside a retry loop would require re-checking-out the sibling repo per attempt; and the regenerated bytes are a **pure function of the two manifests**, which live in the sibling repo and cannot change during the run. Rebasing is therefore equivalent and simpler. It is also safe by construction: this workflow's own `concurrency` group is global, so no second regeneration can be touching the same delimited regions, and any other writer's edits to `README.md` are outside the markers. A genuine conflict aborts and fails the run loudly, exactly as R1 requires.

**CH1 R1 — bound: 3 attempts**, matching `land.sh`'s `MAX_ATTEMPTS` so both sides of the residual behave identically, with jittered backoff and a re-`fetch` per attempt. Exhaustion prints the **same diagnosis wording** `land.sh` prints, as R1 asks.

**CH2 R2 — token: `LAND_VERDICT=TAGGED`, exit 1.** One value added to the existing enum on the existing line — the existing channel, not a second one. Placed with the preconditions, before the lock is taken.

---

## 7. Deferred verification

| Item | Why deferred | Owner |
|---|---|---|
| Live GHA proof that the *fixed* workflow survives the collision | Needs a throwaway branch + 2 dispatched runs | **Q4** — this wave, on authorization |
| `regenerate-landing.yml` added to the xrepo CI-conclusion watch list | Touches `ops/cron/` + `monitoring-inventory.json` + a host install — outside the declared Taxonomy | **Q3** — this wave if authorized, else `OPS-XREPO-CI-WATCH-EXTEND-W{NEXT}` |
| `landing/index.html#USE_CASES_CARDS` and `landing/integrations.html#INTEGRATIONS_INDEX_GRID` report `placeholder not found` on every regeneration | Pre-existing, unrelated to this wave, and `landing/**` is inside CH1's `Must NOT write` firewall | `OPS-LANDING-BUILD-MARKER-RESTORE-W{NEXT}` |
| 4 pre-existing shared-hook blocks still lack registry rows | Inherited from the previous wave; not retrofitted | `OPS-HOOK-BLOCK-REGISTRY-BACKFILL-W{NEXT}` |
