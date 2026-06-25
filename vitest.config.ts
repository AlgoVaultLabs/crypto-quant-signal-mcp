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
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/unit/design_w*_consistency.test.mjs',
      'tests/unit/geo_answer_page_invariants.test.mjs',
      'tests/unit/geo_jsonld_consistency.test.mjs',
      'tests/unit/how_it_works_consistency.test.mjs',
      'tests/unit/landing_faq_glossary_substrate.test.mjs',
      // OPS-CADDY-ROUTE-PARITY-W1 — node:test apex-route-parity guard (canonical runner is
      // node:test; exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/caddy-route-parity.test.mjs',
      // ATTRIBUTION-SRC-COVERAGE-W1 — node:test acquisition `?src=` coverage canary (same
      // node:test ownership; exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/attribution-src-coverage.test.mjs',
      // FOOTER-UNIFY-W1 — node:test footer-drift canary (canonical runner is node:test;
      // exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/footer-unify-canary.test.mjs',
      // LANDING-DUAL-RENDER-PARITY-W1 — node:test dual-render copy-drift canary (canonical
      // runner is node:test; exclude from vitest so it doesn't false-fail "No test suite found").
      'tests/unit/landing-dual-render-parity.test.mjs',
      // P1-TRACK-RECORD-LEADERBOARD-W1 — node:test + jsdom leaderboard behavioral suite
      // (canonical runner is node:test; exclude from vitest so it doesn't false-fail
      // "No test suite found").
      'tests/unit/p1_track_record_leaderboard.test.mjs',
    ],
  },
});
