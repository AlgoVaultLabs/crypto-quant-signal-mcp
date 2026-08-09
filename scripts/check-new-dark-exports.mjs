#!/usr/bin/env node
/**
 * check-new-dark-exports.mjs — PRICING-FOLLOWUPS-GENERATOR-W1 CH2.
 *
 * THE CLASS: "built, tested, never wired."
 *
 * `hoursUntilUtcDayReset()` shipped exported, unit-tested against four boundary cases, and
 * deployed with ONE reference in all of src/ — its own declaration. Production told callers
 * walled for two hours to come back in 30 days for a day and a half, with a green suite the
 * whole time, because every assertion pointed at the primitive rather than at the path. A live
 * probe found it, not a test.
 *
 * WHAT THIS FLAGS: exports a branch ADDS whose reference count across src/ is 1 (the
 * declaration alone). New, and called by nothing.
 *
 * WHY A DELTA, NOT A CENSUS — the settled empirical negative, so this is not re-litigated.
 * Measured on src/lib/** at e8a9c05: 1,812 exports, 971 with zero non-owning-file consumers
 * (475 runtime-with-a-test-consumer, 350 type-only, 146 with no consumer anywhere). A
 * whole-repo guard means ~971 allowlist rows — and the 475 bucket is CLAUDE.md's own MANDATED
 * test-importable-seam pattern, so it would fight the house style and be allowlisted into
 * uselessness on day one ("a guard that cries wolf once is ignored forever"). On the wave that
 * shipped the defect: 23 new exports → 2 flagged, one of them the actual bug.
 *
 * Verdict: exactly one terminal `DARK_EXPORTS_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate).
 *
 * REPORT-first (G-D): findings print and the exit stays 0 until the promotion criterion in
 * ops/dark-exports-config.json is met — BOTH a zero count and a date, because a numeric-only
 * criterion can never fire if the count never heals, and a date-only one flips a noisy guard.
 */
import { readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'ops', 'dark-exports-config.json');

const VERDICT = (tok, code) => { console.log(`DARK_EXPORTS_VERDICT=${tok}`); process.exit(code); };

/**
 * Declarations only. `export type` / `export interface` are excluded HERE rather than by an
 * allowlist row: a type has no call site, so "unreferenced type" is not the defect class and
 * letting it into the corpus would put 350 permanent rows in front of every real finding.
 * `export { x } from …` and `export * from …` are likewise not declarations — a re-export
 * introduces no new symbol and is not evidence that anything invokes it.
 */
