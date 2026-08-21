import { defineConfig, configDefaults } from 'vitest/config';

// OPS-VITEST-SUITE-REPAIR-W1 / C3 — runner-ownership split.
//
// This repo has TWO test runners with non-overlapping ownership:
//   • vitest      (`npm test` = `vitest run`)  — all tests/**/*.test.ts plus the
//     single vitest-authored tests/unit/snapshot-capabilities.test.mjs.
//   • node:test   (`node --test …`, invoked by .github/workflows/deploy.yml) —
//     the landing/design/geo "consistency" canaries written against
//     `node:test` + `node:assert/strict`.
//
// vitest's DEFAULT `include` (`**/*.test.{ts,mjs}`) also matches the node:test
// `.test.mjs` files. Those files register with node:test's runner, so vitest
// finds no vitest suite and reports "No test suite found in file …" — 13 false
// failures. `node --test tests/unit/<them>` runs all 464 of their assertions
// GREEN. The canonical runner for them is node:test, so we EXCLUDE them from
// vitest here (project-scoping only — `npm test` semantics for every other file
// are unchanged).
//
// NOTE: tests/unit/snapshot-capabilities.test.mjs imports from 'vitest' and is a
// genuine vitest file — it is deliberately NOT excluded.

// OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1 / 2026-07-18 — ANCHOR discovery at tests/.
//
// vitest's DEFAULT `include` is `**/*.{test,spec}.?(c|m)[jt]s?(x)` — an unanchored
// walk from the repo root that does NOT honor .gitignore. This repo's worktree-first
// workflow (CLAUDE.md: every parallel session gets its own worktree) puts FULL
// checkouts under `.claude/worktrees/<session>/` via native `claude -w`. They are
// gitignored (.gitignore:14) but still on disk, so the default glob collected THEIR
// tests too.
//
// Measured from the primary checkout on 2026-07-18: **1779 test files discovered,
// of which 1480 (83%) were stale duplicates from 5 nested worktrees** — including 5
// extra copies of tests/analytics-external-only.test.ts. Every copy wrote the SAME
// sentinel rows to the SAME shared ~/.crypto-quant-signal/performance.db while each
// copy's beforeEach DELETEd the others' rows, so the suite produced both over-counts
// (`expected 4 to be 2`) and under-counts (`expected +0 to be 1`). That is a
// nondeterministic gate by construction, and it silently ran other branches' code.
//
// Anchoring at `tests/` makes the leak structurally impossible: a nested checkout's
// path (`.claude/worktrees/X/tests/…`) cannot match a pattern rooted at `tests/`.
// Allow-list, not deny-list — a NEW nesting location cannot reintroduce it.
// Guarded by tests/unit/vitest-discovery-scope.test.ts.
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [
      ...configDefaults.exclude,
      // Backstop only — the anchored `include` above already makes these
      // unreachable. Kept so the hazard stays documented and so a future widening
      // of `include` cannot silently re-open the leak.
      '**/.claude/worktrees/**',
      'tests/unit/design_w*_consistency.test.mjs',
      'tests/unit/geo_answer_page_invariants.test.mjs',
      'tests/unit/geo_jsonld_consistency.test.mjs',
      'tests/unit/how_it_works_consistency.test.mjs',
      'tests/unit/landing_faq_glossary_substrate.test.mjs',
      // OPS-CADDY-ROUTE-PARITY-W1 — node:test apex-route-parity guard (canonical runner is
      // node:test; exclude from vitest so it doesn't false-fail "No test suite found").
      // OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W1 — node:test alert-remedy canary (canonical
      // runner is node:test; exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/alert-recommended-wave.test.mjs',
      'tests/unit/alert-wrapper-clear.test.mjs',
      'tests/unit/alert-registry.test.mjs',
      // OPS-ALERT-REGISTRY-DECLARE-W1 — node:test consumption-derived declaration-coverage
      // guard (canonical runner is node:test; exclude from vitest so it doesn't false-fail
      // "No test suite found").
      'tests/unit/declaration-coverage.test.mjs',
      'tests/unit/caddy-route-parity.test.mjs',
      // ATTRIBUTION-SRC-COVERAGE-W1 — node:test acquisition `?src=` coverage canary (same
      // node:test ownership; exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/attribution-src-coverage.test.mjs',
      // FOOTER-UNIFY-W1 — node:test footer-drift canary (canonical runner is node:test;
      // exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/footer-unify-canary.test.mjs',
      // OPS-LANDING-ASSET-CACHE-BUST-W1 — node:test asset-version stamp canary (canonical
      // runner is node:test; exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/asset-version-stamp.test.mjs',
      // LANDING-DUAL-RENDER-PARITY-W1 — node:test dual-render copy-drift canary (canonical
      // runner is node:test; exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/landing-dual-render-parity.test.mjs',
      // P1-TRACK-RECORD-LEADERBOARD-W1 — node:test + jsdom leaderboard behavioral suite
      // (canonical runner is node:test; exclude from vitest so it doesn't false-fail
      // "No test suite found").
      'tests/unit/p1_track_record_leaderboard.test.mjs',
      // OPS-AOE-MONITORING-PARITY-W1 — node:test shared-primitive registry/parity canary
      // (canonical runner is node:test; exclude from vitest so it doesn't false-fail
      // "No test suite found"). The pre-push gate detects node:test files by CONTENT, so it
      // picks this up automatically.
      'tests/unit/monitoring-primitive-parity.test.mjs',
      // OPS-HOST-EXPOSURE-POSTURE-W1 — node:test guard on the declared network posture
      // (canonical runner is node:test; exclude from vitest so it doesn't false-fail
      // "No test suite found"). Same content-detection note as the parity canary above.
      'tests/unit/network-posture-declaration.test.mjs',
      // OPS-SHARED-WORKTREE-STATE-REGISTRY-W1 — node:test property suite for the shared
      // git-hook block emitter (canonical runner is node:test; exclude from vitest so it
      // doesn't false-fail "No test suite found"). Same content-detection note as above.
      'tests/unit/hook-block.test.mjs',
      // (OPS-VITEST-MAIN-RED-FIX-W1's CI exclusion of check-system-map.test.ts is GONE.
      // Its TODO stated its own condition — "make the script's mtime probe portable, then drop
      // this exclusion" — and OPS-MAP-GATE-STAT-PORTABILITY-W1 did that. The diagnosis in that
      // comment was CORRECT and was briefly retracted in error: GNU `stat -f` is --file-system,
      // so the old `A || B` chain never fell through, poisoned MAP_MTIME with filesystem text and
      // died in `$(( ))` under set -u. An exclusion is how a known bug survives; do not re-add it.)
    ],
  },
});
