/**
 * DESIGN-W10 C4 — canonical Landing chrome rollout to 5 internal pages
 * (/account function-rendered + /integrations × 4 build-time-rendered).
 *
 * Asserts the architect-ratified 10 Q-W10-N decisions from audits/DESIGN-W10-mapping.md:
 *   - Q-W10-1: canonical Nav source = live algovault.com (post-W9 + post-W7-FF state)
 *   - Q-W10-2: per-page active-link styling (text-mint-400 font-medium)
 *   - Q-W10-3: /account canonical H1 (`Your <span>Account</span>`)
 *   - Q-W10-4: /integrations preserve markdown H1 + canonical hero scaffolding above
 *   - Q-W10-5: SKIP — no nav-pill primitive added
 *   - Q-W10-6: VCard = tier-stat-card (oklch(0.18 0.014 265 / 0.5) per W8-FIX directive)
 *   - Q-W10-7: OPTION B — per-page utm-injected canonical Nav for /integrations
 *   - Q-W10-8: actual nav class string `<nav class="fixed top-0 w-full z-50 …">`
 *   - Q-W10-9: 1 JSON-LD block per /integrations file preserved baseline (GEO-W2 deferred)
 *   - Q-W10-10: /account body-flex-centering replaced with var(--bg) layout
 *
 * Preservation-LAW: Stripe portal POST + key recovery POST + switchTab JS + mailto
 * (/account); markdown body + 1 JSON-LD + Plausible + quotable-fact + Tailwind CDN
 * + per-exchange utm params (/integrations).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

async function read(rel) {
  return readFile(resolve(REPO_ROOT, rel), 'utf8');
}

function countOcc(haystack, needle) {
  if (typeof needle === 'string') {
    let n = 0, idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
    return n;
  }
  const re = needle.global ? needle : new RegExp(needle.source, needle.flags + 'g');
  const m = haystack.match(re);
  return m ? m.length : 0;
}

const INTEGRATIONS = ['binance', 'okx', 'bybit', 'bitget'];
const DISPLAY = { binance: 'Binance', okx: 'OKX', bybit: 'Bybit', bitget: 'Bitget' };

// ── /account chrome assertions (Q-W10-1/2/3/6/8/10) ──────────────────────────

// LANDING-MOBILE-NAV-FUNCTION-RENDERED-W1: the canonical nav was extracted to the shared
// SoT src/lib/site-nav.ts (renderSiteNav). /account DELEGATES; the byte-level nav content
// contract is owned by tests/site-nav.test.ts (frozen-oracle byte-equivalence).
test('/account: Q-W10-1 + Q-W10-8 — canonical Nav via shared renderSiteNav (NAV-PLATFORM-GENERATOR-W1)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // NAV-PLATFORM-GENERATOR-W1: /account delegates to the arg-less shared renderSiteNav() — one
  // byte-identical Platform mega-menu region for every surface (absolute hrefs uniformly).
  assert.match(src, /renderSiteNav\(\)/, '/account must render its nav via the shared renderSiteNav()');
  assert.strictEqual(countOcc(src, '<nav class="fixed top-0'), 0,
    'inline <nav> literal must be retired (now via renderSiteNav)');
  // Canonical nav content (class string, absolute links, brand-mark) — assert the RENDERED nav
  // (content now derives from the model in nav-manifest.ts, so read the render, not the source):
  const { renderSiteNav } = await import('../../dist/lib/site-nav.js');
  const nav = renderSiteNav();
  assert.ok(nav.includes('<nav class="fixed top-0 w-full z-50 border-b border-white/5"'),
    'canonical Nav opening tag missing or wrong class string');
  assert.ok(nav.includes('AlgoVault Labs'), 'brand-mark "AlgoVault Labs" missing');
  assert.ok(nav.includes('https://algovault.com/integrations'), 'Integrations link missing (Platform > Ecosystem)');
  assert.ok(nav.includes('https://api.algovault.com/account'), 'Account link missing');
  assert.ok(nav.includes('https://api.algovault.com/welcome'), 'Signup CTA (nav -> /welcome) missing');
});

test('/account: Q-W10-2 — active-link styling applied client-side by the shared nav controller', async () => {
  const src = await read('src/lib/account-handlers.ts');
  assert.match(src, /renderSiteNav\(\)/, '/account must render its nav via the shared renderSiteNav()');
  // NAV-PLATFORM-GENERATOR-W1: the current-page highlight is now applied CLIENT-SIDE by the
  // controller (byte-identical HTML on every surface; JS marks the matching link mint) — so the
  // active mint style is a runtime classList.add, not a server-rendered class.
  const { renderSiteNav } = await import('../../dist/lib/site-nav.js');
  const nav = renderSiteNav();
  assert.ok(nav.includes("classList.add('text-mint-400','font-medium')"),
    'shared nav controller must apply the mint active-link style client-side');
  assert.ok(nav.includes('data-nav-link'), 'top-bar links must carry data-nav-link for the active matcher');
});

test('/account: Q-W10-3 — canonical H1 with mint accent on `Account` (3 pages: main + error + success)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  assert.ok(countOcc(src, "accountH1('Your', 'Account')") >= 1, 'main page H1 helper call missing');
  // mint-accent span pattern (helper template literal — single occurrence in source).
  assert.ok(countOcc(src, '<span style="color: var(--accent, var(--mint))">') >= 1,
    'canonical mint-accent span pattern missing');
});

test('/account: Q-W10-6 — tier-stat-card VCard wraps content on all 3 page renders', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // 3 pages × 1 tier-stat-card wrapper each.
  assert.ok(countOcc(src, 'class="tier-stat-card"') >= 3,
    'expected ≥3 tier-stat-card VCard wrappers (main + error + success)');
});

test('/account: Q-W10-8 — Tailwind CDN script tag + mint OKLCH config loaded (mirror render-integrations.mjs pattern)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  assert.ok(src.includes('https://cdn.tailwindcss.com'), 'Tailwind CDN script tag missing');
  assert.ok(src.includes("mint: { 50: 'oklch(0.97 0.03 165)'"),
    'Tailwind mint OKLCH config block missing (must mirror render-integrations.mjs)');
  assert.ok(src.includes("400: 'oklch(0.86 0.16 165)'"),
    'mint-400 anchor (oklch(0.86 0.16 165)) missing — canonical D1-C anchor');
});

test('/account: Q-W10-10 — body-flex-centering REPLACED with var(--bg) layout', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // OLD pattern (must be absent): display: flex; justify-content: center; align-items: center; min-height: 100vh
  assert.strictEqual(countOcc(src, 'justify-content: center; align-items: center; min-height: 100vh'), 0,
    'body-flex-centering must be removed (Q-W10-10)');
  // NEW pattern (must be present): canonical body styles via CSS vars
  assert.match(src, /body \{ font-family: var\(--font-text/, 'canonical body var(--font-text) styles missing');
  assert.match(src, /background: var\(--bg\)/, 'body background: var(--bg) missing');
});

test('/account: canonical hero scaffolding (artboard + 3 bg layers + VEyebrow) on all 3 page renders', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // accountArtboardOpen() helper — single source. 3 page renders call it.
  assert.ok(src.includes('class="lp-account-desktop"'), 'lp-account-desktop wrapper missing');
  assert.ok(src.includes('class="artboard"'), 'artboard class missing');
  assert.ok(src.includes('class="bg-grid"'), 'bg-grid layer missing');
  assert.ok(src.includes('class="bg-radial-accent"'), 'bg-radial-accent layer missing');
  assert.ok(src.includes('class="bg-noise"'), 'bg-noise layer missing');
  assert.ok(countOcc(src, 'class="placeholder-cap"') >= 3,
    'expected ≥3 placeholder-cap VEyebrow (one per page render)');
});

test('/account: footer renders from the single brand-footer SoT (FOOTER-UNIFY-W1)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // FOOTER-UNIFY-W1: ACCOUNT_FOOTER_HTML retired — the 3 account renders use the ONE SoT footer.
  assert.strictEqual(countOcc(src, "renderBrandFooter('desktop')"), 3,
    'all 3 account page renders must use renderBrandFooter (single source)');
  assert.strictEqual(countOcc(src, '</footer>'), 0, 'no inline footer literal may survive in account-handlers');
  // The SoT carries the canonical footer (brand-mark + GitHub/X/Privacy, absolute URLs per Q4).
  const sot = await read('src/lib/footer-content.ts');
  assert.ok(sot.includes('Built by AlgoVault Labs'), 'SoT Footer brand-mark missing');
  assert.ok(sot.includes('https://github.com/AlgoVaultLabs'), 'SoT Footer GitHub link missing');
  assert.ok(sot.includes('https://x.com/AlgoVaultLabs'), 'SoT Footer X / Twitter link missing');
  assert.ok(sot.includes('https://algovault.com/privacy'), 'SoT Footer Privacy link missing (absolute)');
});

// ── /account preservation-LAW ───────────────────────────────────────────────

test('/account preservation-LAW: Stripe portal POST + key recovery POST + switchTab JS + mailto', async () => {
  const src = await read('src/lib/account-handlers.ts');
  assert.strictEqual(countOcc(src, 'action="/account/portal"'), 1, 'Stripe portal action preserved');
  assert.strictEqual(countOcc(src, 'action="/account/recover-key"'), 1, 'key recovery action preserved');
  assert.strictEqual(countOcc(src, 'function switchTab'), 1, 'switchTab JS preserved');
  assert.ok(countOcc(src, 'mailto:support@algovault.com') >= 3,
    'support@algovault.com mailto preserved on all 3 page renders');
  // ACCOUNT_PAGE_STYLES class skeleton preserved (.tabs/.tab/.panel/.subtitle).
  assert.ok(src.includes('.tabs {'), '.tabs CSS class preserved');
  assert.ok(src.includes('.tab '), '.tab CSS class preserved');
  assert.ok(src.includes('.panel '), '.panel CSS class preserved');
  assert.ok(src.includes('.subtitle '), '.subtitle CSS class preserved');
});

test('/account preservation-LAW: error + success page handlers also receive canonical chrome', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // All 3 functions (getAccountPageHtml + getAccountErrorPageHtml + getAccountRecoverySuccessHtml)
  // emit Nav + Footer + tier-stat-card.
  const errFn = src.indexOf('export function getAccountErrorPageHtml');
  const succFn = src.indexOf('export function getAccountRecoverySuccessHtml');
  assert.ok(errFn > 0 && succFn > 0, 'sister page-render functions present');
  // Both reference ACCOUNT_NAV_HTML + the SoT renderBrandFooter (FOOTER-UNIFY-W1) + tier-stat-card.
  const errBlock = src.slice(errFn, succFn);
  const succBlock = src.slice(succFn);
  assert.ok(errBlock.includes('ACCOUNT_NAV_HTML') && errBlock.includes("renderBrandFooter('desktop')"),
    'error page must use shared Nav + the SoT renderBrandFooter');
  assert.ok(succBlock.includes('ACCOUNT_NAV_HTML') && succBlock.includes("renderBrandFooter('desktop')"),
    'success page must use shared Nav + the SoT renderBrandFooter');
});

// ── /integrations × 4 chrome assertions (parametrized) ───────────────────────

for (const ex of INTEGRATIONS) {
  const display = DISPLAY[ex];

  test(`/integrations/${ex}: Q-W10-1 + Q-W10-8 — canonical Nav present (actual class string)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    assert.strictEqual(countOcc(html, '<nav class="fixed top-0 w-full z-50 border-b border-white/5"'), 1,
      `canonical Nav must be present exactly once on ${ex}.html`);
    // Legacy header replaced.
    assert.strictEqual(countOcc(html, 'border-b border-navy-600 px-6 py-4'), 0,
      'legacy custom nav header must be removed');
  });

  test(`/integrations/${ex}: Q-W10-2 — Integrations reachable in nav (Platform > Ecosystem); active-link client-side`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    // NAV-PLATFORM-GENERATOR-W1: Integrations moved into the Platform mega-menu Ecosystem column
    // (absolute href, A6); the current-page mint highlight is applied client-side by the controller.
    assert.match(html, /href="https:\/\/algovault\.com\/integrations"[^>]*>Integrations</,
      'Integrations link must be present in the unified nav (Platform > Ecosystem)');
    assert.ok(html.includes("classList.add('text-mint-400','font-medium')"),
      'client-side active-link controller must be present');
  });

  test(`/integrations/${ex}: Q-W10-4 — markdown H1 preserved + VEyebrow above`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    // Markdown H1 preserved byte-identical (from algovault-skills/docs/integrations/<x>.md).
    assert.match(html, new RegExp(`<h1>AlgoVault × ${display}`),
      `markdown H1 "AlgoVault × ${display}" must be preserved byte-identical`);
    // VEyebrow `· <exchange> integration` above markdown body.
    assert.ok(html.includes(`<div class="placeholder-cap" style="margin-bottom:14px">· ${ex} integration</div>`),
      `VEyebrow "· ${ex} integration" missing`);
  });

  test(`/integrations/${ex}: Q-W10-6 (DESIGN-W10-FF-2 RESTORED) — tier-stat-card per-section wrapping intact`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    // DESIGN-W10-FF-1 (2026-05-12) misread Mr.1's "Remove cards in Image 1" directive
    // and removed all section cards. DESIGN-W10-FF-2 (2026-05-12) corrected per Mr.1
    // clarification ("I means remove this section, not the section cards"): cards
    // RESTORED; instead the redundant TL;DR section content is stripped.
    const cards = countOcc(html, 'class="tier-stat-card"');
    assert.ok(cards >= 5, `expected ≥5 tier-stat-card wrappers (intro + per-h2 sections), got ${cards}`);
  });

  test(`/integrations/${ex}: DESIGN-W10-FF-2 — TL;DR section stripped (h2 + bullets gone; redundant with quotable-fact above)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    assert.strictEqual(countOcc(html, /<h2>TL;DR/g), 0, 'TL;DR h2 must be stripped');
    assert.strictEqual(countOcc(html, 'Not 26 raw indicators'), 0, 'TL;DR bullet 1 text must be stripped');
    assert.strictEqual(countOcc(html, 'Funding spreads, regime alignment'), 0, 'TL;DR bullet 2 text must be stripped');
    assert.strictEqual(countOcc(html, 'Verifiable accuracy, not a marketing claim'), 0, 'TL;DR bullet 3 text must be stripped');
  });

  test(`/integrations/${ex}: DESIGN-W10-FF-3 — top snapshot blockquote pair stripped (3 elements: marker + metrics line + Don't trust callout)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    // Body residuals must be 0; meta tags in <head> intentionally preserved (out of scope).
    assert.strictEqual(countOcc(html, /Don['’]t trust/g), 0,
      '"Don\'t trust" callout must be stripped from body');
    assert.strictEqual(countOcc(html, 'live numbers refreshed in-page from'), 0,
      '"live numbers refreshed in-page from" snapshot date line must be stripped');
    // The top snapshot block's <blockquote><!-- snapshot --></blockquote> + <p><strong>...</strong></p>
    // is gone. Closing "Why AlgoVault?" recap section may still contain a similar
    // <!-- snapshot --> comment (out of W10-FF-3 scope; Mr.1 directive applied to top block only).
    // PRESERVED: composite-verdict intro paragraph + Provenance blockquote.
    assert.ok(html.includes('composite verdict'), 'composite-verdict intro paragraph must be preserved');
    assert.ok(html.includes('<strong>Provenance:</strong>'), 'Provenance blockquote must be preserved');
  });

  test(`/integrations/${ex}: Q-W10-7 — Plausible attribution preserved on body links (nav utm retired for single-derivation)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    // SEO-STRIP-TRACKING-PARAMS-W1: the internal utm_* on body track-record links was stripped
    // (Google treats /track-record?utm_… as a duplicate — crawl-budget waste). Per-exchange
    // attribution is now carried by a Plausible custom event (same pattern as the /integrations
    // index cards), NOT a URL param. The nav /track-record link stays the clean absolute href.
    assert.ok(countOcc(html, `plausible('CTA Click',{props:{source:'integration_tutorial',slug:'${ex}',campaign:'track-record'}})`) >= 1,
      `per-exchange Plausible attribution event must survive on a body track-record link for ${ex}`);
    assert.match(html, /<!-- NAV:START -->[\s\S]*href="https:\/\/algovault\.com\/track-record"[\s\S]*<!-- NAV:END -->/,
      `nav /track-record must be the clean absolute href (no utm) for ${ex}`);
  });

  test(`/integrations/${ex}: Q-W10-9 — 1 JSON-LD block preserved (TechArticle, not 5)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    assert.strictEqual(countOcc(html, /<script type="application\/ld\+json"/g), 1,
      `expected exactly 1 JSON-LD block (TechArticle); GEO-W2 deferred for expansion`);
    assert.ok(html.includes('"@type": "TechArticle"'), 'TechArticle schema missing');
  });

  test(`/integrations/${ex}: canonical Footer (verbatim) + legacy footer removed`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    assert.strictEqual(countOcc(html, '</footer>'), 1, 'canonical Footer closing tag present');
    assert.ok(html.includes('Built by AlgoVault Labs'), 'Footer brand-mark present');
    // Legacy footer replaced.
    assert.strictEqual(countOcc(html, 'border-t border-navy-600 px-6 py-6 mt-12'), 0,
      'legacy custom footer must be removed');
  });

  test(`/integrations/${ex}: hero scaffolding (artboard + 3 bg layers)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    assert.strictEqual(countOcc(html, 'class="lp-integrations-desktop"'), 1, 'lp-integrations-desktop wrapper present');
    assert.strictEqual(countOcc(html, 'class="artboard"'), 1, 'artboard class present');
    assert.strictEqual(countOcc(html, 'class="bg-grid"'), 1, 'bg-grid layer present');
    assert.strictEqual(countOcc(html, 'class="bg-radial-accent"'), 1, 'bg-radial-accent layer present');
    assert.strictEqual(countOcc(html, 'class="bg-noise"'), 1, 'bg-noise layer present');
  });

  test(`/integrations/${ex}: preservation-LAW — markdown body + Plausible + quotable-fact + Tailwind CDN`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    // Quotable-fact block preserved.
    assert.ok(html.includes('itemtype="https://schema.org/Claim"'), 'quotable-fact Schema.org Claim preserved');
    assert.ok(html.includes('data-tr-field="pfe_wr"'), 'pfe_wr live-bind span preserved');
    assert.ok(html.includes('data-tr-field="signal_count"'), 'signal_count live-bind span preserved');
    // Plausible analytics preserved.
    assert.ok(html.includes('src="/js/insights.js"'), 'Plausible script preserved (first-party proxy)');
    // Tailwind CDN preserved (was already loaded pre-W10).
    assert.ok(html.includes('https://cdn.tailwindcss.com'), 'Tailwind CDN preserved');
    // SEO-STRIP-TRACKING-PARAMS-W1: internal utm on body track-record links was stripped
    // (Google duplicate-URL crawl waste); per-exchange attribution now rides a Plausible event.
    assert.ok(countOcc(html, `plausible('CTA Click',{props:{source:'integration_tutorial',slug:'${ex}',campaign:'track-record'}})`) >= 1,
      `per-exchange Plausible attribution event must appear on >=1 body track-record link for ${ex}`);
  });
}

// ── DESIGN-W10-FF (2026-05-12) — top-left logo links to homepage on every page ──

test('DESIGN-W10-FF: /account brand-mark wrapped in <a href="https://algovault.com/"> — via shared nav SoT (absolute, cross-host)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // Cross-host: /account is on api.algovault.com; the brand-mark uses the absolute
  // https://algovault.com/ href (a relative `/` would resolve to api.algovault.com/ and 404).
  // Nav extracted to the shared SoT src/lib/site-nav.ts; /account delegates via renderSiteNav().
  assert.match(src, /renderSiteNav\(\)/, '/account nav comes from the shared renderSiteNav()');
  const { renderSiteNav } = await import('../../dist/lib/site-nav.js');
  const nav = renderSiteNav();
  assert.match(nav, /<a href="https:\/\/algovault\.com\/" class="flex items-center gap-2\.5"/,
    'shared nav brand-mark must wrap in <a> with absolute URL https://algovault.com/');
  assert.ok(nav.includes('aria-label="AlgoVault home"'),
    'brand-mark <a> should have aria-label for accessibility');
});

for (const ex of INTEGRATIONS) {
  test(`DESIGN-W10-FF: /integrations/${ex} brand-mark wrapped in <a href="/"> (relative — same-origin algovault.com)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    assert.match(html, /<a href="https:\/\/algovault\.com\/" class="flex items-center gap-2\.5"/,
      `/integrations/${ex} brand-mark must wrap in <a> with relative href="/"`);
    assert.ok(html.includes('aria-label="AlgoVault home"'),
      'brand-mark <a> should have aria-label for accessibility');
  });
}

test('DESIGN-W10-FF: landing/index.html brand-mark wrapped in <a href="/"> (was the outlier — other landing pages already had it)', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /<a href="https:\/\/algovault\.com\/" class="flex items-center gap-2\.5"/,
    'landing/index.html brand-mark must wrap in <a> with relative href="/"');
  // Plain <div class="flex items-center gap-2.5"> at the brand-mark position should be absent.
  assert.strictEqual(countOcc(html, /<div class="flex items-center gap-2\.5">\s*<img src="\/logo\.png" alt="AlgoVault Logo"/), 0,
    'legacy plain <div> at brand-mark must be replaced by <a>');
});

// Spot-check 3 sister landing pages already had the link (no fix needed; confirm preservation).
for (const page of ['landing/integrations.html', 'landing/skills.html', 'landing/faq.html']) {
  test(`DESIGN-W10-FF: ${page} homepage brand-mark preserved (absolute href — NAV-PLATFORM-GENERATOR-W1 A6)`, async () => {
    const html = await read(page);
    assert.ok(html.includes('<a href="https://algovault.com/" class="flex items-center gap-2.5"') && html.includes('AlgoVault Logo'),
      `${page} must preserve the homepage brand-mark wrap`);
  });
}

// ── Build Rule 9 / Factuality canary on new chrome prose ─────────────────────

test('Build Rule 9 canary — no forbidden hype phrases in /account chrome', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // Strip HTML comments per `comment-vs-rendered-DOM-aware-canary` DESIGN-W8 WI pattern.
  const stripped = src.replace(/<!--[\s\S]*?-->/g, '');
  const forbidden = [
    'industry-leading', 'cutting-edge', 'revolutionary', 'world-class', 'best-in-class',
    'next-generation', 'game-changing', 'paradigm shift', 'unparalleled', 'unmatched',
  ];
  for (const phrase of forbidden) {
    assert.strictEqual(stripped.toLowerCase().includes(phrase), false,
      `forbidden hype phrase "${phrase}" present in /account chrome`);
  }
});

test('Build Rule 9 canary — no forbidden hype phrases in /integrations × 4', async () => {
  for (const ex of INTEGRATIONS) {
    const html = await read(`landing/integrations/${ex}.html`);
    const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
    const forbidden = ['industry-leading', 'cutting-edge', 'revolutionary', 'paradigm shift'];
    for (const phrase of forbidden) {
      assert.strictEqual(stripped.toLowerCase().includes(phrase), false,
        `forbidden phrase "${phrase}" present in ${ex}.html chrome`);
    }
  }
});

// ── Factuality canary on chrome additions (no fictional placeholder metrics) ─

test('Factuality canary — no fictional placeholder metrics in /account chrome', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // No "X+ users", "Y customers", "Z% uptime" placeholder prose in chrome additions.
  const stripped = src.replace(/<!--[\s\S]*?-->/g, '');
  const fictional = [/\b\d+,\d{3}\+\s*customers?\b/i, /\b\d+\+\s*users?\b/i, /\b99\.\d+%\s*uptime/i];
  for (const re of fictional) {
    assert.strictEqual(re.test(stripped), false, `fictional placeholder metric "${re}" present`);
  }
});

// ── /account body-style relaxation documentation canary ──────────────────────

test('/account body-style relaxation — canonical CSS vars used (var(--bg) + var(--fg-2) + var(--mint))', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // After Q-W10-10, the ACCOUNT_PAGE_STYLES use canonical CSS variables, NOT hardcoded hex colors.
  // (Some inline hex colors may remain in legacy class definitions; the key is the body block.)
  assert.match(src, /body \{ font-family: var\(--font-text/, 'body uses var(--font-text)');
  assert.match(src, /color: var\(--fg\)/, 'body uses var(--fg) for text color');
  assert.match(src, /background: var\(--bg\)/, 'body uses var(--bg) for background');
});
