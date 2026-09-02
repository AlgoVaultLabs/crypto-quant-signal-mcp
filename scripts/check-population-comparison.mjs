#!/usr/bin/env node
/**
 * check-population-comparison.mjs — EDGE-POPULATION-COMPARISON-W1.
 *
 * THE GATE THAT MAKES THE COMPARATOR CLASS ENUMERABLE, AND ITS DEBT MONOTONE.
 *
 * The defect it exists for, measured on production 2026-09-02: a monitoring gate compared a rate
 * across two populations against `max(always_long, always_short)`. `always_short` moved +2.97pp
 * between the two windows, and the gate attributed that market move to the change under test —
 * firing a FALSE rollback alarm on a live revenue product.
 *
 * ── WHY A GATE AND NOT ANOTHER RULE ──────────────────────────────────────────────────────────
 * CLAUDE.md's Benchmark-before-publish LAW already mandated edge "against the naive baselines on
 * the same rows". IT WAS FOLLOWED. "Same rows" controls the market WITHIN an arm and is silent on
 * BETWEEN arms, and following it is precisely what produced `max(long, short)` as the comparator.
 * A correctly-followed rule that produces the defect cannot be fixed by writing the rule again —
 * compliance is false assurance, and review cannot catch what it is told is correct.
 *
 * ── WHAT IT ACTUALLY BUYS, STATED HONESTLY ───────────────────────────────────────────────────
 * Pass 1 is a TRIPWIRE, not a proof: a rename, a loop accumulating a max, or a helper called
 * `bestOf` evades it. The enumeration in the registry is what makes the population knowable, and
 * the RATCHET is what makes the debt monotone. Together: the correct answer is the default, the
 * wrong answer must be declared in a file a human reads, and non-use is expensive rather than free.
 *
 * Verdict contract: exactly one terminal `POPULATION_COMPARISON_GATE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a NEW gate; do not
 * "align" it with check_test_baseline.sh's 2, which is 2 only because it already deployed 2).
 * Callers gate on the TOKEN, never the exit code.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REGISTRY = join(ROOT, 'ops/monitoring/population-comparison.registry.json');
const SCHEMA = join(ROOT, 'ops/monitoring/population-comparison.schema.json');

const PASS = 'PASS', FAIL = 'FAIL', INDET = 'INDETERMINATE';

/**
 * The banned SHAPE: a max/greatest over two or more naive directional baselines.
 * Deliberately narrow and deliberately advertised as incomplete — see the honesty note above.
 */
const BANNED_SHAPE =
  /(?:Math\.max|max|greatest|GREATEST)\s*\([^)]*\balways[_-]?(?:buy|sell|long|short)[^)]*\)/i;
// NOTE THE ABSENT TRAILING \b, AND WHY. The first draft required a word boundary after
// buy/sell/long/short, so `alwaysBuyWr` and `alwaysBuyDwr` — the forms this repo ACTUALLY uses at
// calibration-audit.ts:94 and dwr-baseline.ts:122 — did not match, and the live sweep reported ONE
// hit where FOUR exist while printing PASS. It was caught only because the self-test fixtures below
// are copied from real source lines rather than hand-written approximations of them; a fixture
// written as `Math.max(alwaysBuy, alwaysSell)` passes against a regex that cannot read this repo.

/** Files whose CONTENT is scanned. Data and docs are enumerated via the registry, not the sweep. */
const SCAN_DIRS = ['src', 'ops', 'scripts'];
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|py|sh)$/;

/**
 * A mention is not an invocation. Strip line comments and block comments before matching, the same
 * reason `check-canaries-wired.mjs` does — otherwise the most valuable line in a file (the docblock
 * explaining the historical buggy form) is the one the gate demands you delete.
 */
function stripComments(src, file) {
  let s = src;
  if (/\.(py|sh)$/.test(file)) {
    s = s.replace(/^\s*#.*$/gm, '');
    s = s.replace(/"""[\s\S]*?"""/g, '').replace(/'''[\s\S]*?'''/g, '');
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    s = s.replace(/^\s*\/\/.*$/gm, '');
    s = s.replace(/([^:])\/\/.*$/gm, '$1');
  }
  return s;
}

function tracked() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', ...SCAN_DIRS], { encoding: 'utf8' });
  return out.split('\n').filter(f => f && SCAN_EXT.test(f));
}

