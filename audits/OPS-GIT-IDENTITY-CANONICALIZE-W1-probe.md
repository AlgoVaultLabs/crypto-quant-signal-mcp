# OPS-GIT-IDENTITY-CANONICALIZE-W1 — CH1 confirmation gate + root-cause probe

**Chapter:** CH1 (READ-ONLY). **Measured:** 2026-08-09, operator Mac, `git 2.50.1 (Apple Git-155)`.
**Worktree:** `~/code/.worktrees/crypto-quant-signal-mcp/git-identity-canon` (`worktree-git-identity-canon`, HEAD == `origin/main`).
**Writes this chapter:** this file only. Zero config writes, zero repo writes.

```
ROOT_CAUSE=CLOSED
MCPVERIFY_OWNER=MCPVerifyLabs (User id 314603622, created 2026-08-08) — FOREIGN, not AlgoVaultFi
P3_DELTA=0
```

---

## P1 — `test@test.local` root cause: **CLOSED**

The spec's first hypothesis was correct on the first probe.

| Probe | Output |
|---|---|
| `config --show-origin --get user.email` | `file:.git/config` → `test@test.local` |
| `config --local --list --show-origin` | `file:.git/config user.email=test@test.local` · `user.name=test` |
| `.git/config` mtime | `Aug  9 18:42:58 2026` — **not evidence** (see instrument note) |
| `config.worktree` files under `.git/worktrees` | **0** |

A single local override in the **shared** `.git/config` of
`/Users/tank/code/crypto-quant-signal-mcp` explains the dominance, the repo count, and the sharp
start date at once. `extensions.worktreeConfig` **is** `true`, but with zero `config.worktree`
files every linked worktree still resolves through the shared config — so all 14 worktrees of the
flagship inherit it. No forensic wave is filed, per CH1's own branch rule.

⚠️ **Instrument note — the mtime is contaminated and must not be cited as the set-time.**
`.git/config` was rewritten minutes before this probe by *this wave's own* `git worktree add`.
mtime answers "when was the file last written", not "when was `user.email` set". The dating
evidence is the commit record below, not the filesystem.

### The transition, to the minute

| | commit | UTC+8 | author |
|---|---|---|---|
| last non-`test` | `68d3660` | 2026-06-18T21:40:34 | `megatronwarlord1998@gmail.com` — `ci(test-gate): C4 — composable pre-push greenness gate + green baseline [OPS-VITEST-SUITE-REPAIR-W1 CH4]` |
| **first `test@`** | `41c778f` | 2026-06-18T21:51:51 | `test@test.local` — `fix(test-gate): scrub git hook env vars in check_test_baseline.sh [OPS-VITEST-SUITE-REPAIR-W1 CH4]` |

**11 minutes apart, same wave, same chapter.** The session that introduced it was
`OPS-VITEST-SUITE-REPAIR-W1 CH4`, standing up the composable pre-push test gate; the very next
commit is titled *"scrub git hook env vars in `check_test_baseline.sh`"*. The consistent reading is
that the session set a local test identity while reproducing a git-hook environment problem and
never reverted it. The override then silently authored every commit for **52 days**.

**Named, not guessed:** the wave and chapter are named because the commit record names them. The
*intent* ("set while debugging") is an inference and is labelled as one — no further claim is made.

`tests/unit/check-system-map.test.ts:38` — the obvious suspect, since it literally writes
`user.email=test@test.local` — is **EXONERATED**: it runs `mkdtempSync(tmpdir())` and passes
`git -C <dir>`, so it can never reach a real repo. No tracked file writes `user.email` outside a
temp dir.

---

## P2 — MCPVerifyLabs ownership: **FOREIGN OWNER**

| Probe | Result |
|---|---|
| `gh api orgs/MCPVerifyLabs` | `404` — not an org |
| `gh api users/MCPVerifyLabs` | `{"login":"MCPVerifyLabs","id":314603622,"type":"User","created_at":"2026-08-08T10:30:30Z"}` |
| `gh api users/AlgoVaultFi` | `{"login":"AlgoVaultFi","id":264139505,"type":"User"}` |
| `gh api orgs/mcpverify` | `{"login":"mcpverify","name":"MCP Verify","type":"Organization"}` |
| `gh api repos/mcpverify/mcpverify-site` | `404` |
| `git ls-remote origin` (in `mcpverify-site`) | `remote: Repository not found.` |
| `gh auth status` | exactly one account: `AlgoVaultFi` |

