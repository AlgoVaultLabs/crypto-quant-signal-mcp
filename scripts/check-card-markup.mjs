#!/usr/bin/env node
// DESIGN-INTEGRATIONS-CARD-NESTED-ANCHOR-W1 — fail-closed canary: no card is an <a> inside an <a>.
//
//   node scripts/check-card-markup.mjs                    # 0 PASS · 1 FAIL · 3 INDETERMINATE
//   node scripts/check-card-markup.mjs --self-test        # MUST-CATCH + MUST-PASS fixtures, two-way
//   node scripts/check-card-markup.mjs --file <a.html>…   # scan ONLY these files (both legs)
//
// The /integrations exchange-kit grid rendered 20 children instead of 13: renderIndexCard()
// emitted each card as an <a> and, for the 7 kits with a demo, put the Demo <a> INSIDE it. An
// `a` element may not have an `a` descendant (WHATWG HTML §4.5.1), so the parser's adoption-
// agency algorithm closes the card at the inner link, ejects the footer <div> into the grid as a
// sibling and re-wraps the earlier content in a CLONE of the card anchor. No byte of the source
// is wrong-looking; the break only exists after parsing. Hence two legs:
//
//   leg 1 SOURCE — a tag-level scan of landing/**/*.html, docs-src/**/*.html and the rendered
//                  getAccountPageHtml(): any `<a` start tag while an `a` is open is a FAIL with
//                  file:line. Comments, <script> and <style> bodies are blanked first (newlines
//                  kept, so line numbers stay true): an anchor in a comment or a JS string is
//                  not markup.
//   leg 2 DOM    — every landing/**/*.html is parsed with jsdom (parse5: the same tree-builder,
//                  adoption agency included, that Chrome runs). For every element whose class
//                  list contains `grid` and whose FIRST element child is a `card-hover`, every
//                  element child must be a `card-hover`. A stray child is a FAIL naming the file,
//                  the grid's section id and the child's outerHTML head — i.e. what the browser
//                  actually built, whatever generator produced the bytes.
//
// Leg 1 also reads landing/skills.html, which algovault-skills bakes cross-repo from a template
// of the same shape — so a regression there fails HERE, in the repo that serves it.
//
// Verdict token: CARD_MARKUP_VERDICT / CARD_MARKUP_SELFTEST_VERDICT. Callers gate on the TOKEN.
// INDETERMINATE (3) — the token-law default for a new gate — when jsdom cannot be loaded, the
// account renderer is not built (dist/), or a corpus we were supposed to fill is empty: a scan
// that read nothing is never "clean".
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

export const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
export const SOURCE_ROOTS = ['landing', 'docs-src'];
export const DOM_ROOTS = ['landing'];
export const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'card-markup');
export const FIXTURES = ['nested-anchor.html', 'stray-div.html', 'fixed-card.html', 'clean-grid.html'];
const ACCOUNT_DIST = path.join(REPO_ROOT, 'dist', 'lib', 'account-handlers.js');
const RENDER_DIST = path.join(REPO_ROOT, 'dist', 'lib', 'integrations-data', 'render.js');
const EXCHANGE_KITS_DIST = path.join(REPO_ROOT, 'dist', 'lib', 'integrations-data', 'exchange-kits.js');

export function htmlFiles(roots, root = REPO_ROOT) {
  const out = [];
  const skipDir = new Set(['node_modules', '.git', 'dist']);
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDir.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.html')) out.push(p);
    }
  };
  for (const r of roots) walk(path.join(root, r));
  return out.sort();
}

// ── leg 1: source ────────────────────────────────────────────────────────────────────────────
/** Replace a match with spaces, keeping its newlines, so offsets → line numbers stay exact. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** Comments, <script> and <style> bodies are not markup. Raw-text elements end at their end tag. */
export function stripNonMarkup(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, blank);
}

// An <a> start or end tag. Quoted attribute values may contain '>' (onclick="a>b"), so the body
// alternates quoted strings and non-quote characters; the lookahead keeps <abbr>, <area>, <aside>
// and custom elements like <a-x> out.
const A_TAG_RE = /<(\/?)a(?=[\s>/])(?:"[^"]*"|'[^']*'|[^'">])*>/gi;

/** Every `<a` opened while another `a` is still open, as { line, sample }. */
export function nestedAnchors(html) {
  const text = stripNonMarkup(html);
  const hits = [];
  let depth = 0;
  for (const m of text.matchAll(A_TAG_RE)) {
    if (m[1] === '/') { depth = Math.max(0, depth - 1); continue; }
    if (m[0].endsWith('/>')) continue; // not valid HTML for <a>, but never an open element either
    if (depth > 0) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ line, sample: html.slice(m.index, m.index + 140).split('\n')[0].trim() });
    }
    depth += 1;
  }
  return hits;
}

