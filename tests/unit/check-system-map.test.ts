/**
 * Unit tests for SYSTEM-MAP-ENFORCEMENT-W1 / C2 — `scripts/check_system_map.sh`.
 *
 * The gate blocks commits with edge-mutation signals when the map hasn't been
 * touched within MAX_AGE_SEC of NOW. These tests exercise:
 *
 *   (a) clean diff (no edge signals) + stale system-map.md → exit 0
 *   (b) edge signal in src/index.ts (mock `server.tool(` add) + stale → exit 1
 *   (c) edge signal + fresh system-map.md (touched within 10 min) → exit 0
 *   (d) edge signal + stale + `[skip-map-check]` in commit msg → exit 0
 *   (e) edge signal in `migrations/` (NEW SQL file) + stale → exit 1
 *
 * OPS-SYSTEM-MAP-DIRECTORY-W1 CH4 — the map is now a router (system-map.md) plus one card per
 * component (system-map/<component>.md), so freshness is the NEWEST mtime of the router and its
 * cards. Cases (f)–(n) below exercise that widening; see that block's own header.
 *
 * Strategy: each test creates a tmp git repo, copies the script in, sets
 * up controlled HEAD + staged state, points SYSTEM_MAP_PATH at a tmp file
 * with controlled mtime, runs the script via execFileSync, asserts the
 * exit code + (where relevant) stderr/stdout content.
 *
 * SPAWN BUDGET: every block that shells out declares `{ timeout }` in its OPTIONS argument — the
 * only place scripts/check-test-budget.mjs counts one (a trailing number is invisible to it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, chmodSync, copyFileSync, readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Resolve the gate script path relative to this test file's repo.
// performance-db tests use a similar pattern.
const SCRIPT_PATH = resolve(__dirname, '..', '..', 'scripts', 'check_system_map.sh');
const PATH_LIB = resolve(__dirname, '..', '..', 'scripts', 'lib', 'system-map-path.sh');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

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
    const e = err as {
      status?: number | null; signal?: string | null; code?: string;
      stdout?: Buffer | string; stderr?: Buffer | string; message?: string;
    };
    const out = e.stdout?.toString() ?? '';
    // `e.status ?? 1` WOULD BE A FAIL-OPEN ENCODING — ported from
    // check-system-map-stripping.test.ts, which learned it the expensive way. execFileSync throws
    // with status=null/undefined when the process never ran or was killed, so collapsing that to 1
    // makes "did not run" indistinguishable from "exited 1, i.e. BLOCKED" — and every case in this
    // file that asserts exitCode 1 would then PASS against a process that never executed. That is
    // exactly what hid the GNU stat bug: four ubuntu cases reported PASS while the gate was dying
    // in its own mtime probe. One code, two meanings, in a harness.
    // The two harnesses must not disagree about what a non-run means; a test asserts the shape.
    if (e.status === null || e.status === undefined) {
      throw new Error(
        `gate did not produce an exit status (signal=${e.signal ?? 'none'}, code=${e.code ?? 'none'}): `
        + `${e.message ?? ''}\nstdout: ${JSON.stringify(out)}\nstderr: ${JSON.stringify(e.stderr?.toString() ?? '')}`,
      );
    }
    if (!out.trim()) {
      throw new Error(
        `gate exited ${e.status} with EMPTY stdout — no gate path does that.\n`
        + `stderr: ${JSON.stringify(e.stderr?.toString() ?? '')}`,
      );
    }
    return {
      exitCode: e.status,
      stdout: out,
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
  it('(a) clean diff (no edge signals) + stale system-map.md → exit 0', { timeout: 30_000 }, () => {
    setStaleMtime(repo.systemMapPath, 3600); // 1 hour stale
    // Stage a benign file change (no edge-mutation signals)
    writeFileSync(join(repo.dir, 'README.md'), '# test repo\n\n## new section\n');
    execFileSync('git', ['-C', repo.dir, 'add', 'README.md']);

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('no edge-mutation signals');
  });

  // ── (b) edge signal (server.tool) + stale → exit 1 ──
  it('(b) edge signal (`server.tool(` add) + stale → exit 1 with BLOCK message', { timeout: 30_000 }, () => {
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
  it('(c) edge signal + fresh system-map.md (touched within 10 min) → exit 0', { timeout: 30_000 }, () => {
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
  it('(d) edge signal + stale + [skip-map-check] in commit msg → exit 0', { timeout: 30_000 }, () => {
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
  it('(e) edge signal in `migrations/` (NEW SQL file) + stale → exit 1', { timeout: 30_000 }, () => {
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

/**
 * OPS-SYSTEM-MAP-DIRECTORY-W1 CH4 — the card directory.
 *
 * WHY THE mtime LEG IS THE REAL FIX. The vault is not a git repository, so a staged diff can never
 * list the router or a card. A wave that edits only a card therefore leaves the router's mtime
 * stale, and a router-only gate fires on an honest commit. Freshness is now the NEWEST mtime of the
 * router plus system-map/*.md at depth 1.
 *
 * These fixtures copy the REAL path library beside the gate, because the directory is projected
 * from that ONE definition — a fixture that exported a directory variable of its own would test a
 * seam production never takes. Cases (a)–(e) above deliberately copy only the gate: an explicit
 * SYSTEM_MAP_PATH needs no library, and they pin that the router-only path still works without it.
 */
