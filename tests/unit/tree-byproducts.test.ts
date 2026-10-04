/**
 * OPS-CHECKOUT-PARITY-SIGNAL-MCP-W1 CH2 — scripts/check-tree-byproducts.mjs, driven as the REAL CLI.
 *
 * The gate wraps the Postgres lane's suite: snapshot the tree, run the suite, compare. Its job is to
 * make a test-written byproduct red at the commit that introduces it — `8ddd5405`'s own unit test
 * wrote `ops/monitoring/__pycache__/` into every checkout that ran it, and the first signal was a host
 * page the next day. These cases spawn the script exactly as the workflow does (argv -> stdout token
 * -> exit code), so a broken entrypoint, a lost token or a wrong exit mapping all fail here.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'check-tree-byproducts.mjs');
const TOKEN = 'TREE_BYPRODUCT_VERDICT=';
/** git exports these into hooks; nothing here may resolve to the real repository. */
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => ![
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(k)));
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null'];

function cli(args: string[], cwd = REPO): { tokens: string[]; out: string; code: number | null } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  expect(r.error, 'script spawned').toBeUndefined();
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { tokens: out.split('\n').filter((l) => l.includes(TOKEN)), out, code: r.status };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', [...IDENT, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  expect(r.status, `git ${args[0]}: ${r.stderr}`).toBe(0);
}

describe('check-tree-byproducts.mjs — the real CLI', () => {
  it('--self-test: exit 0, exactly one PASS token, and a non-vacuous summary', { timeout: 60_000 }, () => {
    const r = cli(['--self-test']);
    expect(r.tokens, r.out).toEqual([`${TOKEN}PASS`]);
    expect(r.code).toBe(0);
    const m = r.out.match(/SELF-TEST: PASS \((\d+) must-fire, (\d+) must-not-fire, (\d+) indeterminate, (\d+) must-map\)/);
    expect(m, r.out).not.toBeNull();
    for (const n of m!.slice(1)) expect(Number(n)).toBeGreaterThan(0);
  });

  it('a bad invocation is INDETERMINATE (exit 3), never a pass', { timeout: 60_000 }, () => {
    for (const args of [[], ['--compare'], ['--bogus', 'x'], ['--self-test', 'extra']]) {
      const r = cli(args);
      expect(r.tokens, `${args.join(' ')}: ${r.out}`).toEqual([`${TOKEN}INDETERMINATE`]);
      expect(r.code).toBe(3);
    }
  });

  it('a missing snapshot is INDETERMINATE (exit 3) — the before-state was never recorded', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tbp-missing-'));
    try {
      const r = cli(['--compare', join(dir, 'never-written.z')]);
      expect(r.tokens, r.out).toEqual([`${TOKEN}INDETERMINATE`]);
      expect(r.code).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('end to end in a throwaway repo: clean PASS, then a new file FAILs (exit 1) and is named', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tbp-repo-'));
    const snaps = mkdtempSync(join(tmpdir(), 'tbp-snap-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      git(dir, 'add', '--', 'a.txt');
      git(dir, 'commit', '-q', '-m', 'fixture');
      const snap = join(snaps, 'before.z');

      const s = cli(['--snapshot', snap], dir);
      expect(s.tokens, s.out).toEqual([`${TOKEN}PASS`]);
      expect(s.out).toMatch(/snapshot recorded: 0 entries/);

      const clean = cli(['--compare', snap], dir);
      expect(clean.tokens, clean.out).toEqual([`${TOKEN}PASS`]);
      expect(clean.code).toBe(0);
      expect(clean.out).toMatch(/^before 0 · after 0 · new 0 · gone 0/m);

      writeFileSync(join(dir, 'left-behind.json'), '{}');
      const dirty = cli(['--compare', snap], dir);
      expect(dirty.tokens, dirty.out).toEqual([`${TOKEN}FAIL`]);
      expect(dirty.code).toBe(1);
      expect(dirty.out).toContain('  NEW   ?? left-behind.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(snaps, { recursive: true, force: true });
    }
  });

  it('refuses a snapshot path inside the work tree (it would itself be a byproduct)', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tbp-inside-'));
    try {
      git(dir, 'init', '-q');
      const r = cli(['--snapshot', join(dir, 'before.z')], dir);
      expect(r.tokens, r.out).toEqual([`${TOKEN}INDETERMINATE`]);
      expect(r.code).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
