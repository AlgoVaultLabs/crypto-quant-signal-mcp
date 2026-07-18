# OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1 — root cause + verification

**Date:** 2026-07-18 · **Target ICP tier(s):** META (test-infra / release-gate reliability)
**Symptom:** `tests/analytics-external-only.test.ts` passes alone (15/15) but intermittently
fails the pre-push gate (`scripts/check_test_baseline.sh`). Blocked a docs-only push on
2026-07-18, cleared on rerun (see status.md, OPS-NPM-TRUSTED-PUBLISHING-MIGRATION-W1 §push
mechanics (c)).
**Outcome:** FIXED, not quarantined — `audits/test-baseline-known-failures.txt` still lists
**zero** known-failing files.

---

## TL;DR

Two independent defects, both measured, both fixed:

| # | Defect | Blast radius | Repro rate (measured) |
|---|---|---|---|
| **A** | `vitest.config.ts` used the DEFAULT unanchored `include`, which does not honor `.gitignore` → the suite collected every **nested git worktree** under `.claude/worktrees/` | **1779 files discovered vs 299 real (83% stale duplicates)** from 5 nested worktrees, incl. 5 extra copies of the victim file | deterministic when run from the primary checkout |
| **B** | The victim asserts pre/post **deltas on WHOLE-TABLE aggregates** while other processes INSERT into `request_log` on the shared `~/.crypto-quant-signal/performance.db` | this file only | **5/5** with a concurrent writer · **1/15** in-run, serial |

---

## Defect A — nested-worktree test discovery

`CLAUDE.md` makes one-worktree-per-parallel-session LAW, and native `claude -w` places full
checkouts at `.claude/worktrees/<session>/`. Those are gitignored (`.gitignore:14`) — but
**vitest does not read `.gitignore`**, and `configDefaults.exclude` covers `.git`/`.cache`/
`.idea`/`.output`/`.temp`, *not* `.claude`.

Measured from `/Users/tank/code/crypto-quant-signal-mcp` (`npx vitest list --filesOnly`):

```
TOTAL discovered:            1779
from nested worktrees:       1480   (83%)
legitimate (own tests/):      299
  docs-generator-from-nav-sot-w1  308
  selfhost-plausible-ce           308
  ops-attribution-ai-referral-w1  306
  funnel-auth-unify-w1            296
  ops-geo-probe-multi-run-w1      262
```

All 6 copies of `analytics-external-only.test.ts` ran **concurrently against the one shared
SQLite DB with identical sentinel keys**, and each copy's `beforeEach` runs
`DELETE FROM request_log WHERE tool_name = 'test_dash_ext_w1'` — deleting its siblings' rows
mid-flight. That produces **both** directions of failure, which is the signature that first
separated A from B:

- over-count — `expected 4 to be 2`, `expected 3 to be 2` (sibling INSERTs)
- under-count — `expected +0 to be 1`, `expected undefined to be defined` (sibling DELETEs)

**Fix:** anchor discovery at `tests/` (allow-list, not deny-list). A nested checkout's path
(`.claude/worktrees/X/tests/…`) cannot match a pattern rooted at `tests/`, so a *new* nesting
location cannot reintroduce the leak. A `**/.claude/worktrees/**` exclude is kept as a
documented backstop, and `tests/unit/vitest-discovery-scope.test.ts` fails if either is
weakened.

**Verified (A/B against a nested-worktree fixture):**

| config | `.claude/worktrees/fake-session/tests/dummy.test.ts` collected |
|---|---|
| unanchored default (pre-fix) | **1** |
| anchored `tests/**` (post-fix) | **0** |

> Note: defect A is **not** what bit on 2026-07-18 — that gate run reported 297 files, i.e. it
> ran from a clean sibling worktree. A is a latent, more severe defect found while reproducing.
> It is currently masked in the primary checkout by a *second* problem: its `node_modules` is
> stale (missing `@circle-fin/x402-batching`, `@virtuals-protocol/acp-node-v2`,
> `@okxweb3/x402-evm`), so `npm run build` fails and the gate **fails OPEN, skipping all tests**.
> Tracked separately.

