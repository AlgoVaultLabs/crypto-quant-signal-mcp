#!/usr/bin/env node
/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH2 — a timeout is not a failure.
 *
 * WHY THIS EXISTS. `verification-gates.md` already carries the law in one direction:
 *
 *   "A gate that CAN fail open MUST emit a distinguishable verdict token. Exit 0 may never
 *    encode both 'verified, clean' and 'verified nothing.'"
 *
 * It had never been applied to the fail-CLOSED direction. Exit 1 from vitest encodes BOTH
 * "verified, broken" and "could not verify in time", and the deploy pipeline could not tell them
 * apart. On 2026-08-17 that ambiguity blocked a finished, green, merged wave for ~3 days: the
 * suite reported `Test timed out in 5000ms` with 6,044 tests passing, and a human had to reason
 * about DAG ordering and import graphs to establish it was not a regression.
 *
 * -- THE BOUNDARY, WHICH IS THE LINE BETWEEN A FIX AND A VIOLATION ----------------------------
 *
 * This module RE-RUNS indeterminate files, serially, in a fresh process, and accepts a pass on
 * that retry. That is the opposite of warn-mode, and the difference is worth stating precisely
 * because the two look similar from a distance:
 *
 *   warn-mode  downgrades a KNOWN failure into a pass. The assertion still fails; the gate is
 *              told to ignore it.
 *   this       re-runs the SAME assertions under a known-clean condition to obtain a determinate
 *              verdict. Nothing is skipped. Nothing is quarantined. Nothing is allow-listed.
 *
 * THERE IS NO PATH IN THIS MODULE WHERE A FAILING ASSERTION DEPLOYS. A failure carrying an
 * assertion diff is FAIL immediately and is never retried — retrying it could only launder it.
 * Only contention-shaped failures (timeout / abort / OOM / worker crash) are re-run, and if the
 * retry still fails, the verdict is FAIL. If the retry cannot be parsed, the verdict is
 * INDETERMINATE and the deploy is BLOCKED — an unknown never becomes a pass.
 *
 * That property is pinned by a test that forces a genuine assertion failure through the whole
 * classify -> retry -> verdict chain and asserts the outcome is FAIL.
 *
 * CONTRACT: exactly one terminal `SUITE_VERDICT=PASS|PASS_AFTER_ISOLATION|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN. Exit 0 = deploy permitted (PASS, PASS_AFTER_ISOLATION), 1 = FAIL,
 * 3 = INDETERMINATE. Both 1 and 3 block a deploy; they are distinct so the operator, and CH4's
 * blame classifier, can tell a regression from an unfinished measurement.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Failure shapes that mean "the suite did not finish deciding", not "the code is wrong".
 *
 * Deliberately narrow. Anything not matched here is treated as a real failure, because the safe
 * default when classifying a red is to call it a regression.
 */
export const INDETERMINATE_PATTERNS = [
  /test timed out in \d+\s*ms/i,
  /\bhook timed out\b/i,
  /\btimeout(ed)? exceeded\b/i,
  /JavaScript heap out of memory/i,
  /\bENOMEM\b/i,
  /worker (process )?(exited|crashed|terminated)/i,
  /Channel closed/i,
  /\bAbortError\b/i,
  /operation was aborted/i,
  /Tests closed too early/i,
];

/**
 * An assertion diff is positive evidence of a real failure. If a message carries one, the failure
 * is REAL even when it also mentions a timeout — a test can assert, fail, and then time out while
 * tearing down, and calling that indeterminate would launder a genuine regression.
 */
export const ASSERTION_PATTERNS = [
  /AssertionError/i,
  /\bexpected\b[\s\S]{0,200}?\breceived\b/i,
  /\bexpected\b[\s\S]{0,200}?\bto (be|equal|contain|match|throw)\b/i,
  /Unhandled error/i,
  /ReferenceError|TypeError|SyntaxError/,
];

export function classifyMessage(msg) {
  const s = String(msg ?? '');
  if (ASSERTION_PATTERNS.some((r) => r.test(s))) return 'assertion';
  if (INDETERMINATE_PATTERNS.some((r) => r.test(s))) return 'indeterminate';
  return 'assertion'; // unknown shape -> treat as REAL. Safe default when classifying a red.
}

// -- the STRUCTURED channel ---------------------------------------------------------------------
//
// `classifyMessage` above reads `failureMessages[]` from vitest's JSON reporter. For a TIMEOUT
// that array holds the placeholder `Error: STACK_TRACE_ERROR` and the real message is GONE
// (measured, vitest 3.2.4: "timed out" appears zero times in the whole report). Everything below
// reads the sidecar written by `scripts/vitest-error-shape-reporter.mjs`, which takes its fields
// from the error objects vitest hands a reporter — the source the JSON reporter renders FROM.
//
// 🛑 THE PATTERNS ARE NOT REDUNDANT WITH THIS, AND MUST NOT BE DELETED AS SUCH. Two reasons, and
// the first one is the load-bearing one:
//
//   1. THE STRUCTURED FIELDS ALONE CANNOT IDENTIFY A TIMEOUT. Measured across five real failure
//      shapes, a plain `throw new Error('boom')` is BYTE-IDENTICAL to a timeout in
//      `name`/`hasDiff`/`hasExpected`/`hasActual` — both are `Error` with none of the three. The
//      only field that separates them is the MESSAGE, which is precisely what the JSON reporter
//      destroyed. So the sidecar's job is to deliver a FAITHFUL message, and
//      `INDETERMINATE_PATTERNS` is what then evaluates it. They are the same rule finally getting
//      the text it was always written for.
//   2. A process-level collapse (worker death, OOM, collection error) produces NO per-test result
//      at all, so no sidecar entry exists for it. The string channel is the only cover there, and
//      `tests/unit/test-budget-and-verdict-class.test.ts` pins that case.
//
// What the structure DOES buy is a POSITIVE assertion signal: `AssertionError`, or any of the
// `diff`/`expected`/`actual` triple, is affirmative evidence of a real failure independent of how
// the message happens to be worded. That is checked FIRST, so a real failure can never be talked
// into `indeterminate` by a message that happens to mention a timeout.

/** Repo-relative + forward-slashed, so a sidecar path and a JSON-report path compare equal. */
export function normFile(p) {
  if (!p) return '<unknown>';
  let s = String(p).split('\\').join('/');
  const repo = REPO.split('\\').join('/').replace(/\/+$/, '');
  if (s.startsWith(`${repo}/`)) s = s.slice(repo.length + 1);
  return s;
}

/** `file::name` — the key both channels agree on. */
export function shapeKey(file, name) {
  return `${normFile(file)}::${name ?? '<test>'}`;
}

/**
 * Classify ONE structured error. Order is the contract:
 *   positive assertion evidence -> assertion (never overridable by message text)
 *   faithful message says contention -> indeterminate
 *   anything else -> assertion (the shipped safe default, preserved verbatim)
 */
export function classifyShape(err) {
  if (err?.name === 'AssertionError' || err?.hasDiff || err?.hasExpected || err?.hasActual) return 'assertion';
  const msg = String(err?.message ?? '');
  if (ASSERTION_PATTERNS.some((r) => r.test(msg))) return 'assertion';
  if (INDETERMINATE_PATTERNS.some((r) => r.test(msg))) return 'indeterminate';
  return 'assertion';
}

/** Index a sidecar body into Map<`file::name`, errors[]>. Returns null for an unusable body. */
export function indexSidecar(sidecar) {
  if (!sidecar || !Array.isArray(sidecar.failures)) return null;
  const m = new Map();
  for (const f of sidecar.failures) m.set(shapeKey(f?.file, f?.name), Array.isArray(f?.errors) ? f.errors : []);
  return m;
}

/**
 * Read a sidecar the CALLER DECLARED it expects.
 *
 * 🛑 Expectation is never INFERRED. The reporter is registered on the CI command line only, so a
 * local `npm test` legitimately writes no sidecar — inferring "we're in CI, so there should be
 * one" would produce false INDETERMINATE locally, and inferring the other way would let CI
 * silently fall back to the dark string channel while reporting green. The `--sidecar=PATH` flag
 * IS the declaration: present means required, absent means the string channel is the whole story.
 */
export function readSidecar(path) {
  if (!path) return { ok: false, reason: 'no sidecar path given' };
  if (!existsSync(path)) return { ok: false, reason: `sidecar not found at ${path}` };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `sidecar unreadable: ${e.message}` };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `sidecar unparseable: ${e.message}` };
  }
  const index = indexSidecar(body);
  if (!index) return { ok: false, reason: 'sidecar has no `failures` array — unusable shape' };
  return { ok: true, sidecar: body, index };
}

/** Normalise vitest's JSON reporter into { file, name, messages[] } failures. */
export function extractFailures(report) {
  const out = [];
  const suites = Array.isArray(report?.testResults) ? report.testResults : [];
  for (const s of suites) {
    const file = s.name ?? s.testFilePath ?? '<unknown>';
    const specs = Array.isArray(s.assertionResults) ? s.assertionResults : [];
    // A suite can fail without any assertion result (collection error, worker death).
    if (specs.length === 0 && (s.status === 'failed' || s.message)) {
      out.push({ file, name: '<suite>', messages: [s.message ?? ''] });
      continue;
    }
    for (const a of specs) {
      if (a.status !== 'failed') continue;
      out.push({ file, name: a.fullName ?? a.title ?? '<test>', messages: a.failureMessages ?? [] });
    }
    if (s.status === 'failed' && s.message && !specs.some((a) => a.status === 'failed')) {
      out.push({ file, name: '<suite>', messages: [s.message] });
    }
  }
  return out;
}

/**
 * @param report  vitest JSON-reporter body
 * @param index   optional Map from `readSidecar().index`. When a failure has an entry, it is
 *                classified STRUCTURALLY; otherwise the string channel decides, unchanged.
 */
export function classifyReport(report, index = null) {
  const failures = extractFailures(report);
  if (failures.length === 0) return { verdict: 'PASS', failures, indeterminateFiles: [] };
  const classified = failures.map((f) => {
    const shapes = index?.get(shapeKey(f.file, f.name));
    if (shapes && shapes.length > 0) {
      // Structured: any error carrying assertion evidence makes the whole failure real.
      const kind = shapes.map(classifyShape).includes('assertion') ? 'assertion' : 'indeterminate';
      return { ...f, kind, channel: 'structured' };
    }
    // No per-test structured entry — a process-level collapse, or no sidecar in play.
    const kind = f.messages.length === 0
      ? 'assertion'
      : (f.messages.map(classifyMessage).includes('assertion') ? 'assertion' : 'indeterminate');
    return { ...f, kind, channel: 'string' };
  });
  const real = classified.filter((c) => c.kind === 'assertion');
  if (real.length > 0) return { verdict: 'FAIL', failures: classified, indeterminateFiles: [] };
  return {
    verdict: 'INDETERMINATE',
    failures: classified,
    indeterminateFiles: [...new Set(classified.map((c) => c.file))],
  };
}

export function readReport(path) {
  if (!path) {
    return {
      ok: false,
      reason: 'no report path given (pass it positionally, as --report=PATH, or via VITEST_JSON_REPORT)',
    };
  }
  if (!existsSync(path)) return { ok: false, reason: `report not found at ${path}` };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `report unreadable: ${e.message}` };
  }
  try {
    return { ok: true, report: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, reason: `report unparseable: ${e.message}` };
  }
}

/**
 * Re-run ONLY the indeterminate files, serially, in a fresh process.
 *
 * Serial and isolated on purpose: the failure class being re-tested is CONTENTION, so re-running
 * under the same parallel load would reproduce the same ambiguity rather than resolve it.
 */
export function isolationRetry(files, runner) {
  const started = Date.now();
  const res = runner(files);
  return { ...res, durationMs: Date.now() - started };
}

function defaultRunner(files) {
  const out = join(REPO, '.vitest-isolation-report.json');
  // The RETRY gets the sidecar too. Without this the second classification would fall back to the
  // string channel — i.e. the retry that exists to resolve an ambiguity would be judged by the
  // very reporter that could not see it, and a re-timed-out file would come back FAIL.
  const shapes = join(REPO, '.vitest-isolation-error-shapes.json');
  const reporter = join(REPO, 'scripts', 'vitest-error-shape-reporter.mjs');
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', '--pool=forks', '--poolOptions.forks.singleFork=true', '--reporter=json', `--outputFile=${out}`, `--reporter=${reporter}`, ...files],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, VITEST_ERROR_SHAPE_OUT: shapes } },
    );
  } catch {
    // vitest exits non-zero on failures; the report is still the source of truth.
  }
  const r = readReport(out);
  // The retry's sidecar is BEST-EFFORT, and deliberately so: the caller declared it expected a
  // sidecar for the FIRST run, which we honoured. If the retry's own sidecar is missing we still
  // have a determinate answer available from the string channel, and refusing here would convert
  // a recoverable contention into a blocked deploy for no gain.
  const sc = readSidecar(shapes);
  return { ...r, index: sc.ok ? sc.index : null };
}

function emit(verdict, lines) {
  for (const l of lines) console.log(l);
  console.log(`SUITE_VERDICT=${verdict}`);
  if (verdict === 'PASS' || verdict === 'PASS_AFTER_ISOLATION') return 0;
  if (verdict === 'FAIL') return 1;
  return 3;
}

function run(argv) {
  // Positional is the canonical form (what CI uses). `--report=PATH` is accepted too: the author
  // of this script reached for that spelling first when running it by hand, which is evidence
  // enough that the interface invites it. An unknown flag still falls through to INDETERMINATE
  // rather than being treated as a path — wrong input must never be able to produce a PASS.
  const flag = argv.find((a) => a.startsWith('--report='));
  const pathArg =
    (flag ? flag.slice('--report='.length) : undefined) ??
    argv.find((a) => !a.startsWith('--')) ??
    process.env.VITEST_JSON_REPORT;
  const noRetry = argv.includes('--no-retry');
  // CALLER-DECLARED sidecar expectation. Presence of the flag IS the declaration; it is never
  // inferred from the environment. See `readSidecar` for why inference is unsafe in both
  // directions.
  const scFlag = argv.find((a) => a.startsWith('--sidecar='));
  const scPath = scFlag ? scFlag.slice('--sidecar='.length) : undefined;
  const r = readReport(pathArg);
  if (!r.ok) {
    // Input we were HANDED and could not parse is INDETERMINATE, always — never PASS.
    return emit('INDETERMINATE', [r.reason]);
  }
  let index = null;
  if (scPath !== undefined) {
    const sc = readSidecar(scPath);
    if (!sc.ok) {
      // DECLARED and unusable. A quiet degrade to the string channel here would restore the dark
      // gate while reporting green, which is the whole defect this wave exists to remove.
      return emit('INDETERMINATE', [
        `structured error sidecar was DECLARED (--sidecar=${scPath}) but is unusable: ${sc.reason}`,
        'refusing to fall back to the string channel — that is the dark path this gate was fixed to stop trusting',
      ]);
    }
    index = sc.index;
  }
  const first = classifyReport(r.report, index);
  if (first.verdict === 'PASS') return emit('PASS', ['no failures']);
  if (first.verdict === 'FAIL') {
    const lines = ['REAL failures (assertion diffs present) — not retried, because retrying a real failure could only launder it:'];
    for (const f of first.failures.filter((f) => f.kind === 'assertion').slice(0, 10)) {
      lines.push(`  x ${f.file} :: ${f.name}`);
    }
    return emit('FAIL', lines);
  }

  // INDETERMINATE: contention-shaped only.
  const lines = [
    `all ${first.failures.length} failure(s) are contention-shaped (timeout / abort / OOM / worker crash) and NONE carries an assertion diff`,
    `indeterminate files: ${first.indeterminateFiles.join(', ')}`,
  ];
  if (noRetry) return emit('INDETERMINATE', [...lines, 'retry suppressed (--no-retry)']);

  lines.push('re-running those files SERIALLY in a fresh process to obtain a determinate verdict');
  const retry = isolationRetry(first.indeterminateFiles, defaultRunner);
  if (!retry.ok) {
    // An unknown never becomes a pass. Deploy stays blocked.
    return emit('INDETERMINATE', [...lines, `retry report unusable: ${retry.reason} — deploy BLOCKED`]);
  }
  const second = classifyReport(retry.report, retry.index ?? null);
  lines.push(`isolation retry finished in ${retry.durationMs}ms with verdict ${second.verdict}`);
  if (second.verdict === 'PASS') {
    return emit('PASS_AFTER_ISOLATION', [
      ...lines,
      'the same assertions passed under isolation — contention, not regression. Nothing was skipped or quarantined.',
    ]);
  }
  if (second.verdict === 'FAIL') {
    for (const f of second.failures.filter((f) => f.kind === 'assertion').slice(0, 10)) {
      lines.push(`  x ${f.file} :: ${f.name}`);
    }
    return emit('FAIL', [...lines, 'a real failure surfaced under isolation — deploy BLOCKED']);
  }
  return emit('INDETERMINATE', [...lines, 'still indeterminate after isolation — deploy BLOCKED']);
}

// -- self-test ---------------------------------------------------------------------------------
function selfTest() {
  let pass = 0;
  let fail = 0;
  const t = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      console.log(`  FAIL ${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  };
  const rep = (specs) => ({ testResults: [{ name: 'tests/a.test.ts', assertionResults: specs }] });
  const failed = (msg) => ({ status: 'failed', fullName: 'x', failureMessages: [msg] });

  // -- CAPTURED-ARTIFACT assertions ------------------------------------------------------------
  //
  // These load real `.vitest-report.json` + sidecar pairs produced by running real failing tests
  // through the real reporters. They are CAPTURED, never transcribed.
  //
  // WHY THAT DISTINCTION IS THE WHOLE POINT. The assertion this block replaces read:
  //
  //   t('the real 2026-08-17 message -> INDETERMINATE',
  //     classifyReport(rep([failed('Error: Test timed out in 5000ms.')])).verdict, 'INDETERMINATE');
  //
  // That string is what the TERMINAL reporter printed and a human read in the incident. The JSON
  // reporter — the only channel this gate consumes in production — never emits it; it writes
  // `Error: STACK_TRACE_ERROR`. So the assertion passed while the gate was dark, because the
  // fixture was built to imitate a different renderer's output. A gate's fixture must come from
  // the channel the gate reads.
  const FIXTURES = join(REPO, 'tests/fixtures/verdict-channel');
  const fx = (label) => {
    const r = readReport(join(FIXTURES, `${label}.report.json`));
    const sc = readSidecar(join(FIXTURES, `${label}.shapes.json`));
    return { report: r.ok ? r.report : null, index: sc.ok ? sc.index : null, ok: r.ok && sc.ok };
  };

  t('zero failures -> PASS', classifyReport(rep([{ status: 'passed' }])).verdict, 'PASS');

  const capTimeout = fx('timeout-only');
  t('fixture corpus is present (vacuity guard)', capTimeout.ok, true);
  t(
    'CAPTURED timeout, structured channel -> INDETERMINATE',
    classifyReport(capTimeout.report, capTimeout.index).verdict,
    'INDETERMINATE',
  );
  // THE REGRESSION LOCK. This is the shipped behaviour, pinned as the BEFORE-value: the same real
  // artifact judged on the string channel alone returns FAIL. If a later change stops threading
  // the sidecar, this is the assertion that names what was lost.
  t(
    'CAPTURED timeout, string channel alone -> FAIL (the defect this wave fixes, pinned)',
    classifyReport(capTimeout.report).verdict,
    'FAIL',
  );

  const capAssert = fx('assertion-only');
  t('CAPTURED assertion failure -> FAIL', classifyReport(capAssert.report, capAssert.index).verdict, 'FAIL');

  const capMixed = fx('mixed');
  t(
    'CAPTURED mixed (real timeout + real assertion) -> FAIL (the diff still wins)',
    classifyReport(capMixed.report, capMixed.index).verdict,
    'FAIL',
  );

  // A collection error produces NO per-test result, so the sidecar has zero entries for it and the
  // STRING channel is the only cover. Captured, so this is a fact about vitest rather than a claim.
  const capCollapse = fx('collection-error');
  t('CAPTURED collection error yields no per-test sidecar entry', capCollapse.index.size, 0);
  t(
    'CAPTURED collection error -> FAIL via the string channel (patterns are NOT redundant)',
    classifyReport(capCollapse.report, capCollapse.index).verdict,
    'FAIL',
  );

  // -- DECLARED-sidecar refusal ------------------------------------------------------------------
  t('sidecar DECLARED but absent -> unusable (INDETERMINATE at the caller)', readSidecar(join(REPO, 'no/such/sidecar.json')).ok, false);
  t('sidecar DECLARED but unparseable -> unusable', readSidecar(join(REPO, 'README.md')).ok, false);
  t('sidecar present but wrong shape -> unusable (unit)', indexSidecar({ nope: true }), null);
  // Valid JSON, wrong SHAPE — this exercises readSidecar's own refusal, which the unit assertion
  // above does not reach. Found by breaking that refusal deliberately and watching the suite stay
  // GREEN: an assertion that cannot fail is not an assertion.
  t('sidecar parses but has no `failures` array -> readSidecar REFUSES', readSidecar(join(REPO, 'package.json')).ok, false);

  // -- STRING-channel assertions (process-level collapse) ----------------------------------------
  //
  // Retained deliberately. A worker death / OOM / "tests closed too early" arrives as a SUITE-level
  // message with no per-test result, so no sidecar entry exists and these patterns are the only
  // thing standing between that and a FAIL verdict. Their labels no longer claim to be what the
  // JSON reporter emits for a per-test timeout — that claim was the defect.
  t('an assertion diff (string channel) -> FAIL', classifyReport(rep([failed('AssertionError: expected 1 to be 2')])).verdict, 'FAIL');
  t('OOM (string channel) -> INDETERMINATE', classifyReport(rep([failed('JavaScript heap out of memory')])).verdict, 'INDETERMINATE');
  t('worker crash (string channel) -> INDETERMINATE', classifyReport(rep([failed('worker exited unexpectedly')])).verdict, 'INDETERMINATE');
  t(
    'MIXED on the string channel -> FAIL (a real failure is never diluted by a timeout)',
    classifyReport(rep([failed('Test timed out in 5000ms'), failed('AssertionError: expected a to be b')])).verdict,
    'FAIL',
  );
  t(
    'an assertion that ALSO timed out -> FAIL (the diff wins)',
    classifyReport(rep([failed('AssertionError: expected 1 to be 2\nTest timed out in 5000ms')])).verdict,
    'FAIL',
  );

  // -- structured-shape unit assertions ----------------------------------------------------------
  //
  // Measured, and the reason the structured fields ALONE are not a timeout detector: a plain
  // `throw new Error('boom')` is byte-identical to a timeout in every structured field.
  t('shape: AssertionError -> assertion', classifyShape({ name: 'AssertionError', message: 'expected 1 to be 2' }), 'assertion');
  t('shape: diff present -> assertion', classifyShape({ name: 'Error', hasDiff: true, message: 'anything' }), 'assertion');
  t('shape: TypeError -> assertion (a real bug, no diff)', classifyShape({ name: 'TypeError', message: 'Cannot read properties of null' }), 'assertion');
  t('shape: thrown Error -> assertion (safe default)', classifyShape({ name: 'Error', message: 'boom custom' }), 'assertion');
  t('shape: timeout message -> indeterminate', classifyShape({ name: 'Error', message: 'Test timed out in 250ms.' }), 'indeterminate');
  t(
    'shape: a timeout message CANNOT override positive assertion evidence',
    classifyShape({ name: 'AssertionError', hasDiff: true, message: 'Test timed out in 250ms.' }),
    'assertion',
  );
  t('an unknown failure shape -> FAIL (safe default)', classifyReport(rep([failed('something weird')])).verdict, 'FAIL');
  t('a failure with NO message -> FAIL (never assume benign)', classifyReport(rep([{ status: 'failed', fullName: 'x', failureMessages: [] }])).verdict, 'FAIL');
  t('a suite-level collapse -> counted', classifyReport({ testResults: [{ name: 'f', status: 'failed', message: 'Tests closed too early', assertionResults: [] }] }).verdict, 'INDETERMINATE');
  t('missing report -> INDETERMINATE', readReport('/nonexistent/x.json').ok, false);
  t('unparseable report -> INDETERMINATE', readReport(join(REPO, 'package.json')).ok, true);

  // THE BOUNDARY: a genuine assertion failure must end FAIL through the whole chain, including
  // when the retry itself would have passed. This is the property that makes the module a fix
  // rather than a violation.
  const forced = classifyReport(rep([failed('AssertionError: expected 3 to be 4')]));
  t('boundary: a real failure is never routed into the retry path', forced.indeterminateFiles.length, 0);
  t('boundary: and its verdict is FAIL', forced.verdict, 'FAIL');
  const retried = isolationRetry(['tests/a.test.ts'], () => ({ ok: true, report: rep([{ status: 'passed' }]) }));
  t('boundary: a retry that passes yields PASS only for a contention failure', classifyReport(retried.report).verdict, 'PASS');

  console.log(`SELF-TEST: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
  // NOT `SUITE_VERDICT=`. A self-test evaluates NOTHING about the tree, so emitting the token a
  // caller gates on would let a run that checked nothing publish a pass — the precise defect this
  // gate exists to prevent, reproduced by its own harness. The self-test's verdict has its own
  // name, and callers of the real gate scrape only the token above.
  console.log(`SELF-TEST-EXIT: ${fail === 0 ? 0 : 1}`);
  return fail === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('classify-suite-verdict.mjs')) {
  const argv = process.argv.slice(2);
  process.exit(argv.includes('--self-test') ? selfTest() : run(argv));
}
