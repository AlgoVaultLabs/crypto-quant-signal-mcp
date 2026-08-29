#!/usr/bin/env node
/**
 * check-cron-interlock-coverage.mjs — OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1.
 *
 * A CRON THAT A DEPLOY CAN DECAPITATE CANNOT EXIST UNREGISTERED, BECAUSE THE CORPUS THAT DECIDES
 * "CAN BE DECAPITATED" IS DERIVED FROM THE SCRIPT'S OWN TEXT — NOT FROM WHO REMEMBERED TO LIST IT.
 *
 * ── THE BUG CLASS THIS RETIRES ──────────────────────────────────────────────────────────────
 * `deploy.yml` runs `docker compose up -d --build --force-recreate`. Everything executing inside
 * one of those containers via `docker exec` dies at that moment. Until this wave exactly ONE job
 * was protected — the carry labeler — by a pattern hardcoded inside the interlock script. So
 * every new long `docker exec` cron was unprotected BY DEFAULT, and nothing anywhere went red.
 *
 * That default is what produced the "18:00–02:59 UTC deploy-free window" folklore: a real
 * measurement whose SCOPE was narrower than its APPLICATION, carried in an agent-side memory file
 * rather than in either of the estate's two declared rule sources. You do not delete a measured
 * finding — you make it unnecessary. `ops/scripts/cron-interlock-registry.json` is where the
 * finding now lives as data, and this gate is what keeps it complete.
 *
 * ── SECOND APPLICATION OF A PROVEN SHAPE, NOT A NEW CONVENTION ──────────────────────────────
 * `check-declaration-coverage.mjs` already asserts "every file with a reader is declared". This
 * asserts "every cron that `docker exec`s is registered". Same `evaluate()`/`emit()` split, same
 * vacuity-guard placement, same fixture-tree self-test with a block of assertions against the
 * REAL tree that the fixture seam bypasses. `stripComments` is imported rather than reimplemented
 * — a second copy of "what counts as a mention" is the duplicated-fact drift this repo forbids.
 *
 * ── A MENTION IS NOT AN INVOCATION ──────────────────────────────────────────────────────────
 * Two files in `ops/cron/` contain the literal string `docker exec` and invoke neither: one in a
 * `#` comment recording a RETIRED implementation, one inside an alert-body heredoc ("... host
 * dist/ unusable AND docker exec failed ..."). A bare substring match reports both as candidates
 * and the registry grows two rows for jobs that do not exist. So comments are stripped AND the
 * match requires COMMAND POSITION — start of line, after a `;`/`&`/`|`, inside `$( )`, or after
 * `exec`. That is the same lesson `check-canaries-wired.mjs` carries for comments and
 * `check-test-budget.mjs` carries for string literals, in a third substrate.
 *
 * ── HOST SCOPING (OPS-HOST-AUTO-REBOOT-W1) ──────────────────────────────────────────────────
 * Every registry row now declares its `host`, because the DISRUPTION EVENT differs per host and so
 * does the enumeration that finds it: signal-1's event is `docker compose --force-recreate` (a
 * `docker exec` question), aoe-1's is a REBOOT (strictly larger — every container, every host
 * process, every in-flight Prefect run). A row consulted for the wrong host is a guard reading a
 * green light for a road it is not on.
 *
 * So this gate checks EVERY declared host by default, and `--host <label>` narrows to one. Two
 * things are checked per host and they are deliberately different:
 *   · the REPO-SIDE CORPUS check (`ops/cron/*.sh` must each have a row) applies only to the host
 *     that owns that tree — signal-1. For a host whose rows are all `source: host-only` there is
 *     no repo corpus, and saying so with a positive line is the honest answer, NOT a vacuity
 *     INDETERMINATE. "Empty input is only vacuity when YOU were supposed to fill it."
 *   · the ROW-USABILITY check (known class, non-empty reason) applies to every row of every host.
 *
 * It also asserts `_residual_no_safe_kill[host]` MATCHES that host's actual rows. That block is
 * what OPS-HOST-AUTO-REBOOT-W1's reboot gate and the deploy-free-window ruling both read; if a
 * later wave reclassifies the last no-safe-kill row without updating it, a control would keep
 * being justified by a row that no longer says so.
 *
 * ── DECLARED LIMITATION, STATED RATHER THAN HIDDEN ──────────────────────────────────────────
 * A BUILD-TIME GATE CANNOT SEE HOST-ONLY CRONS. Anything installed straight to
 * /opt/algovault-monitoring or written inline in a crontab is invisible here, however long it
 * runs. Those are covered by registry rows carrying `source: "host-only"` plus the
 * `re_derivation_command` that regenerates them, so the gap is DECLARED rather than rediscovered
 * by the next incident. Closing it needs a host-side reconciler that walks the live crontab:
 * OPS-CRON-INTERLOCK-HOST-CANARY-W1. It is deliberately NOT built here — a canary shipped in the
 * same wave as the registry it polices has no independent corpus to police.
 *
 * Verdict contract: exactly one terminal CRON_INTERLOCK_COVERAGE_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a new gate).
 * Callers gate on the TOKEN, never the code.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './check-alert-recommended-wave.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** Where the committed cron wrappers live. The only tree a build-time gate can see. */
