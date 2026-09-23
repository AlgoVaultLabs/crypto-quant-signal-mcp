#!/usr/bin/env node
// DESIGN-SURFACE-TOKENS-W1 CH2 — fail-closed canary: no legacy navy literal comes back.
//
//   node scripts/check-legacy-navy-literals.mjs              # 0 clean · 1 hits · 3 indeterminate
//   node scripts/check-legacy-navy-literals.mjs --self-test  # MUST-CATCH fixtures, two-way
//
// The wave retired a hand-copied palette: card #0f1526, page #060a14, chip #0a0e1a, hairline
// #161d30 / #1c2536 / #141c2e, the nav's rgba(6,10,20 / rgba(10,14,26 and the pre-mint gold
// glow rgba(196, 163, 74. Every one of them now has a token, so a literal reappearing is a
// second palette forming — the exact drift that made this wave necessary (62 copies).
//
// TWO THINGS THIS FILE DOES DELIBERATELY:
//
//  1. Its patterns are ASSEMBLED FROM FRAGMENTS. A canary whose corpus includes scripts/ and
//     whose source spells out the literals it forbids reports ITSELF, forever.
//  2. The card-border rule is the SHARED whole-class-value predicate (scripts/lib/class-
//     context.mjs), never a lookahead: `border-white/5(?=[^"]*(bg-navy-[78]00|card-hover))`
//     matched 0 of 368 real sites, because the context token always PRECEDES the border token.
//
// Verdict token: LEGACY_NAVY_VERDICT / LEGACY_NAVY_SELFTEST_VERDICT. INDETERMINATE (3) when
// the corpus is empty — that means the scan found nothing to read, never "clean".
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCardContext, CLASS_ATTR_RE } from './lib/class-context.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

/** Assembled from fragments so this file never matches itself. */
const hex = (a, b) => `#${a}${b}`;
export const LEGACY_LITERALS = [
  hex('06', '0a14'), // page
  hex('0a', '0e1a'), // chip / well
  hex('0f', '1526'), // card
  hex('16', '1d30'), // hairline (Tailwind navy-600)
  hex('1c', '2536'), // hairline (answer pages)
  hex('14', '1c2e'), // nav hairline (answer pages)
  `rgba(${[6, 10, 20].join(',')}`, // nav / mobile menu
  `rgba(${[10, 14, 26].join(',')}`, // dropdown
  `rgba(${[196, 163, 74].join(', ')}`, // pre-mint gold glow
];

export const SCAN_ROOTS = ['landing', 'src', 'scripts', 'docs-src'];
export const SCAN_EXT = ['.html', '.ts', '.mjs', '.css', '.js'];

/**
 * Allow-list — a PATH plus the reason it cannot use a token. Anything not listed is scanned.
 * Keep this list short and reasoned: an exemption that outlives its cause is how a gate rots.
 */
export const ALLOW = [
  { path: 'scripts/check-legacy-navy-literals.mjs', reason: 'this file: its own patterns and MUST-CATCH fixtures are the literals it forbids' },
  { path: 'scripts/sweep-answer-page-css.mjs', reason: 'the retirement sweep itself: the literals ARE the left-hand side of its mapping table and its residual assertion' },
  { path: 'scripts/sweep-code-wells.mjs', reason: 'the retirement sweep itself: its header records the measured before/after colours' },
  { path: 'src/lib/off-origin-redirect.ts', reason: 'self-contained billing interstitial, links no stylesheet — a var() token cannot resolve there (Q-DST-7)' },
];

export function scanTargets(root = REPO_ROOT) {
  const out = [];
  const skipDir = new Set(['node_modules', 'audits', 'tests', 'dist', '.git']);
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDir.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (SCAN_EXT.includes(path.extname(ent.name))) out.push(p);
    }
  };
  for (const r of SCAN_ROOTS) walk(path.join(root, r));
  const allowed = new Set(ALLOW.map((a) => path.resolve(root, a.path)));
  return out.filter((f) => !allowed.has(path.resolve(f))).sort();
}

