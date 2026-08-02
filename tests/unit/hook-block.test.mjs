/**
 * OPS-SHARED-WORKTREE-STATE-REGISTRY-W1 — properties of scripts/lib/hook-block.sh.
 *
 * The shared $GIT_COMMON_DIR hooks govern EVERY worktree (74 checkouts measured 2026-08-02), so
 * a defect in the emitter is a fleet-wide outage — that is not hypothetical, it is what happened
 * on 2026-08-01 when a block was installed for a script that existed in one worktree only.
 *
 * These are PROPERTY tests, not characterization tests: each asserts that an outcome is a
 * function of OUR rule rather than of the order or wave-id a caller happens to use. Run by the
 * pre-push test-gate (node --test) and by CI.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The four live installers, and the gate script each one wires in. */
const INSTALLERS = [
  { file: 'install_test_gate_hook.sh', gate: 'scripts/check_test_baseline.sh', hook: 'pre-push', name: 'test-gate' },
  { file: 'install_session_drift_hook.sh', gate: 'scripts/check-session-drift.mjs', hook: 'pre-push', name: 'session-drift' },
  { file: 'install_source_greppable_hook.sh', gate: 'scripts/check-source-greppable.mjs', hook: 'pre-push', name: 'source-greppable' },
  { file: 'install_system_map_hook.sh', gate: 'scripts/check_system_map.sh', hook: 'pre-commit', name: 'system-map' },
];

/**
 * The sentinel literals the PRE-WAVE installers used as their idempotence key. 73 worktrees still
 * hold those installer copies. If the emitter ever stopped producing these byte-for-byte, a stale
 * installer would fail to find its marker and APPEND A DUPLICATE block to the shared hook — this
 * wave's own generator, committed by this wave. That is the whole reason the sentinel was NOT
 * normalised (architect A3), so it is pinned here rather than left to convention.
 */
const LEGACY_SENTINELS = [
  '# >>> algovault test-gate (OPS-VITEST-SUITE-REPAIR-W1) >>>',
  '# >>> algovault session-drift (OPS-CC-DRIFT-DETECTOR-W1) >>>',
  '# >>> algovault source-greppable (OPS-GREPPABLE-SOURCE-GUARD-W1) >>>',
];

let fixture;

/** A throwaway repo with a real bare origin, so assert_publishable has a default ref to resolve. */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'algovault-hook-block-test-'));
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', join(dir, 'origin.git')]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const git = (...args) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  mkdirSync(join(work, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'lib', 'hook-block.sh'), join(work, 'scripts', 'lib', 'hook-block.sh'));
  for (const i of INSTALLERS) copyFileSync(join(ROOT, 'scripts', i.file), join(work, 'scripts', i.file));

  // Stand-ins for the four gate scripts. These tests are about INSTALLATION, never the guards'
  // internals — those have their own suites and this wave changes none of them.
  for (const i of INSTALLERS) {
    const p = join(work, i.gate);
    writeFileSync(p, i.gate.endsWith('.mjs')
      ? `console.log(${JSON.stringify(`RAN ${i.name}`)});\n`
      : `#!/usr/bin/env bash\necho "RAN ${i.name} $*"\n`);
    chmodSync(p, 0o755);
  }
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', join(dir, 'origin.git'));
  git('push', '-q', '-u', 'origin', 'main');
  git('remote', 'set-head', 'origin', '--auto');
  return { dir, work };
}