## Defect B — whole-table delta assertions vs concurrent writers

The file asserts, on aggregates computed over the **entire** `request_log` table:

```ts
expect(post.totalCalls.allTime - preTotal).toBe(2);          // and the genuine/automated split
expect(d((s) => s.totalCallsExternal.last24h)).toBe(7);
```

Those deltas are exact only if nothing else writes `request_log` between the snapshots. Six
other test files do (`pql`, `subscriber-bridge`, `funnel-snapshot`, `funnel-scoreboard`,
`x402-paid-path`, `performance-public-shape`), **and** a concurrent vitest run in another
worktree writes the same shared DB — routine here, since every push runs the full suite through
the pre-push gate and parallel sessions are LAW. The 2026-07-18 incident coincided with a
parallel Circle-Gateway session.

Reproduced deterministically with a controlled second process INSERTing external
`request_log` rows while the victim ran **alone** (its documented-green baseline):

| arm | victim failures | assertion |
|---|---|---|
| unfixed | **5 / 5** | `expected 6 to be 2`, `expected 8 to be 2` |
| fixed | **0 / 5** | — |

In-run (serial full suite, no second process): **1 / 15** unfixed.

**Fix:** `beforeAll` points `performance-db` at a private per-file SQLite DB via the
`PERFORMANCE_DB_PATH` seam (default-preserving; never set in prod, where `DATABASE_URL`
selects Postgres), restored in `afterAll`.

### Correction to the first cut

The original commit keyed the temp DB on
`VITEST_POOL_ID ?? VITEST_WORKER_ID ?? process.pid` and claimed a concurrent run "can't
collide". **That claim is false.** `vitest/dist/worker.js:74` does
`process.env.VITEST_POOL_ID = String(workerId)` — a small integer restarting at 1 in every
run — so two concurrent vitest processes both resolve to
`<tmp>/cqs-analytics-ext-only-1.db` in the machine-global tmpdir and clobber each other,
reinstating the exact race the isolation exists to prevent (class:
`shared-sqlite-test-sentinel-prefix-collision`). Replaced with `fs.mkdtempSync`, which is
OS-guaranteed-unique per process.

---

## Ruled out (checked, not assumed)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Generator writes a shared landing/HTML artifact | ruled out | file reads no generated artifact |
| Lost writes via `SQLITE_BUSY` under WAL contention | **refuted** | instrumented `logRequest`'s blind `catch {}` across a failing run — **zero** errors captured; better-sqlite3 also defaults `busy_timeout` to 5000ms |
| `HOME` leakage between files sharing a worker process | ruled out | `performance-db-migration.test.ts:45-46` and `agent-sessions.test.ts:53-54` both restore `HOME` in `afterAll` |
| Sibling DB tests share the racy whole-table pattern | ruled out | none of the 6 sibling writers assert whole-table deltas — scope is this file alone |

## Residual unknown (honest)

One serial-run failure (run 14/15) was an **under**-count — `expected +0 to be 1` on the
file's *own* just-written row — which the delta-race mechanism does not explain, and which
the later instrumented run did not recur to capture. The private-DB isolation removes all
cross-file and cross-process interference, so it is covered either way, but the mechanism is
unconfirmed. It is *unobservable by construction*: `logRequest` wraps its write in
`catch { /* Never fail the request */ }` with **no** log on the failure path, so any throw is
silently discarded — contrary to this repo's own "load-bearing side-effect needs a
success-path log" rule. Tracked as a follow-up.

## Verification

- `scripts/check_test_baseline.sh` (build + full vitest + node:test canaries + baseline diff)
  → **GREEN**, `0 allow-listed`.
- Discovery-scope canary: 3/3.
- Victim alone: green. Victim + concurrent writer: 0/5 failures (was 5/5).
- Changed files: `vitest.config.ts`, `tests/analytics-external-only.test.ts`,
  `tests/unit/vitest-discovery-scope.test.ts` (+ this audit). **No `src/**` change** — the
  `PERFORMANCE_DB_PATH` seam in `src/lib/performance-db.ts` landed in the parent commit and is
  unmodified here.
