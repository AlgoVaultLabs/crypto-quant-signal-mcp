/**
 * OPS-SUITE-VERDICT-REPORTER-CHANNEL-W1 CH1 — the structured error, written beside the JSON report.
 *
 * WHY THIS EXISTS. `classify-suite-verdict.mjs` has to tell a TIMEOUT ("the suite did not finish
 * deciding") from an ASSERTION FAILURE ("the code is wrong"). It classified on vitest's
 * `--reporter=json` output, and that reporter is STRUCTURALLY INCAPABLE of carrying the
 * distinction: it renders a timeout's `failureMessages[0]` as the placeholder
 *
 *     Error: STACK_TRACE_ERROR
 *
 * Measured on vitest 3.2.4 (the lockfile-pinned version CI installs): the literal string
 * "timed out" appears ZERO times anywhere in `.vitest-report.json` for a timing-out test. So every
 * `INDETERMINATE_PATTERNS` entry missed, `classifyMessage()` fell through to its safe
 * `'assertion'` default, and a timeout-only run returned FAIL. The gate built to stop a timeout
 * reading as a regression could not stop a timeout reading as a regression, from the day it
 * shipped. It fails CLOSED, so nothing unsafe ever deployed — the loss is the chapter's value.
 *
 * This reporter reads the SOURCE the JSON reporter renders FROM — the error objects vitest hands
 * a reporter through `onTestCaseResult` — and writes them to a sidecar the classifier consumes.
 *
 * -- WHAT THE SIDECAR ACTUALLY BUYS, STATED PRECISELY -------------------------------------------
 *
 * It is tempting to describe this as "the structural discriminator", i.e. `name: "Error"` with no
 * `diff`/`expected`/`actual` means timeout. THAT IS FALSE, and believing it would launder real
 * bugs into INDETERMINATE. Measured, same vitest, five real failure shapes:
 *
 *     test              err.name        diff   expected  actual   message
 *     assertion         AssertionError  yes    yes       yes      expected 1 to be 2
 *     TypeError         TypeError       no     no        no       Cannot read properties of null
 *     throw new Error   Error           no     no        no       boom custom
 *     TIMEOUT           Error           no     no        no       Test timed out in 200ms.
 *     rejected Range    RangeError      no     no        no       bad range
 *
 * A plain `throw new Error('boom')` is BYTE-IDENTICAL to a timeout in `name`/`diff`/`expected`/
 * `actual`. The only field that separates them is the MESSAGE — and the message is exactly what
 * the JSON reporter destroys. So the sidecar's contributions are, in order of importance:
 *
 *   1. MESSAGE FIDELITY. The real `Test timed out in 200ms.` survives, so the existing
 *      `INDETERMINATE_PATTERNS` finally evaluate against the text they were written for.
 *   2. A POSITIVE assertion signal. `AssertionError` + the `diff`/`expected`/`actual` triple is
 *      affirmative evidence of a real failure, independent of any message wording.
 *
 * This is why the classifier still consults the patterns on the structured path, and why they are
 * NOT redundant with it. See the classification order in `classify-suite-verdict.mjs`.
 *
 * -- REGISTRATION: CLI, NOT `vitest.config.ts` --------------------------------------------------
 *
 * Register this on the COMMAND LINE, in `.github/workflows/deploy.yml`, alongside the JSON
 * reporter. Measured on vitest 3.2.4: a CLI `--reporter` flag REPLACES `test.reporters[]` from the
 * config, it does not append to it. The CI invocation already passes
 * `--reporter=default --reporter=json`, so a reporter registered only in `vitest.config.ts` would
 * be green locally, green in the self-test, and NEVER RUN IN CI — the exact class of defect this
 * wave exists to retire, reproduced by its own remedy. `vitest.config.ts` carries a comment
 * recording why it deliberately has no `reporters:` entry.
 *
 * OUTPUT PATH: `VITEST_ERROR_SHAPE_OUT`, defaulting to `.vitest-error-shapes.json` in the repo
 * root. Paths are stored REPO-RELATIVE so a committed fixture is portable and byte-stable across
 * machines and CI runners.
 *
 * CI-ONLY. This file is never copied into the runtime image — see the Dockerfile, which copies
 * `dist/` plus a small named set of `scripts/` entries. Verify that against the file, never
 * against a count in a spec.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_SUITE, KIND_TEST, displayName, normFile, titlePathOfEntity } from './lib/vitest-test-identity.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Sidecar wire-format version. 2 = every entry carries `kind` + `titlePath`, the structured
 * identity the classifier keys on (OPS-SUITE-VERDICT-NESTED-KEY-W1). Version 1 keyed on a rendered
 * `name` and could not be joined for any test inside a `describe`.
 */
