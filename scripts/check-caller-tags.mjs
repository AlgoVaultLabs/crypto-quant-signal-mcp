#!/usr/bin/env node
/**
 * check-caller-tags.mjs — OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH1.
 *
 * THE CLASS THIS RETIRES: one caller tag naming two spenders. The per-caller acquisition ledger
 * keys on the ALS caller tag, so a tag shared by two processes merges two spenders into one row and
 * the attribution is silently wrong. Measured before this gate: `backfill` named backfill-outcomes
 * AND PID 1's in-server backfill; `seed:<tf>` named the HL, promoted, shadow and WEEX lanes at once;
 * `dwr-backfill` named two scripts; and `signal_perf_backfill` named PID 1 AND every seed process,
 * because seed-signals.ts reaches the backfill through a DYNAMIC import.
 *
 * WHAT IT ASSERTS, over every runAsCaller / runAsBatch / runAsInteractive call site in src/**:
 *   (a) the caller name is a string literal, a conditional whose branches are all string literals,
 *       or a call to a REGISTERED BUILDER from src/lib/caller-tags.ts — seedCallerTag (only inside
 *       src/scripts/seed-signals.ts), processScopedTag(<literal>), x402CallerTag(…). Anything else —
 *       a variable, a template, a missing or empty name — FAILS: the gate cannot say what it emits.
 *   (b) no emitted name is shared by two different ENTRYPOINTS. Reuse inside one entrypoint is fine.
 *       Entrypoints: src/index.ts (PID 1), every src/scripts/**.ts, and any src file with a
 *       `require.main === module` branch. A call site "emits" from every entrypoint whose import
 *       closure contains its file — static imports, re-exports, `require()` AND dynamic `import()`.
 *       processScopedTag(b) emits `b` from PID 1 and `b@<entrypoint>` from any other entrypoint, so it
 *       is unique per entrypoint by construction; that is exactly why library code uses it.
 *
 * VERDICT: exactly one terminal line `CALLER_TAG_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0 / 1 / 3
 * (3 = the token-law default for a NEW gate: the corpus could not be read, the helper module is
 * missing, or `typescript` is not installed). Callers gate on the TOKEN, never the exit code.
 *
 * USAGE
 *   node scripts/check-caller-tags.mjs [--check] [--root <dir>]   # the gate
 *   node scripts/check-caller-tags.mjs --self-test                 # hermetic two-way fixtures
 *   node scripts/check-caller-tags.mjs --manifest [--root <dir>]   # JSON: every site, its helper, class and names
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GATE = 'CALLER_TAG';
export const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
/** Index of the caller-name argument, per helper. */
export const HELPERS = { runAsCaller: 0, runAsBatch: 1, runAsInteractive: 1 };
/** The class a helper imposes: runAsCaller only names, it never sets a class. */
export const HELPER_CLASS = { runAsCaller: 'inherit', runAsBatch: 'batch', runAsInteractive: 'interactive' };
export const HELPER_MODULE = 'src/lib/upstream-weight-budget.ts';
export const BUILDER_MODULE = 'src/lib/caller-tags.ts';
export const PID1 = 'src/index.ts';
export const SEED_ENTRY = 'src/scripts/seed-signals.ts';
export const PID1_NAME = 'index';

let ts;
function loadTs() {
  if (!ts) ts = createRequire(import.meta.url)('typescript');
  return ts;
}

/** Entrypoint name the runtime would derive (runtime.ts entrypointName): basename, extension stripped. */
export function epName(rel) {
  return path.basename(rel).replace(/\.(?:c|m)?[jt]s$/, '');
}

