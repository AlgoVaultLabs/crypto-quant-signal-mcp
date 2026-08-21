#!/usr/bin/env node
/**
 * check-declaration-coverage.mjs — OPS-ALERT-REGISTRY-DECLARE-W1 CH2.
 *
 * A HOST-CONSUMED DECLARATION CANNOT EXIST UNWIRED, BECAUSE THE CORPUS THAT DECIDES "WIRED" IS
 * DERIVED FROM WHO READS THE FILE — NOT FROM WHO REMEMBERED TO LIST IT.
 *
 * ── THE BUG CLASS THIS RETIRES ──────────────────────────────────────────────────────────────
 * `tests/unit/declaration-sync.test.ts` already asserts that `DECLARATIONS` is COMPLETE. It
 * derives the requirement from `ops/monitoring/monitoring-inventory.json` — a file maintained by
 * hand — so it inherits that file's blind spots. Its own header claims:
 *
 *     "Adding a host config without wiring it here is therefore no longer possible to do
 *      silently."
 *
 * That claim was falsified on the very next declaration created after it was written.
 * `alert-registry.json` shipped 2026-08-20 with an inventory row, two host-side readers, and NO
 * sync path — the SIXTH instance of the omission the assertion was built to end. It was invisible
 * because its row expressed its host copy through `installed_at[].path` while the classifier read
 * only the top-level `host_path`, so `exemption()` returned `'no host copy exists'` for a file
 * installed on both hosts. The assertion was BLIND, not bypassed.
 *
 * CLAUDE.md's own rule, applied one level up: A VACUITY GUARD BELONGS WHERE THE CORPUS IS
 * CONSTRUCTED, NOT WHERE IT IS OBSERVED. There, the corpus is constructed by hand and the
 * assertion merely observes it. Here it is derived from CONSUMPTION, which no schema drift in the
 * inventory can hide — a file is a declaration because something reads it, full stop.
 *
 * Measured against the tree at authoring time: this check flags `alert-registry.json` on day one,
 * and would have flagged all five historical omissions (`venue-slo-tiers.json`,
 * `OPS-SEED-ORCHESTRATOR-W1-baseline.json`, and the three `.yaml` manifests) the same way.
 *
 * ── WHY `declaration-sync.sh` IS NOT A CONSUMER ─────────────────────────────────────────────
 * Its `DECLARATIONS` array names every declared file, so counting it as a reader makes
 * "declared => has a reader" CIRCULAR: every declared file would trivially have one and the check
 * would only ever be able to report PASS. Excluding it is what makes the derivation independent of
 * the hand-list it is auditing. This is also why comments are stripped from every consumer before
 * matching — a filename mentioned in prose is not a read, the same lesson
 * `check-alert-registry.mjs` records after a comment manufactured a phantom alert id.
 *
 * Verdict contract: exactly one terminal DECLARATION_COVERAGE_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a new gate).
 * Callers gate on the TOKEN, never the code.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './check-alert-recommended-wave.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** Inert data formats a declaration can be written in. Mirrors declaration-sync.sh's dispatcher. */
const DATA_EXT = /\.(json|ya?ml)$/i;
/** Anything with a shebang-able extension is executable CODE, which this script never syncs. */
const CODE_EXT = /\.(sh|py|mjs|cjs|js|rb|pl)$/i;

/**
 * Host-side consumer directories, relative to the repo root. `ops/monitoring` is where the
 * canaries and the reconciler live; `ops/cron` is where the scheduled shells live. Both are
 * installed on a host and both read declarations from `$MONITORING_DIR`.
 */
export const CONSUMER_DIRS = ['ops/monitoring', 'ops/cron'];
/** Where the declarations themselves live — the same directory declaration-sync.sh writes into. */
export const DECLARATION_DIR = 'ops/monitoring';
/**
 * The one consumer that must NOT count. See the header: its DECLARATIONS array names every
 * declared file, so including it makes the derivation circular and the gate unfalsifiable.
 */
export const NOT_A_CONSUMER = new Set(['declaration-sync.sh']);

function listFiles(root, rel) {
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((n) => ({ name: n, abs: path.join(dir, n) }));
}

