/**
 * OPS-SYSTEM-MAP-GATE-COMMENT-STRIP-W1 — the gate must not match its own prose.
 *
 * WHY THIS IS A SEPARATE FILE FROM check-system-map.test.ts.
 *
 * ⚠️ THIS DOCBLOCK PREVIOUSLY CARRIED THREE FALSE CLAIMS, corrected here rather than deleted
 * because each one caused a concrete wrong decision (OPS-MAP-GATE-STAT-PORTABILITY-W1):
 *
 *   1. "vitest.config.ts's stated reason does not hold — the probe is ALREADY portable." FALSE.
 *      `stat -f %m … || stat -c %Y …` only LOOKS portable. On GNU coreutils `-f` is
 *      `--file-system`: it errors on the format operand but SUCCEEDS on the file, printing
 *      filesystem text to stdout and exiting 1 — so the `||` fallback ALSO runs and both outputs
 *      land in one substitution. `$((NOW - MAP_MTIME))` then evaluated the bare word `File` as a
 *      variable and `set -u` aborted: exit 1, EMPTY stdout. That comment was RIGHT; reading a
 *      fallback chain is not measuring it.
 *   2. "It cannot be measured from a branch — deploy.yml runs npm test only on push to main."
 *      FALSE of the estate. `postgres-lane.yml` triggers on `branches: ['**']` and runs the suite
 *      on ubuntu. It had already reported this failure on the branch push; the enumeration stopped
 *      at the first workflow and the signal went unread, so a red reached main.
 *   3. "SYSTEM_MAP_MAX_AGE_SEC=-1 means no stat flavour is ever consulted." FALSE — see the
 *      corrected note at the env block below. The probe runs unconditionally.
 *
 * What was TRUE: splitting the pattern cases into a file the CI exclusion does not name made them
 * run on ubuntu for the first time, where they immediately met the bug the exclusion had been
 * hiding since it was filed. The split worked exactly as designed. The exclusion is now GONE
 * (its TODO's own condition is satisfied), so both files guard the gate on both platforms.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, copyFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GATE = path.join(ROOT, 'scripts/check_system_map.sh');
const STRIPPER = path.join(ROOT, 'scripts/lib/strip-comments.mjs');
const MADE: string[] = [];

afterAll(() => MADE.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway git repo carrying the REAL gate + the REAL stripper. */
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'smgate-strip-'));
  MADE.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  // Never let a developer's installed hooks fire inside the fixture.
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(path.join(dir, 'README.md'), '# seed\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'seed');

  mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
  copyFileSync(GATE, path.join(dir, 'scripts/check_system_map.sh'));
  chmodSync(path.join(dir, 'scripts/check_system_map.sh'), 0o755);
  copyFileSync(STRIPPER, path.join(dir, 'scripts/lib/strip-comments.mjs'));
  writeFileSync(path.join(dir, 'system-map.md'), '# mock\n');
  return dir;
}

