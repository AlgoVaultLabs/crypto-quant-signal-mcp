#!/usr/bin/env node
/**
 * check-tree-byproducts.mjs — OPS-CHECKOUT-PARITY-SIGNAL-MCP-W1 CH2
 *
 * THE RULE: the test suite may leave NO path in the working tree that it did not find there.
 *
 * WHY. `8ddd5405` landed a canary whose own unit test wrote `ops/monitoring/__pycache__/` into
 * every checkout that ran it — CI included — and nothing looked. The first signal was a host
 * provenance page (CHECKOUT_PARITY_SIGNAL_MCP), the day after, which then went red for 12
 * consecutive daily runs. The developer's Mac could not have seen it: its session env sets
 * PYTHONDONTWRITEBYTECODE=1 and Apple's python3 redirects bytecode to ~/Library/Caches. CI can,
 * so this gate runs THERE, around the Postgres lane's full suite.
 *
 * CH1 made interpreter caches unrepresentable (`.gitignore` `__pycache__`). This makes the NEXT
 * byproduct kind — a .pytest_cache, a state json, a log — red at the commit that introduces it,
 * instead of at a 06:47Z page weeks later. A finding here is CLASSIFIED (a reproducible cache may
 * earn a repo `.gitignore` rule; anything else must write elsewhere), never baselined ad hoc.
 *
 * USAGE
 *   node scripts/check-tree-byproducts.mjs --snapshot <file>   record the tree's state (raw bytes)
 *   node scripts/check-tree-byproducts.mjs --compare  <file>   diff the tree against that record
 *   node scripts/check-tree-byproducts.mjs --self-test         hermetic, two-way, vacuity-guarded
 *
 * THE INSTRUMENT is git's own: `git status --porcelain=v1 -z --untracked-files=all`, so `.gitignore`
 * is honoured by git itself and never by a re-implementation (scripts/check-build-context-hygiene.mjs's
 * ignoreMatches() was measured to misjudge both `__pycache__` cases). `-z` makes every path NUL-
 * terminated and unquoted, and the snapshot is written as the raw bytes git produced — never through
 * a shell `$(…)`, which would drop NULs and trailing newlines. A rename/copy entry (`R  new\0old\0`)
 * is ONE entry of two fields.
 *
 * VERDICT — exactly one terminal `TREE_BYPRODUCT_VERDICT=PASS|FAIL|INDETERMINATE`; callers gate on the
 * TOKEN. Codes 0 / 1 / 3 — 3 is the token-law default for a NEW gate. Set through `process.exitCode`,
 * never `process.exit()`, which abandons a queued pipe write and with it the token
 * (tests/unit/verdict-exit-path.test.ts).
 *   --compare  FAIL           an entry present after and absent before (each one named).
 *              PASS           positive output: `before N · after M · new 0`. An entry that DISAPPEARED
 *                             is reported, never failed — a test may legitimately clean up after itself.
 *              INDETERMINATE  a missing or unparseable snapshot, not a git repository, a git error.
 *   --snapshot PASS = recorded (the count is printed); INDETERMINATE when it could not be recorded,
 *              including a snapshot path INSIDE the work tree, which would itself become a byproduct.
 *
 * VACUITY. At runtime the WORLD builds the corpus, so an empty status (a clean tree) is a fact, and
 * the compare over it is a reported PASS. In --self-test WE build the corpus, so a self-test that
 * exercised zero cases of any class refuses (INDETERMINATE).
 *
 * WRITES: the snapshot file, and nothing else. No network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'TREE_BYPRODUCT_VERDICT';
const CODE = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
const MAX_NAMED = 200; // bounded output — every new entry is still COUNTED

/** git exports these into hooks; a fixture must never resolve to the real repository. */
const GIT_LEAKS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

class Indeterminate extends Error {}

