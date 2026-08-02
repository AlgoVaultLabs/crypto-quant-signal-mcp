#!/usr/bin/env node
// @ts-check
/**
 * check-shared-state.mjs — the reconciler for ops/shared-worktree-state.json.
 *
 * OPS-SHARED-WORKTREE-STATE-REGISTRY-W1. Worktrees isolate the git INDEX and nothing else. The
 * shared hooks, the shared SQLite test DB and the $GIT_COMMON_DIR ledgers are common to every
 * checkout, and until this wave none of them had an enumeration — only the hope that whoever
 * wrote them next would remember. CLAUDE.md's own law says a shared primitive gets a CONSUMER
 * REGISTRY, not just drift detection, because "detection is strictly weaker than enumeration —
 * it only tells you the miss already happened". That law was applied to host monitoring
 * artefacts and never to developer-machine state, which is why the 4th writer to pre-push
 * halted every parallel session on 2026-08-01.
 *
 * ── ONLY ONE CHECK BLOCKS ────────────────────────────────────────────────────────────────────
 * UNPUBLISHED_DEP blocks, because it IS incident A and it is provably actionable: push the
 * script. Everything else REPORTS. Blocking on the rest would recreate the very deadlock this
 * wave exists to retire — a reconciler that refuses every push until 69 stale worktrees are
 * reclaimed is strictly worse than the problem. Every block prints its exact remediation;
 * blocking without remediation is hostile.
 *
 * ── ONE DECISION FUNCTION ────────────────────────────────────────────────────────────────────
 * `evaluate(registry, facts)` is pure. `--check` gathers real facts and calls it; `--self-test`
 * drives it with synthetic fixtures. The shipped decision and the asserted decision are the same
 * code path, so they cannot drift — the seam check_test_baseline.sh already uses for the same
 * reason.
 *
 * Usage:
 *   node scripts/check-shared-state.mjs --check       # verify (default)
 *   node scripts/check-shared-state.mjs --self-test   # two-directional, vacuity-guarded
 *
 * Verdict: exactly one terminal `SHARED_STATE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE.
 *   3 is the token-law DEFAULT for a new gate. It is deliberately NOT check_test_baseline.sh's
 *   2 — that script uses 2 only because it already deployed 2, and the two code spaces are
 *   deliberately not aligned (nothing reads both). One meaning, one code, chosen locally.
 * FAIL-CLOSED: an unreadable/invalid registry, an empty resource set, or a git that cannot
 * enumerate worktrees is INDETERMINATE and blocks — never a silent pass over an empty corpus.
 * ALGOVAULT_SHARED_STATE=warn downgrades the EXIT CODE only, never the TOKEN.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REGISTRY_PATH = join(ROOT, 'ops', 'shared-worktree-state.json');
const MODE = process.env.ALGOVAULT_SHARED_STATE ?? 'block';

/** Token → exit code. Exported so the self-test asserts the MAPPING, not merely the token. */
export function mapCode(token, mode = 'block') {
  if (token === 'PASS') return 0;
  // `warn` downgrades the CODE so a broken environment never blocks every push. It must never
  // launder the TOKEN into a pass — that is how a gate becomes decorative.
  if (mode === 'warn') return 0;
  return token === 'FAIL' ? 1 : 3;
}

function verdict(token, mode = MODE) {
  const code = mapCode(token, mode);
  if (mode === 'warn' && token !== 'PASS') {
    console.log(`[shared-state] ALGOVAULT_SHARED_STATE=warn — reporting ${token} without blocking.`);
  }
  console.log(`SHARED_STATE_VERDICT=${token}`);
  process.exit(code);
}

