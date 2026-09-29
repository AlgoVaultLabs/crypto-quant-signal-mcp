#!/usr/bin/env node
// @ts-check
/**
 * emit-claim-evidence.mjs — OPS-CLIENT-CLAIM-EVIDENCE-W1 CH1.
 *
 * Projects the MCP-client SoT (src/lib/integrations-data/mcp-clients.ts, compiled) into
 * src/lib/integrations-data/claim-evidence.json — the document the host canary
 * ops/monitoring/client-claim-freshness.py fetches over raw HTTPS and confirms live, daily.
 * The JSON is written ONLY here; tests/unit/claim-evidence.test.ts R5 fails CI when it drifts.
 *
 *   node scripts/emit-claim-evidence.mjs              # write (refuses a SoT that breaks R1–R4)
 *   node scripts/emit-claim-evidence.mjs --check      # lockstep verdict
 *   node scripts/emit-claim-evidence.mjs --self-test  # two-way, offline
 *
 * Reads dist/ via createRequire, like check-mcp-client-copy.mjs — run `npm run build` first.
 * No network.
 *
 * --check verdict: exactly one terminal CLAIM_EVIDENCE_VERDICT=IN_SYNC|DRIFT|INDETERMINATE,
 * exit 0 / 1 / 3. A missing dist/, or a committed JSON that is missing or unparseable, is
 * INDETERMINATE: a check that read nothing must never read as in sync. A committed file that
 * parses but is not byte-for-byte the emitter's output is DRIFT, even when it is deep-equal —
 * the file is diffed in review, so its bytes are the contract.
 * --self-test: exactly one terminal CLAIM_EVIDENCE_SELFTEST=PASS|FAIL|INDETERMINATE, 0 / 1 / 3.
 * 3 is the token-law default for a NEW gate.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderedRowText } from './check-mcp-client-copy.mjs';

// tsc emits CJS; createRequire is the documented way to load it from ESM (a bare `require` is
// undefined here, and getting that wrong reads as INDETERMINATE forever while looking like config).
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {'IN_SYNC'|'DRIFT'|'INDETERMINATE'} CheckVerdict */

const EXIT = Object.freeze({ IN_SYNC: 0, DRIFT: 1, INDETERMINATE: 3 });

/** @param {CheckVerdict} v */
export function exitCodeFor(v) {
  return EXIT[v];
}

/**
 * The compiled SoT and the pure contract module. Null = cannot verify (dist missing or broken).
 * @param {string} root
 */
export function loadCompiled(root = ROOT) {
  const dir = join(root, 'dist', 'lib', 'integrations-data');
  const surfacePath = join(dir, 'mcp-clients.js');
  const libPath = join(dir, 'claim-evidence.js');
  if (!existsSync(surfacePath) || !existsSync(libPath)) return null;
  try {
    const mod = require(surfacePath);
    const surface = mod && (mod.default || mod);
    const lib = require(libPath);
    if (!surface || !Array.isArray(surface.entries) || surface.entries.length === 0) return null;
    if (typeof lib.buildClaimEvidenceDoc !== 'function' || typeof lib.serializeClaimEvidenceDoc !== 'function') return null;
    if (typeof lib.CLAIM_EVIDENCE_JSON !== 'string' || !lib.CLAIM_EVIDENCE_JSON) return null;
    // The output path comes from the contract module — ONE constant, shared with the test's R5 read.
    return { surface, lib, out: join(root, lib.CLAIM_EVIDENCE_JSON) };
  } catch {
    return null;
  }
}

/**
 * The whole --check decision, pure so the self-test drives the shipped logic.
 * @param {string|null} committed  committed file text, null when missing/unreadable
 * @param {string|null} expected   emitter output, null when the SoT could not be loaded
 * @returns {CheckVerdict}
 */
export function decideCheck(committed, expected) {
  if (expected === null || committed === null) return 'INDETERMINATE';
  try {
    JSON.parse(committed);
  } catch {
    return 'INDETERMINATE';
  }
  return committed === expected ? 'IN_SYNC' : 'DRIFT';
}

/**
 * Write via a sibling temp file and rename, so a failure can never leave the tracked file
 * truncated (never redirect a command's stdout onto a tracked file).
 * @param {string} path @param {string} text
 */
export function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** @param {string} path */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function runCheck() {
  const loaded = loadCompiled();
  if (!loaded) console.error('✗ dist/lib/integrations-data/{mcp-clients,claim-evidence}.js not loadable — run `npm run build`.');
  const expected = loaded ? loaded.lib.serializeClaimEvidenceDoc(loaded.lib.buildClaimEvidenceDoc(loaded.surface)) : null;
  const committed = loaded ? readOrNull(loaded.out) : null;
  if (loaded && committed === null) console.error(`✗ ${loaded.lib.CLAIM_EVIDENCE_JSON} missing or unreadable.`);
  const v = decideCheck(committed, expected);
  if (v === 'DRIFT') console.error('✗ claim-evidence.json is not the emitter output of the SoT — run `npm run claims:evidence` and commit it.');
  if (v === 'IN_SYNC' && loaded) {
    const rows = loaded.surface.entries.length;
    const anchors = loaded.surface.entries.reduce((n, e) => n + (e.evidence ? e.evidence.length : 0), 0);
    console.log(`✓ claim-evidence.json matches the SoT (${rows} rows, ${anchors} anchors).`);
  }
  console.log(`CLAIM_EVIDENCE_VERDICT=${v}`);
  process.exit(exitCodeFor(v));
}