function hasMainGuard(T, sf) {
  // A real `require.main === module` comparison in CODE. Comments never enter the AST, so a docblock
  // quoting the guard (script-lifecycle.ts does) is not mistaken for an entrypoint.
  let found = false;
  (function walk(n) {
    if (found) return;
    if (T.isBinaryExpression(n) && (n.operatorToken.kind === T.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === T.SyntaxKind.EqualsEqualsToken)) {
      const side = (x) => x.getText(sf).replace(/\s+/g, '');
      const l = side(n.left), r = side(n.right);
      if ((l === 'require.main' && r === 'module') || (l === 'module' && r === 'require.main')) { found = true; return; }
    }
    T.forEachChild(n, walk);
  })(sf);
  return found;
}

function isEntrypoint(T, rel, sf) {
  if (rel === PID1) return true;
  if (rel.startsWith('src/scripts/')) return true;
  return hasMainGuard(T, sf);
}

function resolveSpec(fromRel, spec, files) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const stem = base.replace(/\.(?:c|m)?js$/, '');
  for (const cand of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, base]) if (files.has(cand)) return cand;
  return null;
}

/**
 * Pure analysis over an in-memory tree { relPath → source }. Returns every call site, the
 * entrypoint reach of each file, every violation and the emitted-name table. No I/O.
 */