/** Stage `content` at `rel`, run the gate, return its exit code + streams. */
function gate(dir: string, rel: string, content: string, env: Record<string, string> = {}) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
  execFileSync('git', ['-C', dir, 'add', rel]);
  const r = spawnSync('bash', ['scripts/check_system_map.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      SYSTEM_MAP_PATH: path.join(dir, 'system-map.md'),
      // Deterministic staleness: any age exceeds -1, so the COMPARISON is decided without a clock.
      // It does NOT avoid the stat probe — that runs unconditionally, before the comparison, which
      // is precisely why every BLOCK-expecting case here died on ubuntu while the exit-0 cases
      // passed. An earlier version of this comment claimed the probe was skipped; that false
      // determinism claim sat next to the code it misdescribed and is how the bug was
      // mis-diagnosed twice (OPS-MAP-GATE-STAT-PORTABILITY-W1).
      SYSTEM_MAP_MAX_AGE_SEC: '-1',
      ALGOVAULT_SKIP_MAP_CHECK: '',
      ...env,
    },
  });
  // `r.status ?? 1` WOULD BE A FAIL-OPEN ENCODING, and it cost a red `main` to learn that here.
  // spawnSync returns status=null when the process never ran or was killed by a signal, so
  // collapsing that to 1 makes "did not run" indistinguishable from "exited 1, i.e. BLOCKED" —
  // a test asserting `code === 1` then PASSES on a process that never executed. Same
  // one-code-two-meanings defect this repo's verdict-token law forbids, one level up, in a
  // harness. Measured 2026-08-13: one ubuntu case reported code 1 with EMPTY stdout, and the
  // empty stdout was the only surviving clue precisely because the code had been laundered.
  // THROW on a non-run rather than returning a number a caller can misread.
  if (r.error) throw new Error(`gate did not run: ${r.error.message}`);
  if (r.status === null) {
    throw new Error(
      `gate was killed by ${r.signal ?? 'an unknown signal'} — it never produced a verdict.\n`
      + `stdout: ${JSON.stringify(r.stdout)}\nstderr: ${JSON.stringify(r.stderr)}`,
    );
  }
  // Every gate path prints SOMETHING. Silence means the run is not interpretable, so say that
  // instead of letting a later assertion report a confusing "expected '' to contain BLOCK".
  if (!(r.stdout ?? '').trim()) {
    throw new Error(
      `gate exited ${r.status} with EMPTY stdout — no gate path does that.\n`
      + `stderr: ${JSON.stringify(r.stderr)}`,
    );
  }
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('the gate does not match its own prose', () => {
  it('a COMMENT mentioning setInterval does not block — the motivating failure', () => {
    // Verbatim shape that blocked PAY-RAIL-DASHBOARD-W1.
    const r = gate(repo(), 'src/thing.ts',
      'export const x = 1;\n// rides the existing 30s load() loop — adds NO setInterval\n');
    expect(r.code, `gate blocked on a comment:\n${r.out}`).toBe(0);
    expect(r.out).toContain('no edge-mutation signals');
  });

  it('a COMMENT mentioning app.get( does not block', () => {
    const r = gate(repo(), 'src/notes.ts', 'export const y = 2;\n// we deliberately do NOT app.get( here\n');
    expect(r.code, r.out).toBe(0);
  });

  it('a SHELL comment mentioning crontab does not block', () => {
    const r = gate(repo(), 'ops/thing.sh', '#!/bin/sh\n# installed by hand, no crontab entry\necho hi\n');
    expect(r.code, r.out).toBe(0);
  });

  it('a SQL comment mentioning CREATE TABLE does not block', () => {
    // SQL matters specifically: two patterns are CREATE TABLE / ALTER TABLE … ADD COLUMN, and
    // migrations are .sql, whose comment syntax neither reuse target covered.
    const r = gate(repo(), 'sql/notes.sql', 'SELECT 1;\n-- this does NOT CREATE TABLE anything\n');
    expect(r.code, r.out).toBe(0);
  });

  it('a FILENAME containing a pattern word does not block (the +++ b/ header)', () => {
    // Measured before the fix: this blocked, matching only the diff header.
    const r = gate(repo(), 'src/guards/setInterval-guard.ts', 'export const y = 2;\n');
    expect(r.code, r.out).toBe(0);
  });
});

describe('the gate still catches REAL edges — the fail-OPEN direction is the dangerous one', () => {
  it('a real setInterval( call BLOCKS', () => {
    const r = gate(repo(), 'src/real.ts', 'export const t = setInterval(() => {}, 1000);\n');
    expect(r.code, `the gate went blind:\n${r.out}`).toBe(1);
    expect(r.out).toContain('BLOCK');
  });

  it('a real app.get( route BLOCKS', () => {
    const r = gate(repo(), 'src/route.ts', "app.get('/x', (q, s) => s.send('ok'));\n");
    expect(r.code, r.out).toBe(1);
  });

  it('a real CREATE TABLE in a .sql migration BLOCKS', () => {
    const r = gate(repo(), 'sql/002.sql', 'CREATE TABLE things (id INT);\n');
    expect(r.code, r.out).toBe(1);
  });

  it('code AFTER a comment on the same line still counts', () => {
    // Offset-preserving stripping must not eat the code beside a trailing comment.
    const r = gate(repo(), 'src/mixed.ts', 'const t = setInterval(f, 1); // not the comment that matters\n');
    expect(r.code, r.out).toBe(1);
  });
});

