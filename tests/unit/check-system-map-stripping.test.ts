/**
 * OPS-SYSTEM-MAP-GATE-COMMENT-STRIP-W1 — the gate must not match its own prose.
 *
 * WHY THIS IS A SEPARATE FILE FROM check-system-map.test.ts, and the correction that produced it.
 * `vitest.config.ts:93-99` excludes the whole of check-system-map.test.ts from CI, blaming "a
 * BSD-vs-GNU platform difference in the script's mtime/stat probe". Measured 2026-08-12, that
 * reason does not hold: check_system_map.sh's probe is ALREADY portable
 * (`stat -f %m … || stat -c %Y … || echo 0`), and the sibling harness sets mtime with Node's
 * `utimesSync`, which is platform-independent. Neither side carries the named defect — so the real
 * cause of the CI failure is unmeasured, and it cannot be measured from a branch because
 * deploy.yml runs `npm test` only on `push: branches: [main]`.
 *
 * Fixing the mtime logic is out of this wave's scope, so rather than churn the five legacy cases
 * on an unverified theory, the NEW pattern/stripping cases live here — outside the exclusion, so
 * they run in CI — and are built to depend on nothing environmental:
 *
 *   · staleness is forced with SYSTEM_MAP_MAX_AGE_SEC=-1 (any age exceeds it), so no file mtime,
 *     no `utimesSync`, no clock, and no `stat` flavour is ever consulted;
 *   · `core.hooksPath=/dev/null` on the seed commit, so a developer's installed hooks cannot run
 *     inside the fixture repo.
 *
 * If this file does turn red on ubuntu, the honest move is to record the MEASURED error and add it
 * to the exclusion — not to claim CI coverage that was never observed.
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
      // Deterministic staleness: any age exceeds -1, so the gate always reaches its verdict
      // without consulting a clock or a stat flavour.
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
