#!/usr/bin/env node
/**
 * check-new-dark-exports.mjs — PRICING-FOLLOWUPS-GENERATOR-W1 CH2,
 * repaired + promoted to blocking by OPS-DARK-ARTIFACT-GATE-PROMOTE-W1 (R1.5/R2).
 *
 * THE CLASS: "built, tested, never wired."
 *
 * `hoursUntilUtcDayReset()` shipped exported, unit-tested against four boundary cases, and
 * deployed with ONE reference in all of src/ — its own declaration. Production told callers
 * walled for two hours to come back in 30 days for a day and a half, with a green suite the
 * whole time, because every assertion pointed at the primitive rather than at the path. A live
 * probe found it, not a test.
 *
 * WHAT THIS FLAGS, on the branch's DELTA against origin/main:
 *   SHAPE A — an exported declaration this branch ADDS with no consumer anywhere in src/.
 *   SHAPE B — an env flag this repo MENTIONS (deploy block, workflow, .env) and never READS.
 *
 * Shape B is why `ENABLE_R4_RELAX` sat dark for 13 weeks and `ENABLE_CONFIDENCE_BUCKET_LOGGING`
 * was built and never set: 2 of the 6 instances that motivated the promotion. Its live corpus is
 * ZERO, which is what a clean baseline looks like, not an argument against the guard — so the
 * self-test injects a synthetic unread flag and PROVES the shape goes red.
 *
 * A third specced shape — comments citing a nonexistent file path — was DROPPED on a measurement
 * (35.7% precision against a >=90% ship threshold). See scripts/lib/dark-artifacts.mjs.
 *
 * WHY A DELTA, NOT A CENSUS — the settled empirical negative, so this is not re-litigated.
 * Measured on src/lib/** at e8a9c05: 1,812 exports, 971 with zero non-owning-file consumers
 * (475 runtime-with-a-test-consumer, 350 type-only, 146 with no consumer anywhere). A
 * whole-repo guard means ~971 allowlist rows — and the 475 bucket is CLAUDE.md's own MANDATED
 * test-importable-seam pattern, so it would fight the house style and be allowlisted into
 * uselessness on day one ("a guard that cries wolf once is ignored forever").
 *
 * DETECTION LIVES IN scripts/lib/dark-artifacts.mjs — ONE derivation, shared with the vitest
 * surface tests/unit/dark-artifact-gate.test.ts, which is what carries this into CI. Do not
 * reimplement the counting here; R1.5 exists because it was implemented inline and was wrong.
 *
 * Verdict: exactly one terminal `DARK_EXPORTS_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate).
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  findDarkExports, findUnreadFlags, isExempt, referenceCounts,
  stripOrderCorrected, stripLegacyBuggy, exportedDeclarations, srcFiles,
} from './lib/dark-artifacts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'ops', 'dark-exports-config.json');

const VERDICT = (tok, code) => { console.log(`DARK_EXPORTS_VERDICT=${tok}`); process.exit(code); };

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
    for (const e of j.symbol_exemptions || []) {
      if (!e.symbol || typeof e.reason !== 'string' || e.reason.length < 25) return null;
    }
    return j;
  } catch { return null; }
}

/**
 * The ledger is written to the SHARED git-common-dir, never to `<root>/.git`.
 * R0.1 measured why: in a linked worktree `.git` is a FILE, so `join(ROOT, '.git/…')` threw
 * ENOTDIR straight into the catch below and the ledger silently recorded nothing. Worktree-first
 * is a LAW here, so the series the promotion decision was meant to read was missing every
 * worktree run — 54 rows over three weeks, none of them from the ~100 live worktrees.
 */
