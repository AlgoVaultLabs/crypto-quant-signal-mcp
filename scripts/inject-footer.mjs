#!/usr/bin/env node
/**
 * FOOTER-UNIFY-W1 — build-time canonical-brand-footer injector.
 * FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1 — glob-derived targets + insert-where-missing.
 *
 * Places the single-source brand footer (src/lib/footer-content.ts renderBrandFooter, compiled to
 * dist/lib/footer-content.js) on EVERY static public page.
 *
 *   node scripts/inject-footer.mjs           # rewrite the static files in place
 *   node scripts/inject-footer.mjs --check   # canary: non-zero if any page is out of sync
 *   node scripts/inject-footer.mjs --self-test
 *
 * ── What changed in W1-UNIVERSAL, and why ───────────────────────────────────
 *
 * 1. TARGETS IS DERIVED, NOT TYPED. The old hand-maintained array went stale TWICE: the comment
 *    it carried records the first (gemini/kraken/alpaca silently never got the footer), and this
 *    wave found the second — it listed 12 of the 24 integrations pages. A list of every page is a
 *    duplicated fact, and a duplicated fact goes stale. Targets now come from a glob minus the
 *    declared exemptions in ops/footer-coverage-config.json, each carrying a `reason` in DATA.
 *
 * 2. IT CAN NOW ADD A FOOTER, NOT ONLY REPLACE ONE. The old script matched an existing <footer>
 *    carrying BRAND_FOOTER_BG_SIGNATURE and swapped it. On a page with a DIFFERENT footer — or
 *    none at all — it matched nothing and reported success. That is why "re-run the injector over
 *    a glob" would not have covered anything by itself. Per-page priority is now:
 *       brand footer(s) present  -> replace each, preserving its desktop/mobile variant
 *       another <footer> present -> replace it with the brand footer (Mr.1 "Unify + preserve";
 *                                  the links unique to those footers were carried into the SoT)
 *       no footer at all         -> insert the brand footer immediately before </body>
 *
 * 3. ZERO FOOTERS ON A TARGET IS NOW A FAILURE. It used to be a console.warn that neither
 *    incremented the drift counter nor failed --check, so a page could sit in the target set
 *    carrying no footer while the canary printed OK. That is the dark-guard shape CLAUDE.md
 *    tracks; the gate now asserts the POSITIVE per-page outcome it claims to.
 *
 * 4. IT EMITS A VERDICT TOKEN. Exactly one terminal `FOOTER_INJECT_VERDICT=PASS|FAIL|INDETERMINATE`
 *    line, and callers gate on the TOKEN rather than the bare code. Codes are 0/1/3 — **3 is the
 *    token-law default for a gate that has no incumbent code for "could not verify"**; do NOT
 *    "align" it with check_test_baseline.sh's 2, which is 2 only because it already deployed 2.
 *    OPS-TEST-GATE-RECONCILE-W1 litigated that and it is settled.
 *
 * NOTE FOR WHOEVER WIRES THIS: until this wave, `--check` was referenced by NOTHING — not
 * package.json, not a workflow, not ops/. Its own docblock called it a CI canary and the unit test
 * said it "pairs with" it, but it had never run unattended. That is precisely how TARGETS went
 * stale twice without anyone noticing. It is wired now; keep it wired.
 *
 * Requires `npm run build` first (loads the tsc-emitted CJS SoT via createRequire).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { globSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const TOKEN = 'FOOTER_INJECT_VERDICT';

/** PASS=0 · FAIL=1 · INDETERMINATE=3. See the docblock for why 3 and not 2. */
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/** Emit the ONE terminal token and exit. Never called twice in a process. */
function verdict(v, why) {
  process.stdout.write(`${TOKEN}=${v}${why ? ` — ${why}` : ''}\n`);
  process.exit(CODES[v]);
}

// ───────────────────────────── target derivation ─────────────────────────────