describe('fail-safe: a broken stripper must never SKIP the check', () => {
  it('falls back to the UNSTRIPPED diff and warns on stderr', () => {
    const dir = repo();
    rmSync(path.join(dir, 'scripts/lib/strip-comments.mjs'));
    const r = gate(dir, 'src/thing.ts',
      'export const x = 1;\n// adds NO setInterval\n');
    // A false positive is the CORRECT outcome here: annoying and visible, with two documented
    // hatches. Skipping would be a false negative — an unmapped edge shipping in silence.
    expect(r.code, 'the gate SKIPPED instead of falling back — this is the fail-open regression').toBe(1);
    expect(r.err).toContain('comment stripper unavailable');
    expect(r.err).toContain('UNSTRIPPED');
  });
});

describe('both escape hatches are countable', () => {
  const ledgerOf = (dir: string) => {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return path.resolve(dir, common, 'algovault-hook-skip.log');
  };

  it('ALGOVAULT_SKIP_MAP_CHECK appends MAP_CHECK_ENV_BYPASS', () => {
    const dir = repo();
    const r = gate(dir, 'src/real.ts', 'export const t = setInterval(f, 1);\n',
      { ALGOVAULT_SKIP_MAP_CHECK: '1' });
    expect(r.code).toBe(0);
    const led = ledgerOf(dir);
    expect(existsSync(led), 'no ledger row — the bypass is still uncountable').toBe(true);
    const row = readFileSync(led, 'utf8').trim().split('\t');
    expect(row[1]).toBe('MAP_CHECK_ENV_BYPASS');
    expect(row, 'the established TSV shape is 5 fields').toHaveLength(5);
    expect(row[4]).toBe('scripts/check_system_map.sh');
  });

  it('[skip-map-check] appends MAP_CHECK_MSG_BYPASS', () => {
    const dir = repo();
    const gitDir = execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    writeFileSync(path.resolve(dir, gitDir, 'COMMIT_EDITMSG'), 'wip [skip-map-check]\n');
    const r = gate(dir, 'src/real.ts', 'export const t = setInterval(f, 1);\n');
    expect(r.code).toBe(0);
    expect(readFileSync(ledgerOf(dir), 'utf8')).toContain('MAP_CHECK_MSG_BYPASS');
  });

  it('writes to the EXISTING shared ledger, never a second log', () => {
    const src = readFileSync(GATE, 'utf8');
    const logs = [...src.matchAll(/([A-Za-z0-9_-]+\.log)/g)].map((m) => m[1]);
    expect([...new Set(logs)], 'a second log is a second thing to forget to read')
      .toEqual(['algovault-hook-skip.log']);
  });
});

/**
 * OPS-MAP-GATE-STAT-PORTABILITY-W1 — the mtime probe, on BOTH stat flavours.
 *
 * The other flavour is SIMULATED with a stub `stat` earlier on PATH, so neither case is a silent
 * no-op on whichever platform happens to run the suite. That matters here specifically: this bug
 * lived for months precisely because the only platform that exercised it was the one CI ran on,
 * and the only platform developers ran was the one where it worked.
 */
