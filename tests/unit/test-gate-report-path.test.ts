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
  // autoinstall_allowed() requires a package-lock.json (plus AUTOINSTALL!=0 and no CI).
  // Without one it returns false UNCONDITIONALLY, which silently made every
  // "auto-recovery ON" assertion vacuous — recovery was never reachable, so the
  // on/off gate could be neutered with nothing going red. Found by R5's
  // deliberate-breakage step; the lock file is what makes the gate testable at all.
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));

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
          // OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch1: record the worker cap the gate
          // exported. It is an ENV var rather than a CLI flag deliberately, so an
          // argv-only stub would be blind to it.
          `printf '%s' "\${VITEST_MAX_FORKS:-}" >"${join(fx.dir, 'seen-max-forks.txt')}"`,
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

function runGate(fx: Fixture, env: Record<string, string> = {}, args: string[] = []): RunResult {
  const r = spawnSync('bash', ['scripts/check_test_baseline.sh', ...args], {
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

  it('cleans up its transient report dir', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `expected GREEN; output:\n${r.all}`).toBe(0);
    const transient = readdirSync(fx.tmp).filter(
      (f) => f.startsWith('test-gate-vitest.') && !f.endsWith('.log'),
    );
    expect(transient, `transient report dir not cleaned up: ${transient.join(', ')}`).toEqual([]);
  });

  // ── OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch1 — per-run log dir ──
  //
  // The five logs used to be FIXED names directly under $TMPDIR, so two concurrent
  // gates (89 checkouts share one pre-push hook) overwrote each other's diagnostics
  // last-writer-wins. They now live in a per-run `test-gate-run.XXXXXX` directory.
  //
  // Its LIFETIME is a function of the VERDICT, not of the process exiting — which is
  // why there is deliberately no blanket `trap ... EXIT` cleanup: that would delete
  // the very file hard_fail() has just told the operator to go read.

  it('keeps the per-run log dir, with the operator-facing log inside it, when the gate FAILS', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts'], ['tests/unit/brand-new.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `expected a FAIL verdict; output:\n${r.all}`).not.toBe(0);
    const runDirs = readdirSync(fx.tmp).filter((f) => f.startsWith('test-gate-run.'));
    expect(runDirs, 'the per-run log dir must survive a failure').toHaveLength(1);
    expect(runDirs[0], 'mktemp template was not expanded').not.toMatch(/XXXXXX/);
    expect(
      readdirSync(join(fx.tmp, runDirs[0])),
      'the operator-facing vitest log must survive inside the run dir',
    ).toContain('test-gate-vitest.log');
    // The failure output must NAME the directory, or a per-run path is worse than a
    // fixed one — the operator would have no way to find it.
    expect(r.all).toContain(runDirs[0]);
  });

  it('removes the per-run log dir on PASS (nothing to diagnose, and residue is unbounded)', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `expected GREEN; output:\n${r.all}`).toBe(0);
    expect(
      readdirSync(fx.tmp).filter((f) => f.startsWith('test-gate-run.')),
      'a GREEN run must not leave a log dir behind',
    ).toEqual([]);
  });

  it('caps the vitest worker pool via VITEST_MAX_FORKS, and refuses a value that would hang', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    // The cap reaches vitest as an ENV var (not a CLI flag): an unknown env var is
    // ignored by a future vitest, whereas an unknown flag throws CACError before any
    // report is written — which would block `git push` in every checkout at once.
    const ok = runGate(fx);
    expect(ok.exitCode, `expected GREEN; output:\n${ok.all}`).toBe(0);
    expect(
      readFileSync(join(fx.dir, 'seen-max-forks.txt'), 'utf8').trim(),
      'the gate did not export VITEST_MAX_FORKS to vitest',
    ).toBe('6');

    // 0 workers makes vitest hang FOREVER and this invocation has no timeout, so an
    // unusable cap must be INDETERMINATE rather than a wedge.
    const bad = runGate(fx, { ALGOVAULT_GATE_MAX_WORKERS: '0' });
    expect(bad.stdout).toMatch(/^TEST_GATE_VERDICT=INDETERMINATE$/m);
    expect(bad.all).toMatch(/hang vitest forever/i);
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

  // ── the silent fail-opens are now INDETERMINATE / exit 2 ──────────────────────
  //
  // These two cases originally asserted `exit 0`, which is what let the gate report a
  // pass over a suite it never ran. The exemption and the test that encoded it are a
  // PAIR (CLAUDE.md): flipping the behaviour without flipping these would have left a
  // test asserting a contract the script no longer honours. `ALGOVAULT_TEST_GATE=warn`
  // remains the one documented way to get exit 0 out of either case.
  //
  // The code is **2**, not 3: OPS-TEST-GATE-FAILOPEN-W1 briefly used 3 for symmetry
  // with the monitoring convention, but `2` was already deployed on main for the same
  // "could not verify" meaning, so OPS-TEST-GATE-RECONCILE-W1 settled on 2 and retired
  // 3. One meaning, one code.

  // REVENUE-METER-TRUTH-W6 Step 0B. The third member of that family, and the one that
  // survived both prior hardening waves: vitest RAN, wrote a well-formed report, and
  // collected ZERO test files. Measured against real vitest 3.2.4 — it emits
  // `{"numTotalTests":0,…,"testResults":[]}` and exits 1, and the runner line ends in
  // `|| true`, so the report is the gate's only signal. `jq -e` is falsy for `null` and
  // `false` ONLY, so the empty array was truthy: the report read as usable, the failing
  // set came back empty, and the gate printed GREEN having verified nothing.
  it('reports INDETERMINATE (exit 2), not a pass, when vitest collected ZERO test files', () => {
    stubNpx(fx, report([]));

    const r = runGate(fx);

    expect(r.exitCode, `output:\n${r.all}`).toBe(2);
    expect(r.stdout).toMatch(/^TEST_GATE_VERDICT=INDETERMINATE$/m);
    // Must not describe an empty run as a pass in the prose either.
    expect(r.all).not.toMatch(/GREEN/);
  });

  it('reports INDETERMINATE (exit 2), not a pass, when node_modules/vitest is missing', () => {
    rmSync(join(fx.dir, 'node_modules'), { recursive: true, force: true });

    const r = runGate(fx, { ALGOVAULT_TEST_GATE_AUTOINSTALL: '0' });

    expect(r.exitCode, `output:\n${r.all}`).toBe(2);
    expect(r.all).toMatch(/node_modules/);
    expect(r.stdout).toMatch(/^TEST_GATE_VERDICT=INDETERMINATE$/m);
    // Pins the OFF side of the auto-recovery gate: the documented reason must be given,
    // and no `npm ci` may be attempted. Without these two assertions
    // `autoinstall_allowed()` could be neutered to always-allow with nothing going red
    // (R5.3 initially stayed GREEN under exactly that mutation).
    expect(r.all).toMatch(/auto-recovery is off/);
    expect(r.all).not.toMatch(/recovering with 'npm ci'/);
  });

  it('reports INDETERMINATE (exit 2), not a pass, on a genuine build failure', () => {
    writeStub(join(fx.dir, 'stubbin', 'npm'), 'case "$*" in "run build") exit 2;; esac\nexit 0');
    stubNpx(fx, report(['tests/unit/a.test.ts']));

    const r = runGate(fx);

    expect(r.exitCode, `output:\n${r.all}`).toBe(2);
    expect(r.all).toMatch(/build failed/i);
    expect(r.stdout).toMatch(/^TEST_GATE_VERDICT=INDETERMINATE$/m);
  });

  // AC9's other side: with auto-recovery ON, the cold case is ATTEMPTED rather than
  // simply blocked. This is the mitigation that makes closing the soft fail-opens
  // acceptable, so it is asserted rather than assumed — and whichever way it lands,
  // the token must agree with the code.
  it('cold checkout with autoinstall ON attempts recovery, and token matches code', () => {
    rmSync(join(fx.dir, 'node_modules'), { recursive: true, force: true });

    const r = runGate(fx, { ALGOVAULT_TEST_GATE_AUTOINSTALL: '1', CI: '' });

    // The ON side: recovery must actually be ATTEMPTED, and the OFF reason must NOT
    // appear. Together with the OFF test above this pins the gate in both directions.
    expect(r.all, `output:\n${r.all}`).toMatch(/recovering with 'npm ci'/);
    expect(r.all).not.toMatch(/auto-recovery is off/);
    // Whichever way recovery lands (the stub npm "succeeds" but installs nothing, so
    // this ends INDETERMINATE), the token must agree with the exit code.
    const token = (r.stdout.match(/^TEST_GATE_VERDICT=(\w+)$/m) ?? [])[1];
    expect(token, `no token in:\n${r.all}`).toBeTruthy();
    const expected = { PASS: 0, FAIL: 1, INDETERMINATE: 2 }[token as 'PASS' | 'FAIL' | 'INDETERMINATE'];
    expect(r.exitCode, `token ${token} must map to ${expected}`).toBe(expected);
  });

  it('honours the documented ALGOVAULT_TEST_GATE=warn override for an unusable report path', () => {
    stubNpx(fx, null);

    const r = runGate(fx, { ALGOVAULT_TEST_GATE: 'warn' });

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.all).toMatch(/warn/i);
    // warn downgrades the CODE but must NEVER launder the token into a pass —
    // otherwise the override silently recreates the very defect this wave fixed.
    expect(r.stdout).toMatch(/^TEST_GATE_VERDICT=INDETERMINATE$/m);
  });

  it('warn mode does not launder a REAL regression into a pass either', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts'], ['tests/unit/brand-new.test.ts']));

    const r = runGate(fx, { ALGOVAULT_TEST_GATE: 'warn' });

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.stdout).toMatch(/^TEST_GATE_VERDICT=FAIL$/m);
  });

  // ── the verdict-token contract itself ──

  it('prints EXACTLY ONE terminal TEST_GATE_VERDICT line on every path', () => {
    stubNpx(fx, report(['tests/unit/a.test.ts']));
    const clean = runGate(fx);
    stubNpx(fx, null);
    const broken = runGate(fx);

    for (const [label, r] of [['clean', clean], ['unparseable report', broken]] as const) {
      const n = r.stdout.split('\n').filter((l) => l.startsWith('TEST_GATE_VERDICT=')).length;
      expect(n, `${label}: expected exactly 1 verdict line, got ${n}\n${r.all}`).toBe(1);
    }
    expect(clean.stdout).toMatch(/^TEST_GATE_VERDICT=PASS$/m);
    expect(broken.stdout).toMatch(/^TEST_GATE_VERDICT=INDETERMINATE$/m);
  });

  it('--self-test is two-way, non-vacuous, and names every case', () => {
    const r = runGate(fx, {}, ['--self-test']);

    expect(r.exitCode, `output:\n${r.all}`).toBe(0);
    expect(r.stdout).toMatch(/^TEST_GATE_VERDICT=PASS$/m);
    expect(r.stdout).toMatch(/must-fire/);
    expect(r.stdout).toMatch(/must-not-fire/);
    expect(r.stdout).toMatch(/must-map/);
    // Non-vacuity: every corpus must report a NON-ZERO count. A self-test that ran
    // zero assertions prints the same ✓ as one that ran twelve.
    const m = r.stdout.match(/self-test passed \((\d+) must-fire, (\d+) must-not-fire, (\d+) must-map\)/);
    expect(m, `no summary line in:\n${r.all}`).toBeTruthy();
    for (const n of (m ?? []).slice(1)) expect(Number(n)).toBeGreaterThan(0);
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