// ── leg 2: DOM ───────────────────────────────────────────────────────────────────────────────
/** jsdom, or null when it cannot be loaded (→ INDETERMINATE, never a silent skip). */
export function loadJsdom() {
  try {
    return require('jsdom');
  } catch {
    return null;
  }
}

/** Stray children of card grids in one parsed document, as { section, head }. */
export function strayGridChildren(jsdom, html) {
  const dom = new jsdom.JSDOM(html, { virtualConsole: new jsdom.VirtualConsole() });
  try {
    const doc = dom.window.document;
    const out = [];
    for (const grid of doc.querySelectorAll('[class]')) {
      if (!grid.classList.contains('grid')) continue;
      const kids = [...grid.children];
      if (!kids.length || !kids[0].classList.contains('card-hover')) continue;
      for (const kid of kids) {
        if (kid.classList.contains('card-hover')) continue;
        const holder = grid.closest('section[id]') ?? grid.closest('[id]');
        out.push({
          section: holder ? holder.id : '(no id)',
          head: kid.outerHTML.replace(/\s+/g, ' ').slice(0, 140),
        });
      }
    }
    return out;
  } finally {
    dom.window.close();
  }
}

// ── corpus + run ─────────────────────────────────────────────────────────────────────────────
/** The fn-rendered account page, in both sign-in variants. null when dist/ is not built. */
export function renderedAccountPages() {
  if (!fs.existsSync(ACCOUNT_DIST)) return null;
  const { getAccountPageHtml } = require(ACCOUNT_DIST);
  if (typeof getAccountPageHtml !== 'function') return null;
  return [
    { file: 'getAccountPageHtml()', html: getAccountPageHtml() },
    { file: 'getAccountPageHtml({ unifiedSignin: true })', html: getAccountPageHtml({ unifiedSignin: true }) },
  ];
}

/**
 * Both legs over a corpus. `files` (absolute paths) replaces the default corpus entirely and is
 * read by BOTH legs; otherwise leg 1 reads SOURCE_ROOTS + the rendered account page and leg 2
 * reads DOM_ROOTS. Returns { verdict, reason?, sourceCount, domCount, nested, stray }.
 */
export function run({ root = REPO_ROOT, files = null, jsdom = loadJsdom(), account = undefined } = {}) {
  const rel = (f) => {
    const r = path.relative(root, f);
    return r && !r.startsWith('..') ? r : f; // a --file outside the tree keeps its own path
  };
  if (!jsdom) return { verdict: 'INDETERMINATE', reason: 'jsdom cannot be loaded (devDependency; run npm ci)', sourceCount: 0, domCount: 0, nested: [], stray: [] };
  let sources;
  let doms;
  if (files) {
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) return { verdict: 'INDETERMINATE', reason: `--file not found: ${missing.join(', ')}`, sourceCount: 0, domCount: 0, nested: [], stray: [] };
    sources = files.map((f) => ({ file: rel(f), html: fs.readFileSync(f, 'utf8') }));
    doms = sources;
  } else {
    const pages = account === undefined ? renderedAccountPages() : account;
    if (!pages) return { verdict: 'INDETERMINATE', reason: 'dist/lib/account-handlers.js missing — run npm run build', sourceCount: 0, domCount: 0, nested: [], stray: [] };
    sources = [...htmlFiles(SOURCE_ROOTS, root).map((f) => ({ file: rel(f), html: fs.readFileSync(f, 'utf8') })), ...pages];
    doms = htmlFiles(DOM_ROOTS, root).map((f) => ({ file: rel(f), html: fs.readFileSync(f, 'utf8') }));
  }
  if (sources.length === 0 || doms.length === 0) {
    return { verdict: 'INDETERMINATE', reason: `empty corpus (leg 1: ${sources.length} file(s), leg 2: ${doms.length} file(s)) — a scan that read nothing is not clean`, sourceCount: sources.length, domCount: doms.length, nested: [], stray: [] };
  }
  const nested = [];
  for (const s of sources) for (const h of nestedAnchors(s.html)) nested.push({ file: s.file, ...h });
  const stray = [];
  for (const d of doms) for (const h of strayGridChildren(jsdom, d.html)) stray.push({ file: d.file, ...h });
  return { verdict: nested.length || stray.length ? 'FAIL' : 'PASS', sourceCount: sources.length, domCount: doms.length, nested, stray };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────