export function loadRegistry(path = REGISTRY_PATH) {
  if (!existsSync(path)) throw new Error(`registry not found at ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.resources)) throw new Error('registry has no `resources` array');
  return parsed;
}

/**
 * The ONE decision function. `facts` is everything observed about the machine, so this stays
 * pure and the self-test can drive every branch without a real repo.
 *
 * facts = {
 *   worktrees:   [{ path, reclaimable, scripts: { '<repo-rel path>': boolean } }],
 *   hookBlocks:  { '<hook>': ['<block name>', …] },   // what is actually installed
 *   reachable:   { '<repo-rel path>': boolean },      // from the resolved remote default ref
 *   skipLedgerRows: number,
 *   dbPresent:   boolean,
 * }
 */
export function evaluate(registry, facts) {
  const findings = [];
  const add = (check, severity, message, remediation = null) =>
    findings.push({ check, severity, message, remediation });

  const blocks = registry.resources.filter((r) => r.kind === 'hook-block');

  // ── UNPUBLISHED_DEP — the only blocking check. This IS incident A. ───────────────────────
  for (const b of blocks) {
    const ok = facts.reachable[b.script];
    if (ok) {
      add('UNPUBLISHED_DEP', 'ok', `${b.block_name}: ${b.script} reachable from the remote default ref`);
    } else {
      add(
        'UNPUBLISHED_DEP',
        'block',
        `${b.block_name}: ${b.script} is NOT reachable from the remote default ref — every worktree that lacks it runs unguarded, and before the skip-guard this condition blocked ~70 checkouts at once`,
        `git add ${b.script} && git commit && git push   # then re-run this gate`,
      );
    }
  }

  // ── MISSING_BLOCK / ORPHAN_BLOCK — registry ↔ installed hooks, both directions. ──────────
  const byHook = new Map();
  for (const b of blocks) {
    if (!byHook.has(b.hook)) byHook.set(b.hook, []);
    byHook.get(b.hook).push(b.block_name);
  }
  for (const [hook, names] of byHook) {
    const installed = facts.hookBlocks[hook] ?? [];
    for (const n of names) {
      if (installed.includes(n)) add('MISSING_BLOCK', 'ok', `${hook}: block '${n}' installed`);
      else
        add('MISSING_BLOCK', 'report', `${hook}: registry row '${n}' has no installed block`,
          `bash ${(blocks.find((b) => b.block_name === n)?.writers ?? ['<installer>'])[0]}`);
    }
    for (const n of installed) {
      if (!names.includes(n))
        add('ORPHAN_BLOCK', 'report', `${hook}: installed block '${n}' has no registry row`,
          `add a row to ops/shared-worktree-state.json, or remove the block`);
    }
  }

  // ── UNGUARDED_WORKTREE — split by exposure AND by reclaimability. ────────────────────────
  // A single "N unguarded" number would be true and useless. Two things differentiate it:
  //   · a gate backstopped in CI costs only defence-in-depth when skipped; an un-backstopped
  //     one (check-session-drift.mjs) is genuinely unprotected — it reasons about worktrees, so
  //     CI cannot run it;
  //   · most of the population is abandoned-worktree debt, and the remedy for that is
  //     RECLAMATION, not remediation. Reclaimability comes from cc-session.sh's own predicate.
  for (const b of blocks) {
    const missing = facts.worktrees.filter((w) => w.scripts[b.script] === false);
    const active = missing.filter((w) => !w.reclaimable);
    const backstopped = (b.backstopped_by ?? []).length > 0;
    if (missing.length === 0) {
      add('UNGUARDED_WORKTREE', 'ok', `${b.block_name}: present in all ${facts.worktrees.length} checkouts`);
      continue;
    }
    add(
      'UNGUARDED_WORKTREE',
      'report',
      `${b.block_name}: absent from ${missing.length}/${facts.worktrees.length} checkouts ` +
        `(${active.length} ACTIVE, ${missing.length - active.length} RECLAIMABLE) — ` +
        (backstopped
          ? `backstopped by ${(b.backstopped_by ?? []).join(', ')}, so a skip costs defence-in-depth only`
          : `NOT backstopped in CI: those checkouts have NO protection from this gate at all`),
      active.length > 0
        ? `git -C <worktree> checkout origin/HEAD -- ${b.script}   # for the ${active.length} ACTIVE one(s)`
        : `bash scripts/cc-session.sh clean --force   # all ${missing.length} are reclaimable`,
    );
  }

  // ── SKIP_LEDGER_STALE — a guard that has been quietly skipping. ──────────────────────────
  const threshold = registry.skip_ledger_stale_threshold ?? 200;
  if (facts.skipLedgerRows > threshold)
    add('SKIP_LEDGER_STALE', 'report',
      `skip ledger holds ${facts.skipLedgerRows} rows (threshold ${threshold}) — guards are running nowhere`,
      `bash scripts/cc-session.sh clean --force, or restore the missing scripts, then truncate the ledger`);
  else add('SKIP_LEDGER_STALE', 'ok', `skip ledger holds ${facts.skipLedgerRows} rows (threshold ${threshold})`);

  // ── CONCURRENT_WRITER — >1 live worktree can write a registered shared DB. ───────────────
  for (const db of registry.resources.filter((r) => r.kind === 'sqlite-db')) {
    if (!facts.dbPresent) {
      add('CONCURRENT_WRITER', 'ok', `${db.id}: not present on this machine`);
    } else if (facts.worktrees.length > 1) {
      const exempt = (db.exempt_consumers ?? []).map((e) => e.path);
      add('CONCURRENT_WRITER', 'report',
        `${db.id}: ${facts.worktrees.length} live worktrees can write it concurrently` +
          (exempt.length ? ` (${exempt.length} suite(s) isolate via PERFORMANCE_DB_PATH: ${exempt.join(', ')})` : ''),
        `export PERFORMANCE_DB_PATH=$(mktemp -d)/perf.db   # per-suite isolation; the lever already exists`);
    } else {
      add('CONCURRENT_WRITER', 'ok', `${db.id}: single checkout, no concurrent writer`);
    }
  }

  // ── REGISTRY_PARITY — cross-referenced primitives must resolve. ──────────────────────────
  for (const r of registry.resources.filter((x) => x.inventory_ref)) {
    const [refFile, refId] = String(r.inventory_ref).split('#');
    const invPath = join(ROOT, refFile);
    let ok = false;
    let detail = `${refFile} unreadable`;
    if (existsSync(invPath)) {
      try {
        const inv = JSON.parse(readFileSync(invPath, 'utf8'));
        const rows = inv.artifacts ?? inv.rows ?? [];
        const row = rows.find((x) => x.id === refId);
        ok = Boolean(row) && existsSync(join(ROOT, r.path));
        detail = row ? (ok ? `→ ${refFile}#${refId}` : `row found but ${r.path} is missing`) : `no row '${refId}' in ${refFile}`;
      } catch {
        detail = `${refFile} is not valid JSON`;
      }
    }
    if (ok) add('REGISTRY_PARITY', 'ok', `${r.id}: canonical sha256 cross-referenced ${detail}`);
    else add('REGISTRY_PARITY', 'report', `${r.id}: ${detail}`, `reconcile ops/shared-worktree-state.json against ${refFile}`);
  }

  return findings;
}

