# OPS-GIT-IDENTITY-CANONICALIZE-W1 — Plan-Mode endpoint-truth

**Status:** 🛑 HALT — awaiting architect. No state mutated.
**Probed:** 2026-08-09, operator Mac, `git 2.50.1 (Apple Git-155)`.
**Risk markers present:** identifier cited >1 place · state mutation spanning ~40 checkouts · external first-use (GH007 semantics). → Plan Mode mandatory.
**Fictional-primitive count: 4** (≥3 ⇒ HALT per CLAUDE.md §Plan Mode rules).

---

## 0. Identifier diff — R-section vs AC-section

**Result: CLEAN. Zero mismatches.** Every identifier the spec cites in Requirements is
reproduced identically in Acceptance Criteria.

| Identifier | R-section | AC-section | Match |
|---|---|---|---|
| `AlgoVaultFi` | R2, R2b, R3 | AC2 | ✅ |
| `admin@algovault.com` | R2, R3 | AC3 | ✅ |
| `user.useConfigOnly` = `true` | R2, R2b | AC4 | ✅ |
| `Megatron888-Robot` | R2b, R3 | AC7a (implied) | ✅ |
| `268183053+Megatron888-Robot@users.noreply.github.com` | R2b, R3 | AC7a | ✅ |
| `megatronwarlord1998@gmail.com` | R2b, R4 | AC9, AC11 | ✅ |
| `AUTHOR_IDENTITY_VERDICT` | R4 | AC9 | ✅ |
| exit codes `0/1/3` | R4 | — | ✅ (R-only) |
| `scripts/check-author-identity.sh` | R4 | AC8 | ✅ |
| `ops/author-identity-allowlist.json` | R4 | AC7 | ✅ |

**The spec is internally consistent.** Every finding below is spec-vs-**reality** drift, not
R-vs-AC drift.

---

## 1. The finding the spec does not contain

`git log origin/main --format='%ae'` in `AlgoVaultLabs/crypto-quant-signal-mcp` — the **public
flagship**, 1260 commits:

| Author email | Commits | % | Date range |
|---|---:|---:|---|
| **`test@test.local`** | **627** | **49.8%** | 2026-06-18 → **2026-08-09 (today)** |
| `megatronwarlord1998@gmail.com` | **401** | 31.8% | 2026-04-17 → 2026-06-18 |
| `admin@algovault.com` | 193 | 15.3% | 2026-04-05 → 2026-07-04 |
| `funnel-snapshot@algovault.com` | 27 | 2.1% | (Hetzner cron, out of scope) |
| `ci@algovault.com` | 6 | 0.5% | (GHA) |
| `diophantus.hau@gmail.com` | 5 | 0.4% | operator personal Gmail |
| `babyblueviperbusiness@gmail.com` | 1 | 0.1% | unidentified |

**Only 15.3% of the public flagship's history is correctly attributed.** The dominant
misattribution is `test <test@test.local>` — an identity the spec never mentions, currently set
as a **local override in the shared `.git/config`** of the primary checkout, and therefore
inherited by all **14** of its worktrees (`extensions.worktreeConfig=true` is set, but **zero**
`config.worktree` files exist).

### Timeline — reconstructed, not assumed

```
≤ 2026-04-16   0 megatron commits on origin/main   →  the Apr-2026 filter-repo rewrite DID WORK
  2026-04-17   megatron commits resume             →  re-contamination begins ONE DAY LATER
→ 2026-06-18   401 megatron commits accumulate
  2026-06-18   switch to test@test.local           →  coincides with hooks going live
→ 2026-08-09   627 test@test.local commits         →  still live at probe time
```

The re-contamination boundary (2026-04-17, the day after `Prompt/rewrite-commit-authorship.md`)
is exactly the "lane fix did not hold" the spec's own Method predicts — but the spec models it as
*3 stale clones*, not as *the entire subsequent history of the flagship*.

**Root cause of `test@test.local`: NOT identified. Hypothesis rejected, not substituted.**
`tests/unit/check-system-map.test.ts:38` was the obvious suspect and is **exonerated** — it is
correctly sandboxed (`mkdtempSync(tmpdir())` + `git -C <dir>`). No tracked file writes
`user.email` outside a temp dir. The write is unexplained and I will not invent a reason for it.

---

## 2. Probe table — `claim | reality | resolution`

