#!/usr/bin/env node
// @ts-check
/**
 * check-session-drift.mjs — OPS-CC-DRIFT-DETECTOR-W1.
 *
 * Worktree-first made INDEX collisions structurally impossible. It does nothing about
 * SEMANTIC ones: two sessions independently rewriting the same file with overlapping-but-
 * different designs, neither aware of the other. This detects that at `pre-push` — the last
 * moment before a collision becomes shared state.
 *
 * Motivating evidence, all from 2026-07-30 and none hypothetical: `origin/main` moved FOUR
 * times in one session across ≥6 waves (282548a → 0d17276 → 4673224 → 66d0679); FOUR waves
 * rewrote scripts/check_test_baseline.sh inside ~90 minutes producing two independent,
 * non-duplicated designs of the SAME idea (main grepped 0 for the other's identifiers); and
 * a whole reconciliation wave was needed to merge them. That wave's triage — "do the commits
 * that landed since my base touch files I also touch?" — was done BY HAND, twice, under time
 * pressure. It is a deterministic computation. This is it.
 *
 * ── THE SEVERITY LADDER — confidence is NOT uniform ──────────────────────────────────────
 *   mode 1  stale_base        BLOCK   merge-base ∩ landed ∩ mine. Not a heuristic: an empty
 *                                     intersection is exactly the "proceed, re-point" case
 *                                     and a non-empty one is exactly the case that cost a
 *                                     reconciliation wave.
 *   mode 2  worktree_overlap  REPORT  another live worktree touches a file this push touches.
 *                                     High value, but ships REPORT-first behind a measured
 *                                     promotion criterion (see the config) so its false-
 *                                     positive rate is proven before it can ever annoy
 *                                     someone into disabling the whole guard.
 *   mode 3  merged_live_refs  REPORT  refs merged into origin/main whose ref still exists,
 *                                     escalating past the configured age. Hygiene — never a
 *                                     reason to block a push.
 *
 * Blocking with no remediation is hostile, so every BLOCK prints the exact command to
 * resolve it with the REAL SHAs substituted, never just a complaint.
 *
 * ── WHY THIS GATE'S INDETERMINATE CODE IS 3 AND check_test_baseline.sh's IS 2 ────────────
 * This is NOT a repeat of the 2-vs-3 drift OPS-TEST-GATE-RECONCILE-W1 just fixed. CLAUDE.md's
 * verdict-token law says: pick the indeterminate code by what the script ALREADY DEPLOYS for
 * that meaning; a NEW gate with no incumbent uses 3 (the token-law default). This gate is new
 * and has no incumbent, so it is 3. check_test_baseline.sh is 2 ONLY because it had already
 * shipped 2 for "could not verify" before the law existed. Nothing reads both code spaces and
 * no wrapper maps between them. Do not "align" them.
 *
 * ── WHY NODE, NOT BASH ───────────────────────────────────────────────────────────────────
 * This exact layer has produced TWO BSD-portability bugs — `wc -l` leading whitespace, and
 * `mktemp` templates requiring a terminal XXXXXX — both firing only on the operator's machine,
 * which is where every wave actually runs. A third surfaced while MEASURING for this very
 * wave: zsh does not word-split unquoted `$3`, which turned the first run of mode 1's
 * intersection check into a silent false PASS. `execFileSync` git plumbing has no BSD/GNU
 * divergence to get wrong.
 *
 * Usage:
 *   node scripts/check-session-drift.mjs              # run the three checks
 *   node scripts/check-session-drift.mjs --self-test  # hermetic; never touches the real repo
 *   ALGOVAULT_SESSION_DRIFT=warn ...                  # downgrade the CODE, never the token
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONFIG_PATH = join(ROOT, 'ops', 'session-drift-config.json');
const argv = process.argv.slice(2);
const MODE = process.env.ALGOVAULT_SESSION_DRIFT ?? 'block';

// ── the ONE place a verdict is emitted ───────────────────────────────────────────────────
// Single-derivation: token → code is mapped here and nowhere else, and every terminal path
// goes through verdict(). That is what makes "exactly one SESSION_DRIFT_VERDICT line per run"
// structural rather than a convention the next early-return has to remember.
export function mapCode(token, mode = 'block') {
  let c;
  if (token === 'PASS') c = 0;
  else if (token === 'FAIL') c = 1;
  else if (token === 'INDETERMINATE') c = 3;
  else return 3;
  // warn downgrades the CODE, never the token.
  if (c !== 0 && mode === 'warn') c = 0;
  return c;
}

function verdict(token, mode = MODE) {
  const t = ['PASS', 'FAIL', 'INDETERMINATE'].includes(token) ? token : 'INDETERMINATE';
  if (t !== token) console.error(`[session-drift] internal: unknown token '${token}' — reporting INDETERMINATE.`);
  const code = mapCode(t, mode);
  if (t !== 'PASS' && mode === 'warn') {
    console.error(`[session-drift] WARNING: ALGOVAULT_SESSION_DRIFT=warn → ${t} downgraded to exit 0. Nothing is blocked.`);
  }
  console.log(`SESSION_DRIFT_VERDICT=${t}`);
  process.exit(code);
}

// ── pure helpers (driven directly by --self-test, so the self-test exercises the REAL logic) ──

/** Intersection of two path lists, minus the union-safe set. Mode 1 and mode 2 both use it. */
export function intersectPaths(landed, mine, unionSafe = []) {
  const safe = new Set(unionSafe);
  const m = new Set(mine.filter((p) => p && !safe.has(p)));
  return [...new Set(landed.filter((p) => p && !safe.has(p) && m.has(p)))].sort();
}

