/**
 * OPS-WORKTREE-WORK-PENDING-W1 CH4 — `scripts/session-end-work-pending.sh`.
 *
 * The exit boundary. Nothing fired when a session ended, which is exactly when work gets
 * stranded; this hook fires there and REPORTS. It is a guard on a live path, so the property
 * under test is as much "it never wedges a session" as "it reports the truth".
 *
 * THE HOOK'S OWN CONTRACT WAS MEASURED, NOT READ (Claude Code 2.1.118, 2026-08-20): a
 * logging-only probe was registered, one real session fired, and its stdin captured verbatim.
 * Payload `{session_id, transcript_path, cwd, hook_event_name, reason}`, fired exactly once,
 * no tty on stdin or stdout, git env vars all unset. These tests replay that payload shape.
 *
 * Scratch repos only. The hook resolves its manifest RELATIVE TO THE PREDICATE it finds, so
 * pointing `ALGOVAULT_WORK_PENDING_PREDICATE` at a copy inside a scratch tree exercises the
 * real resolution logic without touching the live manifest or any real worktree.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(__dirname, '..', '..');
const HOOK = join(REPO, 'scripts', 'session-end-work-pending.sh');
const PREDICATE = join(REPO, 'scripts', 'lib', 'worktree-work-pending.sh');
const LIVE_CONFIG = join(REPO, 'ops', 'worktree-noise-config.json');

interface Fired {
  stdout: string;
  status: number;
}

/** Fire the hook with a real SessionEnd payload on stdin. */
function fire(payload: Record<string, string>, env: Record<string, string> = {}): Fired {
  try {
    const stdout = execFileSync('bash', [HOOK], {
      input: JSON.stringify(payload),
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

function mkRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@algovault.local');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git('add', 'README.md');
  git('commit', '-qm', 'seed');
  return dir;
}

/**
 * A scratch "estate": a copy of the predicate at scripts/lib/ plus a manifest at ops/, so the
 * hook's own PREDICATE_DIR/../../ops/ resolution is what gets exercised.
 */
function mkEstate(root: string, repos: string[]): string {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'ops'), { recursive: true });
  copyFileSync(PREDICATE, join(root, 'scripts', 'lib', 'worktree-work-pending.sh'));
  writeFileSync(join(root, 'ops', 'worktree-noise-config.json'), JSON.stringify({
    version: 1,
    repos,
    rows: [
      { pattern: 'node_modules', match: 'basename', class: 'B', reason: 'test', owner_wave: 'test', added: '2026-08-20' },
      { pattern: '.venv', match: 'basename', class: 'B', reason: 'test', owner_wave: 'test', added: '2026-08-20' },
    ],
  }, null, 2));
  return join(root, 'scripts', 'lib', 'worktree-work-pending.sh');
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sewp-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('session-end hook — it must never wedge a session', () => {
  it('AC4.2 — a cwd that is NOT a git repo exits 0 and says NOTHING', { timeout: 120_000 }, () => {
    withTmp((t) => {
      // Cowork sessions run with the vault as cwd. Silence here is the ratified behaviour:
      // a report about a directory that is not a repo is noise on every single session end.
      const out = fire({ hook_event_name: 'SessionEnd', reason: 'other', cwd: t });
      expect(out.status).toBe(0);
      expect(out.stdout).toBe('');
    });
  });

  it('exits 0 when the predicate cannot be found — degrades LOUDLY, never fatally', { timeout: 120_000 }, () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      const out = fire(
        { hook_event_name: 'SessionEnd', reason: 'other', cwd: r },
        { ALGOVAULT_WORK_PENDING_PREDICATE: join(t, 'nonexistent.sh'), ALGOVAULT_WORK_PENDING_LOG: join(t, 'log') },
      );
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('SESSION_END_WORK_PENDING=INDETERMINATE');
    });
  });

  it('AC4.6 — an unparseable payload is survivable, not fatal', { timeout: 120_000 }, () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      const pred = mkEstate(join(t, 'estate'), [r]);
      // No cwd in the payload at all: the hook must fall back rather than throw.
      const out = fire(
        { hook_event_name: 'SessionEnd' },
        { ALGOVAULT_WORK_PENDING_PREDICATE: pred, ALGOVAULT_WORK_PENDING_CWD: r, ALGOVAULT_WORK_PENDING_LOG: join(t, 'log') },
      );
      expect(out.status).toBe(0);
    });
  });

  it('a git repo the manifest does not declare reports OUT_OF_SCOPE, not silence', { timeout: 120_000 }, () => {
    withTmp((t) => {
      const declared = mkRepo(join(t, 'declared'));
      const other = mkRepo(join(t, 'other'));
      const pred = mkEstate(join(t, 'estate'), [declared]);
      const out = fire(
        { hook_event_name: 'SessionEnd', reason: 'other', cwd: other },
        { ALGOVAULT_WORK_PENDING_PREDICATE: pred, ALGOVAULT_WORK_PENDING_LOG: join(t, 'log') },
      );
      expect(out.status).toBe(0);
      // Silence would be indistinguishable from a clean report — the absence-of-alert trap.
      expect(out.stdout).toContain('SESSION_END_WORK_PENDING=OUT_OF_SCOPE');
    });
  });
});

