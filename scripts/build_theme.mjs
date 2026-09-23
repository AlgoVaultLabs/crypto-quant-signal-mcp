#!/usr/bin/env node
// DESIGN-SURFACE-TOKENS-W1 CH1 — build-time theme-region injector + drift canary.
//
//   node scripts/build_theme.mjs              # write: migrate un-migrated pages, inject the region
//   node scripts/build_theme.mjs --check      # CI: 0 in sync · 1 drift/un-migrated/missing loader · 3 indeterminate
//   node scripts/build_theme.mjs --self-test  # hermetic legs (a)-(g), two-way
//
// Renders the ONE canonical Tailwind theme region (src/lib/site-theme.ts renderThemeRegion(),
// compiled to dist/) between `<!-- THEME:START -->` / `<!-- THEME:END -->` on every landing
// page + docs-src/template.html. Same contract as build_nav.mjs: the renderer returns the
// INNER content, this file owns the markers, so a region can never accumulate markers.
//
// MIGRATION IS TWO ANCHORED EDITS, NEVER A SPAN (measured, Plan Mode 2026-09-22)
// -----------------------------------------------------------------------------
// The `<script src=cdn>` tag and the `<script>tailwind.config = {…}</script>` block are
// ADJACENT IN 0 OF 56 HTML TARGETS: the canonical design loader sits between them in every
// one, plus track-record-proxy on 50, JSON-LD on 26 and the whole ANALYTICS region on 26. A
// `<script src=…></script>…<script>tailwind.config…</script>` span replace — the shape the
// first version of this wave's spec asked for — would have DELETED all of it, starting with
// the stylesheet the region's own CSS variables come from. So: delete the unpinned CDN line
// in place, replace only the config element, each asserted exactly once, file untouched on
// anything else. Leg (d) pins that with an integrations-shaped fixture.
//
// Verdict tokens (fail closed): THEME_SYNC_VERDICT / THEME_SELFTEST_VERDICT, one terminal
// line each; callers gate on the TOKEN, never the bare exit code. INDETERMINATE = 3 (the
// token-law default for a new gate): missing dist/, zero targets, or a missing tailwindcss
// binary for leg (f) — never a pass.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

export const THEME_START = '<!-- THEME:START -->';
export const THEME_END = '<!-- THEME:END -->';
/** A page carrying either signature outside the markers is un-migrated. */
export const LEGACY_CDN_TAG = '<script src="https://cdn.tailwindcss.com"></script>';
export const CONFIG_SIG = 'tailwind.config';
export const LOADER_LINK = '/_design/algovault-design.css';
export const LOADER_END = '<!-- END: AlgoVault canonical design loader -->';

/** The canonical region (inner content, no markers). Lazy so importers can stub. */
export function renderThemeRegion() {
  const { renderThemeRegion: render } = require(path.join(REPO_ROOT, 'dist', 'lib', 'site-theme.js'));
  return render();
}

/** Replace the content between the markers. Pure + idempotent (markers preserved, never doubled). */
export function applyRegion(html, region) {
  const s = html.indexOf(THEME_START);
  const e = html.indexOf(THEME_END);
  if (s === -1 || e === -1 || e < s) return { marked: false, html };
  const before = html.slice(0, s);
  const after = html.slice(e + THEME_END.length);
  return { marked: true, html: `${before}${THEME_START}\n${region}\n${THEME_END}${after}` };
}

/** Recursively list every *.html under a dir. */
export function listHtml(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listHtml(p));
    else if (ent.isFile() && ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** Every `<script>` element whose body assigns `tailwind.config`, as [start,end) spans. */
export function findConfigBlocks(html) {
  const spans = [];
  const re = /<script>\s*[\r\n]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const bodyStart = m.index;
    const close = html.indexOf('</script>', bodyStart);
    if (close === -1) continue;
    const body = html.slice(bodyStart, close);
    if (/(^|[\r\n])\s*tailwind\.config\s*=/.test(body)) spans.push([bodyStart, close + '</script>'.length]);
  }
  return spans;
}

