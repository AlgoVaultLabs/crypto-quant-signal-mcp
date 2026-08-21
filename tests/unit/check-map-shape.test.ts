/**
 * Unit tests for SYSTEM-MAP-SHAPE-GATE-W1 — `scripts/check_map_shape.sh`.
 *
 * The gate asserts three shape properties of a markdown map file. Its sibling
 * `check_system_map.sh` asks whether the map was TOUCHED; this one asks whether it is still
 * MAP-SHAPED. Every check below fired on a real defect in the pre-de-log archive on 2026-08-21.
 *
 * WHAT THESE TESTS ADD OVER `--self-test`:
 *   The script's own `--self-test` is the gate's falsifiability proof and runs in the developer
 *   loop. These tests are the REGRESSION net — they run in CI and in the pre-push gate, where a
 *   future edit to the scanner would otherwise go unnoticed until a commit was wrongly blocked
 *   or wrongly allowed. They deliberately assert the TOKEN and the EXIT CODE separately: a
 *   recorded incident had a suite asserting tokens only, so re-coding a mapping to 0 left it
 *   green while the gate silently stopped blocking.
 *
 * HERMETIC BY CONSTRUCTION — and that is load-bearing here:
 *   Nothing below reads the real vault `system-map.md`. That file lives outside the repo on a
 *   synced mount, so asserting on it would make this suite fail whenever the vault is
 *   unmounted — a flake keyed on infrastructure, not on code. The gate itself owns the live
 *   assertion (fail-closed on INDETERMINATE); these tests own the logic.
 *
 *   Nothing below WRITES a shared repo artifact either. Vitest runs test FILES in parallel
 *   workers, so a test that mutates a tracked file races any test that reads it — a real,
 *   non-deterministic failure this repo has already paid for. Every fixture is in a tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT_PATH = resolve(__dirname, '..', '..', 'scripts', 'check_map_shape.sh');
const PATH_LIB = resolve(__dirname, '..', '..', 'scripts', 'lib', 'system-map-path.sh');
const SIBLING = resolve(__dirname, '..', '..', 'scripts', 'check_system_map.sh');

interface Run {
  code: number;
  stdout: string;
  verdict: string;
}

/** Run the gate and split the TOKEN from the exit code so each can be asserted separately. */
function runGate(args: string[]): Run {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('bash', [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      // Neutralise an inherited hatch: a set ALGOVAULT_SKIP_MAP_SHAPE would downgrade every
      // exit code here and quietly make the whole suite vacuous.
      env: { ...process.env, ALGOVAULT_SKIP_MAP_SHAPE: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string };
    code = e.status ?? -1;
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '');
  }
  const lines = stdout.trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? '';
  const m = last.match(/^SYSTEM_MAP_SHAPE_VERDICT=(\w+)$/);
  return { code, stdout, verdict: m ? m[1] : `<no token; last line was: ${last}>` };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-map-shape-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const CLEAN = `# a map

| Component | Role | Repo |
|---|---|---|
| \`alpha\` | does a thing | github.com/x/alpha |
| \`beta\` | mode is \`shadow\\|enforce\` | github.com/x/beta |

prose below the table is fine.
`;

describe('check_map_shape.sh — verdict token contract', () => {
  it('always prints exactly one token, as the LAST line of stdout', { timeout: 15_000 }, () => {
    for (const args of [[fixture('c.md', CLEAN)], ['/nonexistent'], ['--self-test']]) {
      const r = runGate(args);
      expect(r.verdict).toMatch(/^(PASS|FAIL|INDETERMINATE)$/);
      const tokens = r.stdout.split('\n').filter((l) => l.startsWith('SYSTEM_MAP_SHAPE_VERDICT='));
      expect(tokens).toHaveLength(1);
    }
  });

  // The token->code MAPPING, asserted independently of the token itself.
  it.each([
    ['PASS', 0],
    ['FAIL', 1],
    ['INDETERMINATE', 3],
  ])('maps %s to exit %i', (verdict, code) => {
    const byVerdict: Record<string, string[]> = {
      PASS: [fixture('p.md', CLEAN)],
      FAIL: [fixture('f.md', '| A | B |\n|---|---|\n| one | two | three |\n')],
      INDETERMINATE: ['/nonexistent/definitely-not-here.md'],
    };
    const r = runGate(byVerdict[verdict]);
    expect(r.verdict).toBe(verdict);
    expect(r.code).toBe(code);
    // it.each takes its budget as a trailing number, not an options object. Every block in this
    // file spawns a subprocess, so none of them may inherit the 5,000ms default.
  }, 15_000);
});

describe('check_map_shape.sh — the three checks', () => {
  it('PASSes a clean table and reports what it actually evaluated', { timeout: 15_000 }, () => {
    const r = runGate([fixture('clean.md', CLEAN)]);
    expect(r.verdict).toBe('PASS');
    expect(r.code).toBe(0);
    // Positive per-check output: a check silently skipped must never look like one that passed.
    expect(r.stdout).toContain('LINE_TOO_LONG');
    expect(r.stdout).toContain('CELL_COUNT_MISMATCH');
    expect(r.stdout).toContain('TABLE_INTERRUPTED');
    expect(r.stdout).toMatch(/2 row\(s\) checked/);
  });

  it('does NOT count an escaped \\| as a column separator', { timeout: 15_000 }, () => {
    // The single most important parsing detail: a naive split('|') reproduces the very bug the
    // gate exists to catch. CLEAN's second row carries a legal escaped pipe.
    expect(CLEAN).toContain('shadow\\|enforce');
    expect(runGate([fixture('esc.md', CLEAN)]).verdict).toBe('PASS');
  });

  it('flags LINE_TOO_LONG past the threshold, and honours --max-line', { timeout: 15_000 }, () => {
    const long = `| A | B |\n|---|---|\n| ${'x'.repeat(300)} | b |\n`;
    const p = fixture('long.md', long);
    const tight = runGate([p, '--max-line', '100']);
    expect(tight.verdict).toBe('FAIL');
    expect(tight.stdout).toContain('LINE_TOO_LONG');
    // Same file, threshold above the longest line -> clean. Proves the flag is a real knob and
    // the failure above is not incidental to something else in the fixture.
    expect(runGate([p, '--max-line', '5000']).verdict).toBe('PASS');
  });

  it('tailors the LINE_TOO_LONG remedy to the target file', { timeout: 15_000 }, () => {
    // R2 mandates the map-not-a-log wording, and system-map.md must keep it verbatim. But this
    // script is file-agnostic, and telling a reader checking status.md that "per-wave history
    // belongs in status.md" is advice that contradicts itself.
    const long = `| A | B |\n|---|---|\n| ${'x'.repeat(300)} | b |\n`;
    const asMap = runGate([fixture('system-map.md', long), '--max-line', '100']);
    expect(asMap.stdout).toContain('This file is a MAP, not a log.');

    const asOther = runGate([fixture('some-other-doc.md', long), '--max-line', '100']);
    expect(asOther.stdout).not.toContain('This file is a MAP, not a log.');
    expect(asOther.stdout).toContain('accreted history inside a single cell');
  });

  it('flags CELL_COUNT_MISMATCH on an unescaped union type inside a cell', { timeout: 15_000 }, () => {
    const r = runGate([
      fixture('union.md', "| A | B | C |\n|---|---|---|\n| x | 'daily'|'monthly' | z |\n"),
    ]);
    expect(r.verdict).toBe('FAIL');
    expect(r.stdout).toContain('CELL_COUNT_MISMATCH');
    // R2: the message names the LAW and the remedy, not just the number.
    expect(r.stdout).toContain('phantom columns');
    expect(r.stdout).toMatch(/header declares 3/);
  });

  it('flags TABLE_INTERRUPTED when prose splits a table', { timeout: 15_000 }, () => {
    const r = runGate([
      fixture('split.md', '| A | B |\n|---|---|\n| 1 | 2 |\n\nprose here.\n\n| 3 | 4 |\n'),
    ]);
    expect(r.verdict).toBe('FAIL');
    expect(r.stdout).toContain('TABLE_INTERRUPTED');
    expect(r.stdout).toContain('headerless');
  });

  // The regression that would make AC1 unsatisfiable. Read naively, "a non-row line ends the
  // table, therefore it interrupted it" flags the blank line that terminates EVERY well-formed
  // table. If this test ever goes red, the clean map itself has started failing the gate.
  it('does NOT flag the blank line that terminates a table', { timeout: 15_000 }, () => {
    const r = runGate([fixture('term.md', '| A | B |\n|---|---|\n| 1 | 2 |\n\nnext paragraph.\n')]);
    expect(r.verdict).toBe('PASS');
    expect(r.stdout).not.toContain('TABLE_INTERRUPTED  non-row');
  });

  it('does NOT flag two legitimately separate tables', { timeout: 15_000 }, () => {
    const r = runGate([
      fixture('two.md', '| A | B |\n|---|---|\n| 1 | 2 |\n\ntext.\n\n| C | D | E |\n|---|---|---|\n| 3 | 4 | 5 |\n'),
    ]);
    expect(r.verdict).toBe('PASS');
    expect(r.stdout).toMatch(/2 table\(s\)/);
  });
});

describe('check_map_shape.sh — vacuity and refusal', () => {
  it('treats a missing target as INDETERMINATE, never PASS', { timeout: 15_000 }, () => {
    const r = runGate([join(dir, 'absent.md')]);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('treats a table-less file as INDETERMINATE, never PASS', { timeout: 15_000 }, () => {
    // Input we were HANDED and could not parse is INDETERMINATE. (Empty is only vacuity where
    // WE construct the corpus — that case lives in --self-test's REFUSE branch.)
    const r = runGate([fixture('prose.md', 'just prose.\n\nnothing to parse.\n')]);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('rejects a non-numeric --max-line rather than coercing it', { timeout: 15_000 }, () => {
    const r = runGate([fixture('c2.md', CLEAN), '--max-line', 'lots']);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it('ignores pipes and long lines inside fenced code blocks', { timeout: 15_000 }, () => {
    const body = `| A | B |\n|---|---|\n| 1 | 2 |\n\n\`\`\`\n| a | b | c | d | e |\n${'y'.repeat(300)}\n\`\`\`\n`;
    expect(runGate([fixture('fence.md', body), '--max-line', '100']).verdict).toBe('PASS');
  });
});

describe('check_map_shape.sh — self-test is real', () => {
  it('passes, and reports a non-zero scenario count', { timeout: 15_000 }, () => {
    const r = runGate(['--self-test']);
    expect(r.verdict).toBe('PASS');
    expect(r.code).toBe(0);
    const m = r.stdout.match(/SELF-TEST: (\d+) passed, (\d+) failed, across (\d+) scenarios/);
    expect(m).toBeTruthy();
    expect(Number(m![2])).toBe(0);
    // Guards the vacuity hole directly: a suite that ran nothing must not read as a pass.
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![3])).toBeGreaterThan(0);
  });
});

describe('single-derivation of the target path', () => {
  it('defines the vault path in exactly ONE place', { timeout: 15_000 }, () => {
    expect(existsSync(PATH_LIB)).toBe(true);
    const lib = readFileSync(PATH_LIB, 'utf8');
    expect(lib).toMatch(/ALGOVAULT_SYSTEM_MAP_PATH=/);

    // Neither gate may carry its own copy of the absolute path. Two gates on one file that can
    // disagree about WHICH file is a defect that surfaces as "the gate passed", not as an error.
    //
    // Assert the FULL path literal, not the substring 'Obsidian Vault'. The looser form flags
    // check_map_shape.sh's own seam assertion, which greps the installed hook to prove the path
    // is ABSENT there — asserting a string's absence is not a copy of it, and a test that cannot
    // tell those apart would push the next author to delete a real check to get green.
    const DEFAULT_PATH_LITERAL = 'AlgoVault MCP/system-map.md';
    expect(readFileSync(PATH_LIB, 'utf8')).toContain(DEFAULT_PATH_LITERAL);
    for (const p of [SCRIPT_PATH, SIBLING]) {
      expect(readFileSync(p, 'utf8')).not.toContain(DEFAULT_PATH_LITERAL);
    }
  });

  it('both gates consume the shared definition', { timeout: 15_000 }, () => {
    for (const p of [SCRIPT_PATH, SIBLING]) {
      expect(readFileSync(p, 'utf8')).toContain('lib/system-map-path.sh');
    }
  });

  it('honours an explicit SYSTEM_MAP_PATH without needing the library', { timeout: 15_000 }, () => {
    // The existing suite for the sibling copies only that one script into a tmp repo. Requiring
    // the library on a path that needs no resolution would have broken it.
    const target = fixture('explicit.md', CLEAN);
    const out = execFileSync('bash', [SCRIPT_PATH, '--system-map'], {
      encoding: 'utf8',
      env: { ...process.env, SYSTEM_MAP_PATH: target, ALGOVAULT_SKIP_MAP_SHAPE: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(out.trimEnd().split('\n').pop()).toBe('SYSTEM_MAP_SHAPE_VERDICT=PASS');
  });
});

describe('the bypass hatch', () => {
  const failing = '| A | B |\n|---|---|\n| one | two | three |\n';

  it('downgrades the exit code but NEVER launders the token', { timeout: 15_000 }, () => {
    const p = fixture('bad.md', failing);
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [SCRIPT_PATH, p], {
        encoding: 'utf8',
        env: { ...process.env, ALGOVAULT_SKIP_MAP_SHAPE: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: Buffer | string };
      code = e.status ?? -1;
      stdout = e.stdout?.toString() ?? '';
    }
    expect(code).toBe(0); // downgraded
    expect(stdout.trimEnd().split('\n').pop()).toBe('SYSTEM_MAP_SHAPE_VERDICT=FAIL'); // truthful
  });

  it('is TOTAL — it honours the INDETERMINATE path too', { timeout: 15_000 }, () => {
    // A hatch that fails when it is most needed gets replaced by `git commit --no-verify`,
    // which bypasses every hook and writes no ledger row.
    let code = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', [SCRIPT_PATH, join(dir, 'nope.md')], {
        encoding: 'utf8',
        env: { ...process.env, ALGOVAULT_SKIP_MAP_SHAPE: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: Buffer | string };
      code = e.status ?? -1;
      stdout = e.stdout?.toString() ?? '';
    }
    expect(code).toBe(0);
    expect(stdout.trimEnd().split('\n').pop()).toBe('SYSTEM_MAP_SHAPE_VERDICT=INDETERMINATE');
  });
});
