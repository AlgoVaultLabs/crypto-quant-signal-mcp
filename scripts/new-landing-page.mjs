#!/usr/bin/env node
// @ts-check
/**
 * new-landing-page.mjs — DESIGN-THEME-UNIVERSAL-COVERAGE-W1 R3.
 *
 * Scaffold a public page that is ALREADY on-theme, then run every injector and every gate over
 * it, so the page is complete before the author types a word.
 *
 *   node scripts/new-landing-page.mjs --slug <slug> --title "…" --description "…"
 *   node scripts/new-landing-page.mjs --slug <slug> --title "…" --description "…" --kind answer
 *   node scripts/new-landing-page.mjs --slug <slug> --title "…" --description "…" --dry-run
 *   node scripts/new-landing-page.mjs --self-test
 *
 * ## Why a scaffold and not a convention
 *
 * R1 and R2 of this wave DETECT an off-theme page: the coverage leg fails a page that carries
 * no THEME region, and the ratchet fails one that paints its own colours. Detection alone taxes
 * every future author with a checklist. This is the BY-CONSTRUCTION half — the emitted page
 * carries the loader, the four generated regions, `body { background: var(--bg) }` and zero
 * colour literals, so the default path is the compliant one and the gates only ever have to
 * catch someone leaving it deliberately.
 *
 * ## The regions are BLANKED on the way out, deliberately
 *
 * The committed templates carry FILLED regions — they have to, or build_theme --check would
 * report them as drifted on every run. Copying those bytes into a new page would hand it a
 * SNAPSHOT of the region as it stood when the template was last written. So renderPage()
 * blanks all four marker pairs and lets the injector chain fill them from today's SoT. It is
 * the same reason render-integrations.mjs writes its NAV/footer/ANALYTICS/asset regions empty.
 *
 * ## The answer kind inherits its template's declared debt, and says so
 *
 * `--kind answer` renders landing/_templates/answer-page.template.html, which carries 19
 * hand-written TEXT colour literals (measured 2026-09-23). DESIGN-SURFACE-TOKENS-W1's sweep
 * retired that family's SURFACE literals and deliberately left its foreground ones — they have
 * no exact token in landing/_design/algovault-design.css :root, so tokenising them is a design
 * decision and not this wave's to make. A page scaffolded from it therefore inherits 19
 * literals and the ratchet, correctly, refuses a new file at 19.
 *
 * This script does NOT raise the baseline for you. Automating a raise would convert the one
 * documented escape hatch into a hole the scaffold punches on every run. It prints the exact
 * `--allow-raise … --reason …` command instead, so accepting the debt stays an act somebody
 * performs and signs. Owner of the tokenisation: DESIGN-ANSWER-TEMPLATE-TOKENS-W{NEXT}.
 *
 * Verdict token: NEW_LANDING_PAGE_VERDICT=PASS|FAIL|INDETERMINATE (0/1/3 — 3 is the token-law
 * default for a new gate). `--self-test` emits NEW_LANDING_PAGE_SELFTEST_VERDICT.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { THEME_START, THEME_END, LOADER_LINK, LOADER_END, run as themeRun, loadCoverageConfig } from './build_theme.mjs';
import { evaluate as ratchetEvaluate, countLiterals } from './check-colour-literal-ratchet.mjs';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const require = createRequire(import.meta.url);
const TOKEN = 'NEW_LANDING_PAGE_VERDICT';

export const SLUG_RE = /^[a-z0-9-]+$/;
export const LOADER_SNIPPET_REL = path.join('landing', '_design', 'loader-snippet.html');

/** kind -> template. Both live under landing/_templates/, which the deploy glob does not copy. */
export const TEMPLATES = {
  page: path.join('landing', '_templates', 'page.template.html'),
  answer: path.join('landing', '_templates', 'answer-page.template.html'),
};

/** Marker pairs blanked on emit; see the docblock for why a snapshot would be wrong. */
export const BLANK_REGIONS = ['THEME', 'NAV', 'ANALYTICS', 'CONVERSION-BAND'];