function git(args, { cwd, env }) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw new Indeterminate(`git could not be spawned: ${r.error.message}`);
  if (r.status !== 0) {
    const why = String(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`;
    throw new Indeterminate(`git ${args[0]} failed: ${why}`);
  }
  return r.stdout;
}

function repoRoot(ctx) {
  return git(['rev-parse', '--show-toplevel'], ctx).toString('utf8').trim();
}

function statusZ(ctx) {
  return git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], ctx);
}

/**
 * Raw `-z` porcelain bytes -> entry keys. `latin1` round-trips every byte, so two distinct
 * non-UTF-8 names can never collide into one key; display re-decodes as UTF-8.
 * Throws Indeterminate on anything that is not porcelain v1 — input we were HANDED and could not
 * PARSE is never a pass.
 */
export function parseEntries(buf) {
  const s = Buffer.from(buf).toString('latin1');
  if (s === '') return [];
  if (!s.endsWith('\0')) throw new Indeterminate('snapshot is not NUL-terminated porcelain (truncated or not -z)');
  const fields = s.slice(0, -1).split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4 || f[2] !== ' ' || !/^[ MTADRCU?!]{2}$/.test(f.slice(0, 2))) {
      throw new Indeterminate(`unparseable porcelain entry #${out.length + 1}: ${JSON.stringify(f.slice(0, 40))}`);
    }
    const xy = f.slice(0, 2);
    let key = f;
    if (/[RC]/.test(xy)) {
      if (i + 1 >= fields.length) throw new Indeterminate(`rename/copy entry without its source path: ${JSON.stringify(f.slice(0, 40))}`);
      key = `${f}\0${fields[++i]}`;
    }
    out.push(key);
  }
  return out;
}

const show = (key) => Buffer.from(key.replace('\0', ' <- '), 'latin1').toString('utf8');

/**
 * Compared on REAL paths: git reports the top level resolved (macOS /var -> /private/var), so a lexical
 * comparison would wave a snapshot path inside the tree straight through. The file need not exist yet,
 * so its directory is resolved instead.
 */