describe('session-end hook — the report', () => {
  it('AC4.10 — a Class-A file makes the report NAME that file', { timeout: 120_000 }, () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      writeFileSync(join(r, 'migrations-029.sql'), 'ALTER TABLE x;\n');
      const pred = mkEstate(join(t, 'estate'), [r]);
      const log = join(t, 'log');
      const out = fire(
        { session_id: 's1', hook_event_name: 'SessionEnd', reason: 'other', cwd: r },
        { ALGOVAULT_WORK_PENDING_PREDICATE: pred, ALGOVAULT_WORK_PENDING_LOG: log },
      );
      expect(out.stdout).toContain('SESSION_END_WORK_PENDING=YES');
      expect(out.stdout).toContain('migrations-029.sql');
      expect(readFileSync(log, 'utf8')).toContain('migrations-029.sql');
    });
  });

  it('Class-B noise alone reports NO — dirty is not work', { timeout: 120_000 }, () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      execFileSync('ln', ['-s', '/tmp', join(r, 'node_modules')]);
      const pred = mkEstate(join(t, 'estate'), [r]);
      const out = fire(
        { session_id: 's2', hook_event_name: 'SessionEnd', reason: 'other', cwd: r },
        { ALGOVAULT_WORK_PENDING_PREDICATE: pred, ALGOVAULT_WORK_PENDING_LOG: join(t, 'log') },
      );
      expect(out.stdout).toContain('SESSION_END_WORK_PENDING=NO');
    });
  });

  it('AC4.8 — telemetry lands in the log as one OBS row per run, and NOT in the manifest', { timeout: 300_000 }, () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      const pred = mkEstate(join(t, 'estate'), [r]);
      const cfg = join(t, 'estate', 'ops', 'worktree-noise-config.json');
      const before = readFileSync(cfg, 'utf8');
      const log = join(t, 'log');
      for (const n of ['a', 'b', 'c']) {
        fire({ session_id: n, hook_event_name: 'SessionEnd', reason: 'other', cwd: r },
             { ALGOVAULT_WORK_PENDING_PREDICATE: pred, ALGOVAULT_WORK_PENDING_LOG: log });
      }
      const obs = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('OBS\t'));
      expect(obs.length, 'one OBS row per run, so the healing RATE is measured').toBe(3);
      // The manifest is TRACKED. A run counter written there would have made this hook a
      // generator of the very dirt it exists to report on.
      expect(readFileSync(cfg, 'utf8')).toBe(before);
    });
  });
});

describe('session-end hook — Build Rule 6, asserted BEHAVIOURALLY', () => {
  it('AC4.4 — a poisoned GIT_INDEX_FILE leaves the real index untouched', { timeout: 120_000 }, () => {
    withTmp((t) => {
      const r = mkRepo(join(t, 'repo'));
      writeFileSync(join(r, 'work.txt'), 'x\n');
      const pred = mkEstate(join(t, 'estate'), [r]);
      const idx = join(r, '.git', 'index');
      const sha = () => execFileSync('shasum', ['-a', '256', idx], { encoding: 'utf8' }).split(' ')[0];
      const before = sha();
      const poison = join(t, 'poison.idx');

      fire({ hook_event_name: 'SessionEnd', reason: 'other', cwd: r }, {
        GIT_INDEX_FILE: poison,
        GIT_DIR: join(t, 'poison-dir'),
        GIT_WORK_TREE: join(t, 'poison-wt'),
        ALGOVAULT_WORK_PENDING_PREDICATE: pred,
        ALGOVAULT_WORK_PENDING_LOG: join(t, 'log'),
      });

      expect(before).not.toBe('');
      expect(sha(), 'the real index must be byte-identical').toBe(before);
      // The unset is the FIRST statement, so git never even sees the poisoned path.
      expect(existsSync(poison)).toBe(false);
    });
  });

  it('AC4.3 — the source never writes to the controlling-terminal device', { timeout: 120_000 }, () => {
    // Deny-list grep, per the spec's own AC. It cannot distinguish a mention from a use, which
    // is why the no-TTY behavioural run above is the assertion that actually proves anything.
    expect(readFileSync(HOOK, 'utf8')).not.toContain('/dev/tty');
  });
});

describe('session-end hook — the promotion criterion it introduces (R4.4)', () => {
  it('carries BOTH conditions and a grade-D instrument the hook cannot game', { timeout: 120_000 }, () => {
    const cfg = JSON.parse(readFileSync(LIVE_CONFIG, 'utf8'));
    expect(cfg.promotion.max_class_a_stranded).toBe(0);
    expect(typeof cfg.promotion.runs_required).toBe('number');
    expect(cfg.promotion.escalate_after).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cfg.promotion.enforcement).toBe('report');
    expect(cfg.promotion.owner).toContain('W{NEXT}');
    // Grade D + reobserve, never B/rederive: the value is world-state at an instant.
    expect(cfg.promotion.instrument.grade).toBe('D');
    expect(cfg.promotion.instrument.reobserve?.length).toBeGreaterThan(0);
    expect(cfg.promotion.instrument.rederive).toBeUndefined();
    // The instrument must NOT be this tracked file — that would be grade C.
    expect(cfg.promotion.instrument.written_by).toContain('session-end-work-pending.sh');
    expect(cfg.promotion.instrument.population).toContain('algovault-work-pending.log');
  });
});