export function analyze(files) {
  const T = loadTs();
  const sfs = new Map();
  for (const [rel, text] of files) {
    if (!rel.endsWith('.ts')) continue;
    sfs.set(rel, T.createSourceFile(rel, text, T.ScriptTarget.Latest, true, T.ScriptKind.TS));
  }
  // ── import graph (static, re-export, require(), dynamic import()) ──
  const edges = new Map();
  for (const [rel, sf] of sfs) {
    const out = new Set();
    const add = (spec) => { const r = resolveSpec(rel, spec, files); if (r) out.add(r); };
    (function walk(n) {
      if ((T.isImportDeclaration(n) || T.isExportDeclaration(n)) && n.moduleSpecifier && T.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
      if (T.isCallExpression(n) && n.arguments.length >= 1 && T.isStringLiteralLike(n.arguments[0])) {
        if (n.expression.kind === T.SyntaxKind.ImportKeyword) add(n.arguments[0].text);
        if (T.isIdentifier(n.expression) && n.expression.text === 'require') add(n.arguments[0].text);
      }
      T.forEachChild(n, walk);
    })(sf);
    edges.set(rel, out);
  }
  const entrypoints = [...sfs.keys()].filter((rel) => isEntrypoint(T, rel, sfs.get(rel))).sort();
  const reachedBy = new Map([...sfs.keys()].map((k) => [k, new Set()]));
  for (const ep of entrypoints) {
    const seen = new Set([ep]); const q = [ep];
    while (q.length) { const f = q.shift(); for (const g of edges.get(f) ?? []) if (!seen.has(g)) { seen.add(g); q.push(g); } }
    for (const f of seen) reachedBy.get(f)?.add(ep);
  }
  // ── call sites ──
  const sites = []; const violations = [];
  for (const [rel, sf] of sfs) {
    if (rel === HELPER_MODULE) continue;
    const alias = new Map(); // local name → helper
    const builderAlias = new Map(); // local name → builder
    for (const st of sf.statements) {
      if (!T.isImportDeclaration(st) || !st.importClause?.namedBindings || !T.isNamedImports(st.importClause.namedBindings)) continue;
      const target = resolveSpec(rel, st.moduleSpecifier.text, files);
      for (const el of st.importClause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text; const local = el.name.text;
        if (target === HELPER_MODULE && imported in HELPERS) alias.set(local, imported);
        if (target === BUILDER_MODULE && ['seedCallerTag', 'processScopedTag', 'x402CallerTag'].includes(imported)) builderAlias.set(local, imported);
      }
    }
    if (alias.size === 0) continue;
    (function walk(n) {
      if (T.isCallExpression(n) && T.isIdentifier(n.expression) && alias.has(n.expression.text)) {
        const helper = alias.get(n.expression.text);
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const site = { file: rel, line, helper, class: HELPER_CLASS[helper], eps: [...(reachedBy.get(rel) ?? [])].sort() };
        const arg = n.arguments[HELPERS[helper]];
        classifyName(T, arg, site, builderAlias, sf);
        if (site.rule) violations.push({ rule: site.rule, file: rel, line, detail: site.detail });
        if (site.kind === 'seed' && rel !== SEED_ENTRY) violations.push({ rule: 'A_SEED_SCOPE', file: rel, line, detail: 'seedCallerTag may only be called from ' + SEED_ENTRY });
        sites.push(site);
      }
      T.forEachChild(n, walk);
    })(sf);
  }
  // ── emissions per entrypoint, then collisions across entrypoints ──
  const emissions = []; // { name | prefix+suffix, ep, file, line }
  for (const s of sites) {
    if (s.rule) continue;
    for (const ep of s.eps) {
      const en = epName(ep);
      if (s.kind === 'literal') for (const nm of s.names) emissions.push({ exact: nm, ep, file: s.file, line: s.line });
      if (s.kind === 'scoped') emissions.push({ exact: en === PID1_NAME ? s.base : `${s.base}@${en}`, ep, file: s.file, line: s.line });
      if (s.kind === 'x402') emissions.push({ prefix: 'x402:', suffix: en === PID1_NAME ? null : `@${en}`, ep, file: s.file, line: s.line });
      if (s.kind === 'seed') emissions.push({ prefix: 'seed:', suffix: null, ep, file: s.file, line: s.line });
    }
  }
  const overlaps = (a, b) => {
    const fits = (nm, p) => nm.startsWith(p.prefix) && (p.suffix === null ? !/@[^@]+$/.test(nm) : nm.endsWith(p.suffix));
    if (a.exact !== undefined && b.exact !== undefined) return a.exact === b.exact;
    if (a.exact !== undefined) return fits(a.exact, b);
    if (b.exact !== undefined) return fits(b.exact, a);
    return (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) && a.suffix === b.suffix;
  };
  const groups = new Map(); // label → Map(ep → first site)
  for (let i = 0; i < emissions.length; i++) for (let j = i + 1; j < emissions.length; j++) {
    const a = emissions[i], b = emissions[j];
    if (a.ep === b.ep || !overlaps(a, b)) continue;
    const label = a.exact ?? b.exact ?? `${a.prefix}*`;
    if (!groups.has(label)) groups.set(label, new Map());
    const g = groups.get(label);
    for (const e of [a, b]) if (!g.has(e.ep)) g.set(e.ep, `${e.file}:${e.line}`);
  }
  for (const [label, g] of [...groups].sort((x, y) => x[0].localeCompare(y[0]))) {
    const eps = [...g.keys()].sort();
    const first = g.get(eps[0]).split(':');
    const shown = eps.slice(0, 6).map((ep) => `${ep} (${g.get(ep)})`).join(', ');
    violations.push({ rule: 'B_SHARED', file: first[0], line: Number(first[1]), detail: `name ${JSON.stringify(label)} is emitted by ${eps.length} entrypoints: ${shown}${eps.length > 6 ? `, … +${eps.length - 6} more` : ''}` });
  }
  return { sites, entrypoints, violations, filesScanned: sfs.size };
}

function classifyName(T, arg, site, builderAlias, sf) {
  if (!arg) { site.rule = 'A_MISSING'; site.detail = `${site.helper} without a caller name`; return; }
  const lit = (x) => (T.isStringLiteral(x) || T.isNoSubstitutionTemplateLiteral(x)) ? x.text : null;
  const bare = (x) => { while (T.isParenthesizedExpression(x) || T.isAsExpression(x)) x = x.expression; return x; };
  const a = bare(arg);
  const one = lit(a);
  if (one !== null) {
    if (one.trim() === '') { site.rule = 'A_EMPTY'; site.detail = 'empty caller name'; return; }
    site.kind = 'literal'; site.names = [one]; return;
  }
  if (T.isConditionalExpression(a)) {
    const w = lit(bare(a.whenTrue)), f = lit(bare(a.whenFalse));
    if (w !== null && f !== null && w.trim() && f.trim()) { site.kind = 'literal'; site.names = [...new Set([w, f])]; return; }
  }
  if (T.isCallExpression(a) && T.isIdentifier(a.expression) && builderAlias.has(a.expression.text)) {
    const b = builderAlias.get(a.expression.text);
    if (b === 'seedCallerTag') { site.kind = 'seed'; return; }
    if (b === 'x402CallerTag') { site.kind = 'x402'; return; }
    if (b === 'processScopedTag') {
      const base = a.arguments[0] ? lit(bare(a.arguments[0])) : null;
      if (base && base.trim() && a.arguments.length === 1) { site.kind = 'scoped'; site.base = base; return; }
      site.rule = 'A_NONLITERAL'; site.detail = 'processScopedTag needs exactly one string-literal base'; return;
    }
  }
  site.rule = 'A_NONLITERAL';
  site.detail = `caller name is not a literal, a conditional of literals, or a registered builder call: ${a.getText(sf).slice(0, 80)}`;
}

function readTree(root) {
  const files = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.set(path.relative(root, abs).split(path.sep).join('/'), fs.readFileSync(abs, 'utf8'));
    }
  })(path.join(root, 'src'));
  return files;
}

