# OPS-PREVERIFY-RED-UNREAD-W1 — 2026-10-03

**VERDICT: MEASUREMENT ARTIFACT — the checker, not the chain.** `publish-lane-preverify.yml` cried wolf for 33 days. Every one of the 38 `prepublishOnly` segments passed in every one of the 51 truncated reds; the rehearsal computed `PASS` and lost the line that said so.

## Report (as received)

> `publish-lane-preverify.yml` has been **RED for 33 days — 49 consecutive failed runs** — and three release tags were cut straight through it.

The workflow's own header carried the assumption that made the red unread:

> The named red step IS the operator signal. … A FAIL here means the NEXT RELEASE WILL FAIL; that is what makes the red actionable.

The step's error line on every truncated red:

> `::error::the publish lane is BROKEN — the next release will fail at this step.`

## Hypotheses

| H | Claim | Probe | Survived? |
|---|---|---|---|
| H1 | a recent commit broke the lane | 68 runs enumerated; first red `14b418a8` (2026-08-31T23:20Z), red since `9d2e0860` (2026-09-03T21:52Z), 49 consecutive | ❌ no lane commit — the trigger was GROWTH: the `npm pack --dry-run` listing crossed 64 KiB (1,306 → 1,318 packed files) |
| H2 | a third-party outage | zero transport signatures across all 68 logs | ❌ — and the dispatch's reason ("exit 1 proves content") was itself wrong: 51 exit-1s came from the workflow's catch-all on a MISSING token |
| H3 | the red reaches someone | 0 ledger rows, 0 canary-results records, header "NO TELEGRAM LEG" | ✅ survives — no consumer at all |
| H4 | the xrepo CI canary covers it | its watch list held 2 rows, neither publish workflow | ✅ survives — measured coverage hole |
| H5 | measurement artifact | real logs via authenticated `gh run view --log`; local rehearsal to a file vs through a pipe | ✅ **CONFIRMED** for 51 of 53 reds |

## Probes (claim / reality / resolution)

| Claim | Reality | Resolution |
|---|---|---|
| one of the 38 segments is failing | 38/38 ran; every token PASS/OK; last `LIVE_NUMERIC_CLAIMS_VERDICT=PASS` (segment 38) | the defect is the detector's exit path |
| the transition points at the monitoring-corpus segments (5/8/10/11) | all four PASS in every truncated red | the transition is the pack listing crossing the pipe capacity |
| the 2026-09-03 two-run blip was green | both runs emitted `INDETERMINATE` (segment 2 `snapshot_capabilities` DRIFT, zero tokens → vacuity branch → green) | a SECOND detector defect, fixed in the same file |
| a pipe write is synchronous on Linux | Node docs: pipes are asynchronous on POSIX; `process.exit()` abandons queued writes | the rule is the docs', measured on GHA ubuntu-latest / Node 24 |
| how the 53 reds end | 51 `NO_TOKEN_EMITTED` · 2 real `FAIL` (`34099936768`, `35815892757`: `CLAIM_COVERAGE`, healed by the next SHA) | the 2 real reds were hidden inside the artifact red |
| where the output stops | page multiples after the pack banner — 65,536 B or 73,728 B (16 / 18 × 4096) | pipe capacity, not content |
| the size threshold | pack write ≤ 65,511 B in 13/13 PASS runs; > 65,536 B in 51/51 truncated reds | exact split |
| local rehearsal → FILE | `PUBLISH_LANE_PREVERIFY_VERDICT=PASS`, 38/38 segments, 29 tokens all PASS, 1,541 packed entries, rc 0 | the classifier was right |
| local rehearsal → `\| tee` | rc 0, zero token lines | the token is lost in transit |
| `publish-npm.yml?branch=main` measures the release lane | it reads a 2026-08-26 manual dispatch; tag-push runs carry the TAG as their branch | the canary does not watch it; the readiness gate reads it on any ref |
| "the gate predicted the v1.31.0 failure" | v1.31.0 died at `Verify dist-tag` (3×20 s poll vs a 249–307 s registry lag since 2026-08-22), a step the rehearsal does not run | separate red, `Owner: OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1` |

## Bug class

> **Any verdict-emitting gate that relays large output to stdout and terminates with `process.exit()` loses its trailing verdict token when stdout is a pipe — and a caller that maps "no token" to FAIL turns a clean run into a permanent red that names the wrong cause.**

And the class the dispatch named, which was also real: **a CI gate whose only declared consumer is a human reading a UI has no consumer.**

Priors (same root cause, each a one-script fix plus a comment): `d5b7e755` (2026-08-24, `runScript` drain), `05802215` (2026-09-22, `check-caller-tags.mjs`), `f81f7da9` (2026-09-26, `check-form-action-conformance.mjs`) — this is the 4th, so the fix is structural. Ledger priors for the delivery class (case-folded): `dark guard` 18 · `no consumer` 13 · `dark gate` 5 · `installed is not working` 6.

## Generator fix

| Layer | Mechanism | Rank |
|---|---|---|
| exit path | `terminate()` sets `process.exitCode`, never `process.exit()`; a `--pipe-probe` self-test crosses a REAL pipe through the real exit path | 3 (one guarded exit path) |
| class gate | `tests/unit/verdict-exit-path.test.ts` — TypeScript-AST scan: a verdict-emitting script may not call `process.exit()`; existing debt in `ops/verdict-exit-baseline.json`, per-file counts that may only fall, the measured piped subset flagged `piped_consumer: true` | 5 (CI + pre-push gate, ratchet) |
| classifier order | an observed non-zero exit is judged before any vacuity question | 3 |
| caller | the workflow step reports a missing token as the CHECKER failing, logs node's own exit code, and still blocks | 5 |
| delivery | `publish-lane-preverify.yml` row in the xrepo CI canary `WATCHED` → `xrepo_ci_red` | 5 |
| blocking | `npm run release:readiness` — an allow-list of two workflows with per-entry branch semantics, run by Version-Bump-SOP § 2 | 2 (the one derivation every release reads) |