/** Hits in one text: literal matches + card-context `border-white/5` survivors. */
export function scanText(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const lit of LEGACY_LITERALS) {
      if (line.includes(lit)) hits.push({ line: i + 1, what: lit, sample: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(CLASS_ATTR_RE)) {
      const value = m[2] ?? m[3] ?? '';
      if (value.includes('border-white/5') && isCardContext(value)) {
        hits.push({ line: i + 1, what: 'card-context border-white/5', sample: value.slice(0, 120) });
      }
    }
  });
  return hits;
}

export function run({ root = REPO_ROOT } = {}) {
  const files = scanTargets(root);
  const findings = [];
  for (const f of files) {
    for (const h of scanText(fs.readFileSync(f, 'utf8'))) findings.push({ file: path.relative(root, f), ...h });
  }
  return { files, findings };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────
export function selfTest() {
  let failed = 0;
  const t = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (!pass) failed += 1;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  };
  // MUST-CATCH, each in the shape it really appears in:
  t('MUST-CATCH a card background literal', scanText(`  .card { background: ${hex('0f', '1526')}; }`).length, 1);
  t('MUST-CATCH a page background literal', scanText(`body { background: ${hex('06', '0a14')}; }`).length, 1);
  t('MUST-CATCH an answer-page hairline', scanText(`  th, td { border-bottom: 1px solid ${hex('1c', '2536')}; }`).length, 1);
  t('MUST-CATCH the sticky-nav hairline', scanText(`<nav style="border-bottom:1px solid ${hex('14', '1c2e')}">`).length, 1);
  t('MUST-CATCH the nav rgba', scanText(`style="background:rgba(${[6, 10, 20].join(',')},0.85)"`).length, 1);
  t('MUST-CATCH the pre-mint gold glow', scanText(`  .glow { box-shadow: 0 0 40px rgba(${[196, 163, 74].join(', ')}, 0.08); }`).length, 1);
  // …in the REAL token order: the context class precedes the border, which is why a lookahead
  // implementation of this rule matched 0 of 368 live sites.
  t('MUST-CATCH a card-context border in real token order',
    scanText('<a class="card-hover bg-navy-700 border border-white/5 rounded-xl p-5">').length, 1);
  t('MUST-CATCH a well-context border', scanText('<div class="code-block bg-well border border-white/5 rounded-lg p-4">').length, 1);
  // MUST-PASS: the nav/footer hairline is NOT a card and keeps border-white/5.
  t('MUST-PASS the nav hairline', scanText('<nav class="fixed top-0 w-full z-50 border-b border-white/5">').length, 0);
  t('MUST-PASS a tokenised card', scanText('<a class="card-hover bg-navy-700 border border-line rounded-xl p-5">').length, 0);
  t('MUST-PASS tokenised CSS', scanText('  .card { background: var(--surface); border: 1px solid var(--line); }').length, 0);
  // The allow-list is reasoned, not a blanket.
  t('every allow-list row carries a reason', ALLOW.every((a) => a.reason && a.reason.length > 20), true);
  console.log(`LEGACY_NAVY_SELFTEST_VERDICT=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const { files, findings } = run();
  if (files.length === 0) {
    console.error('zero files scanned — the corpus is empty, which is not the same as clean');
    console.log('LEGACY_NAVY_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  if (findings.length) {
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.what}  ${f.sample}`);
    console.error(`✗ ${findings.length} legacy literal(s) across ${new Set(findings.map((f) => f.file)).size} file(s).`);
    console.error('  Every one has a token: var(--bg) · var(--surface) · var(--bg-3) · var(--well) · var(--line), or border-line on a card.');
    console.log('LEGACY_NAVY_VERDICT=FAIL');
    process.exit(1);
  }
  console.log(`✓ check-legacy-navy-literals: ${files.length} file(s) scanned, 0 legacy literal(s). Allow-listed: ${ALLOW.map((a) => a.path).join(', ')}.`);
  console.log('LEGACY_NAVY_VERDICT=PASS');
}