/**
 * TRACKED-ONLY touched set. R1 measured this single decision taking mode 2's false-positive
 * rate from 174/435 to 2/28 with NO exclusion list at all — the dominant noise was
 * `node_modules` appearing as UNTRACKED in 19 worktrees, because .gitignore's `node_modules/`
 * pattern does not match a SYMLINK (the known worktree symlink trap). Excluding local
 * artifacts by name would have been an ever-growing list; dropping untracked paths by
 * construction is the generator-level fix.
 *
 * Callers pass `git status --porcelain -uno`: since untracked paths are discarded anyway,
 * asking git to ENUMERATE them is pure waste — and expensive waste, because it walks
 * node_modules in every worktree. Measured on this tree (59 worktrees): 9.9s → 5.0s for a
 * full run, with byte-identical findings. Acceptable next to the ~40s test-baseline gate that
 * shares this hook; if the worktree count grows much further, parallelising the per-worktree
 * probes is the next lever (not another exclusion list).
 * The `??` filter here is kept regardless, so the function stays correct if a caller forgets.
 */
export function trackedPathsFromStatus(porcelain) {
  return porcelain
    .split('\n')
    .filter((l) => l.length > 3 && !l.startsWith('??'))
    .map((l) => l.slice(3).replace(/^.* -> /, '').trim())
    .filter(Boolean);
}

export function loadConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) throw new Error(`config missing: ${path}`);
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  const rows = cfg.union_safe_paths;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('union_safe_paths must be a non-empty array');
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.path || !r.reason) {
      throw new Error('every union_safe_paths row needs BOTH `path` and `reason` (an exemption in prose alone gets "fixed" later)');
    }
  }
  return cfg;
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ── the three checks ─────────────────────────────────────────────────────────────────────
// Each prints its OWN result line carrying the MEASURED values. Absence-of-alert is never
// the assertion — a check that only speaks up when unhappy is indistinguishable from a
// check that never ran.

function checkStaleBase(unionSafe) {
  const base = git(['merge-base', 'origin/main', 'HEAD']);
  const head = git(['rev-parse', '--short', 'HEAD']);
  const mainSha = git(['rev-parse', '--short', 'origin/main']);
  const landed = git(['diff', '--name-only', base, 'origin/main']).split('\n').filter(Boolean);
  const mine = git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  const hits = intersectPaths(landed, mine, unionSafe);
  const behind = landed.length === 0 ? 0 : Number(git(['rev-list', '--count', `${base}..origin/main`]));

  console.log(
    `  stale_base       base=${base.slice(0, 7)} head=${head} origin/main=${mainSha} ` +
    `behind=${behind} landed_files=${landed.length} my_files=${mine.length} overlap=${hits.length}`,
  );
  if (hits.length) {
    console.log('    ⛔ files changed on BOTH sides since your base:');
    for (const f of hits) console.log(`       - ${f}`);
    console.log('    remediation — re-point onto the landed work before pushing:');
    console.log(`       git -C "${ROOT}" fetch origin && git merge origin/main   # then resolve, re-run the suite`);
    console.log(`       (or: git rebase origin/main   — only if this branch is NOT yet pushed)`);
  }
  return hits.length === 0;
}