function emit(verdict, lines) {
  for (const l of lines) console.log(l);
  console.log(`${GATE}_VERDICT=${verdict}`);
  process.exitCode = CODES[verdict]; // never process.exit(): a queued pipe write would lose the token
}

export function runCheck(root) {
  try { loadTs(); } catch (e) { return { verdict: 'INDETERMINATE', lines: [`[caller-tags] typescript not loadable: ${e.message}`] }; }
  let files;
  try { files = readTree(root); } catch (e) { return { verdict: 'INDETERMINATE', lines: [`[caller-tags] cannot read ${root}/src: ${e.message}`] }; }
  if (!files.has(HELPER_MODULE)) return { verdict: 'INDETERMINATE', lines: [`[caller-tags] ${HELPER_MODULE} missing — cannot locate the helpers`] };
  const r = analyze(files);
  const lines = [`[caller-tags] scanned ${r.filesScanned} files · ${r.entrypoints.length} entrypoints · ${r.sites.length} call sites`];
  if (r.sites.length === 0) return { verdict: 'INDETERMINATE', lines: [...lines, '[caller-tags] zero call sites found while the helper module exists — the detector cannot be trusted'] };
  for (const v of r.violations) lines.push(`  FAIL ${v.rule} ${v.file}:${v.line} — ${v.detail}`);
  if (r.violations.length === 0) lines.push(`[caller-tags] every name is a literal or a registered builder, and no name is shared by two entrypoints`);
  return { verdict: r.violations.length ? 'FAIL' : 'PASS', lines, result: r };
}

