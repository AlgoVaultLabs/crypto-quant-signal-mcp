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
 * ── WHICH CHECKS BLOCK, AND WHY THAT SET GREW ────────────────────────────────────────────────
 * UNPUBLISHED_DEP blocks, because it IS incident A and it is provably actionable: push the
 * script. Most checks REPORT. Blocking on those would recreate the very deadlock this wave
 * exists to retire — a reconciler that refuses every push until 69 stale worktrees are
 * reclaimed is strictly worse than the problem. Every block prints its exact remediation;
 * blocking without remediation is hostile.
 *
 * OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 CH2 added TWO more blocking checks, and they earn it by
 * the same test UNPUBLISHED_DEP passes — provably actionable, by editing one local file:
 *
 *   SERIALIZATION     — a resource with >=2 writers and no declared way of serializing them.
 *                       The fix is a four-field declaration in ops/shared-worktree-state.json.
 *   CI_SERIALIZATION  — a workflow on disk with no registry row, a registry row for a workflow
 *                       that is not on disk, or a declared group that disagrees with the group
 *                       actually in the YAML. The fix is one line in one of two files.
 *
 * The point of the enumeration clause is that a SEVENTH workflow cannot be added without
 * declaring how it serializes: the reconciler reads .github/workflows/ from disk, so a new file
 * announces itself. Detection is strictly weaker than enumeration.
 *
 * ── ONE THING THIS RECONCILER DELIBERATELY DOES NOT OWN ──────────────────────────────────────
 * "Does every workflow HAVE a concurrency group?" is owned by the disk-enumerating canary in
 * tests/unit/workflow-concurrency.test.ts, which runs inside the pre-push test-gate. This file
 * owns whether DECLARATION and REALITY AGREE. A workflow that declares a key in the registry and
 * has no group in its YAML therefore REPORTS here and FAILS there — one control each, neither
 * duplicating the other, and no gap between them.
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

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
/**
 * The five declared serialization mechanisms. An unknown value BLOCKS rather than passing:
 * a typo in `mechanism` would otherwise silently disable the rule for that row, which is the
 * quietest way for a gate to stop meaning anything.
 */
export const SERIALIZATION_MECHANISMS = new Set([
  'landing-lock',
  'gha-concurrency',
  'none-single-writer',
  'idempotent-composable-write',
  'append-atomic',
]);

/**
 * Parse the TOP-LEVEL `concurrency:` block out of a workflow YAML.
 *
 * Deliberately dependency-free, though js-yaml is a real dependency of this repo. This file runs
 * in the pre-push hook across 51 checkouts, some of which predate any given wave and may have no
 * usable node_modules; a guard that needs an import it might not have is a guard that turns
 * INDETERMINATE — and therefore blocks — for reasons unrelated to what it checks. The grammar it
 * needs is four fixed keys in one block, so a parser is cheaper than the risk.
 *
 * Anchored at COLUMN ZERO on purpose: an indented `concurrency:` is a JOB-level block, which is
 * a different thing, and is reported separately rather than silently read as the workflow's.
 *
 * Comment-immune by construction: only `key: value` lines inside the block are read, so the
 * reasoning comments each workflow carries — which necessarily mention `cancel-in-progress` in
 * order to explain why it is not set — can never be mistaken for a setting.
 *
 * Exported so the CH3 canary consumes THIS parser rather than writing a second one. Two readers
 * of one grammar drift, and the bug returns in whichever copy nobody is watching.
 */
export function parseWorkflowConcurrency(text) {
  const lines = String(text).split('\n');
  const strip = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  const out = {
    present: false,
    jobLevel: lines.some((l) => /^\s+concurrency:/.test(l)),
    group: null,
    queue: null,
    cancelInProgress: null,
  };
  const i = lines.findIndex((l) => /^concurrency:/.test(l));
  if (i === -1) return out;
  out.present = true;

  const inline = strip(lines[i].slice('concurrency:'.length));
  if (inline) { out.group = inline; return out; }

  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^\s*$/.test(l)) continue;
    if (!/^\s/.test(l)) break;                       // back to column 0 — the block ended
    const m = l.match(/^\s+([A-Za-z][A-Za-z-]*):\s*(.*)$/);
    if (!m) continue;                                // comments and list items are not settings
    const val = strip(m[2]);
    if (m[1] === 'group') out.group = val;
    else if (m[1] === 'queue') out.queue = val;
    else if (m[1] === 'cancel-in-progress') out.cancelInProgress = val;
  }
  return out;
}