/**
 * The injector chain, in the order the regen chain requires. build_nav must precede build_theme
 * only in the full site rebuild; for one page the order below is what matters: regions first,
 * then the footer that sits outside them, then the asset stamp that rewrites src="" refs.
 */
export const INJECTORS = [
  { name: 'build_theme', script: 'scripts/build_theme.mjs', token: 'THEME_SYNC_VERDICT' },
  { name: 'build_nav', script: 'scripts/build_nav.mjs', token: null },
  { name: 'inject-footer', script: 'scripts/inject-footer.mjs', token: 'FOOTER_INJECT_VERDICT' },
  { name: 'build_analytics', script: 'scripts/build_analytics.mjs', token: null },
  { name: 'build_asset_versions', script: 'scripts/build_asset_versions.mjs', token: null },
];

// ── pure render ──────────────────────────────────────────────────────────────────────────

/** Escape for an HTML attribute value. A title with a quote must not break the meta tag. */
export function attr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape for HTML text (a <title> body). */
export function text(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Empty every generated marker pair, so the injectors fill them from today's SoT. */
export function blankRegions(html) {
  let out = html;
  for (const name of BLANK_REGIONS) {
    out = out.replace(
      new RegExp(`<!--\\s*${name}:START\\s*-->[\\s\\S]*?<!--\\s*${name}:END\\s*-->`, 'g'),
      `<!-- ${name}:START -->\n<!-- ${name}:END -->`,
    );
  }
  return out;
}

/**
 * Drop the template's own authoring comment — everything before `<!DOCTYPE`. It addresses
 * whoever edits the TEMPLATE ("DO NOT COPY THIS FILE BY HAND", the slot map, the deploy-glob
 * note); shipping it on a public page is scaffolding left in the building. Measured 2026-09-23:
 * 0 of the 16 live answer pages carry it, so the human authors have been stripping it by hand
 * every time — which is exactly the kind of step a scaffold should own.
 */
export function stripAuthoringDocblock(template) {
  const i = template.indexOf('<!DOCTYPE');
  return i === -1 ? template : template.slice(i);
}

/**
 * Substitute the SLOT markers and blank the regions. PURE — the same inputs give the same
 * bytes, which is what makes `--dry-run` reviewable and the unit test byte-stable.
 *
 * A SLOT marker is `<!-- SLOT:NAME -->` optionally followed by placeholder text that runs to
 * the end of the enclosing value; for the head slots the placeholder is the rest of the
 * attribute or element, so the marker plus its default is replaced wholesale.
 */
export function renderPage(template, { slug, title, description }) {
  let html = stripAuthoringDocblock(template);
  // <title><!-- SLOT:TITLE -->default</title>  ->  <title>Title | AlgoVault Labs</title>
  html = html.replace(/(<title>)<!--\s*SLOT:TITLE\s*-->[^<]*(<\/title>)/, `$1${text(title)}$2`);
  // content="<!-- SLOT:META_DESC -->"  and the OG/twitter description twins
  html = html.replace(/content="<!--\s*SLOT:(META_DESC|OG_DESC)\s*-->[^"]*"/g, `content="${attr(description)}"`);
  html = html.replace(/content="<!--\s*SLOT:OG_TITLE\s*-->[^"]*"/g, `content="${attr(title)}"`);
  // href/content="https://algovault.com/<!-- SLOT:SLUG -->"
  html = html.replace(/<!--\s*SLOT:SLUG\s*-->/g, slug);
  // The answer template's visible eyebrow; the page skeleton has no eyebrow and is untouched.
  html = html.replace(/<!--\s*SLOT:EYEBROW\s*-->[^<]*/g, text(title));
  return blankRegions(html);
}

// ── argv ─────────────────────────────────────────────────────────────────────────────────

export function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? '' : v;
}

/**
 * Validate the request. Returns the plan, or every reason it is refused — all of them at once,
 * because fixing one argument at a time across five runs is its own kind of hostile.
 * @returns {{ok:true,plan:object}|{ok:false,why:string[]}}
 */
