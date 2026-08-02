/**
 * OPS-CLAUDEMD-CLAIM-VERIFIER-W1 — pre-push enforcement of the CLAUDE.md claim gate.
 *
 * The vitest suite runs at pre-push (check_test_baseline.sh), so this test is what makes a
 * STALE claim lock — the vault CLAUDE.md edited without `--sync` — block the push that would
 * ship around it, with the gate's own remediation printed. In CI the vault corpus is
 * unreachable and the gate verifies the committed lock against the tree (lock-mode), so this
 * test is corpus-independent: it must pass on any machine.
 *
 * It asserts the CONTRACT, not internals: self-test green both directions, exactly one
 * terminal verdict token, and a PASS verdict on the current tree + lock.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const GATE = resolve(ROOT, 'scripts', 'check-claudemd-claims.mjs');

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [GATE, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('claudemd-claims gate (OPS-CLAUDEMD-CLAIM-VERIFIER-W1)', () => {
  it('self-test passes: dead prescriptive path fires, correction blocks do not, vacuity guarded', { timeout: 60_000 }, () => {
    const { code, out } = run(['--self-test']);
    expect(out).toContain('self-test passed');
    expect(code).toBe(0);
  });

  // Generous by intent: this spawns the REAL gate, which shells out to git. It passed standalone
  // at ~3s and still blocked a push under the full parallel suite, against vitest's 5s default —
  // a timing-fragile gate teaches people to re-run until green, which is how a real red gets
  // waved through. The underlying cost was fixed too (one batched cat-file, not ~160 spawns).
  it('--check emits exactly one verdict token and it is PASS on the current tree + lock', { timeout: 60_000 }, () => {
    const { code, out } = run(['--check']);
    const tokens = out.match(/CLAUDEMD_CLAIMS_VERDICT=\w+/g) ?? [];
    expect(tokens).toHaveLength(1);
    // The token is the truth; a stale lock or a broken claim must surface here, at pre-push,
    // with the gate's printed remediation (node scripts/check-claudemd-claims.mjs --sync).
    expect(tokens[0], out.slice(-2000)).toBe('CLAUDEMD_CLAIMS_VERDICT=PASS');
    expect(code).toBe(0);
  });
});
