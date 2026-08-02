#!/usr/bin/env node
// @ts-check
/**
 * check-source-greppable.mjs — no tracked text file may be classified BINARY by a
 * grep-class tool, because such a tool skips it SILENTLY and reports its contents
 * as ABSENT.
 *
 * OPS-GREPPABLE-SOURCE-GUARD-W1, retiring a class with four recorded incidents
 * across ~8 weeks.
 *
 * THE BUG CLASS. `src/lib/performance-db.ts` carried three RAW NUL bytes as a
 * composite-key separator. Measured on 2026-08-01:
 *
 *     grep -c export src/lib/performance-db.ts     ->  (empty)     [agent shell]
 *     /usr/bin/grep -c export  …/performance-db.ts ->  73          [BSD grep]
 *     rg -c export             …/performance-db.ts ->  73          [ripgrep]
 *
 * The agent shell resolves `grep` to a wrapper around ugrep invoked with `-I`
 * (ignore binary files). ugrep classifies a file containing NUL as binary, `-I`
 * drops it, and the exit code is 0 — so the caller sees "no matches" and cannot
 * distinguish it from "searched and found nothing". On 2026-08-01 that produced a
 * Plan-Mode HALT declaring SIGNAL_MIGRATIONS, the information_schema/PRAGMA
 * migration runner and 18 CREATE TABLEs "fictional". All were live in that file.
 * Three chapters of a wave stopped on a tool's blindness.
 *
 * WHY THE DATA, NOT THE TOOL. The pre-existing mitigation was a CLAUDE.md rule
 * ("every gate greps with `grep -a` or `rg`"). That protects committed gates only,
 * and the incident was a HAND-TYPED probe — you cannot lint a command someone types
 * into a terminal, and no future author is guaranteed to have read the rule. Making
 * the FILES safe protects every grep that will ever run against this repo: gates,
 * ad-hoc probes, `git grep`, editors, and GitHub code search.
 *
 * WHAT IT ASSERTS, over every tracked file except the allowlisted binaries:
 *   R1  No U+0000 byte. This is the trigger every grep-class tool keys on.
 *   R2  Valid UTF-8. Invalid sequences also trip binary heuristics, and a file that
 *       cannot be decoded cannot be reviewed.
 *
 * Detection is BYTE-LEVEL and TOOL-INDEPENDENT: it never shells out to whichever
 * `grep` happens to be installed, so macOS and the CI runner return the same
 * verdict. Asserting the property of the data is the whole point — a check that
 * asked the local grep would inherit exactly the blindness it exists to detect.
 *
 * Usage:
 *   node scripts/check-source-greppable.mjs --self-test   # both directions, offline
 *   node scripts/check-source-greppable.mjs --check       # scan the tracked tree
 *   node scripts/check-source-greppable.mjs               # same as --check
 *
 * Verdict: exactly one terminal `SOURCE_GREPPABLE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN, not the code (CLAUDE.md verdict-token law).
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE. FAIL-CLOSED — there is no
 * fail-open branch: an unreadable path, a missing git, or an empty corpus is
 * INDETERMINATE and blocks.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const CONFIG_PATH = join(ROOT, 'ops', 'source-greppable-allowlist.json');

/** The escape to use in place of a raw NUL, spelled without emitting one. */
const NUL_ESCAPE = '\\u' + '0000';

// ── detection (pure, byte-level) ──────────────────────────────────────────────

/**
 * Inspect one file's bytes. Returns null when clean, else a finding.
 * @param {Buffer} buf
 * @returns {{rule: string, detail: string, offset: number} | null}
 */
export function inspectBytes(buf) {
  const nul = buf.indexOf(0);
  if (nul !== -1) {
    const count = buf.reduce((n, b) => (b === 0 ? n + 1 : n), 0);
    return {
      rule: 'R1',
      offset: nul,
      detail: `${count} raw NUL byte(s); first at byte ${nul}. Replace each with the escape ${NUL_ESCAPE} — the compiled string is byte-identical.`,
    };
  }
  // R2 — valid UTF-8. Node's fatal decoder is the authority; no heuristics.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { rule: 'R2', offset: -1, detail: 'not valid UTF-8 — cannot be decoded, and trips binary heuristics.' };
  }
  return null;
}

// ── allowlist ─────────────────────────────────────────────────────────────────

/**
 * Load the committed allowlist. Every row carries a `reason` — an exemption that
 * lives only in a code comment gets "fixed" by a future wave enforcing the contract.
 * @returns {{extensions: {ext: string, reason: string}[], paths: {path: string, reason: string}[]}}
 */
function loadAllowlist() {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.extensions) || !Array.isArray(cfg.paths)) {
    throw new Error('allowlist must carry `extensions` and `paths` arrays');
  }
  for (const row of [...cfg.extensions, ...cfg.paths]) {
    if (!row.reason || typeof row.reason !== 'string') {
      throw new Error(`allowlist row ${JSON.stringify(row)} has no reason`);
    }
  }
  return cfg;
}

/** @returns {string[]} every tracked path, repo-relative. */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

// ── self-test (two-way, vacuity-guarded) ──────────────────────────────────────

// A raw NUL is CONSTRUCTED here, never typed as a literal — authoring a file that
// bans raw NULs must not itself plant one (this happened twice while writing this
// wave, which is precisely why the gate exists).
const NUL = Buffer.from([0]);

const DIRTY = [
  ['R1', Buffer.concat([Buffer.from('const key = `${a}'), NUL, Buffer.from('${b}`;\n')])],
  ['R1', Buffer.concat([Buffer.from('# a markdown doc describing the '), NUL, Buffer.from(' separator\n')])],
  ['R1', Buffer.concat([NUL])],
  ['R2', Buffer.from([0x41, 0xc3, 0x28, 0x42])], // invalid UTF-8 continuation byte
  ['R2', Buffer.from([0xff, 0xfe, 0x41])],       // lone surrogates / bad lead byte
];