export function planPage(argv, root = REPO_ROOT) {
  const why = [];
  const slug = flagValue(argv, '--slug');
  const title = flagValue(argv, '--title');
  const description = flagValue(argv, '--description');
  const kind = flagValue(argv, '--kind') || 'page';

  if (!slug) why.push('--slug <slug> is required');
  else if (!SLUG_RE.test(slug)) why.push(`--slug "${slug}" must match ${SLUG_RE} (lowercase, digits and hyphens — it becomes the URL)`);
  if (!title || !title.trim()) why.push('--title "…" is required (it becomes <title> and og:title)');
  if (!description || !description.trim()) why.push('--description "…" is required (it becomes the meta description and og:description)');
  if (!(kind in TEMPLATES)) why.push(`--kind "${kind}" must be one of: ${Object.keys(TEMPLATES).join(' | ')}`);

  const templateRel = TEMPLATES[kind];
  if (templateRel && !fs.existsSync(path.join(root, templateRel))) why.push(`template ${templateRel} is missing`);

  const outRel = slug ? path.join('landing', `${slug}.html`) : '';
  if (outRel && fs.existsSync(path.join(root, outRel))) {
    why.push(`${outRel} already exists — refusing to overwrite a live page. Edit it, or pick another slug.`);
  }
  if (why.length) return { ok: false, why };
  return { ok: true, plan: { slug, title: title.trim(), description: description.trim(), kind, templateRel, outRel } };
}

/** The loader block must stay byte-identical to the canonical snippet. */
export function loaderDrift(root = REPO_ROOT, templateRel = TEMPLATES.page) {
  const snip = fs.readFileSync(path.join(root, LOADER_SNIPPET_REL), 'utf8');
  const s = snip.indexOf('<!-- BEGIN: AlgoVault canonical design loader');
  const e = snip.indexOf(LOADER_END);
  if (s === -1 || e === -1) return `${LOADER_SNIPPET_REL} does not contain the canonical loader block`;
  const block = snip.slice(s, e + LOADER_END.length);
  const tpl = fs.readFileSync(path.join(root, templateRel), 'utf8');
  return tpl.includes(block) ? '' : `${templateRel} does not carry the loader block byte-identically — it has drifted from ${LOADER_SNIPPET_REL}`;
}

// ── the chain ────────────────────────────────────────────────────────────────────────────

function sh(root, script, args) {
  const r = spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { code: r.status === null ? 1 : r.status, out };
}

/** The last `<TOKEN>=VALUE` line a run printed, or '' — callers gate on the TOKEN, not the code. */
export function lastToken(out, token) {
  const m = [...String(out).matchAll(new RegExp(`^${token}=(\\w+)`, 'gm'))];
  return m.length ? m[m.length - 1][1] : '';
}

// ── self-test ────────────────────────────────────────────────────────────────────────────

/** A temp root carrying the repo's landing/ + docs-src/ + ops/ — enough for every root-aware gate. */
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-landing-page-'));
  fs.cpSync(path.join(REPO_ROOT, 'landing'), path.join(root, 'landing'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs-src'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'docs-src', 'template.html'), path.join(root, 'docs-src', 'template.html'));
  fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
  for (const f of ['theme-coverage-config.json', 'colour-literal-baseline.json', 'footer-coverage-config.json']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'ops', f), path.join(root, 'ops', f));
  }
  return root;
}

