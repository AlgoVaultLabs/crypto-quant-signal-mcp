/**
 * OPS-VALIDATE-KEY-INDETERMINATE-W1 CH5 — the two gates, exercised by the ordinary suite.
 *
 * ── WHY THIS EXISTS GIVEN BOTH GATES ALREADY HAVE `--self-test` ───────────────────────────────
 * A hermetic self-test is structurally blind to exactly what its own seam replaces. Both suites
 * feed hand-built source strings through `scan()`, so they prove the MATCHER works and say
 * nothing about whether the matcher is pointed at anything — a gate whose `listTsFiles(SRC)` no
 * longer resolves would self-test 13/13 and verify zero files. So each gate is run BOTH ways
 * here: hermetically, and against the real repository.
 *
 * The verdict-token law is asserted directly: exactly ONE terminal token per invocation, and the
 * caller gates on the token rather than the exit code.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function runGate(script: string, args: string[] = []): { out: string; code: number } {
  try {
    const out = execFileSync('node', [join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8', cwd: ROOT, timeout: 60_000,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? -1 };
  }
}

const GATES: Array<[string, string]> = [
  ['check-subscription-status-sot.mjs', 'SUBSCRIPTION_STATUS_SOT_VERDICT'],
  ['check-entitlement-state-collapse.mjs', 'ENTITLEMENT_STATE_COLLAPSE_VERDICT'],
];

describe.each(GATES)('%s', (script, token) => {
  it('prints EXACTLY ONE terminal verdict token on --self-test', () => {
    const { out, code } = runGate(script, ['--self-test']);
    const tokens = out.split('\n').filter((l) => l.startsWith(`${token}=`));
    expect(tokens, `expected one ${token} line, got ${tokens.length}`).toHaveLength(1);
    expect(tokens[0]).toBe(`${token}=PASS`);
    expect(code).toBe(0);
  });

  it('the self-test is NON-VACUOUS — it reports how many cases it actually ran', () => {
    // A suite that built zero cases would print PASS while proving nothing. Both gates guard
    // this at their construction site; this asserts the guard is reachable and the count real.
    const { out } = runGate(script, ['--self-test']);
    const m = /self-test: (\d+)\/(\d+) passed/.exec(out);
    expect(m, 'the self-test must report its own denominator').not.toBeNull();
    expect(Number(m![2])).toBeGreaterThanOrEqual(8);
    expect(m![1]).toBe(m![2]);
  });

  it('PASSES against the real repository — the half the hermetic suite cannot see', () => {
    const { out, code } = runGate(script);
    const tokens = out.split('\n').filter((l) => l.startsWith(`${token}=`));
    expect(tokens).toHaveLength(1);
    expect(tokens[0], out).toBe(`${token}=PASS`);
    expect(code).toBe(0);
  });

  it('is safely IMPORTABLE — no verdict, no exit, as a side effect of import', async () => {
    // CH5 L2 imports L1's comment-stripper. A top-level `process.exit(...)` ran the whole gate at
    // import time and killed the importing process after printing the WRONG gate's verdict.
    // Measured, not hypothetical: L2's first run printed L1's output and stopped.
    const mod = await import(`../../scripts/${script}`);
    expect(typeof mod.scan).toBe('function');
  });
});

describe('the real corpus is not empty — the vacuity guards have something to guard', () => {
  it('the status-SoT gate sees real subscriptions.list() call sites', () => {
    const { out } = runGate('check-subscription-status-sot.mjs');
    const m = /(\d+) subscriptions\.list\(\) call site/.exec(out);
    expect(m).not.toBeNull();
    // If this ever reads 0 the gate answers INDETERMINATE by design, and this asserts we have
    // not silently arrived there.
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it('the collapse gate sees real entitlement route files', () => {
    const { out } = runGate('check-entitlement-state-collapse.mjs');
    const m = /(\d+) entitlement route file/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});
