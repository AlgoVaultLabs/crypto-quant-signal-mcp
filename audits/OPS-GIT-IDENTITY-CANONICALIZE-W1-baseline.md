# OPS-GIT-IDENTITY-CANONICALIZE-W1 — CH5 baseline + verification

**Measured:** 2026-08-09. **Purpose:** pin the instrument so the next wave measuring this defect
compares like with like. Every number below names the command that produced it.

---

## 1. The instrument (read before quoting any figure)

Four populations exist here and **none of them are interchangeable**. Three of the four were
measured during this wave and disagreed by more than an order of magnitude.

| # | Instrument | Command | What it answers |
|---|---|---|---|
| A | **`origin/main`, one repo** | `git log origin/main --format='%ae'` | **The public surface. The instrument of record.** |
| B | all refs, one repo | `git log --all --format='%ae'` | Includes stale/unmerged local branches (401 → 416 for the Gmail on cqsm) |
| C | per-**origin**, deduplicated | one representative checkout per distinct origin URL | Cross-repo totals |
| D | 🛑 per-**checkout** aggregate | every checkout summed | **WRONG — do not use.** 56 checkouts share 23 origins, so the same commits are counted up to 14×. |

⚠️ **Instrument D produced a confident, plausible, 16× wrong number during this wave**: it read
`test@test.local` at **10,314** when the true `origin/main` figure was **635**. It was caught only
because the value was implausible against a figure measured a different way an hour earlier. This
is the third recorded substrate of *the instrument measured a different quantity than the question
asked* — after the site-scoped access log that returned a confident **zero**, and the liveness band
built from scheduling arithmetic that returned a confident **alarm**. **Before adopting a count,
state in one sentence what the command literally computes and check that sentence answers the
question.**

📌 **A second instrument error, in this wave's own verification, kept visible for the same reason:**
the BLOCK-mode probe printed `exit=0` from `$?` **after a pipe through `sed`** — it was reading
*sed's* status, not git's. The real evidence that BLOCK mode refuses is that `HEAD` did not move.
A verification that measures the wrong process is not a verification.

---

## 2. Public-surface baseline — `AlgoVaultLabs/crypto-quant-signal-mcp`, `origin/main`

Instrument **A**. 1,273 commits at wave close.

| author email | commits | share | date range | status after this wave |
|---|---:|---:|---|---|
| `test@test.local` | 640 | 50.3% | 2026-06-18 → 2026-08-09 | 🛑 denied · **historical only** |
| `megatronwarlord1998@gmail.com` | 401 | 31.5% | 2026-04-17 → 2026-06-18 | 🛑 denied · historical only |
| `admin@algovault.com` | 193 | 15.2% | 2026-04-05 → 2026-07-04 | 🔄 non-canonical · historical only |
| `funnel-snapshot@algovault.com` | 27 | 2.1% | — | ⚪ Hetzner cron, out of scope |
| `ci@algovault.com` | 6 | 0.5% | — | ⚪ GHA |
| `diophantus.hau@gmail.com` | 5 | 0.4% | — | 🛑 denied · historical only |
| `babyblueviperbusiness@gmail.com` | 1 | 0.1% | 2026-07-03 | ❓ unidentified |

**Cross-repo, instrument C** (deduplicated by origin, forked-upstream repos excluded — `agentkit`,
`crewAI-quickstarts`, `langchain-mcp-adapters`, `.claude/skills/{claudeception,napkin,taskmaster}`,
**141 distinct upstream authors** who never committed on this machine): `test@test.local` 649 ·
`megatronwarlord1998@gmail.com` 633 · `diophantus.hau@gmail.com` 43.

---

## 3. Machine state — before → after