export function selfTest() {
  const jsdom = loadJsdom();
  if (!jsdom) {
    console.error('jsdom cannot be loaded — the DOM leg cannot be exercised (run npm ci)');
    console.log('CARD_MARKUP_SELFTEST_VERDICT=INDETERMINATE');
    return EXIT.INDETERMINATE;
  }
  // The fixture corpus is CONSTRUCTED here, so an empty one is a defect in the test: refuse.
  const missing = FIXTURES.filter((f) => !fs.existsSync(path.join(FIXTURE_DIR, f)));
  if (missing.length) {
    console.error(`fixture(s) missing under tests/fixtures/card-markup/: ${missing.join(', ')}`);
    console.log('CARD_MARKUP_SELFTEST_VERDICT=FAIL');
    return EXIT.FAIL;
  }
  const fx = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  let failed = 0;
  let checks = 0;
  // An assertion that RAISES is not an assertion: a thrown subject reports FAIL, never aborts.
  const t = (name, fn) => {
    checks += 1;
    let res;
    try { res = fn(); } catch (e) { res = `threw: ${e && e.message}`; }
    const pass = res === true;
    if (!pass) failed += 1;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (${res})`}`);
  };

  // MUST-CATCH — leg 1 over the nested-anchor fixture, reported with its real line.
  const leg1 = nestedAnchors(fx('nested-anchor.html'));
  t('MUST-CATCH leg 1: a card <a> wrapping a Demo <a> (nested-anchor.html)', () => leg1.length === 1 || `got ${leg1.length} site(s)`);
  t('leg 1 reports the inner anchor\'s own line', () => (leg1[0] && leg1[0].line === 10) || `got line ${leg1[0] && leg1[0].line}`);
  // MUST-CATCH — leg 2 over a grid whose SOURCE children are all a.card-hover. The stray only
  // exists after parsing, so this proves leg 2 sees what the browser builds, not what we wrote.
  const strayHtml = fx('stray-div.html');
  t('stray-div.html: every grid child in the SOURCE is an a.card-hover (the stray is parser-made)', () => {
    const grid = strayHtml.slice(strayHtml.indexOf('<div class="grid'), strayHtml.lastIndexOf('</div>'));
    const opens = grid.match(/^ {4}<(\w+)/gm) || [];
    return (opens.length === 3 && opens.every((o) => o.endsWith('<a'))) || `source grid-level tags: ${opens.join(' ')}`;
  });
  const leg2 = strayGridChildren(jsdom, strayHtml);
  t('MUST-CATCH leg 2: the parser-ejected footer is a stray grid child (stray-div.html)', () => leg2.length === 1 || `got ${leg2.length} stray child(ren)`);
  t('leg 2 names the section and the ejected footer div', () =>
    (leg2[0] && leg2[0].section === 'connect-exchange-kit' && leg2[0].head.startsWith('<div class="flex items-center gap-3 text-xs">')) || JSON.stringify(leg2[0]));
  t('MUST-CATCH leg 2: a literal non-card child in a card grid', () =>
    strayGridChildren(jsdom, '<section id="s"><div class="grid"><div class="card-hover">a</div><div class="flex">b</div></div></section>').length === 1 || 'missed');
  t('MUST-CATCH leg 1: a nested anchor whose attribute value contains ">"', () =>
    nestedAnchors('<a href="/x" onclick="if(a>b)go()">x <a href="/y">y</a></a>').length === 1 || 'missed');

  // MUST-PASS — the fixed template and a clean grid, both legs.
  for (const name of ['fixed-card.html', 'clean-grid.html']) {
    const html = fx(name);
    t(`MUST-PASS leg 1: ${name}`, () => nestedAnchors(html).length === 0 || JSON.stringify(nestedAnchors(html)));
    t(`MUST-PASS leg 2: ${name}`, () => strayGridChildren(jsdom, html).length === 0 || JSON.stringify(strayGridChildren(jsdom, html)));
  }
  t('MUST-PASS leg 1: an <a> inside a comment, a <script> string or a <style> body is not markup', () =>
    nestedAnchors('<a href="/x">x <!-- <a href="/c"> --><script>var s = \'<a href="/s">\';</script><style>/* <a> */</style></a>').length === 0 || 'false positive');
  t('MUST-PASS leg 1: <abbr>, <area>, <aside> are not anchors', () =>
    nestedAnchors('<a href="/x"><abbr>A</abbr><aside>B</aside></a><area href="/y">').length === 0 || 'false positive');
  t('MUST-PASS leg 1: sibling anchors close before the next opens', () =>
    nestedAnchors('<a href="/1">1</a><a href="/2">2</a>\n<A HREF="/3">3</A>').length === 0 || 'false positive');

  // The REAL generator output — a hermetic fixture cannot see the template it stands in for.
  t('MUST-PASS both legs: the real renderIndexGrid(EXCHANGE_KITS) from dist/', () => {
    if (!fs.existsSync(RENDER_DIST) || !fs.existsSync(EXCHANGE_KITS_DIST)) return 'dist/ missing — run npm run build';
    const { renderIndexGrid } = require(RENDER_DIST);
    const kits = require(EXCHANGE_KITS_DIST).default;
    const html = `<section id="connect-exchange-kit"><div class="grid">\n${renderIndexGrid(kits)}\n</div></section>`;
    const a = nestedAnchors(html).length;
    const b = strayGridChildren(jsdom, html).length;
    return (a === 0 && b === 0) || `leg 1 ${a}, leg 2 ${b}`;
  });

  // The verdict machinery itself: corpus vacuity and the token→exit mapping.
  t('missing jsdom ⇒ INDETERMINATE', () => run({ jsdom: null }).verdict === 'INDETERMINATE' || 'not indeterminate');
  t('unbuilt account renderer ⇒ INDETERMINATE', () => run({ jsdom, account: null }).verdict === 'INDETERMINATE' || 'not indeterminate');
  t('empty corpus ⇒ INDETERMINATE, never PASS', () =>
    run({ jsdom, root: path.join(FIXTURE_DIR, '__no_such_tree__'), account: [] }).verdict === 'INDETERMINATE' || 'not indeterminate');
  t('--file corpus: nested-anchor + stray-div ⇒ FAIL on both legs', () => {
    const r = run({ jsdom, files: [path.join(FIXTURE_DIR, 'nested-anchor.html'), path.join(FIXTURE_DIR, 'stray-div.html')] });
    return (r.verdict === 'FAIL' && r.nested.length === 2 && r.stray.length === 1) || `${r.verdict} nested=${r.nested.length} stray=${r.stray.length}`;
  });
  t('--file corpus: fixed-card + clean-grid ⇒ PASS', () =>
    run({ jsdom, files: [path.join(FIXTURE_DIR, 'fixed-card.html'), path.join(FIXTURE_DIR, 'clean-grid.html')] }).verdict === 'PASS' || 'not pass');
  t('exit codes: PASS 0 · FAIL 1 · INDETERMINATE 3', () => (EXIT.PASS === 0 && EXIT.FAIL === 1 && EXIT.INDETERMINATE === 3) || JSON.stringify(EXIT));

  console.log(`${checks - failed}/${checks} self-test check(s) passed`);
  console.log(`CARD_MARKUP_SELFTEST_VERDICT=${failed === 0 && checks > 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 && checks > 0 ? EXIT.PASS : EXIT.FAIL;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parseFiles(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file' && argv[i + 1]) { files.push(path.resolve(argv[i + 1])); i += 1; }
    else if (argv[i].startsWith('--file=')) files.push(path.resolve(argv[i].slice(7)));
  }
  return files.length ? files : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  const r = run({ files: parseFiles(argv) });
  if (r.verdict === 'INDETERMINATE') {
    console.error(`check-card-markup: ${r.reason}`);
    console.log('CARD_MARKUP_VERDICT=INDETERMINATE');
    process.exit(EXIT.INDETERMINATE);
  }
  for (const n of r.nested) console.error(`  leg 1  ${n.file}:${n.line}  <a> opened inside an open <a>  ${n.sample}`);
  for (const s of r.stray) console.error(`  leg 2  ${s.file}  #${s.section}  stray grid child  ${s.head}`);
  if (r.verdict === 'FAIL') {
    console.error(`✗ ${r.nested.length} nested-anchor site(s) (leg 1) · ${r.stray.length} stray card-grid child(ren) (leg 2).`);
    console.error('  A card with a second tap target is a stretched-link card: <div class="card-hover … relative"> with');
    console.error('  a primary a.card-link (its ::after overlays the card) and an a.card-secondary above it —');
    console.error('  see landing/_design/algovault-design.css and renderIndexCard() in src/lib/integrations-data/render.ts.');
    console.log('CARD_MARKUP_VERDICT=FAIL');
    process.exit(EXIT.FAIL);
  }
  console.log(`✓ check-card-markup: leg 1 scanned ${r.sourceCount} source(s), leg 2 parsed ${r.domCount} page(s) — 0 nested anchors, 0 stray card-grid children.`);
  console.log('CARD_MARKUP_VERDICT=PASS');
}
