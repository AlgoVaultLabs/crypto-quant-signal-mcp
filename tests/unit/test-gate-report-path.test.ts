/**
 * OPS-TEST-GATE-MKTEMP-PORTABILITY-W1 — `scripts/check_test_baseline.sh` report-path contract.
 *
 * The pre-push gate turned into a silent no-op on 2026-07-29 (observed during
 * SIGNAL-CLOSEDBAR-SHADOW-W1 CH2). Chain:
 *
 *   1. `mktemp "$TMP/test-gate-vitest.XXXXXX.json"` — BSD/macOS mktemp does NOT
 *      substitute `XXXXXX` when a suffix follows it, so it created a LITERAL file
 *      named `test-gate-vitest.XXXXXX.json` (GNU mktemp substitutes; BSD does not).
 *   2. On a run where that literal name already existed (a concurrent worktree
 *      session, or an interrupted earlier run), mktemp exits 1 with EMPTY stdout:
 *      `mkstemp failed on …: File exists`.
 *   3. `set -uo pipefail` has no `-e`, so the script carried on with an empty
 *      `$VITEST_JSON` → `npx vitest run --outputFile=` →
 *      `CACError: option --outputFile <filename/-s> value is missing`.
 *   4. No report was written, so the report-parse check fired and the gate
 *      printed "infra error; failing OPEN (exit 0)" — having verified NOTHING.
 *
 * A gate that exits 0 while verifying nothing is indistinguishable from a healthy
 * one. That is the exact class CLAUDE.md's "installed is not working" law covers,
 * so an unusable report path is a HARD FAIL, not a fail-open.
 *
 * Strategy (mirrors tests/unit/check-system-map.test.ts): build a throwaway git
 * repo, copy in the REAL bash file, and put stub `npm` / `npx` / `mktemp` ahead of
 * the real ones on PATH so each scenario can drive one branch deterministically —
 * no vitest-inside-vitest, no network, ~instant.
 *
 * Runs on BSD (macOS dev + pre-push) and GNU (ubuntu CI) — the fix must hold on both.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT_PATH = resolve(__dirname, '..', '..', 'scripts', 'check_test_baseline.sh');

/** Baseline content used by the fixtures: one allow-listed file + the comment/blank forms. */
const FIXTURE_BASELINE = [
  '# fixture baseline — comments and blanks must be ignored',
  '',
  'tests/unit/known-broken.test.ts',
  '',
].join('\n');

interface Fixture {
  dir: string;
  /** Sandboxed TMPDIR handed to the script, so we can inspect exactly what it created. */
  tmp: string;
  cleanup: () => void;
}

