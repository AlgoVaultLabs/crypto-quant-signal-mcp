/**
 * OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 CH1 R4 — scripts/lib/with-lock.sh.
 *
 * These tests exercise the REAL mutex against a REAL temp lock root. There is deliberately no
 * seam substituting the lock: this file has exactly one interesting line (`mkdir "$dir"`), and a
 * hermetic test is structurally blind to exactly what its own seam replaces.
 *
 * Two house contracts are honoured throughout, both the hard way round:
 *
 *  · EVERY spawning block declares its timeout in the OPTIONS ARGUMENT (between the title and
 *    the callback), per scripts/check-test-budget.mjs. A `timeout:` inside the body does not
 *    count as a declaration and the gate is right to say so.
 *  · EVERY spawn scrubs GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / GIT_COMMON_DIR /
 *    GIT_QUARANTINE_PATH. Git exports those into hooks, so when this suite runs under the
 *    pre-push gate an unscrubbed child would resolve the REAL repo — mutating the operator's
 *    index from inside a test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';

const LOCK_SH = resolve(__dirname, '../../scripts/lib/with-lock.sh');

/** Git exports these into hooks; a child that inherits them resolves the REAL repo. */
const GIT_ENV_LEAKS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH'];

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of GIT_ENV_LEAKS) delete env[k];
  // Scrub the AMBIENT lock marker too. When this suite runs under the pre-push gate it is a
  // descendant of `git push`, which scripts/land.sh spawns while HOLDING the landing lock —
  // so every child inherits ALGOVAULT_LOCK_HELD_LANDING and a detector honestly answers
  // ACQUIRED. These cases assert about a SYNTHETIC lock root and must not inherit the real one.
  for (const k of Object.keys(env)) if (/^ALGOVAULT_LOCK_(HELD|DEPTH)_/.test(k)) delete env[k];
  return env;
}

function runLock(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [LOCK_SH, ...args], {
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
    cwd: tmpdir(), // never the repo: the lock root must come from ALGOVAULT_LOCK_DIR here
  });
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tokens = [...all.matchAll(/LANDING_LOCK_VERDICT=([A-Z]+)/g)].map((m) => m[1]);
  return { ...r, all, tokens, token: tokens[tokens.length - 1] };
}

/** Plant a lock directory with a holder record we control. */
function plantHolder(root: string, name: string, fields: Record<string, string | number>) {
  const dir = join(root, `${name}.lock`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'holder'),
    Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );
  return dir;
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'algovault-lock-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('with-lock.sh — the primitive itself', () => {
  it('the shipped --self-test passes', { timeout: 120_000 }, () => {
    const r = runLock(['--self-test']);
    expect(r.all).toMatch(/SELF-TEST: \d+ passed, 0 failed/);
    expect(r.status).toBe(0);
    expect(r.token).toBe('ACQUIRED');
  });

  it('acquires a free lock, runs the command, and releases', { timeout: 30_000 }, () => {
    const r = runLock(['t', '--', 'true'], { ALGOVAULT_LOCK_DIR: root });
    expect(r.token).toBe('ACQUIRED');
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 't.lock'))).toBe(false);
  });

  it('propagates the command exit code and still releases (trap, not the happy path)', { timeout: 30_000 }, () => {
    const r = runLock(['t', '--', 'sh', '-c', 'exit 7'], { ALGOVAULT_LOCK_DIR: root });
    expect(r.status).toBe(7);
    expect(existsSync(join(root, 't.lock'))).toBe(false);
  });

  it('releases on SIGINT', { timeout: 30_000 }, async () => {
    const child = spawn('bash', [LOCK_SH, 'sig', '--', 'sleep', '30'], {
      env: cleanEnv({ ALGOVAULT_LOCK_DIR: root }), cwd: tmpdir(),
    });
    // Wait for the lock to actually exist before interrupting — otherwise we might signal
    // before acquisition and prove nothing.
    const lockDir = join(root, 'sig.lock');
    for (let i = 0; i < 100 && !existsSync(lockDir); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(lockDir)).toBe(true);
    child.kill('SIGINT');
    await new Promise((r) => child.on('exit', r));
    expect(existsSync(lockDir)).toBe(false);
  });

  it('a nested acquire of the SAME lock does not self-deadlock (reentrancy)', { timeout: 30_000 }, () => {
    const r = runLock(['t', '--', 'bash', LOCK_SH, 't', '--', 'echo', 'NESTED-OK'],
      { ALGOVAULT_LOCK_DIR: root, ALGOVAULT_LOCK_TIMEOUT: '5' });
    expect(r.all).toContain('NESTED-OK');
    expect(r.all).toMatch(/reentrant, not re-locked/);
    expect(r.status).toBe(0);
  });
});