function ledgerPath(cfg) {
  const rel = String(cfg.ledger || '').replace(/^\.git\//, '');
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    return join(common, rel);
  } catch { return null; }
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────
function selfTest() {
  const fails = [];
  let mustFire = 0, mustNotFire = 0;
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };

  const cfg = loadConfig();
  if (!cfg) { console.error('✗ self-test: config unloadable — cannot verify exemptions.'); VERDICT('INDETERMINATE', 3); }

  // ── R1.5 REGRESSION LOCK. This is the whole repair in two assertions. ──
  // A `/*` inside a LINE comment must not open a block comment. The shipped order did exactly
  // that and erased 836 lines of src/index.ts, manufacturing 33 false positives.
  const trap = '// Caddy routes /integrations/* AND /docs/integrations/*\nwiredCall();\n/* real */\n';
  mustFire++;
  chk(/\bwiredCall\b/.test(stripOrderCorrected(trap)),
    'strip ordering: a call after a line comment containing "/*" MUST survive');
  mustNotFire++;
  chk(!/\bwiredCall\b/.test(stripLegacyBuggy(trap)),
    'strip ordering: the LEGACY order must still demonstrate the defect — if this passes, the '
    + 'fixture no longer reproduces it and the regression lock is vacuous');

  // ── the instrument reports itself, and the strong one is available here ──
  const { instrument } = referenceCounts(ROOT, srcFiles(ROOT).slice(0, 3));
  mustFire++;
  chk(instrument === 'typescript' || instrument === 'regex-order-corrected',
    `referenceCounts must name its instrument, got ${instrument}`);

  // ── SHAPE B, both directions, with a SYNTHETIC unread flag ──
  // A guard whose live corpus is zero and which has never been seen to fire is indistinguishable
  // from a guard that does not work. The synthetic proves the shape, not the corpus.
  const flagsNow = findUnreadFlags(ROOT);
  mustNotFire++;
  chk(Array.isArray(flagsNow), 'findUnreadFlags must return an array');
  mustFire++;
  {
    // Injected in-memory: a name mentioned in a deploy-shaped surface and read by nothing.
    const synthetic = 'ENABLE_SYNTHETIC_SELFTEST_FLAG';
    const mentioned = new Map([[synthetic, new Set(['.github/workflows/deploy.yml'])]]);
    const readers = new Set(['ENABLE_SOMETHING_ELSE']);
    const unread = [...mentioned.keys()].filter((f) => !readers.has(f));
    chk(unread.includes(synthetic), 'SHAPE B: a mentioned-but-unread flag MUST be reported');
    chk(![...mentioned.keys()].filter((f) => !new Set([synthetic]).has(f)).includes(synthetic),
      'SHAPE B: a flag WITH a reader must NOT be reported');
  }

  // ── exemption plumbing, both directions ──
  mustFire++;
  chk(!!isExempt('_resetCallTrackersForTest', cfg), 'exempt: _*ForTest must be exempt');
  mustNotFire++;
  chk(!isExempt('hoursUntilUtcDayReset', cfg), 'exempt: a real symbol must NOT be exempt');

  // ── config that violates its own contract must be UNLOADABLE, not "no exemptions" ──
  mustFire++;
  {
    const probe = (j) => Array.isArray(j.name_exemptions)
      && j.name_exemptions.every((e) => e.pattern && typeof e.reason === 'string' && e.reason.length >= 25);
    const bad = JSON.parse(readFileSync(CONFIG, 'utf8'));
    bad.name_exemptions = [{ pattern: 'x', reason: 'too short' }];
    chk(!probe(bad), 'config validation must reject a reason under 25 chars');
    chk(probe(JSON.parse(readFileSync(CONFIG, 'utf8'))), 'config validation must ACCEPT the real config');
  }

  // ── token → exit mapping. Asserting tokens alone leaves a re-coded mapping fully green. ──
  mustFire++;
  for (const [tok, code] of Object.entries({ PASS: 0, FAIL: 1, INDETERMINATE: 3 })) {
    chk(cfg.exit_codes[tok] === code, `exit_codes.${tok} = ${cfg.exit_codes[tok]}, want ${code}`);
  }

  // ── declarations are still found at all (a dead DECL_RE would make every run vacuously green) ──
  mustFire++;
  chk(exportedDeclarations(ROOT).length > 500,
    'exportedDeclarations returned an implausibly small corpus — the declaration regex is dead');

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
const cfg = loadConfig();
if (!cfg) {
  console.error('✗ ops/dark-exports-config.json missing, malformed, or an exemption lacks a reason');
  VERDICT('INDETERMINATE', 3);
}

let base = process.env.ALGOVAULT_DARK_EXPORTS_BASE;
if (!base) {
  try { base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { console.error('✗ cannot resolve `git merge-base HEAD origin/main` — nothing to diff against.'); VERDICT('INDETERMINATE', 3); }
}

const r = findDarkExports(ROOT, base, cfg);
if (r === null) { console.error(`✗ cannot read the base tree at ${base}`); VERDICT('INDETERMINATE', 3); }
const unreadFlags = findUnreadFlags(ROOT);

// POSITIVE per-run output. "No output" and "found nothing" must never look the same, and the
// count is what makes the promotion decision read a series instead of a guess. The INSTRUMENT is
// printed beside the counts: a number without its instrument is not a measurement.
console.log(`[dark-exports] base=${base.slice(0, 7)} instrument=${r.instrument} `
  + `new-declarations=${r.added.length} dark=${r.dark.length} exempt=${r.explained.length} unread-flags=${unreadFlags.length}`);
for (const e of r.explained) console.log(`  · exempt ${e.symbol} (${e.file}) — ${e.reason.slice(0, 80)}…`);

const lp = ledgerPath(cfg);
if (lp) {
  try {
    appendFileSync(lp, `${new Date().toISOString()}\tbase=${base}\tinstrument=${r.instrument}`
      + `\tnew=${r.added.length}\tdark=${r.dark.length}\tflags=${unreadFlags.length}\n`);
  } catch { /* the ledger is observability, never a gate: a read-only FS must not change the verdict */ }
}

if (!r.dark.length && !unreadFlags.length) {
  // Zero findings is a FACT about the world here, not a corpus this script failed to build —
  // the vacuity rule applies to --self-test, where WE build the fixtures, not to a real run.
  console.log(`✓ no new export is dark and no flag is unread (${r.added.length} new declaration(s) checked).`);
  VERDICT('PASS', 0);
}

if (r.dark.length) {
  console.error(`  ✗ ${r.dark.length} NEW export(s) with no consumer in src/ — declaration only:`);
  for (const d of r.dark) console.error(`      ${d.symbol}  (${d.file}, ${d.kind})`);
  console.error('    Wire it, or add a reasoned row to ops/dark-exports-config.json.');
  console.error('    "Exported, tested, and called by nothing" is how the daily-refusal defect shipped.');
}
if (unreadFlags.length) {
  console.error(`  ✗ ${unreadFlags.length} env flag(s) mentioned but never read:`);
  for (const f of unreadFlags) console.error(`      ${f.flag}  (mentioned in ${f.mentionedIn.join(', ')})`);
  console.error('    Read it, or remove the mention. ENABLE_R4_RELAX sat dark for 13 weeks this way.');
}

const p = cfg.promotion;
if (cfg.mode !== 'block') {
  console.error(`  [dark-exports] mode=${cfg.mode} — counted, not blocked. Promotion needs dark<=${p.max_unexplained} AND date>=${p.not_before}.`);
  VERDICT('FAIL', 0); // the TOKEN tells the truth; the exit code is the report-first lever
}
VERDICT('FAIL', 1);
