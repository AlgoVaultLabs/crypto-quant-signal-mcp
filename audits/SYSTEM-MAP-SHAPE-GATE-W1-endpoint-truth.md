# SYSTEM-MAP-SHAPE-GATE-W1 — endpoint-truth (Plan Mode Step 0)

_Probed 2026-08-21. Zero state mutated. Destination on approval: `audits/SYSTEM-MAP-SHAPE-GATE-W1-endpoint-truth.md` in `crypto-quant-signal-mcp`._

## 0. system-map.md read FIRST — edge enumeration

Spec declares `system-map edges: NONE — internal change only.` **Confirmed.** The wave adds a
pre-commit check script + a hook block + two `package.json` script entries + one line inside
§5's per-wave checklist. It creates no producer→consumer edge, no API field, no postgres
column, no cron, no publish target. No component in §3 (18 rows) or §4 (45 rows) changes role,
repo or edge. `system-map.md updated:` will be **`n-a`** — R5's §5 edit is documentation *of the
gate*, added in place inside the existing checklist block, never a prepended row.

Touched component per §3: `crypto-quant-signal-mcp` (Role unchanged; a new `scripts/*.sh` gate
is not a role mutation). No `tight`/`loose` consumer rows implicated.

## 1. Truth table — claim | reality | resolution

| # | Spec claim | Probed reality | Resolution |
|---|---|---|---|
| P1 | Vault may be a git repo with a hooks path | `git -C "<vault>" rev-parse --show-toplevel` → `fatal: not a git repository`; `.git` absent on the **real** filesystem, not merely the Cowork mount | R4 branch 2. `system-map.md` is versioned by **nothing**. |
| P2 | `scripts/check_system_map.sh` repo unnamed | `/Users/tank/code/crypto-quant-signal-mcp/scripts/check_system_map.sh` (+ ~20 worktree copies) | Sibling repo = `crypto-quant-signal-mcp`; sibling language = **bash** → build `check_map_shape.sh` |
| P3 | "wire as a GHA step … that reads the vault copy is **not** possible" | The sibling gate **already** reads the vault path from the repo's shared `pre-commit`: `SYSTEM_MAP_PATH="${SYSTEM_MAP_PATH:-/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/system-map.md}"` (`check_system_map.sh:23`) | A fail-closed pre-commit gate **is** achievable, by the identical mechanism. Not an invented path — a measured, live one. **→ Q1** |
| P4 | Hook, GHA, or both? | `pre-commit` block **2 of 2** only. `grep -rn check_system_map .github/` → **zero** hits. `pre-push` carries 10 blocks. | One caller today. This wave adds a second `pre-commit` block. |
| P5 | Which `package.json` runner? | Convention is `<domain>:<thing>:check` / `:selftest`; `prepublishOnly` chains 20+ of them | Add `map:shape:check` + `map:shape:selftest`. **Not** into `prepublishOnly` — it targets an out-of-repo file and npm publish must not depend on the vault being mounted. |
| P6 | Max line currently **844** (Context + R5) | **852** — `LC_ALL=C awk '{if(length($0)>m)m=length($0)}END{print m}' system-map.md`, longest is line 441 (in §5). `wc -L` agrees. Bytes == chars. | Stale by 8. Fix inline in R5; headroom = 1 − 852/1200 = **29.0 %**, not "~30 %" of 844. |
| P7 | Archive L356 Role cell = **62,356** chars | Line 356 is **62,983** chars. No single cell is 62,356 (largest is cell[11] at 29,136; the intended Role span ≈ 60,535) | Number is unreproducible under any instrument. Use **62,983 chars (line 356, `LC_ALL=C awk length()`)**. Magnitude and conclusion unchanged. |
| P8 | L356 had **17 unescaped pipes → 16 cells vs a 3-column header** | **Exactly reproduced**: 17 unescaped, 0 escaped, 16 cells, header declares 3 | Confirmed. R2's message text is literally correct. |
| P9 | §3 = 18 rows, §4 = 45 rows | 20 and 47 pipe-leading lines = header + separator + 18 / 45 | AC7 instrument pinned. |
| P10 | 11/11 repo URLs, 10/10 `/opt` paths | Repo URLs **11** ✓. `/opt` = **10** ✓ under `grep -oE '/opt/[A-Za-z0-9_.-]+' \| sort -u` (a looser regex yields 13 — instrument matters) | Both confirmed; instrument recorded. |
| P11 | Archive violates all three checks | Prototype: `LINE_TOO_LONG` (17 lines), `CELL_COUNT_MISMATCH` (356, 357, 368), `TABLE_INTERRUPTED` (**358** and **425** — the exact lines the spec cites) | **AC2 satisfiable.** |
| P12 | Current de-logged file passes | Prototype: 2 tables, **0 violations** | **AC1 satisfiable — but only under the orphan-row reading of check 3.** See §3. |
| P13 | *(9th probe)* Does the tool already do this? | No `markdownlint`/`remark` in `devDependencies`, `node_modules/.bin`, or any config. `markdown-it` is a renderer, not a linter. markdownlint MD013 + MD056 would cover checks 1–2 | Build it. Rationale recorded in §4 — MD056 cannot express check 3, cannot emit R2's LAW text, and adds a fetched dependency to a pre-commit gate. |
| P14 | Install "immediately after the existing `check_system_map.sh` call" | `hook_block_install` imposes **canonical `LC_ALL=C` name order on every write** (hook-block.sh design decision 3) → `map-shape` sorts *before* `system-map` | Position is not choosable and must not be hand-forced. The two gates are independent processes (`\|\| exit 1` each), so order is behaviourally irrelevant. Flagged, not "fixed". |
| P15 | *(unstated)* bash flavour | **bash 3.2.57 only** — no Homebrew bash at either prefix. `mapfile` absent; measured: `set -u` + `"${arr[@]}"` on an **empty** array → `unbound variable` | bash-3.2-safe constructs only; every array expansion count-guarded. |
| P16 | *(unstated)* hook install primitives | `hook_block_assert_publishable` and `hook_block_install` exist and are real; assert is **fail-closed** on a script present on no remote ref | **Push the script to a remote ref BEFORE installing the block** (the publish-ordering LAW). |

