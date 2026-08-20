/**
 * OPS-ALERT-RECOVERY-NOTICE-W1 CH1 — the alert channel is a STATE, not an event stream.
 *
 * `send_telegram.sh` wrote its cooldown marker on a delivered fire and NOTHING ever cleared it,
 * so the channel's last message was pinned to the worst thing that ever happened. Measured cost:
 * MONITORING_DECLARATION_SYNC_FAILED fired 2026-08-17 during a published GitHub incident,
 * self-healed within the hour, and 70 hours later the operator was still treating it as live.
 *
 * This test is also the WIRING for the wrapper's `--self-test` — an unwired gate is theatre.
 * The hermetic suite lives in the shell script (it must run identically on the hosts, where
 * node is not guaranteed); this file's job is to make sure it RUNS, that its verdict token is
 * the contract CLAUDE.md requires, and to pin the two properties whose regression would be
 * silent and estate-wide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = join(REPO, 'ops', 'monitoring', 'send_telegram.sh');

const run = (args, env = {}) => {
  try {
    return { out: execFileSync('bash', [WRAPPER, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
};

test('the wrapper --self-test passes and is not vacuous', () => {
  const { out, code } = run(['--self-test']);
  assert.equal(code, 0, `--self-test failed:\n${out}`);
  assert.match(out, /^SELF-TEST: PASS/m);
  const n = Number(out.match(/SELF-TEST: PASS — (\d+) checks/)?.[1] ?? 0);
  assert.ok(n >= 25, `self-test ran only ${n} checks — vacuity guard`);
});

test('exactly ONE terminal verdict token, per the token law', () => {
  const { out } = run(['--self-test']);
  const tokens = out.split('\n').filter((l) => /^ALERT_WRAPPER_VERDICT=(PASS|FAIL|INDETERMINATE)$/.test(l));
  assert.equal(tokens.length, 1, `expected exactly one verdict token, got ${tokens.length}`);
});

/**
 * The sharpest hazard in the wave. The test-context gate exists because a test WROTE the cooldown
 * marker and would have silenced the next genuine alert. `--clear` introduces the inverse and
 * worse mutation: a test can DELETE production alert state, which does not merely silence — it
 * erases the episode and makes the next fire look like a fresh incident.
 *
 * Note this test file itself runs under NODE_TEST_CONTEXT, which is one of the triggers — so this
 * asserts the real production guard using the real production trigger, not a simulation.
 */
test('a test process cannot clear production alert state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgclear-'));
  const state = join(dir, 'state');
  mkdirSync(state);
  const marker = join(state, 'FIXTURE_ALERT-last-fired-at');
  writeFileSync(marker, '1755700000');
  const before = readFileSync(marker, 'utf8');

  const { code } = run(['--clear', 'FIXTURE_ALERT'], {
    ALERT_WRAPPER_STATE_DIR: state,
    ALERT_WRAPPER_LOG: join(dir, 'log'),
  });

  assert.equal(code, 0, 'fail-open: the wrapper must exit 0 on every path');
  assert.ok(existsSync(marker), 'a test process DELETED the production marker');
  assert.equal(readFileSync(marker, 'utf8'), before, 'marker was mutated by a test process');
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The law's default, pinned in code rather than in prose. CLAUDE.md holds that recovery CHATTER
 * is noise and silence is the default; announcing is opt-in per alert via `announce_resolution`
 * on the registry row. Every failure mode of that lookup must resolve to SILENT, or the default
 * lives only in a sentence someone has to read.
 */
test('announcing a resolution is OPT-IN — absent registry resolves to silent', () => {
  const src = readFileSync(WRAPPER, 'utf8');
  assert.match(src, /\[\[ -r "\$ALERT_REGISTRY" \]\] \|\| return 1/,
    'an unreadable registry must fail toward SILENT, not toward announcing');
  assert.match(src, /command -v python3 .* \|\| return 1/,
    'a missing python3 must fail toward SILENT');
});

test('a resolution is exempt from the cooldown, but the cooldown value itself is untouched', () => {
  const src = readFileSync(WRAPPER, 'utf8');
  assert.match(src, /^COOLDOWN_SEC=86400/m, 'the 24h cooldown is frozen by CH1 scope');
  const clearBlock = src.slice(src.indexOf('do_clear() {'), src.indexOf('do_reconcile() {'));
  assert.ok(!/SUPPRESSED_COOLDOWN/.test(clearBlock),
    'the clear path must not consult the cooldown — a resolution that waits 24h is worthless');
});
