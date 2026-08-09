/**
 * OPS-GIT-IDENTITY-CANONICALIZE-W1 — behaviour tests for `scripts/check-author-identity.sh`.
 *
 * Pins BEHAVIOURS, never a hash: a hash cannot catch a re-vendor from a stale source that also
 * re-records the hash, and it says nothing about whether the gate still judges correctly.
 *
 * Every case runs in its OWN temp git repo (mkdtempSync + `git -C <dir>`), never against this
 * checkout's real `ops/author-identity-allowlist.json`. Two reasons, both load-bearing:
 *   1. A test that rewrites a shared artifact races any parallel reader in the same suite.
 *   2. Swapping the live allowlist would be a seam that can make the gate print PASS. The script
 *      deliberately has no allowlist-path override for exactly that reason; a temp repo gives the
 *      same coverage with none of the risk, because `git rev-parse --show-toplevel` relocates the
 *      lookup honestly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'check-author-identity.sh');
const LIVE_ALLOWLIST = resolve(__dirname, '..', '..', 'ops', 'author-identity-allowlist.json');

const CANONICAL = '264139505+AlgoVaultFi@users.noreply.github.com';
const MEGATRON = '268183053+Megatron888-Robot@users.noreply.github.com';

interface Sandbox {
  dir: string;
  cleanup: () => void;
}

/** A throwaway repo carrying its own allowlist. `allowlist === null` omits the file entirely. */
function sandbox(allowlist: string | null): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'author-identity-'));
  execFileSync('git', ['-C', dir, 'init', '--initial-branch=main', '-q']);
  mkdirSync(join(dir, 'ops'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-author-identity.sh'));
  chmodSync(join(dir, 'scripts', 'check-author-identity.sh'), 0o755);
  if (allowlist !== null) writeFileSync(join(dir, 'ops', 'author-identity-allowlist.json'), allowlist);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run the gate inside `dir` as the given author. Returns the terminal token + the exit code. */
function runGate(dir: string, email: string, name = 'probe', env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(dir, 'scripts', 'check-author-identity.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, ...env },
  });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { token: lines[lines.length - 1] ?? '', code: r.status, stderr: r.stderr ?? '' };
}

const REPORT_MODE = JSON.stringify({
  allowed: [{ email: CANONICAL, name: 'AlgoVaultFi', class: 'canonical', reason: 'test fixture' }],
  denied: [{ email: 'test@test.local', reason: 'test fixture' }],
  promotion: { mode: 'report', max_violations: 0, not_before: '2026-08-16' },
});
const BLOCK_MODE = JSON.stringify({
  allowed: [{ email: CANONICAL, name: 'AlgoVaultFi', class: 'canonical', reason: 'test fixture' }],
  denied: [{ email: 'test@test.local', reason: 'test fixture' }],
  promotion: { mode: 'block', max_violations: 0, not_before: '2026-08-16' },
});

describe('check-author-identity.sh — self-test', () => {
  it('passes, and its terminal line is the verdict token', () => {
    const r = spawnSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    const lines = (r.stdout ?? '').trim().split('\n');
    expect(lines[lines.length - 1]).toBe('AUTHOR_IDENTITY_VERDICT=PASS');
    expect(r.status).toBe(0);
  });

  it('is not vacuous — it reports a positive assertion count', () => {
    const r = spawnSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    const m = (r.stdout ?? '').match(/SELF-TEST: (\d+) passed, (\d+) failed \((\d+) assertions\)/);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBeGreaterThan(0);
    expect(Number(m![2])).toBe(0);
  });
});

describe('check-author-identity.sh — verdict token for all three states', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('PASS for an allowlisted author', () => {
    sb = sandbox(REPORT_MODE);
    expect(runGate(sb.dir, CANONICAL).token).toBe('AUTHOR_IDENTITY_VERDICT=PASS');
  });

  it('FAIL for an explicitly denied author', () => {
    sb = sandbox(REPORT_MODE);
    expect(runGate(sb.dir, 'test@test.local').token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
  });

  it('FAIL for an unknown author — allowlist semantics, not deny-list', () => {
    sb = sandbox(REPORT_MODE);
    expect(runGate(sb.dir, 'someone@nowhere.example').token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
  });

  it('INDETERMINATE for an EMPTY allowed[] — we author that file, so empty is our defect', () => {
    sb = sandbox(JSON.stringify({ allowed: [], denied: [], promotion: { mode: 'report' } }));
    const r = runGate(sb.dir, CANONICAL);
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('INDETERMINATE for an unparseable allowlist', () => {
    sb = sandbox('not json at all {{{');
    const r = runGate(sb.dir, CANONICAL);
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('INDETERMINATE for a missing allowlist', () => {
    sb = sandbox(null);
    const r = runGate(sb.dir, CANONICAL);
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=INDETERMINATE');
    expect(r.code).toBe(3);
  });
});

describe('check-author-identity.sh — token to exit-code mapping', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('PASS maps to 0', () => {
    sb = sandbox(BLOCK_MODE);
    expect(runGate(sb.dir, CANONICAL).code).toBe(0);
  });

  it('FAIL maps to 1 in BLOCK mode', () => {
    sb = sandbox(BLOCK_MODE);
    const r = runGate(sb.dir, 'test@test.local');
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
    expect(r.code).toBe(1);
  });

  it('REPORT mode downgrades the CODE to 0 but never launders the TOKEN', () => {
    sb = sandbox(REPORT_MODE);
    const r = runGate(sb.dir, 'test@test.local');
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
    expect(r.code).toBe(0);
  });

  it('ALGOVAULT_AUTHOR_IDENTITY=warn downgrades the CODE only, in BLOCK mode', () => {
    sb = sandbox(BLOCK_MODE);
    const r = runGate(sb.dir, 'test@test.local', 'probe', { ALGOVAULT_AUTHOR_IDENTITY: 'warn' });
    expect(r.token).toBe('AUTHOR_IDENTITY_VERDICT=FAIL');
    expect(r.code).toBe(0);
  });

  it('no lever can make a denied author print PASS', () => {
    sb = sandbox(BLOCK_MODE);
    for (const env of [{ ALGOVAULT_AUTHOR_IDENTITY: 'warn' }, { ALGOVAULT_AUTHOR_IDENTITY: 'report' }, {}]) {
      expect(runGate(sb.dir, 'test@test.local', 'probe', env).token)
        .not.toBe('AUTHOR_IDENTITY_VERDICT=PASS');
    }
  });
});

describe('check-author-identity.sh — pure parser (the seam the gate body hides)', () => {
  /** Source the script and call one pure function, exactly as the self-test does. */
  function callPure(fn: string, arg: string): string {
    const r = spawnSync('bash', ['-c', `. "${SCRIPT}"; ${fn} "$1"`, '_', arg], { encoding: 'utf8' });
    return (r.stdout ?? '').trim();
  }

  it('extracts the email from a real GIT_AUTHOR_IDENT shape', () => {
    expect(callPure('author_identity_parse_email', 'AlgoVaultFi <a@b.com> 1786265766 +0800')).toBe('a@b.com');
  });

  it('handles a display name containing a space', () => {
    expect(callPure('author_identity_parse_email', 'AlgoVault Operator <x@y.z> 1700000000 -0500')).toBe('x@y.z');
    expect(callPure('author_identity_parse_name', 'AlgoVault Operator <x@y.z> 1700000000 -0500')).toBe('AlgoVault Operator');
  });

  it('anchors on the LAST "<" so a name containing "<" cannot smuggle a wrong email', () => {
    expect(callPure('author_identity_parse_email', 'Weird <Name <deep@mail.io> 1754700000 +0000')).toBe('deep@mail.io');
  });

  it('sourcing the script does NOT run the gate — no verdict token is emitted', () => {
    const r = spawnSync('bash', ['-c', `. "${SCRIPT}"; echo SOURCED_OK`], { encoding: 'utf8' });
    expect(r.stdout).toContain('SOURCED_OK');
    expect(r.stdout).not.toContain('AUTHOR_IDENTITY_VERDICT=');
  });
});

describe('ops/author-identity-allowlist.json — the shipped config', () => {
  it('is non-vacuous and judges every identity of record correctly', () => {
    const cfg = JSON.parse(
      execFileSync('cat', [LIVE_ALLOWLIST], { encoding: 'utf8' }),
    ) as {
      allowed: { email: string; reason: string }[];
      denied: { email: string; reason: string }[];
      exempt_repos: { path: string; reason: string }[];
      promotion: { mode: string; max_violations: number; not_before: string };
    };
    const allowed = cfg.allowed.map((a) => a.email);
    const denied = cfg.denied.map((d) => d.email);

    expect(allowed).toContain(CANONICAL);
    expect(allowed).toContain(MEGATRON);
    expect(denied).toContain('test@test.local');
    expect(denied).toContain('megatronwarlord1998@gmail.com');
    expect(denied).toContain('diophantus.hau@gmail.com');
    // The three denied addresses must never leak into `allowed`.
    for (const d of denied) expect(allowed).not.toContain(d);
  });

  it('carries a reason on EVERY row — an exemption living only in prose gets "fixed" later', () => {
    const cfg = JSON.parse(execFileSync('cat', [LIVE_ALLOWLIST], { encoding: 'utf8' }));
    for (const row of [...cfg.allowed, ...cfg.denied, ...cfg.exempt_repos]) {
      expect(typeof row.reason).toBe('string');
      expect(row.reason.length).toBeGreaterThan(20);
    }
  });

  it('ships REPORT-first with BOTH promotion criteria, never collapsed into one', () => {
    const cfg = JSON.parse(execFileSync('cat', [LIVE_ALLOWLIST], { encoding: 'utf8' }));
    expect(cfg.promotion.mode).toBe('report');
    expect(cfg.promotion.max_violations).toBe(0);
    expect(cfg.promotion.not_before).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof cfg.promotion.owner).toBe('string');
    expect(cfg.promotion.reason.length).toBeGreaterThan(20);
  });
});