function runWrite() {
  const loaded = loadCompiled();
  if (!loaded) {
    console.error('✗ dist/lib/integrations-data/{mcp-clients,claim-evidence}.js not loadable — run `npm run build`.');
    process.exit(3);
  }
  const { surface, lib, out } = loaded;
  // Refuse to publish a corpus the binding rules reject: the host would read it tomorrow.
  const problems = lib.evidenceProblems(surface.entries, renderedRowText);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p.rule} ${p.slug}: ${p.detail}`);
    console.error(`✗ refusing to write — ${problems.length} evidence problem(s) in the SoT.`);
    process.exit(1);
  }
  const text = lib.serializeClaimEvidenceDoc(lib.buildClaimEvidenceDoc(surface));
  const anchors = surface.entries.reduce((n, e) => n + e.evidence.length, 0);
  if (readOrNull(out) === text) {
    console.log(`✓ claim-evidence.json already current (${surface.entries.length} rows, ${anchors} anchors).`);
    process.exit(0);
  }
  writeAtomic(out, text);
  console.log(`✓ wrote ${lib.CLAIM_EVIDENCE_JSON} (${surface.entries.length} rows, ${anchors} anchors).`);
  process.exit(0);
}

/** @returns {'PASS'|'FAIL'|'INDETERMINATE'} */
function selfTest() {
  const fails = [];
  let mustFire = 0;
  let mustNotFire = 0;
  const doc = `${JSON.stringify({ schema_version: 1, rows: [{ slug: 'a', evidence: [{ claim: 'x' }] }] }, null, 2)}\n`;

  /** @param {string} name @param {CheckVerdict} got @param {CheckVerdict} want @param {boolean} fire */
  const expectVerdict = (name, got, want, fire) => {
    if (fire) mustFire++; else mustNotFire++;
    if (got !== want) fails.push(`${name}: got ${got}, want ${want}`);
  };
  expectVerdict('identical bytes', decideCheck(doc, doc), 'IN_SYNC', false);
  expectVerdict('one claim changed', decideCheck(doc.replace('"x"', '"y"'), doc), 'DRIFT', true);
  expectVerdict('deep-equal but reformatted', decideCheck(JSON.stringify(JSON.parse(doc)), doc), 'DRIFT', true);
  expectVerdict('missing trailing newline', decideCheck(doc.trimEnd(), doc), 'DRIFT', true);
  expectVerdict('committed unparseable', decideCheck('{ not json', doc), 'INDETERMINATE', true);
  expectVerdict('committed missing', decideCheck(null, doc), 'INDETERMINATE', true);
  expectVerdict('SoT unloadable', decideCheck(doc, null), 'INDETERMINATE', true);

  // token -> exit mapping, asserted through the SHIPPED function (asserting tokens alone once let a
  // re-coded INDETERMINATE -> 0 mapping stay fully green)
  for (const [v, code] of /** @type {Array<[CheckVerdict, number]>} */ ([['IN_SYNC', 0], ['DRIFT', 1], ['INDETERMINATE', 3]])) {
    if (exitCodeFor(v) !== code) fails.push(`exit code for ${v} is ${exitCodeFor(v)}, want ${code}`);
  }

  // the write path: lands the bytes, leaves no temp file behind
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'claim-evidence-selftest-'));
    const target = join(dir, 'claim-evidence.json');
    writeAtomic(target, doc);
    if (readFileSync(target, 'utf8') !== doc) fails.push('writeAtomic did not land the exact bytes');
    if (readdirSync(dir).length !== 1) fails.push(`writeAtomic left ${readdirSync(dir).length - 1} temp file(s) behind`);
  } catch (e) {
    fails.push(`writeAtomic raised: ${e && /** @type {Error} */ (e).message}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  if (mustFire === 0 || mustNotFire === 0) {
    console.error(`✗ self-test is VACUOUS (must-fire=${mustFire}, must-not-fire=${mustNotFire}).`);
    return 'INDETERMINATE';
  }
  if (fails.length) {
    for (const f of fails) console.error(`  ✗ ${f}`);
    return 'FAIL';
  }
  console.log(`✓ self-test passed — ${mustFire} must-fire, ${mustNotFire} must-not-fire, 3 token→exit mappings, write path.`);
  return 'PASS';
}

// Test-importable entrypoint: importing this module for decideCheck() must not run a mode.
const INVOKED_DIRECTLY = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (INVOKED_DIRECTLY) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const v = selfTest();
    console.log(`CLAIM_EVIDENCE_SELFTEST=${v}`);
    process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
  } else if (argv.includes('--check')) {
    runCheck();
  } else {
    runWrite();
  }
}