| effective identity | checkouts BEFORE | checkouts AFTER |
|---|---:|---:|
| `test <test@test.local>` | 27 | **0** |
| `Megatron888-Robot <megatronwarlord1998@gmail.com>` | 18 | **0** |
| `AlgoVault Operator <diophantus.hau@gmail.com>` | 2 | **0** |
| `AlgoVault Labs <dev@algovault.com>` | 1 | **0** |
| `AlgoVaultFi <AlgoVaultFi@users.noreply.github.com>` (legacy) | 1 | **0** |
| `AlgoVaultFi <264139505+AlgoVaultFi@users.noreply.github.com>` | 5 | **54** |
| `MCPVerifyLabs <314603622+…>` | 2 | 2 *(second business, untouched)* |
| `Megatron888-Robot <268183053+…noreply…>` | 0 | 1 *(desktop-tutorial, via includeIf)* |

Eight identities collapsed to three, and all three are correct for their class.

---

## 4. R5.1 — live verification

| # | Check | Result |
|---|---|---|
| 1 | primary checkout `var GIT_AUTHOR_IDENT` | ✅ `AlgoVaultFi <264139505+AlgoVaultFi@users.noreply.github.com>` |
| 2 | **fresh** throwaway worktree (inheritance, not just the primary) | ✅ canonical; `$GIT_DIR` = `…/crypto-quant-signal-mcp/.git/worktrees/_ch5-throwaway`; removed after |
| 3a | scratch repo, no local config | ✅ commit authored canonical |
| 3b | **layer 2**, `useConfigOnly=true`, no identity configured | ✅ git **REFUSED**: `Author identity unknown` |
| 3c | layer 2 counterfactual, `useConfigOnly` unset | 🛑 git **silently invented `TANK <tank@Tank.local>` and committed it** — the exact failure `useConfigOnly` exists to prevent, demonstrated live |
| 4a | denied identity, REPORT mode | ✅ `AUTHOR_IDENTITY_VERDICT=FAIL` + the named reason; commit lands (does not block) |
| 4b | denied identity, BLOCK mode counterfactual | ✅ `FAIL`; **`HEAD` did not move** — genuinely refused |
| 5 | `git push --dry-run` in the primary | ⚠️ **7 verdict tokens for 8 pre-push blocks** — see below |

### R5.1.5 — the 7-vs-8, fully attributed

**Not caused by this wave.** `pre-push` sha256 is byte-identical across the install
(`a299db8c98855d09a0a4c9790cdfc09c3266ae39490fd149a3769e328657bbea` before **and** after); this
wave installed into `pre-commit` only. The 8th block, `dark-exports`
(`PRICING-FOLLOWUPS-GENERATOR-W1`), **skipped loudly with a ledger row** because
`scripts/check-new-dark-exports.mjs` is absent from the primary checkout — which lags `origin/main`.
That is `hook_block_render`'s designed fail-open (loud + ledgered, never silent), working correctly:

```
2026-08-09T11:03:59Z  SKIP  dark-exports  /Users/tank/code/crypto-quant-signal-mcp  scripts/check-new-dark-exports.mjs
```

Emitted tokens, all PASS: `GATE_STALENESS` · `PUSH_SAFETY` · `SESSION_DRIFT` · `SHARED_STATE` ·
`SOURCE_GREPPABLE` · `TEST_GATE` · `WORKTREE_ROOT`.

🔶 **Two pre-existing findings surfaced in passing, neither in this wave's scope:**
`⚠ pre-push: installed block 'dark-exports' has no registry row` in
`ops/shared-worktree-state.json`, and the primary checkout is behind `origin/main` (its
`git push` is rejected non-fast-forward).

---

## 5. AC5.1 — measured against BOTH windows, honestly

**As literally specified (window = CH2 completion, 10:49:59Z): ⚠️ NOT met, by exactly one commit.**

```
e50f01fa8129b8f8665080660847fcf2b2f33592
  author    test <test@test.local>
  authored  2026-08-09T18:51:09+08:00  ==  10:51:09Z
  subject   merge: origin/main into the pricing-followups wave branch
  ref       worktree-pricing-followups
```