// ── fact gathering (impure; kept out of evaluate() on purpose) ─────────────────────────────

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function defaultRef() {
  try {
    return git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).replace(/^refs\/remotes\//, '');
  } catch {
    try {
      git(['rev-parse', '--verify', '--quiet', 'origin/main']);
      return 'origin/main';
    } catch {
      return null;
    }
  }
}

function commonDir() {
  return execFileSync('bash', ['-c', 'cd "$(git rev-parse --git-common-dir)" && pwd'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
}

/** Which blocks are actually installed in a hook, read from the live sentinels. */
function installedBlocks(hookPath) {
  if (!existsSync(hookPath)) return [];
  return [...readFileSync(hookPath, 'utf8').matchAll(/^# >>> algovault (\S+) \(/gm)].map((m) => m[1]);
}

/**
 * Reclaimable worktrees, taken from cc-session.sh's OWN predicate rather than re-derived.
 * `cc-session.sh clean` without --force is a pure dry run (it prints WOULD-REMOVE / KEEP and
 * only prunes under --force). Re-implementing "merged + clean + pushed" here would be a second
 * derivation of one rule, which is exactly what drifts.
 */
function reclaimableSet() {
  const r = spawnSync('bash', [join(ROOT, 'scripts', 'cc-session.sh'), 'clean'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
  });
  const out = `${r.stdout ?? ''}`;
  const set = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^WOULD-REMOVE\s+(\S+)/);
    if (m) set.add(m[1]);
  }
  return set;
}

function gatherFacts(registry) {
  const ref = defaultRef();
  if (!ref) throw new Error('cannot resolve the remote default ref (origin/HEAD unset and no origin/main)');

  const scripts = [...new Set(registry.resources.filter((r) => r.kind === 'hook-block').map((r) => r.script))];
  const reachable = {};
  for (const s of scripts) {
    reachable[s] = spawnSync('git', ['cat-file', '-e', `${ref}:${s}`], { cwd: ROOT }).status === 0;
  }

  const wtPaths = git(['worktree', 'list', '--porcelain'])
    .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  if (wtPaths.length === 0) throw new Error('git enumerated zero worktrees');

  const reclaimable = reclaimableSet();
  const worktrees = wtPaths.map((p) => ({
    path: p,
    reclaimable: reclaimable.has(p),
    scripts: Object.fromEntries(scripts.map((s) => [s, existsSync(join(p, s))])),
  }));

  const cd = commonDir();
  const hookBlocks = {};
  for (const h of [...new Set(registry.resources.filter((r) => r.kind === 'hook-block').map((r) => r.hook))]) {
    hookBlocks[h] = installedBlocks(join(cd, 'hooks', h));
  }

  const ledger = join(cd, 'algovault-hook-skip.log');
  const skipLedgerRows = existsSync(ledger)
    ? readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim()).length : 0;

  const dbRow = registry.resources.find((r) => r.kind === 'sqlite-db');
  const dbPresent = dbRow ? existsSync(dbRow.path.replace('$HOME', homedir())) : false;

  return { ref, worktrees, hookBlocks, reachable, skipLedgerRows, dbPresent };
}

// ── reporting ──────────────────────────────────────────────────────────────────────────────

const GLYPH = { ok: '✓', report: '⚠', block: '✖' };

function report(findings) {
  const order = ['UNPUBLISHED_DEP', 'MISSING_BLOCK', 'ORPHAN_BLOCK', 'UNGUARDED_WORKTREE', 'SKIP_LEDGER_STALE', 'CONCURRENT_WRITER', 'REGISTRY_PARITY'];
  for (const check of order) {
    const rows = findings.filter((f) => f.check === check);
    if (rows.length === 0) continue;
    console.log(`\n${check}`);
    // POSITIVE per-row output: a silent pass must be impossible to confuse with a pass over
    // zero rows. Every row prints, including the ones that are fine.
    for (const f of rows) {
      console.log(`  ${GLYPH[f.severity]} ${f.message}`);
      if (f.remediation) console.log(`      remediation: ${f.remediation}`);
    }
  }
}

// ── self-test: two-directional, vacuity-guarded, and it asserts the MAPPING ────────────────

function selfTest() {
  const assert = (cond, msg) => { if (!cond) { console.log(`✖ self-test: ${msg}`); console.log('SHARED_STATE_VERDICT=INDETERMINATE'); process.exit(3); } };

  const registry = loadRegistry();
  assert(registry.resources.length > 0, 'the real registry is empty — nothing to assert against');
  const blockRows = registry.resources.filter((r) => r.kind === 'hook-block');
  assert(blockRows.length > 0, 'the real registry declares no hook-block rows (vacuous corpus)');

  const cleanFacts = {
    worktrees: [{ path: '/w/a', reclaimable: false, scripts: Object.fromEntries(blockRows.map((b) => [b.script, true])) }],
    hookBlocks: Object.fromEntries([...new Set(blockRows.map((b) => b.hook))].map((h) => [h, blockRows.filter((b) => b.hook === h).map((b) => b.block_name)])),
    reachable: Object.fromEntries(blockRows.map((b) => [b.script, true])),
    skipLedgerRows: 0,
    dbPresent: false,
  };

  // ── direction 1: a clean machine PASSES ──
  let f = evaluate(registry, cleanFacts);
  assert(f.length > 0, 'evaluate() produced ZERO findings on a clean fixture — vacuous');
  assert(!f.some((x) => x.severity === 'block'), 'a clean fixture must not block');
  assert(f.some((x) => x.check === 'UNPUBLISHED_DEP' && x.severity === 'ok'), 'clean fixture produced no positive UNPUBLISHED_DEP row');

  // ── direction 2: each defect is DETECTED ──
  const unpublished = { ...cleanFacts, reachable: { ...cleanFacts.reachable, [blockRows[0].script]: false } };
  f = evaluate(registry, unpublished);
  const blocked = f.filter((x) => x.severity === 'block');
  assert(blocked.length === 1, `an unpublished dep must produce exactly 1 blocking finding, got ${blocked.length}`);
  assert(Boolean(blocked[0].remediation), 'a blocking finding without remediation is hostile');

  const orphan = { ...cleanFacts, hookBlocks: { ...cleanFacts.hookBlocks, [blockRows[0].hook]: [...cleanFacts.hookBlocks[blockRows[0].hook], 'not-in-registry'] } };
  f = evaluate(registry, orphan);
  assert(f.some((x) => x.check === 'ORPHAN_BLOCK' && x.severity === 'report'), 'an orphan block must REPORT');
  assert(!f.some((x) => x.severity === 'block'), 'an orphan block must NOT block');

  const missing = { ...cleanFacts, hookBlocks: { ...cleanFacts.hookBlocks, [blockRows[0].hook]: [] } };
  f = evaluate(registry, missing);
  assert(f.some((x) => x.check === 'MISSING_BLOCK' && x.severity === 'report'), 'a missing block must REPORT');

  const unguarded = {
    ...cleanFacts,
    worktrees: [
      cleanFacts.worktrees[0],
      { path: '/w/stale', reclaimable: true, scripts: { ...cleanFacts.worktrees[0].scripts, [blockRows[0].script]: false } },
    ],
  };
  f = evaluate(registry, unguarded);
  const ug = f.find((x) => x.check === 'UNGUARDED_WORKTREE' && x.severity === 'report');
  assert(Boolean(ug), 'an unguarded worktree must REPORT');
  assert(/ACTIVE/.test(ug.message) && /RECLAIMABLE/.test(ug.message), 'UNGUARDED_WORKTREE must split ACTIVE vs RECLAIMABLE, not emit one useless count');

  const ledgerHot = { ...cleanFacts, skipLedgerRows: (registry.skip_ledger_stale_threshold ?? 200) + 1 };
  assert(evaluate(registry, ledgerHot).some((x) => x.check === 'SKIP_LEDGER_STALE' && x.severity === 'report'), 'a hot skip ledger must REPORT');

  const dbShared = { ...cleanFacts, dbPresent: true, worktrees: [cleanFacts.worktrees[0], { path: '/w/b', reclaimable: false, scripts: cleanFacts.worktrees[0].scripts }] };
  assert(evaluate(registry, dbShared).some((x) => x.check === 'CONCURRENT_WRITER' && x.severity === 'report'), 'a shared DB with >1 worktree must REPORT');

  // ── the token → EXIT CODE mapping, not just the token ──
  // OPS-TEST-GATE-FAILOPEN-W1 shipped a self-test that asserted verdict TOKENS but never the
  // mapping, so re-coding INDETERMINATE to 0 left it fully green. Assert the mapping.
  assert(mapCode('PASS') === 0, 'PASS must map to 0');
  assert(mapCode('FAIL') === 1, 'FAIL must map to 1');
  assert(mapCode('INDETERMINATE') === 3, 'INDETERMINATE must map to 3 (token-law default for a new gate)');
  assert(mapCode('FAIL', 'warn') === 0 && mapCode('INDETERMINATE', 'warn') === 0, 'warn must downgrade the CODE');
  assert(mapCode('PASS', 'warn') === 0, 'warn must not change PASS');

  console.log(`✓ self-test: ${blockRows.length} registry block rows; clean fixture passes, 6 defect fixtures detected, token→exit mapping asserted.`);
}

// ── main ───────────────────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) { selfTest(); verdict('PASS'); return; }

  let registry;
  try {
    registry = loadRegistry();
  } catch (e) {
    console.log(`✖ shared-state: ${e.message}`);
    console.log('  A registry that cannot be read is not a clean machine — failing closed.');
    verdict('INDETERMINATE');
    return;
  }
  if (registry.resources.length === 0) {
    console.log('✖ shared-state: registry declares zero resources — refusing to report a pass over an empty corpus.');
    verdict('INDETERMINATE');
    return;
  }

  let facts;
  try {
    facts = gatherFacts(registry);
  } catch (e) {
    console.log(`✖ shared-state: cannot observe the machine — ${e.message}`);
    verdict('INDETERMINATE');
    return;
  }

  console.log(`[shared-state] ${registry.resources.length} registered resources · ${facts.worktrees.length} live checkouts · default ref ${facts.ref}`);
  const findings = evaluate(registry, facts);
  report(findings);

  const blocking = findings.filter((f) => f.severity === 'block');
  console.log('');
  if (blocking.length > 0) {
    console.log(`[shared-state] ${blocking.length} BLOCKING finding(s). Only UNPUBLISHED_DEP blocks — everything else above is a report.`);
    verdict('FAIL');
    return;
  }
  const reports = findings.filter((f) => f.severity === 'report');
  console.log(`[shared-state] no blocking findings; ${reports.length} report-class finding(s) across ${findings.length} checked rows.`);
  verdict('PASS');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
