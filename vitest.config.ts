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
    ],
  },
});