/** Every inert data file that could be a declaration. */
export function declarationCandidates(root) {
  return listFiles(root, DECLARATION_DIR)
    .filter((f) => DATA_EXT.test(f.name))
    .map((f) => f.name)
    .sort();
}

/** Every host-side script that could read one, minus the self-referential one. */
export function consumerFiles(root) {
  return CONSUMER_DIRS
    .flatMap((d) => listFiles(root, d))
    .filter((f) => CODE_EXT.test(f.name) && !NOT_A_CONSUMER.has(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The declared set, parsed out of declaration-sync.sh — the script IS the SoT for it, exactly as
 * tests/unit/declaration-sync.test.ts parses it. Returns null when the array cannot be located,
 * which the caller must treat as INDETERMINATE rather than "nothing is declared".
 */
export function declaredSet(root) {
  const p = path.join(root, 'ops/monitoring/declaration-sync.sh');
  if (!existsSync(p)) return null;
  const block = /DECLARATIONS=\(([\s\S]*?)\n\)/.exec(readFileSync(p, 'utf8'));
  if (!block) return null;
  return block[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .map((l) => l.replace(/^"/, '').split('|')[0])
    .sort();
}

/**
 * filename -> [consumer basenames that read it]. Comments stripped first: a mention in prose is
 * documentation, not consumption.
 */
export function consumptionMap(root) {
  const candidates = declarationCandidates(root);
  const consumers = consumerFiles(root);
  const bodies = consumers.map((c) => {
    let text = '';
    try { text = readFileSync(c.abs, 'utf8'); } catch { text = ''; }
    return { name: c.name, body: stripComments(text) };
  });
  const map = new Map();
  for (const cand of candidates) {
    map.set(cand, bodies.filter((b) => b.body.includes(cand)).map((b) => b.name));
  }
  return map;
}

/**
 * The whole decision, as data. Separated from I/O so the self-test can drive it against a
 * fixture tree — and so a caller can see WHY, not only WHAT.
 */
export function evaluate(root) {
  const candidates = declarationCandidates(root);
  const consumers = consumerFiles(root);
  const declared = declaredSet(root);

  // ── VACUITY GUARD 1 — the glob broke, which is not "the tree is clean". ────────────────────
  if (candidates.length === 0) {
    return { verdict: 'INDETERMINATE', reason: `no declaration candidates under ${DECLARATION_DIR}/ — the glob is broken, not the tree` };
  }
  if (consumers.length === 0) {
    return { verdict: 'INDETERMINATE', reason: `no host-side consumers under ${CONSUMER_DIRS.join(', ')}/ — the consumer glob is broken` };
  }
  if (declared === null) {
    return { verdict: 'INDETERMINATE', reason: 'could not locate the DECLARATIONS array in ops/monitoring/declaration-sync.sh' };
  }

  const map = consumptionMap(root);
  const consumed = [...map.entries()].filter(([, r]) => r.length > 0);

  // ── VACUITY GUARD 2 — nothing reads ANY declaration, so the grep broke. ────────────────────
  // Deliberately "for ANY file", not "for each file": a single unread declaration is a real and
  // reportable state (nothing consumes it yet), while ZERO reads across the whole corpus can only
  // mean the matcher itself stopped working.
  if (consumed.length === 0) {
    return { verdict: 'INDETERMINATE', reason: `not one of ${candidates.length} declaration(s) has a host-side reader — the consumption scan is broken, not the tree` };
  }

  const derived = consumed.map(([n]) => n).sort();
  const declaredSetOf = new Set(declared);

  // ── VACUITY GUARD 3 — the scan sees LESS than the hand-list, so it is measuring itself. ────
  // A consumption scan is only worth trusting when it can see at least everything a human already
  // wrote down. A strict subset means the extractor lost files, and reporting PASS on that would
  // be this gate committing the exact defect it exists to catch.
  const derivedSetOf = new Set(derived);
  const missingFromDerived = declared.filter((d) => !derivedSetOf.has(d));
  if (missingFromDerived.length > 0 && derived.every((d) => declaredSetOf.has(d))) {
    return {
      verdict: 'INDETERMINATE',
      reason: `the consumption scan derived ${derived.length} file(s), a STRICT SUBSET of the ${declared.length} already declared — `
        + `it cannot see ${missingFromDerived.join(', ')}, so it is measuring itself, not the tree`,
    };
  }

  const violations = consumed
    .filter(([n]) => !declaredSetOf.has(n))
    .map(([n, readers]) => ({ file: n, readers }));

  return {
    verdict: violations.length ? 'FAIL' : 'PASS',
    violations,
    derived,
    declared,
    candidates,
    consumers: consumers.map((c) => c.name),
    unread: candidates.filter((c) => (map.get(c) || []).length === 0),
  };
}

function emit(r) {
  if (r.verdict === 'INDETERMINATE') {
    console.log(`declaration-coverage: INDETERMINATE — ${r.reason}`);
    console.log('DECLARATION_COVERAGE_VERDICT=INDETERMINATE');
    return 3;
  }
  // POSITIVE per-item output: a check silently skipping a file must never read like one that
  // passed over it. Every candidate prints its own line with its own readers.
  console.log(`declaration-coverage: ${r.candidates.length} candidate(s), ${r.consumers.length} host-side consumer(s) `
    + `(declaration-sync.sh excluded — it would make the derivation circular)`);
  for (const f of r.candidates) {
    const readers = (r.derived.includes(f) ? consumptionMapCache.get(f) : []) || [];
    const state = r.declared.includes(f) ? 'declared' : (readers.length ? 'UNWIRED' : 'not declared');
    console.log(`  ${readers.length ? (r.declared.includes(f) ? '✓' : '✗') : '·'} ${f.padEnd(40)} ${state.padEnd(12)} readers: ${readers.join(', ') || '— none —'}`);
  }
  if (r.verdict === 'FAIL') {
    console.log('');
    for (const v of r.violations) {
      console.log(`  ✗ ${v.file} is READ by ${v.readers.join(', ')} but is absent from DECLARATIONS in `
        + 'ops/monitoring/declaration-sync.sh — add "<file>|<required top-level key>|<floor>|<host scope>"');
    }
    console.log('DECLARATION_COVERAGE_VERDICT=FAIL');
    return 1;
  }
  console.log('DECLARATION_COVERAGE_VERDICT=PASS');
  return 0;
}

/** Populated by main()/self-test just before emit, so the per-item lines can name readers. */
let consumptionMapCache = new Map();

export function run(root) {
  consumptionMapCache = consumptionMap(root);
  return emit(evaluate(root));
}

// ─────────────────────────────── self-test ───────────────────────────────

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function fixture(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'declcov-'));
  mkdirSync(path.join(root, 'ops/monitoring'), { recursive: true });
  mkdirSync(path.join(root, 'ops/cron'), { recursive: true });
  for (const [rel, body] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function syncScript(names) {
  return `#!/usr/bin/env bash\nDECLARATIONS=(\n${names.map((n) => `  "${n}|k|1|*"`).join('\n')}\n)\n`;
}

function selfTest() {
  let checks = 0; let fails = 0;
  const roots = [];
  const ck = (label, actual, expected) => {
    checks += 1;
    if (actual !== expected) { fails += 1; console.log(`  ✗ ${label}: got ${actual}, want ${expected}`); }
    else console.log(`  ✓ ${label}`);
  };
  const v = (spec) => {
    const root = fixture(spec); roots.push(root);
    return evaluate(root).verdict;
  };

  // ── the happy path, and the failure it exists to produce ────────────────────────────────
  ck('a read + declared file -> PASS', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json")',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'PASS');

  ck('a read + UNDECLARED file -> FAIL', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/b.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json"); open("b.json")',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'FAIL');

  ck('an UNREAD undeclared file -> PASS (nothing consumes it; not this gate\'s business)', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/orphan.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json")',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'PASS');

  ck('a reader in ops/cron counts too', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/b.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json")',
    'ops/cron/nightly.sh': 'cat b.json',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'FAIL');

  // ── the two rules that make the derivation independent of the hand-list ─────────────────
  // Proven BOTH ways, because "excluded" is the load-bearing half of the derivation. `lonely.json`
  // is undeclared and is named in declaration-sync.sh OUTSIDE a comment, so the only thing keeping
  // it from looking "read" is the exclusion itself. Note the fixture deliberately keeps derived ==
  // declared so GUARD 3 cannot fire and mask the result.
  const circularSpec = {
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/lonely.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json")',
    'ops/monitoring/declaration-sync.sh': `${syncScript(['a.json'])}LEGACY_PATH=lonely.json\n`,
  };
  ck('declaration-sync.sh is NOT a consumer -> PASS', v(circularSpec), 'PASS');
  {
    const root = fixture(circularSpec); roots.push(root);
    NOT_A_CONSUMER.delete('declaration-sync.sh');           // break the rule on purpose
    const broken = evaluate(root).verdict;
    NOT_A_CONSUMER.add('declaration-sync.sh');              // and put it back
    ck('  …and COUNTING it manufactures a violation (the circularity, demonstrated)', broken, 'FAIL');
  }

  ck('a filename in a COMMENT is not a read', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/b.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json")',
    'ops/monitoring/prose.sh': '# we used to read b.json here, and no longer do\ntrue\n',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'PASS');

  // ── the three vacuity guards, each demonstrated ─────────────────────────────────────────
  ck('GUARD 1 — no declaration candidates -> INDETERMINATE', v({
    'ops/monitoring/reader.py': 'pass',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'INDETERMINATE');

  ck('GUARD 1b — no consumers at all -> INDETERMINATE', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'INDETERMINATE');

  ck('GUARD 2 — candidates exist but NOTHING reads any -> INDETERMINATE', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/b.json': '{}',
    'ops/monitoring/reader.py': 'print("hello")',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'INDETERMINATE');

  ck('GUARD 3 — derived is a STRICT SUBSET of declared -> INDETERMINATE', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/b.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json")',
    // b.json is declared but nothing reads it -> derived {a} is a strict subset of declared {a,b}
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json', 'b.json']),
  }), 'INDETERMINATE');

  ck('GUARD 3 does NOT fire when derived exceeds declared (that is a real FAIL)', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/b.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json"); open("b.json")',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'FAIL');

  ck('an unparseable DECLARATIONS array -> INDETERMINATE, never "nothing is declared"', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/reader.py': 'open("a.json")',
    'ops/monitoring/declaration-sync.sh': '#!/usr/bin/env bash\necho no array here\n',
  }), 'INDETERMINATE');

  ck('.yaml is a declaration format too', v({
    'ops/monitoring/a.json': '{}',
    'ops/monitoring/m.yaml': 'rows: []',
    'ops/monitoring/reader.py': 'open("a.json"); open("m.yaml")',
    'ops/monitoring/declaration-sync.sh': syncScript(['a.json']),
  }), 'FAIL');

  // ── THE HERMETIC SEAM'S OWN BLIND SPOT ─────────────────────────────────────────────────
  // Every check above replaces the repo root with a fixture, so all of them are structurally
  // blind to the real tree — a broken glob against the REAL layout would pass all thirteen.
  // CLAUDE.md: assert the bypassed artifact too.
  const realCandidates = declarationCandidates(REPO);
  const realConsumers = consumerFiles(REPO);
  const realDeclared = declaredSet(REPO);
  ck('SEAM — the real ops/monitoring glob is non-empty', realCandidates.length >= 8, true);
  ck('SEAM — the real consumer glob is non-empty', realConsumers.length >= 20, true);
  ck('SEAM — declaration-sync.sh is excluded from the real consumer set',
    realConsumers.some((c) => c.name === 'declaration-sync.sh'), false);
  ck('SEAM — the real DECLARATIONS array parses', Array.isArray(realDeclared) && realDeclared.length >= 8, true);
  ck('SEAM — the real tree evaluates to a decided verdict', evaluate(REPO).verdict !== 'INDETERMINATE', true);

  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }

  if (fails) {
    console.log(`SELF-TEST: FAIL — ${fails} of ${checks}`);
    console.log('DECLARATION_COVERAGE_VERDICT=FAIL');
    return 1;
  }
  console.log(`SELF-TEST: PASS — ${checks} checks (happy path, both independence rules, all three vacuity guards, and five assertions against the REAL tree the fixture seam bypasses)`);
  console.log('DECLARATION_COVERAGE_VERDICT=PASS');
  return 0;
}

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (IS_MAIN) {
  process.exit(process.argv.includes('--self-test') ? selfTest() : run(REPO));
}
