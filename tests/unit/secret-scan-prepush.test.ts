/**
 * OPS-SECRET-SCAN-PREPUSH-W1 — the secret-scan gate must stay LEFT of the push.
 *
 * The class this pins: security-canary Gate B is fail-closed and correct, but until this wave it
 * ran ONLY in .github/workflows/deploy.yml — after the push. So its only possible expression was
 * "the commit lands on main, the deploy dies, prod is stranded, the operator is paged". That
 * happened four times; the fourth (deploy run 32488595037, 2026-08-21) stranded prod at 81cf4f0
 * for ~3h behind main at 2c3a6ea, and the remedy recorded after the THIRD was prose in status.md.
 *
 * These assertions are what stops it being prose again.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALLER = 'scripts/install_secret_scan_hook.sh';
const GATE = 'scripts/security-canary.mjs';

function runGate(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const out = execFileSync('node', [resolve(ROOT, GATE), ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('secret-scan pre-push gate — wiring', () => {
  it('the installer exists and is executable', () => {
    const p = resolve(ROOT, INSTALLER);
    expect(existsSync(p), `${INSTALLER} is missing`).toBe(true);
    expect(statSync(p).mode & 0o111, `${INSTALLER} is not executable`).toBeGreaterThan(0);
  });

  it('the installer registers the block through the shared emitter, never by hand', () => {
    const src = readFileSync(resolve(ROOT, INSTALLER), 'utf8');
    // hook_block_install is what imposes canonical order, the skip-guard and the backup. A
    // hand-rolled append is the shape that deadlocked ~70 checkouts on 2026-08-01.
    expect(src).toMatch(/hook_block_install pre-push secret-scan /);
    expect(src).toMatch(/hook_block_assert_publishable/);
  });

  it('the block gates on the TOKEN, not the bare exit code', () => {
    const src = readFileSync(resolve(ROOT, INSTALLER), 'utf8');
    expect(src).toMatch(/SECRET_SCAN_VERDICT/);
    expect(src).toMatch(/!= "PASS"/);
  });

  it('the block runs the matcher self-test before trusting a clean scan', () => {
    const src = readFileSync(resolve(ROOT, INSTALLER), 'utf8');
    expect(src).toMatch(/--self-test/);
  });

  it('the installer carries NO warn/override lever', () => {
    const src = readFileSync(resolve(ROOT, INSTALLER), 'utf8');
    // An override on this gate would only ever be used to push the literal it exists to stop.
    expect(src).not.toMatch(/ALGOVAULT_SECRET_SCAN\s*=/);
    expect(src).not.toMatch(/--no-verify/);
  });

  it('is declared in the shared-worktree-state registry', () => {
    const reg = JSON.parse(readFileSync(resolve(ROOT, 'ops/shared-worktree-state.json'), 'utf8'));
    const row = reg.resources.find((r: any) => r.id === 'block-secret-scan');
    expect(row, 'block-secret-scan row missing from ops/shared-worktree-state.json').toBeTruthy();
    expect(row.block_name).toBe('secret-scan');
    expect(row.script).toBe(GATE);
    expect(row.writers).toContain(INSTALLER);
    expect(reg.resources.find((r: any) => r.id === 'hook-pre-push').writers).toContain(INSTALLER);
  });

  it('deploy.yml keeps running the same gate — the pre-push lane ADDS, never replaces', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(wf).toMatch(/security-canary\.mjs --check=pii/);
  });
});

describe('secret-scan pre-push gate — verdict semantics', () => {
  it('emits SECRET_SCAN_VERDICT=PASS on a clean tree, exit 0', () => {
    const r = runGate(['--check=pii']);
    expect(r.out).toMatch(/^SECRET_SCAN_VERDICT=PASS$/m);
    expect(r.code).toBe(0);
  });

  it('the whole tree is clean — the corpus is real, not vacuous', () => {
    const r = runGate(['--check=pii']);
    const m = r.out.match(/secret literal in (\d+) source files/);
    expect(m, 'gate did not report a file count').toBeTruthy();
    // Guards the exact fail-open measured on 2026-08-21: a broken `git ls-files` produced
    // "in 0 source files" followed by "✓ PASS", exit 0.
    expect(Number(m![1])).toBeGreaterThan(100);
  });

  it('the matcher self-test passes and is NOT vacuous', () => {
    const r = runGate(['--self-test']);
    expect(r.code).toBe(0);
    const counts = [...r.out.matchAll(/\((\d+) must-fire, (\d+) must-not-fire\)/g)];
    expect(counts.length).toBeGreaterThanOrEqual(2);
    for (const c of counts) {
      expect(Number(c[1])).toBeGreaterThan(0);
      expect(Number(c[2])).toBeGreaterThan(0);
    }
    expect(r.out).toMatch(/corpus-vacuity self-test passed \((\d+) cases\)/);
    expect(Number(r.out.match(/corpus-vacuity self-test passed \((\d+) cases\)/)![1])).toBeGreaterThan(0);
  });

  it('an unconstructible corpus is INDETERMINATE and exit 2 — never a pass', () => {
    // END-TO-END reproduction of the fail-open measured on 2026-08-21, not a unit test of the
    // pure predicate: with a failing `git` on PATH the pre-fix gate printed "in 0 source files"
    // and "✓ PASS", exit 0 — one exit code encoding both "verified, clean" and "verified
    // nothing". The stub lives in a private temp dir; a test must never write a shared repo
    // artifact another test file may be reading concurrently.
    const stubDir = mkdtempSync(join(tmpdir(), 'av-secret-scan-'));
    try {
      writeFileSync(join(stubDir, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const r = runGate(['--check=pii'], { PATH: `${stubDir}:${process.env.PATH ?? ''}` });
      expect(r.out).toMatch(/^SECRET_SCAN_VERDICT=INDETERMINATE$/m);
      expect(r.out).not.toMatch(/^SECRET_SCAN_VERDICT=PASS$/m);
      expect(r.code).toBe(2); // 2 = "could not verify", already this gate's code for inconclusive
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('fires on the exact literal that stranded prod, and not on its redacted form', () => {
    const src = readFileSync(resolve(ROOT, GATE), 'utf8');
    // Both fixtures must be present in the two-way self-test. Pinning only the must-fire half
    // would let a future tightening re-block every audit doc that abbreviates a probe value.
    expect(src).toMatch(/Bearer av_live_0123456789abcdef01234567/);
    expect(src).toMatch(/Bearer av_live_0123\\u20264567/);
  });

  it('the audit doc that caused the incident stays redacted', () => {
    const p = resolve(ROOT, 'audits/RELEASE-v1.28.0-W1-endpoint-truth.md');
    if (!existsSync(p)) return; // the doc may be archived later; its absence is not a regression
    expect(readFileSync(p, 'utf8')).not.toMatch(/Bearer av_live_[0-9a-f]{16,}/);
  });
});
