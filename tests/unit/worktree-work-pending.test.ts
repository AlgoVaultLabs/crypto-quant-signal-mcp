/**
 * OPS-WORKTREE-WORK-PENDING-W1 CH1 — `scripts/lib/worktree-work-pending.sh`.
 *
 * The predicate answers ONE question — "is there unlanded WORK in this worktree?" — where
 * work is defined by CLASSIFICATION, not by dirtiness. These tests are the CI-visible half
 * of that contract; the shell `--self-test` is the hermetic half and is delegated to here
 * rather than duplicated, so the two cannot drift into disagreeing.
 *
 * Every scenario builds throwaway git repos under `mkdtemp` and points the script's config
 * and shared-state seams at scratch files. NOTHING here touches a real worktree, the real
 * `ops/shared-worktree-state.json`, or any shared repo artifact — a test that writes a file
 * another test file reads is a data race under a parallel runner, and this suite runs in
 * parallel with ~470 others.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lib', 'worktree-work-pending.sh');
const MUTATION_PROOF = join(REPO, 'scripts', 'selftest-mutation-proof.sh');
const LIVE_CONFIG = join(REPO, 'ops', 'worktree-noise-config.json');

interface Run {
  stdout: string;
  status: number;
}

/** Run the predicate with its seams pointed at scratch. Never throws on a non-zero exit —
 *  the exit CODE is part of the contract under test, so swallowing it would hide the half
 *  of the token law that says callers gate on the token AND the code means something. */
function run(args: string[], env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 300_000,
    });
    return { stdout, status: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', status: err.status ?? -1 };
  }
}

function verdictOf(stdout: string): string {
  const hits = stdout.split('\n').filter((l) => l.startsWith('WORK_PENDING_VERDICT='));
  expect(hits.length, 'exactly one verdict line (AC1.1)').toBe(1);
  return hits[0].replace('WORK_PENDING_VERDICT=', '');
}

function rows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .filter((l) => l.includes('\t') && !l.startsWith('WORK_PENDING_VERDICT='))
    .map((l) => l.split('\t'));
}

function mkRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@algovault.local');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  // The shared pre-commit/pre-push blocks live in $GIT_COMMON_DIR and would otherwise run
  // inside a fixture repo, which is both slow and a way for a test to mutate real state.
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-qm', 'seed');
  return dir;
}

interface Row {
  pattern: string;
  match?: string;
  class?: string;
  reason?: string;
}

function writeConfig(path: string, repos: string[], rowsIn?: Row[]): void {
  const cfg = {
    version: 1,
    repos,
    rows: rowsIn ?? [
      { pattern: 'node_modules', match: 'basename', class: 'B', reason: 'test', owner_wave: 'test', added: '2026-08-20' },
      { pattern: '.venv', match: 'basename', class: 'B', reason: 'test', owner_wave: 'test', added: '2026-08-20' },
      { pattern: '.claude/napkin.md', match: 'relpath', class: 'B', reason: 'test', owner_wave: 'test', added: '2026-08-20' },
    ],
    promotion: {},
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wpw-vitest-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_STATE = { WORK_PENDING_STATE_FILE: '/nonexistent-shared-state.json' };

describe('worktree-work-pending — classification, not dirtiness', () => {
  it('AC1.3 — a node_modules SYMLINK classifies Class B, so the tree folds CLEAN', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      // The live shape. `.gitignore`'s `node_modules/` matches directories only, so git
      // reports this symlink as untracked forever — the noise this wave exists to retire.
      symlinkSync('/tmp', join(r, 'node_modules'));
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(verdictOf(out.stdout)).toBe('CLEAN');
      expect(out.status).toBe(0);
      expect(rows(out.stdout)[0][5]).toBe('0'); // class_a_count
    });
  });

  it('AC1.3 — a .venv SYMLINK classifies Class B (the matcher has no directory semantics)', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      symlinkSync('/tmp', join(r, '.venv'));
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      expect(verdictOf(run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE }).stdout)).toBe('CLEAN');
    });
  });

  it('an UNTRACKED real file is Class A → PENDING, exit 1, protected_by=dirty_only', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      symlinkSync('/tmp', join(r, 'node_modules'));
      writeFileSync(join(r, 'migration.sql'), 'ALTER TABLE x;\n');
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(verdictOf(out.stdout)).toBe('PENDING');
      expect(out.status).toBe(1);
      const row = rows(out.stdout)[0];
      expect(row[3]).toBe('YES'); // work_pending
      expect(row[4]).toBe('dirty_only'); // the de-renting instrument
      expect(row[5]).toBe('1'); // class_a_count — the symlink did NOT count
    });
  });

  it('a MODIFIED TRACKED file is Class A', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      writeFileSync(join(r, 'README.md'), 'seed\nchanged\n');
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      expect(verdictOf(run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE }).stdout)).toBe('PENDING');
    });
  });

  it('AC1.8 — a gitignored Class-A path is FLAGGED, and is NOT counted as pending work', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      writeFileSync(join(r, '.gitignore'), 'research-data\n');
      execFileSync('git', ['-C', r, 'add', '.gitignore'], { stdio: 'pipe' });
      execFileSync('git', ['-C', r, 'commit', '-qm', 'ignore'], { stdio: 'pipe' });
      mkdirSync(join(r, 'research-data'));
      writeFileSync(join(r, 'research-data', 'big.parquet'), 'payload\n');
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      const env = { WORK_PENDING_CONFIG: cfg, ...NO_STATE };

      // Flagged by the projection...
      const flagged = run(['--all', '--gitignored-class-a'], env);
      expect(flagged.stdout).toContain('research-data');
      expect(flagged.stdout).toContain('ignored_only');

      // ...but NOT folded into the verdict. An ignored path is a DECLARED artifact, so its
      // presence is not somebody's unsaved work; folding it in would leave every worktree
      // holding a gitignored dataset PENDING forever, which is decoration.
      expect(verdictOf(run(['--all'], env).stdout)).toBe('CLEAN');
    });
  });
});