/**
 * Derive the target set: every page matching the config glob, minus the declared exemptions.
 * PURE + exported so the coverage gate reads THIS answer instead of re-deriving its own — a
 * second derivation is a second thing that can drift.
 *
 * Order-independence is a property, not an accident: the result is sorted, so it is a function of
 * the file set and the exemption set, never of directory-iteration order.
 *
 * @returns {{status:'PASS'|'FAIL'|'INDETERMINATE', targets:string[], exempt:string[], why?:string}}
 */
export function deriveFooterTargets(repoRoot, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { status: 'INDETERMINATE', targets: [], exempt: [], why: 'config is not an object' };
  }
  if (typeof config.glob !== 'string' || !config.glob.trim()) {
    return { status: 'INDETERMINATE', targets: [], exempt: [], why: '`glob` is absent or not a string' };
  }
  if (!Array.isArray(config.exempt)) {
    return {
      status: 'INDETERMINATE',
      targets: [],
      exempt: [],
      why: `\`exempt\` is ${config.exempt === undefined ? 'absent' : 'not an array'}`,
    };
  }

  const exempt = new Set();
  for (const [i, row] of config.exempt.entries()) {
    const id = (row && row.path) || `#${i}`;
    if (!row || typeof row !== 'object' || typeof row.path !== 'string' || !row.path.trim()) {
      return { status: 'FAIL', targets: [], exempt: [], why: `exemption ${id} has no usable \`path\`` };
    }
    // An exemption with no stated reason is the failure mode this config exists to prevent.
    if (typeof row.reason !== 'string' || row.reason.trim().length < 10) {
      return { status: 'FAIL', targets: [], exempt: [], why: `exemption ${row.path} has no substantive \`reason\`` };
    }
    // A stale exemption silently shrinks coverage — it must name a file that exists.
    if (!existsSync(path.join(repoRoot, row.path))) {
      return { status: 'FAIL', targets: [], exempt: [], why: `exemption ${row.path} names a file that does not exist` };
    }
    exempt.add(row.path);
  }

  let found;
  try {
    found = globSync(config.glob, { cwd: repoRoot });
  } catch (e) {
    return { status: 'INDETERMINATE', targets: [], exempt: [], why: `glob failed: ${e.message}` };
  }

  const targets = found
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => !exempt.has(p))
    .sort();

  // Constructed-corpus vacuity: this repo authors these pages, so zero targets means the glob
  // matched nothing — REFUSE rather than report an empty pass.
  if (targets.length === 0) {
    return {
      status: 'INDETERMINATE',
      targets: [],
      exempt: [...exempt],
      why: `glob \`${config.glob}\` yielded ZERO targets after ${exempt.size} exemption(s)`,
    };
  }
  return { status: 'PASS', targets, exempt: [...exempt] };
}

// ───────────────────────────── page transformation ───────────────────────────

/** Build the matchers from the SoT signature. */
export function buildMatchers(bgSignature) {
  const esc = bgSignature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    // A BRAND <footer> — opening tag carries the oklch bg signature. Non-greedy; footers never nest.
    brand: new RegExp(`<footer\\b[^>]*${esc}[^>]*>[\\s\\S]*?</footer>`, 'g'),
    // ANY <footer> — used only once we know the page carries no brand footer.
    any: /<footer\b[^>]*>[\s\S]*?<\/footer>/g,
  };
}

/**
 * Apply the SoT footer to one page's HTML.
 *
 * @returns {{html:string, action:'replaced-brand'|'replaced-other'|'inserted'|'none',
 *            brandCount:number, unknownVariant:number, why?:string}}
 */