**Fictional primitives: 0.** Numeric drift: **2** (P6, P7) → below the ≥3 HALT threshold ⇒ fix
inline + flag, per `plan-mode-probes.md`.

## 2. Identifier diff — R-section vs AC-section

| Identifier | R-section | AC / Method | Verdict |
|---|---|---|---|
| `SYSTEM_MAP_SHAPE_VERDICT` | R1 token block | AC1, AC3 | ✅ identical |
| `1200` threshold | R1 default, R2 message, R5 | Method check 1 | ✅ identical |
| exit `0` / `1` / `3` | R1 | AC3 | ✅ identical — and `3` is the token-law default for a **new** gate with no incumbent code |
| Script basename | R1: `check_map_shape.sh` **or** `.mjs` | AC1–3 + gate: bare `check_map_shape` | ⚠️ resolved → **`.sh`** (R1's own "matching the sibling's language"); AC's bare form is shorthand for `bash scripts/check_map_shape.sh` |
| Archive path | Context | AC2, Verification Gate | ✅ exists, **174,174 bytes** — byte-exact match |
| Max line `844` | R5 | Context | ❌ both stale → **852** |
| `62,356` | R2 example | Method check 1 | ❌ → **62,983** |
| §3 `18` / §4 `45` | Context | AC7 | ✅ confirmed |
| `--max-line N` | R1 | — | ✅ single site |

## 3. The one design decision AC1 forces

Check 3 read naively — "a non-row line ends the table, therefore it is an interruption" —
flags the **blank line after the last row**, which is how every well-formed markdown table
terminates. Measured: that reading reports 2 violations on the *clean* file (lines 374, 426)
and **AC1 becomes unsatisfiable**.

The spec's own words are "no prose or blank line between a table's **first and last row**", so
the correct implementation is the **orphan-row** rule: a non-row line is remembered as a
*candidate* interrupter; it is only a violation if another `^|` row follows that is **not**
itself a new table header. Prose splitting a table leaves headerless continuation rows → caught.
A blank line terminating a table → clean. Measured under this rule: current file **0
violations**, archive flags **358** and **425** — precisely the lines the spec's Method table
cites. This is the only reading self-consistent with AC1, AC2 and the Method table at once.

Two further implementation decisions, beyond spec literal, both required by R1's
reusability claim (`status.md`, `CLAUDE.md` adopt it with no code change):

- **Fenced code blocks are skipped.** `CLAUDE.md` and `status.md` both contain fenced examples
  holding pipes and long lines; without this the reusable claim is false. `system-map.md` has 4
  fence markers and zero pipe-leading lines inside them, so this changes nothing for AC1/AC2.
- **Cells, not pipes, in the message.** R2's required text says "16 cells, header declares 3";
  measured, that is `pipes − 1` on both sides. Reported exactly as R2 mandates.

## 4. 9th probe — why not markdownlint

MD013 (line-length) and MD056 (table column count) are genuine first-class equivalents of
checks 1 and 2. Rejected on four measured grounds: (a) not installed — adopting it adds a
**fetched dependency to a pre-commit gate**, which the manual forbids ("bake into the repo every
piece of reference data a gate DECIDES on"); (b) **no markdownlint rule expresses check 3**
(MD055 is pipe *style*, not continuity); (c) it cannot emit R2's LAW-naming remediation text,
which is the entire point of R2; (d) its target is a file outside the repo, which markdownlint's
glob-driven config addresses awkwardly. Recorded rather than assumed.

## 5. Destructive-bash enumeration

| Act | Blast radius | Mitigation |
|---|---|---|
| `hook_block_install pre-commit map-shape …` | Writes the **shared** `pre-commit` at `/Users/tank/code/crypto-quant-signal-mcp/.git/hooks` — `core.hooksPath` is set `--local` to that absolute path, so **every** checkout (≈45 worktrees) resolves to this one file | Timestamped backup first; `hook_block_assert_publishable` run first (fail-closed); render-and-diff before install; rollback = restore the backup. This is the act that took ~70 of 74 checkouts down on 2026-08-01. |
| Push `check_map_shape.sh` to a remote ref | none | Precondition for the above, not optional |
| Edit vault `system-map.md` §5 (R5) | Vault only, unversioned | Additive single line inside the existing checklist; **no row removed, never prepended**; AC7 re-verified after |
| `package.json` scripts +2 entries | repo | `"name":`/`"version":` untouched, so the sibling gate's `^[+-].*"name":` signal does not fire |

No deletion, no truncation, no `reset --hard`, no force-push, no rsync, no prod/Hetzner touch,
no version bump, no publish. Work happens in a **dedicated worktree off `origin/main`** —
the primary checkout is **22 commits behind** `origin/main` (clean tree), per the worktree-first LAW.

## 6. Ambiguous dependencies → architect

Q1 (wiring target), Q2 (INDETERMINATE blast radius), Q3 (gate scope). See the HALT block.

---

## 7. Corrections found DURING execution (appended post-approval)

| # | Finding | Detail |
|---|---|---|
| E1 | **The target file changed mid-wave.** | `system-map.md` went **44,641 → 45,523 bytes** between the Step-0 probe and the build, line numbers shifting +10. The growth is entirely in **§2 (ASCII tree, 163 → 173 lines)** — the known-residual area, not the gated tables. Re-measured after: **2 tables, 0 violations; §3 = 18 rows; §4 = 45 rows; 11 repo URLs; 10 `/opt` dirs** — every AC still holds. Recorded because a wave that both reads and writes a concurrently-edited file must pin its claims to a version: sha256 `1b938ecb…`, 45,523 bytes. |
| E2 | **Max line is 852, not 844 — and neither is a table figure.** | Longest line is **852 chars at line 451**, a §5 *prose* bullet. The longest **table row** is **314**. Since the file is under concurrent edit, R5's number is now emitted **by the gate itself** (`max observed 852 chars at line 451; threshold 1200; 29.0% headroom`), so the instrument and the number are one artifact and cannot drift apart. |
| E3 | **The sibling's own test suite would have broken.** | `tests/unit/check-system-map.test.ts:49` copies **only** `check_system_map.sh` into a tmp repo and sets `SYSTEM_MAP_PATH`. Requiring the shared library unconditionally would have failed 3 of its 5 cases. Fixed at the design level: the library is required **only when the default is actually needed**. Single-derivation is preserved — the default literal still exists in exactly one file, asserted by test. |
| E4 | **The first mutation-proof harness produced a false SURVIVED.** | It judged each mutation by the suite's **exit code** — but the `FAIL→exit 0` mutation *breaks the exit code*, so it controlled its own verdict. Judging on the suite's **output** (assertion lines + token) caught it. This is the "callers gate on the TOKEN, never the bare exit code" law applying to the proof harness itself, and it is the reason the prove-it step is not ceremony. |
| E5 | **A too-loose test assertion flagged a real check.** | The first draft asserted no gate contains the substring `Obsidian Vault`; that flagged `check_map_shape.sh`'s own seam assertion, which greps the installed hook to prove the path is **absent** there. Asserting a string's absence is not a copy of it. Tightened to the full path literal `AlgoVault MCP/system-map.md`. A test that cannot tell those apart would push the next author to delete a real check to get green. |

## 8. Follow-ups filed, NOT built here

- `OPS-MUTATION-PROOF-GENERALISE-W{NEXT}` — `scripts/selftest-mutation-proof.sh` already parameterises its SUBJECT via `MUTATION_PROOF_SUBJECT`, but its mutation TABLE is hardcoded, so a second consumer cannot reuse it without a copy. Making the table an env/argument would let this gate's proof run from the shared harness. Not done here: it modifies another wave's artifact, which is outside this wave's scope.
- `MAP-TREE-DELOG-W1` — §2 still carries wave-IDs/dates on 23 of its (now 173) lines. Explicitly out of scope per the dispatch.
- **Out of scope, do not fold in:** `check_system_map.sh`'s exclusion list covers `landing/**` but not `docs-src/**`, so identical bytes block on one side and pass on the other. Real defect, sibling's gate, separate ops wave.