/**
 * Two anchored edits, each asserted exactly once. Returns { ok, html, reason }.
 * Shape 1 (54 pages + 2 templates): CDN line ×1 + config block ×1 → delete the line, replace
 *   the block with the marked region AT THE CONFIG SITE (after the loader).
 * Shape 2 (privacy.html, terms.html): CDN line ×1, no config → delete the line, insert the
 *   marked region immediately after the loader's END comment.
 * Anything else: untouched, ok=false — a shape this function has not been proven on must
 * never be edited by guesswork.
 */
export function migrateLegacyBlock(html, region) {
  if (html.includes(THEME_START)) return { ok: false, html, reason: 'already marked' };
  const lineRe = /^[ \t]*<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>[ \t]*\r?\n/gm;
  const cdnHits = html.match(lineRe) || [];
  if (cdnHits.length !== 1) return { ok: false, html, reason: `expected exactly 1 unpinned CDN line, found ${cdnHits.length}` };
  const blocks = findConfigBlocks(html);
  if (blocks.length > 1) return { ok: false, html, reason: `expected at most 1 tailwind.config block, found ${blocks.length}` };
  const block = `${THEME_START}\n${region}\n${THEME_END}`;
  let next = html.replace(lineRe, '');
  if (blocks.length === 1) {
    const stripped = findConfigBlocks(next);
    if (stripped.length !== 1) return { ok: false, html, reason: 'config block not re-locatable after CDN removal' };
    const [s, e] = stripped[0];
    next = next.slice(0, s) + block + next.slice(e);
    return { ok: true, html: next, reason: 'config-site migration' };
  }
  const anchors = next.split(LOADER_END).length - 1;
  if (anchors !== 1) return { ok: false, html, reason: `no config block and ${anchors} loader anchors — unknown shape` };
  next = next.replace(LOADER_END, `${LOADER_END}\n${block}`);
  return { ok: true, html: next, reason: 'cdn-only migration' };
}

/** The target set: every landing page plus the docs template, deduped. */
export function targets(root = REPO_ROOT) {
  const set = new Set([...listHtml(path.join(root, 'landing')), path.join(root, 'docs-src', 'template.html')]);
  return [...set].filter((f) => fs.existsSync(f)).sort();
}

/**
 * @returns {{changed, drifted, missingMarker, missingLoader, migrated, refused, targets}}
 *   drifted        = marked files whose region != freshly rendered
 *   missingMarker  = files carrying a Tailwind signature outside the markers (un-migrated)
 *   missingLoader  = marked files that do not link the design stylesheet (their var() twins
 *                    would have nothing to resolve against — fallbacks cover the colour, but
 *                    a marked page without the sheet has lost the whole design system)
 *   refused        = files whose shape migrateLegacyBlock would not touch
 */
export function run({ check = false, root = REPO_ROOT, region = null } = {}) {
  const theRegion = region ?? renderThemeRegion();
  const files = targets(root);
  const changed = [];
  const drifted = [];
  const missingMarker = [];
  const missingLoader = [];
  const migrated = [];
  const refused = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    let html = fs.readFileSync(file, 'utf8');
    let marked = html.includes(THEME_START);
    if (!marked) {
      const outside = html.includes(LEGACY_CDN_TAG) || html.includes(CONFIG_SIG);
      if (!outside) continue;
      if (check) { missingMarker.push(rel); continue; }
      const mig = migrateLegacyBlock(html, theRegion);
      if (!mig.ok) { refused.push(`${rel} (${mig.reason})`); missingMarker.push(rel); continue; }
      html = mig.html;
      marked = true;
      migrated.push(rel);
    }
    const { html: next } = applyRegion(html, theRegion);
    if (!next.includes(LOADER_LINK)) missingLoader.push(rel);
    const outsideAfter = next.slice(next.indexOf(THEME_END)).includes(LEGACY_CDN_TAG)
      || next.slice(0, next.indexOf(THEME_START)).includes(LEGACY_CDN_TAG);
    if (outsideAfter) missingMarker.push(rel);
    if (next !== fs.readFileSync(file, 'utf8')) {
      drifted.push(rel);
      if (!check) { fs.writeFileSync(file, next); changed.push(rel); }
    }
  }
  return { changed, drifted, missingMarker, missingLoader, migrated, refused, targets: files };
}