describe('with-lock.sh — stale-holder reclaim (R1b: without this, one crash deadlocks 49 checkouts)', () => {
  it('reclaims a holder whose pid is DEAD', { timeout: 30_000 }, () => {
    // Assert the fixture pid really is dead — otherwise this test proves nothing.
    expect(spawnSync('kill', ['-0', '2147483647']).status).not.toBe(0);
    plantHolder(root, 't', {
      pid: 2147483647, hostname: hostname(),
      acquired_at: new Date().toISOString(), acquired_epoch: Math.floor(Date.now() / 1000),
      worktree: root,
    });
    const r = runLock(['t', '--', 'true'], { ALGOVAULT_LOCK_DIR: root, ALGOVAULT_LOCK_TIMEOUT: '10' });
    expect(r.token).toBe('RECLAIMED');
    expect(r.all).toMatch(/RECLAIMING stale lock 't' — pid=2147483647 .* is no longer alive/);
  });

  it('reclaims a holder that has exceeded the TTL even when its pid is ALIVE', { timeout: 30_000 }, () => {
    plantHolder(root, 't', {
      pid: process.pid, hostname: hostname(),
      acquired_at: '1970-01-01T00:00:00Z', acquired_epoch: 1, worktree: root,
    });
    const r = runLock(['t', '--', 'true'],
      { ALGOVAULT_LOCK_DIR: root, ALGOVAULT_LOCK_TTL: '60', ALGOVAULT_LOCK_TIMEOUT: '10' });
    expect(r.token).toBe('RECLAIMED');
    expect(r.all).toMatch(/exceeding TTL 60s/);
  });

  it('does NOT reclaim a live, in-TTL holder — it waits, then fails OPEN with TIMEOUT', { timeout: 30_000 }, () => {
    const dir = plantHolder(root, 't', {
      pid: process.pid, hostname: hostname(),
      acquired_at: new Date().toISOString(), acquired_epoch: Math.floor(Date.now() / 1000),
      worktree: root,
    });
    const r = runLock(['t', '--', 'true'],
      { ALGOVAULT_LOCK_DIR: root, ALGOVAULT_LOCK_TIMEOUT: '2', ALGOVAULT_LOCK_POLL: '1' });
    expect(r.token).toBe('TIMEOUT');
    // R1d: fail OPEN. The work RAN, and exit 0 says so — the TOKEN is what carries "no lock".
    expect(r.status).toBe(0);
    expect(existsSync(dir)).toBe(true);        // the live holder was NOT stolen
    expect(r.all).toMatch(/Proceeding WITHOUT the lock/);
  });

  it('a dead pid on a DIFFERENT host is not reclaimed on pid evidence (only on TTL)', { timeout: 30_000 }, () => {
    plantHolder(root, 't', {
      pid: 2147483647, hostname: 'some-other-machine',
      acquired_at: new Date().toISOString(), acquired_epoch: Math.floor(Date.now() / 1000),
      worktree: root,
    });
    const r = runLock(['t', '--', 'true'],
      { ALGOVAULT_LOCK_DIR: root, ALGOVAULT_LOCK_TIMEOUT: '2', ALGOVAULT_LOCK_POLL: '1' });
    expect(r.token).toBe('TIMEOUT');
  });
});

describe('with-lock.sh — REAL contention (two concurrent holders serialize)', () => {
  it('two concurrent processes never hold the lock at the same time', { timeout: 60_000 }, async () => {
    const witness = join(root, 'witness.log');
    // Each holder appends ENTER, sleeps, appends EXIT. If the lock works, the file reads
    // ENTER/EXIT/ENTER/EXIT — never two ENTERs in a row. This is real contention, not a mock.
    const body = `printf 'ENTER %s\\n' "$$" >>${JSON.stringify(witness)}; sleep 1; printf 'EXIT %s\\n' "$$" >>${JSON.stringify(witness)}`;
    const spawnHolder = () => new Promise<number>((res) => {
      const c = spawn('bash', [LOCK_SH, 'contend', '--', 'bash', '-c', body], {
        env: cleanEnv({ ALGOVAULT_LOCK_DIR: root, ALGOVAULT_LOCK_TIMEOUT: '30', ALGOVAULT_LOCK_POLL: '1' }),
        cwd: tmpdir(), stdio: 'ignore',
      });
      c.on('exit', (code) => res(code ?? -1));
    });

    const codes = await Promise.all([spawnHolder(), spawnHolder(), spawnHolder()]);
    expect(codes).toEqual([0, 0, 0]);

    const lines = readFileSync(witness, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(6);
    // The interleaving check: strictly alternating ENTER/EXIT proves mutual exclusion.
    lines.forEach((l, i) => expect(l.split(' ')[0]).toBe(i % 2 === 0 ? 'ENTER' : 'EXIT'));
    // …and each EXIT belongs to the ENTER immediately before it.
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i].split(' ')[1]).toBe(lines[i + 1].split(' ')[1]);
    }
    expect(existsSync(join(root, 'contend.lock'))).toBe(false);
  });
});