| # | Spec claim | Reality (live command) | Resolution |
|---|---|---|---|
| C1 | Bug class = "a commit inherits whatever the ambient config carries"; offending value is the Gmail | Shape correct, **target wrong**. `test@test.local` = 25 of 55 repos and 627 public commits; the Gmail = 18 repos. | **Q1** |
| C2 | AC11: `--all` `%ae` contains **zero** `megatronwarlord1998@gmail.com` | **401** on `origin/main`, **416** across all refs | AC11 unsatisfiable without a history rewrite — which the spec **forbids**. **Q2** |
| C3 | History "already filter-repo'd, **mailmapped**, Contributors API verified clean" | Rewrite verified TRUE (0 megatron ≤2026-04-16). **No `.mailmap` exists** — `%aE` is byte-identical to `%ae`. | Rewrite claim true-then-undone; mailmap claim **false**. Do not propagate. |
| C4 | R2b writes a **new** `includeIf` scoping structure | `~/.gitconfig` **already has two `includeIf` blocks of the inverse polarity** (global=megatron, `includeIf`→`~/.gitconfig-algovault`=AlgoVaultFi), authored 2026-05-02 by DISTRIBUTION-CLOSEOUT-W1 for this exact bug. **Both are DEAD**: `/Users/tank/git` is empty (0 entries); the vault is not a git repo. | This is an **inversion of a failed prior fix**, not a greenfield write. **Q3** |
| C5 | Megatron repos sit under a root that `gitdir:` can scope | **One** repo has a `Megatron888-Robot/*` origin: `~/Documents/GitHub/desktop-tutorial`. The other **17** megatron-identity repos are **AlgoVaultLabs-owned**, silently inheriting the global. | R2b's directory-scoping premise collapses — there is no megatron root. **Q3** |
| C6 | `admin@algovault.com` canonical; noreply form rejected because it "**permanently splits** `git shortlog -sne`" | The split **already exists**, running the other way: **5** repos use `264139505+AlgoVaultFi@…`, **1** uses `AlgoVaultFi@users.noreply.github.com` (no numeric prefix), **1** uses `dev@algovault.com`. **Zero** repos resolve to `admin@algovault.com` today. | `admin@` does not avoid a split; it makes a 4-way one. **Q4** |
| C7 | Three classes: `algovault` · `megatron` · `other` | **Eight** distinct effective identities across 55 repos — incl. `AlgoVault Operator <diophantus.hau@gmail.com>` (2 editorial repos) and `MCPVerifyLabs <314603622+…>` (2 repos = the Reliability Bureau second business). | 3-class taxonomy under-fits. **Q5** |
| C8 | GH007 "**Live breakage** … converts R3 into an **outage fix**" | `gh auth status` → this machine pushes as **`AlgoVaultFi`**, whose "keep email private" is **OFF**. GH007 is evaluated against the **pushing** account's private email — not an arbitrary author email. | Probably **not** an outage. Reported, **not asserted either way**. **Q6** |
| C9 | Inheritors include `/Users/tank/code/tlc-quant-engine` | **Does not exist** on this machine | 🔴 **Fictional #1** — drop (also barred by the never-write-to-TLC rule) |
| C10 | Context cites `audits/AGENTKIT-ACTION-PROVIDER-W1-endpoint-truth.md` §D.2 | **File does not exist** in the repo | 🔴 **Fictional #2** — citation dead. The underlying fact (global = Megatron) is nonetheless **CONFIRMED live**. |
| C11 | `~/code/.worktrees/**` is the worktree root | CONFIRMED (14 worktrees). But **11 further checkouts sit outside it** — `~/code/cqsm-wt-*`, `~/code/algovault-bot-wt-*`, `~/algovault-bot-wt/*`, `~/algovault-bot-worktrees/*` | Sweep must **not** be root-scoped. Spec's R1.5 "every git dir under /Users/tank" is the correct instruction; its Context note is narrower than its Requirement. |
| C12 | "check `extensions.worktreeConfig` per primary, don't assume" | **Set to `true`** on the primary — but **0** `config.worktree` files exist, so all 14 worktrees inherit `.git/config`. | **AC7d answerable now** (see §3) |
| C13 | R4 primitives exist and compose | ✅ `scripts/lib/hook-block.sh` (`hook_block_assert_publishable` @147, `hook_block_install` @239), `check-push-safety.sh`, `check-claudemd-claims.mjs`, `ops/` all PRESENT. pre-commit = **1** block, pre-push = **7**. | R4 buildable exactly as specified. `blocks_before→after` = 1→2. |
| C14 | pre-commit chosen because pre-push stdin is single-consumer | CONFIRMED — 7 pre-push blocks, `check-push-safety.sh` present and stdin-reading | Rationale **sound**. Keep pre-commit. |
| C15 | R2 backup convention | `~/.gitconfig` = 585 B, `~/.config/git/config` **absent** ⇒ `~/.gitconfig` is unambiguously authoritative | ✅ no ambiguity |
| C16 | Signing may invalidate on email change | `user.signingkey`, `commit.gpgsign`, `gpg.format` **all unset**; `--system` carries no `user.*` | ✅ **no signing risk** |