Why nothing higher: rank 1 (unrepresentable) is unreachable — `process.exit` is a runtime global and GitHub owns the workflow-run model. Honest scope: the readiness gate catches a REGISTERED red on two workflows; it cannot prove a release will succeed.

## Dependency envelope

| Direction | Item | State |
|---|---|---|
| backward | the badge endpoint discriminates (200; passing / failing / no status) | met |
| backward | the canary's watch list is data | met |
| backward | the canary is installed and scheduled (`41 9 * * *`) | met |
| forward | `ops/cron/xrepo-ci-conclusion-canary.sh` + inventory `watches[]` + `sha256` | updated same commit |
| forward | signal-1 host copy | re-installed with a timestamped backup |
| forward | `scripts/check-publish-lane-preverify.mjs` + inventory `sha256` + `reconcile_exempt_reason` | updated same commit |
| forward | `tests/unit/publish-lane-preverify.test.ts`, `tests/unit/release-readiness.test.ts`, `tests/unit/verdict-exit-path.test.ts` | updated / new |
| forward | Version-Bump-SOP § 2 | pre-flight block added |
| unreachable | the GitHub Actions UI | no one is obliged to read it — the finding |

## Inheritors

`scripts/check-docs-samples-live.mjs`, `scripts/check-readme-links.mjs`, `scripts/classify-suite-verdict.mjs`, `scripts/check-smithery-sync.mjs` — verdict tokens read through `| tee` in CI, each ending in `process.exit()`, each inheriting the ratchet (and 10 more piped consumers recorded in the baseline). For the delivery class: `readme-snapshot-writeback.yml` and `monitoring-schedules.yml`, each one canary row, no code.

## Verdict tokens

| Token | Value | Evidence |
|---|---|---|
| `PUBLISH_LANE_PREVERIFY_VERDICT` | **PASS** — first since 2026-08-30 | push run `37116112603` and `workflow_dispatch` run `37116129802`, both at `b93e40b2`, both `node exit 0`; badge `passing` |
| `PUBLISH_LANE_PREVERIFY_VERDICT` (two-direction, same tree, through `\| tee`) | post-fix PASS / pre-fix no token | `b93e40b2`: fixed script 79,016 B after the pack banner + token; previous script cut at 65,536 B, 0 token lines |
| `RELEASE_READINESS_VERDICT` | FAIL at CH1 (`RED=publish-lane-preverify.yml,publish-npm.yml`) → FAIL after CH2 (`RED=publish-npm.yml`) | the remaining red is `publish-npm.yml`'s `Verify dist-tag` (Owner: `OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1`) |
| `XREPO_CI_VERDICT` (self-test) | PASS | 133 assertions in the checkout, 132 on signal-1 (inventory parity is skipped there by design); deliberate breaks red 3/128 and 14/133 |
| `XREPO_CI_VERDICT` (first scheduled run with the new row) | pending | the `41 9 * * *` fire on 2026-10-04 — recorded as GREEN_PENDING_FIRST_RUN, never manufactured by hand |
| `INSTALL_MONITORING_ARTIFACT_VERDICT` | PASS | signal-1 `50818cd4…` → `77c7d057…`, backup `.bak.OPS-PREVERIFY-RED-UNREAD-W1-20261003T095117Z` taken before the swap |
| `TEST_GATE_VERDICT` / `LAND_VERDICT` | PASS / LANDED ×2 | `bc183b40` (CH1), `b93e40b2` (CH2) |
| `CH1_GREEN` · `CH2_GREEN` | ✅ · ✅ | CH2's readiness leg is a declared relaxation: it asserts `publish-lane-preverify.yml` is not red, since the aggregate stays red on the foreign `publish-npm.yml` |

### Pre-landing adversarial review

Three reviewers over the CH1+CH2 diff, each finding re-reproduced by an independent skeptic: **12 confirmed, 0 refuted.** Ten fixed before landing (`b93e40b2`): an unconditional early-transport check and a whole-output transport scan that both laundered later content failures; a single-segment chain classed "unparseable" before its exit code; an early-step FAIL printing no diagnosis; a module-scope throw made reachable by the exit fix; a symlinked invocation exiting 0 with no token (both gates); the scanner missing the `${GATE}_VERDICT=` form and false-flagging trading-domain constants; a missed piped consumer (the robots-allowlist cron); a blind "not in the workflow" assertion. Two are honest-scope limits recorded in `scripts/check-release-readiness.mjs`: a green pre-verify badge can be an INDETERMINATE run, and `publish-npm.yml` can only turn green through a publish-npm run that, today, only a release produces — so the readiness gate holds a release spec until its owner adds a verify-without-publish path.

The wave's own two-direction rehearsal also caught a real content FAIL before landing (`TEST_BUDGET_VERDICT=FAIL`: a regex literal's raw `\(` left `check-test-budget.mjs`'s paren-balancer open) and reported it as FAIL with the token intact — the first live evidence that the repaired checker reports what it sees.