function checkWorktreeOverlap(unionSafe, enforcement) {
  const mineBase = git(['merge-base', 'origin/main', 'HEAD']);
  const mine = [
    ...git(['diff', '--name-only', mineBase, 'HEAD']).split('\n'),
    ...trackedPathsFromStatus(git(['status', '--porcelain', '-uno'])),
  ].filter(Boolean);

  const worktrees = git(['worktree', 'list', '--porcelain'])
    .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));

  const collisions = [];
  for (const wt of worktrees) {
    if (resolve(wt) === resolve(ROOT)) continue;
    let base, theirs;
    try {
      base = git(['merge-base', 'origin/main', 'HEAD'], wt);
      theirs = [
        ...git(['diff', '--name-only', base, 'HEAD'], wt).split('\n'),
        ...trackedPathsFromStatus(git(['status', '--porcelain', '-uno'], wt)),
      ].filter(Boolean);
    } catch {
      continue; // a worktree we cannot read is not evidence of a collision
    }
    const hits = intersectPaths(theirs, mine, unionSafe);
    if (hits.length) collisions.push({ wt, hits });
  }

  console.log(
    `  worktree_overlap worktrees_scanned=${worktrees.length - 1} my_tracked_files=${new Set(mine).size} ` +
    `colliding_worktrees=${collisions.length} enforcement=${enforcement}`,
  );
  for (const c of collisions) {
    console.log(`    ⚠ ${c.wt}`);
    for (const f of c.hits) console.log(`       - ${f}`);
  }
  // REPORT-only until the promotion criterion in the config is met.
  return enforcement === 'block' ? collisions.length === 0 : true;
}

function checkMergedLiveRefs(staleDays) {
  const now = Date.now();
  let refs = [];
  try {
    refs = git(['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/remotes/origin'])
      .split('\n').filter(Boolean)
      .map((l) => { const [name, ts] = l.split(' '); return { name, ts: Number(ts) }; })
      .filter((r) => r.name !== 'origin/main' && r.name !== 'origin/HEAD');
  } catch { /* handled by the caller's try/catch → INDETERMINATE */ }

  const merged = [];
  for (const r of refs) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', r.name, 'origin/main'], { cwd: ROOT, stdio: 'ignore' });
      merged.push({ ...r, ageDays: Math.floor((now - r.ts * 1000) / 86_400_000) });
    } catch { /* not merged — fine */ }
  }
  const stale = merged.filter((r) => r.ageDays >= staleDays);
  console.log(
    `  merged_live_refs remote_refs=${refs.length} merged_but_live=${merged.length} ` +
    `stale_over_${staleDays}d=${stale.length}`,
  );
  for (const r of stale.slice(0, 10)) console.log(`    ⚠ ${r.name} (merged, ${r.ageDays}d old)`);
  if (stale.length > 10) console.log(`    … and ${stale.length - 10} more`);
  if (stale.length) console.log(`    remediation (human act, never automated): git push origin --delete <branch>`);
  return true; // hygiene only — never blocks
}