🔴 **Fictional #3:** R2b's `<root-of-megatron-owned-repos-from-R1.5>` — no such root exists.
🔴 **Fictional #4:** AC11's premise of a clean history.

---

## 3. AC7d — worktree inheritance, resolved empirically

`git -C /Users/tank/code/.worktrees/crypto-quant-signal-mcp/closedbar-sell-asymmetry var
GIT_AUTHOR_IDENT` → `test <test@test.local>`.

Matched on `$GIT_DIR` = `/Users/tank/code/crypto-quant-signal-mcp/.git/worktrees/<name>` — i.e.
**inside the primary**, confirming the spec's stated hypothesis. A `gitdir:` `includeIf` keyed on
`~/code/.worktrees/` would therefore **never match a worktree**; it must be keyed on the
**primary's** path. This is the single most load-bearing mechanical fact in R2b and it favours the
spec's caution.

---

## 4. Machine identity census — 55 git dirs

| Effective identity | Repos | Notes |
|---|---:|---|
| `test <test@test.local>` | **25** | cqsm + algovault-bot families. **The dominant class. Absent from the spec.** |
| `Megatron888-Robot <megatronwarlord1998@gmail.com>` | **18** | inherited from global; **17 are AlgoVaultLabs-owned** |
| `AlgoVaultFi <264139505+AlgoVaultFi@users.noreply.github.com>` | 5 | the form the spec **rejects** |
| `MCPVerifyLabs <314603622+…>` | 2 | Reliability Bureau — genuinely separate business |
| `AlgoVault Operator <diophantus.hau@gmail.com>` | 2 | `algovault-editorial`, `-editorial-content` |
| `AlgoVaultFi <AlgoVaultFi@users.noreply.github.com>` | 1 | `MCPVERIFY` — **third** AlgoVaultFi variant |
| `AlgoVault Labs <dev@algovault.com>` | 1 | `binance-skills-hub` — **fourth** algovault address |
| `admin@algovault.com` | **0** | **the spec's canonical target is used by no repo today** |
| ERR (not a repo) | 1 | `~/.cache/uv/sdists-v9` |

Third-party clones inheriting the global: `~/.claude/skills/{claudeception,napkin,taskmaster}`
(origin `blader/*`) — these would be **mis-attributed to AlgoVaultFi** under a naive global flip.

### Cross-repo public blast radius (`origin/main`)

| Repo | Misattributed | Correct |
|---|---|---|
| `crypto-quant-signal-mcp` | 627 test + 401 gmail + 5 personal + 1 unknown | 193 |
| `autonomous-optimizer` | 120 gmail | 34 |
| `algovault-bot` | 54 gmail + 14 test + 10 personal | 0 |
| `algovault-skills` | 38 gmail + 1 personal | 14 |
| `algovault-mcp` | 12 gmail | 1 |
| `algovault-editorial` | 18 personal | 0 |
| `agentkit-algovault` / `plugin-algovault` | 0 | 3 / 5 (noreply form) |

---

## 5. What is safe to proceed with, unchanged

R2 (global reassign + backup), R4 (the guard), R5 (verification) are all sound and buildable.
R1 is complete — this document **is** its output. The blocked items are R2b (premise collapsed),
R3 (class taxonomy under-fits), and AC11 (unsatisfiable). The spec's Execution Plan already
mandates the stop I am taking: *"report the class table and **STOP** if any `other`-class repo is
found."* Six were found.

## 6. Destructive-bash proposal (nothing run)

| Command | Reversibility |
|---|---|
| `cp ~/.gitconfig ~/.gitconfig.bak.OPS-GIT-IDENTITY-CANONICALIZE-W1-<UTC>` | additive |
| `git config --global user.name/user.email/useConfigOnly` | reversed by the backup |
| per-repo `git config --local --replace-all user.email <x>` | reversed per repo |
| `bash scripts/install_author_identity_hook.sh` | `--remove`; hook auto-backs-up |

**Zero `--unset`. Zero history rewrite. Zero force-push.** No command touches
`~/code/.worktrees` layout, the Hetzner host, or any `other`-class repo.
