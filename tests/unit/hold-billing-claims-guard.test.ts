/**
 * OPS-OPERATOR-SURFACES-HOLD-RETIRE-W1 (R6) — wiring + red-then-green for the generator guard.
 *
 * WIRING. `scripts/check-hold-billing-claims.mjs` is a standalone gate with its own verdict
 * token, but a gate nothing invokes is decoration. This suite is its invocation point: it runs
 * inside the pre-push test gate and CI, so a re-introduced claim blocks a push. It deliberately
 * does NOT install a new block into the shared `$GIT_COMMON_DIR` pre-push hook — that file
 * governs every checkout on this machine and installing into it has twice taken the whole fleet
 * down (CLAUDE.md). Running through the existing gate gets the same coverage at zero fleet risk.
 *
 * RED-THEN-GREEN. `scanSource` is driven directly rather than by mutating a tracked file: a
 * fail-closed test that writes junk into the repo and restores it races every concurrent suite
 * in a shared checkout (napkin, 2026-08-05). The guard is importable precisely so this works.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs gate, no types; importing it must not run main() (argv guard).
import { scanSource, extractStringLiterals, stripComments } from '../../scripts/check-hold-billing-claims.mjs';

const ROOT = join(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-hold-billing-claims.mjs');

/** Run the gate and return its terminal verdict token + exit code. */
function runGate(args: string[]): { verdict: string; code: number } {
  try {
    const out = execFileSync('node', [GATE, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { verdict: (out.match(/HOLD_BILLING_CLAIMS_VERDICT=(\w+)/) ?? [])[1] ?? 'MISSING', code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { verdict: ((err.stdout ?? '').match(/HOLD_BILLING_CLAIMS_VERDICT=(\w+)/) ?? [])[1] ?? 'MISSING', code: err.status ?? -1 };
  }
}

describe('hold-billing-claims guard — the repo is clean and the gate is armed', () => {
  it('the live scan passes over src/** + scripts/**', () => {
    expect(runGate([])).toEqual({ verdict: 'PASS', code: 0 });
  });

  it('its own two-way self-test passes', () => {
    expect(runGate(['--self-test'])).toEqual({ verdict: 'PASS', code: 0 });
  });

  it('emits exactly ONE terminal verdict token (callers gate on the token, not the code)', () => {
    const out = execFileSync('node', [GATE], { cwd: ROOT, encoding: 'utf8' });
    expect(out.match(/HOLD_BILLING_CLAIMS_VERDICT=/g)).toHaveLength(1);
    expect(out.trim().split('\n').pop()).toMatch(/^HOLD_BILLING_CLAIMS_VERDICT=(PASS|FAIL|INDETERMINATE)$/);
  });
});

describe('hold-billing-claims guard — PROVEN able to fail', () => {
  // Every one of these is a string this repo actually shipped, or nearly did.
  it.each([
    ['the digest line this wave retired', `const a = '• 🆓 Free-by-design HOLD — Last 24h: 534';`],
    ['the digest headline annotation', `const b = 'Total Agent Calls: 646   (all traffic incl. free HOLD)';`],
    ['the funnel tile label', `const c = 'HOLD calls (free today)';`],
    ['the funnel hint', `const d = '99% HOLD · billed $0';`],
    ['the scoreboard caveat', `const e = 'Estimate only — HOLDs stay free until you decide otherwise.';`],
    ['the funnel subheading', `const f = '~99% of external calls are free HOLDs today';`],
    ['the x402 docstring form', `const g = 'HOLD verdicts stay free, like MCP';`],
    ['a template literal', 'const h = `HOLD is unmetered on this rail`;'],
  ])('fires on %s', (_name, src) => {
    expect(scanSource(src).length).toBeGreaterThan(0);
  });

  it.each([
    ['a correction record in a line comment', `// It read "HOLD verdicts stay free" until 2026-08-09.\nconst x = 'ok';`],
    ['a correction record in a block comment', `/* would report "~99% of external calls are free HOLDs" as 0% */\nconst y = 'ok';`],
    ['the behaviour identifier', `return v === HOLD_VERDICT ? 'free_hold' : 'billable';`],
    ['the date-bounded legacy label', "const l = 'Unbilled HOLD (pre-${FLAT_BILLING_CUTOVER_DATE}, legacy)';"],
    ['post-cutover copy', `const m = 'HOLD calls (metered)';`],
    ['the flat-billing sentence', `const n = 'every verdict is one metered call, HOLD included';`],
  ])('stays silent on %s', (_name, src) => {
    expect(scanSource(src)).toEqual([]);
  });

  it('the extractor survives an escaped quote (a claim must not hide past it)', () => {
    const lits = extractStringLiterals(stripComments(`const s = 'it\\'s a free HOLD';`));
    expect(lits).toHaveLength(1);
    expect(scanSource(`const s = 'it\\'s a free HOLD';`).length).toBe(1);
  });

  it('a URL literal survives comment-stripping intact (the // guard)', () => {
    expect(extractStringLiterals(stripComments(`const u = 'https://algovault.com/docs';`))).toEqual([
      'https://algovault.com/docs',
    ]);
  });
});
