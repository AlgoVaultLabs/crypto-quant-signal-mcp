/**
 * OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W1 R3 — one alert id, one remedy.
 *
 * On 2026-08-01 `CLOSEDBAR_DISPATCH_RATCHET_REGRESSION` fired correctly and told the operator
 * to dispatch the wave that would have RATIFIED the fault: it had inherited the readiness
 * alert's `recommended_wave`. A detector that points at the wrong action is worse than no
 * detector, because the operator acts on it.
 *
 * This test is also the WIRING for scripts/check-alert-recommended-wave.mjs — an unwired gate
 * is theatre (see check-canaries-wired.mjs, which fails the build on exactly that). Run by the
 * pre-push test-gate (node --test) and deploy.yml.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPairs, findViolations, stripComments } from '../../scripts/check-alert-recommended-wave.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'check-alert-recommended-wave.mjs');

const run = (args = []) => {
  try {
    return { out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
};

test('every alert id in a committed alert-emitting artifact owns a DISTINCT recommended wave', () => {
  const { out, code } = run();
  assert.match(out, /^ALERT_WAVE_VERDICT=PASS$/m,
    `check-alert-recommended-wave failed. Two alert ids sharing one wave means one of them sends ` +
    `the operator to the wrong remedy — give each its own templated OPS-<CLASS>-W{NEXT}, or add ` +
    `an explicit \`alert-wave-exempt:\` comment saying why they genuinely share one.\n${out}`);
  assert.equal(code, 0, `expected exit 0 on PASS, got ${code}\n${out}`);
});

test("the gate's own self-test is green and NOT vacuous", () => {
  const { out, code } = run(['--self-test']);
  assert.equal(code, 0, `self-test failed:\n${out}`);
  assert.match(out, /self-test passed/, out);
  assert.doesNotMatch(out, /\b0 must-(fire|not-fire|map)\b/,
    `an empty corpus means the self-test verified nothing:\n${out}`);
});

test('the shared-wave defect is DETECTED, not merely describable (the 2026-08-01 case)', () => {
  const shared = extractPairs(
    `printf 'ALERT_ONE Action: dispatch OPS-SAME-W{NEXT}'\nprintf 'ALERT_TWO Action: dispatch OPS-SAME-W{NEXT}'`,
  );
  assert.deepEqual(findViolations(shared).map((v) => v.kind), ['SHARED_WAVE']);
});

test('a literal wave number is rejected — the field must stay templated', () => {
  const literal = extractPairs(`printf 'ALERT_ONE Action: dispatch OPS-THING-W3'`);
  assert.deepEqual(findViolations(literal).map((v) => v.kind), ['LITERAL_WAVE']);
});

test('a comment mentioning a wave is not an emission, and a Rollback pointer is not a recommendation', () => {
  assert.equal(stripComments('# ALERT_ONE OPS-A-W{NEXT}').trim(), '');
  // Regression case: an earlier draft paired `OFFSET_PCT` (from `OFFSET_PCT=75`) with the
  // `Rollback: see status.md SIGNAL-…-W1` pointer in the same printf and invented a violation.
  const withRollback = extractPairs(
    `printf 'ALERT_ONE (OFFSET_PCT=75) Rollback: see status.md SIGNAL-CLOSEDBAR-SHADOW-W1 CH6 Action: dispatch OPS-A-W{NEXT}'`,
  );
  assert.deepEqual(findViolations(withRollback), []);
  assert.deepEqual(withRollback.map((p) => p.wave), ['OPS-A-W{NEXT}']);
});

test('the liveness probe can no longer recommend the basis-flip wave', { timeout: 5000 }, () => {
  const probe = join(REPO, 'ops', 'monitoring', 'closedbar-w1-liveness.sh');
  // Comments are STRIPPED first, for the same reason this module's own extractor strips them:
  // a mention in prose is not an emission. The probe carries a historical citation explaining
  // WHY its band is now derived from the bot's live config ("SIGNAL-CLOSEDBAR-FLIP-W1 CH5. This
  // used to hardcode …"), and this repo records corrections rather than deleting them. The
  // property under test is that the probe cannot RECOMMEND that wave, which is a statement about
  // live code, not about its history.
  // (Unmasked 2026-08-21 OPS-ALERT-RECOVERY-NOTICE-W1 CH2: this file's import of
  // check-alert-recommended-wave.mjs executed that module's main at load and exited the process,
  // so only ONE of six tests here ever ran and the file reported green. Adding a main guard to
  // the module took it to 6 tests and rendered this assertion for the first time.)
  const src = stripComments(execFileSync('cat', [probe], { encoding: 'utf8' }));
  assert.doesNotMatch(src, /SIGNAL-CLOSEDBAR-FLIP|CLOSEDBAR_FLIP/,
    'the flip wave sets ALGOVAULT_BOT_DISPATCH_OFFSET_PCT=0, which would ratify the very fault ' +
    'this probe detects — it must never be reachable from this alert',
  );
  assert.match(src, /W\{NEXT\}/, 'recommended_wave must be templated');
});
