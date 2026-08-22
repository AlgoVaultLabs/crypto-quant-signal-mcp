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
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Repo-relative, forward-slashed. Keeps a committed fixture identical on any machine. */
export function relPath(p) {
  if (!p) return '<unknown>';
  const s = String(p);
  const r = isAbsolute(s) ? relative(REPO, s) : s;
  return r.split('\\').join('/');
}

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

  onTestCaseResult(testCase) {
    const result = typeof testCase?.result === 'function' ? testCase.result() : undefined;
    if (result?.state !== 'failed') return;
    this.#failures.push({
      file: relPath(testCase?.module?.moduleId),
      name: typeof testCase?.fullName === 'string' ? testCase.fullName : (testCase?.name ?? '<test>'),
      errors: (result.errors ?? []).map(errorShape),
    });
  }

  onTestRunEnd() {
    const out = process.env.VITEST_ERROR_SHAPE_OUT || join(REPO, '.vitest-error-shapes.json');
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify({ schema: 1, failures: this.#failures }, null, 2)}\n`);
    } catch (e) {
      // A reporter must never take the run down. The classifier treats a DECLARED-but-absent
      // sidecar as INDETERMINATE, so a write failure blocks the deploy loudly rather than
      // silently degrading to the channel this wave exists to stop trusting.
      console.error(`[error-shape-reporter] could not write ${out}: ${e.message}`);
    }
  }
}
