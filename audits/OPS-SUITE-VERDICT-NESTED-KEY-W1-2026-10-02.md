# OPS-SUITE-VERDICT-NESTED-KEY-W1 — 2026-10-02

The deploy gate's suite classifier (`scripts/classify-suite-verdict.mjs`) misread every failure inside a `describe` block. A load-induced timeout read **FAIL**. A `beforeAll` that threw read **PASS**.

## Report (as received)

During EDGE-ADS1-SCORECARD-W1-V3 CH3-A there were three consecutive full-suite runs at load average ~12. Each failed on a different foreign spawning test with `Error: Test timed out in 5000ms.`:

- `tests/unit/lifecycle-readout-cron.test.ts` 'pages on a rollback EVENT…'
- `tests/unit/boot-contract-acknowledged.test.ts` 'a name in BOTH lists is INDETERMINATE…'

Each test passed when run on its own. The classifier returned `SUITE_VERDICT=FAIL`. For a timeout it should return `PASS_AFTER_ISOLATION` or `INDETERMINATE`.

## Hypotheses

| # | Claim | Probe | Survived? |
|---|---|---|---|
| H1 | The sidecar key and the report key are rendered differently, so the join misses and the string channel's safe default fires | Captured a real nested timeout. Sidecar key `…::an outer suite > an inner suite > a nested test…`; report key `…::an outer suite an inner suite a nested test…`; `index.has(key)` → `false`; CLI → `SUITE_VERDICT=FAIL` | ✅ mechanism |
| H2 | `INDETERMINATE_PATTERNS` no longer matches the vitest 3.2.4 timeout text | `classifyShape` on the captured sidecar message returns `indeterminate` | ❌ |
| H3 | The tests are genuinely broken | Each passes standalone (reporter's measurement); the captured repro is a pure timeout | ❌ |
| H4 | The file component of the key differs, as in `0fed536e` | Both printed keys carry the identical repo-relative file; only the name component differs | ❌ |
| H5 | The red is a measurement artifact of the instrument, not of the code | The code under test was fine. The classifier measured the wrong test identity | ✅ (H1 is its mechanism) |

## Probes (claim / reality / resolution)

| Claim | Reality | Resolution |
|---|---|---|
| The reporter keys on `testCase.fullName` | vitest 3.2.4 `cli-api` builds `TestCase.fullName` as `` `${parent.fullName} > ${name}` `` | Identity is now a title path, never a rendered name |
| `extractFailures` keys on the JSON `fullName` | The JSON reporter builds `[...ancestorTitles, t.name].join(" ")` | Same as above |
| Both renderings start from one source | Both walk `task.suite` (`TestCase.parent` is built from `task.suite`) | Both channels now emit that chain as an array, and one function keys it |
| A `beforeAll` failing inside a `describe` reaches the classifier | The JSON report shows `success:false`, `numFailedTests:0`, file `message:""`, and every test `skipped`. `extractFailures` required a message, so the classifier returned `SUITE_VERDICT=PASS` (exit 0) and the deploy was permitted | Fixed in the same wave: a failed file with no failed test is a suite failure even with no message. The reporter now records suite errors (`onTestSuiteResult`) |
| The fixture corpus covers nesting | All 4 captured fixtures were top-level tests, the one shape where both renderings agree | 5 nested fixtures were captured, and the self-test refuses a corpus without them |

## Bug class

**Any classification the suite-verdict gate built from a rendered name or a flat file record assumed a flat test tree. As a result, every failure inside a `describe` was either mis-keyed (a timeout read FAIL) or unseen (a suite-hook failure read PASS).** The general form: two channels that each derive a join key will drift apart, and the miss falls through to a default.

Priors, counted by root cause ("this gate read a timeout as FAIL"):

1. 2026-08-17: string channel, before the sidecar existed.
2. 2026-08-21: the JSON reporter replaces the timeout message with `STACK_TRACE_ERROR`.
3. `0fed536e`: the file component of the key missed on CI.
4. This wave.

That makes this the 4th occurrence, so the fix must be structural.

## Generator fix

- **Rank 2, single derivation.** `scripts/lib/vitest-test-identity.mjs` owns test identity: `normFile`, a title path for each channel, `testKey(kind, file, path)`. The reporter and the classifier both import it. Neither side joins strings, so no separator is left to disagree on. The space-join collision (`describe('a b') > it('c')` vs `describe('a') > it('b c')`) also goes away.
- **Rank 5, a miss is loud.** With a sidecar declared, a failed test that finds no sidecar entry is UNJOINED:
  - It is never retried and never called a regression.
  - It reads `INDETERMINATE` (exit 3), and the output names both sides of the miss.
  - Positive assertion evidence in the message still makes it FAIL.
- **Backstop.** If vitest's `success:false` but nothing is extractable, the verdict is `INDETERMINATE`, never PASS.
- **Index safety.** Duplicate test names merge their shapes, never overwrite, so an assertion is never masked by a namesake's timeout. Sidecar entries without a structured identity (schema 1) are refused.
- Rank 1 was unreachable: the two channels are vitest's own renderers and cannot be made one type.

**Honest scope.** The join covers per-test failures and nested suite hooks. Module-level errors (collection errors, top-level hooks) still go through the string channel, which carries their message faithfully; the `collection-error` fixture pins that. vitest *unhandled errors* (`Timeout calling "onTaskUpdate"`) do not affect the JSON `success` field and are not covered. Their behaviour is unchanged.

## Dependency envelope

| Direction | Item | State |
|---|---|---|
| Backward | vitest 3.2.4 pinned by the lockfile; both renderers walk `task.suite` | met (source read) |
| Forward | `.github/workflows/deploy.yml` verdict step + floor proof | updated in the same commit; the floor proof now runs the top-level, nested and hook timeouts |
| Forward | `scripts/gates/{ads1-amend,ads1-ch2,cce-ch1,cce-ch2,cmc-ch1,cmc-ch2,lrw-ch2,oah-ch1,oah-ch2}-gate.sh` | unchanged: same CLI, same token; they run the reporter and classifier from one checkout |
| Forward | `defaultRunner` isolation retry | unchanged path; it now receives repo-relative files (cwd = REPO) |
| Forward | `tests/fixtures/verdict-channel/*` | re-captured by `scripts/capture-verdict-fixtures.mjs`; `ci-green-run.shapes.json` kept unmodified and still usable |

**Inheritors:**

- the nested-describe timeouts measured on 2026-10-02;
- any `beforeAll`/`afterAll` failure inside a `describe`;
- a vitest upgrade that changes either renderer (now caught by the live identity test and, at runtime, by the join miss);
- a test with a duplicated name.

## Verdict token

`SUITE_VERDICT=PASS|PASS_AFTER_ISOLATION|FAIL|INDETERMINATE` → exit `0|0|1|3`, unchanged.
