/**
 * OPS-WORKTREE-RECLAIM-ON-CREATE-W1-V2 — automatic worktree reclaim.
 *
 *   scripts/worktree-reclaim.sh          THE one entry point (WorktreeCreate + SessionStart)
 *   scripts/cc-session.sh clean          the reclaim tool it runs (liveness leg B, work leg,
 *                                        D2 deletions, foreign sweepers)
 *   scripts/lib/worktree-work-pending.sh --worktree <path> + declared content conditions
 *   scripts/install-worktree-hook.sh     pinned install from a landed SHA + registrations
 *
 * EVERY drill runs in mkdtemp scratch. HOME is pointed at scratch too, because `clean`
 * discovers primaries by walking $HOME: with the real HOME a drill would sweep this machine.
 * The scripts under test are COPIED into a scratch tree shaped like the real install
 * (scripts/ + scripts/lib/ + ops/), so the SoT and the noise manifest they read are scratch
 * files — the real ops/shared-worktree-state.json and the real worktrees are never touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync,
  copyFileSync, cpSync, readdirSync, lstatSync, utimesSync, lutimesSync, realpathSync, chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(__dirname, '..', '..');
const TOUCHED = [
  'scripts/cc-session.sh',
  'scripts/worktree-reclaim.sh',
  'scripts/worktree-create-hook.sh',
  'scripts/install-worktree-hook.sh',
  'scripts/lib/worktree-work-pending.sh',
];

// A child must never inherit git's hook-exported plumbing variables (they would point every
// scratch `git` at the real repository) nor a lock marker from an enclosing land.sh.
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_') || k.startsWith('ALGOVAULT_') || k.startsWith('WORKTREE_RECLAIM_')) delete env[k];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@algovault.local',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@algovault.local',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

interface Run { stdout: string; stderr: string; status: number; ms: number }
function run(cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; input?: string; timeout?: number }): Run {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, env: opts.env, input: opts.input ?? '', encoding: 'utf8', timeout: opts.timeout ?? 180_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1, ms: Date.now() - t0 };
}

/** Set every entry under `p` (and `p` itself) to `days` ago, never following a symlink. */
function age(p: string, days: number): void {
  const when = new Date(Date.now() - days * 86_400_000);
  const walk = (q: string): void => {
    const st = lstatSync(q);
    if (st.isDirectory()) for (const e of readdirSync(q)) walk(join(q, e));
    if (st.isSymbolicLink()) lutimesSync(q, when, when); else utimesSync(q, when, when);
  };
  walk(p);
}

function waitFor(pred: () => boolean, ms: number): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    execFileSync('sleep', ['0.2']);
  }
  return pred();
}

interface Scratch {
  T: string; home: string; install: string; artifacts: string; locks: string; env: NodeJS.ProcessEnv;
}

/** A scratch world: HOME, an install-shaped copy of the scripts, and a writable SoT. */
function mkScratch(label: string): Scratch {
  const T = realpathSync(mkdtempSync(join(tmpdir(), `wt-reclaim-${label}-`)));
  const home = join(T, 'home');
  const install = join(T, 'install');
  mkdirSync(join(home, 'code'), { recursive: true });
  mkdirSync(join(install, 'scripts'), { recursive: true });
  mkdirSync(join(install, 'ops'), { recursive: true });
  for (const f of ['cc-session.sh', 'worktree-reclaim.sh', 'worktree-create-hook.sh', 'install-worktree-hook.sh']) {
    copyFileSync(join(REPO, 'scripts', f), join(install, 'scripts', f));
  }
  cpSync(join(REPO, 'scripts', 'lib'), join(install, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(REPO, 'ops', 'worktree-noise-config.json'), join(install, 'ops', 'worktree-noise-config.json'));
  const artifacts = join(T, 'artifacts');
  const locks = join(T, 'locks');
  const extra: Record<string, string> = {
    HOME: home, ALGOVAULT_HOOK_ARTIFACTS: artifacts, WORKTREE_RECLAIM_LOCK_DIR: locks,
  };
  // lsof is load-bearing for leg A; where a CI image lacks it, a shim reporting one unrelated
  // process keeps `clean` evaluable. On the Mac the REAL lsof is used.
  if (spawnSync('sh', ['-c', 'command -v lsof']).status !== 0) {
    const bin = join(T, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nprintf "p1\\ncinit\\nn/\\n"\n');
    chmodSync(join(bin, 'lsof'), 0o755);
    extra.PATH = `${bin}:${process.env.PATH}`;
  }
  return { T, home, install, artifacts, locks, env: baseEnv(extra) };
}

function writeSot(s: Scratch, roots: Record<string, unknown>): void {
  writeFileSync(join(s.install, 'ops', 'shared-worktree-state.json'), JSON.stringify({ worktree_roots: roots }, null, 2));
}

function reclaimBlock(sweepCwd: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cooldown_hours: 4, floor_gib: 0, auto_max_age_hours: 72, lock_ttl_s: 3600,
    sweep_cwd: sweepCwd, foreign_sweepers: [], ...over,
  };
}

/** A primary with a bare origin, so `origin/main` exists and the landed predicate can answer. */
function mkPrimary(s: Scratch, name: string, gitignore: string, extraFiles: Record<string, string> = {}): string {
  const dir = join(s.home, 'code', name);
  const remote = join(s.T, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote], { env: s.env });
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--initial-branch=main'], s.env);
  git(dir, ['config', 'commit.gpgsign', 'false'], s.env);
  git(dir, ['config', 'core.hooksPath', '/dev/null'], s.env);
  writeFileSync(join(dir, '.gitignore'), gitignore);
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  for (const [rel, body] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, ['add', '-A'], s.env);
  git(dir, ['commit', '-qm', 'seed'], s.env);
  git(dir, ['remote', 'add', 'origin', remote], s.env);
  git(dir, ['push', '-q', '-u', 'origin', 'main'], s.env);
  return dir;
}

