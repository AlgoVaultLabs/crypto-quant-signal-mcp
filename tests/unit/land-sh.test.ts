/**
 * OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 CH1 R2/R4 — scripts/land.sh.
 *
 * Every case runs the REAL script against REAL throwaway git repositories (a bare remote plus
 * clones), never the operator's checkout. The lock root is redirected with ALGOVAULT_LOCK_DIR,
 * so nothing here can touch $GIT_COMMON_DIR.
 *
 * Spawning blocks declare their timeout in the OPTIONS ARGUMENT (scripts/check-test-budget.mjs),
 * and every spawn scrubs the GIT_* variables git exports into hooks — without that, running this
 * suite from inside the pre-push gate would resolve the real repository.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(__dirname, '../..');
const GIT_ENV_LEAKS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH'];

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    ...extra,
  };
  for (const k of GIT_ENV_LEAKS) delete env[k];
  // Scrub the AMBIENT lock marker too. When this suite runs under the pre-push gate it is a
  // descendant of `git push`, which scripts/land.sh spawns while HOLDING the landing lock —
  // so every child inherits ALGOVAULT_LOCK_HELD_LANDING and a detector honestly answers
  // ACQUIRED. These cases assert about a SYNTHETIC lock root and must not inherit the real one.
  for (const k of Object.keys(env)) if (/^ALGOVAULT_LOCK_(HELD|DEPTH)_/.test(k)) delete env[k];
  return env;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function land(cwd: string, lockDir: string, args: string[] = []) {
  const r = spawnSync('bash', [join(cwd, 'scripts/land.sh'), ...args], {
    cwd, encoding: 'utf8', env: cleanEnv({ ALGOVAULT_LOCK_DIR: lockDir }),
  });
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const grab = (k: string) => {
    const m = [...all.matchAll(new RegExp(`${k}=([A-Za-z0-9_]+)`, 'g'))];
    return m.length ? m[m.length - 1][1] : undefined;
  };
  return { ...r, all, verdict: grab('LAND_VERDICT'), attempts: grab('LAND_ATTEMPTS'), lock: grab('LANDING_LOCK_VERDICT') };
}

/** A bare remote with one commit, plus N clones carrying the scripts under test. */
function makeEstate(root: string, clones: number) {
  const bare = join(root, 'remote.git');
  mkdirSync(bare, { recursive: true });
  spawnSync('git', ['init', '--bare', '-b', 'main', bare], { env: cleanEnv() });

  const seed = join(root, 'seed');
  spawnSync('git', ['clone', bare, seed], { env: cleanEnv() });
  writeFileSync(join(seed, 'README'), 'seed\n');
  git(seed, 'add', 'README');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', 'origin', 'main');

  const paths: string[] = [];
  for (let i = 0; i < clones; i++) {
    const c = join(root, `clone${i}`);
    spawnSync('git', ['clone', bare, c], { env: cleanEnv() });
    mkdirSync(join(c, 'scripts/lib'), { recursive: true });
    copyFileSync(join(REPO, 'scripts/land.sh'), join(c, 'scripts/land.sh'));
    copyFileSync(join(REPO, 'scripts/lib/with-lock.sh'), join(c, 'scripts/lib/with-lock.sh'));
    // A clone has no origin/HEAD symref by default in some git versions; land.sh falls back to
    // origin/main, but set it so the resolution path under test is the real one.
    spawnSync('git', ['remote', 'set-head', 'origin', 'main'], { cwd: c, env: cleanEnv() });
    paths.push(c);
  }
  return { bare, paths };
}

function commitOn(clone: string, file: string, body: string) {
  writeFileSync(join(clone, file), body);
  git(clone, 'add', file);
  git(clone, 'commit', '-m', `add ${file}`);
}

let root: string;
let lockDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'algovault-land-test-'));
  lockDir = join(root, 'locks');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('land.sh — preconditions refuse before the lock is ever taken', () => {
  it('refuses a dirty TRACKED tree with LAND_VERDICT=DIRTY', { timeout: 60_000 }, () => {
    const { paths: [c] } = makeEstate(root, 1);
    writeFileSync(join(c, 'README'), 'dirtied\n');
    const r = land(c, lockDir);
    expect(r.verdict).toBe('DIRTY');
    expect(r.status).toBe(1);
    expect(r.all).toMatch(/Refusing to rebase a dirty tree/);
    // The lock was never taken — the refusal is cheap and happens first.
    expect(r.lock).toBeUndefined();
  });

  it('refuses a detached HEAD as INDETERMINATE (exit 3), never a silent pass', { timeout: 60_000 }, () => {
    const { paths: [c] } = makeEstate(root, 1);
    git(c, 'checkout', '--detach', 'HEAD');
    const r = land(c, lockDir);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.status).toBe(3);
  });
});