describe('the mtime probe survives both stat flavours', () => {
  /** Put a fake `stat` first on PATH that mimics the OTHER platform's behaviour. */
  function withStubStat(dir: string, flavour: 'gnu' | 'bsd'): string {
    const bin = path.join(dir, 'stubbin');
    mkdirSync(bin, { recursive: true });
    const body = flavour === 'gnu'
      // GNU: -c works; -f is --file-system, so it prints filesystem text and exits 1 — the exact
      // behaviour that poisoned the old chain.
      ? '#!/bin/sh\ncase "$1" in\n  -c) shift; exec /usr/bin/env stat -f %m "$2" 2>/dev/null || exec /bin/stat -f %m "$2";;\n  -f) echo "  File: \\"$3\\""; echo "    ID: deadbeef Namelen: 255"; exit 1;;\nesac\nexit 2\n'
      // BSD: -c is an illegal option (stderr, nothing on stdout); -f %m yields the mtime.
      : '#!/bin/sh\ncase "$1" in\n  -c) echo "stat: illegal option -- c" >&2; exit 1;;\n  -f) shift; exec /usr/bin/stat -c %Y "$2";;\nesac\nexit 2\n';
    writeFileSync(path.join(bin, 'stat'), body);
    chmodSync(path.join(bin, 'stat'), 0o755);
    return bin;
  }

  it('reaches a verdict with the OTHER flavour simulated — never exit 1 with empty stdout', () => {
    const dir = repo();
    const other = process.platform === 'darwin' ? 'gnu' : 'bsd';
    const bin = withStubStat(dir, other);
    // A real edge, so the gate must reach the BLOCK verdict rather than dying in the probe.
    const r = gate(dir, 'src/real.ts', 'export const t = setInterval(f, 1);\n',
      { PATH: `${bin}:${process.env.PATH}` });
    // gate() itself throws on empty stdout, which IS the regression assertion: the old chain
    // produced exit 1 with nothing on stdout under the simulated GNU stub.
    expect(r.out, `no verdict reached with ${other} stat simulated`).toMatch(/system-map gate/);
    expect([0, 1]).toContain(r.code);
  });

  it('a NON-INTEGER mtime BLOCKS with a named reason — never OK, never a silent 0', () => {
    const dir = repo();
    const bin = path.join(dir, 'badbin');
    mkdirSync(bin, { recursive: true });
    // Both forms "succeed" while printing garbage — the shape that must refuse, not assume.
    writeFileSync(path.join(bin, 'stat'), '#!/bin/sh\necho "  File: nonsense"\nexit 0\n');
    chmodSync(path.join(bin, 'stat'), 0o755);
    const r = gate(dir, 'src/real.ts', 'export const t = setInterval(f, 1);\n',
      { PATH: `${bin}:${process.env.PATH}` });
    expect(r.code, 'an undeterminable mtime must REFUSE').toBe(1);
    expect(r.out).toContain('could not read a numeric mtime');
    expect(r.out, 'the refusal must name the reason, not masquerade as staleness')
      .toContain('REFUSES rather than assuming');
    expect(r.out, 'falling through to epoch 0 would block for the WRONG reason')
      .not.toContain('STALE (max allowed');
  });

  it('detects the flavour ONCE and does not chain two stat forms', () => {
    // The chain is the hazard, not the order: `A || B` presumes a failing command prints nothing,
    // and GNU `stat -f` disproves that. Reordering only makes it happen to work today.
    const src = readFileSync(GATE, 'utf8');
    expect(src).toMatch(/if stat -c %Y \. >\/dev\/null 2>&1; then STAT_FLAVOUR=gnu/);
    expect(src, 'a chained stat probe re-introduces the poisoning')
      .not.toMatch(/stat -[cf] [^\n]*\|\|[^\n]*stat -[fc] /);
  });
});

describe('the shared stripper', () => {
  it('--self-test passes and is not vacuous', () => {
    const r = spawnSync('node', [STRIPPER, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('STRIP_COMMENTS_VERDICT=PASS');
    const n = /self-test: (\d+) checks passed/.exec(r.stdout)?.[1];
    expect(Number(n ?? 0)).toBeGreaterThanOrEqual(18);
  });

  it('the gate calls the shared module — no 13th stripper in bash', async () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src).toContain('lib/strip-comments.mjs');

    // This ban-grep is itself subject to the bug the wave fixes, and it FIRED while being
    // written: the gate's own comment EXPLAINING why a bash stripper is insufficient quotes the
    // shell form, and an unstripped assertion matched that explanation. A mention is not an
    // occurrence — one level up, in the test. So strip first, with the module this wave ships:
    // the assertion dogfoods its own artifact, and the most valuable line in the file (the
    // explanation) does not have to be deleted to satisfy a grep.
    const { stripComments } = await import(`file://${STRIPPER}`) as {
      stripComments: (t: string, f: string) => string;
    };
    const code = stripComments(src, 'check_system_map.sh');
    // A bash-side stripper would be a new, unshared, untested implementation on a hook that
    // governs every worktree — and the existing shell form is whole-line and diff-unaware anyway.
    expect(code).not.toMatch(/grep -vE '\^\[\[:space:\]\]\*#'/);
    expect(code).not.toMatch(/sed .*s[/|#].*\/\//);
    // ...and the strip must not have eaten the real call it is checking around (anti-blind-spot).
    expect(code).toContain('lib/strip-comments.mjs');
  });
});