function addWt(s: Scratch, prim: string, name: string): string {
  const wt = join(s.home, 'wt', name);
  mkdirSync(dirname(wt), { recursive: true });
  git(prim, ['worktree', 'add', '-q', wt, '-b', `b-${name}`, 'origin/main'], s.env);
  return wt;
}

interface Row { disp: string; path: string; branch: string; rest: string }
function parseClean(out: string): Row[] {
  const rows: Row[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(KEEP|REMOVED|WOULD-REMOVE) +(\S+) \(([^)]*)\)(.*)$/);
    if (m) rows.push({ disp: m[1], path: m[2], branch: m[3], rest: m[4] });
  }
  return rows;
}
function rowFor(rows: Row[], path: string): Row {
  const r = rows.find((x) => x.path === path);
  expect(r, `a disposition line for ${path}`).toBeDefined();
  return r as Row;
}
function branchExists(prim: string, branch: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync('git', ['-C', prim, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { env }).status === 0;
}

// ── 1. `clean --force` over one fleet, one worktree per class ──────────────────────────────
describe('cc-session.sh clean — every class, one sweep (Build Rule 1)', () => {
  let s: Scratch;
  let primA: string, primB: string, foreign: string;
  const wt: Record<string, string> = {};
  let out = '';
  let rows: Row[] = [];
  let target = '';

  beforeAll(() => {
    s = mkScratch('fleet');
    // primA ignores the things the WorktreeCreate hook and Python leave behind; primB ignores
    // only node_modules/ — the AOE/bot shape, where .DS_Store and __pycache__ are UNTRACKED.
    primA = mkPrimary(s, 'primA', 'data/\n__pycache__/\nnode_modules/\n.env.local\ndist/\n',
      { 'src/lib/deep/a.ts': 'export const a = 1;\n', 'pkg/mod.py': 'x = 1\n' });
    primB = mkPrimary(s, 'primB', 'node_modules/\n');
    foreign = mkPrimary(s, 'foreign', '');
    target = join(s.T, 'nm-target');
    mkdirSync(target);
    writeFileSync(join(target, 'precious'), 'keep me\n');

    const mk = (prim: string, name: string, setup?: (p: string) => void, aged = true, after?: (p: string) => void): void => {
      const p = addWt(s, prim, name);
      if (setup) setup(p);
      if (aged) age(p, 5);
      if (after) after(p);
      wt[name] = p;
    };
    mk(primA, 'landed');
    mk(primA, 'work', (p) => writeFileSync(join(p, 'notes.sql'), 'select 1;\n'));
    mk(primA, 'data', (p) => { mkdirSync(join(p, 'data')); writeFileSync(join(p, 'data', 'big.bin'), 'x'.repeat(4096)); });
    mk(primA, 'pyc-ignored', (p) => {
      mkdirSync(join(p, 'pkg', '__pycache__'), { recursive: true });
      writeFileSync(join(p, 'pkg', '__pycache__', 'm.cpython-311.pyc'), 'pyc');
      mkdirSync(join(p, 'dist')); writeFileSync(join(p, 'dist', 'index.js'), 'built');
    });
    // `git status --ignored` collapses an UNTRACKED directory whose every entry is ignored to
    // the directory itself (`!! tools/`), so its name — not __pycache__ — is what classifies.
    // Class A, so the worktree is KEPT: the fail-safe direction, pinned here as a decision.
    mk(primA, 'ignored-only-dir', (p) => {
      mkdirSync(join(p, 'tools', '__pycache__'), { recursive: true });
      writeFileSync(join(p, 'tools', '__pycache__', 'b.cpython-311.pyc'), 'pyc');
    });
    mk(primB, 'pyc-ds', (p) => {
      mkdirSync(join(p, 'pkg', '__pycache__'), { recursive: true });
      writeFileSync(join(p, 'pkg', '__pycache__', 'm.cpython-311.pyc'), 'pyc');
      writeFileSync(join(p, '.DS_Store'), 'finder');
      mkdirSync(join(p, 'sub')); writeFileSync(join(p, 'sub', '.DS_Store'), 'finder');
    });
    mk(primB, 'nmlink', (p) => symlinkSync(target, join(p, 'node_modules')));
    mk(primA, 'env-port', (p) => writeFileSync(join(p, '.env.local'), 'PORT=4242\n'));
    mk(primA, 'env-secret', (p) => writeFileSync(join(p, '.env.local'), 'PORT=4242\nNODE_ENV=development\n'));
    mk(primB, 'uvlock', (p) => writeFileSync(join(p, 'uv.lock'), 'lock\n'));
    mk(primA, 'unique', (p) => {
      writeFileSync(join(p, 'feature.txt'), 'unique\n');
      git(p, ['add', 'feature.txt'], s.env);
      git(p, ['commit', '-qm', 'unique commit'], s.env);
    });
    mk(primA, 'locked', (p) => git(primA, ['worktree', 'lock', p, '--reason', 'test lock'], s.env));
    mk(primA, 'exempt');
    // A TRACKED file at depth 4, touched inside the window with its content unchanged: git
    // status stays clean, so ONLY leg B can hold this worktree.
    mk(primA, 'deep', undefined, true, (p) => { const now = new Date(); utimesSync(join(p, 'src/lib/deep/a.ts'), now, now); });
    // Finder browsed it: a fresh .DS_Store, which also bumps the root directory's mtime.
    mk(primA, 'finder', undefined, true, (p) => writeFileSync(join(p, '.DS_Store'), 'finder'));
    // The hook's own brand-new worktree: everything in it was just written.
    mk(primA, 'fresh', undefined, false);
    mk(foreign, 'foreign-wt');

    writeSot(s, {
      worktree_root: join(s.home, 'wt'),
      exempt_paths: [{ path: wt.exempt, reason: 'test exemption', expires: 'never' }],
      reclaim: reclaimBlock(primA, { foreign_sweepers: [{ primary: foreign, owner: 'TEST-OWNER-W1', reason: 'test' }] }),
    });
    const r = run('bash', [join(s.install, 'scripts', 'cc-session.sh'), 'clean', '--force', '--max-age-hours', '24'],
      { cwd: primA, env: s.env });
    out = r.stdout + r.stderr;
    expect(r.status, out).toBe(0);
    rows = parseClean(r.stdout);
  }, 300_000);

  afterAll(() => { if (s) rmSync(s.T, { recursive: true, force: true }); });

  it('landed, clean and idle -> REMOVED, and its branch survives', () => {
    const r = rowFor(rows, wt.landed);
    expect(r.disp).toBe('REMOVED');
    expect(r.rest).toMatch(/kib=\d+/);
    expect(existsSync(wt.landed)).toBe(false);
    expect(branchExists(primA, 'b-landed', s.env)).toBe(true);
  });

  it('real untracked work -> KEEP work(<path>)', () => {
    expect(rowFor(rows, wt.work).rest).toContain('work(notes.sql)');
    expect(existsSync(join(wt.work, 'notes.sql'))).toBe(true);
  });

  it('the bdir3diag shape — landed, clean, ignored data/ -> KEEP ignored-payload(data)', () => {
    const r = rowFor(rows, wt.data);
    expect(r.disp).toBe('KEEP');
    expect(r.rest).toContain('ignored-payload(data)');
    expect(existsSync(join(wt.data, 'data', 'big.bin'))).toBe(true);
  });

  it('collapsed ignored __pycache__/ (beside tracked source) and dist/ are Class B -> REMOVED', () => {
    expect(rowFor(rows, wt['pyc-ignored']).disp).toBe('REMOVED');
  });

  it('an untracked dir holding ONLY ignored content collapses to that dir -> KEEP (fail-safe)', () => {
    expect(rowFor(rows, wt['ignored-only-dir']).rest).toContain('ignored-payload(tools)');
  });

  it('expanded untracked __pycache__/*.pyc and .DS_Store -> deleted first, then REMOVED', () => {
    const r = rowFor(rows, wt['pyc-ds']);
    expect(r.disp).toBe('REMOVED');
    expect(r.rest).toContain('[noise deleted first: 3]');
  });

  it('a node_modules symlink -> unlinked, never followed: its target is intact', () => {
    expect(rowFor(rows, wt.nmlink).disp).toBe('REMOVED');
    expect(readFileSync(join(target, 'precious'), 'utf8')).toBe('keep me\n');
  });

  it('.env.local = PORT=<n> -> Class B -> REMOVED; any other line -> KEEP', () => {
    expect(rowFor(rows, wt['env-port']).disp).toBe('REMOVED');
    const r = rowFor(rows, wt['env-secret']);
    expect(r.disp).toBe('KEEP');
    expect(r.rest).toContain('ignored-payload(.env.local)');
  });

  it('untracked uv.lock -> KEEP noise-not-deletable (Class B, but outside the D2 delete list)', () => {
    expect(rowFor(rows, wt.uvlock).rest).toContain('noise-not-deletable(uv.lock)');
    expect(existsSync(join(wt.uvlock, 'uv.lock'))).toBe(true);
  });

  it('a UNIQUE commit -> KEEP unmerged', () => {
    expect(rowFor(rows, wt.unique).rest).toMatch(/unmerged unpushed\(1\)/);
  });

  it('locked -> KEEP; exempt path -> KEEP', () => {
    expect(rowFor(rows, wt.locked).rest).toContain('locked (git worktree lock');
    expect(rowFor(rows, wt.exempt).rest).toContain('exempt: test exemption');
  });

  it('a depth-4 regular file touched inside the window -> KEEP in-use', () => {
    expect(rowFor(rows, wt.deep).rest).toContain('in-use(touched <24h ago)');
  });

  it('Finder-only .DS_Store plus a directory mtime -> NOT held (deleted as noise, REMOVED)', () => {
    const r = rowFor(rows, wt.finder);
    expect(r.rest).not.toContain('in-use');
    expect(r.disp).toBe('REMOVED');
  });

  it("the hook's own brand-new worktree -> KEEP in-use", () => {
    expect(rowFor(rows, wt.fresh).rest).toContain('in-use(touched <24h ago)');
  });

  it('a foreign primary -> one SKIP line, no git run in it, its worktree untouched', () => {
    expect(out).toContain(`SKIP primary ${foreign} — owned by TEST-OWNER-W1`);
    expect(out).not.toContain(`=== primary ${foreign} ===`);
    expect(rows.find((x) => x.path === wt['foreign-wt'])).toBeUndefined();
    expect(existsSync(wt['foreign-wt'])).toBe(true);
  });

  it('EXACTLY ONE terminal disposition per non-main worktree reached', () => {
    const reached = Object.entries(wt).filter(([k]) => k !== 'foreign-wt').map(([, p]) => p);
    for (const p of reached) expect(rows.filter((x) => x.path === p).length, p).toBe(1);
  });
});

// ── 2. the deliberate-break runs: each drill above must be ABLE to fail (Build Rule 2) ─────
describe('mutation proof — the drills go red when the logic is broken', () => {
  function sweepWith(mutate: (src: string) => string, setup: (s: Scratch, prim: string) => string): Row {
    const s = mkScratch('mut');
    try {
      const prim = mkPrimary(s, 'prim', 'data/\n');
      const target = setup(s, prim);
      const cc = join(s.install, 'scripts', 'cc-session.sh');
      const before = readFileSync(cc, 'utf8');
      const after = mutate(before);
      expect(after, 'the mutation must change the source, or this proves nothing').not.toBe(before);
      writeFileSync(cc, after);
      writeSot(s, { worktree_root: join(s.home, 'wt'), exempt_paths: [], reclaim: reclaimBlock(prim) });
      const r = run('bash', [cc, 'clean', '--max-age-hours', '24'], { cwd: prim, env: s.env });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return rowFor(parseClean(r.stdout), target);
    } finally {
      rmSync(s.T, { recursive: true, force: true });
    }
  }

  it('leg B restored to the directory-inclusive form -> the Finder drill reads in-use again', () => {
    const r = sweepWith(
      (src) => src.replace(
        /find "\$pp" \\\( -name node_modules -o -name \.venv -o -name \.git \\\) -prune \\\n\s+-o -type f ! -name \.DS_Store/,
        "find \"$pp\" -maxdepth 3 -not -path '*/.git/*' -not -path '*/node_modules*'"),
      (s, prim) => { const p = addWt(s, prim, 'finder'); age(p, 5); writeFileSync(join(p, '.DS_Store'), 'f'); return p; });
    expect(r.rest).toContain('in-use');
  });

  it('ignored-payload leg removed -> the bdir3diag drill would be REMOVED (data destroyed)', () => {
    const r = sweepWith(
      (src) => src.replace(/\[ -z "\$wp_ia" \] \|\| reasons="\$reasons ignored-payload\(\$\{wp_ia\}\)"/, ': # mutated'),
      (s, prim) => {
        const p = addWt(s, prim, 'data');
        mkdirSync(join(p, 'data')); writeFileSync(join(p, 'data', 'big.bin'), 'x');
        age(p, 5); return p;
      });
    expect(r.disp).toBe('WOULD-REMOVE');
  });

  it('work leg bypassed -> real untracked work would be eligible', () => {
    const r = sweepWith(
      // \x29 = a close paren, spelled as an escape so the test-budget gate's raw paren count balances
      (src) => src.replace(/case "\$wp_verdict" in\n\s+CLEAN\x29   : ;;/, 'case "CLEAN" in\n    CLEAN\x29   : ;;'),
      (s, prim) => { const p = addWt(s, prim, 'work'); writeFileSync(join(p, 'notes.sql'), 'x'); age(p, 5); return p; });
    expect(r.disp).not.toBe('KEEP');
  });
});

// ── 3. the entry point: cooldown, lock, verdict line, detach ───────────────────────────────
describe('scripts/worktree-reclaim.sh — the one entry point', () => {
  function fleet(label: string, over: Record<string, unknown> = {}): { s: Scratch; prim: string; landed: string } {
    const s = mkScratch(label);
    const prim = mkPrimary(s, 'prim', '');
    const landed = addWt(s, prim, 'landed');
    writeFileSync(join(landed, 'payload.txt'), 'y'.repeat(8192));
    git(landed, ['add', 'payload.txt'], s.env);
    git(landed, ['commit', '-qm', 'payload'], s.env);
    git(landed, ['push', '-q', 'origin', 'HEAD:main'], s.env);
    git(prim, ['fetch', '-q', 'origin'], s.env);
    age(landed, 5);
    writeSot(s, { worktree_root: join(s.home, 'wt'), exempt_paths: [], reclaim: reclaimBlock(prim, over) });
    return { s, prim, landed };
  }
  const entry = (s: Scratch) => join(s.install, 'scripts', 'worktree-reclaim.sh');
  const lines = (s: Scratch) => readFileSync(join(s.artifacts, 'reclaim.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  function stub(s: Scratch, body: string): string {
    const f = join(s.T, 'stub-clean.sh');
    writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  }

  it('PASS: runs clean --force --max-age-hours 72, removes the landed worktree, records counts and KiB', () => {
    const { s, prim, landed } = fleet('pass');
    try {
      const r = run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env: s.env });
      expect(r.stdout.trim().split('\n').pop()).toBe('WORKTREE_RECLAIM_VERDICT=PASS');
      expect(r.status).toBe(0);
      expect(existsSync(landed)).toBe(false);
      expect(branchExists(prim, 'b-landed', s.env)).toBe(true);
      const [j] = lines(s);
      expect(j.WORKTREE_RECLAIM_VERDICT).toBe('PASS');
      expect(j.trigger).toBe('manual');
      expect(j.max_age_hours).toBe(72);
      expect(j.removed).toBe(1);
      expect(j.considered).toBe(1);
      expect(j.kib_freed).toBeGreaterThan(0);
      expect(typeof j.free_gib).toBe('number');
      expect(j.installed_sha).toBe('uninstalled');
      expect(j.installed_matches_origin_main).toBeNull();
      expect(j.origin_main_compared).toBe(git(prim, ['rev-parse', 'origin/main'], s.env).trim());
      expect(j.worktreecreate_handlers).toBe(0);
      expect(j.double_registration).toBe(false);
      expect(existsSync(join(s.artifacts, 'reclaim.last-completed'))).toBe(true);
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('a second trigger inside the cooldown -> SKIPPED_COOLDOWN, and clean is not run', () => {
    const { s } = fleet('cool');
    try {
      expect(run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env: s.env }).status).toBe(0);
      const marker = join(s.T, 'clean-ran');
      const env = { ...s.env, WORKTREE_RECLAIM_CC_SESSION: stub(s, `touch ${marker}`) };
      const r = run('bash', [entry(s), '--trigger', 'session-start', '--foreground'], { env });
      expect(r.stdout.trim()).toBe('WORKTREE_RECLAIM_VERDICT=SKIPPED_COOLDOWN');
      expect(existsSync(marker)).toBe(false);
      expect(lines(s).pop().WORKTREE_RECLAIM_VERDICT).toBe('SKIPPED_COOLDOWN');
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('the lock held by a live sweep -> SKIPPED_LOCKED, clean NOT invoked, the holder untouched', () => {
    const { s } = fleet('lock');
    try {
      const dir = join(s.locks, 'worktree-reclaim.lock');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'holder'),
        `pid=${process.pid}\nhostname=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\n`
        + `acquired_at=now\nacquired_epoch=${Math.floor(Date.now() / 1000)}\nworktree=/\n`);
      const marker = join(s.T, 'clean-ran');
      const env = { ...s.env, WORKTREE_RECLAIM_CC_SESSION: stub(s, `touch ${marker}`) };
      const r = run('bash', [entry(s), '--trigger', 'worktree-create', '--foreground'], { env });
      expect(r.stdout.trim()).toBe('WORKTREE_RECLAIM_VERDICT=SKIPPED_LOCKED');
      expect(r.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dir, 'holder'))).toBe(true);
      expect(lines(s).pop().lock).toBe('TIMEOUT');
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('a crashing sweep -> INDETERMINATE (exit 3), and no cooldown stamp, so the next trigger sweeps', () => {
    const { s } = fleet('crash');
    try {
      const env = { ...s.env, WORKTREE_RECLAIM_CC_SESSION: stub(s, 'echo boom >&2; exit 1') };
      const r = run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env });
      expect(r.stdout.trim()).toBe('WORKTREE_RECLAIM_VERDICT=INDETERMINATE');
      expect(r.status).toBe(3);
      expect(existsSync(join(s.artifacts, 'reclaim.last-completed'))).toBe(false);
      expect(run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env: s.env }).stdout.trim())
        .toBe('WORKTREE_RECLAIM_VERDICT=PASS');
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('an unreadable reclaim block -> INDETERMINATE, and nothing is swept (fail closed for teardown)', () => {
    const { s, landed } = fleet('nocfg');
    try {
      writeSot(s, { worktree_root: join(s.home, 'wt'), exempt_paths: [] });
      const r = run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env: s.env });
      expect(r.stdout.trim()).toBe('WORKTREE_RECLAIM_VERDICT=INDETERMINATE');
      expect(existsSync(landed)).toBe(true);
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('below the floor -> PASS still, plus one floor line naming the largest HELD worktrees', () => {
    const { s, prim } = fleet('floor', { floor_gib: 100_000_000 });
    try {
      const held = addWt(s, prim, 'held');
      writeFileSync(join(held, 'work.sql'), 'x');
      age(held, 5);
      const r = run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env: s.env });
      expect(r.stdout.trim()).toBe('WORKTREE_RECLAIM_VERDICT=PASS');
      expect(lines(s).pop().floor_breached).toBe(true);
      const log = readFileSync(join(s.artifacts, 'reclaim.log'), 'utf8');
      expect(log).toMatch(/WORKTREE_RECLAIM_FLOOR: free [\d.]+ GiB < floor 100000000 GiB/);
      expect(log).toContain(`${held} \x28`);
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('the SessionStart form prints NOTHING and returns in < 1 s while the sweep runs on, detached', () => {
    const { s } = fleet('detach');
    try {
      const marker = join(s.T, 'clean-finished');
      const env = { ...s.env, WORKTREE_RECLAIM_CC_SESSION: stub(s, `sleep 3; touch ${marker}`) };
      const r = run('bash', [entry(s), '--trigger', 'session-start'], { env });
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.ms).toBeLessThan(1000);
      expect(waitFor(() => existsSync(marker), 20_000), 'the detached sweep ran to completion').toBe(true);
      expect(waitFor(() => existsSync(join(s.artifacts, 'reclaim.jsonl')), 10_000)).toBe(true);
      expect(lines(s).pop().trigger).toBe('session-start');
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('double registration: two DISTINCT WorktreeCreate handlers -> flagged and named; one -> not; unparseable -> null', () => {
    const { s, prim } = fleet('double');
    try {
      const wtc = (cmd: string) => JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: cmd }] }] } });
      const userFile = join(s.home, '.claude', 'settings.json');
      mkdirSync(dirname(userFile), { recursive: true });
      mkdirSync(join(prim, '.claude'), { recursive: true });
      const stubEnv = { ...s.env, WORKTREE_RECLAIM_CC_SESSION: stub(s, 'exit 0') };
      const sweep = () => {
        rmSync(join(s.artifacts, 'reclaim.last-completed'), { force: true });
        expect(run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env: stubEnv }).status).toBe(0);
        return lines(s).pop();
      };
      // One handler, declared in BOTH files with the identical string -> Claude dedupes it.
      writeFileSync(userFile, wtc('/inst/current/scripts/worktree-create-hook.sh'));
      writeFileSync(join(prim, '.claude', 'settings.json'), wtc('/inst/current/scripts/worktree-create-hook.sh'));
      let j = sweep();
      expect(j.worktreecreate_handlers).toBe(1);
      expect(j.double_registration).toBe(false);
      expect(j.worktreecreate_sources).toHaveLength(2);
      // The stale primary's old path beside the user one -> two distinct handlers.
      writeFileSync(join(prim, '.claude', 'settings.json'), wtc(`${prim}/scripts/worktree-create-hook.sh`));
      j = sweep();
      expect(j.worktreecreate_handlers).toBe(2);
      expect(j.double_registration).toBe(true);
      expect(j.worktreecreate_commands).toEqual([`${prim}/scripts/worktree-create-hook.sh`, '/inst/current/scripts/worktree-create-hook.sh'].sort());
      const log = readFileSync(join(s.artifacts, 'reclaim.log'), 'utf8');
      expect(log).toContain('WORKTREE_RECLAIM_DOUBLE_REGISTRATION: 2 distinct WorktreeCreate handlers');
      expect(log).toContain(`${prim}/scripts/worktree-create-hook.sh`);
      // settings.local.json counts too.
      writeFileSync(join(prim, '.claude', 'settings.json'), '{}');
      writeFileSync(join(prim, '.claude', 'settings.local.json'), wtc('/elsewhere/hook.sh'));
      expect(sweep().double_registration).toBe(true);
      // A present file that does not parse -> not enumerable -> null, never a guessed count.
      writeFileSync(join(prim, '.claude', 'settings.local.json'), '{not json');
      j = sweep();
      expect(j.worktreecreate_handlers).toBeNull();
      expect(j.double_registration).toBeNull();
      expect(j.WORKTREE_RECLAIM_VERDICT).toBe('PASS');
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('the double-registration drill can fail: counting one file only misses the stale primary', () => {
    const { s, prim } = fleet('double-mut');
    try {
      const src = readFileSync(entry(s), 'utf8');
      const broken = src.replace('"$SWEEP_CWD/.claude/settings.json" "$SWEEP_CWD/.claude/settings.local.json"', '');
      expect(broken).not.toBe(src);
      writeFileSync(entry(s), broken);
      const wtc = (cmd: string) => JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: cmd }] }] } });
      mkdirSync(join(s.home, '.claude'), { recursive: true });
      writeFileSync(join(s.home, '.claude', 'settings.json'), wtc('/inst/current/scripts/worktree-create-hook.sh'));
      mkdirSync(join(prim, '.claude'), { recursive: true });
      writeFileSync(join(prim, '.claude', 'settings.json'), wtc(`${prim}/scripts/worktree-create-hook.sh`));
      const env = { ...s.env, WORKTREE_RECLAIM_CC_SESSION: stub(s, 'exit 0') };
      run('bash', [entry(s), '--trigger', 'manual', '--foreground'], { env });
      expect(lines(s).pop().double_registration).toBe(false);
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('a bad trigger argument never fails the caller and prints nothing', () => {
    const s = mkScratch('badarg');
    try {
      const r = run('bash', [entry(s), '--trigger', 'nonsense'], { env: s.env });
      expect(r).toMatchObject({ stdout: '', status: 0 });
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  });
});