**Window = CH3 completion (11:00:12Z, when the override was actually removed): ✅ met.** Zero
non-allowlisted authors on `origin/main`; the only commits pushed machine-wide since are this
wave's own three, all canonical.

**The gap is a precisely-bounded race, not a miss.** CH2 fixes the GLOBAL; a **local** override
beats the global, and `worktree-pricing-followups` was still carrying the shared `.git/config`
override that CH3 removes. The commit landed **70 seconds** after CH2 and **9 minutes** before CH3,
made by a **parallel session that had no knowledge of this wave**.

Two things follow, and the second matters more than the first:

1. **AC5.1's window is mis-specified.** The criterion should start at **CH3** completion, because
   CH2 alone cannot deliver it — that is a property of git's precedence order, not of execution.
   Recorded as a spec correction rather than quietly re-based.
2. **This is the strongest possible argument for the CH4 guard.** Inside the ten-minute window in
   which this wave was actively retiring the identity, an unrelated session produced a 640th
   instance of it. No sweep can close that gap; only a gate at the commit boundary can. The guard
   was not yet installed at 10:51:09Z — had it been, it would have printed
   `AUTHOR_IDENTITY_VERDICT=FAIL` for that exact commit.

---

## 6. R5.3 — attribution recovery WITHOUT a history rewrite

| identity | commits | recoverable by verifying the email on the account? |
|---|---:|---|
| `dev@algovault.com` | 2 | ✅ **Yes.** Domain is owned; the address is simply not verified on `AlgoVaultFi`. Verifying it makes GitHub re-derive attribution retroactively. **Filed as a one-line manual follow-up — NOT performed: account settings are Mr.1's to change.** |
| `admin@algovault.com` | 193 | ✅ Already verified on the account, so these are already attributed. It remains a verified address and must **not** be removed there — it is simply no longer the commit address. |
| `megatronwarlord1998@gmail.com` | 401 | ⚠️ Attributed, but to the **personal** `Megatron888-Robot` account. Reassigning requires a rewrite. |
| `diophantus.hau@gmail.com` | 43 | ⚠️ Unverified on `AlgoVaultFi` ⇒ attributed to nobody. Verifying it would attach the operator's **personal Gmail** to the org's history — the opposite of this wave's intent. Recommend **not** verifying. |
| **`test@test.local`** | **640** | 🛑 **NO — structurally impossible.** `.local` is an [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762) reserved TLD: it cannot receive mail, so it can never be verified on any GitHub account. **Only a history rewrite reclaims these 640, and this wave does not do one.** Stated plainly rather than left implied. |

**`.mailmap`** would unify `git shortlog -sne` locally at zero risk. It is **not** shipped here, and
no claim is made that it affects the GitHub Contributors graph — that is unverified, and this repo's
own history contains a "mailmapped" claim that turned out to be false (no `.mailmap` has ever
existed in this repo; `%aE` is byte-identical to `%ae`).

**No history rewrite. No force-push.** Rewriting 1,080 of 1,273 commits would break `merge-base`
ancestry for every worktree, make `ops/scripts/host-deploy.sh` refuse to deploy (it refuses a
non-ancestor of `origin/main`), invalidate `bot-deploy-parity.sh`'s lockfile, break
`branch-work-landed.sh`'s patch-id dedup, and orphan external SHA citations. It was **already done
once, in Apr-2026, and did not hold** — 401 Gmail commits returned starting the very next day.
Rewriting before the guard exists is guaranteed waste. Guard first.

---

## 7. Guard ledger — the promotion input

`$GIT_COMMON_DIR/algovault-author-identity.log`, 12 rows at wave close (self-test + verification
runs + 2 real pre-commit invocations). Promotion to BLOCK mode requires **BOTH**
`max_violations: 0` **AND** `not_before: 2026-08-16`, measured from this log rather than asserted —
owner `OPS-AUTHOR-IDENTITY-PROMOTE-W{NEXT}`.