describe('check_system_map.sh — router + system-map/ card directory (OPS-SYSTEM-MAP-DIRECTORY-W1 CH4)', () => {
  let repo: TestRepo;
  let cardDir: string;

  beforeEach(() => {
    repo = setupTestRepo();
    mkdirSync(join(repo.dir, 'scripts', 'lib'), { recursive: true });
    copyFileSync(PATH_LIB, join(repo.dir, 'scripts', 'lib', 'system-map-path.sh'));
    cardDir = join(repo.dir, 'system-map');
    mkdirSync(cardDir);
    writeFileSync(join(cardDir, 'aoe.md'), '# aoe\n');
    writeFileSync(join(cardDir, 'landing.md'), '# landing/\n');
  });

  afterEach(() => {
    repo.cleanup();
  });

  /** Stage one real edge-mutation signal so every case reaches the freshness leg. */
  function stageEdgeSignal(): void {
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'src/index.ts'),
      `server.tool("fake_new_tool", { schema: {} }, async () => {});\n`,
    );
    execFileSync('git', ['-C', repo.dir, 'add', 'src/index.ts']);
  }

  /** Age the router AND both cards, so each case moves exactly the file it is about. */
  function ageAll(seconds: number): void {
    setStaleMtime(repo.systemMapPath, seconds);
    for (const f of ['aoe.md', 'landing.md']) setStaleMtime(join(cardDir, f), seconds);
  }

  it('(f) card-only edit: stale router + ONE fresh card → exit 0, naming the card', { timeout: 30_000 }, () => {
    ageAll(3600);
    setStaleMtime(join(cardDir, 'aoe.md'), 60);
    stageEdgeSignal();

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mtime fresh');
    expect(r.stdout).toContain('system-map/aoe.md');
  });

  it('(g) router-only edit: fresh router + stale cards → exit 0, naming the router', { timeout: 30_000 }, () => {
    ageAll(3600);
    setStaleMtime(repo.systemMapPath, 60);
    stageEdgeSignal();

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mtime fresh via system-map.md');
  });

  it('(h) router AND every card stale → BLOCK, reporting how many cards it considered', { timeout: 30_000 }, () => {
    ageAll(3600);
    stageEdgeSignal();

    const r = runGate(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('STALE');
    expect(r.stdout).toContain('2 card(s)');
  });

  it('(i) an unreadable card mtime BLOCKS — even when the router is fresh', { timeout: 30_000 }, () => {
    ageAll(3600);
    setStaleMtime(repo.systemMapPath, 60);
    writeFileSync(join(cardDir, 'UNREADABLE.md'), '# cannot be stat-ed\n');
    // A PATH shim makes `stat` fail for exactly that one card and delegates everything else —
    // including the gate's GNU/BSD flavour probe — to the real binary. chmod cannot fake this
    // portably: root ignores it, and a directory-level denial is a different case, (n).
    const realStat = execFileSync('bash', ['-c', 'command -v stat'], { encoding: 'utf8' }).trim();
    const shim = join(repo.dir, 'shim');
    mkdirSync(shim);
    writeFileSync(
      join(shim, 'stat'),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in *UNREADABLE*) echo "stat: simulated failure" >&2; exit 1;; esac; done\nexec "${realStat}" "$@"\n`,
    );
    chmodSync(join(shim, 'stat'), 0o755);
    stageEdgeSignal();

    const r = runGate(repo, { extraEnv: { PATH: `${shim}:${process.env.PATH ?? ''}` } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('could not read a numeric mtime');
    expect(r.stdout).toContain('UNREADABLE.md');
  });

  it('(j1) absent card directory → router-only fallback that SAYS so (fresh router → exit 0)', { timeout: 30_000 }, () => {
    rmSync(cardDir, { recursive: true, force: true });
    setStaleMtime(repo.systemMapPath, 60);
    stageEdgeSignal();

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('router-only');
  });

  it('(j2) absent card directory + stale router → still BLOCKS: the fallback is not a pass', { timeout: 30_000 }, () => {
    rmSync(cardDir, { recursive: true, force: true });
    setStaleMtime(repo.systemMapPath, 3600);
    stageEdgeSignal();

    const r = runGate(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('router-only');
    expect(r.stdout).toContain('STALE');
  });

  it('(k) a STAGED card is exempt like a staged router (fixture-only: the vault is not a repo)', { timeout: 30_000 }, () => {
    ageAll(3600);
    stageEdgeSignal();
    execFileSync('git', ['-C', repo.dir, 'add', 'system-map/aoe.md']);

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('exempt');
  });

  it('(l) SYSTEM_MAP_PATH precedence is unchanged — the card directory FOLLOWS the override', { timeout: 30_000 }, () => {
    // The fixture carries the real library, whose default is the vault. Were the directory
    // resolved from anywhere but the override, the printed directory would not be this one.
    ageAll(3600);
    setStaleMtime(join(cardDir, 'landing.md'), 60);
    stageEdgeSignal();

    const r = runGate(repo);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`card(s) in ${cardDir}`);
  });

  it('(m) the library projects the directory from the ONE path definition', { timeout: 30_000 }, () => {
    const lib = readFileSync(PATH_LIB, 'utf8');
    // The _PATH= line keeps its pre-wave shape (tests/unit/check-map-shape.test.ts and
    // tests/unit/prereg-mirror-parity.test.ts pin it too) …
    expect(lib).toMatch(/^ALGOVAULT_SYSTEM_MAP_PATH="\$\{SYSTEM_MAP_PATH:-\/[^}]+\/system-map\.md\}"$/m);
    // … and the directory is a projection of it, never a second literal.
    expect(lib).toMatch(/^ALGOVAULT_SYSTEM_MAP_DIR="\$\{ALGOVAULT_SYSTEM_MAP_PATH%\.md\}"$/m);
    expect(lib.split('system-map.md}').length - 1).toBe(1);

    const probe = (env: Record<string, string>): string => execFileSync(
      'bash',
      ['-c', '. "$1"; printf "%s|%s" "$ALGOVAULT_SYSTEM_MAP_PATH" "$ALGOVAULT_SYSTEM_MAP_DIR"', '_', PATH_LIB],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
    expect(probe({ SYSTEM_MAP_PATH: '/tmp/x/system-map.md' })).toBe('/tmp/x/system-map.md|/tmp/x/system-map');
    const [path, dir] = probe({ SYSTEM_MAP_PATH: '' }).split('|');
    expect(path.endsWith('/system-map.md')).toBe(true);
    expect(dir).toBe(path.slice(0, -'.md'.length));
  });

  describe.skipIf(IS_ROOT)('an unlistable card directory (root ignores permissions, so not as root)', () => {
    it('(n) a card directory that exists but cannot be listed BLOCKS — never a silent router-only pass', { timeout: 30_000 }, () => {
      setStaleMtime(repo.systemMapPath, 60);
      stageEdgeSignal();
      chmodSync(cardDir, 0o000);
      try {
        const r = runGate(repo);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain('cannot be listed');
      } finally {
        chmodSync(cardDir, 0o755);
      }
    });
  });
});