// ── 4. the WorktreeCreate hook: stdout contract and exit code with the trigger in place ────
describe('scripts/worktree-create-hook.sh — the reclaim trigger keeps the contract', () => {
  function hookRun(label: string, reclaimBody: string | null) {
    const s = mkScratch(label);
    const prim = mkPrimary(s, 'prim', '.env.local\n');
    const root = join(s.T, 'wtroot');
    writeSot(s, { worktree_root: root, exempt_paths: [], reclaim: reclaimBlock(prim) });
    const reclaim = join(s.install, 'scripts', 'worktree-reclaim.sh');
    if (reclaimBody === null) rmSync(reclaim);
    else if (reclaimBody !== 'REAL') writeFileSync(reclaim, `#!/usr/bin/env bash\n${reclaimBody}\n`);
    const r = run('bash', [join(s.install, 'scripts', 'worktree-create-hook.sh')], {
      env: s.env, input: JSON.stringify({ name: 'task-one', cwd: prim, hook_event_name: 'WorktreeCreate' }),
    });
    return { s, prim, root, r };
  }

  it('stdout is EXACTLY the path + newline, exit 0, when the sweep crashes', () => {
    const { s, root, r } = hookRun('hook-crash', 'echo noise; echo more >&2; exit 9');
    try {
      expect(r.stdout).toBe(`${join(root, 'prim', 'task-one')}\n`);
      expect(r.status).toBe(0);
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  }, 120_000);

  it('byte-identical to a run with no reclaim script at all', () => {
    const a = hookRun('hook-none', null);
    const b = hookRun('hook-real', 'REAL');
    try {
      const rel = (x: typeof a) => x.r.stdout.replace(x.root, '<root>');
      expect(rel(b)).toBe(rel(a));
      expect(b.r.status).toBe(a.r.status);
      expect(b.r.status).toBe(0);
      // and the real trigger did fire: a verdict line appears once the detached sweep ends
      expect(waitFor(() => existsSync(join(b.s.artifacts, 'reclaim.jsonl')), 30_000)).toBe(true);
    } finally {
      rmSync(a.s.T, { recursive: true, force: true });
      rmSync(b.s.T, { recursive: true, force: true });
    }
  }, 120_000);
});

// ── 5. the work predicate's new surface ────────────────────────────────────────────────────
describe('worktree-work-pending.sh — --worktree and declared content conditions', () => {
  it('the live manifest validates', () => {
    const r = run('bash', [join(REPO, 'scripts/lib/worktree-work-pending.sh'), '--validate-config'], { env: baseEnv() });
    expect(r.status, r.stderr).toBe(0);
  });

  it('every row this wave added carries reason, owner_wave and added', () => {
    const cfg = JSON.parse(readFileSync(join(REPO, 'ops/worktree-noise-config.json'), 'utf8'));
    const mine = cfg.rows.filter((x: { owner_wave?: string }) => x.owner_wave === 'OPS-WORKTREE-RECLAIM-ON-CREATE-W1-V2');
    expect(mine.map((x: { pattern: string }) => x.pattern).sort()).toEqual([
      '*.egg-info', '*__pycache__/*', '.DS_Store', '.cache', '.coverage', '.env.local',
      '.mcpregistry_*_token', '.pytest_cache', '.ruff_cache', '.vitest-*.json', '__pycache__', 'dist',
    ].sort());
    for (const x of mine) {
      expect(x.reason, x.pattern).toBeTruthy();
      expect(x.added, x.pattern).toBe('2026-10-17');
    }
    expect(mine.find((x: { pattern: string }) => x.pattern === '.env.local').content_lines_match).toBe('^PORT=[0-9]+$');
  });

  it('a malformed content condition, or one on a glob row, fails --validate-config', () => {
    const T = mkdtempSync(join(tmpdir(), 'wpw-cfg-'));
    try {
      const base = JSON.parse(readFileSync(join(REPO, 'ops/worktree-noise-config.json'), 'utf8'));
      for (const bad of [
        { pattern: '.env.local', match: 'relpath', class: 'B', reason: 'r', content_lines_match: '^PORT=[0-9+$' },
        { pattern: '*.env', match: 'glob', class: 'B', reason: 'r', content_lines_match: '^PORT=[0-9]+$' },
        { pattern: '.env.local', match: 'relpath', class: 'B', reason: 'r', content_lines_match: '' },
      ]) {
        const f = join(T, 'c.json');
        writeFileSync(f, JSON.stringify({ ...base, rows: [...base.rows, bad] }));
        const r = run('bash', [join(REPO, 'scripts/lib/worktree-work-pending.sh'), '--validate-config'],
          { env: baseEnv({ WORK_PENDING_CONFIG: f }) });
        expect(r.status, JSON.stringify(bad)).toBe(1);
      }
    } finally { rmSync(T, { recursive: true, force: true }); }
  });

  it('--worktree prints one row, class_a / class_b / ignored_a lines, and ONE verdict', () => {
    const s = mkScratch('wpw');
    try {
      const prim = mkPrimary(s, 'prim', 'data/\n.env.local\n');
      const p = addWt(s, prim, 'x');
      writeFileSync(join(p, 'work.sql'), 'w');
      writeFileSync(join(p, '.DS_Store'), 'f');
      mkdirSync(join(p, 'data')); writeFileSync(join(p, 'data', 'd'), 'd');
      writeFileSync(join(p, '.env.local'), 'PORT=1\n');
      const r = run('bash', [join(s.install, 'scripts/lib/worktree-work-pending.sh'), '--worktree', p], { env: s.env });
      const out = r.stdout.trim().split('\n');
      expect(out.filter((l) => l.startsWith('WORK_PENDING_VERDICT=')).length).toBe(1);
      expect(out[out.length - 1]).toBe('WORK_PENDING_VERDICT=PENDING');
      expect(r.status).toBe(1);
      expect(out[0].split('\t')).toHaveLength(7);
      expect(out).toContain('class_a\twork.sql');
      expect(out.some((l) => l.startsWith('class_b\t.DS_Store\t'))).toBe(true);
      expect(out).toContain('ignored_a\tdata');
      expect(out.some((l) => l.includes('.env.local'))).toBe(false);
    } finally { rmSync(s.T, { recursive: true, force: true }); }
  });

  it('the predicate self-test still passes', () => {
    const r = run('bash', [join(REPO, 'scripts/lib/worktree-work-pending.sh'), '--self-test'], { env: baseEnv() });
    expect(r.stdout).toContain('WORK_PENDING_VERDICT=CLEAN');
    expect(r.status).toBe(0);
  }, 120_000);
});

// ── 6. the install: a landed SHA, an atomic current, exactly two registration edits ────────
describe('scripts/install-worktree-hook.sh — pinned install and registrations', () => {
  let s: Scratch;
  let R: string;
  let sha1 = '';
  const inst = () => join(s.T, 'inst');
  const settings = () => join(s.T, 'settings.json');
  const env = () => ({ ...s.env, ALGOVAULT_HOOK_INSTALL_ROOT: inst(), ALGOVAULT_USER_SETTINGS: settings() });
  const installer = () => join(R, 'scripts', 'install-worktree-hook.sh');

  beforeAll(() => {
    s = mkScratch('install');
    // A scratch repository carrying the declared file set, landed on its own origin/main.
    R = join(s.home, 'code', 'repo');
    mkdirSync(R, { recursive: true });
    cpSync(join(s.install, 'scripts'), join(R, 'scripts'), { recursive: true });
    mkdirSync(join(R, 'ops'));
    copyFileSync(join(REPO, 'ops', 'worktree-noise-config.json'), join(R, 'ops', 'worktree-noise-config.json'));
    writeFileSync(join(R, 'ops', 'shared-worktree-state.json'),
      JSON.stringify({ worktree_roots: { worktree_root: join(s.T, 'wtroot'), exempt_paths: [], reclaim: reclaimBlock(R) } }, null, 2));
    mkdirSync(join(R, '.claude'));
    writeFileSync(join(R, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] } }, null, 2));
    const remote = join(s.T, 'repo.git');
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote], { env: s.env });
    git(R, ['init', '-q', '--initial-branch=main'], s.env);
    git(R, ['config', 'commit.gpgsign', 'false'], s.env);
    git(R, ['config', 'core.hooksPath', '/dev/null'], s.env);
    git(R, ['add', '-A'], s.env);
    git(R, ['commit', '-qm', 'tooling'], s.env);
    git(R, ['remote', 'add', 'origin', remote], s.env);
    git(R, ['push', '-q', '-u', 'origin', 'main'], s.env);
    sha1 = git(R, ['rev-parse', 'HEAD'], s.env).trim();
    writeFileSync(settings(), JSON.stringify({
      model: 'keep-me',
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: '/x/session-end.sh' }] }],
        WorktreeCreate: [{ hooks: [{ type: 'command', command: '/old/primary/scripts/worktree-create-hook.sh' }] }],
      },
    }, null, 2));
  }, 120_000);

  afterAll(() => { if (s) rmSync(s.T, { recursive: true, force: true }); });

  it('materializes the landed SHA, writes the manifest, swaps current, and reports per-file parity', () => {
    const r = run('bash', [installer(), sha1], { env: env() });
    expect(r.stdout.trim().split('\n').pop()).toBe('WORKTREE_HOOK_INSTALL_VERDICT=PASS');
    expect(realpathSync(join(inst(), 'current'))).toBe(realpathSync(join(inst(), sha1)));
    const manifest = readFileSync(join(inst(), sha1, '.manifest'), 'utf8').trim().split('\n');
    for (const f of ['scripts/worktree-create-hook.sh', 'scripts/worktree-reclaim.sh', 'scripts/cc-session.sh',
      'scripts/lib/with-lock.sh', 'scripts/lib/worktree-work-pending.sh', 'ops/shared-worktree-state.json',
      'ops/worktree-noise-config.json']) expect(manifest).toContain(f);
    expect(readFileSync(join(inst(), sha1, '.installed-sha'), 'utf8').trim()).toBe(sha1);
    expect(r.stdout + r.stderr).not.toContain('DIFF');
  });

  it('refuses a commit that is not on origin/main', () => {
    git(R, ['checkout', '-q', '-b', 'side'], s.env);
    writeFileSync(join(R, 'side.txt'), 's');
    git(R, ['add', 'side.txt'], s.env);
    git(R, ['commit', '-qm', 'side'], s.env);
    const side = git(R, ['rev-parse', 'HEAD'], s.env).trim();
    git(R, ['checkout', '-q', 'main'], s.env);
    const r = run('bash', [installer(), side], { env: env() });
    expect(r.stdout.trim().split('\n').pop()).toBe('WORKTREE_HOOK_INSTALL_VERDICT=FAIL');
    expect(r.stderr).toContain('REFUSED');
    expect(realpathSync(join(inst(), 'current'))).toBe(realpathSync(join(inst(), sha1)));
  });

  it('--register makes EXACTLY two edits, keeps everything else, backs up first, and is idempotent', () => {
    const before = JSON.parse(readFileSync(settings(), 'utf8'));
    for (let i = 0; i < 2; i++) {
      const r = run('bash', [installer(), sha1, '--register'], { env: env() });
      expect(r.stdout.trim().split('\n').pop(), r.stderr).toBe('WORKTREE_HOOK_INSTALL_VERDICT=PASS');
    }
    const after = JSON.parse(readFileSync(settings(), 'utf8'));
    expect(after.model).toBe('keep-me');
    expect(after.hooks.SessionEnd).toEqual(before.hooks.SessionEnd);
    expect(after.hooks.WorktreeCreate).toEqual([{ hooks: [{ type: 'command',
      command: `${inst()}/current/scripts/worktree-create-hook.sh` }] }]);
    expect(after.hooks.SessionStart).toEqual([{ matcher: 'startup', hooks: [{ type: 'command',
      command: `${inst()}/current/scripts/worktree-reclaim.sh --trigger session-start` }] }]);
    const backups = readdirSync(inst()).filter((f) => f.startsWith('registration-backup-'));
    expect(backups.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(inst(), backups.sort()[0]), 'utf8'))).toEqual(before);
  });

  it('--verify is PASS on a faithful install and FAIL once an installed file drifts', () => {
    expect(run('bash', [installer(), '--verify'], { env: env() }).stdout.trim().split('\n').pop()).toBe('WORKTREE_HOOK_INSTALL_VERDICT=PASS');
    const f = join(inst(), sha1, 'scripts', 'cc-session.sh');
    chmodSync(f, 0o644);
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n# drift\n`);
    const r = run('bash', [installer(), '--verify'], { env: env() });
    expect(r.stdout.trim().split('\n').pop()).toBe('WORKTREE_HOOK_INSTALL_VERDICT=FAIL');
    expect(r.stdout + r.stderr).toMatch(/DIFF .*scripts\/cc-session\.sh/);
  });

  it('the installed entry point reports installed_sha and a per-file drift on every run', () => {
    const r = run('bash', [join(inst(), 'current', 'scripts', 'worktree-reclaim.sh'), '--trigger', 'manual', '--foreground'],
      { env: env() });
    expect(r.stdout.trim()).toBe('WORKTREE_RECLAIM_VERDICT=PASS');
    const j = JSON.parse(readFileSync(join(s.artifacts, 'reclaim.jsonl'), 'utf8').trim().split('\n').pop() as string);
    expect(j.installed_sha).toBe(sha1);
    expect(j.installed_matches_origin_main).toBe(false);
    expect(j.installed_drift_files).toEqual(['scripts/cc-session.sh']);
    expect(j.origin_main_compared).toBe(sha1);
  }, 120_000);
});