describe('worktree-work-pending — the fold and the token (R1.4)', () => {
  it('AC1.4 — an UNREADABLE worktree folds to INDETERMINATE and NEVER to CLEAN', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      // A registered worktree whose directory is gone: the census cannot answer for it, and
      // UNKNOWN is fail-safe — never reclaimed, never counted clean.
      const gone = join(t, 'vanished');
      execFileSync('git', ['-C', r, 'worktree', 'add', '-q', gone, '-b', 'wt'], { stdio: 'pipe' });
      rmSync(gone, { recursive: true, force: true });
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(verdictOf(out.stdout)).toBe('INDETERMINATE');
      expect(out.status).toBe(3);
    });
  });

  it('AC1.1 — exactly ONE verdict line across multiple declared repos', () => {
    withTmp((t) => {
      const a = mkRepo(join(t, 'a'));
      const b = mkRepo(join(t, 'b'));
      const c = mkRepo(join(t, 'c'));
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [a, b, c]);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(out.stdout.split('\n').filter((l) => l.startsWith('WORK_PENDING_VERDICT=')).length).toBe(1);
      expect(rows(out.stdout).length).toBe(3);
    });
  });

  it('the --paths projection carries NO verdict line (its stdout feeds sort/comm)', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      writeFileSync(join(r, 'work.txt'), 'x\n');
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      const out = run(['--all', '--paths', 'class_a'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(out.stdout).not.toContain('WORK_PENDING_VERDICT=');
      // The baseline row shape: repo <TAB> worktree <TAB> path.
      expect(out.stdout.trim().split('\t').length).toBe(3);
      expect(out.status).toBe(1); // the projection still carries the real code
    });
  });
});

describe('worktree-work-pending — the manifest schema (AC1.2)', () => {
  it('the COMMITTED manifest validates, and every row carries match + reason', () => {
    const out = run(['--validate-config']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('config OK');
    // Read through the script's own validator rather than re-implementing the schema here:
    // a second implementation of one question WILL drift.
  });

  it('a row missing `reason` fails the schema → INDETERMINATE, never CLEAN', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r], [{ pattern: 'node_modules', match: 'basename', class: 'B' }]);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(verdictOf(out.stdout)).toBe('INDETERMINATE');
      expect(out.status).toBe(3);
    });
  });

  it('a row missing `match` fails the schema → INDETERMINATE, never CLEAN', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r], [{ pattern: 'node_modules', class: 'B', reason: 'x' }]);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(verdictOf(out.stdout)).toBe('INDETERMINATE');
      expect(out.status).toBe(3);
    });
  });

  it('R1.5 — an EMPTY declaration is vacuity where the corpus is CONSTRUCTED, so it REFUSES', () => {
    withTmp((t) => {
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, []);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(verdictOf(out.stdout)).toBe('INDETERMINATE');
      expect(out.status).toBe(3);
    });
  });

  it('a declared repo that is not a git repository REFUSES rather than reporting CLEAN', () => {
    withTmp((t) => {
      mkdirSync(join(t, 'not-a-repo'));
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [join(t, 'not-a-repo')]);
      const out = run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE });
      expect(verdictOf(out.stdout)).toBe('INDETERMINATE');
      expect(out.status).toBe(3);
    });
  });
});