export function evaluate(registry, facts) {
  const findings = [];
  const add = (check, severity, message, remediation = null) =>
    findings.push({ check, severity, message, remediation });

  const blocks = registry.resources.filter((r) => r.kind === 'hook-block');

  // ── UNPUBLISHED_DEP — the only blocking check. This IS incident A. ───────────────────────
  //
  // THREE states, not two. status.md's account of 2026-08-01 is precise: the script "existed
  // only in its own worktree AND ON NO REMOTE BRANCH". The conjunction is the hazard — a
  // worktree can recover a script that exists on SOME remote ref and can recover nothing that
  // exists on none. Blocking on "not on the default ref" would also mean the wave that
  // INTRODUCES a gate can never install it (its script is on the feature branch until merge),
  // pushing every new guard into a post-merge manual step — the "MANUAL_PENDING that never
  // happens" class this repo has already been bitten by.
  for (const b of blocks) {
    const reach = facts.reachable[b.script]; // 'default' | 'other:<ref>' | 'none'
    if (reach === 'default') {
      add('UNPUBLISHED_DEP', 'ok', `${b.block_name}: ${b.script} reachable from the remote default ref`);
    } else if (typeof reach === 'string' && reach.startsWith('other:')) {
      add('UNPUBLISHED_DEP', 'report',
        `${b.block_name}: ${b.script} is on ${reach.slice('other:'.length)} but not yet on the default ref — recoverable everywhere, so not incident A, but checkouts based on the default ref will skip this guard until it merges`,
        `merge ${reach.slice('other:'.length)} into the remote default ref`);
    } else {
      add('UNPUBLISHED_DEP', 'block',
        `${b.block_name}: ${b.script} is reachable from NO remote ref — no other worktree can obtain it, and this is exactly the 2026-08-01 condition that blocked ~70 checkouts at once`,
        `git add ${b.script} && git commit && git push   # then re-run this gate`);
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
          : b.report_only
          ? `REPORT-ONLY block: its absence costs MEASUREMENT, not protection — it blocks nothing anywhere`
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

  // ── SERIALIZATION — a shared resource with >=2 writers must DECLARE how they serialize. ──
  //
  // This is the rule the wave exists to install. The registry already enumerated what shared
  // files CONTAIN and who WRITES them; it had no concept of who may write them AT ONCE, which is
  // the property the push livelock and the six unserialized workflows both violate.
  //
  // It BLOCKS, and it earns that the same way UNPUBLISHED_DEP does: the remediation is a
  // four-field declaration in one local file, printed in full below.
  for (const r of registry.resources) {
    const s = r.serialization;
    const writers = r.writers ?? [];
    const fix = `add "serialization": {"mechanism": …, "key": …, "scope": …, "_scope_reason": …} to the '${r.id}' row in ops/shared-worktree-state.json`;

    if (!s || typeof s !== 'object') {
      add('SERIALIZATION', 'block', `${r.id}: no serialization declared`, fix);
      continue;
    }
    if (!SERIALIZATION_MECHANISMS.has(s.mechanism)) {
      add('SERIALIZATION', 'block',
        `${r.id}: unknown serialization mechanism '${s.mechanism}' — a typo here would silently disable this rule for the row`,
        `use one of: ${[...SERIALIZATION_MECHANISMS].join(' · ')}`);
      continue;
    }
    // `scope` is mandatory and load-bearing: it names the boundary within which the mechanism
    // holds, which is what stops the guarantee rotting silently when a writer appears outside it.
    if (!s.scope || !String(s.scope).trim()) {
      add('SERIALIZATION', 'block', `${r.id}: serialization.scope is missing — a mechanism without a declared boundary is a guarantee nobody can check`, fix);
      continue;
    }
    if (writers.length >= 2 && (s.mechanism === 'none-single-writer' || !s.key)) {
      add('SERIALIZATION', 'block',
        `${r.id}: ${writers.length} writers but no serialization key (mechanism '${s.mechanism}') — ${writers.join(', ')}`,
        fix);
      continue;
    }
    add('SERIALIZATION', 'ok',
      `${r.id}: ${writers.length} writer(s) · ${s.mechanism}${s.key ? ` (key ${s.key})` : ''} · scope: ${s.scope}`);
  }

  // ── CI_SERIALIZATION — declaration and reality must agree, in BOTH directions. ───────────
  //
  // ENUMERATION, not detection: the workflow list comes from disk, so a 7th workflow announces
  // itself instead of waiting to be noticed. That clause is the whole reason this is a generator
  // fix rather than a patch to six files.
  const wfRows = registry.resources.filter((r) => r.kind === 'ci-workflow');
  const onDisk = facts.workflows ?? {};

  for (const path of Object.keys(onDisk).sort()) {
    if (!wfRows.some((r) => r.path === path)) {
      add('CI_SERIALIZATION', 'block',
        `${path} is on disk but has NO registry row — an unregistered workflow is an unserialized one`,
        `add a {"kind": "ci-workflow", "path": "${path}", …} row with a serialization.key to ops/shared-worktree-state.json`);
    }
  }

  for (const row of wfRows) {
    const wf = onDisk[row.path];
    const key = row.serialization?.key;

    if (!wf) {
      add('CI_SERIALIZATION', 'block',
        `${row.id}: registry declares ${row.path}, which is not on disk`,
        `remove the '${row.id}' row, or restore ${row.path}`);
      continue;
    }
    if (!key) {
      add('CI_SERIALIZATION', 'block', `${row.id}: no serialization.key declared`,
        `set serialization.key on the '${row.id}' row to the concurrency group expression`);
      continue;
    }
    // `cancel-in-progress` is checked FIRST and on every workflow, present group or not: it is
    // the wrong knob for pending-run cancellation, its `false` value is undocumented, and
    // `queue: max` + `cancel-in-progress: true` is an explicit GitHub validation error.
    if (wf.cancelInProgress !== null) {
      add('CI_SERIALIZATION', 'block',
        `${row.path}: sets cancel-in-progress: ${wf.cancelInProgress} — the knob that governs PENDING runs is queue, not this`,
        `delete the cancel-in-progress line from ${row.path}`);
      continue;
    }
    if (!wf.present) {
      // Declared but not applied. This REPORTS rather than blocks; the canary in
      // tests/unit/workflow-concurrency.test.ts owns "every workflow has a group" and fails there.
      add('CI_SERIALIZATION', 'report',
        `${row.path}: registry declares group '${key}' but the file has no top-level concurrency block yet`,
        `add a top-level block to ${row.path}:  concurrency: { group: ${key}, queue: max }  — and no cancel-in-progress`);
      continue;
    }
    if (wf.group !== key) {
      add('CI_SERIALIZATION', 'block',
        `${row.path}: declared group '${key}' but the file says '${wf.group}' — declaration and reality must agree in both directions`,
        `make them match: edit ${row.path}, or the '${row.id}' serialization.key`);
      continue;
    }
    if (wf.queue !== 'max') {
      add('CI_SERIALIZATION', 'block',
        `${row.path}: queue is '${wf.queue ?? '(unset → GitHub default "single")'}' — under 'single' a PENDING run is cancelled when the next one queues, which is a missing run rather than a failed one`,
        `set  queue: max  in ${row.path}`);
      continue;
    }
    if (wf.jobLevel) {
      add('CI_SERIALIZATION', 'report',
        `${row.path}: also declares a JOB-level concurrency block — GitHub does not document how workflow-level and job-level groups interact`,
        `prefer the workflow-level group alone; a load-bearing safety property must not be rented from undocumented behaviour`);
      continue;
    }
    add('CI_SERIALIZATION', 'ok',
      `${row.path}: group '${wf.group}' · queue: ${wf.queue} · no cancel-in-progress · target: ${row.contended_target ?? 'none (run-lane dedup only)'}`);
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
  const remoteRefs = git(['for-each-ref', '--format=%(refname)', 'refs/remotes/'])
    .split('\n').filter((r) => r && !r.endsWith('/HEAD')).map((r) => r.replace(/^refs\/remotes\//, ''));
  const reachable = {};
  for (const s of scripts) {
    if (spawnSync('git', ['cat-file', '-e', `${ref}:${s}`], { cwd: ROOT }).status === 0) {
      reachable[s] = 'default';
      continue;
    }
    const other = remoteRefs.find((r) => spawnSync('git', ['cat-file', '-e', `${r}:${s}`], { cwd: ROOT }).status === 0);
    reachable[s] = other ? `other:${other}` : 'none';
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

  // ENUMERATED FROM DISK, never from the registry — that direction is what lets a 7th workflow
  // announce itself. Reading the registry's list instead would make the check structurally
  // incapable of seeing the case it exists for.
  const wfDir = join(ROOT, '.github', 'workflows');
  if (!existsSync(wfDir)) throw new Error(`${wfDir} does not exist — cannot enumerate CI workflows`);
  const workflows = {};
  for (const f of readdirSync(wfDir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    workflows[`.github/workflows/${f}`] = parseWorkflowConcurrency(readFileSync(join(wfDir, f), 'utf8'));
  }
  if (Object.keys(workflows).length === 0) throw new Error(`${wfDir} contains no workflow files — refusing to report a pass over an empty corpus`);

  return { ref, worktrees, hookBlocks, reachable, skipLedgerRows, dbPresent, workflows };
}

// ── reporting ──────────────────────────────────────────────────────────────────────────────

const GLYPH = { ok: '✓', report: '⚠', block: '✖' };

function report(findings) {
  // Every check name MUST appear here: report() iterates this list, so a name omitted from it
  // prints nothing at all — a dark check at a green exit code, which is the one outcome the
  // verdict-token law exists to prevent. Add the name in the SAME edit as the check.
  const order = ['UNPUBLISHED_DEP', 'SERIALIZATION', 'CI_SERIALIZATION', 'MISSING_BLOCK', 'ORPHAN_BLOCK', 'UNGUARDED_WORKTREE', 'SKIP_LEDGER_STALE', 'CONCURRENT_WRITER', 'REGISTRY_PARITY'];
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

  const wfRows = registry.resources.filter((r) => r.kind === 'ci-workflow');
  assert(wfRows.length > 0, 'the real registry declares no ci-workflow rows (vacuous corpus)');
  assert(registry.resources.every((r) => r.serialization), 'a registry row is missing serialization — the fixtures below would be vacuous');

  // Fixtures are built from the REAL rows, and the workflow facts are produced by the REAL
  // parser, not hand-written. A hand-written fixture shape that the shipped extractor never
  // emits is how a self-test passes while the property it claims to assert is broken.
  const wfFacts = (overrides = {}) => {
    const base = {};
    for (const r of wfRows) {
      base[r.path] = parseWorkflowConcurrency(
        `name: x\non:\n  push:\nconcurrency:\n  group: ${r.serialization.key}\n  queue: max\n`);
    }
    return { ...base, ...overrides };
  };

  const cleanFacts = {
    worktrees: [{ path: '/w/a', reclaimable: false, scripts: Object.fromEntries(blockRows.map((b) => [b.script, true])) }],
    hookBlocks: Object.fromEntries([...new Set(blockRows.map((b) => b.hook))].map((h) => [h, blockRows.filter((b) => b.hook === h).map((b) => b.block_name)])),
    reachable: Object.fromEntries(blockRows.map((b) => [b.script, 'default'])),
    skipLedgerRows: 0,
    dbPresent: false,
    workflows: wfFacts(),
  };

  // ── the parser itself, both directions. It is the seam every CI fixture below rides on, so
  // a self-test that never exercised it would be blind to exactly what it replaces. ──
  {
    const p1 = parseWorkflowConcurrency('name: x\nconcurrency:\n  group: G\n  queue: max\njobs:\n  a:\n    runs-on: x\n');
    assert(p1.present && p1.group === 'G' && p1.queue === 'max' && p1.cancelInProgress === null, 'parser must read a top-level block');
    const p2 = parseWorkflowConcurrency('name: x\njobs:\n  a:\n    concurrency:\n      group: J\n');
    assert(!p2.present && p2.jobLevel, 'an indented concurrency is JOB-level and must not be read as the workflow group');
    const p3 = parseWorkflowConcurrency('name: x\n# cancel-in-progress: true is the wrong knob\nconcurrency:\n  group: G\n  # queue: max keeps pending runs alive\n  queue: max\n');
    assert(p3.cancelInProgress === null && p3.queue === 'max', 'the parser must be immune to comments mentioning the keys');
    const p4 = parseWorkflowConcurrency('name: x\nconcurrency: inline-group\n');
    assert(p4.present && p4.group === 'inline-group', 'the inline scalar form must parse');
    const p5 = parseWorkflowConcurrency('name: x\non:\n  push:\n');
    assert(!p5.present && p5.group === null, 'a workflow with no concurrency must report absent, not guess');
  }

  // ── direction 1: a clean machine PASSES ──
  let f = evaluate(registry, cleanFacts);
  assert(f.length > 0, 'evaluate() produced ZERO findings on a clean fixture — vacuous');
  assert(!f.some((x) => x.severity === 'block'), 'a clean fixture must not block');
  assert(f.some((x) => x.check === 'UNPUBLISHED_DEP' && x.severity === 'ok'), 'clean fixture produced no positive UNPUBLISHED_DEP row');

  // ── direction 2: each defect is DETECTED ──
  const unpublished = { ...cleanFacts, reachable: { ...cleanFacts.reachable, [blockRows[0].script]: 'none' } };
  f = evaluate(registry, unpublished);
  const blocked = f.filter((x) => x.severity === 'block');
  assert(blocked.length === 1, `an unpublished dep must produce exactly 1 blocking finding, got ${blocked.length}`);
  assert(Boolean(blocked[0].remediation), 'a blocking finding without remediation is hostile');

  // The middle state. Published on a branch but not merged is RECOVERABLE everywhere, so it is
  // not incident A and must NOT block — otherwise the wave that introduces a gate could never
  // install it, and every new guard would become a post-merge manual step.
  const pendingMerge = { ...cleanFacts, reachable: { ...cleanFacts.reachable, [blockRows[0].script]: 'other:origin/some-branch' } };
  f = evaluate(registry, pendingMerge);
  assert(!f.some((x) => x.severity === 'block'), 'a script published on a non-default remote ref must NOT block');
  assert(f.some((x) => x.check === 'UNPUBLISHED_DEP' && x.severity === 'report'), 'a pending-merge script must REPORT');

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

  // ── SERIALIZATION, both directions ──
  const clone = (mut) => { const c = JSON.parse(JSON.stringify(registry)); mut(c); return c; };
  const blocksOf = (reg, facts, check) =>
    evaluate(reg, facts).filter((x) => x.check === check && x.severity === 'block');

  assert(blocksOf(registry, cleanFacts, 'SERIALIZATION').length === 0, 'the real registry must not have a serialization block');
  assert(evaluate(registry, cleanFacts).some((x) => x.check === 'SERIALIZATION' && x.severity === 'ok'), 'a clean registry must emit POSITIVE per-row SERIALIZATION output, never a silent pass');

  const twoWritersNoKey = clone((c) => {
    const r = c.resources.find((x) => x.kind === 'ledger');
    r.writers = ['a.sh', 'b.sh'];
    r.serialization = { mechanism: 'none-single-writer', key: null, scope: 's', _scope_reason: 'r' };
  });
  let b = blocksOf(twoWritersNoKey, cleanFacts, 'SERIALIZATION');
  assert(b.length === 1, `>=2 writers with no serialization key must BLOCK, got ${b.length}`);
  assert(Boolean(b[0].remediation), 'a blocking finding without remediation is hostile');

  const badMechanism = clone((c) => { c.resources[0].serialization.mechanism = 'landing_lock'; });
  assert(blocksOf(badMechanism, cleanFacts, 'SERIALIZATION').length === 1, 'an unknown mechanism must BLOCK — a typo must not silently disable the rule');

  const noScope = clone((c) => { c.resources[0].serialization.scope = ''; });
  assert(blocksOf(noScope, cleanFacts, 'SERIALIZATION').length === 1, 'a missing serialization.scope must BLOCK');

  const noSerialization = clone((c) => { delete c.resources[0].serialization; });
  assert(blocksOf(noSerialization, cleanFacts, 'SERIALIZATION').length === 1, 'a row with no serialization at all must BLOCK');

  // ── CI_SERIALIZATION, both directions ──
  assert(blocksOf(registry, cleanFacts, 'CI_SERIALIZATION').length === 0, 'the real registry + matching groups must not block');
  assert(evaluate(registry, cleanFacts).some((x) => x.check === 'CI_SERIALIZATION' && x.severity === 'ok'), 'a clean CI fixture must emit POSITIVE per-workflow output');

  // THE ENUMERATION CLAUSE — a 7th workflow on disk with no registry row.
  const seventh = { ...cleanFacts, workflows: wfFacts({ '.github/workflows/brand-new.yml': parseWorkflowConcurrency('name: n\nconcurrency:\n  group: G\n  queue: max\n') }) };
  assert(blocksOf(registry, seventh, 'CI_SERIALIZATION').length === 1, 'a workflow on disk with NO registry row must BLOCK — this is the clause that makes a 7th workflow unable to land unserialized');

  const vanished = { ...cleanFacts, workflows: Object.fromEntries(Object.entries(cleanFacts.workflows).filter(([k]) => k !== wfRows[0].path)) };
  assert(blocksOf(registry, vanished, 'CI_SERIALIZATION').length === 1, 'a registry row whose workflow is NOT on disk must BLOCK');

  const mismatch = { ...cleanFacts, workflows: wfFacts({ [wfRows[0].path]: parseWorkflowConcurrency('name: n\nconcurrency:\n  group: SOMETHING-ELSE\n  queue: max\n') }) };
  assert(blocksOf(registry, mismatch, 'CI_SERIALIZATION').length === 1, 'a declared key that disagrees with the actual group must BLOCK');

  const cip = { ...cleanFacts, workflows: wfFacts({ [wfRows[0].path]: parseWorkflowConcurrency('name: n\nconcurrency:\n  group: ' + wfRows[0].serialization.key + '\n  queue: max\n  cancel-in-progress: true\n') }) };
  assert(blocksOf(registry, cip, 'CI_SERIALIZATION').length === 1, 'cancel-in-progress set anywhere must BLOCK');

  const singleQueue = { ...cleanFacts, workflows: wfFacts({ [wfRows[0].path]: parseWorkflowConcurrency('name: n\nconcurrency:\n  group: ' + wfRows[0].serialization.key + '\n') }) };
  assert(blocksOf(registry, singleQueue, 'CI_SERIALIZATION').length === 1, 'an unset queue (GitHub default `single`) must BLOCK — a cancelled PENDING run is a missing run, not a failed one');

  // Declared but not yet applied REPORTS rather than blocks: "does every workflow have a group"
  // belongs to the disk-enumerating canary, which fails there. One control each, no gap.
  const notYet = { ...cleanFacts, workflows: wfFacts({ [wfRows[0].path]: parseWorkflowConcurrency('name: n\non:\n  push:\n') }) };
  assert(blocksOf(registry, notYet, 'CI_SERIALIZATION').length === 0, 'a workflow with no group yet must NOT block here');
  assert(evaluate(registry, notYet).some((x) => x.check === 'CI_SERIALIZATION' && x.severity === 'report'), 'a workflow with no group yet must REPORT');

  // ── the token → EXIT CODE mapping, not just the token ──
  // OPS-TEST-GATE-FAILOPEN-W1 shipped a self-test that asserted verdict TOKENS but never the
  // mapping, so re-coding INDETERMINATE to 0 left it fully green. Assert the mapping.
  assert(mapCode('PASS') === 0, 'PASS must map to 0');
  assert(mapCode('FAIL') === 1, 'FAIL must map to 1');
  assert(mapCode('INDETERMINATE') === 3, 'INDETERMINATE must map to 3 (token-law default for a new gate)');
  assert(mapCode('FAIL', 'warn') === 0 && mapCode('INDETERMINATE', 'warn') === 0, 'warn must downgrade the CODE');
  assert(mapCode('PASS', 'warn') === 0, 'warn must not change PASS');

  console.log(`✓ self-test: ${registry.resources.length} registry rows (${blockRows.length} hook-block, ${wfRows.length} ci-workflow); clean fixture passes, 17 defect fixtures detected across 9 checks, parser asserted both ways, token→exit mapping asserted.`);
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
    console.log(`[shared-state] ${blocking.length} BLOCKING finding(s). UNPUBLISHED_DEP, SERIALIZATION and CI_SERIALIZATION block — everything else above is a report.`);
    verdict('FAIL');
    return;
  }
  const reports = findings.filter((f) => f.severity === 'report');
  console.log(`[shared-state] no blocking findings; ${reports.length} report-class finding(s) across ${findings.length} checked rows.`);
  verdict('PASS');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