const DECL = /^export\s+(?:async\s+)?(function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** Comments are not invocations — the same strip `check-canaries-wired.mjs` applies. */
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

function srcFiles(dir = 'src') {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

function declaredIn(text) {
  const out = new Map();
  for (const m of text.matchAll(DECL)) out.set(m[2], m[1]);
  return out;
}

/**
 * Reference count across the WHOLE of src/, including the declaring file.
 *
 * Counting only OTHER files would flag every helper a module uses internally — measured on the
 * reference wave that is `getDailyCap` (3 refs), `utcDayKey` (3), `INTERVAL_MONTHS` (4),
 * `planPrepayTotalUsd` (4), none of them defects. 1 means the declaration and nothing else.
 */
function refCount(sym, texts) {
  const re = new RegExp(`\\b${sym.replace(/\$/g, '\\$')}\\b`, 'g');
  let n = 0;
  for (const t of texts) n += (t.match(re) || []).length;
  return n;
}

function loadConfig() {
  if (!existsSync(CONFIG)) return null;
  try {
    const j = JSON.parse(readFileSync(CONFIG, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    if (!Array.isArray(j.name_exemptions)) return null;
    // A config WE author is CONSTRUCTED, so a malformed promotion block is vacuity, not a fact.
    if (!j.promotion || typeof j.promotion.max_unexplained !== 'number' || !j.promotion.not_before) return null;
    for (const e of j.name_exemptions) {
      if (!e.pattern || typeof e.reason !== 'string' || e.reason.length < 25) return null;
    }
    return j;
  } catch { return null; }
}

function exempt(sym, cfg) {
  for (const e of cfg.name_exemptions) if (new RegExp(e.pattern).test(sym)) return e;
  for (const e of cfg.symbol_exemptions || []) if (e.symbol === sym) return e;
  return null;
}

/** New declarations on HEAD that are absent at `base`. */
function newDeclarations(base) {
  const files = srcFiles();
  const head = new Map();
  for (const f of files) for (const [s, k] of declaredIn(readFileSync(join(ROOT, f), 'utf8'))) head.set(s, { file: f, kind: k });

  const baseSyms = new Set();
  let baseFiles;
  try {
    baseFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((x) => x.endsWith('.ts'));
  } catch { return null; }
  for (const f of baseFiles) {
    let raw;
    try { raw = execFileSync('git', ['show', `${base}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch { continue; }
    for (const s of declaredIn(raw).keys()) baseSyms.add(s);
  }
  return [...head.entries()].filter(([s]) => !baseSyms.has(s)).map(([s, v]) => ({ symbol: s, ...v }));
}

function analyse(base) {
  const cfg = loadConfig();
  if (!cfg) return { verdict: 'INDETERMINATE', why: 'ops/dark-exports-config.json missing, malformed, or an exemption lacks a reason' };
  const added = newDeclarations(base);
  if (added === null) return { verdict: 'INDETERMINATE', why: `cannot read the base tree at ${base}` };

  const texts = srcFiles().map((f) => strip(readFileSync(join(ROOT, f), 'utf8')));
  const dark = [], explained = [];
  for (const a of added) {
    if (refCount(a.symbol, texts) > 1) continue;
    const ex = exempt(a.symbol, cfg);
    (ex ? explained : dark).push({ ...a, reason: ex?.reason });
  }
  return { verdict: dark.length ? 'FAIL' : 'PASS', cfg, added, dark, explained };
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────
function selfTest() {
  const fails = [];
  let mustFire = 0, mustNotFire = 0;

  const T = (name, text, sym, want) => {
    const decls = declaredIn(text);
    const got = decls.has(sym);
    if (got !== want) fails.push(`${name}: declaredIn(${sym}) = ${got}, want ${want}`);
    want ? mustFire++ : mustNotFire++;
  };
  T('function decl', 'export function foo() {}', 'foo', true);
  T('const decl', 'export const bar = 1;', 'bar', true);
  T('class decl', 'export class Baz {}', 'Baz', true);
  // Exempt BY CONSTRUCTION — these must never enter the corpus at all.
  T('type is not a declaration', 'export type Qux = string;', 'Qux', false);
  T('interface is not a declaration', 'export interface Quux { a: 1 }', 'Quux', false);
  T('re-export is not a declaration', "export { corge } from './x.js';", 'corge', false);
  T('star re-export', "export * from './y.js';", 'grault', false);
  T('non-exported is out of scope', 'function garply() {}', 'garply', false);

  // refCount: 1 = declaration only (dark); >1 = used somewhere, including intra-file.
  const decl = 'export function widget() {}';
  mustFire++;
  if (refCount('widget', [strip(decl)]) !== 1) fails.push('refCount: a lone declaration must count 1');
  mustNotFire++;
  if (refCount('widget', [strip(`${decl}\nwidget();`)]) <= 1) fails.push('refCount: an intra-file call must count >1');
  // A mention in a COMMENT is not an invocation.
  mustFire++;
  if (refCount('widget', [strip(`${decl}\n// widget() is called elsewhere\n`)]) !== 1) {
    fails.push('refCount: a commented call must NOT count as a consumer');
  }

  // Exemption plumbing, both directions.
  const cfg = loadConfig();
  if (!cfg) { console.error('✗ self-test: config unloadable — cannot verify exemptions.'); VERDICT('INDETERMINATE', 3); }
  mustFire++;
  if (!exempt('_resetCallTrackersForTest', cfg)) fails.push('exempt: _*ForTest must be exempt');
  mustNotFire++;
  if (exempt('hoursUntilUtcDayReset', cfg)) fails.push('exempt: a real symbol must NOT be exempt');

  // A config that violates its own contract must be UNLOADABLE, not "no exemptions".
  mustFire++;
  {
    const bad = JSON.parse(readFileSync(CONFIG, 'utf8'));
    bad.name_exemptions = [{ pattern: 'x', reason: 'too short' }];
    const saved = readFileSync(CONFIG, 'utf8');
    try {
      // Validate through the same predicate rather than the file, so the self-test never writes.
      const probe = (j) => Array.isArray(j.name_exemptions) && j.name_exemptions.every((e) => e.pattern && typeof e.reason === 'string' && e.reason.length >= 25);
      if (probe(bad)) fails.push('config validation must reject a reason under 25 chars');
      if (!probe(JSON.parse(saved))) fails.push('config validation must ACCEPT the real config');
    } catch { fails.push('config validation threw'); }
  }

  // token → exit mapping. Asserting tokens alone leaves a re-coded mapping fully green.
  mustFire++;
  const MAP = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
  for (const [tok, code] of Object.entries(MAP)) {
    if (cfg.exit_codes[tok] !== code) fails.push(`exit_codes.${tok} = ${cfg.exit_codes[tok]}, want ${code}`);
  }

  // Vacuity: a self-test that built nothing must REFUSE, not report a pass.
  if (mustFire === 0 || mustNotFire === 0) {
    console.error(`✗ self-test built an empty corpus (fire=${mustFire}, not-fire=${mustNotFire}).`);
    VERDICT('INDETERMINATE', 3);
  }
  if (fails.length) {
    console.error('✗ self-test FAILED:'); for (const f of fails) console.error(`    ${f}`);
    VERDICT('FAIL', 1);
  }
  console.log(`✓ self-test passed — ${mustFire} must-fire, ${mustNotFire} must-not-fire, 3 token→exit mappings.`);
  VERDICT('PASS', 0);
}

if (process.argv.includes('--self-test')) selfTest();

// ── run ─────────────────────────────────────────────────────────────────────────────────────
let base = process.env.ALGOVAULT_DARK_EXPORTS_BASE;
if (!base) {
  try { base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { console.error('✗ cannot resolve `git merge-base HEAD origin/main` — nothing to diff against.'); VERDICT('INDETERMINATE', 3); }
}

const r = analyse(base);
if (r.verdict === 'INDETERMINATE') { console.error(`✗ ${r.why}`); VERDICT('INDETERMINATE', 3); }

// POSITIVE per-run output. "No output" and "found nothing" must never look the same, and the
// count is what makes the promotion decision read a series instead of a guess.
console.log(`[dark-exports] base=${base.slice(0, 7)} new-declarations=${r.added.length} dark=${r.dark.length} exempt=${r.explained.length}`);
for (const e of r.explained) console.log(`  · exempt ${e.symbol} (${e.file}) — ${e.reason.slice(0, 80)}…`);

try {
  appendFileSync(join(ROOT, r.cfg.ledger), `${new Date().toISOString()}\tbase=${base}\tnew=${r.added.length}\tdark=${r.dark.length}\n`);
} catch { /* the ledger is observability, never a gate: a read-only FS must not change the verdict */ }

if (!r.dark.length) {
  // Zero findings is a FACT about the world here, not a corpus this script failed to build —
  // the vacuity rule applies to --self-test, where WE build the fixtures, not to a real run.
  console.log(`✓ no new export is dark (${r.added.length} new declaration(s) checked).`);
  VERDICT('PASS', 0);
}

console.error(`  ✗ ${r.dark.length} NEW export(s) with no consumer in src/ — declaration only:`);
for (const d of r.dark) console.error(`      ${d.symbol}  (${d.file}, ${d.kind})`);
console.error('    Wire it, delete it, or add a reasoned row to ops/dark-exports-config.json.');
console.error('    "Exported, tested, and called by nothing" is how the daily-refusal defect shipped.');

const p = r.cfg.promotion;
const blocking = r.cfg.mode === 'block'
  || (r.dark.length <= p.max_unexplained && new Date().toISOString().slice(0, 10) >= p.not_before);
if (!blocking) {
  console.error(`  [dark-exports] mode=report — counted, not blocked. Promotion needs dark<=${p.max_unexplained} AND date>=${p.not_before}.`);
  VERDICT('FAIL', 0); // the TOKEN tells the truth; the exit code is the report-first lever
}
VERDICT('FAIL', 1);