function writeStub(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function setupFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'test-gate-report-path-'));
  spawnSync('git', ['-C', dir, 'init', '--initial-branch=main', '-q']);

  // The real bash file under test.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT_PATH, join(dir, 'scripts', 'check_test_baseline.sh'));
  chmodSync(join(dir, 'scripts', 'check_test_baseline.sh'), 0o755);

  mkdirSync(join(dir, 'audits'), { recursive: true });
  writeFileSync(join(dir, 'audits', 'test-baseline-known-failures.txt'), FIXTURE_BASELINE);

  // Satisfy the toolchain preflight: an executable node_modules/.bin/vitest.
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeStub(join(dir, 'node_modules', '.bin', 'vitest'), 'exit 0');

  // `tests/` with no *.test.mjs → the node:test canary leg is a no-op here.
  mkdirSync(join(dir, 'tests'), { recursive: true });

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { build: 'true', 'build:knowledge': 'true' } }),
  );

  // Sandboxed TMPDIR — asserted against directly, so it must not be the shared one.
  const tmp = join(dir, 'tmpdir');
  mkdirSync(tmp, { recursive: true });

  // Stub bin dir, PREPENDED to the real PATH so git/jq/sed/comm/find still resolve.
  mkdirSync(join(dir, 'stubbin'), { recursive: true });
  writeStub(join(dir, 'stubbin', 'npm'), 'exit 0'); // `npm run build` / `build:knowledge`

  return { dir, tmp, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Stub `npx`: writes `report` (a JSON object) to whatever `--outputFile=` names.
 * `report === null` → write nothing at all, i.e. vitest died before producing a
 * report (the CACError case, and every other crash-before-write).
 */
function stubNpx(fx: Fixture, report: unknown | null): void {
  const body =
    report === null
      ? [
          'for a in "$@"; do :; done',
          'echo "CACError: option `--outputFile <filename/-s>` value is missing" >&2',
          'exit 1',
        ].join('\n')
      : [
          'out=""',
          'for a in "$@"; do case "$a" in --outputFile=*) out="${a#--outputFile=}";; esac; done',
          // Record the path the gate handed us, so a test can assert the template
          // was actually expanded rather than passed through literally.
          `printf '%s' "$out" >"${join(fx.dir, 'handed-report-path.txt')}"`,
          '[ -n "$out" ] || { echo "CACError: option `--outputFile` value is missing" >&2; exit 1; }',
          `cat >"$out" <<'JSON'\n${JSON.stringify(report)}\nJSON`,
          'exit 0',
        ].join('\n');
  writeStub(join(fx.dir, 'stubbin', 'npx'), body);
}

/** Force the `mktemp` failure that produced the empty report path in production. */
function stubFailingMktemp(fx: Fixture): void {
  writeStub(
    join(fx.dir, 'stubbin', 'mktemp'),
    'echo "mktemp: mkstemp failed on /x/test-gate-vitest.XXXXXX.json: File exists" >&2\nexit 1',
  );
}

/** A vitest json report: every named file `passed` except those in `failed`. */
function report(passed: string[], failed: string[] = []) {
  return {
    testResults: [
      ...passed.map((name) => ({ name: `/abs/repo/${name}`, status: 'passed' })),
      ...failed.map((name) => ({ name: `/abs/repo/${name}`, status: 'failed' })),
    ],
  };
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
}

function runGate(fx: Fixture, env: Record<string, string> = {}): RunResult {
  const r = spawnSync('bash', ['scripts/check_test_baseline.sh'], {
    cwd: fx.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(fx.dir, 'stubbin')}:${process.env.PATH ?? ''}`,
      TMPDIR: fx.tmp,
      ALGOVAULT_TEST_GATE: 'block',
      // Never let the fixture inherit the outer run's git-hook env.
      GIT_DIR: '',
      GIT_WORK_TREE: '',
      ...env,
    },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { exitCode: r.status ?? -1, stdout, stderr, all: `${stdout}\n${stderr}` };
}

describe('check_test_baseline.sh — report-path contract', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setupFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('precondition: jq is on PATH (the gate fails OPEN without it, which would mask every assertion below)', () => {
    expect(spawnSync('jq', ['--version']).status, 'install jq — the gate cannot parse a report without it').toBe(0);
  });

  // ── the defect: an unusable report path must NOT fail open ──

  it('exits non-zero when mktemp fails and the report path is EMPTY (was: exit 0, verified nothing)', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));
    stubFailingMktemp(fx);

    const r = runGate(fx);

    expect(r.exitCode, `gate exited ${r.exitCode}; output:\n${r.all}`).not.toBe(0);
    expect(r.all).not.toMatch(/GREEN/);
  });

  it('exits non-zero when vitest crashes before writing a report (CACError class)', () => {
    stubNpx(fx, null);

    const r = runGate(fx);

    expect(r.exitCode, `gate exited ${r.exitCode}; output:\n${r.all}`).not.toBe(0);
    expect(r.all).not.toMatch(/GREEN/);
  });

  it('does not describe an unrunnable suite as a fail-OPEN', () => {
    stubNpx(fx, null);

    const r = runGate(fx);

    expect(r.all).not.toMatch(/failing OPEN/i);
  });

  // ── the portability defect itself ──

  it('hands vitest an EXPANDED report path, never a literal XXXXXX template', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `expected GREEN; output:\n${r.all}`).toBe(0);
    const handed = readFileSync(join(fx.dir, 'handed-report-path.txt'), 'utf8');
    expect(handed, 'the gate passed --outputFile= with no value').not.toBe('');
    expect(handed, `mktemp template was not expanded: ${handed}`).not.toMatch(/XXXXXX/);
  });

  it('cleans up its transient report dir but KEEPS the operator-facing log', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `expected GREEN; output:\n${r.all}`).toBe(0);
    const entries = readdirSync(fx.tmp);
    // The `.log` files are deliberate — hard_fail() tells the operator to read
    // test-gate-vitest.log, so cleaning them up would break the diagnostic.
    const transient = entries.filter((f) => f.startsWith('test-gate-vitest.') && !f.endsWith('.log'));
    expect(transient, `transient report dir not cleaned up: ${transient.join(', ')}`).toEqual([]);
    expect(entries, 'the operator-facing vitest log must survive').toContain('test-gate-vitest.log');
  });

  it('still runs the suite when a stale literal-XXXXXX file is already present (the production collision)', () => {
    writeFileSync(join(fx.tmp, 'test-gate-vitest.XXXXXX.json'), 'stale leftover\n');
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.stdout, `output:\n${r.all}`).toMatch(/GREEN/);
    expect(r.exitCode).toBe(0);
  });

  it('tolerates a TMPDIR with a trailing slash (macOS exports one, yielding // in every path)', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx, { TMPDIR: `${fx.tmp}/` });

    expect(r.stdout, `output:\n${r.all}`).toMatch(/GREEN/);
    expect(r.exitCode).toBe(0);
  });

  it('never reads a previous run\'s report (a stale report must not be mistaken for this run\'s)', () => {
    // vitest writes nothing; if the gate reused a fixed-name path from an earlier
    // run it would parse that stale GREEN report and pass.
    writeFileSync(join(fx.tmp, 'test-gate-vitest.json'), JSON.stringify(report(['tests/unit/a.test.ts'])));
    stubNpx(fx, null);

    const r = runGate(fx);

    expect(r.exitCode, `gate exited ${r.exitCode}; output:\n${r.all}`).not.toBe(0);
  });

  // ── fail-open PRESERVED for the genuinely-inconclusive cases it was designed for ──

  it('still fails OPEN (exit 0) when node_modules/vitest is missing', () => {
    rmSync(join(fx.dir, 'node_modules'), { recursive: true, force: true });

    const r = runGate(fx);

    expect(r.exitCode).toBe(0);
    expect(r.all).toMatch(/node_modules/);
  });

  it('still fails OPEN (exit 0) on a genuine build failure', () => {
    writeStub(join(fx.dir, 'stubbin', 'npm'), 'case "$*" in "run build") exit 2;; esac\nexit 0');
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode).toBe(0);
    expect(r.all).toMatch(/build failed/i);
  });

  it('honours the documented ALGOVAULT_TEST_GATE=warn override for an unusable report path', () => {
    stubNpx(fx, null);

    const r = runGate(fx, { ALGOVAULT_TEST_GATE: 'warn' });

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.all).toMatch(/warn/i);
  });

  // ── composition with OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1's fail-open ledger ──
  //
  // hard_fail() in warn mode delegates to fail_open() rather than a plain exit 0,
  // so an UNGATED push is recorded no matter which path allowed it. Neither wave
  // had this on its own, so it is pinned here rather than assumed.

  /** The ledger fail_open() appends to: $(git rev-parse --git-common-dir)/… */
  const ledgerPath = (f: Fixture) => join(f.dir, '.git', 'algovault-test-gate-failopen.log');

  it('records a warn-mode hard failure in the fail-open ledger (an ungated push is never silent)', () => {
    stubNpx(fx, null);

    const r = runGate(fx, { ALGOVAULT_TEST_GATE: 'warn' });

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.all).toMatch(/THIS PUSH IS UNGATED/);
    const ledger = readFileSync(ledgerPath(fx), 'utf8');
    expect(ledger, `ledger:\n${ledger}`).toMatch(/downgraded by ALGOVAULT_TEST_GATE=warn/);
  });

  it('a later GREEN run reports the ungated push and clears the ledger', () => {
    // 1. warn-mode hard failure → one ledger row.
    stubNpx(fx, null);
    runGate(fx, { ALGOVAULT_TEST_GATE: 'warn' });
    expect(readFileSync(ledgerPath(fx), 'utf8').trim(), 'precondition: ledger has a row').not.toBe('');

    // 2. the suite now actually runs green → those commits are covered.
    stubNpx(fx, report(['tests/unit/a.test.ts']));
    const r = runGate(fx);

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.all).toMatch(/went UNGATED since the last GREEN gate/);
    expect(readFileSync(ledgerPath(fx), 'utf8').trim(), 'ledger should be cleared').toBe('');
  });

  it('a blocking hard failure does NOT write a ledger row (nothing went ungated)', () => {
    stubNpx(fx, null);

    const r = runGate(fx); // block mode

    expect(r.exitCode).not.toBe(0);
    expect(existsSync(ledgerPath(fx)) ? readFileSync(ledgerPath(fx), 'utf8').trim() : '').toBe('');
  });

  // ── baseline allow-list semantics — unchanged by this wave ──

  it('GREEN when every file passes', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts', 'tests/unit/b.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.stdout).toMatch(/GREEN/);
  });

  it('exits 1 on a NEW failing file that is not allow-listed', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts'], ['tests/unit/regressed.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode).toBe(1);
    expect(r.all).toMatch(/tests\/unit\/regressed\.test\.ts/);
  });

  it('exits 0 when the only failing file IS allow-listed in the baseline', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts'], ['tests/unit/known-broken.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.stdout).toMatch(/GREEN/);
  });

  it('reports the allow-listed count, ignoring comment and blank lines', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.stdout).toMatch(/1 allow-listed/);
  });
});