export const CRON_DIR = 'ops/cron';
/** The declared protected set, beside its only consumer. */
export const REGISTRY_REL = 'ops/scripts/cron-interlock-registry.json';
/** The three classes a row may declare. Anything else is an unusable row. */
export const VALID_CLASSES = new Set(['safe-to-kill', 'preempt-and-catchup', 'no-safe-kill']);
/**
 * The ONE host whose scheduled work is committed as `ops/cron/*.sh`. Any other host's rows are
 * `source: host-only` and have no repo-side corpus for the candidate check to compare against.
 */
export const REPO_CRON_HOST = 'signal-1';

/**
 * `docker exec` in COMMAND POSITION — start of line, after a command separator, inside a `$( )`,
 * or after `exec`. Never mid-sentence, which is how the two prose mentions in ops/cron/ read.
 */
export const DOCKER_EXEC_RE = /(^|[;&|]|\$\(|\bexec\s)\s*(sudo\s+)?docker\s+exec\b/m;

/** Every committed cron wrapper, whether or not it execs. */
export function cronFiles(root) {
  const dir = path.join(root, CRON_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sh'))
    .sort()
    .map((n) => ({ name: n, rel: `${CRON_DIR}/${n}`, abs: path.join(dir, n) }));
}

/** Those that actually invoke `docker exec` — the set that needs a registry row. */
export function cronCandidates(root) {
  return cronFiles(root).filter((f) => {
    let text = '';
    try { text = readFileSync(f.abs, 'utf8'); } catch { return false; }
    return DOCKER_EXEC_RE.test(stripComments(text));
  });
}

/**
 * The registry, or null when it cannot be read or parsed. Null is INDETERMINATE at the caller —
 * never "nothing is registered", which would silently pass a tree with no protection at all.
 */
export function loadRegistry(root) {
  const p = path.join(root, REGISTRY_REL);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (!doc || !Array.isArray(doc.rows)) return null;
    return doc;
  } catch { return null; }
}

/** Every host the registry declares a row for, in declaration order. */
export function declaredHosts(doc) {
  const seen = [];
  for (const r of doc.rows || []) {
    const h = r && typeof r.host === 'string' ? r.host.trim() : '';
    if (h && !seen.includes(h)) seen.push(h);
  }
  return seen;
}

/**
 * The whole decision, as data. Separated from I/O so the self-test can drive it against a fixture
 * tree — and so a caller can see WHY, not only WHAT.
 */
export function evaluate(root, host = REPO_CRON_HOST) {
  const files = cronFiles(root);
  const doc = loadRegistry(root);

  // ── VACUITY GUARD 1 — the glob broke, which is not "the tree is clean". ────────────────────
  if (files.length === 0) {
    return { verdict: 'INDETERMINATE', host, reason: `no ${CRON_DIR}/*.sh found — the glob is broken, not the tree` };
  }
  // ── VACUITY GUARD 2 — no registry at all. ─────────────────────────────────────────────────
  if (doc === null) {
    return { verdict: 'INDETERMINATE', host, reason: `${REGISTRY_REL} is missing or unparseable — never "nothing is registered"` };
  }
  // A registry WE author is a CONSTRUCTED corpus, so an empty declaration is vacuity and refuses.
  if (doc.rows.length === 0) {
    return { verdict: 'INDETERMINATE', host, reason: `${REGISTRY_REL} declares zero rows — we build this corpus, so empty means it was not built` };
  }

  // ── VACUITY GUARD 4 — an unknown host, or a host with no rows. ─────────────────────────────
  // A consumer asking about a host the registry has never heard of must get INDETERMINATE, never
  // a PASS over an empty selection — that is precisely how a gate ends up certifying a host it
  // cannot see. Same reasoning as GUARD 2 one level down.
  const hostRows = doc.rows.filter((r) => r && r.host === host);
  if (hostRows.length === 0) {
    return {
      verdict: 'INDETERMINATE', host,
      reason: `no registry row declares host "${host}" (declared: ${declaredHosts(doc).join(', ') || '— none —'}) `
        + '— an unknown host is never an empty PASS',
    };
  }
  // ── VACUITY GUARD 5 — the per-host blocks the CONSUMERS read must exist for this host. ─────
  for (const block of ['_enumeration', '_residual_no_safe_kill']) {
    if (!doc[block] || typeof doc[block][host] !== 'object' || doc[block][host] === null) {
      return { verdict: 'INDETERMINATE', host, reason: `${block} declares no block for host "${host}" — the reboot gate and the deploy-free-window ruling both read it` };
    }
  }

  // ── the repo-side corpus check — signal-1 only, and that is a FACT, not a gap. ─────────────
  // `ops/cron/*.sh` is signal-1's committed cron tree. A host whose rows are all `source:
  // host-only` has no repo corpus here, so reporting that positively is the honest answer;
  // "empty input is only vacuity when YOU were supposed to fill it."
  const ownsRepoCron = host === REPO_CRON_HOST;
  const candidates = ownsRepoCron ? cronCandidates(root) : [];
  // ── VACUITY GUARD 3 — wrappers exist and NOT ONE execs, so the matcher stopped working. ────
  // Deliberately "for ANY file", not "for each file": a single non-exec'ing wrapper is a real and
  // ordinary state, while ZERO matches across the whole tree can only mean the matcher broke.
  if (ownsRepoCron && candidates.length === 0) {
    return { verdict: 'INDETERMINATE', host, reason: `not one of ${files.length} ${CRON_DIR}/*.sh matched a command-position \`docker exec\` — the matcher is broken, not the tree` };
  }

  const byScript = new Map();
  for (const r of hostRows) if (r && typeof r.script === 'string') byScript.set(r.script, r);
  const unregistered = candidates.filter((c) => !byScript.has(c.rel)).map((c) => c.rel);

  // Every row of this host is checked, not just the ones a cron wrapper points at: a host-only row
  // with an empty reason is exactly as unusable as a repo one, and the consumers read them both.
  // A row with NO `host` is invisible to every per-host selection, so deleting the field would
  // silently drop a job from every check — the exact silent-exclusion this gate exists to prevent.
  // It is therefore reported against EVERY host, so no selection can miss it.
  const hostless = doc.rows
    .map((r, i) => (r && typeof r.host === 'string' && r.host.trim() ? null
      : { id: (r && r.id) || `<row ${i}>`, why: 'declares no `host` — it would be invisible to every per-host consumer' }))
    .filter(Boolean);

  const unusable = hostless.concat(hostRows.map((r, i) => {
    const id = (r && typeof r.id === 'string' && r.id.trim()) || `<row ${i}>`;
    const cls = (r && typeof r.class === 'string' && r.class.trim()) || '';
    const reason = (r && typeof r.reason === 'string' && r.reason.trim()) || '';
    if (!VALID_CLASSES.has(cls)) return { id, why: `class ${cls ? `"${cls}"` : '<missing>'} is not one of ${[...VALID_CLASSES].join(' | ')}` };
    if (!reason) return { id, why: 'reason is missing or empty — INDETERMINATE, never a silent safe-to-kill' };
    return null;
  }).filter(Boolean));

  // ── the ruling must match its evidence ────────────────────────────────────────────────────
  // `_residual_no_safe_kill[host]` is what kernel-auto-reboot.sh's third gate and the 18:00-02:59
  // deploy-free-window ruling both cite. A reclassification that leaves it behind would keep a
  // live control justified by a row that no longer says so.
  const actualNsk = hostRows.filter((r) => r.class === 'no-safe-kill').map((r) => r.id).sort();
  const declared = doc._residual_no_safe_kill[host];
  const declaredIds = Array.isArray(declared.ids) ? [...declared.ids].sort() : null;
  const rulingDrift = [];
  if (declared.count !== actualNsk.length) {
    rulingDrift.push(`_residual_no_safe_kill["${host}"].count = ${declared.count} but ${actualNsk.length} row(s) are class no-safe-kill`);
  }
  if (declaredIds === null || declaredIds.join('|') !== actualNsk.join('|')) {
    rulingDrift.push(`_residual_no_safe_kill["${host}"].ids = [${declaredIds ? declaredIds.join(', ') : '<not an array>'}] but the rows say [${actualNsk.join(', ')}]`);
  }

  return {
    verdict: unregistered.length || unusable.length || rulingDrift.length ? 'FAIL' : 'PASS',
    host,
    ownsRepoCron,
    files: files.map((f) => f.rel),
    candidates: candidates.map((c) => c.rel),
    rows: hostRows.length,
    classes: hostRows.reduce((a, r) => ({ ...a, [r.class]: (a[r.class] || 0) + 1 }), {}),
    unregistered,
    unusable,
    rulingDrift,
  };
}

function emit(r) {
  if (r.verdict === 'INDETERMINATE') {
    console.log(`cron-interlock-coverage [${r.host}]: INDETERMINATE — ${r.reason}`);
    return 3;
  }
  // POSITIVE PER-ITEM OUTPUT: a wrapper silently skipped must never read like one that passed.
  const cls = Object.entries(r.classes).map(([k, v]) => `${v} ${k}`).join(' · ');
  console.log(`cron-interlock-coverage [${r.host}]: ${r.rows} registry row(s) — ${cls}`);
  if (r.ownsRepoCron) {
    console.log(`  repo cron corpus: ${r.files.length} ${CRON_DIR}/*.sh, ${r.candidates.length} with a command-position \`docker exec\``);
    for (const f of r.files) {
      const isCandidate = r.candidates.includes(f);
      const glyph = !isCandidate ? '·' : (r.unregistered.includes(f) ? '✗' : '✓');
      const state = !isCandidate ? 'no docker exec' : (r.unregistered.includes(f) ? 'UNREGISTERED' : 'registered');
      console.log(`    ${glyph} ${f.padEnd(46)} ${state}`);
    }
  } else {
    console.log(`  repo cron corpus: none — ${CRON_DIR}/*.sh belongs to ${REPO_CRON_HOST}; every ${r.host} row is source: host-only.`);
    console.log('    That is a FACT about this host, not an unchecked gap: see the declared limitation below.');
  }
  console.log(`  residual no-safe-kill: ${r.rulingDrift.length ? 'DRIFTED' : 'matches the rows'}`);
  if (r.verdict === 'FAIL') {
    console.log('');
    for (const f of r.unregistered) {
      console.log(`  ✗ ${f} runs \`docker exec\` but has no row in ${REGISTRY_REL} for host ${r.host} —`);
      console.log('      add one with { id, host, script, container, process_pattern, class, reason, max_runtime_s, runtime_instrument, source, verified_at }.');
      console.log('      MEASURE max_runtime_s; do not estimate it, and record the instrument beside the number.');
    }
    for (const u of r.unusable) {
      console.log(`  ✗ registry row "${u.id}" is unusable: ${u.why}`);
    }
    for (const d of r.rulingDrift) console.log(`  ✗ ${d}`);
    return 1;
  }
  return 0;
}

/** Check every declared host (default) or just one. ONE terminal token over all of them. */
export function run(root, only = null) {
  const doc = loadRegistry(root);
  const hosts = only ? [only] : (doc ? declaredHosts(doc) : [REPO_CRON_HOST]);
  const codes = (hosts.length ? hosts : [REPO_CRON_HOST]).map((h) => emit(evaluate(root, h)));
  // Worst wins, and INDETERMINATE outranks FAIL: "we could not tell" must never be reported as
  // the weaker, more specific "we told, and it was wrong".
  const code = codes.includes(3) ? 3 : (codes.includes(1) ? 1 : 0);
  console.log('  (declared limitation: a build-time gate cannot see host-only crons — those carry source: "host-only"'
    + ' plus their re_derivation_command; the reconciler is OPS-CRON-INTERLOCK-HOST-CANARY-W1)');
  console.log(`CRON_INTERLOCK_COVERAGE_VERDICT=${code === 3 ? 'INDETERMINATE' : code === 1 ? 'FAIL' : 'PASS'}`);
  return code;
}


// ─────────────────────────────── self-test ───────────────────────────────

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function fixture(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'croncov-'));
  mkdirSync(path.join(root, CRON_DIR), { recursive: true });
  mkdirSync(path.join(root, 'ops/scripts'), { recursive: true });
  for (const [rel, body] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const row = (over = {}) => ({
  id: 'a', host: REPO_CRON_HOST, script: `${CRON_DIR}/a.sh`, container: 'ctr', process_pattern: 'p',
  class: 'safe-to-kill', reason: 'idempotent on next fire', max_runtime_s: 1,
  runtime_instrument: 'timed run', source: 'repo', verified_at: '2026-08-29', ...over,
});
/**
 * A fixture registry in the PER-HOST shape the real one uses. `_enumeration` and
 * `_residual_no_safe_kill` are derived from the rows here rather than hand-written, so a fixture
 * can never accidentally encode the ruling-drift the gate exists to catch — the drift cases below
 * inject it deliberately instead.
 */
const registry = (rows, over = {}) => {
  const hosts = [...new Set(rows.map((r) => r.host).filter(Boolean))];
  const doc = { schema_version: 1, rows, _enumeration: {}, _residual_no_safe_kill: {} };
  for (const h of hosts) {
    const nsk = rows.filter((r) => r.host === h && r.class === 'no-safe-kill').map((r) => r.id);
    doc._enumeration[h] = { host: h, command: 'fixture' };
    doc._residual_no_safe_kill[h] = { count: nsk.length, ids: nsk };
  }
  return JSON.stringify({ ...doc, ...over });
};

function selfTest() {
  let checks = 0; let fails = 0;
  const roots = [];
  const ck = (label, actual, expected) => {
    checks += 1;
    if (actual !== expected) { fails += 1; console.log(`  ✗ ${label}: got ${actual}, want ${expected}`); }
    else console.log(`  ✓ ${label}`);
  };
  const v = (spec, host) => { const root = fixture(spec); roots.push(root); return evaluate(root, host).verdict; };

  // ── the happy path, and the failure it exists to produce ────────────────────────────────
  ck('an exec\'ing wrapper WITH a row -> PASS', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'PASS');

  ck('an exec\'ing wrapper with NO row -> FAIL', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [`${CRON_DIR}/b.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node y.js\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'FAIL');

  ck('a wrapper that does NOT exec needs no row -> PASS', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [`${CRON_DIR}/plain.sh`]: '#!/usr/bin/env bash\ncurl -s https://example.test\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'PASS');

  // ── a mention is not an invocation, in BOTH of its real shapes ──────────────────────────
  ck('a `docker exec` in a # COMMENT is not an invocation', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [`${CRON_DIR}/prose.sh`]: '#!/usr/bin/env bash\n# this USED to run `docker exec ctr node old.js` and no longer does\ntrue\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'PASS');

  ck('a `docker exec` MID-SENTENCE in an alert body is not an invocation', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [`${CRON_DIR}/alert.sh`]: '#!/usr/bin/env bash\nBODY="Common causes: host dist/ unusable AND docker exec failed."\necho "$BODY"\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'PASS');

  // …and the COMMAND POSITIONS that must still be caught, or the exclusion above is a hole.
  for (const [label, line] of [
    ['start of line', 'docker exec ctr node x.js'],
    ['after `exec`', 'exec docker exec ctr node x.js'],
    ['inside $( )', 'OUT=$(docker exec ctr node x.js)'],
    ['after a pipe', 'true | docker exec ctr node x.js'],
    ['after a semicolon', 'true ; docker exec ctr node x.js'],
    ['via sudo', 'sudo docker exec ctr node x.js'],
  ]) {
    ck(`a REAL invocation ${label} still counts`, v({
      [`${CRON_DIR}/b.sh`]: `#!/usr/bin/env bash\n${line}\n`,
      [REGISTRY_REL]: registry([row()]),
    }), 'FAIL');
  }

  // ── the unusable-row rules ─────────────────────────────────────────────────────────────
  ck('an EMPTY reason -> FAIL (INDETERMINATE at the interlock, never a silent pass)', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row({ reason: '   ' })]),
  }), 'FAIL');

  ck('a MISSING reason -> FAIL', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([{ id: 'a', host: REPO_CRON_HOST, script: `${CRON_DIR}/a.sh`, class: 'safe-to-kill' }]),
  }), 'FAIL');

  ck('an UNKNOWN class -> FAIL', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row({ class: 'probably-fine' })]),
  }), 'FAIL');

  ck('a HOST-ONLY row is checked for a reason too', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row(), row({ id: 'h', script: 'crontab inline', source: 'host-only', reason: '' })]),
  }), 'FAIL');

  ck('all three classes are accepted', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([
      row(),
      row({ id: 'b', script: 'x', class: 'preempt-and-catchup' }),
      row({ id: 'c', script: 'y', class: 'no-safe-kill' }),
    ]),
  }), 'PASS');

  // ── the three vacuity guards, each demonstrated ────────────────────────────────────────
  ck('GUARD 1 — no ops/cron/*.sh at all -> INDETERMINATE', v({
    [REGISTRY_REL]: registry([row()]),
  }), 'INDETERMINATE');

  ck('GUARD 2 — a MISSING registry -> INDETERMINATE, never "nothing is registered"', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
  }), 'INDETERMINATE');

  ck('GUARD 2b — an UNPARSEABLE registry -> INDETERMINATE', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: 'not json at all',
  }), 'INDETERMINATE');

  ck('GUARD 2c — an EMPTY rows[] is vacuity (we build this corpus) -> INDETERMINATE', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([]),
  }), 'INDETERMINATE');

  ck('GUARD 3 — wrappers exist but NOT ONE execs -> INDETERMINATE (the matcher broke)', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ncurl -s https://example.test\n',
    [`${CRON_DIR}/b.sh`]: '#!/usr/bin/env bash\necho hi\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'INDETERMINATE');

  // ── the token -> exit-code MAPPING, not just the token ────────────────────────────────
  // Asserting verdicts alone once left a gate whose INDETERMINATE mapped to 0 fully green.
  const codeOf = (verdict) => {
    const orig = console.log; console.log = () => {};
    try { return emit(verdict === 'INDETERMINATE' ? { verdict, host: 'h', reason: 'x' } : { verdict, host: 'h', ownsRepoCron: true, files: ['f'], candidates: [], rows: 1, classes: {}, unregistered: verdict === 'FAIL' ? ['f'] : [], unusable: [], rulingDrift: [] }); }
    finally { console.log = orig; }
  };
  ck('PASS maps to exit 0', codeOf('PASS'), 0);
  ck('FAIL maps to exit 1', codeOf('FAIL'), 1);
  ck('INDETERMINATE maps to exit 3, the token-law default for a new gate', codeOf('INDETERMINATE'), 3);

  // ── THE HERMETIC SEAM'S OWN BLIND SPOT ────────────────────────────────────────────────
  // Every check above replaces the repo root with a fixture, so all of them are structurally
  // blind to the real tree — a broken glob against the REAL layout would pass every one.
  // CLAUDE.md: assert the bypassed artifact too.
  const realFiles = cronFiles(REPO);
  const realCandidates = cronCandidates(REPO);
  const realDoc = loadRegistry(REPO);
  ck('SEAM — the real ops/cron glob is non-empty', realFiles.length >= 10, true);
  ck('SEAM — the real tree has at least one command-position `docker exec`', realCandidates.length >= 1, true);
  ck('SEAM — the real registry loads with rows', Array.isArray(realDoc?.rows) && realDoc.rows.length >= 5, true);
  ck('SEAM — the real registry declares the carry-labeler row the interlock hardcodes',
    (realDoc?.rows || []).some((r) => r.id === 'carry-labeler' && r.class === 'preempt-and-catchup'), true);
  ck('SEAM — the real tree evaluates to a DECIDED verdict', evaluate(REPO).verdict !== 'INDETERMINATE', true);

  // ── HOST SCOPING (OPS-HOST-AUTO-REBOOT-W1) ────────────────────────────────────────────────
  ck('the registry declares BOTH hosts', declaredHosts(realDoc || { rows: [] }).sort().join(','), 'aoe-1,signal-1');
  ck('SEAM — every REAL host evaluates to a DECIDED verdict',
    declaredHosts(realDoc).every((h) => evaluate(REPO, h).verdict === 'PASS'), true);
  ck('a row with NO host is REPORTED, never silently dropped from every selection', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row(), { id: 'ghost', script: 'x', class: 'safe-to-kill', reason: 'stated' }]),
  }), 'FAIL');
  ck('an UNKNOWN host is INDETERMINATE, never an empty PASS', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row()]),
  }, 'mars-1'), 'INDETERMINATE');
  ck('a host with rows but NO _residual_no_safe_kill block is INDETERMINATE', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row()], { _residual_no_safe_kill: {} }),
  }), 'INDETERMINATE');
  ck('a NON-repo-cron host needs no repo corpus and still PASSES', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row(), row({ id: 'h1', host: 'aoe-1', script: 'host-only', source: 'host-only' })]),
  }, 'aoe-1'), 'PASS');
  ck("…and its rows are STILL checked for a reason (a host-only row is not exempt)", v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row(), row({ id: 'h1', host: 'aoe-1', script: 'host-only', source: 'host-only', reason: '  ' })]),
  }, 'aoe-1'), 'FAIL');
  ck('a row on ANOTHER host cannot satisfy this host\'s repo corpus', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row({ host: 'aoe-1' }), row({ id: 'z', script: 'other' })]),
  }), 'FAIL');
  // THE RULING MUST MATCH ITS EVIDENCE — the block kernel-auto-reboot.sh's third gate reads.
  ck('a _residual_no_safe_kill COUNT that disagrees with the rows -> FAIL', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row()], { _residual_no_safe_kill: { [REPO_CRON_HOST]: { count: 1, ids: [] } } }),
  }), 'FAIL');
  ck('…and disagreeing IDS -> FAIL too', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n',
    [REGISTRY_REL]: registry([row({ class: 'no-safe-kill' })], { _residual_no_safe_kill: { [REPO_CRON_HOST]: { count: 1, ids: ['something-else'] } } }),
  }), 'FAIL');

  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }

  if (fails) {
    console.log(`SELF-TEST: FAIL — ${fails} of ${checks}`);
    console.log('CRON_INTERLOCK_COVERAGE_VERDICT=FAIL');
    return 1;
  }
  console.log(`SELF-TEST: PASS — ${checks} checks (happy path, both mention-vs-invocation shapes, six command positions, the unusable-row rules, every vacuity guard, the token→exit-code mapping, host scoping incl. the ruling-must-match-its-evidence check, and the assertions against the REAL tree the fixture seam bypasses)`);
  console.log('CRON_INTERLOCK_COVERAGE_VERDICT=PASS');
  return 0;
}

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (IS_MAIN) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  // `--host <label>` narrows to one host; with no flag EVERY declared host is checked, so the
  // prepublishOnly wiring stays a bare invocation and still gains the new host the day one lands.
  const i = process.argv.indexOf('--host');
  process.exit(run(REPO, i > -1 ? process.argv[i + 1] : null));
}
