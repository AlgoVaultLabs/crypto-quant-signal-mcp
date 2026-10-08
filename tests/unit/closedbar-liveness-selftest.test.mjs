/**
 * OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W2 R3.2 — the closed-bar liveness probe's own self-test,
 * run by a lane.
 *
 * `ops/monitoring/closedbar-w1-liveness.sh --self-test` drives the probe's LIVE path against a stub
 * of the bot's dispatch auditor (tests/fixtures/closedbar-liveness/stub-auditor.sh) and a capture in
 * place of send_telegram.sh. A self-test nothing runs is the shipped-dark class, so this node:test
 * file is what the pre-push gate (`check_test_baseline.sh` auto-discovers `.test.mjs`) and
 * deploy.yml execute. Excluded from vitest in vitest.config.ts — its runner is node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = join(REPO, 'ops', 'monitoring', 'closedbar-w1-liveness.sh');

const run = (args) => {
  try {
    return { out: execFileSync('bash', [PROBE, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
};

test('the probe self-test passes, and is not vacuous', { timeout: 180_000 }, () => {
  const { out, code } = run(['--self-test']);
  const lines = out.trim().split('\n');
  assert.equal(lines.at(-1), 'CLOSEDBAR_SELFTEST_VERDICT=PASS', out);
  assert.equal(code, 0, `PASS must exit 0\n${out}`);
  const m = /self-test passed: (\d+) must-fire, (\d+) must-not-fire, (\d+) must-map/.exec(out);
  assert.ok(m, `no summary line — the self-test did not run to completion\n${out}`);
  const [fire, nofire, map] = m.slice(1).map(Number);
  // Eight must-fire cases are R3.1's own list (three verdicts, five auditor failures); five
  // must-not-fire are its silences. Fewer means a case was dropped, not merely renamed.
  assert.ok(fire >= 8, `must-fire ${fire} < 8\n${out}`);
  assert.ok(nofire >= 5, `must-not-fire ${nofire} < 5\n${out}`);
  assert.ok(map > 0, `must-map ${map}\n${out}`);
});

test('--print-routes is the pinned verdict list the live path checks the auditor against', () => {
  const { out, code } = run(['--print-routes']);
  assert.equal(code, 0, out);
  assert.deepEqual(out.trim().split('\n'), [
    'OK',
    'TIMING_FAULT',
    'DEPLOY_REGRESSION',
    'CHRONIC_LATE',
    'INDETERMINATE',
  ]);
});