describe('with-lock.sh --detect — the bypass detector (READ-ONLY, no stdin)', () => {
  it('reports BYPASSED outside a lock and ACQUIRED inside one', { timeout: 30_000 }, () => {
    const outside = runLock(['--detect', 'landing'], { ALGOVAULT_LOCK_DIR: root });
    expect(outside.token).toBe('BYPASSED');
    expect(outside.status).toBe(0);

    const inside = runLock(['landing', '--', 'bash', LOCK_SH, '--detect', 'landing'],
      { ALGOVAULT_LOCK_DIR: root });
    expect(inside.tokens[0]).toBe('ACQUIRED');
    expect(inside.status).toBe(0);
  });

  it('a FORGED marker is not believed — the detector cross-checks a real live holder', { timeout: 30_000 }, () => {
    const r = runLock(['--detect', 'landing'], {
      ALGOVAULT_LOCK_DIR: root,
      ALGOVAULT_LOCK_HELD_LANDING: join(root, 'landing.lock'), // points at nothing
    });
    expect(r.token).toBe('BYPASSED');
  });

  it('THE BLOCKING CONTRACT: --detect consumes NO stdin', { timeout: 30_000 }, () => {
    // check-push-safety.sh sorts AFTER bypass-detect and reads the hook's stdin to learn which
    // refs are being pushed; its 3-state contract PASSes on zero lines. If --detect drained
    // stdin, force-push and deletion protection would silently pass over an unprotected push.
    // So: feed stdin, and prove every byte is still there afterwards.
    const payload = 'refs/heads/x aaa refs/heads/x bbb\nrefs/heads/y ccc refs/heads/y ddd\n';
    const r = spawnSync('bash', ['-c',
      `bash ${JSON.stringify(LOCK_SH)} --detect landing >/dev/null 2>&1; cat`], {
      input: payload, encoding: 'utf8', env: cleanEnv({ ALGOVAULT_LOCK_DIR: root }), cwd: tmpdir(),
    });
    expect(r.stdout).toBe(payload);
  });
});

describe('with-lock.sh — INDETERMINATE is reachable only for "could not evaluate"', () => {
  it('a malformed invocation is INDETERMINATE and exits 3, never a pass', { timeout: 30_000 }, () => {
    const r = runLock(['t', 'no-double-dash'], { ALGOVAULT_LOCK_DIR: root });
    expect(r.token).toBe('INDETERMINATE');
    expect(r.status).toBe(3);
  });

  it('no git repo and no ALGOVAULT_LOCK_DIR is INDETERMINATE, not a silent acquire', { timeout: 30_000 }, () => {
    const outside = mkdtempSync(join(tmpdir(), 'algovault-nonrepo-'));
    try {
      const env = cleanEnv();
      delete env.ALGOVAULT_LOCK_DIR;
      const r = spawnSync('bash', [LOCK_SH, 't', '--', 'true'],
        { encoding: 'utf8', env, cwd: outside });
      expect(r.status).toBe(3);
      expect(`${r.stdout}${r.stderr}`).toMatch(/cannot resolve a lock root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('with-lock.sh — single derivation', () => {
  it('is the ONLY lock implementation in scripts/ (comment-stripped)', { timeout: 30_000 }, () => {
    // Comments are stripped first. This repo already codified why: a ban-grep that reads its own
    // docblock demands the deletion of the most valuable line in the file, and land.sh's header
    // must be free to say which primitive it delegates to.
    const r = spawnSync('bash', ['-c',
      `git ls-files 'scripts/**/*.sh' | while read -r f; do ` +
      `  [ "$f" = 'scripts/lib/with-lock.sh' ] && continue; ` +
      `  grep -vE '^[[:space:]]*#' "$f" | grep -qE 'flock|mkdir[[:space:]]+"?[^"]*\\.lock|fcntl\\.flock' && echo "$f"; ` +
      `done; true`],
      { encoding: 'utf8', cwd: resolve(__dirname, '../..'), env: cleanEnv() });
    expect(r.stdout.trim()).toBe('');
  });
});
