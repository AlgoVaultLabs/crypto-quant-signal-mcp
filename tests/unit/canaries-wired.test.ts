import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (args: string[]) => {
  try {
    return { code: 0, out: execFileSync('node', ['scripts/check-canaries-wired.mjs', ...args], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

/**
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch5 · SEC-19 remainder + SEC-21/34 + SEC-36.
 *
 * "A canary exists but nothing invokes it" appeared THREE times in SECURITY-AUDIT-FULL-W1 and is
 * the reason a live Postgres password sat in a PUBLIC repo for seven weeks with every gate green.
 * The meta-canary retires the class; these tests keep the meta-canary itself honest.
 */
describe('canary-wiring meta-canary (SEC-19/21/34/36)', () => {
  it('self-test passes — it can detect an orphan and ignores comment-only mentions', () => {
    const r = run(['--self-test']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('self-test passed');
  });

  it('reports zero orphans on the current tree', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('all 15 committed gate scripts are invoked by something');
  });

  it('the three audited orphans are now wired', () => {
    const out = run([]).out;
    // SEC-19 remainder (the secret gate), SEC-21/34, SEC-36.
    expect(out).toMatch(/scripts\/security-canary\.mjs\s+←\s+.*deploy\.yml/);
    expect(out).toMatch(/scripts\/check-mcp-stateless\.mjs\s+←\s+.*deploy\.yml/);
    expect(out).toMatch(/scripts\/check_mobile_nav_parity\.sh\s+←\s+.*deploy\.yml/);
  });

  it('is itself wired fail-closed — a meta-canary nobody runs is the bug it exists to prevent', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(wf).toContain('node scripts/check-canaries-wired.mjs --self-test');
    expect(wf).toContain('node scripts/check-canaries-wired.mjs\n');
    // No `|| true` anywhere on the gate steps — fail-closed is the whole point.
    const step = wf.slice(wf.indexOf('Canary-wiring meta-canary'), wf.indexOf('Canary-wiring meta-canary') + 400);
    expect(step).not.toContain('|| true');
    expect(step).not.toContain('continue-on-error');
  });

  it('the stateless probe runs AFTER the deploy it validates', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(wf.indexOf('check-mcp-stateless.mjs')).toBeGreaterThan(wf.indexOf('Deploy via SSH'));
  });

  it("check-mcp-stateless.mjs no longer names an owner that does not exist", () => {
    const s = readFileSync(resolve(ROOT, 'scripts/check-mcp-stateless.mjs'), 'utf8');
    expect(s).not.toContain('canary cadence that invokes this script owns escalation');
    expect(s).toContain('OWNER');
  });
});
