/**
 * Unit tests for SYSTEM-MAP-ENFORCEMENT-W1 / C2 — `scripts/check_system_map.sh`.
 *
 * The gate blocks commits with edge-mutation signals when system-map.md
 * hasn't been touched within MAX_AGE_SEC of NOW. These tests exercise:
 *
 *   (a) clean diff (no edge signals) + stale system-map.md → exit 0
 *   (b) edge signal in src/index.ts (mock `server.tool(` add) + stale → exit 1
 *   (c) edge signal + fresh system-map.md (touched within 10 min) → exit 0
 *   (d) edge signal + stale + `[skip-map-check]` in commit msg → exit 0
 *   (e) edge signal in `migrations/` (NEW SQL file) + stale → exit 1
 *
 * Strategy: each test creates a tmp git repo, copies the script in, sets
 * up controlled HEAD + staged state, points SYSTEM_MAP_PATH at a tmp file
 * with controlled mtime, runs the script via execFileSync, asserts the
 * exit code + (where relevant) stderr/stdout content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, chmodSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Resolve the gate script path relative to this test file's repo.
// performance-db tests use a similar pattern.
const SCRIPT_PATH = resolve(__dirname, '..', '..', 'scripts', 'check_system_map.sh');

interface TestRepo {
  dir: string;
  systemMapPath: string;
  cleanup: () => void;
}

function setupTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'check-system-map-'));
  // Initialize a real git repo with one commit on main
  execFileSync('git', ['-C', dir, 'init', '--initial-branch=main', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  // Initial commit (otherwise diff --cached has no HEAD to diff against)
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial']);

  // Create scripts/ + copy in our gate script (the test exercises the SAME
  // bash file the production hook uses).
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT_PATH, join(dir, 'scripts', 'check_system_map.sh'));
  chmodSync(join(dir, 'scripts', 'check_system_map.sh'), 0o755);

  // Mock system-map.md at a tmp path passed via SYSTEM_MAP_PATH env var.
  const systemMapPath = join(dir, 'system-map.md');
  writeFileSync(systemMapPath, '# mock system-map\n');

  return {
    dir,
    systemMapPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function setStaleMtime(path: string, ageSeconds: number): void {
  const t = new Date((Date.now() / 1000 - ageSeconds) * 1000);
  utimesSync(path, t, t);
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGate(
  repo: TestRepo,
  opts: { extraEnv?: Record<string, string> } = {},
): RunResult {
  try {
    const stdout = execFileSync(
      'bash',
      [join(repo.dir, 'scripts', 'check_system_map.sh')],
      {
        cwd: repo.dir,
        env: {
          ...process.env,
          SYSTEM_MAP_PATH: repo.systemMapPath,
          ...(opts.extraEnv ?? {}),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

describe('check_system_map.sh — pre-commit gate', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = setupTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  // ── (a) clean diff + stale map → exit 0 ──
  it('(a) clean diff (no edge signals) + stale system-map.md → exit 0', () => {
    setStaleMtime(repo.systemMapPath, 3600); // 1 hour stale
    // Stage a benign file change (no edge-mutation signals)
    writeFileSync(join(repo.dir, 'README.md'), '# test repo\n\n## new section\n');
    execFileSync('git', ['-C', repo.dir, 'add', 'README.md']);

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no edge-mutation signals');
  });

  // ── (b) edge signal (server.tool) + stale → exit 1 ──
  it('(b) edge signal (`server.tool(` add) + stale → exit 1 with BLOCK message', () => {
    setStaleMtime(repo.systemMapPath, 3600);
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'src/index.ts'),
      `// stub\nserver.tool("fake_new_tool", { schema: {} }, async () => {});\n`,
    );
    execFileSync('git', ['-C', repo.dir, 'add', 'src/index.ts']);

    const r = runGate(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('BLOCK');
    expect(r.stdout).toContain('server\\.tool\\(');
    expect(r.stdout).toContain('STALE');
  });

  // ── (c) edge signal + fresh map → exit 0 ──
  it('(c) edge signal + fresh system-map.md (touched within 10 min) → exit 0', () => {
    setStaleMtime(repo.systemMapPath, 60); // 1 min ago — fresh
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'src/index.ts'),
      `server.tool("fake_new_tool", { schema: {} }, async () => {});\n`,
    );
    execFileSync('git', ['-C', repo.dir, 'add', 'src/index.ts']);

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mtime fresh');
  });

  // ── (d) edge signal + stale + [skip-map-check] in commit msg → exit 0 ──
  it('(d) edge signal + stale + [skip-map-check] in commit msg → exit 0', () => {
    setStaleMtime(repo.systemMapPath, 3600);
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'src/index.ts'),
      `server.tool("fake_new_tool", { schema: {} }, async () => {});\n`,
    );
    execFileSync('git', ['-C', repo.dir, 'add', 'src/index.ts']);
    // Pre-populate COMMIT_EDITMSG (git creates this when commit -m runs;
    // we simulate by writing the file directly so the gate sees it).
    writeFileSync(
      join(repo.dir, '.git', 'COMMIT_EDITMSG'),
      'feat: add fake tool [skip-map-check]\n',
    );

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[skip-map-check] in commit message; bypassing');
  });

  // ── (e) edge signal in migrations/ (NEW SQL file) + stale → exit 1 ──
  it('(e) edge signal in `migrations/` (NEW SQL file) + stale → exit 1', () => {
    setStaleMtime(repo.systemMapPath, 3600);
    mkdirSync(join(repo.dir, 'migrations'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'migrations/0001_add_test_table.sql'),
      `CREATE TABLE test_t (id INT);\n`,
    );
    execFileSync('git', ['-C', repo.dir, 'add', 'migrations/0001_add_test_table.sql']);

    const r = runGate(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('BLOCK');
    // Either the file-pattern hit or the CREATE TABLE diff-line hit (gate
    // detects both — only need one to fire).
    expect(r.stdout).toMatch(/migrations\/|CREATE TABLE/);
  });
});
