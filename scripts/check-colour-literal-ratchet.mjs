#!/usr/bin/env node
// @ts-check
/**
 * check-colour-literal-ratchet.mjs — DESIGN-THEME-UNIVERSAL-COVERAGE-W1 R2.
 *
 * A RATCHET on hand-written colour literals across every public surface.
 *
 * WHY A RATCHET AND NOT A BAN. DESIGN-SURFACE-TOKENS-W1 retired nine named navy literals and
 * gated them fail-closed, which stops those nine coming back and nothing else: a new page
 * painting #111827 or rgb(17,24,39) is invisible to that canary. Measured 2026-09-23 under the
 * counting rule below, the corpus carries 864 literals across 95 files (758 of them on the 57
 * landing pages that have any). A zero-tolerance gate over that is not shippable; a ratchet is,
 * and it converts a slab of debt into a monotone one. Same shape as ops/adapter-numeric-guard-baseline.json, which took its
 * own class from 195 to 43 precisely because the bleeding stopped first.
 *
 * THE COUNTING RULE, AND WHY IT IS CONTEXT-SCOPED. A literal is counted only where it PAINTS
 * something: inside a <style> block, inside a style="" attribute, or inside a Tailwind
 * arbitrary colour utility (`-[#…]`). It is NOT a whole-file grep, and that is load-bearing in
 * both directions:
 *   - the generated THEME region itself carries `steel: { 400: '#8b9bb5', … }` inside a
 *     <script> block, on all 58 landing pages. A whole-file rule would bill every page three
 *     literals it does not own and cannot fix — the region is generated from
 *     src/lib/site-theme.ts — and the gate would be measuring the generator, not the page;
 *   - <script type="application/ld+json"> bodies are excluded for the same reason: structured
 *     data is not paint.
 * (The wave spec's Objective quotes 1,536 literals in 57 files. That figure is a WHOLE-FILE
 * count and it reproduces EXACTLY — how-it-works 211 / docs 57 / integrations 47, same 57 files
 * — so it is a correct measurement of a different question. Under the Method's context rule,
 * which R2 prescribes and which this file implements, the same 57 landing pages measure 1,158;
 * excluding the generated regions as well brings them to 758. Each step removes bytes no page
 * author can act on, which is the only property that makes a ratchet worth obeying.)
 *
 * THE ONLY WAY UP IS A DATA FILE. `--write-baseline` LOWERS rows and never raises one, so
 * re-baselining after a cleanup can only tighten the gate. A row that must go up needs
 * `--allow-raise <path> --reason "<why>"`, which stores the reason and the date in
 * ops/colour-literal-baseline.json`.raises[]`. There is deliberately no env lever and no
 * automation path: a scaffolded page that inherits literals from a template prints this command
 * and stops, rather than quietly widening its own allowance.
 *
 * Verdict: exactly one terminal `COLOUR_LITERAL_RATCHET_VERDICT=PASS|FAIL|INDETERMINATE`, and
 * callers gate on the TOKEN, never the bare exit code.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate; do not
 * "align" it with check_test_baseline.sh's 2, which is 2 only because it already deployed 2).
 * FAIL-CLOSED: a missing or unparseable baseline, and an empty corpus, are INDETERMINATE.
 *
 * Usage:
 *   node scripts/check-colour-literal-ratchet.mjs                    # enforce (default)
 *   node scripts/check-colour-literal-ratchet.mjs --self-test
 *   node scripts/check-colour-literal-ratchet.mjs --write-baseline   # lower rows only
 *   node scripts/check-colour-literal-ratchet.mjs --allow-raise landing/x.html --reason "…"
 */

import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
export const BASELINE_REL = path.join('ops', 'colour-literal-baseline.json');
const TOKEN = 'COLOUR_LITERAL_RATCHET_VERDICT';

/** Globs over rendered surfaces. */
export const CORPUS_GLOBS = ['landing/**/*.html', 'docs-src/**/*.html'];

/**
 * Every generator that emits HTML from template strings: the six the wave spec names, plus the
 * four region SoTs (see the comment inside). Named explicitly rather than globbed — `scripts/**`
 * also holds this file and the retirement sweeps, whose source IS the literals they forbid, and
 * a gate that scans itself reports its own fixtures forever.
 */
