# OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1 — probes, design decision, verification

**Date:** 2026-07-18 · **Target ICP tier(s):** META (release-gate integrity)
**Problem:** `scripts/check_test_baseline.sh` could skip the ENTIRE suite and still exit 0,
with only a single stderr line to say so. The primary checkout did exactly that for 17 days.

---

## Step 0 — probes (all live, none assumed)

| # | probe | result |
|---|---|---|
| P1 | `npm run build; echo $?` in the primary checkout (NOT piped — a pipe masks the exit code) | **exit 2**, 4 × `error TS2307: Cannot find module` |
| P2 | `ps aux` for processes using the primary checkout before `npm ci` would wipe `node_modules` | none — safe to reinstall |
| P3 | the 3 packages: declared in `package.json`? installed? | all three **declared**, all three **MISSING**; `node_modules` mtime **Jul 1** (17 days stale) |
| P4 | `bash scripts/check_test_baseline.sh; echo $?` | **one stderr WARNING line, exit 0, ZERO tests run** — symptom reproduced verbatim |

The failing specifiers included **subpaths** — `@circle-fin/x402-batching/server`,
`@okxweb3/x402-evm/exact/server` — so any classifier must reduce a specifier to its package
name scope-aware (`@scope/pkg/sub` → `@scope/pkg`) before a manifest lookup.

## The design decision

The brief asked to evaluate (a) distinguishing recoverable-vs-genuine build failures and
(b) a louder/recorded fail-open, and to justify a choice. **Both shipped, because they solve
different halves and neither is sufficient alone.**

There are two build-failure classes with *opposite* correct responses:

- **RECOVERABLE — stale/missing `node_modules`.** Not a code defect. Nothing for a human to
  fix. There is no reason to skip the suite: one `npm ci` makes the gate meaningful again.
  Failing open here is simply wrong, and it is the class that actually bit — three times
  (this wave, plus CIRCLE-GATEWAY-MIGRATE-W1's "honest caveat" and the OIDC wave's 92-file
  failure, both in status.md 2026-07-18).
- **COMPILE_ERROR — a genuine TS error.** Policy says fail open: it surfaces via
  build/deploy, not this gate. **Unchanged by this wave.**

So classification is not gold-plating: it converts the common case from *silently ungated* to
*actually gated*. Only the genuinely-unrecoverable remainder still fails open — and that
remainder is now loud and recorded.

**Why the ledger is read back.** A marker file nobody opens is theatre (and this repo says so
explicitly). So the ledger is not write-only: the next GREEN run **reports** every ungated push
since the last green gate, then clears it — the record surfaces exactly when someone is looking
at gate output, and is retired precisely when the suite has actually covered those commits.

**Conservative by construction.** The classifier returns COMPILE_ERROR for anything it is not
certain about — a non-TS2307 error, a mixed log, a relative-path import, an undeclared package,
a declared-AND-installed package, or a build with no TS errors at all (OOM / tsc crash). A
genuine defect can therefore never be masked by a pointless reinstall; the failure mode is
"fell back to the old behaviour", never "hid a real error".

**Guards on the auto-`npm ci`:** runs at most once, never on CI, never without a lockfile,
and disabled by `ALGOVAULT_TEST_GATE_AUTOINSTALL=0`. It announces itself before starting
("this can take a few minutes; the push is NOT hung") because a silent multi-minute pause in a
pre-push hook reads as a hang. If `npm ci` itself fails, the gate fails open loudly and says
`node_modules` may now be incomplete.

**Considered and rejected:** on a genuine compile error, run the suite anyway (only the two
`dist/`-reading tests would fail). Rejected — it would let a compile error block a push
indirectly, which *would* change the documented policy the brief said not to change without
flagging. Noted here as the open option if that policy is ever revisited.

## Verification

| proof | expectation | result |
|---|---|---|
| unit — `tests/unit/test-gate-build-classifier.test.ts` | 11 cases pin the decision boundary incl. the MIXED case (real error + recoverable one) | **11/11 pass** |
| **A** — remove a declared package, run the gate | classify RECOVERABLE → `npm ci` → rebuild → **run the suite** → GREEN | ✅ recovered and reported `GREEN … (0 allow-listed)`; previously this push would have been silently ungated |
| **B** — inject a real TS error, run the gate | still fails open (policy) but with a banner + ledger entry | ✅ banner printed, `COMPILE_ERROR`, ledger row written, exit 0 |
| **C** — remove the error, run the gate | next GREEN reports and clears the ledger | ✅ `NOTE: 1 push(es) went UNGATED since the last GREEN gate: …`, ledger truncated to **0 bytes** |
| Part 1 — primary checkout | `npm ci`, then `npm run build` exits 0 | ✅ `npm ci` exit 0, **build exit 0, 0 TS errors** |