// ── hermetic two-way self-test ───────────────────────────────────────────────
const HELPER_SRC = `export function runAsCaller(c: string, f: any) { return f(); }
export function runAsBatch(f: any, c: string) { return f(); }
export function runAsInteractive(f: any, c: string) { return f(); }`;
const BUILDER_SRC = `export function processScopedTag(b: string) { return b; }
export function x402CallerTag(t: string) { return t; }
export function seedCallerTag(a: any) { return 'seed:'; }`;
function tree(extra) {
  return new Map([[HELPER_MODULE, HELPER_SRC], [BUILDER_MODULE, BUILDER_SRC], ...Object.entries(extra)]);
}
const IMP = `import { runAsCaller, runAsBatch, runAsInteractive } from '../lib/upstream-weight-budget.js';\nimport { processScopedTag, x402CallerTag, seedCallerTag } from '../lib/caller-tags.js';\n`;
const IMP_ROOT = IMP.replace(/\.\.\/lib\//g, './lib/');
const IMP_LIB = IMP.replace(/\.\.\/lib\//g, './');
export const SELF_TEST_CASES = [
  // must PASS
  { name: 'literals, conditional, builders, one entrypoint each', expect: [], tree: {
      [PID1]: `${IMP_ROOT}import './lib/shared.js';\nrunAsCaller('tool_a', () => 1); runAsCaller(x ? 'get_trade_call' : 'get_trade_signal', () => 1); runAsCaller(x402CallerTag(t), () => 1);`,
      'src/scripts/job.ts': `${IMP}import '../lib/shared.js';\nrunAsBatch(async () => 1, 'job_tag');`,
      'src/lib/shared.ts': `${IMP_LIB}runAsBatch(async () => 1, processScopedTag('shared_work'));`,
      [SEED_ENTRY]: `${IMP}runAsBatch(async () => 1, seedCallerTag(a));`,
      'src/lib/nobody.ts': `${IMP_LIB}runAsBatch(async () => 1, 'orphan_lib_tag');` } },
  { name: 'reuse inside ONE entrypoint is allowed', expect: [], tree: {
      [PID1]: `${IMP_ROOT}runAsCaller('same', () => 1); runAsCaller('same', () => 2);` } },
  { name: 'a guard quoted in a COMMENT is not an entrypoint (regression: script-lifecycle.ts)', expect: [], tree: {
      [PID1]: `${IMP_ROOT}import './lib/lifecycle.js';`,
      'src/lib/lifecycle.ts': `${IMP_LIB}// callers wrap main under: if (require.main === module) { … }\nrunAsCaller('lifecycle_tag', () => 1);` } },
  // must FAIL, one rule each
  { name: 'same literal in two entrypoints', expect: ['B_SHARED'], tree: {
      [PID1]: `${IMP_ROOT}runAsBatch(async () => 1, 'backfill');`,
      'src/scripts/backfill-outcomes.ts': `${IMP}runAsCaller('backfill', () => 1);` } },
  { name: 'literal in a library reachable from two entrypoints', expect: ['B_SHARED'], tree: {
      [PID1]: `${IMP_ROOT}import './lib/perf.js';`,
      'src/scripts/seed.ts': `${IMP}import '../lib/perf.js';`,
      'src/lib/perf.ts': `${IMP_LIB}runAsBatch(async () => 1, 'signal_perf_backfill');` } },
  { name: 'reach through a DYNAMIC import', expect: ['B_SHARED'], tree: {
      [PID1]: `${IMP_ROOT}import './lib/perf.js';`,
      'src/scripts/seed.ts': `${IMP}async function f() { await import('../lib/perf.js'); }`,
      'src/lib/perf.ts': `${IMP_LIB}runAsBatch(async () => 1, 'signal_perf_backfill');` } },
  { name: 'script literal colliding with a PID-1 processScopedTag emission', expect: ['B_SHARED'], tree: {
      [PID1]: `${IMP_ROOT}import './lib/grid.js';`,
      'src/lib/grid.ts': `${IMP_LIB}runAsBatch(async () => 1, processScopedTag('grid_warmer'));`,
      'src/scripts/rogue.ts': `${IMP}runAsBatch(async () => 1, 'grid_warmer');` } },
  { name: 'seed: literal outside the seed entrypoint', expect: ['B_SHARED'], tree: {
      [SEED_ENTRY]: `${IMP}runAsBatch(async () => 1, seedCallerTag(a));`,
      'src/scripts/other.ts': `${IMP}runAsBatch(async () => 1, 'seed:5m');` } },
  { name: 'seedCallerTag outside seed-signals.ts', expect: ['A_SEED_SCOPE'], tree: {
      'src/scripts/other.ts': `${IMP}runAsBatch(async () => 1, seedCallerTag(a));` } },
  { name: 'empty literal', expect: ['A_EMPTY'], tree: { [PID1]: `${IMP_ROOT}runAsCaller('', () => 1);` } },
  { name: 'variable name', expect: ['A_NONLITERAL'], tree: { [PID1]: `${IMP_ROOT}runAsCaller(name, () => 1);` } },
  { name: 'template literal with a substitution', expect: ['A_NONLITERAL'], tree: { [PID1]: `${IMP_ROOT}runAsCaller(\`x402:\${tool}\`, () => 1);` } },
  { name: 'processScopedTag with a non-literal base', expect: ['A_NONLITERAL'], tree: { [PID1]: `${IMP_ROOT}runAsCaller(processScopedTag(b), () => 1);` } },
  { name: 'missing name', expect: ['A_MISSING'], tree: { [PID1]: `${IMP_ROOT}runAsBatch(async () => 1);` } },
  { name: 'aliased helper import is still seen', expect: ['A_EMPTY'], tree: {
      [PID1]: `import { runAsBatch as rab } from './lib/upstream-weight-budget.js';\nrab(async () => 1, '');` } },
];

export function runSelfTest() {
  try { loadTs(); } catch (e) { return { verdict: 'INDETERMINATE', lines: [`[caller-tags] self-test: typescript not loadable: ${e.message}`] }; }
  const lines = []; let fails = 0;
  const mustPass = SELF_TEST_CASES.filter((c) => c.expect.length === 0);
  const mustFail = SELF_TEST_CASES.filter((c) => c.expect.length > 0);
  if (mustPass.length === 0 || mustFail.length === 0) return { verdict: 'INDETERMINATE', lines: ['[caller-tags] self-test corpus is empty on one side — refusing to report a pass'] };
  for (const c of SELF_TEST_CASES) {
    let got;
    try { got = [...new Set(analyze(tree(c.tree)).violations.map((v) => v.rule))].sort(); }
    catch (e) { got = [`THREW:${e.message}`]; }
    const ok = JSON.stringify(got) === JSON.stringify([...c.expect].sort());
    const sitesFound = (() => { try { return analyze(tree(c.tree)).sites.length; } catch { return 0; } })();
    const vacuous = sitesFound === 0;
    if (!ok || vacuous) fails++;
    lines.push(`  ${ok && !vacuous ? 'PASS' : 'FAIL'} ${c.expect.length ? 'must-fail' : 'must-pass'}: ${c.name} → got ${JSON.stringify(got)}${vacuous ? ' (VACUOUS: zero sites parsed)' : ''}`);
  }
  // token → exit-code mapping is part of the contract
  const mapOk = CODES.PASS === 0 && CODES.FAIL === 1 && CODES.INDETERMINATE === 3;
  if (!mapOk) { fails++; lines.push('  FAIL token→exit mapping is not PASS=0 FAIL=1 INDETERMINATE=3'); }
  lines.push(`[caller-tags] self-test: ${SELF_TEST_CASES.length - fails + (mapOk ? 0 : 1)}/${SELF_TEST_CASES.length} cases (${mustPass.length} must-pass, ${mustFail.length} must-fail)${fails ? ` — ${fails} FAILED` : ''}`);
  return { verdict: fails ? 'FAIL' : 'PASS', lines };
}

function main(argv) {
  let mode = 'check'; let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') continue;
    if (a === '--self-test') { mode = 'self-test'; continue; }
    if (a === '--manifest') { mode = 'manifest'; continue; }
    if (a === '--root') { root = path.resolve(argv[++i]); continue; }
    emit('INDETERMINATE', [`[caller-tags] unknown argument ${a}`]); return;
  }
  if (mode === 'self-test') { const r = runSelfTest(); emit(r.verdict, r.lines); return; }
  const r = runCheck(root);
  if (mode === 'manifest' && r.result) {
    console.log(JSON.stringify(r.result.sites.map((s) => ({ file: s.file, line: s.line, helper: s.helper, class: s.class, kind: s.kind ?? null, names: s.names ?? (s.base ? [s.base] : null), eps: s.eps.map(epName) })), null, 1));
  }
  emit(r.verdict, r.lines);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