describe('land.sh — the happy path', () => {
  it('lands a commit in exactly ONE push attempt', { timeout: 60_000 }, () => {
    const { bare, paths: [c] } = makeEstate(root, 1);
    commitOn(c, 'a.txt', 'a\n');
    const r = land(c, lockDir);
    expect(r.verdict).toBe('LANDED');
    expect(r.status).toBe(0);
    // THE PRIMARY METRIC: one gate execution per landing.
    expect(r.attempts).toBe('1');
    expect(r.lock).toBe('ACQUIRED');
    // The remote really moved.
    expect(git(bare, 'log', '--oneline', '-1', 'main')).toMatch(/add a\.txt/);
    // And the lock was released.
    expect(spawnSync('test', ['-d', join(lockDir, 'landing.lock')]).status).not.toBe(0);
  });

  it('rebases onto a remote that moved, then lands — still one attempt', { timeout: 60_000 }, () => {
    const { bare, paths: [a, b] } = makeEstate(root, 2);
    commitOn(a, 'a.txt', 'a\n');
    git(a, 'push', 'origin', 'main');                 // remote moves under b
    commitOn(b, 'b.txt', 'b\n');
    const r = land(b, lockDir);
    expect(r.verdict).toBe('LANDED');
    expect(r.attempts).toBe('1');                     // rebase inside the lock, no retry needed
    const log = git(bare, 'log', '--oneline', 'main');
    expect(log).toMatch(/add b\.txt/);
    expect(log).toMatch(/add a\.txt/);
  });
});

describe('land.sh — a conflict is handed back, never auto-resolved', () => {
  it('aborts the rebase, names the conflicted paths, and leaves the branch untouched', { timeout: 60_000 }, () => {
    const { paths: [a, b] } = makeEstate(root, 2);
    commitOn(a, 'clash.txt', 'from-a\n');
    git(a, 'push', 'origin', 'main');
    commitOn(b, 'clash.txt', 'from-b\n');
    const headBefore = git(b, 'rev-parse', 'HEAD');

    const r = land(b, lockDir);
    expect(r.verdict).toBe('CONFLICT');
    expect(r.status).toBe(1);
    expect(r.all).toContain('clash.txt');
    expect(r.all).toMatch(/never auto-resolve a conflict/);
    // The branch is exactly where it was, no TRACKED file was touched, and — the part that
    // matters — no rebase is left in progress for the operator to discover later.
    // (`git status --porcelain` also lists the fixture's own uncommitted `scripts/` copy, which
    // is scaffolding rather than rebase residue, so assert on tracked state specifically.)
    expect(git(b, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(b, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(spawnSync('test', ['-d', join(b, '.git/rebase-merge')]).status).not.toBe(0);
    expect(spawnSync('test', ['-d', join(b, '.git/rebase-apply')]).status).not.toBe(0);
    // The lock was released despite the non-zero exit.
    expect(spawnSync('test', ['-d', join(lockDir, 'landing.lock')]).status).not.toBe(0);
  });
});

describe('land.sh — a red gate is surfaced, NEVER retried or routed around', () => {
  it('a refusing pre-push hook yields GATE_BLOCKED in ONE attempt, with the block token verbatim', { timeout: 60_000 }, () => {
    const { paths: [c] } = makeEstate(root, 1);
    // Stand in for a real pre-push block that refuses.
    const hook = join(c, '.git/hooks/pre-push');
    writeFileSync(hook, '#!/usr/bin/env bash\necho "FAKE_GATE_VERDICT=FAIL"\nexit 1\n');
    chmodSync(hook, 0o755);
    commitOn(c, 'a.txt', 'a\n');

    const r = land(c, lockDir);
    expect(r.verdict).toBe('GATE_BLOCKED');
    expect(r.status).toBe(1);
    // Retrying a red gate is routing around it. Exactly one attempt.
    expect(r.attempts).toBe('1');
    // The block's own token is surfaced verbatim, not swallowed or downgraded.
    expect(r.all).toContain('FAKE_GATE_VERDICT=FAIL');
    expect(r.all).toMatch(/does not retry, warn-mode, or route around a gate/);
  });
});

describe('land.sh — the flags it must never carry', () => {
  it('contains no force / verify-skipping / deletion flag OUTSIDE its own documentation', { timeout: 30_000 }, () => {
    // Comments are stripped first, per the codified rule: a ban-grep that matches its own
    // docblock demands the deletion of the line that explains the ban.
    const src = readFileSync(join(REPO, 'scripts/land.sh'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/--force/);
    expect(code).not.toMatch(/--no-verify/);
    expect(code).not.toMatch(/--delete/);
    // …and prove the ban is stated where a reader will find it.
    expect(src).toMatch(/never pass a force flag/);
  });
});