// ── twin parity (leg e) ──────────────────────────────────────────────────────────────────
/** Parse `--x-lch: <triple>;` declarations out of a CSS text. */
export function parseTwins(css) {
  const out = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+-lch)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
/**
 * Every `oklch(var(--x[, TRIPLE]))` channel reference in a text. Anchored on the oklch()
 * construct, NOT on a `-lch` suffix: a suffix-anchored pattern cannot see the very typo it
 * exists to catch (`--surface-lchh` simply stops matching, and silence reads as clean).
 */
export function parseChannelRefs(text) {
  return [...text.matchAll(/oklch\(\s*var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/g)]
    .map((m) => ({ name: m[1], fallback: m[2] === undefined ? null : m[2].trim() }));
}
/** Problems = a channel that is not a `:root` twin, has no fallback, or whose fallback drifted. */
export function twinParityProblems(texts, css) {
  const twins = parseTwins(css);
  const problems = [];
  for (const { label, text } of texts) {
    for (const ref of parseChannelRefs(text)) {
      if (!(ref.name in twins)) problems.push(`${label}: ${ref.name} is not a :root channel twin`);
      else if (ref.fallback === null) problems.push(`${label}: ${ref.name} has no fallback triple (a stale cached stylesheet would render it invalid)`);
      else if (twins[ref.name] !== ref.fallback)
        problems.push(`${label}: ${ref.name} fallback '${ref.fallback}' != :root '${twins[ref.name]}'`);
    }
  }
  return problems;
}

/** Every non-generated producer that emits an `oklch(var(--…))` channel reference. */
export function channelConsumers(root = REPO_ROOT) {
  const files = [
    ...listHtml(path.join(root, 'docs-src')),
    path.join(root, 'src', 'lib', 'site-nav.ts'),
    ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(root, 'scripts', f)),
    ...listHtml(path.join(root, 'landing', '_templates')),
    // This file is excluded BY PATH: its own MUST-CATCH fixtures are deliberately-broken
    // channel references, and a gate that scans itself reports its own test data as drift.
  ].filter((f) => fs.existsSync(f) && path.resolve(f) !== __filename);
  return files.filter((f) => fs.readFileSync(f, 'utf8').includes('oklch(var(--'));
}

// ── alpha-utility compile canary (leg f) ─────────────────────────────────────────────────
export const PALETTE_CLASS_RE = /(?<![\w-])((?:hover:|focus:|group-hover:|sm:|md:|lg:)*(?:bg|text|border|ring|divide|from|via|to|shadow|placeholder|outline)-(?:navy|mint|brass|well|line|steel)(?:-\d{2,3})?(?:\/\d{1,3})?)(?![\w./-])/g;

/** Every palette utility class used across the rendered corpus (sorted, deduped). */
export function collectPaletteClasses(root = REPO_ROOT) {
  const files = [
    ...listHtml(path.join(root, 'landing')),
    ...(fs.existsSync(path.join(root, 'docs-src', 'partials')) ? listHtml(path.join(root, 'docs-src', 'partials')) : []),
    path.join(root, 'docs-src', 'template.html'),
    path.join(root, 'src', 'lib', 'site-nav.ts'),
    path.join(root, 'src', 'index.ts'),
    path.join(root, 'src', 'lib', 'account-handlers.ts'),
  ].filter((f) => fs.existsSync(f));
  const set = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(PALETTE_CLASS_RE)) set.add(m[1]);
  }
  return [...set].sort();
}

/** `hover:border-mint-500/40` → `.hover\:border-mint-500\/40` (the selector Tailwind emits). */
export function escapeClass(cls) {
  return '.' + cls.replace(/([:/.])/g, '\\$1');
}