function insideTree(root, file) {
  let real;
  try { real = join(realpathSync(dirname(file)), basename(file)); } catch { real = file; }
  const rel = relative(realpathSync(root), real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** --snapshot. Returns { verdict, lines }. */
export function runSnapshot(file, ctx) {
  try {
    if (!file) throw new Indeterminate('--snapshot needs a file path');
    const root = repoRoot(ctx);
    const target = resolve(ctx.cwd, file);
    if (insideTree(root, target)) {
      throw new Indeterminate(`refusing a snapshot path inside the work tree (${target}) — it would itself be a byproduct; use $RUNNER_TEMP or a temp dir`);
    }
    const buf = statusZ({ ...ctx, cwd: root });
    const n = parseEntries(buf).length; // a snapshot we could not parse back is no snapshot
    writeFileSync(target, buf);
    return { verdict: 'PASS', lines: [`snapshot recorded: ${n} entr${n === 1 ? 'y' : 'ies'} at ${root} -> ${target}`] };
  } catch (e) {
    if (e instanceof Indeterminate) return { verdict: 'INDETERMINATE', lines: [`snapshot NOT recorded: ${e.message}`] };
    return { verdict: 'INDETERMINATE', lines: [`snapshot NOT recorded: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/** --compare. Returns { verdict, lines }. */
export function runCompare(file, ctx) {
  try {
    if (!file) throw new Indeterminate('--compare needs the snapshot path');
    const target = resolve(ctx.cwd, file);
    if (!existsSync(target)) throw new Indeterminate(`snapshot missing: ${target} — the before-state was never recorded`);
    const before = new Set(parseEntries(readFileSync(target)));
    const root = repoRoot(ctx);
    const after = new Set(parseEntries(statusZ({ ...ctx, cwd: root })));
    const added = [...after].filter((k) => !before.has(k)).sort();
    const gone = [...before].filter((k) => !after.has(k)).sort();
    const lines = [`before ${before.size} · after ${after.size} · new ${added.length} · gone ${gone.length}  (${root})`];
    for (const k of added.slice(0, MAX_NAMED)) lines.push(`  NEW   ${show(k)}`);
    if (added.length > MAX_NAMED) lines.push(`  … and ${added.length - MAX_NAMED} more new`);
    for (const k of gone.slice(0, MAX_NAMED)) lines.push(`  gone  ${show(k)}  (reported, never failed)`);
    if (added.length > 0) {
      lines.push('A test-exercised path wrote into the tree. Classify it: a reproducible cache may earn a rule in the repo .gitignore; anything else must write to a temp dir. Never baseline it here.');
      return { verdict: 'FAIL', lines };
    }
    return { verdict: 'PASS', lines };
  } catch (e) {
    if (e instanceof Indeterminate) return { verdict: 'INDETERMINATE', lines: [`compare could not run: ${e.message}`] };
    return { verdict: 'INDETERMINATE', lines: [`compare could not run: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

// ── --self-test: hermetic temp repos, the REAL runSnapshot/runCompare, vacuity-guarded ──────────
export function selfTest() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_LEAKS.includes(k)));
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null'];
  const scratch = mkdtempSync(join(tmpdir(), 'tree-byproducts-'));
  const counts = { fire: 0, nofire: 0, indet: 0, map: 0 };
  const failures = [];
  let seq = 0;
  const check = (cls, name, want, got) => {
    counts[cls]++;
    if (want !== got) failures.push(`${name}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  };
  /** A committed repo: two tracked files and one .gitignore rule, nothing else. */
  const repo = () => {
    const dir = join(scratch, `r${++seq}`);
    const g = (...a) => git([...ident, ...a], { cwd: dir, env });
    mkdirSync(dir, { recursive: true });
    g('init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    g('add', '--', '.gitignore', 'a.txt', 'b.txt');
    g('commit', '-q', '-m', 'fixture');
    return dir;
  };
  /** snapshot -> mutate -> compare, through the same functions the CLI calls. */
  const around = (mutate, prepare = () => {}) => {
    const dir = repo();
    prepare(dir);
    const snap = join(scratch, `s${seq}.z`);
    const s = runSnapshot(snap, { cwd: dir, env });
    if (s.verdict !== 'PASS') return { verdict: `SNAPSHOT_${s.verdict}`, lines: s.lines };
    mutate(dir);
    return runCompare(snap, { cwd: dir, env });
  };
  try {
    // must-fire
    let r = around((d) => writeFileSync(join(d, 'new.tmp'), 'x'));
    check('fire', 'a new untracked file FAILs', 'FAIL', r.verdict);
    check('map', 'the new file is NAMED', true, r.lines.some((l) => l === '  NEW   ?? new.tmp'));
    r = around((d) => writeFileSync(join(d, 'a.txt'), 'changed\n'));
    check('fire', 'a modified tracked file FAILs', 'FAIL', r.verdict);
    r = around((d) => unlinkSync(join(d, 'b.txt')));
    check('fire', 'a deleted tracked file FAILs', 'FAIL', r.verdict);
    r = around((d) => writeFileSync(join(d, 'line\nbreak.tmp'), 'x'));
    check('fire', 'a filename containing a newline FAILs', 'FAIL', r.verdict);
    check('map', 'NUL-safe: that name is ONE entry', true, r.lines[0].includes('new 1 '));

    // must-not-fire
    r = around(() => {});
    check('nofire', 'no change PASSes', 'PASS', r.verdict);
    check('map', 'a PASS is positive output, not silence', true, /^before 0 · after 0 · new 0 · gone 0/.test(r.lines[0]));
    r = around((d) => writeFileSync(join(d, 'ignored.log'), 'x'));
    check('nofire', 'a .gitignore-matched file PASSes (judged by git)', 'PASS', r.verdict);
    r = around((d) => unlinkSync(join(d, 'pre.tmp')), (d) => writeFileSync(join(d, 'pre.tmp'), 'x'));
    check('nofire', 'an entry that DISAPPEARED is reported, never failed', 'PASS', r.verdict);
    check('map', 'the disappeared entry is reported', true, r.lines.some((l) => l.startsWith('  gone  ?? pre.tmp')));
    r = around(() => {}, (d) => writeFileSync(join(d, 'pre.tmp'), 'x'));
    check('nofire', 'a byproduct that was ALREADY there is not new', 'PASS', r.verdict);

    // must-map: the parser, on bytes we construct (the shapes `status -z` emits). A parser that
    // THROWS here must count as a failed assertion, not abort the suite — an assertion that raises
    // is not an assertion.
    const attempt = (fn) => { try { return fn(); } catch (e) { return `THREW: ${e instanceof Error ? e.message : e}`; } };
    const parsed = attempt(() => parseEntries(Buffer.from('R  new.txt\0old.txt\0?? x\0 M y\0', 'latin1')));
    check('map', 'a rename is one entry of two fields', 3, Array.isArray(parsed) ? parsed.length : parsed);
    check('map', 'the rename keeps its source', 'R  new.txt\0old.txt', Array.isArray(parsed) ? parsed[0] : parsed);
    check('map', 'an empty status is zero entries', 0, attempt(() => parseEntries(Buffer.alloc(0)).length));

    // INDETERMINATE
    const d0 = repo();
    check('indet', 'a missing snapshot is INDETERMINATE', 'INDETERMINATE', runCompare(join(scratch, 'absent.z'), { cwd: d0, env }).verdict);
    const notRepo = join(scratch, 'not-a-repo');
    mkdirSync(notRepo, { recursive: true });
    writeFileSync(join(scratch, 'empty.z'), '');
    // The ceiling stops git walking up into whatever repository the temp dir happens to sit in.
    const ceiling = { ...env, GIT_CEILING_DIRECTORIES: scratch };
    check('indet', 'a non-repository is INDETERMINATE', 'INDETERMINATE', runCompare(join(scratch, 'empty.z'), { cwd: notRepo, env: ceiling }).verdict);
    writeFileSync(join(scratch, 'garbage.z'), 'this is not porcelain');
    check('indet', 'an unparseable snapshot is INDETERMINATE', 'INDETERMINATE', runCompare(join(scratch, 'garbage.z'), { cwd: d0, env }).verdict);
    check('indet', 'a snapshot path inside the work tree is refused', 'INDETERMINATE', runSnapshot(join(d0, 'inside.z'), { cwd: d0, env }).verdict);
    check('map', 'a refused snapshot writes nothing', false, existsSync(join(d0, 'inside.z')));
  } catch (e) {
    failures.push(`self-test aborted: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const summary = `${counts.fire} must-fire, ${counts.nofire} must-not-fire, ${counts.indet} indeterminate, ${counts.map} must-map`;
  const vacuous = counts.fire === 0 || counts.nofire === 0 || counts.indet === 0 || counts.map === 0;
  // A failure we SAW outranks a class we never reached: a broken subject is FAIL, and its reason is printed.
  if (failures.length) {
    return { verdict: 'FAIL', lines: [...failures.map((f) => `  FAIL ${f}`),
      `SELF-TEST: FAIL (${failures.length} failing across ${summary}${vacuous ? '; some classes never ran' : ''})`] };
  }
  if (vacuous) return { verdict: 'INDETERMINATE', lines: [`SELF-TEST VACUOUS: ${summary}`] };
  return { verdict: 'PASS', lines: [`SELF-TEST: PASS (${summary})`] };
}

function emit({ verdict, lines }) {
  for (const l of lines) console.log(l);
  console.log(`${TOKEN}=${verdict}`);
  process.exitCode = CODE[verdict];
}

function main(argv) {
  const ctx = { cwd: process.cwd(), env: process.env };
  const [mode, file] = argv;
  if (mode === '--self-test' && argv.length === 1) return emit(selfTest());
  if (mode === '--snapshot' && argv.length === 2) return emit(runSnapshot(file, ctx));
  if (mode === '--compare' && argv.length === 2) return emit(runCompare(file, ctx));
  return emit({ verdict: 'INDETERMINATE', lines: [
    'usage: check-tree-byproducts.mjs --snapshot <file> | --compare <file> | --self-test',
  ] });
}

// Test-importable entrypoint: importing this module runs nothing; only `node scripts/…` does.
// Compared on REAL paths. Node realpaths the main module, so `import.meta.url` is /private/var/… on
// macOS while argv[1] can be /var/…; a lexical compare made a run through a symlinked path skip
// main() entirely and exit 0 with NO token — measured while proving this gate's own self-test could
// fail. A guard that silently does nothing at exit 0 is the dark-guard class; this cannot be one.
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const IS_MAIN = process.argv[1] != null && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (IS_MAIN) main(process.argv.slice(2));