const hookPath = (hook) => join(fixture.work, '.git', 'hooks', hook);
const readHook = (hook) => (existsSync(hookPath(hook)) ? readFileSync(hookPath(hook), 'utf8') : '');
const countBlocks = (text) => (text.match(/^# >>> algovault /gm) ?? []).length;

function clearHooks() {
  const dir = join(fixture.work, '.git', 'hooks');
  for (const f of ['pre-push', 'pre-commit']) rmSync(join(dir, f), { force: true });
  for (const f of execFileSync('bash', ['-c', `ls ${dir} 2>/dev/null || true`], { encoding: 'utf8' }).split('\n')) {
    if (f.includes('.bak.SHARED-STATE-W1-')) rmSync(join(dir, f), { force: true });
  }
}

/**
 * Run an installer. Returns {code, out} rather than throwing, so a refusal can be asserted.
 *
 * spawnSync, NOT execFileSync: execFileSync's return value is stdout ONLY, so on the SUCCESS
 * path it silently drops stderr — and every banner this helper emits (the refusal, the
 * --allow-unpublished override, each skip) goes to stderr by design. An assertion on banner text
 * would then pass or fail depending on the exit code rather than on the banner, which is exactly
 * the kind of half-blind assertion this wave exists to stop shipping.
 */
function runInstaller(file, args = []) {
  const r = spawnSync('bash', [join(fixture.work, 'scripts', file), ...args], {
    cwd: fixture.work, encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

before(() => { fixture = buildFixture(); });

test('order-independence: installer sequence cannot change the resulting hook (R2.5)', () => {
  clearHooks();
  for (const i of INSTALLERS) assert.equal(runInstaller(i.file).code, 0, `${i.file} failed`);
  const forwardPush = readHook('pre-push');
  const forwardCommit = readHook('pre-commit');

  clearHooks();
  // Reverse order, and every installer run TWICE — the outcome must be a function of our
  // canonical ordering rule, never of the sequence or repetition.
  for (const i of [...INSTALLERS].reverse()) assert.equal(runInstaller(i.file).code, 0);
  for (const i of [...INSTALLERS].reverse()) assert.equal(runInstaller(i.file).code, 0);

  assert.equal(readHook('pre-push'), forwardPush, 'pre-push differs between installer orders');
  assert.equal(readHook('pre-commit'), forwardCommit, 'pre-commit differs between installer orders');
  assert.equal(countBlocks(forwardPush), 3, 'pre-push must hold exactly 3 blocks');
  assert.equal(countBlocks(forwardCommit), 1, 'pre-commit must hold exactly 1 block');
});

test('idempotence keys on <name> ALONE — a NEW wave-id must not append a duplicate (A3)', () => {
  clearHooks();
  runInstaller('install_test_gate_hook.sh');
  const before = countBlocks(readHook('pre-push'));

  // Simulate the installer being re-run after its wave-id changed. Keying idempotence on the
  // FULL sentinel (name + wave-id) would silently duplicate the block here — the same hazard
  // as the un-normalised sentinel, by another door.
  const inst = join(fixture.work, 'scripts', 'install_test_gate_hook.sh');
  const bumped = readFileSync(inst, 'utf8').replace('OPS-VITEST-SUITE-REPAIR-W1 "$GATE_SCRIPT"', 'OPS-SOME-LATER-WAVE-W9 "$GATE_SCRIPT"');
  assert.notEqual(bumped, readFileSync(inst, 'utf8'), 'test self-check: wave-id substitution must actually apply');
  writeFileSync(inst, bumped);
  assert.equal(runInstaller('install_test_gate_hook.sh').code, 0);

  const text = readHook('pre-push');
  assert.equal(countBlocks(text), before, 'a changed wave-id duplicated the block');
  assert.equal((text.match(/^# >>> algovault test-gate \(/gm) ?? []).length, 1);
  assert.match(text, /OPS-SOME-LATER-WAVE-W9/, 'the block should be REPLACED in place, not left stale');
  copyFileSync(join(ROOT, 'scripts', 'install_test_gate_hook.sh'), inst);
});

test('emitted sentinels stay byte-identical to the PRE-WAVE literals, so a stale installer no-ops (A3)', () => {
  clearHooks();
  for (const i of INSTALLERS) runInstaller(i.file);
  const text = readHook('pre-push');
  for (const sentinel of LEGACY_SENTINELS) {
    assert.ok(text.includes(sentinel), `emitter stopped producing the pre-wave sentinel: ${sentinel}`);
  }
});

test('a foreign hook body is preserved, never truncated by a sibling installer', () => {
  clearHooks();
  writeFileSync(hookPath('pre-push'), '#!/usr/bin/env bash\necho FOREIGN_BODY_MARKER\n', { mode: 0o755 });
  for (const i of INSTALLERS) runInstaller(i.file);
  assert.match(readHook('pre-push'), /FOREIGN_BODY_MARKER/);
});

test('assert_publishable REFUSES a script unreachable from the remote default ref (incident A)', () => {
  clearHooks();
  for (const i of INSTALLERS) runInstaller(i.file);
  const blocksBefore = countBlocks(readHook('pre-push'));

  // Committed locally, never pushed — incident A's exact condition.
  writeFileSync(join(fixture.work, 'scripts', 'check-unpublished.mjs'), 'console.log("nope");\n');
  writeFileSync(join(fixture.work, 'scripts', 'install_unpublished_hook.sh'), [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    'REPO_ROOT="$(git rev-parse --show-toplevel)"', '. "$REPO_ROOT/scripts/lib/hook-block.sh"',
    'ALLOW=0; for a in "$@"; do [ "$a" = "--allow-unpublished" ] && ALLOW=1; done',
    'hook_block_assert_publishable scripts/check-unpublished.mjs "$ALLOW" || exit 1',
    "hook_block_install pre-push unpublished OPS-X-W1 scripts/check-unpublished.mjs '# c' 'true'",
  ].join('\n'));
  execFileSync('git', ['-C', fixture.work, 'add', '-A']);
  execFileSync('git', ['-C', fixture.work, 'commit', '-qm', 'local only']);

  const refused = runInstaller('install_unpublished_hook.sh');
  assert.notEqual(refused.code, 0, 'installing an unpublished dep must FAIL');
  assert.match(refused.out, /REFUSING/);
  assert.match(refused.out, /push the script FIRST/, 'a refusal without remediation is hostile');
  assert.equal(countBlocks(readHook('pre-push')), blocksBefore, 'the shared hook must be left untouched on refusal');

  // The escape hatch installs, but must be auditable: banner AND a ledger row.
  const forced = runInstaller('install_unpublished_hook.sh', ['--allow-unpublished']);
  assert.equal(forced.code, 0);
  assert.match(forced.out, /--allow-unpublished OVERRIDE/);
  const ledger = join(fixture.work, '.git', 'algovault-hook-skip.log');
  assert.ok(existsSync(ledger), 'an override must leave a ledger row');
  assert.match(readFileSync(ledger, 'utf8'), /UNPUBLISHED_OVERRIDE\tscripts\/check-unpublished\.mjs/);
});

test('a missing script SKIPS its own block and still runs LATER blocks — never `exit 0`', () => {
  clearHooks();
  for (const i of INSTALLERS) runInstaller(i.file);

  // Hide the FIRST block's gate in canonical order (session-drift sorts before source-greppable
  // and test-gate). A bare `exit 0` in a skipped block would abort the whole hook here, silently
  // taking every LATER guard with it — the defect this if/else shape exists to avoid.
  const hidden = join(fixture.work, 'scripts', 'check-session-drift.mjs');
  const stash = `${hidden}.stashed`;
  copyFileSync(hidden, stash);
  rmSync(hidden);

  const res = execFileSync('bash', [hookPath('pre-push'), 'origin', 'url'], {
    cwd: fixture.work, encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrRun = runInstaller('install_test_gate_hook.sh'); // keep fixture consistent
  assert.equal(stderrRun.code, 0);

  assert.match(res, /RAN source-greppable/, 'a LATER block was skipped — the hook aborted early');
  assert.match(res, /RAN test-gate/, 'a LATER block was skipped — the hook aborted early');

  const ledger = readFileSync(join(fixture.work, '.git', 'algovault-hook-skip.log'), 'utf8');
  assert.match(ledger, /\tSKIP\tsession-drift\t/, 'a skip must be auditable, not silent');
  copyFileSync(stash, hidden);
});
