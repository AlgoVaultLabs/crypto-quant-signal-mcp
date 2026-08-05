/**
 * session-drift.test.ts — OPS-CC-DRIFT-DETECTOR-W1.
 *
 * The gate's own decision logic, plus the contract that keeps it from becoming the 7th dark
 * guard found in this repo: exactly one verdict token per path, fail-CLOSED on indeterminate,
 * and a self-test that cannot report a pass while vacuous.
 *
 * Strategy mirrors tests/unit/test-gate-report-path.test.ts: drive the REAL file via
 * spawnSync so what is asserted is what ships, not a re-implementation.
 *
 * BUDGETS — 120 s, raised from 30 s by OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch2.
 *
 * This file IS the pre-push gate's floor, and the cost is not its own: three of its tests
 * run the drift script for REAL against this repo (`cwd` = the toplevel), and that script
 * probes EVERY live worktree — 3 git subprocesses x 89 checkouts. Measured 34 s for this
 * file ALONE versus 32 s for the whole 390-file suite, i.e. no worker cap can make the gate
 * faster than this one file. The script's own docblock recorded 5.0 s per full run at 59
 * worktrees and predicted this: "if the worktree count grows much further, parallelising
 * the per-worktree probes is the next lever".
 *
 * So the budget scales with a number nobody edits deliberately. At 15.9 s for the slowest
 * test today, 30 s survived 5 concurrent gates with no headroom and would not survive 10.
 * 120 s is sized for the fleet growing, not for today.
 *
 * Reclaiming stale worktrees (Ch4) is the only lever that lowers this floor; making the
 * probes concurrent is the generator-level fix and is deliberately out of scope here —
 * OPS-DRIFT-PROBE-PARALLELISE-W{NEXT}.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'check-session-drift.mjs');
const CONFIG = resolve(__dirname, '..', '..', 'ops', 'session-drift-config.json');

function run(args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { exitCode: r.status ?? -1, stdout, stderr, all: `${stdout}\n${stderr}` };
}

const tokenOf = (stdout: string) => (stdout.match(/^SESSION_DRIFT_VERDICT=(\w+)$/m) ?? [])[1];

describe('check-session-drift.mjs — verdict contract', () => {
  it('--self-test is two-way, non-vacuous, and names every case', () => {
    const r = run(['--self-test']);

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(tokenOf(r.stdout)).toBe('PASS');
    expect(r.stdout).toMatch(/must-fire/);
    expect(r.stdout).toMatch(/must-not-fire/);
    expect(r.stdout).toMatch(/must-map/);

    // Non-vacuity read off the SUMMARY line, where the count PRECEDES the label. Matching
    // `must-fire[^0-9]*0` instead would hit a per-case line ending "⇒ exit 0".
    const m = r.stdout.match(/self-test passed \((\d+) must-fire, (\d+) must-not-fire, (\d+) must-map\)/);
    expect(m, `no summary line in:\n${r.all}`).toBeTruthy();
    for (const n of (m ?? []).slice(1)) expect(Number(n)).toBeGreaterThan(0);
  });

  // 30s: these spawn the REAL gate, which probes 59 worktrees + 43 refs (~5s measured).
  // Asserting against the real thing is the point, so the timeout accommodates it rather
  // than the test being weakened into a mock.
  it('prints EXACTLY ONE terminal verdict line on every path', { timeout: 120_000 }, () => {
    for (const [label, r] of [
      ['real run', run()],
      ['self-test', run(['--self-test'])],
    ] as const) {
      const n = r.stdout.split('\n').filter((l) => l.startsWith('SESSION_DRIFT_VERDICT=')).length;
      expect(n, `${label}: expected 1 verdict line, got ${n}\n${r.all}`).toBe(1);
    }
  });

  it('emits POSITIVE per-check output for all three modes, carrying measured values', { timeout: 120_000 }, () => {
    const r = run();
    // Absence-of-alert is never the assertion — each check must speak up with its numbers.
    expect(r.stdout).toMatch(/stale_base\s+base=\w+ head=\w+ origin\/main=\w+ behind=\d+ landed_files=\d+ my_files=\d+ overlap=\d+/);
    expect(r.stdout).toMatch(/worktree_overlap\s+worktrees_scanned=\d+ my_tracked_files=\d+ colliding_worktrees=\d+ enforcement=\w+/);
    expect(r.stdout).toMatch(/merged_live_refs\s+remote_refs=\d+ merged_but_live=\d+ stale_over_\d+d=\d+/);
  });

  // The bug this pins was invisible to every other form of testing. Under `pre-push` git
  // exports GIT_DIR/GIT_WORK_TREE, and env GIT_DIR overrides even `git -C <dir>` — so mode 2's
  // per-worktree probes silently read the PUSHING repo instead. Measured on the first real
  // hook invocation: colliding_worktrees=59 of 59 (100% false positives) while a standalone
  // run of the same commit reported 0. No standalone run, unit test or --self-test could see
  // it, because none of them have git's hook env set. So the test sets it explicitly.
  it('is immune to git hook env leakage (GIT_DIR overrides even `git -C`)', { timeout: 120_000 }, () => {
    const gitDir = resolve(__dirname, '..', '..', '.git');
    const clean = run();
    const hooked = run([], { GIT_DIR: gitDir, GIT_WORK_TREE: resolve(__dirname, '..', '..') });

    const countOf = (out: string) =>
      Number((out.match(/colliding_worktrees=(\d+)/) ?? [])[1] ?? -1);

    expect(countOf(hooked.stdout), `hooked run:\n${hooked.all}`).toBeGreaterThanOrEqual(0);
    expect(
      countOf(hooked.stdout),
      `hook env changed the verdict — GIT_DIR leaked into the per-worktree probes.\nclean:\n${clean.stdout}\nhooked:\n${hooked.stdout}`,
    ).toBe(countOf(clean.stdout));
    expect(tokenOf(hooked.stdout)).toBe(tokenOf(clean.stdout));
  });

  it('fails CLOSED on an unparseable config: INDETERMINATE + exit 3', { timeout: 120_000 }, () => {
    const backup = readFileSync(CONFIG, 'utf8');
    try {
      writeFileSync(CONFIG, 'not json at all');
      const r = run();
      expect(r.exitCode, `output:\n${r.all}`).toBe(3);
      expect(tokenOf(r.stdout)).toBe('INDETERMINATE');
    } finally {
      writeFileSync(CONFIG, backup);
    }
  });

  it('fails CLOSED when a union_safe_paths row lacks a `reason`', { timeout: 120_000 }, () => {
    const backup = readFileSync(CONFIG, 'utf8');
    try {
      writeFileSync(CONFIG, JSON.stringify({ union_safe_paths: [{ path: 'status.md' }] }));
      const r = run();
      expect(r.exitCode, `output:\n${r.all}`).toBe(3);
      expect(tokenOf(r.stdout)).toBe('INDETERMINATE');
      expect(r.all).toMatch(/reason/i);
    } finally {
      writeFileSync(CONFIG, backup);
    }
  });

  it('ALGOVAULT_SESSION_DRIFT=warn downgrades the CODE but never the TOKEN', { timeout: 120_000 }, () => {
    const backup = readFileSync(CONFIG, 'utf8');
    try {
      writeFileSync(CONFIG, 'not json at all');
      const r = run([], { ALGOVAULT_SESSION_DRIFT: 'warn' });
      expect(r.exitCode, `output:\n${r.all}`).toBe(0);
      // The whole point of the lever: exit 0, but the honest token still printed.
      expect(tokenOf(r.stdout)).toBe('INDETERMINATE');
    } finally {
      writeFileSync(CONFIG, backup);
    }
  });
});

describe('session-drift config', () => {
  it('every union_safe_paths row carries its own reason', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(Array.isArray(cfg.union_safe_paths)).toBe(true);
    expect(cfg.union_safe_paths.length).toBeGreaterThan(0);
    for (const row of cfg.union_safe_paths) {
      expect(row.path, `row without a path: ${JSON.stringify(row)}`).toBeTruthy();
      // An exemption that lives only in prose gets "fixed" by a future wave enforcing the
      // contract — so the reason lives ON THE ROW.
      expect(row.reason, `union-safe row "${row.path}" has no reason`).toBeTruthy();
      expect(String(row.reason).length).toBeGreaterThan(40);
    }
  });

  it('ships mode 2 as REPORT with a numeric promotion criterion', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.mode2_enforcement).toBe('report');
    // A criterion the operator can check, not a vibe.
    expect(cfg._mode2_promotion_criterion).toMatch(/\d+/);
  });
});

describe('install_session_drift_hook.sh', () => {
  it('is idempotent and never disturbs the existing test-gate block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-hook-'));
    try {
      spawnSync('git', ['-C', dir, 'init', '-q', '--initial-branch=main']);
      const hookDir = join(dir, '.git', 'hooks');
      const hookPath = join(hookDir, 'pre-push');
      // Seed a hook that already carries the test-gate block, exactly as the real one does.
      const seeded = [
        '#!/usr/bin/env bash',
        '',
        '# >>> algovault test-gate (OPS-VITEST-SUITE-REPAIR-W1) >>>',
        '"$(git rev-parse --show-toplevel)/scripts/check_test_baseline.sh" || exit 1',
        '# <<< algovault test-gate <<<',
        '',
      ].join('\n');
      writeFileSync(hookPath, seeded);

      // OPS-SHARED-WORKTREE-STATE-REGISTRY-W1: the installer now sources scripts/lib/hook-block.sh
      // (the ONE emitter shared by all four installers) and calls hook_block_assert_publishable,
      // which refuses to write a block whose script is unreachable from the RESOLVED remote
      // default ref. So the fixture needs the helper, the gate script, and a resolvable
      // origin/HEAD — i.e. it now has to look like a real clone, which is the point of the
      // precondition. `git update-ref` stands in for a bare remote: cheaper, same observable.
      mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
      copyFileSync(
        resolve(__dirname, '..', '..', 'scripts', 'lib', 'hook-block.sh'),
        join(dir, 'scripts', 'lib', 'hook-block.sh'),
      );
      writeFileSync(join(dir, 'scripts', 'check-session-drift.mjs'), 'console.log("stub");\n');
      spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
      spawnSync('git', ['-C', dir, 'config', 'user.name', 'test']);
      spawnSync('git', ['-C', dir, 'add', '-A']);
      spawnSync('git', ['-C', dir, 'commit', '-qm', 'fixture']);
      spawnSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
      spawnSync('git', ['-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

      const installer = readFileSync(resolve(__dirname, '..', '..', 'scripts', 'install_session_drift_hook.sh'), 'utf8');
      const local = join(dir, 'install.sh');
      writeFileSync(local, installer);

      const first = spawnSync('bash', [local], { cwd: dir, encoding: 'utf8' });
      expect(first.status, first.stderr).toBe(0);
      const after1 = readFileSync(hookPath, 'utf8');

      // The pre-existing BLOCK must survive byte-for-byte — that is what this assertion has
      // always been about. It is no longer contiguous with the shebang, because block order is
      // now canonical (LC_ALL=C by name) rather than append-order, so `session-drift` sorts
      // ahead of `test-gate`. Asserting on the block itself keeps the original intent without
      // pinning an incidental layout detail.
      expect(after1).toContain(
        [
          '# >>> algovault test-gate (OPS-VITEST-SUITE-REPAIR-W1) >>>',
          '"$(git rev-parse --show-toplevel)/scripts/check_test_baseline.sh" || exit 1',
          '# <<< algovault test-gate <<<',
        ].join('\n'),
      );
      expect(after1.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(after1).toContain('algovault session-drift');

      const second = spawnSync('bash', [local], { cwd: dir, encoding: 'utf8' });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/idempotent no-op/);
      // Re-running adds nothing.
      expect(readFileSync(hookPath, 'utf8')).toBe(after1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