export const SIDECAR_SCHEMA = 2;

/**
 * Repo-relative, forward-slashed. The SAME function the classifier normalises with — not a second
 * implementation of it. Two implementations of this once disagreed (`0fed536e`), which is why the
 * export is an alias and not a body.
 */
export const relPath = normFile;

/**
 * The per-error record. Deliberately small and JSON-primitive: this file is a WIRE FORMAT read by
 * another process, and every field here is one the classifier actually branches on.
 */
export function errorShape(e) {
  return {
    name: typeof e?.name === 'string' ? e.name : null,
    // `diff` is a rendered string when present; we only ever ask WHETHER it exists, so store the
    // boolean rather than the payload. Storing the diff would put assertion values — potentially
    // real data from a fixture — into a committed artifact for no classification benefit.
    hasDiff: e?.diff != null,
    hasExpected: e?.expected !== undefined,
    hasActual: e?.actual !== undefined,
    message: String(e?.message ?? ''),
  };
}

export default class VitestErrorShapeReporter {
  #failures = [];

  // Identity is the TITLE PATH, never `testCase.fullName`. vitest renders `fullName` with " > "
  // here and with " " in the JSON report, so a rendered name joins only for a test with no
  // enclosing `describe` — see scripts/lib/vitest-test-identity.mjs for the measured incident.
  #record(kind, entity, errors) {
    const titlePath = titlePathOfEntity(entity);
    this.#failures.push({
      kind,
      file: normFile(entity?.module?.moduleId),
      titlePath,
      name: displayName(titlePath), // for humans reading the artifact; the classifier never keys on it
      errors: (errors ?? []).map(errorShape),
    });
  }

  onTestCaseResult(testCase) {
    const result = typeof testCase?.result === 'function' ? testCase.result() : undefined;
    if (result?.state !== 'failed') return;
    this.#record(KIND_TEST, testCase, result.errors);
  }

  // A SUITE's own errors — a `beforeAll`/`afterAll` that threw or timed out inside a `describe`.
  // The JSON report has no field for them: its per-file `message` reads only the MODULE's errors,
  // and every test under the failed hook is reported `skipped`. Measured on vitest 3.2.4: such a
  // run is `success: false` with `numFailedTests: 0` and an empty `message`, and the classifier
  // read it as PASS. Recording them here is what lets it see the failure and judge its shape.
  // Module-level errors are NOT recorded: they reach the JSON `message` faithfully, and the
  // string channel is their pinned cover (the collection-error fixture).
  onTestSuiteResult(testSuite) {
    let state;
    let errors;
    try {
      // vitest's `state()` THROWS on a state it does not know; a reporter must never take the run down.
      state = typeof testSuite?.state === 'function' ? testSuite.state() : undefined;
      errors = typeof testSuite?.errors === 'function' ? testSuite.errors() : [];
    } catch {
      return;
    }
    if (state !== 'failed' || !Array.isArray(errors) || errors.length === 0) return;
    this.#record(KIND_SUITE, testSuite, errors);
  }

  onTestRunEnd() {
    const out = process.env.VITEST_ERROR_SHAPE_OUT || join(REPO, '.vitest-error-shapes.json');
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify({ schema: SIDECAR_SCHEMA, failures: this.#failures }, null, 2)}\n`);
    } catch (e) {
      // A reporter must never take the run down. The classifier treats a DECLARED-but-absent
      // sidecar as INDETERMINATE, so a write failure blocks the deploy loudly rather than
      // silently degrading to the channel this wave exists to stop trusting.
      console.error(`[error-shape-reporter] could not write ${out}: ${e.message}`);
    }
  }
}