/** The config object literal, parsed back OUT of the shipped region bytes (one derivation). */
export function configLiteralFromRegion(region) {
  const m = region.match(/tailwind\.config = ([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error('region does not contain a tailwind.config assignment');
  return m[1];
}

/**
 * Compile every collected class with the local tailwindcss binary against the config parsed
 * out of the region. Returns { ok, missing, indeterminate, reason }.
 * `npx -y` is deliberately NOT used: this runs in prepublishOnly and in deploy.yml, and a
 * gate that reaches the npm registry degrades to "pass" exactly when the network does.
 */
export function compileCanary({ root = REPO_ROOT, region = null, classes = null } = {}) {
  const bin = path.join(root, 'node_modules', '.bin', 'tailwindcss');
  if (!fs.existsSync(bin)) return { ok: false, indeterminate: true, missing: [], reason: 'node_modules/.bin/tailwindcss missing — run npm ci' };
  const theRegion = region ?? renderThemeRegion();
  const list = classes ?? collectPaletteClasses(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-canary-'));
  try {
    fs.writeFileSync(path.join(dir, 'fixture.html'), `<div class="${list.join(' ')}"></div>\n`);
    fs.writeFileSync(
      path.join(dir, 'tailwind.config.js'),
      `module.exports = Object.assign(${configLiteralFromRegion(theRegion)}, { content: ['./fixture.html'] })\n`,
    );
    execFileSync(bin, ['-c', 'tailwind.config.js', '-o', 'out.css'], { cwd: dir, stdio: 'pipe' });
    const css = fs.readFileSync(path.join(dir, 'out.css'), 'utf8');
    const missing = list.filter((c) => !css.includes(escapeClass(c)));
    return { ok: missing.length === 0, indeterminate: false, missing, reason: '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── CDN pin drift (leg g) ────────────────────────────────────────────────────────────────
/**
 * The CDN answers 200 for versions that DO NOT EXIST (serving a `console.error("Unknown
 * Tailwind version")` stub), so a status-code probe proves nothing — assert the banner.
 * Never fails the gate: a WARN line, or INDETERMINATE when offline.
 */
export async function cdnBannerCheck(version) {
  const url = `https://cdn.tailwindcss.com/${version}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    // The unknown-version stub is a ~731 B `console.error("Unknown Tailwind version: …")`.
    // The real bundle is ~400 KB and assigns the version string; the surrounding minified
    // identifier changes between builds, so anchor on the QUOTED VERSION, never on `dh=`.
    const stub = body.trimStart().startsWith('console.error("Unknown Tailwind version');
    const ok = !stub && body.length > 100_000 && body.includes(`"${version}"`);
    return ok
      ? { state: 'ok', line: `THEME_CDN_PIN=OK (${version} bundle served, ${body.length} B)` }
      : { state: 'drift', line: `THEME_CDN_DRIFT=${url} did not serve the ${version} bundle (${stub ? 'unknown-version stub' : `${body.length} B, version string absent`})` };
  } catch (err) {
    return { state: 'offline', line: `THEME_CDN_PIN=INDETERMINATE (${String(err && err.message || err)})` };
  }
}

// ── self-test ────────────────────────────────────────────────────────────────────────────
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'theme');

function tmpRootWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-selftest-'));
  fs.mkdirSync(path.join(root, 'landing'), { recursive: true });
  for (const [name, src] of Object.entries(files)) {
    fs.copyFileSync(path.join(FIXTURES, src), path.join(root, 'landing', name));
  }
  return root;
}

export async function selfTest() {
  const results = [];
  const t = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass, actual, expected });
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    return pass;
  };
  let indeterminate = null;
  const region = renderThemeRegion();

  // (a) idempotence — writing twice changes nothing the second time.
  {
    const root = tmpRootWith({ 'clean.html': 'clean.html' });
    run({ root, region });
    const second = run({ root, region });
    const html = fs.readFileSync(path.join(root, 'landing', 'clean.html'), 'utf8');
    t('(a) idempotent: second write changes 0 files', second.changed.length, 0);
    t('(a) markers stay at 1 pair', [html.split(THEME_START).length - 1, html.split(THEME_END).length - 1], [1, 1]);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // (b) MUST-CATCH an un-migrated page (legacy palette, no markers) in --check.
  {
    const root = tmpRootWith({ 'unmigrated.html': 'unmigrated.html' });
    const res = run({ root, region, check: true });
    t('(b) MUST-CATCH un-migrated page', res.missingMarker, ['landing/unmigrated.html']);
    const after = run({ root, region });
    t('(b) write mode migrates it', after.migrated, ['landing/unmigrated.html']);
    const html = fs.readFileSync(path.join(root, 'landing', 'unmigrated.html'), 'utf8');
    t('(b) legacy palette gone', /navy: \{ 900: '#/.test(html), false);
    t('(b) unpinned CDN gone', html.includes(LEGACY_CDN_TAG), false);
    t('(b) clean afterwards', run({ root, region, check: true }).missingMarker, []);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // (c) MUST-CATCH a marked page that does not link the design stylesheet.
  {
    const root = tmpRootWith({ 'no-loader.html': 'no-loader.html' });
    const res = run({ root, region, check: true });
    t('(c) MUST-CATCH marked page without the loader', res.missingLoader, ['landing/no-loader.html']);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // (d) MUST-PRESERVE: an integrations-shaped head keeps every block between the two tags.
  {
    const root = tmpRootWith({ 'preserve.html': 'preserve.html' });
    const before = fs.readFileSync(path.join(root, 'landing', 'preserve.html'), 'utf8');
    run({ root, region });
    const after = fs.readFileSync(path.join(root, 'landing', 'preserve.html'), 'utf8');
    for (const needle of [
      '<link rel="stylesheet" href="/_design/algovault-design.css">',
      '<script defer src="/js/track-record-proxy.js"></script>',
      '<script type="application/ld+json" data-algovault-jsonld="TechArticle">',
      '<!-- ANALYTICS:START -->',
      '<!-- ANALYTICS:END -->',
      '<!-- SEO-PREFSRC-W1:START -->',
    ]) t(`(d) MUST-PRESERVE ${needle.slice(0, 46)}`, after.includes(needle), true);
    t('(d) preserved bytes are byte-equal outside the region', after.replace(/<!-- THEME:START -->[\s\S]*<!-- THEME:END -->\n/, ''), before.replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\n/, '').replace(/<script>\ntailwind\.config[\s\S]*?<\/script>\n/, ''));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // (d2) the CDN-only shape (privacy/terms) migrates, and an unknown shape is REFUSED.
  {
    const root = tmpRootWith({ 'legal.html': 'legal.html', 'unknown.html': 'unknown-shape.html' });
    const res = run({ root, region });
    t('(d2) cdn-only page migrated', res.migrated, ['landing/legal.html']);
    const legal = fs.readFileSync(path.join(root, 'landing', 'legal.html'), 'utf8');
    t('(d2) region sits after the loader', legal.indexOf(THEME_START) > legal.indexOf(LOADER_END), true);
    t('(d2) MUST-REFUSE an unknown shape (2 CDN tags)', res.refused.length, 1);
    const unknown = fs.readFileSync(path.join(root, 'landing', 'unknown.html'), 'utf8');
    t('(d2) refused file untouched', unknown.includes(THEME_START), false);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // (e) twin parity — every oklch(var(--x, …)) any producer emits matches a :root twin.
  {
    const css = fs.readFileSync(path.join(REPO_ROOT, 'landing', '_design', 'algovault-design.css'), 'utf8');
    const corpus = [{ label: 'region', text: region }, ...channelConsumers().map((f) => ({ label: path.relative(REPO_ROOT, f), text: fs.readFileSync(f, 'utf8') }))];
    const live = twinParityProblems(corpus, css);
    t(`(e) live twin parity across ${corpus.length} producer(s)`, live, []);
    t('(e) MUST-CATCH a typo\'d twin name', twinParityProblems([{ label: 'x', text: 'oklch(var(--surfce-lch, 0.18 0.014 265) / 1)' }], css).length, 1);
    t('(e) MUST-CATCH a twin that is not a channel', twinParityProblems([{ label: 'x', text: 'oklch(var(--surface-lchh, 0.18 0.014 265) / 1)' }], css).length, 1);
    t('(e) MUST-CATCH a drifted fallback value', twinParityProblems([{ label: 'x', text: 'oklch(var(--surface-lch, 0.19 0.014 265) / 1)' }], css).length, 1);
    t('(e) MUST-CATCH a missing fallback', twinParityProblems([{ label: 'x', text: 'oklch(var(--surface-lch) / 1)' }], css).length, 1);
  }

  // (f) alpha-utility compile canary over the real corpus.
  {
    const classes = collectPaletteClasses();
    const res = compileCanary({ region, classes });
    if (res.indeterminate) {
      indeterminate = res.reason;
      console.log(`  ??  (f) compile canary INDETERMINATE — ${res.reason}`);
    } else {
      t(`(f) every palette class emits a rule (${classes.length} classes)`, res.missing, []);
      const control = compileCanary({ region: region.replace(/ \/ <alpha-value>/g, ''), classes: classes.filter((c) => c.includes('/')) });
      t('(f) MUST-CATCH: without <alpha-value> the opacity classes emit nothing', control.missing.length > 0, true);
    }
  }

  // (g) CDN pin banner (never fails the gate).
  {
    const { TAILWIND_CDN_VERSION } = require(path.join(REPO_ROOT, 'dist', 'lib', 'site-theme.js'));
    const res = await cdnBannerCheck(TAILWIND_CDN_VERSION);
    console.log(`  ${res.state === 'ok' ? 'ok  ' : 'warn'}  (g) ${res.line}`);
  }

  const failed = results.filter((r) => !r.pass);
  if (indeterminate) {
    console.log(`THEME_SELFTEST_VERDICT=INDETERMINATE`);
    return 3;
  }
  console.log(`THEME_SELFTEST_VERDICT=${failed.length === 0 ? 'PASS' : 'FAIL'}`);
  return failed.length === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const check = process.argv.includes('--check');
  const wantSelfTest = process.argv.includes('--self-test');
  if (wantSelfTest) {
    if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'lib', 'site-theme.js'))) {
      console.error('dist/lib/site-theme.js missing — run npm run build');
      console.log('THEME_SELFTEST_VERDICT=INDETERMINATE');
      process.exit(3);
    }
    process.exit(await selfTest());
  }
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'lib', 'site-theme.js'))) {
    console.error('dist/lib/site-theme.js missing — run npm run build');
    console.log('THEME_SYNC_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  if (targets().length === 0) {
    console.error('zero theme targets — landing/ is empty or unreadable');
    console.log('THEME_SYNC_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  const res = run({ check });
  if (check) {
    const problems = [...res.drifted, ...res.missingMarker, ...res.missingLoader];
    if (problems.length > 0) {
      if (res.drifted.length) console.error(`✗ build_theme --check: ${res.drifted.length} region(s) OUT OF SYNC:\n  ${res.drifted.join('\n  ')}`);
      if (res.missingMarker.length) console.error(`✗ build_theme --check: ${res.missingMarker.length} un-migrated page(s) (Tailwind signature outside the markers):\n  ${res.missingMarker.join('\n  ')}`);
      if (res.missingLoader.length) console.error(`✗ build_theme --check: ${res.missingLoader.length} marked page(s) NOT linking ${LOADER_LINK}:\n  ${res.missingLoader.join('\n  ')}`);
      console.error('  Run: node scripts/build_theme.mjs');
      console.log('THEME_SYNC_VERDICT=FAIL');
      process.exit(1);
    }
    console.log(`✓ build_theme --check: ${res.targets.length} target(s) scanned, every theme region in sync.`);
    console.log('THEME_SYNC_VERDICT=PASS');
  } else {
    console.log(`✓ build_theme: ${res.changed.length} region(s) written${res.migrated.length ? `, ${res.migrated.length} page(s) migrated` : ''} across ${res.targets.length} target(s).`);
    if (res.refused.length) console.error(`  REFUSED (unknown shape, untouched):\n  ${res.refused.join('\n  ')}`);
    if (res.missingLoader.length) console.error(`  note: ${res.missingLoader.length} marked page(s) lack ${LOADER_LINK}: ${res.missingLoader.join(', ')}`);
    console.log(`THEME_SYNC_VERDICT=${res.refused.length ? 'FAIL' : 'PASS'}`);
    if (res.refused.length) process.exit(1);
  }
}