const CLEAN = [
  Buffer.from("export const SEP = '" + NUL_ESCAPE + "';\n"),
  Buffer.from('// a comment mentioning U+0000 and the word NUL in prose\n'),
  Buffer.from('const s = "\\\\u0000 written as text, not a byte";\n'),
  Buffer.from('emoji and accents: café — ✅\n'),
  Buffer.from(''),          // an empty file is greppable-as-text
  Buffer.from('plain\n'),
];

/** @returns {'PASS'|'FAIL'|'INDETERMINATE'} */
function selfTest() {
  // Vacuity guard: a self-test over an empty corpus proves nothing.
  if (DIRTY.length === 0 || CLEAN.length === 0) {
    console.error('✖ self-test corpus is empty — refusing to report a pass');
    return 'INDETERMINATE';
  }
  let failures = 0;
  for (const [rule, buf] of DIRTY) {
    const got = inspectBytes(/** @type {Buffer} */ (buf));
    if (!got) {
      console.error(`✖ self-test: known-BAD ${rule} fixture was NOT flagged`);
      failures++;
    } else if (got.rule !== rule) {
      console.error(`✖ self-test: ${rule} fixture flagged as ${got.rule}`);
      failures++;
    }
  }
  for (const buf of CLEAN) {
    const got = inspectBytes(/** @type {Buffer} */ (buf));
    if (got) {
      console.error(`✖ self-test: clean fixture wrongly flagged [${got.rule}] ${got.detail}`);
      failures++;
    }
  }
  if (failures) return 'FAIL';
  console.log(`✓ self-test: ${DIRTY.length} known-bad fixtures flagged, ${CLEAN.length} clean fixtures passed.`);
  return 'PASS';
}

// ── verdict ───────────────────────────────────────────────────────────────────

/** @param {'PASS'|'FAIL'|'INDETERMINATE'} verdict */
function verdictAndExit(verdict) {
  console.log(`SOURCE_GREPPABLE_VERDICT=${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}

// ── main ──────────────────────────────────────────────────────────────────────

// Test-importable entrypoint (CLAUDE.md): importing this module for `inspectBytes`
// must NOT run the scan or call process.exit. Only a direct `node scripts/…` does.
const IS_MAIN = process.argv[1] != null
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) main();

function main() {
if (argv.includes('--self-test')) {
  verdictAndExit(selfTest());
}

// A broken detector must never green-light the scan.
const st = selfTest();
if (st !== 'PASS') verdictAndExit(st);

if (!existsSync(CONFIG_PATH)) {
  console.error(`✖ allowlist config missing: ${CONFIG_PATH}`);
  verdictAndExit('INDETERMINATE');
}

let cfg;
try {
  cfg = loadAllowlist();
} catch (err) {
  console.error(`✖ allowlist unreadable/invalid: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}

let files;
try {
  files = trackedFiles();
} catch (err) {
  console.error(`✖ could not enumerate tracked files: ${err instanceof Error ? err.message : err}`);
  verdictAndExit('INDETERMINATE');
}

if (!files || files.length === 0) {
  console.error('✖ enumerated 0 tracked files — refusing to report a pass');
  verdictAndExit('INDETERMINATE');
}

const skipExt = new Set(cfg.extensions.map((/** @type {{ext:string}} */ e) => e.ext.toLowerCase()));
const skipPath = new Set(cfg.paths.map((/** @type {{path:string}} */ p) => p.path));

const findings = [];
let scanned = 0;
let skippedBinaryExt = 0;
let skippedPath = 0;

for (const f of files) {
  if (skipPath.has(f)) { skippedPath++; continue; }
  if (skipExt.has(extname(f).toLowerCase())) { skippedBinaryExt++; continue; }
  let buf;
  try {
    buf = readFileSync(join(ROOT, f));
  } catch (err) {
    // Fail-closed: a tracked file we cannot read is "could not verify", never "clean".
    console.error(`✖ unreadable tracked file ${f}: ${err instanceof Error ? err.message : err}`);
    verdictAndExit('INDETERMINATE');
  }
  scanned++;
  const hit = inspectBytes(buf);
  if (hit) findings.push({ file: f, ...hit });
}

// Vacuity guard #2: an allowlist that swallowed the whole tree is not a pass.
if (scanned === 0) {
  console.error('✖ scanned 0 files after allowlisting — refusing to report a pass');
  verdictAndExit('INDETERMINATE');
}

if (findings.length) {
  console.error(`✖ ${findings.length} file(s) would be silently SKIPPED by a grep-class tool:`);
  for (const h of findings) {
    console.error(`   - ${h.file}  [${h.rule}] ${h.detail}`);
  }
  console.error('');
  console.error(`   Remediation: replace each raw NUL with the escape ${NUL_ESCAPE} (runtime byte-identical),`);
  console.error('   or add a justified row to ops/source-greppable-allowlist.json if the file is genuinely binary.');
  verdictAndExit('FAIL');
}

// Positive per-class output — a silent pass is indistinguishable from a pass over
// zero files, which is the dark-guard failure mode this repo has hit five times.
console.log(`✓ R1 no raw NUL bytes:      ${scanned} files`);
console.log(`✓ R2 valid UTF-8:           ${scanned} files`);
console.log(`  tracked total ${files.length} · scanned ${scanned} · skipped ${skippedBinaryExt} by extension, ${skippedPath} by path`);
verdictAndExit('PASS');
}
