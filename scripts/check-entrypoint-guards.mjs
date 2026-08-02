#!/usr/bin/env node
// @ts-check
/**
 * check-entrypoint-guards.mjs — a cron/CLI entrypoint must GUARD its top-level main().
 *
 * OPS-AUDIT-REMEDIATION-LOW-W1 · SEC-22.
 *
 * THE LAW THIS ENFORCES ALREADY EXISTED, IN PROSE ONLY. CLAUDE.md: "Make entrypoints
 * test-importable: `scripts/*.ts` cron/CLI wraps top-level `main()` in
 * `if (require.main === module)`". Written law with no executable gate is the exact class this
 * arc has been retiring — SEC-22 was reported against 2 files, and a re-grep at HEAD found the
 * 2 it named already fixed while **7 others** had never been guarded at all. A rule nobody can
 * fail is a rule nobody keeps.
 *
 * WHY IT MATTERS. An unguarded module runs its job the instant anything imports it — a unit
 * test, a canary, another script reusing one exported helper. The failure is silent and
 * expensive: the import "hangs" (it is actually posting to dev.to, writing Postgres, or sending
 * Telegram), and nothing in the stack says why.
 *
 * WHAT COUNTS AS A GUARD. Four idioms are live in this repo and ALL are accepted — the point is
 * that execution is conditional on being the entry point, not which spelling was used:
 *   require.main === module      (27 sites — the dominant form, and what CLAUDE.md names)
 *   runScript('<label>', main)   (25 sites — the shared wrapper, which guards internally)
 *   argv1.endsWith('<name>.js')  (6 sites — pre-dates the helper)
 *   process.argv[1].includes(…)  (geo-demand-mining.ts — same semantics, different spelling)
 * Adding a 5th spelling is fine; add it to GUARD_PATTERNS with a reason.
 *
 * SCOPE. `src/scripts/**.ts` — the cron/CLI surface. A file is IN SCOPE only if it has a
 * top-level `main()` CALL; a module that merely defines and exports main() is already
 * import-safe and is not flagged.
 *
 * Verdict: exactly one terminal `ENTRYPOINT_GUARDS_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate).
 * FAIL-CLOSED: an unreadable tree, or a vacuous scan (zero entrypoints found in a non-empty
 * repo), is INDETERMINATE and blocks — a scan that examined nothing must never read as clean.
 *
 * Usage:
 *   node scripts/check-entrypoint-guards.mjs --self-test   # both directions, offline
 *   node scripts/check-entrypoint-guards.mjs               # scan the tracked tree
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** Every accepted guard spelling. A hit anywhere in the file means execution is conditional. */
const GUARD_PATTERNS = [
  /require\.main\s*===\s*module/,
  /runScript\s*\(/,
  /process\.argv\[1\]/,
  /\bargv1\b/,
];

/**
 * Does this module INVOKE main (as opposed to merely defining/exporting it)?
 *
 * This must NOT be anchored to column 0. A correctly guarded file has its call INDENTED inside
 * the `if` block, so a column-0 detector sees guarded files as "not an entrypoint" — which
 * collapses the corpus to zero the moment the tree is clean and trips the vacuity guard. (That
 * is exactly what the first draft of this canary did on its first real run: it reported
 * INDETERMINATE against a fully-compliant tree.) Detect the CALL anywhere, then ask separately
 * whether it is guarded.
 *
 * `runScript('label', main)` passes main by reference and invokes it internally — also an entrypoint.
 */
const MAIN_CALL = /(?:^|[^.\w])main\s*\(\s*\)/m;
const RUNSCRIPT_CALL = /runScript\s*\(/;
/** Definitions, stripped before looking for a call, so `function main()` is not read as one. */
const MAIN_DEFINITION = /(?:async\s+)?function\s+main\s*\([^)]*\)|(?:const|let|var)\s+main\s*=/g;

/**
 * Strip comments so a guard *described in a docblock* never counts as a guard, and a commented
 * -out main() call never counts as an entrypoint. Same lesson as check-canaries-wired.mjs:
 * a mention is not an invocation.
 * @param {string} text
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * @param {string} source raw file text
 * @returns {{isEntrypoint: boolean, guarded: boolean}}
 */
export function classify(source) {
  const code = stripComments(source);
  const withoutDefs = code.replace(MAIN_DEFINITION, '');
  const isEntrypoint = MAIN_CALL.test(withoutDefs) || RUNSCRIPT_CALL.test(code);
  const guarded = GUARD_PATTERNS.some((p) => p.test(code));
  return { isEntrypoint, guarded };
}

function trackedScripts() {
  return execFileSync('git', ['ls-files', 'src/scripts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));
}

function audit() {
  const files = trackedScripts();
  const entrypoints = [];
  const offenders = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    const { isEntrypoint, guarded } = classify(text);
    if (!isEntrypoint) continue;
    entrypoints.push(f);
    if (!guarded) offenders.push(f);
  }
  return { scanned: files.length, entrypoints, offenders };
}

/** Two-directional, vacuity-guarded. A gate that cannot fail is theatre. */
export function selfTest() {
  const fails = [];
  const UNGUARDED = 'async function main(){ await go(); }\nmain().catch((e) => { process.exit(1); });\n';
  const GUARDED_REQUIRE = 'async function main(){}\nif (require.main === module) {\n  main().catch(() => {});\n}\n';
  const GUARDED_ARGV = "const argv1 = process.argv[1] ?? '';\nif (argv1.endsWith('x.js')) {\n  main().catch(() => {});\n}\n";
  const GUARDED_RUNSCRIPT = "runScript('label', main);\n";
  const NOT_ENTRYPOINT = 'export async function main(){}\n';

  if (!classify(UNGUARDED).isEntrypoint) fails.push('an unguarded top-level main() was not recognised as an entrypoint');
  if (classify(UNGUARDED).guarded) fails.push('an unguarded entrypoint was reported as guarded');
  for (const [label, src] of [['require.main', GUARDED_REQUIRE], ['argv1', GUARDED_ARGV], ['runScript', GUARDED_RUNSCRIPT]]) {
    if (!classify(src).guarded) fails.push(`the ${label} guard idiom was not accepted`);
  }
  // THE REGRESSION that made this canary's own first live run INDETERMINATE: a correctly guarded
  // file has an INDENTED main() call, and must still be counted as an entrypoint. Without this,
  // a fully-compliant tree collapses the corpus to zero and the vacuity guard fires on success.
  for (const [label, src] of [['require.main', GUARDED_REQUIRE], ['argv1', GUARDED_ARGV]]) {
    if (!classify(src).isEntrypoint) fails.push(`a GUARDED (indented) ${label} entrypoint was not counted as an entrypoint`);
  }
  if (classify(NOT_ENTRYPOINT).isEntrypoint) fails.push('a module that only EXPORTS main() was flagged as an entrypoint');
  // a guard named only in a comment must NOT count — the SEC-36 shape, one level up
  if (classify('// guarded by require.main === module\nmain().catch(()=>{});\n').guarded) {
    fails.push('a guard mentioned only in a comment counted as a real guard');
  }
  // a commented-out main() call must NOT make the file an entrypoint
  if (classify('// main();\nexport const x = 1;\n').isEntrypoint) {
    fails.push('a commented-out main() call counted as an entrypoint');
  }
  return fails;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function emit(verdict, why) {
  if (why) console.log(`\n${verdict === 'FAIL' ? '✖' : 'ℹ'} ${why}`);
  console.log(`ENTRYPOINT_GUARDS_VERDICT=${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}

if (IS_MAIN) {
  if (argv.includes('--self-test')) {
    const fails = selfTest();
    if (fails.length) { console.error('✖ entrypoint-guards self-test FAILED:'); fails.forEach((f) => console.error('   - ' + f)); process.exit(1); }
    console.log('✓ entrypoint-guards self-test passed (unguarded fires; all 4 idioms accepted; comments and export-only do not count)');
    process.exit(0);
  }

  const stFails = selfTest();
  if (stFails.length) {
    console.error('✖ entrypoint-guards self-test FAILED — refusing to report a vacuous pass:');
    stFails.forEach((f) => console.error('   - ' + f));
    emit('INDETERMINATE', 'self-test failure');
  }

  let result;
  try { result = audit(); } catch (e) {
    emit('INDETERMINATE', `could not enumerate src/scripts: ${e.message}`);
  }
  if (!result.scanned) emit('INDETERMINATE', 'zero tracked files under src/scripts — vacuous scan, refusing to pass');
  if (!result.entrypoints.length) emit('INDETERMINATE', 'zero entrypoints found among tracked scripts — the detector is broken or the tree moved');

  if (result.offenders.length) {
    console.error(`✖ ${result.offenders.length} cron/CLI entrypoint(s) call main() at top level with NO guard:`);
    for (const o of result.offenders) console.error(`   - ${o}`);
    console.error('\n  Anything that imports one of these RUNS it — a test, a canary, another script');
    console.error('  reusing one helper. Wrap the call:');
    console.error('\n      if (require.main === module) {\n        main().catch((err) => { console.error(err); process.exit(1); });\n      }\n');
    console.error('  Live cron invokes `node dist/scripts/<name>.js`, so the guard is TRUE there and the');
    console.error('  scheduled run is unaffected.');
    emit('FAIL', `${result.offenders.length} unguarded entrypoint(s)`);
  }
  console.log(`✓ entrypoint guards: all ${result.entrypoints.length} cron/CLI entrypoints under src/scripts guard their top-level main() (${result.scanned} files scanned).`);
  emit('PASS');
}