function run() {
  const notes = [];
  let registry, schema;
  try {
    registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  } catch (e) {
    // Input we were HANDED and could not parse is INDETERMINATE, always.
    console.log(`[population-comparison] cannot read the contract: ${e.message}`);
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  // Config we AUTHOR is CONSTRUCTED, so an empty declaration is vacuity and must refuse.
  if (!Array.isArray(registry.sites) || registry.sites.length === 0) {
    console.log('[population-comparison] registry declares zero sites — a corpus we construct ' +
                'being empty is a defect in the registry, not a fact about the world');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }
  if (!Array.isArray(schema.banned_basis) || schema.banned_basis.length === 0) {
    console.log('[population-comparison] schema declares no banned bases — vacuous contract');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  const files = tracked();
  // Input the WORLD gives us being empty would be a fact; but we build this list from git, so an
  // empty tree means the scan is broken, not that the repo has no source.
  if (files.length === 0) {
    console.log('[population-comparison] scanned zero files — the sweep searched nothing, which ' +
                'is indistinguishable from a clean sweep and must never report one');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  const declaredFiles = new Set(registry.sites.map(s => s.file));
  const hits = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    const body = stripComments(src, f);
    body.split('\n').forEach((line, i) => {
      if (BANNED_SHAPE.test(line)) hits.push({ file: f, line: i + 1, text: line.trim().slice(0, 110) });
    });
  }

  const undeclared = hits.filter(h => !declaredFiles.has(h.file));
  const unmigrated = registry.sites.filter(s => s.status === 'UNMIGRATED');
  const missingWave = unmigrated.filter(s => !s.migration_wave);
  const baseline = Number(registry.unmigrated_baseline);

  // POSITIVE per-check output — a check silently skipped must not look like one that passed.
  console.log(`[population-comparison] scanned ${files.length} tracked files across ${SCAN_DIRS.join('/')}`);
  console.log(`[population-comparison] registry declares ${registry.sites.length} sites ` +
              `(${unmigrated.length} UNMIGRATED, baseline ${baseline})`);
  console.log(`[population-comparison] banned-shape hits: ${hits.length}, of which undeclared: ${undeclared.length}`);
  for (const h of hits.slice(0, 12)) {
    const tag = declaredFiles.has(h.file) ? 'declared  ' : 'UNDECLARED';
    console.log(`  ${tag} ${h.file}:${h.line}  ${h.text}`);
  }

  if (undeclared.length) {
    notes.push(`${undeclared.length} banned-comparator site(s) not declared in the registry`);
  }
  if (missingWave.length) {
    notes.push(`${missingWave.length} UNMIGRATED site(s) name no migration_wave — declared debt ` +
               `must name who will pay it`);
  }
  if (Number.isFinite(baseline) && unmigrated.length > baseline) {
    notes.push(`RATCHET: UNMIGRATED count ${unmigrated.length} exceeds baseline ${baseline} — ` +
               `the class may shrink, never grow`);
  }
  if (!Number.isFinite(baseline)) {
    console.log('[population-comparison] registry declares no numeric unmigrated_baseline');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${INDET}`);
    return 3;
  }

  if (notes.length) {
    for (const n of notes) console.log(`[population-comparison] ✗ ${n}`);
    console.log('[population-comparison] remediation: add a row to ' +
                relative(ROOT, REGISTRY) + ' with status, purpose, basis and a migration_wave, ' +
                'or migrate the site to population_comparison / population-comparison.ts');
    console.log(`POPULATION_COMPARISON_GATE_VERDICT=${FAIL}`);
    return 1;
  }
  console.log('[population-comparison] every banned-comparator site is declared; debt within ratchet');
  console.log(`POPULATION_COMPARISON_GATE_VERDICT=${PASS}`);
  return 0;
}

function selfTest() {
  const fails = [];
  const ck = (label, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) fails.push(label); };

  // The banned shape matches the real forms found in this repo — built from the ACTUAL source
  // lines, not from hand-written approximations of them.
  ck('matches Math.max(alwaysBuyWr, alwaysSellWr, randomWr)',
     BANNED_SHAPE.test('  const bestBenchmark = Math.max(alwaysBuyWr, alwaysSellWr, randomWr);'));
  ck('matches actual - Math.max(alwaysBuy, alwaysSell)',
     BANNED_SHAPE.test('  return { edge: actual - Math.max(alwaysBuy, alwaysSell) };'));
  ck('matches Math.max(bench.alwaysBuyDwr, bench.alwaysSellDwr)',
     BANNED_SHAPE.test('  const benchmark = Math.max(bench.alwaysBuyDwr, bench.alwaysSellDwr);'));
  ck('matches the python form max(self.p_long, self.p_short) via always_ naming',
     BANNED_SHAPE.test('    best = max(always_long, always_short)'));
  ck('does NOT match an unrelated max',
     !BANNED_SHAPE.test('  const n = Math.max(a.length, b.length);'));
  ck('does NOT match a mix-matched null',
     !BANNED_SHAPE.test('  const pStar = q * pLong + (1 - q) * pShort;'));

  // A mention in a comment is not an invocation — and this is the trap that would otherwise
  // demand deleting the docblock that explains the historical buggy form.
  ck('a // comment mentioning the banned form is stripped',
     !BANNED_SHAPE.test(stripComments('// edge = actual - Math.max(alwaysBuy, alwaysSell)', 'x.ts')));
  ck('a # comment mentioning it is stripped',
     !BANNED_SHAPE.test(stripComments('# best = max(always_long, always_short)', 'x.py')));
  ck('a python docstring mentioning it is stripped',
     !BANNED_SHAPE.test(stripComments('"""uses max(always_long, always_short)"""', 'x.py')));
  ck('but real code on the same line as trailing prose still matches',
     BANNED_SHAPE.test(stripComments('const e = a - Math.max(alwaysBuy, alwaysSell); // note', 'x.ts')));

  // The corpus is real.
  let files = [];
  try { files = tracked(); } catch { /* ignore */ }
  ck(`the scan corpus is non-empty (${files.length} files)`, files.length > 100);

  // Contract coherence — the artifacts the run path reads but no scenario above exercises.
  let ok = false;
  try {
    const s = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    const r = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    ok = s.banned_basis.includes('MAX_NAIVE')
      && r.sites.every(x => x.file && x.status)
      && r.sites.filter(x => x.status === 'UNMIGRATED').every(x => x.migration_wave)
      && Number.isFinite(Number(r.unmigrated_baseline));
  } catch (e) { console.log(`     (contract read failed: ${e.message})`); }
  ck('schema + registry are coherent: MAX_NAIVE banned, every site typed, every debt owned', ok);

  console.log(`SELF-TEST: ${fails.length === 0 ? 'PASS' : `FAIL (${fails.length})`}`);
  console.log(`POPULATION_COMPARISON_GATE_VERDICT=${fails.length === 0 ? PASS : INDET}`);
  return fails.length === 0 ? 0 : 3;
}

process.exit(process.argv.includes('--self-test') ? selfTest() : run());