## ⚠ Part 1's second half is BLOCKED — and not by anything in this wave

The brief also asked to confirm the gate "actually runs the suite and reports GREEN" in the
primary checkout. It runs the suite now (the build passes), but it **cannot report GREEN**,
because between this wave being dispatched and being executed, `origin/main` acquired two
reverts of OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1:

```
d26a59d Revert "fix(test): isolate analytics-external-only to its own SQLite DB …"
543cbb7 Revert "fix(test): anchor vitest discovery at tests/ + per-process private DB …"
```

Both authored `test <test@test.local>` at 2026-07-18 15:13 +0800, with no stated reason. They
removed the anchored `vitest` `include`, the discovery-scope canary, and the private-DB
isolation. Consequence, measured: the primary checkout is **back to 1780 discovered test
files** — ~1480 of them stale duplicates from the 5 still-present `.claude/worktrees/`
checkouts, which is precisely the nondeterminism that wave removed.

### Measured consequence: the primary checkout's gate is now hard RED, not merely flaky

With `npm ci` done the build passes, so the gate now **runs the suite** there (that half of
Part 1 works). It then exits **1** with **25 failing files** in 1m34s:

- ~15 are node:test `.mjs` canaries (`design_w3-w11`, `geo_*`, `footer-unify-canary`,
  `caddy-route-parity`, `landing-dual-render-parity`, `p1_track_record_leaderboard`,
  `how_it_works`, `landing_faq_glossary_substrate`, `attribution-src-coverage`);
- the rest are the shared-SQLite races (`analytics-external-only`, `funnel-snapshot`,
  `api-performance-public`, `attribution-connect`, …).

The `.mjs` group is **entirely an artifact of nested collection**, proven directly:

```
$ npx vitest list --filesOnly | grep design_w3_consistency
.claude/worktrees/funnel-auth-unify-w1/tests/unit/design_w3_consistency.test.mjs
.claude/worktrees/docs-generator-from-nav-sot-w1/tests/unit/design_w3_consistency.test.mjs
.claude/worktrees/ops-geo-probe-multi-run-w1/tests/unit/design_w3_consistency.test.mjs
.claude/worktrees/ops-attribution-ai-referral-w1/tests/unit/design_w3_consistency.test.mjs
.claude/worktrees/selfhost-plausible-ce/tests/unit/design_w3_consistency.test.mjs
$ node --test tests/unit/design_w3_consistency.test.mjs   # the OWN copy
→ passes
```

Five nested copies collected, **zero** of the repo's own copy — because the existing exclusion
`'tests/unit/design_w*_consistency.test.mjs'` (and every other entry in that list) is anchored
at `tests/unit/`, so it protects only the own copy while nested paths starting
`.claude/worktrees/…` bypass all of them. Note the gate's reporter normalises paths with
`sed "s#.*/tests/#tests/#"`, which is why these read as ordinary `tests/unit/…` names — the
nested origin is invisible in the failure list. An anchored `include` is the only thing that
closes this, which is what the reverted commit did.

**Net effect for the operator:** before this wave, pushes from the primary checkout were
silently UNGATED. After the `npm ci`, they are BLOCKED (exit 1) until either the anchor is
restored or the 5 stale nested worktrees are removed. That is a strictly more honest state —
the gate is telling the truth instead of skipping — but it does need an operator decision to
clear. Pushes from any sibling `cqsm-wt-*` worktree are unaffected and work normally today.

**This wave did NOT re-apply the reverted commits.** Re-applying someone's revert is the same
class of unauthorized history action as reverting shipped work, so the branch was rebased onto
the post-revert `main` (`d26a59d`) and contains only the gate changes. Restoring the flake fix
is an operator decision, not a side effect of this wave.

Nothing here depends on that fix: the classifier, the recovery and the ledger are all verified
independently in a clean worktree (proofs A/B/C above).