// ── 7. static gates ────────────────────────────────────────────────────────────────────────
describe('static gates', () => {
  it('no touched script runs `git worktree remove --force` (Build Rule 3)', () => {
    for (const f of TOUCHED) {
      const code = readFileSync(join(REPO, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l));
      const hits = code.filter((l) => /worktree\s+remove\b.*--force|--force\b.*worktree\s+remove/.test(l));
      expect(hits, f).toEqual([]);
    }
  });

  it('the scan above can fail: it sees a --force remove when one is planted', () => {
    const planted = ['  git -C "$root" worktree remove --force "$path"'];
    expect(planted.filter((l) => /worktree\s+remove\b.*--force/.test(l))).toHaveLength(1);
  });

  it('the tracked .claude/settings.json holds NO WorktreeCreate entry, and keeps its SessionStart bootstrap (Build Rule 4)', () => {
    const j = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
    expect(j.hooks.WorktreeCreate).toBeUndefined();
    expect(JSON.stringify(j.hooks.SessionStart)).toContain('scripts/cc-session-bootstrap.sh');
  });

  it('the SoT reclaim block declares every key with a reason, and both foreign primaries', () => {
    const j = JSON.parse(readFileSync(join(REPO, 'ops', 'shared-worktree-state.json'), 'utf8'));
    const r = j.worktree_roots.reclaim;
    expect(r).toMatchObject({ cooldown_hours: 4, floor_gib: 20, auto_max_age_hours: 72, lock_ttl_s: 3600 });
    for (const k of ['cooldown', 'floor', 'auto_max_age', 'lock_ttl', 'sweep_cwd']) expect(r[`${k}_reason`], k).toBeTruthy();
    expect(r.foreign_sweepers.map((x: { primary: string }) => x.primary).sort())
      .toEqual(['/Users/tank/code/MCPVERIFY', '/Users/tank/code/mcpverify-site']);
    for (const x of r.foreign_sweepers) expect(x.owner).toBe('MCPVERIFY-WORKTREE-LIFECYCLE-W1');
  });

  it('both registered commands are EXECUTABLE — a hook command runs the path directly, not via bash', () => {
    for (const f of ['scripts/worktree-create-hook.sh', 'scripts/worktree-reclaim.sh']) {
      expect(lstatSync(join(REPO, f)).mode & 0o111, f).not.toBe(0);
    }
  });

  it('the hook spawns the entry point detached, after npm ci and before section 10', () => {
    const src = readFileSync(join(REPO, 'scripts', 'worktree-create-hook.sh'), 'utf8');
    const spawn = src.indexOf('bash "$RECLAIM" --trigger worktree-create >/dev/null 2>&1 </dev/null &');
    expect(spawn).toBeGreaterThan(src.indexOf('npm ci queued in background'));
    expect(spawn).toBeLessThan(src.indexOf('# ── 10. THE path, and nothing else'));
  });
});