// ── --self-test (hermetic: touches no repo state) ────────────────────────────────────────
function selfTest() {
  const fails = [];
  let fire = 0, noFire = 0, map = 0;

  const chkFire = (label, expected, actual) => {
    fire++;
    if (expected === actual) console.log(`    ✓ must-fire: ${label} ⇒ ${actual}`);
    else fails.push(`MISSED must-fire: ${label} — expected ${expected}, got ${actual}`);
  };
  const chkNoFire = (label, expected, actual) => {
    noFire++;
    if (expected === actual) console.log(`    ✓ must-not-fire: ${label} ⇒ ${actual}`);
    else fails.push(`FALSE POSITIVE must-not-fire: ${label} — expected ${expected}, got ${actual}`);
  };
  const chkMap = (label, expectedCode, token, mode) => {
    map++;
    const got = mapCode(token, mode);
    if (got === expectedCode) console.log(`    ✓ must-map: ${label} ⇒ exit ${got}`);
    else fails.push(`WRONG must-map: ${label} — expected exit ${expectedCode}, got ${got}`);
  };

  const tok = (hits) => (hits.length ? 'FAIL' : 'PASS');
  const cfgToken = (fn) => { try { fn(); return 'PASS'; } catch { return 'INDETERMINATE'; } };

  console.log('[session-drift] --self-test (hermetic; no repo state is read)');

  // must-fire
  chkFire('overlapping landed ∩ mine', 'FAIL',
    tok(intersectPaths(['src/a.ts', 'docs/x.md'], ['src/a.ts', 'src/b.ts'], [])));
  chkFire('unreadable config', 'INDETERMINATE',
    cfgToken(() => loadConfig('/nonexistent/session-drift-config.json')));
  chkFire('config row missing `reason`', 'INDETERMINATE',
    cfgToken(() => { const r = [{ path: 'x' }]; if (!r.every((q) => q.path && q.reason)) throw new Error('no reason'); }));
  chkFire('a git command failing', 'INDETERMINATE',
    cfgToken(() => git(['rev-parse', '--verify', 'refs/heads/__definitely_not_a_ref__'])));

  // must-not-fire
  chkNoFire('empty intersection', 'PASS',
    tok(intersectPaths(['docs/x.md'], ['src/b.ts'], [])));
  chkNoFire('overlap ONLY on a union-safe path', 'PASS',
    tok(intersectPaths(['.github/workflows/deploy.yml'], ['.github/workflows/deploy.yml'], ['.github/workflows/deploy.yml'])));
  chkNoFire('untracked paths are dropped at source', 'PASS',
    tok(intersectPaths(['node_modules'], trackedPathsFromStatus('?? node_modules\n M src/b.ts'), [])));

  // must-map
  chkMap('PASS in block mode', 0, 'PASS', 'block');
  chkMap('FAIL in block mode', 1, 'FAIL', 'block');
  chkMap('INDETERMINATE in block mode', 3, 'INDETERMINATE', 'block');
  chkMap('FAIL under warn', 0, 'FAIL', 'warn');
  chkMap('INDETERMINATE under warn', 0, 'INDETERMINATE', 'warn');
  chkMap('PASS is never downgraded', 0, 'PASS', 'warn');

  // Vacuity guard — a self-test that ran zero assertions prints the same ✓ as one that ran
  // thirteen. CLOSEDBAR CH2's PII-guard self-test shipped exactly that way and reported a
  // green "passed (0 must-fire, 0 must-not-fire)".
  if (fire === 0 || noFire === 0 || map === 0) {
    console.log(`self-test failed: VACUOUS — ${fire} must-fire, ${noFire} must-not-fire, ${map} must-map (all must be > 0); refusing to report a pass.`);
    console.log('SESSION_DRIFT_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  if (fails.length) {
    console.log('self-test failed:');
    for (const f of fails) console.log(`   - ${f}`);
    console.log('SESSION_DRIFT_VERDICT=FAIL');
    process.exit(1);
  }
  console.log(`self-test passed (${fire} must-fire, ${noFire} must-not-fire, ${map} must-map)`);
  console.log('SESSION_DRIFT_VERDICT=PASS');
  process.exit(0);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────
if (argv.includes('--self-test')) selfTest();

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  // Fail CLOSED: an unreadable config means the checks did not run, which is not a pass.
  console.error(`[session-drift] config error: ${e.message}`);
  verdict('INDETERMINATE');
}

const unionSafe = cfg.union_safe_paths.map((r) => r.path);
console.log('[session-drift] parallel-session drift checks');

let ok;
try {
  const a = checkStaleBase(unionSafe);
  const b = checkWorktreeOverlap(unionSafe, cfg.mode2_enforcement ?? 'report');
  const c = checkMergedLiveRefs(cfg.merged_ref_stale_days ?? 14);
  ok = a && b && c;
} catch (e) {
  console.error(`[session-drift] a git probe failed: ${e.message}`);
  verdict('INDETERMINATE');
}

verdict(ok ? 'PASS' : 'FAIL');