describe('worktree-work-pending — protection is DERIVED, never asserted (R2.4)', () => {
  it('an unexpired exempt_paths row outranks dirty_only; a LAPSED one does not protect', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      writeFileSync(join(r, 'work.txt'), 'x\n');
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);

      const live = join(t, 'state-live.json');
      writeFileSync(live, JSON.stringify({
        worktree_roots: { exempt_paths: [{ path: r, reason: 'test', expires: 'never' }] },
      }));
      expect(rows(run(['--all'], { WORK_PENDING_CONFIG: cfg, WORK_PENDING_STATE_FILE: live }).stdout)[0][4])
        .toBe('exempt_paths');

      const lapsed = join(t, 'state-lapsed.json');
      writeFileSync(lapsed, JSON.stringify({
        worktree_roots: { exempt_paths: [{ path: r, reason: 'test', expires: '2026-01-01' }] },
      }));
      expect(rows(run(['--all'], {
        WORK_PENDING_CONFIG: cfg, WORK_PENDING_STATE_FILE: lapsed, WORK_PENDING_TODAY: '2026-08-20',
      }).stdout)[0][4]).toBe('dirty_only');
    });
  });

  it('a live `git worktree lock` reads as protected_by=lock', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      const wt = join(t, 'locked-wt');
      execFileSync('git', ['-C', r, 'worktree', 'add', '-q', wt, '-b', 'locked'], { stdio: 'pipe' });
      execFileSync('git', ['-C', r, 'worktree', 'lock', wt], { stdio: 'pipe' });
      writeFileSync(join(wt, 'work.txt'), 'x\n');
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      const found = rows(run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE }).stdout)
        .find((row) => row[0].endsWith('locked-wt'));
      expect(found?.[4]).toBe('lock');
    });
  });

  it('a CLEAN dirty-free worktree is `none`, never `dirty_only` — the label cannot be faked', () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      const cfg = join(t, 'cfg.json');
      writeConfig(cfg, [r]);
      const row = rows(run(['--all'], { WORK_PENDING_CONFIG: cfg, ...NO_STATE }).stdout)[0];
      expect(row[3]).toBe('NO');
      expect(row[4]).toBe('none');
    });
  });
});

describe('worktree-work-pending — falsifiability (R1.7)', () => {
  it('the hermetic shell --self-test passes', () => {
    const out = run(['--self-test']);
    expect(out.stdout).toContain('0 failed');
    expect(out.status).toBe(0);
  }, 300_000);

  it('the mutation proof catches EVERY mutation — and exits NON-ZERO when it does', () => {
    // The inversion is the gate's contract, not a preference: `exit 0` means NOT proven.
    // Assert the TOKEN as well, because exit-code-only would read an INDETERMINATE run
    // (lost anchor, no mktemp) as the same thing as a survived mutation.
    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync('bash', [MUTATION_PROOF], { encoding: 'utf8', timeout: 600_000 });
    } catch (e: unknown) {
      const err = e as { stdout?: string; status?: number };
      stdout = err.stdout ?? '';
      status = err.status ?? -1;
    }
    expect(stdout).toContain('MUTATION_PROOF_VERDICT=PROVEN');
    expect(stdout).not.toContain('SURVIVED ');
    expect(stdout).not.toContain('ANCHOR-LOST');
    expect(status, 'exit 0 would mean the self-test cannot fail').not.toBe(0);
  }, 600_000);
});

describe('worktree-work-pending — the committed manifest is the SoT it claims to be', () => {
  it('declares the 3 repos this wave scopes to, and names what it deliberately excludes', () => {
    const cfg = JSON.parse(execFileSync('cat', [LIVE_CONFIG], { encoding: 'utf8' }));
    expect(cfg.repos).toContain('/Users/tank/code/crypto-quant-signal-mcp');
    expect(cfg.repos).toContain('/Users/tank/code/algovault-bot');
    expect(cfg.repos).toContain('/Users/tank/code/autonomous-optimizer');
    // Scope is DECLARED, not emergent: `cc-session.sh clean` sweeps every primary on the
    // machine, so any corroboration against it must be restricted to this set.
    expect(Array.isArray(cfg._repos_out_of_scope)).toBe(true);
    for (const row of cfg._repos_out_of_scope) expect(row.reason?.length).toBeGreaterThan(0);
  });

  it('carries the napkin runbook row — without it an operator runbook classifies as work', () => {
    const cfg = JSON.parse(execFileSync('cat', [LIVE_CONFIG], { encoding: 'utf8' }));
    const napkin = cfg.rows.find((r: Row) => r.pattern === '.claude/napkin.md');
    expect(napkin, 'the P12 napkin row is load-bearing for CH5').toBeTruthy();
    expect(napkin.match).toBe('relpath');
  });

  it('no row smuggles a measured byte figure into its reason (Build Rule 11)', () => {
    // A number with no instrument beside it is exactly what this estate has twice retracted.
    const cfg = JSON.parse(execFileSync('cat', [LIVE_CONFIG], { encoding: 'utf8' }));
    for (const row of cfg.rows) {
      expect(row.reason, `row ${row.pattern}`).not.toMatch(/\b\d+(\.\d+)?\s*(B|KB|MB|GB|kb|mb|gb)\b/);
    }
  });
});
