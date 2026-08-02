# OPS-SHARED-WORKTREE-STATE-REGISTRY-W1 — CH1 census (endpoint truth)

**Chapter:** CH1 — census of shared-across-worktree state. **READ-ONLY** apart from this file.
**Wave shape after architect ratification (A1):** 4 chapters — CH1 · CH2 · CH3 · CH5. **CH4 deleted.**
Spec chapter labels preserved so `WAVE1_CH<N>_HALT` strings stay cross-referenceable.

**Plan-Mode base:** `a0046e7` (2026-08-02 ~08:25 UTC).
**CH1 re-confirmation base:** `657a459` (worktree `cqsm-wt-shared-state`, branch
`ops/shared-worktree-state-registry-w1`, created off the resolved `origin/main` after an explicit
`git fetch`).
**`system-map.md` updated: n-a** — see P7.

> **`origin/main` moved THREE times during this wave's Plan Mode**: `a0046e7` → `d8d8b046` →
> `657a459`. That is not incidental noise; it is the concurrency this wave exists to make safe,
> observed live. Every count below is therefore reported **at both bases**, and the drift between
> them is attributed rather than averaged away.

---

## P1 — Live worktrees and the shared common dir

| Item | Measured |
|---|---|
| `git rev-parse --git-common-dir` (absolute) | `/Users/tank/code/crypto-quant-signal-mcp/.git` |
| Checkouts governed by that common dir | **74** at `a0046e7` (1 primary + 73 linked) → **75** at `657a459` (+1 = this wave's own worktree) |
| `core.hooksPath` | **SET** — `--local`, value `/Users/tank/code/crypto-quant-signal-mcp/.git/hooks`; `git config --show-origin` → `file:.git/config`. **NOT unset.** |
| `$GIT_COMMON_DIR/hooks/pre-push` | 1319 B, mtime `Aug 2 00:04` **local (UTC+8)** = `2026-08-01 16:04 UTC` |
| `$GIT_COMMON_DIR/hooks/pre-commit` | 93 B, mtime `Jun 18 21:41` local |
| `.bak` copies of either hook | **NONE** — the timestamped-backup convention that governs host monitoring artefacts has never been applied to these hooks |
| `$GIT_COMMON_DIR` ledgers | `algovault-test-gate-failopen.log` — exists, **0 bytes**, mtime `Jul 30 15:03` (never written) |

**Blast radius of incident A is 74 (now 75) checkouts.**

> **Timestamp correction (minor, recorded so it is not propagated).** The spec and `status.md`
> both date incident A `2026-08-02 00:04Z`. The host is **UTC+8**, and the hook's mtime is
> `Aug 2 00:04` *local* — i.e. `2026-08-01 16:04 UTC`. The local wall-clock reading was stamped
> with a `Z`. Same class as the recorded Hetzner clock-read artifact. The *ordering* of events is
> unaffected, so no conclusion in this wave changes; CH5 uses the local-time form with its offset.

---

## P2 — The actual shared hooks

### `pre-push` — 3 marker blocks, one dialect, composable

| # | Sentinel (verbatim) | Invokes | Existence guard? | Override lever |
|---|---|---|---|---|
| 1 | `# >>> algovault test-gate (OPS-VITEST-SUITE-REPAIR-W1) >>>` | `"$(git rev-parse --show-toplevel)/scripts/check_test_baseline.sh" \|\| exit 1` | 🛑 **No** | `ALGOVAULT_TEST_GATE=warn` |
| 2 | `# >>> algovault session-drift (OPS-CC-DRIFT-DETECTOR-W1) >>>` | `node ".../scripts/check-session-drift.mjs" \|\| exit 1` | 🛑 **No** | `ALGOVAULT_SESSION_DRIFT=warn` |
| 3 | `# >>> algovault source-greppable (OPS-GREPPABLE-SOURCE-GUARD-W1) >>>` | `node ".../scripts/check-source-greppable.mjs" --check \|\| exit 1` | 🛑 **No** | none by design |

Close sentinels are `# <<< algovault <name> <<<`. All three resolve the script at hook-run time
via `git rev-parse --show-toplevel`, which returns **the pushing worktree's** root — the mechanism
by which a per-worktree absence becomes a hard block.

**The sentinel literal `ALGOVAULT-HOOK-BLOCK-BEGIN` cited in the spec's CH2 gate exists nowhere in
the repo** (`rg` → 0 hits). Per **A3** the live shape is kept and the helper adopts it verbatim.

### `pre-commit` — **0 marker blocks**, not 1

```sh
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/check_system_map.sh" "$@"
```

A whole-file `exec` with argument pass-through, **not** a sentinelled block. The spec's
"1 in pre-commit" is a count of blocks that do not exist. `"$@"` must survive CH2's retrofit.

---

## P3 — Reachability: which blocks break a fresh/older worktree TODAY?

### P3a — from the remote default (`origin/main`, resolved via `git symbolic-ref`, never hardcoded)

| Script | `a0046e7` | `657a459` |
|---|---|---|
| `scripts/check_test_baseline.sh` | OK | OK |
| `scripts/check-session-drift.mjs` | OK | OK |
| `scripts/check-source-greppable.mjs` | OK | OK |
| `scripts/check_system_map.sh` | OK | OK |

**4/4 reachable from origin at both bases.** By the origin-only test, there is no live
incident-A condition — which is precisely why the origin-only test is insufficient.

### P3b — per live worktree (the half that actually bites)

| Script | MISS @ `a0046e7` (of 74) | MISS @ `657a459` (of 75) | Backstopped elsewhere? |
|---|---|---|---|
| `check_test_baseline.sh` | 10 | 10 | partial — also in `deploy.yml` |
| `check-session-drift.mjs` | 55 | 55 | 🛑 **NO** — inherently local, CI cannot run it |
| `check-source-greppable.mjs` | **70** | **69** | ✅ yes — `deploy.yml` + `prepublishOnly` |
| `check_system_map.sh` | **0** | **0** | n/a — present everywhere |
| **Union: cannot push at all** | **70 / 74 (94.6 %)** | **69 / 75 (92.0 %)** | — |

The `70 → 69` drift is **one worktree rebasing onto a newer `main` during this session**, not
measurement error. Recorded rather than smoothed: it is the same concurrency as the three
`origin/main` moves.

### 🛑 Incident A is LIVE — not "since cleared"

Both the spec's table and `status.md:64` describe incident A as a `~1h` outage "since cleared".
**Falsified.** Reproduced read-only in `cqsm-wt-mon-inventory` by invoking the hook's own
commands:

```
Error: Cannot find module '/Users/tank/code/cqsm-wt-mon-inventory/scripts/check-source-greppable.mjs'
  code: 'MODULE_NOT_FOUND'                                                          → exit 1
Error: Cannot find module '/Users/tank/code/cqsm-wt-mon-inventory/scripts/check-session-drift.mjs'
  code: 'MODULE_NOT_FOUND'                                                          → exit 1
```

It cleared **only for the installing session's own siblings** — the worktrees that subsequently
rebased onto the `main` carrying the script. Pushing the script to `origin` does not retroactively
place it in a working tree that already exists. **Per R-e this supersedes the specced
scratch-worktree reproduction and completes incident A's PRE-fix half.**

**Residual exposure is NOT uniform (A2 rider 1)** — the number that matters is the second row:

| Gate | Skipped-at-pre-push cost |
|---|---|
| `check-source-greppable.mjs` | **BACKSTOPPED** — also runs in `deploy.yml` + `prepublishOnly`. Loss is defence-in-depth only. |
| `check-session-drift.mjs` | 🛑 **NOT BACKSTOPPED.** It reasons about worktrees, so a 1-worktree CI runner cannot run it. `stale_base` protection is **genuinely absent** for 55 checkouts. |
| `check_system_map.sh` | Unaffected — present 74/74. |

---

## P4 — Shared non-git state

| Resource | Measured | Notes |
|---|---|---|
| `~/.crypto-quant-signal/performance.db` | **30,638,080 B**, mtime today; `-shm` 32 KB + `-wal` 4.17 MB present ⇒ **live WAL mode** | Plus `performance.db.stale-bak` (23.8 MB, Jul 4) |
| Path resolver | `src/lib/performance-db.ts:36` — `process.env.PERFORMANCE_DB_PATH \|\| path.join(os.homedir(), '.crypto-quant-signal', 'performance.db')` | **The isolation lever already exists.** No new mechanism needed — only a declared contract. |
| Prior art for isolation | `tests/analytics-external-only.test.ts` defines `ISOLATED_DB_PATH`; `vitest.config.ts:35` documents the shared-DB hazard in prose | Precedent to point the registry row at |
| Measured harm | `audits/OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1-root-cause.md`: **5/5** failures with a concurrent writer vs **1/15** serial | Row 3 of the spec's incident table, confirmed at source |
| `$GIT_COMMON_DIR` ledgers | `algovault-test-gate-failopen.log` (0 B) | CH2's skip ledger reuses this convention, not a second dialect |
| Shared `node_modules` symlinks | Not re-measured — CH3's `CONCURRENT_WRITER` row covers the DB; the symlink claim is `check-session-drift.mjs`'s domain and its Mode-2 tracked-paths-only fix already retired it | Out of scope by A1/A2 |

---

## P5 — The deploy-checkout question — **CH4 DELETED (A1)**

Measured for both candidate repos, then superseded:

| Repo | Scripted laptop→prod rsync? | Ancestry assert? |
|---|---|---|
| `algovault-bot` | 🛑 **None.** `rg rsync` over the whole repo returns **one comment** — its own `hooks/pre-push:4`: *"`algovault-bot` has NO GHA deploy (deploy is manual ssh+rsync+systemctl)"*. No `scripts/deploy*`. | None |
| `autonomous-optimizer` | Only `scripts/burst_sweep.sh` — **permanent-host → burst-host**, not the incident-B vector. Plus an unscripted `paper-carry-tracker` package rsync (mapped at `system-map.md:281`). | None (`rg 'merge-base\|is-ancestor\|symbolic-ref\|rev-parse HEAD'` over both repos' `scripts/`+`deploy/` → 0 hits) |

**Resolution (A1): do NOT build `ops/deploy/assert-deploy-ref.sh`.** `OPS-BOT-DEPLOY-PROVENANCE-W1`
already shipped a strictly stronger primitive — it never deploys a working tree at all, which
dominates asserting on one. Verified live against `origin/main`:

| Artefact | Verified |
|---|---|
| merge commit | `a433f207efc5268e1eddd66e853d80586a724e9b`, `2026-08-02T08:48:29Z` |
| `ops/scripts/host-deploy.sh` | present, **13,828 B** — resolves a ref, refuses a non-ancestor of `origin/main`, materialises `git archive <sha>` into a staging dir with per-entry atomic swap, stamps the deployed SHA |
| `ops/cron/bot-deploy-parity.sh` | present, **13,688 B** — daily L2 detect against a lockfile written **from the commit** |

My Q1 measurement was correct but scoped to the wrong repo: the primitive takes `--repo` as an
argument, so it lives in neither consumer. **What survives of CH4 = 2 registry rows in CH3.**
Remaining deploy work is already named and **not ours**: `OPS-HOST-DEPLOY-PROVENANCE-ROLLOUT-W{NEXT}`.

---

## P6 — Every symbol this spec names, re-derived

**0 named symbols absent.** Build Rule 7's `≥3 absent = HALT` does **not** trip.

| Symbol | Reachable from `origin/main` |
|---|---|
| `scripts/install_system_map_hook.sh` · `install_test_gate_hook.sh` · `install_session_drift_hook.sh` · `install_source_greppable_hook.sh` | OK ×4 |
| `scripts/check_test_baseline.sh` · `check-session-drift.mjs` · `check-source-greppable.mjs` · `check_system_map.sh` | OK ×4 |
| `scripts/cc-session.sh` — `cmd_new` · `cmd_list` · `list_row` · `cmd_clean` · `clean_consider` · `default_base_ref` · `fetch_or_warn` | OK |
| `scripts/check-canaries-wired.mjs` · `ops/session-drift-config.json` · `ops/monitoring/monitoring-inventory.json` · `package.json` `prepublishOnly` | OK |
| `scripts/lib/hook-block.sh` · `ops/shared-worktree-state.json` · `scripts/check-shared-state.mjs` | correctly ABSENT — this wave creates them |
| `ops/deploy/assert-deploy-ref.sh` | ABSENT and **stays absent** per A1 |

`check-canaries-wired.mjs` live count: **29** at the Plan-Mode base `a0046e7`.

> **Corrected during CH3 (same day).** By `657a459` the live count was **31** — `origin/main` gained
> two committed gate scripts while this wave was in flight. CH3 therefore asserts **31 → 32**, and
> the point stands rather than being undermined: the spec's own rule is to assert the **live** count
> `+1` and never a literal from any document, and this audit's own literal went stale within hours.
> Note also that `check-canaries-wired.mjs` enumerates **tracked** files, so a new gate is invisible
> to it until committed — the `+1` can only be verified after the commit, never before.

### 🛑 `install_system_map_hook.sh` is worktree-broken AND truncating

| Installer | Hooks dir resolution | Composable? |
|---|---|---|
| `install_system_map_hook.sh` | 🛑 `$REPO_ROOT/.git/hooks` | 🛑 **No** — `printf '%s' "$ONELINER" > "$HOOK_PATH"` truncates the whole file |
| `install_test_gate_hook.sh` | ✅ `$(cd "$(git rev-parse --git-common-dir)" && pwd)` | ✅ appends a guarded block |
| `install_session_drift_hook.sh` | ✅ same | ✅ same |
| `install_source_greppable_hook.sh` | ✅ same | ✅ same |

In a linked worktree `.git` is a **file**, not a directory — verified: `file …/.git` →
`ASCII text`; `ls …/.git/hooks` → **`Not a directory`**. So the system-map installer can only
ever run from the primary checkout.

`install_test_gate_hook.sh`'s own header states *"standard `.git/hooks` path, **NO custom
core.hooksPath**"* — **false**, per P1.

### R-b — the broken-installer / green-result paradox, RECONCILED

The gate is present **74/74** despite an installer that cannot run in 73 of them. An unexplained
green is how dark guards survive, so this is resolved *before* CH2 touches it. Three measured
facts close it, and **no dark guard is involved**:

1. The hook file was written **`Jun 18 21:41` from the primary checkout**, where
   `$REPO_ROOT/.git/hooks` *is* a real directory. The installer never needed to run elsewhere.
2. `core.hooksPath` is `--local` and **absolute** (P1), so all 74 checkouts resolve to that one
   file regardless of `$GIT_COMMON_DIR`. **R-a: this makes the blast radius worse, not better** —
   CLAUDE.md's "install once, governs every worktree" is right for the wrong reason.
3. `scripts/check_system_map.sh` was added in `d69fe00` (SYSTEM-MAP-ENFORCEMENT-W1 / C2), old
   enough to be present on every branch → 74/74.

The installer's defect is therefore **latent, not active**: it fires the first time anyone runs it
from a worktree. CH2 fixes it and must preserve `exec … "$@"`.

---

## P7 — `system-map.md` edge check → **NONE**

`rg -n 'pre-push|pre-commit|git.hook|install_.*hook|cc-session|worktree|rsync|GIT_COMMON' system-map.md`
returns exactly two hits, **neither a producer→consumer row**:

- `:281` — webhook prose (false positive on the substring "hook"). It *does* carry a real
  `autonomous-optimizer` rsync edge (`pkg = rsync'd … src/research/carry`), but **CH4 is deleted**,
  so nothing in this wave touches it.
- `:367` — a checklist *instruction* about the pre-commit gate, in the file's guidance section.

**No mapped edge, role, or repo changes. `system-map.md updated: n-a`.**

---

## Corrected premises carried into CH2–CH5

| # | Spec / SoT claim | Reality | Where corrected |
|---|---|---|---|
| 1 | `core.hooksPath UNSET (expected)`; CLAUDE.md *"no custom `core.hooksPath`"*; installer header repeating it | **SET**, `--local`, absolute | CH5 (CLAUDE.md, dated note, history kept) + CH2 (installer header) |
| 2 | Incident A *"since cleared"*, `~1h` | **LIVE** — 69–70 of 74–75 checkouts cannot push | CH5 `status.md`; drives CH2's priority (rider 3) |
| 3 | `pre-commit` has 1 marker block; gate greps `ALGOVAULT-HOOK-BLOCK-BEGIN` | **0** blocks; that sentinel exists nowhere | CH2 (live sentinel per A3; assert vs measured counts) |
| 4 | CH4 wires an assert into each repo's rsync path | No such scripted path exists in either repo; a stronger primitive already shipped | **CH4 deleted (A1)**; 2 registry rows in CH3 |
| 5 | Wire the live `--check` into `deploy.yml` | Vacuous there (1 worktree, no hooks). Repo precedent: `check-session-drift.mjs` is wired at `deploy.yml:269` as `--self-test` **only** | CH3 (R-c) |
| 6 | Incident A dated `00:04Z` | `Aug 2 00:04` **local (UTC+8)** = `2026-08-01 16:04 UTC` | CH5 `status.md` |

### ⚠️ New firewall conflict for CH5 (surfaced during CH1, not in the spec)

`OPS-CLAUDEMD-CLAIM-VERIFIER-W1` merged into `origin/main` at `657a459` **during this wave's Plan
Mode**. `scripts/check-claudemd-claims.mjs` enforces lock freshness **by corpus sha256** and keeps
that lock at **`ops/claudemd-claims.lock.json`**. CH5 edits the vault `CLAUDE.md` (the corpus), so
the lock must be regenerated (`--sync`) in the same commit — but CH5's `Must NOT write` freezes
`ops/**`, and its gate asserts `test -z "$(git status --porcelain -- scripts ops .github)"`.

**Resolution:** the lock is a *mechanical derivative* of the CLAUDE.md edit, not new logic — the
same shape as the standing rule that a wave changing an edge updates `system-map.md` in the same
commit. CH5 therefore writes exactly one `ops/` path, `ops/claudemd-claims.lock.json`, and its
gate is narrowed to exclude that single file with this reasoning recorded inline. No other
`ops/**`, `scripts/**` or `.github/**` path is touched by CH5.

---

## CH1 Acceptance

| Check | Result | Evidence |
|---|---|---|
| Row for P1–P7 | ✅ | above |
| Worktree count + blast radius as measured numbers | ✅ | 74 → 75; blocked 70/74 → 69/75 |
| P3 answered per script **and** per live worktree | ✅ | P3a + P3b tables |
| P5 answered per repo, verbatim finding | ✅ | P5 table + A1 verification |
| P6 `≥3 absent = HALT` | ✅ not tripped | **0 absent** |
| Zero writes beyond this audit | ✅ | verified by the CH1 gate below |
| No hook touched, no host contacted | ✅ | every probe read-only; hook mtimes unchanged |