export function applyFooter(html, render, matchers) {
  // 1. Brand footer(s) already present -> re-inject each, preserving its variant.
  const brandHits = html.match(matchers.brand);
  if (brandHits && brandHits.length > 0) {
    let unknownVariant = 0;
    let brandCount = 0;
    const out = html.replace(matchers.brand, (match) => {
      const variant = variantOf(match);
      if (!variant) {
        unknownVariant++;
        return match;
      }
      brandCount++;
      return render(variant);
    });
    return { html: out, action: 'replaced-brand', brandCount, unknownVariant };
  }

  // 2. A different footer TYPE -> replace it (Mr.1 "Unify + preserve").
  const otherHits = html.match(matchers.any);
  if (otherHits && otherHits.length > 0) {
    let brandCount = 0;
    const out = html.replace(matchers.any, () => {
      brandCount++;
      return render('desktop');
    });
    return { html: out, action: 'replaced-other', brandCount, unknownVariant: 0 };
  }

  // 3. No footer at all -> insert before </body>.
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) {
    return {
      html,
      action: 'none',
      brandCount: 0,
      unknownVariant: 0,
      why: 'no <footer> to replace and no </body> to anchor an insertion',
    };
  }
  return {
    html: `${html.slice(0, idx)}${render('desktop')}\n${html.slice(idx)}`,
    action: 'inserted',
    brandCount: 1,
    unknownVariant: 0,
  };
}

/**
 * CONVERSION-SURFACES-W2 CH3 — place the conversion band immediately ABOVE the brand footer.
 *
 * WHY ITS OWN REGION AND NOT A PREFIX ON THE FOOTER STRING. The brand matcher matches the
 * `<footer …>` element and nothing else, so a band merely PREPENDED to the footer's markup would
 * be outside what the next run replaces — every re-run would insert another copy and the page
 * would accumulate bands. Idempotence has to come from the band owning a region the injector can
 * find and overwrite, exactly as the nav and analytics injectors do.
 *
 * REMOVAL IS PART OF THE CONTRACT: on an EXCLUDED path an existing region is stripped, so adding
 * a page to CONVERSION_BAND_EXCLUDE.paths actually takes the band off it. A pass that only ever
 * adds would leave the exclusion list describing an intent the artifact does not honour.
 *
 * @returns {{html:string, action:'replaced'|'inserted'|'removed'|'none'}}
 */
export function applyBand(html, rel, renderRegion, isExcluded, markers) {
  const { start, end } = markers;

  // STRIP-THEN-INSERT, not find-and-patch. Idempotence then holds by construction for ANY number
  // of regions, which matters because the page count is not the band count — see below.
  const stripped = stripBandRegions(html, start, end);
  const had = stripped !== html;

  if (isExcluded(rel)) return { html: stripped, action: had ? 'removed' : 'none' };

  const region = renderRegion(routeForPath(rel));
  if (!region) return { html: stripped, action: had ? 'removed' : 'none' };

  // ONE BAND PER BRAND FOOTER, and this is the correction that matters most in this pass.
  // A DUAL-RENDERED page ships two artboards swapped by an @media rule and a footer inside each
  // (landing/how-it-works.html: lp-howit-desktop + lp-howit-mobile). Anchoring on the FIRST
  // footer put the band inside the DESKTOP artboard, where `display:none` below 768px made it
  // invisible on mobile — reproducing, inside this very wave, the exact dead-below-768px class
  // CH2 exists to retire, on the audience the band is for. Measured before the fix: the band's
  // enclosing element on /how-it-works was `lp-howit-desktop`. Mirroring the footer's own
  // per-artboard treatment is the fix; only one artboard is ever rendered, so a visitor still
  // sees exactly one band.
  const parts = [];
  let last = 0;
  let n = 0;
  const re = /<footer\s+data-av-brand-footer=/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    parts.push(stripped.slice(last, m.index), region, '\n');
    last = m.index;
    n++;
  }
  if (n === 0) return { html: stripped, action: 'none' };
  parts.push(stripped.slice(last));
  return { html: parts.join(''), action: had ? 'replaced' : 'inserted' };
}

/** Remove every band region, markers included, leaving the rest byte-identical. */
export function stripBandRegions(html, start, end) {
  let out = html;
  for (;;) {
    const s = out.indexOf(start);
    if (s === -1) break;
    const e = out.indexOf(end, s);
    if (e === -1) break;
    const after = out.slice(e + end.length);
    out = out.slice(0, s) + (after.startsWith('\n') ? after.slice(1) : after);
  }
  return out;
}

