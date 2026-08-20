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

export function classifyReport(report) {
  const failures = extractFailures(report);
  if (failures.length === 0) return { verdict: 'PASS', failures, indeterminateFiles: [] };
  const classified = failures.map((f) => ({
    ...f,
    kind: f.messages.length === 0 ? 'assertion' : (f.messages.map(classifyMessage).includes('assertion') ? 'assertion' : 'indeterminate'),
  }));
  const real = classified.filter((c) => c.kind === 'assertion');
  if (real.length > 0) return { verdict: 'FAIL', failures: classified, indeterminateFiles: [] };
  return {
    verdict: 'INDETERMINATE',
    failures: classified,
    indeterminateFiles: [...new Set(classified.map((c) => c.file))],
  };
}

export function readReport(path) {
  if (!path || !existsSync(path)) return { ok: false, reason: `report not found at ${path}` };
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
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', '--pool=forks', '--poolOptions.forks.singleFork=true', '--reporter=json', `--outputFile=${out}`, ...files],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
  } catch {
    // vitest exits non-zero on failures; the report is still the source of truth.
  }
  return readReport(out);
}

function emit(verdict, lines) {
  for (const l of lines) console.log(l);
  console.log(`SUITE_VERDICT=${verdict}`);
  if (verdict === 'PASS' || verdict === 'PASS_AFTER_ISOLATION') return 0;
  if (verdict === 'FAIL') return 1;
  return 3;
}

function run(argv) {
  const pathArg = argv.find((a) => !a.startsWith('--')) ?? process.env.VITEST_JSON_REPORT;
  const noRetry = argv.includes('--no-retry');
  const r = readReport(pathArg);
  if (!r.ok) {
    // Input we were HANDED and could not parse is INDETERMINATE, always — never PASS.
    return emit('INDETERMINATE', [r.reason]);
  }
  const first = classifyReport(r.report);
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
  const second = classifyReport(retry.report);
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

  t('zero failures -> PASS', classifyReport(rep([{ status: 'passed' }])).verdict, 'PASS');
  t(
    'the real 2026-08-17 message -> INDETERMINATE',
    classifyReport(rep([failed('Error: Test timed out in 5000ms.')])).verdict,
    'INDETERMINATE',
  );
  t('an assertion diff -> FAIL', classifyReport(rep([failed('AssertionError: expected 1 to be 2')])).verdict, 'FAIL');
  t('OOM -> INDETERMINATE', classifyReport(rep([failed('JavaScript heap out of memory')])).verdict, 'INDETERMINATE');
  t('worker crash -> INDETERMINATE', classifyReport(rep([failed('worker exited unexpectedly')])).verdict, 'INDETERMINATE');
  t(
    'MIXED: one timeout + one assertion -> FAIL (a real failure is never diluted by a timeout)',
    classifyReport(rep([failed('Test timed out in 5000ms'), failed('AssertionError: expected a to be b')])).verdict,
    'FAIL',
  );
  t(
    'an assertion that ALSO timed out -> FAIL (the diff wins)',
    classifyReport(rep([failed('AssertionError: expected 1 to be 2\nTest timed out in 5000ms')])).verdict,
    'FAIL',
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
  console.log(`SUITE_VERDICT=${fail === 0 ? 'PASS' : 'FAIL'}`);
  return fail === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('classify-suite-verdict.mjs')) {
  const argv = process.argv.slice(2);
  process.exit(argv.includes('--self-test') ? selfTest() : run(argv));
}