export const PRODUCERS = [
  'scripts/render-integrations.mjs',
  'scripts/build_channel_pages.mjs',
  'scripts/build_tools_page.mjs',
  'scripts/render-jsx-static.mjs',
  'src/index.ts',
  'src/lib/account-handlers.ts',
  // The four region SoTs. They are here for the same reason the generated regions below are
  // EXCLUDED from the pages: a literal a generator writes into 58 marked regions is ONE literal
  // authored in one place, and billing it 58 times measures the generator's reach rather than
  // any page's debt — while billing it nowhere would lose it. Counted once, where it is fixable.
  // (Live example: renderNavRegion() emits `rgba(0,0,0,0.7)` twice in a box-shadow, so before
  // this split every nav-bearing page carried 2 literals no page author could remove, and every
  // freshly scaffolded page would have been born at 2.)
  'src/lib/site-nav.ts',
  'src/lib/site-theme.ts',
  'src/lib/analytics-snippet.ts',
  'src/lib/footer-content.ts',
];

/**
 * Marker pairs whose CONTENT is written by a generator, not by the page. Their bytes belong to
 * the SoT modules listed in PRODUCERS above.
 */
export const GENERATED_REGIONS = ['THEME', 'NAV', 'ANALYTICS', 'CONVERSION-BAND'];

/** A colour literal: hex 3-8 digits, or the opening of an rgb()/rgba()/hsl()/hsla() call. */
export const LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;

/**
 * Drop what is not paint, then drop comments.
 *
 * Order matters: ld+json first (it is delimited by a <script> tag that the comment strippers
 * do not understand), then HTML comments, then JS/CSS block comments, then line comments.
 * The line-comment rule refuses to fire after a `:` so that `https://` survives — a naive
 * `//.*$` deletes the rest of every line carrying a URL, and half this corpus is URLs.
 */