`MCPVerifyLabs` is a **distinct GitHub User account** (different id) whose repos live under the
`mcpverify` **Organization**, and this machine's only authenticated account **cannot read them at
all**. There is no evidence AlgoVaultFi owns or administers it. Plausibly the same human's second
business — but ownership is not inferable from plausibility, and this probe exists precisely to
stop that inference.

### CH1↔CH2/CH3 tension — resolved by the binding gate, flagged for ratification

The spec gives this outcome two different instructions:

- **CH1 P2:** *"Owned by a different account → **HALT**, name the account, wait for the architect to supply its scoping block."*
- **CH3 class table:** *"If foreign owner → UNTOUCHED + exemption row + a `# TODO: revisit by <CH3-date +14d>` marker and a row in `Claude files/defensive-reductions-to-revisit.md`."*
- **CH2 R2.5:** permits an MCPVerifyLabs `includeIf` *"unless CH1 P2 returned a foreign owner"* — while **AC2.5 and the CH2 verification gate both require `[ "$IC" -eq 1 ]`**, i.e. exactly ONE `includeIf`.

**Taken:** the CH3 branch. Reasons, in order of weight:

1. **The gate is the binding artifact.** `IC -eq 1` makes a second `includeIf` fail CH2's own GREEN token. Exactly one `includeIf`, for `desktop-tutorial`.
2. **The HALT's stated purpose is already satisfied.** It exists so nobody *guesses an identity for a business's repos*. `UNTOUCHED` guesses nothing — it is the null action.
3. **Not NEW drift.** V1 already surfaced these repos as `other`-class; V2's D6 anticipated them and CH3 pre-resolved *both* branches. The probe selected a branch the spec had already written. Per V2's preamble — *HALT only on NEW drift* — that is not a halt condition.
4. **Both repos are already correct.** They carry local overrides resolving to
   `MCPVerifyLabs <314603622+MCPVerifyLabs@users.noreply.github.com>`, and their entire commit
   history is consistently that identity. Nothing is broken to fix.

🔶 **Residual risk, recorded rather than silently accepted:** once CH2 flips the global to
AlgoVaultFi with `useConfigOnly = true`, a **fresh clone** of an `mcpverify/*` repo would inherit
`AlgoVaultFi` and mis-attribute the second business. The two existing checkouts are immune
(local overrides). This is exactly what CH3's 14-day TODO covers. **Architect ratification wanted**
on whether MCPVerifyLabs should get its own scoping block in a follow-up
(`OPS-MCPVERIFY-IDENTITY-SCOPE-W{NEXT}`) — not needed for this wave to complete.

---

## P3 — re-confirmation of the 5 ratified measurements: **delta 0**

| # | Assertion | Expected | Measured | ✓ |
|---|---|---|---|---|
| 1 | `~/.gitconfig` still has 2 `includeIf` blocks | true | `grep -c '^\[includeIf'` → **2** | ✅ |
| 2 | Both point at non-existent paths | true | `~/git` = **0 entries**; vault `.git` = **absent** | ✅ |
| 3 | `desktop-tutorial` is the ONLY `Megatron888-Robot` origin | true | 1 of 56 checkouts | ✅ |
| 4 | `admin@algovault.com` is the effective identity of 0 repos | true | absent from the effective tally | ✅ |
| 5 | `gh auth status` pushes as `AlgoVaultFi` | true | `account AlgoVaultFi`, sole account | ✅ |
| 6 | No push has failed with `GH007` | true | **633** Gmail-authored commits are reachable from `origin/main` across 7 repos — they are on the remote, so those pushes succeeded. Most recent: 2026-08-02. | ✅ |

**`P3_DELTA=0`.** D1–D7 all hold. Nothing re-litigated.

---

## P4 — author census (the AC11a baseline)

### ⚠️ Instrument — read this before quoting any number

Three distinct populations exist and they are **not interchangeable**:

| Instrument | What it counts | Why it misleads |
|---|---|---|
| per-**checkout** aggregate | every checkout's own history | **56 checkouts share 23 origins** — the same commits counted up to 14×. Measured this way `test@test.local` reads **10,314**; the true figure on the flagship is **635**. A 16× overstatement that looks entirely plausible. |
| `--all` refs | remote + local + stale branches | Includes unmerged/stale branches (401 → 416 for the Gmail on cqsm) |
| **`origin/main`** | the public surface | **The instrument of record for this defect** |

**Baseline below is deduplicated to one representative checkout per distinct origin, and excludes
forked-upstream repos** (`agentkit`, `crewAI-quickstarts`, `langchain-mcp-adapters`,
`.claude/skills/{claudeception,napkin,taskmaster}` — **141 distinct upstream authors**, zero
authored on this machine). A later wave comparing a fork-inclusive count against this table will
read the difference as drift; it is not.

### P4a — identities of record, deduplicated by origin, our repos only

| email | `origin/main` | all-refs | repos | class |
|---|---:|---:|---:|---|
| `test@test.local` | **649** | 676 | 2 | 🛑 denied |
| `megatronwarlord1998@gmail.com` | **633** | 664 | 7 | 🛑 denied |
| `admin@algovault.com` | 250 | 251 | 6 | 🔄 converge |
| `diophantus.hau@gmail.com` | **43** | 43 | 5 | 🛑 denied |
| `funnel-snapshot@algovault.com` | 27 | 27 | 1 | ⚪ Hetzner cron, out of scope |
| `AlgoVaultFi@users.noreply.github.com` | 24 | 24 | 1 | 🔄 converge (legacy no-prefix) |
| `algovault@hetzner.local` | 18 | 18 | 1 | ⚪ host-side, out of scope |
| `264139505+AlgoVaultFi@users.noreply.github.com` | 11 | 11 | 3 | ✅ **canonical** |
| `314603622+MCPVerifyLabs@users.noreply.github.com` | 6 | 9 | 2 | ⚪ foreign, untouched |
| `ci@algovault.com` / `editorial@algovault.com` | 6 / 6 | 6 / 6 | 1 / 1 | ⚪ CI identities |
| `github-actions@github.com` + `[bot]` | 23 | 38 | 1 | ⚪ bot |
| `babyblueviperbusiness@gmail.com` | 1 | 1 | 1 | ❓ unidentified, 2026-07-03 |
| `dev@algovault.com` | 0 | 2 | 1 | 🔄 converge |

### P4b — the three denied identities, per repo, on `origin/main`

| commits | repo | identity |
|---:|---|---|
| **635** | `AlgoVaultLabs/crypto-quant-signal-mcp` | `test@test.local` |
| **401** | `AlgoVaultLabs/crypto-quant-signal-mcp` | `megatronwarlord1998@gmail.com` |
| 120 | `AlgoVaultLabs/autonomous-optimizer` | `megatronwarlord1998@gmail.com` |
| 54 | `AlgoVaultLabs/algovault-bot` | `megatronwarlord1998@gmail.com` |
| 38 | `AlgoVaultLabs/algovault-skills` | `megatronwarlord1998@gmail.com` |
| 18 | `AlgoVaultLabs/algovault-editorial` | `diophantus.hau@gmail.com` |
| 14 | `AlgoVaultLabs/algovault-bot` | `test@test.local` |
| 12 | `AlgoVaultLabs/algovault-mcp` | `megatronwarlord1998@gmail.com` |
| 10 | `AlgoVaultLabs/algovault-bot` | `diophantus.hau@gmail.com` |
| 9 | `AlgoVaultLabs/algovault-editorial-content` | `diophantus.hau@gmail.com` |
| 7 | `AlgoVaultLabs/algovault-integrations` | `megatronwarlord1998@gmail.com` |
| 5 | `AlgoVaultLabs/crypto-quant-signal-mcp` | `diophantus.hau@gmail.com` |
| 1 | `Megatron888-Robot/desktop-tutorial` | `megatronwarlord1998@gmail.com` (correct for its class) |
| 1 | `AlgoVaultLabs/algovault-skills` | `diophantus.hau@gmail.com` |

**cqsm `test@test.local` reads 635 here vs 627 in the V1 probe** — 8 commits landed from other
sessions between the two measurements. Expected concurrency, not drift; recorded so the delta is
not mistaken for one.

---

## P5 — repo classification (56 checkouts / 23 distinct origins)