export async function selfTest() {
  const results = [];
  const t = (name, actual, expected) => {
    let got;
    try { got = typeof actual === 'function' ? actual() : actual; } catch (e) { got = `THREW: ${e && e.message}`; }
    const pass = JSON.stringify(got) === JSON.stringify(expected);
    results.push(pass);
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(expected)})`}`);
  };

  // ── argv refusals ──────────────────────────────────────────────────────────────────────
  const base = ['--title', 'T', '--description', 'D'];
  t('MUST-REFUSE a missing --slug', planPage([...base]).ok, false);
  t('MUST-REFUSE an upper-case slug', planPage(['--slug', 'Bad-Slug', ...base]).ok, false);
  t('MUST-REFUSE a slug with a slash (path traversal)', planPage(['--slug', '../etc/passwd', ...base]).ok, false);
  t('MUST-REFUSE a missing --title', planPage(['--slug', 'ok', '--description', 'D']).ok, false);
  t('MUST-REFUSE a missing --description', planPage(['--slug', 'ok', '--title', 'T']).ok, false);
  t('MUST-REFUSE an unknown --kind', planPage(['--slug', 'ok', ...base, '--kind', 'poster']).ok, false);
  t('MUST-REFUSE an existing page', planPage(['--slug', 'privacy', ...base]).ok, false);
  t('MUST-PASS a well-formed request', planPage(['--slug', 'zz-selftest-probe', ...base]).ok, true);

  // ── the loader byte-copy ───────────────────────────────────────────────────────────────
  t('page skeleton carries the canonical loader byte-identically', loaderDrift(REPO_ROOT, TEMPLATES.page), '');
  t('answer template carries it too', loaderDrift(REPO_ROOT, TEMPLATES.answer), '');

  // ── pure render ────────────────────────────────────────────────────────────────────────
  {
    const tpl = fs.readFileSync(path.join(REPO_ROOT, TEMPLATES.page), 'utf8');
    const a = renderPage(tpl, { slug: 'x-probe', title: 'Probe', description: 'Probe desc' });
    const b = renderPage(tpl, { slug: 'x-probe', title: 'Probe', description: 'Probe desc' });
    t('renderPage is byte-stable', a === b, true);
    t('renderPage starts the page at <!DOCTYPE', a.startsWith('<!DOCTYPE html>'), true);
    t('renderPage drops the template authoring docblock', a.includes('DO NOT COPY THIS FILE BY HAND'), false);
    t('…and the template itself still carries it (the leg is not vacuous)', tpl.includes('DO NOT COPY THIS FILE BY HAND'), true);
    t('renderPage substitutes the title', /<title>Probe<\/title>/.test(a), true);
    t('renderPage substitutes the slug in canonical + og:url', (a.match(/algovault\.com\/x-probe/g) || []).length >= 2, true);
    t('renderPage leaves no SLOT marker in the head', /<!--\s*SLOT:(TITLE|META_DESC|SLUG|OG_TITLE|OG_DESC)\s*-->/.test(a), false);
    t('renderPage blanks the THEME region', a.includes(`${THEME_START}\n${THEME_END}`), true);
    t('renderPage keeps exactly one marker pair each', [
      (a.match(/<!-- THEME:START -->/g) || []).length,
      (a.match(/<!-- NAV:START -->/g) || []).length,
      (a.match(/<!-- ANALYTICS:START -->/g) || []).length,
    ], [1, 1, 1]);
    t('the emitted page links the design stylesheet', a.includes(LOADER_LINK), true);
    t('the emitted page paints its background from a token', a.includes('background: var(--bg)'), true);
    t('the emitted page carries ZERO colour literals', (a.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || []), []);
    // An escaping hole here puts caller text straight into a meta tag on a public page.
    const esc = renderPage(tpl, { slug: 'x', title: 'A "quoted" <b>title</b>', description: 'x & y' });
    t('MUST-ESCAPE a quote in --title (it lands in an attribute)', esc.includes('content="A &quot;quoted&quot;'), true);
    t('MUST-ESCAPE markup in --title (it lands in <title>)', esc.includes('<title>A "quoted" &lt;b&gt;title&lt;/b&gt;</title>'), true);
    t('MUST-ESCAPE an ampersand in --description', esc.includes('content="x &amp; y"'), true);
  }

  // ── scaffold BOTH kinds into a temp root and drive the real gates ──────────────────────
  for (const kind of ['page', 'answer']) {
    const root = tmpRoot();
    const slug = `zz-selftest-${kind}`;
    const outRel = path.join('landing', `${slug}.html`);
    const tpl = fs.readFileSync(path.join(root, TEMPLATES[kind]), 'utf8');
    fs.writeFileSync(path.join(root, outRel), renderPage(tpl, { slug, title: 'Probe', description: 'Probe description' }));

    // Every injector that accepts a root, in write mode, then asserted at zero drift.
    const region = require(path.join(REPO_ROOT, 'dist', 'lib', 'site-theme.js')).renderThemeRegion();
    const navMod = await import('./build_nav.mjs');
    const anMod = await import('./build_analytics.mjs');
    const assetMod = await import('./build_asset_versions.mjs');
    const footerSot = require(path.join(REPO_ROOT, 'dist', 'lib', 'footer-content.js'));

    themeRun({ root, region });
    navMod.run({ root });
    anMod.run({ root });
    // inject-footer exports no run(); apply its SoT directly at the documented anchor.
    {
      const p = path.join(root, outRel);
      let html = fs.readFileSync(p, 'utf8');
      if (!/<footer\b[^>]*data-av-brand-footer/.test(html)) {
        html = html.replace(/<\/body>/i, `${footerSot.renderBrandFooter('desktop')}\n</body>`);
        fs.writeFileSync(p, html);
      }
    }
    {
      const p = path.join(root, outRel);
      fs.writeFileSync(p, assetMod.stampHtml(fs.readFileSync(p, 'utf8'), assetMod.assetHashes()).out);
    }

    const after = themeRun({ root, region, check: true });
    t(`(${kind}) build_theme reports 0 drift on the scaffolded page`, after.drifted.includes(outRel), false);
    t(`(${kind}) build_nav reports 0 drift`, navMod.run({ root, check: true }).drifted.includes(outRel), false);
    t(`(${kind}) build_nav does not report a missing NAV marker`, navMod.run({ root, check: true }).missingMarker.includes(outRel), false);
    t(`(${kind}) build_analytics reports 0 drift`, anMod.run({ root, check: true }).drifted.includes(outRel), false);
    t(`(${kind}) build_analytics does not report a missing ANALYTICS marker`, anMod.run({ root, check: true }).missingMarker.includes(outRel), false);
    t(`(${kind}) the page carries the brand footer`, /<footer\b[^>]*data-av-brand-footer/.test(fs.readFileSync(path.join(root, outRel), 'utf8')), true);
    t(`(${kind}) asset refs are stamped (a second stamp changes nothing)`,
      assetMod.stampHtml(fs.readFileSync(path.join(root, outRel), 'utf8'), assetMod.assetHashes()).changed, 0);

    // GATE 1 — R1 coverage. Both kinds must be covered pages.
    t(`(${kind}) R1 coverage leg PASSES`, [after.coverageStatus, after.uncovered, after.staleExempt], ['PASS', [], []]);

    // GATE 2 — R2 ratchet.
    const ratchet = ratchetEvaluate(root);
    const mine = ratchet.over.filter((o) => o.path === outRel.split(path.sep).join('/'));
    if (kind === 'page') {
      t('(page) R2 ratchet PASSES — the skeleton is born at 0 literals', [ratchet.verdict, mine], ['PASS', []]);
    } else {
      // The inherited-debt path, asserted in BOTH directions so neither half can rot: the
      // ratchet must refuse first, and the documented --allow-raise must be what clears it.
      t('(answer) R2 ratchet REFUSES the inherited literals', mine.length, 1);
      t('(answer) …and it names the count it refused', mine[0] && mine[0].count === countLiterals(fs.readFileSync(path.join(root, outRel), 'utf8')), true);
      const bp = path.join(root, 'ops', 'colour-literal-baseline.json');
      const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
      b.counts[outRel.split(path.sep).join('/')] = mine[0].count;
      b.raises.push({ path: outRel.split(path.sep).join('/'), from: 0, to: mine[0].count, reason: 'inherited verbatim from landing/_templates/answer-page.template.html', date: '2026-09-23' });
      fs.writeFileSync(bp, JSON.stringify(b, null, 2));
      t('(answer) R2 ratchet PASSES once the debt is DECLARED with a reason', ratchetEvaluate(root).verdict, 'PASS');
    }

    t(`(${kind}) the coverage config was read from the temp root, not the repo`, loadCoverageConfig(root).status, 'PASS');
    t(`(${kind}) nothing leaked into the repo`, fs.existsSync(path.join(REPO_ROOT, outRel)), false);
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r).length;
  console.log(`NEW_LANDING_PAGE_SELFTEST_VERDICT=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────

function emit(v, why) {
  if (why) console.log(`${v === 'PASS' ? '✓' : '✖'} ${why}`);
  console.log(`${TOKEN}=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'lib', 'site-theme.js'))) {
      console.error('dist/ missing — run npm run build');
      console.log('NEW_LANDING_PAGE_SELFTEST_VERDICT=INDETERMINATE');
      process.exit(3);
    }
    process.exit(await selfTest());
  }

  const planned = planPage(argv);
  if (!planned.ok) {
    for (const w of planned.why) console.error(`   - ${w}`);
    console.error('\n  usage: node scripts/new-landing-page.mjs --slug <slug> --title "…" --description "…" [--kind page|answer] [--dry-run]');
    emit('FAIL', `${planned.why.length} problem(s) with the request`);
  }
  const { slug, title, description, kind, templateRel, outRel } = planned.plan;

  const drift = loaderDrift(REPO_ROOT, templateRel);
  if (drift) emit('INDETERMINATE', drift);

  const html = renderPage(fs.readFileSync(path.join(REPO_ROOT, templateRel), 'utf8'), { slug, title, description });

  if (argv.includes('--dry-run')) {
    process.stdout.write(html);
    process.exit(0);
  }

  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'lib', 'site-theme.js'))) emit('INDETERMINATE', 'dist/ missing — run npm run build first');

  fs.writeFileSync(path.join(REPO_ROOT, outRel), html);
  console.log(`✓ wrote ${outRel} from ${templateRel} (${kind} kind)`);

  let bad = 0;
  for (const inj of INJECTORS) {
    const w = sh(REPO_ROOT, inj.script, []);
    const c = sh(REPO_ROOT, inj.script, ['--check']);
    const tok = inj.token ? lastToken(c.out, inj.token) : (c.code === 0 ? 'PASS' : 'FAIL');
    const ok = inj.token ? tok === 'PASS' : c.code === 0;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✖'} ${inj.name.padEnd(21)} ${inj.token ? `${inj.token}=${tok || '<none>'}` : `exit ${c.code}`}`);
    if (!ok) console.error(`${w.out}${c.out}`.split('\n').filter(Boolean).slice(-8).map((l) => `      ${l}`).join('\n'));
  }

  // R1 rides inside build_theme --check above; print it separately so the two are legible.
  const cov = themeRun({ check: true });
  console.log(`  ${cov.coverageStatus === 'PASS' ? '✓' : '✖'} ${'coverage (R1)'.padEnd(21)} uncovered=${cov.uncovered.length} staleExempt=${cov.staleExempt.length}`);
  if (cov.coverageStatus !== 'PASS') bad += 1;

  const ratchet = ratchetEvaluate();
  const mine = ratchet.over.filter((o) => o.path === outRel.split(path.sep).join('/'));
  console.log(`  ${ratchet.verdict === 'PASS' ? '✓' : '✖'} ${'ratchet (R2)'.padEnd(21)} COLOUR_LITERAL_RATCHET_VERDICT=${ratchet.verdict}`);
  if (ratchet.verdict !== 'PASS') {
    bad += 1;
    if (mine.length) {
      console.error('');
      console.error(`  ${outRel} carries ${mine[0].count} colour literal(s), inherited verbatim from ${templateRel}.`);
      console.error('  Either tokenise them (var(--bg) · var(--surface) · var(--line) · var(--fg…) · var(--mint)),');
      console.error('  or DECLARE the debt with an argument attached to it:');
      console.error('');
      console.error(`    node scripts/check-colour-literal-ratchet.mjs --allow-raise ${outRel.split(path.sep).join('/')} \\`);
      console.error(`      --reason "inherited verbatim from ${templateRel}; tokenising that template is DESIGN-ANSWER-TEMPLATE-TOKENS-W{NEXT}"`);
      console.error('');
      console.error('  This script will not run that for you: an automated raise is a hole, not a hatch.');
    }
  }

  if (bad) emit('FAIL', `${bad} gate(s) not green on ${outRel} — fix them before committing the page`);
  emit('PASS', `${outRel} is complete: region, nav, footer, analytics, asset stamps, coverage and ratchet all green`);
}