export function stripNonPaint(text) {
  let s = text.replace(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '');
  // Generated regions BEFORE comments: the markers ARE comments, so stripping comments first
  // would dissolve the delimiters and leave the generated bytes behind, billed to the page.
  for (const name of GENERATED_REGIONS) {
    s = s.replace(new RegExp(`<!--\\s*${name}:START\\s*-->[\\s\\S]*?<!--\\s*${name}:END\\s*-->`, 'g'), '');
  }
  s = s.replace(/<footer\b[^>]*data-av-brand-footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.split('\n').map((l) => l.replace(/(^|[^:\w"'`\\])\/\/.*$/, '$1')).join('\n');
  return s;
}

/**
 * The three contexts in which a literal paints something. Returned as raw strings so the
 * counter is one regex over one list — the single-derivation shape, so `--check`,
 * `--write-baseline` and `--allow-raise` can never disagree about what a literal is.
 */
export function paintContexts(text) {
  const out = [];
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(m[1]);
  for (const m of text.matchAll(/style\s*=\s*"([^"]*)"/gi)) out.push(m[1]);
  for (const m of text.matchAll(/style\s*=\s*'([^']*)'/gi)) out.push(m[1]);
  for (const m of text.matchAll(/-\[(#[^\]\s]*)\]/g)) out.push(m[1]);
  return out;
}

/** @param {string} text @returns {number} colour literals that paint something */
export function countLiterals(text) {
  let n = 0;
  for (const ctx of paintContexts(stripNonPaint(text))) n += (ctx.match(LITERAL_RE) || []).length;
  return n;
}

/** Every corpus file, repo-relative and POSIX-separated, sorted — never iteration order. */
export function corpusFiles(root = REPO_ROOT) {
  const set = new Set();
  for (const g of CORPUS_GLOBS) {
    for (const p of globSync(g, { cwd: root })) set.add(p.split(path.sep).join('/'));
  }
  for (const p of PRODUCERS) if (existsSync(path.join(root, p))) set.add(p);
  return [...set].sort();
}

/** @returns {Record<string, number>} per-file counts over the whole corpus. */
export function measure(root = REPO_ROOT) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const rel of corpusFiles(root)) out[rel] = countLiterals(readFileSync(path.join(root, rel), 'utf8'));
  return out;
}

/**
 * The ratchet comparison. A file with no row has an implicit baseline of 0 — a NEW page must
 * be born clean, which is the whole point: the scaffold emits one that is.
 * @returns {{over: {path:string,count:number,baseline:number}[], under: {path:string,count:number,baseline:number}[]}}
 */
export function compare(current, baseline) {
  const over = [];
  const under = [];
  for (const [rel, n] of Object.entries(current)) {
    const b = rel in baseline ? baseline[rel] : 0;
    if (n > b) over.push({ path: rel, count: n, baseline: b });
    else if (n < b) under.push({ path: rel, count: n, baseline: b });
  }
  over.sort((a, b) => (b.count - b.baseline) - (a.count - a.baseline) || a.path.localeCompare(b.path));
  under.sort((a, b) => a.path.localeCompare(b.path));
  return { over, under };
}

/**
 * `--write-baseline` may only LOWER. A row rewritten upward would silently launder whatever
 * regression prompted the rewrite, which is precisely the escape hatch `--allow-raise` exists
 * to make visible and reasoned.
 */
export function lowerOnly(current, baseline, { seed = false } = {}) {
  const next = { ...baseline };
  const lowered = [];
  const refused = [];
  for (const [rel, n] of Object.entries(current)) {
    const b = rel in baseline ? baseline[rel] : 0;
    if (n < b) { next[rel] = n; lowered.push({ path: rel, from: b, to: n }); }
    // SEED is the one-time bootstrap: there is no prior baseline to lower toward, so the
    // current tree IS the baseline. It is gated on BOTH the file being absent AND an explicit
    // --seed flag, because "delete the committed baseline and re-run the writer" would
    // otherwise be a silent way to re-baseline a regression upward — the zeroed-comparator
    // shape this repo has already paid for once.
    else if (n > b) { if (seed) next[rel] = n; else refused.push({ path: rel, from: b, to: n }); }
    else if (!(rel in baseline)) next[rel] = n; // a new file at 0 gets its row, which is 0
  }
  // A row whose file has left the corpus is dead weight — drop it so the baseline cannot
  // resurrect an allowance for a path that comes back later.
  for (const rel of Object.keys(next)) if (!(rel in current)) delete next[rel];
  return { next, lowered, refused };
}

/**
 * Validate an `--allow-raise` request. Returns the row to store, or the reason to refuse.
 * @returns {{ok:true,row:object}|{ok:false,why:string}}
 */
export function planRaise({ target, reason, current, baseline, today }) {
  if (!target) return { ok: false, why: '--allow-raise needs a path' };
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    return { ok: false, why: `--allow-raise ${target} needs --reason "<why this file may carry more colour literals>" (at least 10 characters)` };
  }
  if (!(target in current)) return { ok: false, why: `--allow-raise ${target} names a file that is not in the corpus` };
  const from = target in baseline ? baseline[target] : 0;
  const to = current[target];
  if (to <= from) return { ok: false, why: `--allow-raise ${target}: count ${to} does not exceed baseline ${from} — nothing to raise` };
  return { ok: true, row: { path: target, from, to, reason: reason.trim(), date: today } };
}

/**
 * The whole `--check` decision over one root, as a PURE function of (tree, baseline file).
 * Exported so a test can drive the real verdict path against a temp root — the CLI below is a
 * thin shell over it, and there is deliberately no env lever that could make a seam print PASS.
 *
 * @returns {{verdict:'PASS'|'FAIL'|'INDETERMINATE', why:string, over:object[], under:object[], total:number, scanned:number, raises:object[]}}
 */
export function evaluate(root = REPO_ROOT) {
  const no = (verdict, why) => ({ verdict, why, over: [], under: [], total: 0, scanned: 0, raises: [] });
  const current = measure(root);
  const scanned = Object.keys(current).length;
  if (scanned === 0) return no('INDETERMINATE', 'zero corpus files — this repo authors these pages, so an empty corpus means the derivation matched nothing');
  const p = path.join(root, BASELINE_REL);
  if (!existsSync(p)) return no('INDETERMINATE', `baseline missing at ${BASELINE_REL} — run --write-baseline --seed and commit it`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { return no('INDETERMINATE', `${BASELINE_REL} is not valid JSON: ${e.message}`); }
  if (!parsed || typeof parsed.counts !== 'object' || parsed.counts === null || Array.isArray(parsed.counts)) {
    return no('INDETERMINATE', `${BASELINE_REL} has no usable \`counts\` object`);
  }
  if (!Array.isArray(parsed.raises)) return no('INDETERMINATE', `${BASELINE_REL} has no \`raises\` array`);
  const { over, under } = compare(current, parsed.counts);
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  return {
    verdict: over.length ? 'FAIL' : 'PASS',
    why: over.length ? `${over.length} file(s) exceed the committed baseline` : '',
    over, under, total, scanned, raises: parsed.raises,
  };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────

export function selfTest() {
  const results = [];
  const t = (name, actual, expected) => {
    // Wrapped so a throwing subject reports FAIL rather than aborting the suite: an assertion
    // that raises is not an assertion.
    let got;
    try { got = typeof actual === 'function' ? actual() : actual; } catch (e) { got = `THREW: ${e && e.message}`; }
    const pass = JSON.stringify(got) === JSON.stringify(expected);
    results.push(pass);
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(expected)})`}`);
  };

  // ── the counting rule ──────────────────────────────────────────────────────────────────
  t('counts a hex in a <style> block', countLiterals('<style>body { color: #112233; }</style>'), 1);
  t('counts a hex in a style="" attribute', countLiterals('<p style="color:#abc">x</p>'), 1);
  t("counts a hex in a style='' attribute", countLiterals("<p style='color:#abcdef'>x</p>"), 1);
  t('counts rgb() and rgba() and hsl()', countLiterals('<style>a{color:rgb(1,2,3);background:rgba(1,2,3,.5);border-color:hsl(1,2%,3%)}</style>'), 3);
  t('counts a Tailwind arbitrary colour utility', countLiterals('<div class="bg-[#123456] text-[#fff]"></div>'), 2);
  t('IGNORES a literal outside a paint context (the generated region\'s steel palette)',
    countLiterals("<script>tailwind.config={colors:{steel:{400:'#8b9bb5'}}}</script>"), 0);
  // The fixture has to put the literal in a PAINT context inside the ld+json body, or the
  // assertion is vacuous — a bare `{"c":"#112233"}` scores 0 whether the exclusion runs or
  // not, and mutation testing showed exactly that: deleting the exclusion left the leg green.
  // The fixture has to put the literal in a PAINT context that survives JSON encoding, or the
  // assertion is vacuous — mutation testing caught two vacuous drafts of this one leg. A bare
  // `{"c":"#112233"}` scores 0 whether the exclusion runs or not, and a JSON-escaped `style=\"…\"`
  // does too (the attribute regex wants a real quote). A SINGLE-quoted attribute needs no JSON
  // escaping, so it appears verbatim, is matched, and the leg finally means something.
  {
    const body = `{"articleBody":"<p style='color:#112233'>x</p>"}`;
    t('IGNORES an ld+json body', countLiterals(`<script type="application/ld+json">${body}</script>`), 0);
    t('…and the SAME bytes outside ld+json are counted (so the leg is not vacuous)', countLiterals(body), 1);
  }
  t('IGNORES an HTML comment', countLiterals('<!-- <style>a{color:#112233}</style> -->'), 0);
  t('IGNORES a CSS comment inside a <style> block', countLiterals('<style>/* was #112233 */ a{color:var(--fg)}</style>'), 0);
  t('IGNORES a JS line comment', countLiterals('const x = 1; // style="color:#112233"'), 0);
  t('a URL is not a line comment', countLiterals('<a href="https://x.test/" style="color:#112233">y</a>'), 1);
  t('a var() token is not a literal', countLiterals('<style>body { background: var(--bg); color: var(--fg-2); }</style>'), 0);

  // Generated regions belong to their SoT module, not to the page that hosts them.
  {
    const inner = '<div style="box-shadow:0 20px 60px -12px rgba(0,0,0,0.7)"></div>';
    t('IGNORES the content of a generated NAV region', countLiterals(`<!-- NAV:START -->${inner}<!-- NAV:END -->`), 0);
    t('IGNORES the content of a generated THEME region', countLiterals(`<!-- THEME:START --><style>a{color:#112233}</style><!-- THEME:END -->`), 0);
    t('IGNORES the brand-footer element', countLiterals('<footer data-av-brand-footer="desktop" style="color:#112233"></footer>'), 0);
    t('…and the SAME bytes outside any region are counted (so the legs are not vacuous)', countLiterals(inner), 1);
    t('a page\'s own markup AFTER a generated region is still counted',
      countLiterals(`<!-- NAV:START -->${inner}<!-- NAV:END --><p style="color:#112233">x</p>`), 1);
  }
  t('an oklch() channel reference is not a literal', countLiterals('<nav style="background:oklch(var(--bg-lch, 0.16 0.012 265) / 0.85)"></nav>'), 0);

  // ── LEG 1 — MUST-CATCH a fixture whose count EXCEEDS its baseline ──────────────────────
  {
    const current = { 'landing/faq.html': 4 };
    const { over, under } = compare(current, { 'landing/faq.html': 3 });
    t('(1) MUST-CATCH a count over baseline', [over.map((o) => o.path), under.length], [['landing/faq.html'], 0]);
    // The boundary. Found by MUTATION, not by reading: flipping `n > b` to `n >= b` left every
    // other leg here green, because none of them held a count EQUAL to its baseline. An
    // unchanged file is the commonest state in the corpus, so a gate that flags it is a gate
    // that gets switched off.
    const same = compare({ 'landing/faq.html': 3 }, { 'landing/faq.html': 3 });
    t('(1) MUST-PASS an UNCHANGED count (the >= boundary)', [same.over.length, same.under.length], [0, 0]);
    const zero = compare({ 'landing/clean.html': 0 }, {});
    t('(1) MUST-PASS a clean new file with no row', [zero.over.length, zero.under.length], [0, 0]);
  }

  // ── LEG 2 — MUST-CATCH a NEW file carrying 1 literal and no baseline row ───────────────
  {
    const n = countLiterals('<!DOCTYPE html><html><head><style>body{background:#111827}</style></head><body></body></html>');
    const { over } = compare({ 'landing/brand-new.html': n }, { 'landing/faq.html': 3 });
    t('(2) the new page measures 1 literal', n, 1);
    t('(2) MUST-CATCH a new file with no row (implicit baseline 0)',
      over.map((o) => `${o.path}:${o.count}>${o.baseline}`), ['landing/brand-new.html:1>0']);
  }

  // ── LEG 3 — MUST-PASS a LOWERED count, and the re-baseline may only go down ────────────
  {
    const { over, under } = compare({ 'landing/faq.html': 1 }, { 'landing/faq.html': 3 });
    t('(3) MUST-PASS a lowered count', [over.length, under.map((u) => u.path)], [0, ['landing/faq.html']]);
    const low = lowerOnly({ 'landing/faq.html': 1, 'landing/new.html': 0 }, { 'landing/faq.html': 3 });
    t('(3) --write-baseline lowers the row', low.next['landing/faq.html'], 1);
    t('(3) --write-baseline gives a clean new file a 0 row', low.next['landing/new.html'], 0);
    const up = lowerOnly({ 'landing/faq.html': 9 }, { 'landing/faq.html': 3 });
    t('(3) MUST-REFUSE: --write-baseline never raises a row', [up.next['landing/faq.html'], up.refused.map((r) => r.path)], [3, ['landing/faq.html']]);
    const gone = lowerOnly({ 'landing/faq.html': 1 }, { 'landing/faq.html': 3, 'landing/deleted.html': 7 });
    t('(3) --write-baseline drops a row whose file has left the corpus', 'landing/deleted.html' in gone.next, false);
    // The one-time bootstrap, and the reason it is a separate flag rather than a fallback.
    const seeded = lowerOnly({ 'landing/faq.html': 9 }, {}, { seed: true });
    t('(3) --seed records the current tree as the baseline', [seeded.next['landing/faq.html'], seeded.refused.length], [9, 0]);
    t('(3) …and WITHOUT --seed the same call refuses instead', lowerOnly({ 'landing/faq.html': 9 }, {}).refused.map((r) => r.path), ['landing/faq.html']);
  }

  // ── LEG 4 — MUST-CATCH `--allow-raise` without a `--reason` ────────────────────────────
  {
    const current = { 'landing/faq.html': 5 };
    const baseline = { 'landing/faq.html': 3 };
    const args = { target: 'landing/faq.html', current, baseline, today: '2026-09-23' };
    t('(4) MUST-CATCH --allow-raise with no --reason', planRaise({ ...args, reason: undefined }).ok, false);
    t('(4) MUST-CATCH --allow-raise with a token --reason', planRaise({ ...args, reason: 'wip' }).ok, false);
    t('(4) MUST-CATCH --allow-raise naming a file outside the corpus',
      planRaise({ ...args, target: 'landing/nope.html', reason: 'a properly stated reason' }).ok, false);
    t('(4) MUST-CATCH --allow-raise that does not actually raise',
      planRaise({ ...args, current: { 'landing/faq.html': 3 }, reason: 'a properly stated reason' }).ok, false);
    const ok = planRaise({ ...args, reason: 'inherited from a baselined template; tokenising it is a design wave' });
    t('(4) MUST-PASS a reasoned raise, recording from/to/reason/date',
      ok.ok && [ok.row.path, ok.row.from, ok.row.to, ok.row.date, ok.row.reason.length > 10],
      ['landing/faq.html', 3, 5, '2026-09-23', true]);
  }

  // ── the seam this suite would otherwise be blind to: the REAL corpus derivation ────────
  {
    const files = corpusFiles();
    t('corpus is non-empty', files.length > 0, true);
    t('corpus includes the landing pages', files.some((f) => f.startsWith('landing/') && f.endsWith('.html')), true);
    t('corpus includes every named producer', PRODUCERS.every((p) => files.includes(p)), true);
    t('corpus EXCLUDES this gate\'s own source (it would report its own fixtures)', files.includes('scripts/check-colour-literal-ratchet.mjs'), false);
    t('corpus derivation is sorted (order-independent)', files.join() === [...files].sort().join(), true);
  }

  const failed = results.filter((r) => !r).length;
  console.log(`COLOUR_LITERAL_RATCHET_SELFTEST_VERDICT=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────

function emit(v, why) {
  if (why) console.log(`${v === 'PASS' ? 'ℹ' : '✖'} ${why}`);
  console.log(`${TOKEN}=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

/** Read `--flag value` out of argv. */
export function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? '' : v;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);

  if (argv.includes('--self-test')) process.exit(selfTest());

  // The self-test guards the gate: if the counting rule is broken, the gate has verified
  // nothing, and that is INDETERMINATE rather than a pass over a broken instrument.
  const stFailed = (() => {
    const log = console.log;
    console.log = () => {};
    try { return selfTest(); } finally { console.log = log; }
  })();
  if (stFailed) emit('INDETERMINATE', 'self-test failed — re-run with --self-test; the counting rule is broken');

  const baselinePath = path.join(REPO_ROOT, BASELINE_REL);
  const current = measure();
  if (Object.keys(current).length === 0) emit('INDETERMINATE', 'zero corpus files — this repo authors these pages, so an empty corpus means the derivation matched nothing');

  const DOC = [
    'DESIGN-THEME-UNIVERSAL-COVERAGE-W1 R2 — the colour-literal ratchet baseline.',
    'Per-file count of hex / rgb() / rgba() / hsl() / hsla() literals that PAINT something:',
    'inside a <style> block, inside a style="" attribute, or inside a Tailwind arbitrary colour',
    'utility (-[#…]). Comments and <script type="application/ld+json"> bodies are excluded, and',
    'so is every literal outside those three contexts — notably the generated THEME region\'s own',
    'steel palette, which lives in a <script> block on all 58 landing pages and is owned by',
    'src/lib/site-theme.ts rather than by any page.',
    '',
    'A file may never EXCEED its number. `--write-baseline` LOWERS rows and never raises one, so',
    'a cleanup locks in and a regression cannot be laundered by re-running the writer. The ONLY',
    'way up is `--allow-raise <path> --reason "<why>"`, which appends to raises[] below with the',
    'date — so an allowance always has an argument attached to it.',
    '',
    'New pages should be born at 0: node scripts/new-landing-page.mjs --slug <slug> --title "…"',
    '--description "…" emits a skeleton carrying the theme region, the loader and zero literals.',
  ];

  if (argv.includes('--write-baseline')) {
    const wantSeed = argv.includes('--seed');
    if (wantSeed && existsSync(baselinePath)) {
      emit('FAIL', `--seed refused: ${BASELINE_REL} already exists. Seeding is a ONE-TIME bootstrap; to raise a row use --allow-raise <path> --reason "…"`);
    }
    if (!wantSeed && !existsSync(baselinePath)) {
      emit('INDETERMINATE', `${BASELINE_REL} does not exist. The first write is a bootstrap and must say so: --write-baseline --seed`);
    }
    const prev = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : { counts: {}, raises: [] };
    if (wantSeed) {
      console.log('⚠ SEEDING a new baseline from the current tree. Every count below becomes DECLARED DEBT,');
      console.log('  not coverage. Review the diff: whatever lands here is what the ratchet will defend.');
    }
    const { next, lowered, refused } = lowerOnly(current, prev.counts || {}, { seed: wantSeed });
    writeFileSync(baselinePath, `${JSON.stringify({ _doc: DOC, _total: Object.values(next).reduce((a, b) => a + b, 0), counts: next, raises: prev.raises || [] }, null, 2)}\n`);
    for (const l of lowered) console.log(`  lowered ${l.path}: ${l.from} -> ${l.to}`);
    if (refused.length) {
      console.error(`✖ ${refused.length} row(s) NOT raised — --write-baseline only lowers:`);
      for (const r of refused) console.error(`   - ${r.path}: ${r.from} -> ${r.to} (use --allow-raise ${r.path} --reason "…")`);
    }
    console.log(`baseline written: ${Object.keys(next).length} file(s), ${Object.values(next).reduce((a, b) => a + b, 0)} literal(s), ${lowered.length} lowered, ${refused.length} refused.`);
    process.exit(refused.length ? 1 : 0);
  }

  if (argv.includes('--allow-raise')) {
    if (!existsSync(baselinePath)) emit('INDETERMINATE', `baseline missing at ${BASELINE_REL} — run --write-baseline --seed and commit it`);
    let parsed;
    try { parsed = JSON.parse(readFileSync(baselinePath, 'utf8')); }
    catch (e) { emit('INDETERMINATE', `${BASELINE_REL} is not valid JSON: ${e.message}`); }
    if (!parsed || typeof parsed.counts !== 'object' || parsed.counts === null || Array.isArray(parsed.counts)) {
      emit('INDETERMINATE', `${BASELINE_REL} has no usable \`counts\` object`);
    }
    if (!Array.isArray(parsed.raises)) emit('INDETERMINATE', `${BASELINE_REL} has no \`raises\` array`);
    const baseline = parsed.counts;
    const plan = planRaise({
      target: flagValue(argv, '--allow-raise'),
      reason: flagValue(argv, '--reason'),
      current,
      baseline,
      today: new Date().toISOString().slice(0, 10),
    });
    if (!plan.ok) emit('FAIL', plan.why);
    baseline[plan.row.path] = plan.row.to;
    parsed.raises.push(plan.row);
    parsed._doc = DOC;
    parsed._total = Object.values(baseline).reduce((a, b) => a + b, 0);
    writeFileSync(baselinePath, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log(`✓ raise recorded: ${plan.row.path} ${plan.row.from} -> ${plan.row.to}`);
    console.log(`  reason: ${plan.row.reason}`);
    emit('PASS', `${BASELINE_REL} updated — commit it with the change that needed it`);
  }

  // The CLI is a thin shell over evaluate() — one decision site, so the verdict a test drives
  // against a temp root is the same verdict CI gets.
  const { verdict, why, over, under, total, scanned, raises } = evaluate();
  if (verdict === 'INDETERMINATE') emit('INDETERMINATE', why);

  if (over.length) {
    console.error(`✖ colour literals INCREASED in ${over.length} file(s) — top ${Math.min(10, over.length)}:`);
    for (const o of over.slice(0, 10)) console.error(`   - ${o.path}: ${o.count} literal(s) > baseline ${o.baseline} (+${o.count - o.baseline})`);
    if (over.length > 10) console.error(`   … and ${over.length - 10} more`);
    console.error('');
    console.error('  Every surface colour on a public page comes from the generated THEME region and');
    console.error('  landing/_design/algovault-design.css :root — var(--bg) · var(--surface) · var(--bg-3)');
    console.error('  · var(--well) · var(--line) · var(--fg…), or a palette utility.');
    console.error(`  A genuinely unavoidable literal needs an argument, not a pass:`);
    console.error(`    node scripts/check-colour-literal-ratchet.mjs --allow-raise ${over[0].path} --reason "<why>"`);
    emit('FAIL', why);
  }

  if (under.length) {
    console.log(`✓ ratchet TIGHTENED — ${under.length} file(s) now below baseline:`);
    for (const u of under.slice(0, 10)) console.log(`   - ${u.path}: ${u.count} < ${u.baseline}`);
    if (under.length > 10) console.log(`   … and ${under.length - 10} more`);
    console.log('  Lock it in: node scripts/check-colour-literal-ratchet.mjs --write-baseline');
  }
  console.log(`✓ colour-literal ratchet: no file exceeds its baseline (${scanned} file(s) scanned, ${total} literal(s) outstanding, ${raises.length} recorded raise(s)).`);
  console.log('  This gate stops NEW literals. The outstanding count is DECLARED DEBT, not coverage.');
  emit('PASS');
}