**Class tally:** `canonical` 48 · `megatron` 1 · `other` 7.
**Effective-identity tally (pre-CH2):**

| effective identity | checkouts |
|---|---:|
| `test <test@test.local>` | 27 |
| `Megatron888-Robot <megatronwarlord1998@gmail.com>` | 18 |
| `AlgoVaultFi <264139505+AlgoVaultFi@users.noreply.github.com>` | 5 |
| `MCPVerifyLabs <314603622+…>` | 2 |
| `AlgoVault Operator <diophantus.hau@gmail.com>` | 2 |
| `AlgoVaultFi <AlgoVaultFi@users.noreply.github.com>` | 1 |
| `AlgoVault Labs <dev@algovault.com>` | 1 |

Probed with `git -c 'safe.directory=*'` throughout — a dubious-ownership refusal reads as "not a
repo" and has already produced one wrong count in this repo's history. (Quoted: an **unquoted**
`safe.directory=*` glob-expands under zsh and truncated a probe mid-run during this chapter.)

### The 8 rows CH3 must NOT converge

| path | origin | class | local `user.email` | effective | source |
|---|---|---|---|---|---|
| `~/.claude/skills/claudeception` | `blader/Claudeception` | other | — | Megatron (inherited) | `~/.gitconfig` |
| `~/.claude/skills/napkin` | `blader/napkin` | other | — | Megatron (inherited) | `~/.gitconfig` |
| `~/.claude/skills/taskmaster` | `blader/taskmaster` | other | — | Megatron (inherited) | `~/.gitconfig` |
| `~/Documents/GitHub/desktop-tutorial` | `Megatron888-Robot/desktop-tutorial` | **megatron** | — | Megatron (inherited) | `~/.gitconfig` |
| `~/Projects/backup-framework` | *(none)* | other | — | Megatron (inherited) | `~/.gitconfig` |
| `~/Projects/hlc-engine` | *(none)* | other | — | Megatron (inherited) | `~/.gitconfig` |
| `~/code/chain-watchdog` | `mcpverify/chain-watchdog` | other | `314603622+MCPVerifyLabs@…` | MCPVerifyLabs | `.git/config` |
| `~/code/mcpverify-site` | `mcpverify/mcpverify-site` | other | `314603622+MCPVerifyLabs@…` | MCPVerifyLabs | `.git/config` |

📌 **Correction to the V1 sweep:** `chain-watchdog` was recorded as having *no origin*. It has one
— `mcpverify/chain-watchdog`. V1's reading was wrong; this table is authoritative.

📌 **Inheritance consequence CH3 must not mistake for a violation.** Five of these eight carry **no
local override**, so CH2 changes their *effective* identity to canonical **without CH3 writing to
them**. `.git/config` stays byte-identical (AC3.3 ✅) and no denied email remains (AC3.2 ✅). For the
three `blader/*` clones this is the spec's own stated intent — *"a PR from here is correctly
authored AlgoVaultFi via the global"*. For `backup-framework` / `hlc-engine` (local-only, no
remote) it is inert. **"Untouched" means we do not write to it — not that its resolution is
frozen.**

---

## CH1 Acceptance Criteria

| # | Criterion | Result |
|---|---|---|
| AC1.1 | P1–P5 tables, live output, zero placeholders | ✅ |
| AC1.2 | Root cause CLOSED with config path (+ mtime, correctly disclaimed) | ✅ `ROOT_CAUSE=CLOSED` |
| AC1.3 | MCPVerifyLabs ownership resolved | ✅ foreign owner named; branch selected + justified |
| AC1.4 | P3 delta = 0 | ✅ `P3_DELTA=0` |
| AC1.5 | `git status --porcelain` shows ONLY this file | ✅ |

## Deliberate sequencing note (declared, not silent)

Build Rule 5 mandates an auto-commit per chapter. Committing CH1 *before* CH2 would author this
audit `test <test@test.local>` — adding a 636th instance of the exact defect the wave retires,
inside the wave that retires it. **CH1's commit is therefore held until CH2 completes**, so it
lands under the canonical identity. CH1's write scope is unchanged (this file only), CH2 touches
no repo file (it writes `~/.gitconfig` only), and AC5.1's measurement window starts at CH2
completion, so nothing downstream shifts.