/**
 * Repo-relative page path -> the route it answers on, which is what the band's `page` prop and
 * the route exclusion are keyed to. `landing/index.html` -> `/`, `landing/verify.html` ->
 * `/verify`, `landing/integrations/cline.html` -> `/integrations/cline`.
 */
export function routeForPath(rel) {
  const p = rel.replace(/^\.\//, '').replace(/^landing\//, '').replace(/\.html$/, '');
  return p === 'index' ? '/' : `/${p}`;
}

export function variantOf(footerHtml) {
  if (footerHtml.includes('padding:44px 80px 56px')) return 'desktop';
  if (footerHtml.includes('padding:32px 22px 36px')) return 'mobile';
  return null; // unknown brand-footer padding → reported as a failure, never silently skipped
}

// ──────────────────────────────────── main ───────────────────────────────────

async function main(argv) {
  const checkMode = argv.includes('--check');

  const cfgIdx = argv.indexOf('--config');
  if (cfgIdx !== -1 && !argv[cfgIdx + 1]) verdict('INDETERMINATE', '--config given with no path');
  const configPath =
    cfgIdx === -1 ? path.join(REPO_ROOT, 'ops', 'footer-coverage-config.json') : path.resolve(argv[cfgIdx + 1]);

  const rootIdx = argv.indexOf('--root');
  const root = rootIdx === -1 ? REPO_ROOT : path.resolve(argv[rootIdx + 1] || '.');

  const distIdx = argv.indexOf('--footer-dist');
  const footerDist = distIdx === -1 ? path.join(REPO_ROOT, 'dist', 'lib', 'footer-content.js') : path.resolve(argv[distIdx + 1] || '.');

  if (!existsSync(footerDist)) {
    verdict('INDETERMINATE', `missing ${footerDist} — run \`npm run build\` first`);
  }
  let renderBrandFooter, BRAND_FOOTER_BG_SIGNATURE;
  let renderConversionBandRegion, isBandExcludedPath, CONVERSION_BAND_START, CONVERSION_BAND_END;
  try {
    ({
      renderBrandFooter, BRAND_FOOTER_BG_SIGNATURE,
      renderConversionBandRegion, isBandExcludedPath, CONVERSION_BAND_START, CONVERSION_BAND_END,
    } = createRequire(SELF)(footerDist));
  } catch (e) {
    verdict('INDETERMINATE', `could not load the footer SoT from ${footerDist}: ${e.message}`);
  }
  if (typeof renderBrandFooter !== 'function' || typeof BRAND_FOOTER_BG_SIGNATURE !== 'string') {
    verdict('INDETERMINATE', 'the footer SoT did not export renderBrandFooter + BRAND_FOOTER_BG_SIGNATURE');
  }
  // Fail CLOSED on a half-loaded SoT. A missing band export would otherwise mean every page is
  // silently processed with no band and the run still prints PASS — the dark-guard shape.
  if (typeof renderConversionBandRegion !== 'function' || typeof isBandExcludedPath !== 'function'
      || typeof CONVERSION_BAND_START !== 'string' || typeof CONVERSION_BAND_END !== 'string') {
    verdict('INDETERMINATE', 'the footer SoT did not export the conversion-band region API (CONVERSION-SURFACES-W2 CH3)');
  }
  const bandMarkers = { start: CONVERSION_BAND_START, end: CONVERSION_BAND_END };
  const renderRegion = (route) => renderConversionBandRegion({ route });

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    verdict('INDETERMINATE', `config unreadable or invalid JSON at ${configPath} (${e.message})`);
  }

  const derived = deriveFooterTargets(root, config);
  if (derived.status !== 'PASS') verdict(derived.status, `${derived.why} (${configPath})`);

  const matchers = buildMatchers(BRAND_FOOTER_BG_SIGNATURE);
  const problems = [];
  let rewritten = 0;
  let inSync = 0;
  let totalBrand = 0;
  let bandCount = 0;

  for (const rel of derived.targets) {
    const abs = path.join(root, rel);
    const before = await readFile(abs, 'utf8');
    const footered = applyFooter(before, renderBrandFooter, matchers);
    // Band AFTER the footer pass so it anchors on the footer this run just wrote.
    const banded = applyBand(footered.html, rel, renderRegion, isBandExcludedPath, bandMarkers);
    const res = { ...footered, html: banded.html, action: `${footered.action}+band:${banded.action}` };
    if (banded.action === 'inserted' || banded.action === 'replaced') bandCount++;

    if (res.unknownVariant > 0) {
      problems.push(`${rel}: ${res.unknownVariant} brand footer(s) with unrecognized padding`);
      continue;
    }
    // The vacuity close: a target that ends with no brand footer is a FAILURE, not a warning.
    if (res.brandCount === 0) {
      problems.push(`${rel}: 0 brand footers after processing${res.why ? ` (${res.why})` : ''}`);
      continue;
    }
    totalBrand += res.brandCount;

    if (res.html !== before) {
      if (checkMode) {
        problems.push(`${rel}: out of sync with the SoT (${res.action})`);
      } else {
        await writeFile(abs, res.html);
        rewritten++;
        console.log(`[inject-footer] ${rel}: ${res.brandCount} footer(s) ${res.action}.`);
      }
    } else {
      inSync++;
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`[inject-footer] ${p}`);
    verdict(
      'FAIL',
      `${problems.length} problem(s) across ${derived.targets.length} target(s)` +
        (checkMode ? ' — run `node scripts/inject-footer.mjs`' : ''),
    );
  }

  verdict(
    'PASS',
    checkMode
      ? `${derived.targets.length} page(s) carry ${totalBrand} SoT footer(s) + ${bandCount} banded page(s); ${derived.exempt.length} exempt`
      : `${rewritten} page(s) rewritten, ${inSync} already in sync, ${totalBrand} SoT footer(s) + ${bandCount} banded page(s) across ${derived.targets.length} target(s)`,
  );
}

// ───────────────────────────────── self-test ─────────────────────────────────

/**
 * Hermetic + two-way + vacuity-guarded. No repo pages, no network.
 *
 * Every case runs the REAL CLI in a child process and asserts BOTH the token AND the exit code.
 * Asserting the token alone is not enough — OPS-TEST-GATE-RECONCILE-W1 found a self-test that was
 * fully green while the token→exit-code mapping had been re-coded, because nothing checked it.
 */
function selfTest() {
  const fails = [];
  let produce = 0;
  let refuse = 0;
  let map = 0;

  /**
   * Written as LITERALS on purpose. An assertion that reads its expectation from the table under
   * test is a tautology — the exact defect OPS-TEST-GATE-RECONCILE-W1 caught. Anywhere else in
   * this repo a duplicated fact is a defect; here the duplication IS the control.
   */
  const EXPECTED_CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'inject-footer.'));
  // A stand-in SoT so the self-test never depends on a built dist/.
  const fakeDist = path.join(tmp, 'footer-sot.cjs');
  writeFileSync(
    fakeDist,
    // CONVERSION-SURFACES-W2 CH3: the stand-in SoT exports the BAND API too. It has to — the
    // loader now fails CLOSED on a half-loaded SoT, and a fake that omitted these would make
    // every scenario below report INDETERMINATE. That is the seam this self-test replaces, so
    // the band cases at the end assert the artifacts the fake stands in for.
    `const BG='oklch(0.13 0.012 265)';
     exports.BRAND_FOOTER_BG_SIGNATURE=BG;
     exports.renderBrandFooter=(v)=>'<footer data-av-brand-footer="'+v+'" style="'+(v==='desktop'?'padding:44px 80px 56px':'padding:32px 22px 36px')+';background:'+BG+'">SOT</footer>';
     exports.CONVERSION_BAND_START='<!-- CONVERSION-BAND:START -->';
     exports.CONVERSION_BAND_END='<!-- CONVERSION-BAND:END -->';
     exports.isBandExcludedPath=(rel)=>rel==='landing/index.html';
     exports.renderConversionBandRegion=({route})=>exports.CONVERSION_BAND_START+'\\n<section data-conversion-band data-page="'+route+'">BAND</section>\\n'+exports.CONVERSION_BAND_END;`,
  );

  const mkRoot = (name, files) => {
    const r = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(r, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return r;
  };
  const writeCfg = (name, obj) => {
    const p = path.join(tmp, name);
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
    return p;
  };
  const run = (root, cfg, extra = []) => {
    const r = spawnSync(
      process.execPath,
      [SELF, '--root', root, '--config', cfg, '--footer-dist', fakeDist, ...extra],
      { encoding: 'utf8' },
    );
    const line = ((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => l.startsWith(`${TOKEN}=`)) || '';
    return { token: line.split('=')[1]?.split(' ')[0] || '', code: r.status ?? -1, out: r.stdout || '' };
  };
  const expect = (label, got, want) => {
    if (got !== want) fails.push(`${label}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  };
  const expectVerdict = (label, r, token) => {
    expect(`${label} token`, r.token, token);
    expect(`${label} code`, r.code, EXPECTED_CODES[token]);
  };

  try {
    const okCfg = writeCfg('ok.json', { glob: 'landing/**/*.html', exempt: [] });

    // ── must-produce: each of the three placement paths ─────────────────────
    produce += 1;
    const rBrand = mkRoot('brand', {
      'landing/a.html': '<html><body>x<footer data-av-brand-footer="desktop" style="padding:44px 80px 56px;background:oklch(0.13 0.012 265)">OLD</footer></body></html>',
    });
    expectVerdict('replace brand', run(rBrand, okCfg), 'PASS');
    expect('replace brand wrote SOT', readFileSync(path.join(rBrand, 'landing/a.html'), 'utf8').includes('>SOT<'), true);

    produce += 1;
    const rOther = mkRoot('other', {
      'landing/a.html': '<html><body>x<footer class="page-nav"><a href="/x">X</a></footer></body></html>',
    });
    expectVerdict('replace other', run(rOther, okCfg), 'PASS');
    const otherOut = readFileSync(path.join(rOther, 'landing/a.html'), 'utf8');
    expect('replace other wrote SOT', otherOut.includes('>SOT<'), true);
    expect('replace other dropped the old footer', otherOut.includes('page-nav'), false);

    produce += 1;
    const rNone = mkRoot('none', { 'landing/a.html': '<html><body>only text</body></html>' });
    expectVerdict('insert where missing', run(rNone, okCfg), 'PASS');
    const noneOut = readFileSync(path.join(rNone, 'landing/a.html'), 'utf8');
    expect('inserted SOT', noneOut.includes('>SOT<'), true);
    expect('inserted BEFORE </body>', noneOut.indexOf('>SOT<') < noneOut.indexOf('</body>'), true);

    // ── conversion band (CONVERSION-SURFACES-W2 CH3) ────────────────────────
    // These four assert the artifacts the stand-in SoT above REPLACES: the band's region
    // markers, its placement relative to the footer, its idempotence, and its removal on an
    // excluded path. A self-test that only exercised the footer would be structurally blind to
    // every one of them while still printing PASS.
    produce += 1;
    const rBand = mkRoot('band', { 'landing/a.html': '<html><body>only text</body></html>' });
    expectVerdict('band inserted', run(rBand, okCfg), 'PASS');
    const bandOut = readFileSync(path.join(rBand, 'landing/a.html'), 'utf8');
    expect('band present', bandOut.includes('data-conversion-band'), true);
    expect('band ABOVE the footer', bandOut.indexOf('data-conversion-band') < bandOut.indexOf('data-av-brand-footer'), true);
    expect('band keyed on the route, not the path', bandOut.includes('data-page="/a"'), true);

    map += 1;
    // A second run replaces the region in place rather than stacking a second band — the whole
    // reason the band owns markers instead of riding on the footer string.
    run(rBand, okCfg);
    const bandTwice = readFileSync(path.join(rBand, 'landing/a.html'), 'utf8');
    expect('band still exactly once after a 2nd run', (bandTwice.match(/data-conversion-band/g) || []).length, 1);
    expect('2nd run byte-identical', bandTwice === bandOut, true);

    map += 1;
    // DUAL-RENDER: a page with two artboards gets a band in EACH. Anchoring on the first footer
    // put the band inside lp-*-desktop, where display:none below 768px made it invisible on
    // mobile — the exact dead-below-768px class this wave exists to retire, reproduced by the
    // band. Measured on landing/how-it-works.html before the fix.
    const rDualBand = mkRoot('dualband', {
      'landing/a.html':
        '<html><body><div class="lp-x-desktop"><footer data-av-brand-footer="desktop" style="padding:44px 80px 56px;background:oklch(0.13 0.012 265)">A</footer></div>' +
        '<div class="lp-x-mobile"><footer data-av-brand-footer="mobile" style="padding:32px 22px 36px;background:oklch(0.13 0.012 265)">B</footer></div></body></html>',
    });
    expectVerdict('dual-render page', run(rDualBand, okCfg), 'PASS');
    const dualBandOut = readFileSync(path.join(rDualBand, 'landing/a.html'), 'utf8');
    expect('one band per artboard', (dualBandOut.match(/data-conversion-band/g) || []).length, 2);
    run(rDualBand, okCfg);
    expect('dual-render still 2 after a 2nd run', (readFileSync(path.join(rDualBand, 'landing/a.html'), 'utf8').match(/data-conversion-band/g) || []).length, 2);

    map += 1;
    // An EXCLUDED path must have an existing band REMOVED, or the exclusion list would describe
    // an intent the artifact does not honour.
    const rBandEx = mkRoot('bandex', { 'landing/index.html': bandOut });
    expectVerdict('band removed on an excluded path', run(rBandEx, okCfg), 'PASS');
    const exOut = readFileSync(path.join(rBandEx, 'landing/index.html'), 'utf8');
    expect('excluded page carries no band', exOut.includes('data-conversion-band'), false);
    expect('excluded page keeps its footer', exOut.includes('data-av-brand-footer'), true);

    // ── must-map ────────────────────────────────────────────────────────────
    map += 1;
    // Idempotence: a second run changes nothing, so --check passes right after a write.
    expectVerdict('idempotent --check', run(rNone, okCfg, ['--check']), 'PASS');

    map += 1;
    // Dual-render preserved: a mobile artboard stays mobile.
    const rDual = mkRoot('dual', {
      'landing/a.html':
        '<html><body><footer data-av-brand-footer="desktop" style="padding:44px 80px 56px;background:oklch(0.13 0.012 265)">A</footer>' +
        '<footer data-av-brand-footer="mobile" style="padding:32px 22px 36px;background:oklch(0.13 0.012 265)">B</footer></body></html>',
    });
    run(rDual, okCfg);
    const dualOut = readFileSync(path.join(rDual, 'landing/a.html'), 'utf8');
    expect('desktop variant kept', dualOut.includes('data-av-brand-footer="desktop"'), true);
    expect('mobile variant kept', dualOut.includes('data-av-brand-footer="mobile"'), true);

    map += 1;
    // An exemption removes a page from the target set entirely.
    const rEx = mkRoot('exempt', {
      'landing/a.html': '<html><body>a</body></html>',
      'landing/frag.html': 'no html here',
    });
    const exCfg = writeCfg('exempt.json', {
      glob: 'landing/**/*.html',
      exempt: [{ path: 'landing/frag.html', reason: 'fragment with no body anchor — long enough reason' }],
    });
    expectVerdict('exemption honoured', run(rEx, exCfg), 'PASS');
    expect('exempt file untouched', readFileSync(path.join(rEx, 'landing/frag.html'), 'utf8'), 'no html here');

    // ── must-refuse ─────────────────────────────────────────────────────────
    refuse += 1;
    // THE VACUITY CLOSE: a target that cannot receive a footer FAILS (it used to warn + pass).
    const rDark = mkRoot('dark', { 'landing/a.html': '<div>no body, no footer</div>' });
    expectVerdict('unfootable page fails', run(rDark, okCfg), 'FAIL');

    refuse += 1;
    // --check must catch a page whose footer drifted from the SoT.
    const rDrift = mkRoot('drift', {
      'landing/a.html': '<html><body><footer data-av-brand-footer="desktop" style="padding:44px 80px 56px;background:oklch(0.13 0.012 265)">STALE</footer></body></html>',
    });
    expectVerdict('--check catches drift', run(rDrift, okCfg, ['--check']), 'FAIL');

    refuse += 1;
    expectVerdict(
      'exemption without a reason',
      run(mkRoot('r1', { 'landing/a.html': '<html><body>a</body></html>' }), writeCfg('noreason.json', { glob: 'landing/**/*.html', exempt: [{ path: 'landing/a.html' }] })),
      'FAIL',
    );

    refuse += 1;
    expectVerdict(
      'stale exemption (file absent)',
      run(mkRoot('r2', { 'landing/a.html': '<html><body>a</body></html>' }), writeCfg('stale.json', { glob: 'landing/**/*.html', exempt: [{ path: 'landing/gone.html', reason: 'this page no longer exists anywhere' }] })),
      'FAIL',
    );

    refuse += 1;
    expectVerdict(
      'unknown brand-footer padding',
      run(mkRoot('r3', { 'landing/a.html': '<html><body><footer style="padding:9px;background:oklch(0.13 0.012 265)">?</footer></body></html>' }), okCfg),
      'FAIL',
    );

    refuse += 1;
    expectVerdict('glob matches nothing (vacuity)', run(mkRoot('r4', { 'other/a.html': 'x' }), okCfg), 'INDETERMINATE');

    refuse += 1;
    expectVerdict('config invalid JSON', run(mkRoot('r5', { 'landing/a.html': '<html><body>a</body></html>' }), writeCfg('bad.json', '{ not json')), 'INDETERMINATE');

    refuse += 1;
    expectVerdict(
      'exempt not an array',
      run(mkRoot('r6', { 'landing/a.html': '<html><body>a</body></html>' }), writeCfg('objex.json', { glob: 'landing/**/*.html', exempt: {} })),
      'INDETERMINATE',
    );

    refuse += 1;
    const missingDist = spawnSync(
      process.execPath,
      [SELF, '--root', tmp, '--config', okCfg, '--footer-dist', path.join(tmp, 'nope.cjs')],
      { encoding: 'utf8' },
    );
    expect('missing SoT dist code', missingDist.status, EXPECTED_CODES.INDETERMINATE);

    map += 1;
    expect('deriveFooterTargets is pure/importable', deriveFooterTargets(mkRoot('r7', { 'landing/z.html': 'x' }), { glob: 'landing/**/*.html', exempt: [] }).targets.join(), 'landing/z.html');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (produce === 0 || refuse === 0 || map === 0) {
    process.stdout.write(`${TOKEN}=INDETERMINATE — self-test VACUOUS: ${produce} must-produce, ${refuse} must-refuse, ${map} must-map\n`);
    process.exit(CODES.INDETERMINATE);
  }
  if (fails.length) {
    process.stdout.write(`${TOKEN}=FAIL — self-test ${fails.length} failure(s): ${fails.join(' | ')}\n`);
    process.exit(CODES.FAIL);
  }
  process.stdout.write(`${TOKEN}=PASS — self-test ${produce} must-produce, ${refuse} must-refuse, ${map} must-map\n`);
  process.exit(CODES.PASS);
}

// Entrypoint guard so the derivation + transforms stay importable by the coverage gate without
// the module rewriting every landing page as an import side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();
  else await main(argv);
}
