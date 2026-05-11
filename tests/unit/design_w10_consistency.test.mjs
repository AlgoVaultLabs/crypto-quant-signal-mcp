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

test('/account: Q-W10-1 + Q-W10-8 — canonical Nav present (actual class string, not <nav class="nav">)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  assert.ok(countOcc(src, '<nav class="fixed top-0 w-full z-50 border-b border-white/5"') >= 1,
    'canonical Nav opening tag missing or wrong class string');
  assert.ok(countOcc(src, 'AlgoVault Labs') >= 1, 'brand-mark "AlgoVault Labs" span missing');
  assert.ok(src.includes('href="/track-record"'), 'Track Record link missing');
  assert.ok(src.includes('href="/integrations"'), 'Integrations link missing');
  assert.ok(src.includes('href="https://api.algovault.com/account"'), 'Account link missing');
  assert.ok(src.includes('href="https://api.algovault.com/signup"'), 'Signup link missing');
});

test('/account: Q-W10-2 — Account link active-link styling (text-mint-400 font-medium)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  // The Account link uses `text-mint-400 font-medium` instead of `hover:text-white transition`.
  assert.match(src, /href="https:\/\/api\.algovault\.com\/account" class="text-mint-400 font-medium"/,
    'Account link must use text-mint-400 font-medium (active-link styling)');
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

test('/account: canonical Footer (verbatim from live algovault.com desktop variant)', async () => {
  const src = await read('src/lib/account-handlers.ts');
  assert.ok(countOcc(src, '</footer>') >= 1, 'canonical Footer closing tag missing');
  assert.ok(src.includes('Built by AlgoVault Labs'), 'Footer brand-mark missing');
  assert.ok(src.includes('href="https://github.com/AlgoVaultLabs"'), 'Footer GitHub link missing');
  assert.ok(src.includes('href="https://x.com/AlgoVaultLabs"'), 'Footer X / Twitter link missing');
  assert.ok(src.includes('href="/privacy"'), 'Footer Privacy link missing');
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
  // Both reference ACCOUNT_NAV_HTML + ACCOUNT_FOOTER_HTML + tier-stat-card.
  const errBlock = src.slice(errFn, succFn);
  const succBlock = src.slice(succFn);
  assert.ok(errBlock.includes('ACCOUNT_NAV_HTML') && errBlock.includes('ACCOUNT_FOOTER_HTML'),
    'error page must use shared Nav + Footer helpers');
  assert.ok(succBlock.includes('ACCOUNT_NAV_HTML') && succBlock.includes('ACCOUNT_FOOTER_HTML'),
    'success page must use shared Nav + Footer helpers');
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

  test(`/integrations/${ex}: Q-W10-2 — Integrations link active-link styling`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    assert.match(html, /href="\/integrations" class="text-mint-400 font-medium"/,
      'Integrations link must use text-mint-400 font-medium active-link');
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

  test(`/integrations/${ex}: Q-W10-6 — tier-stat-card wraps each h2 section + intro`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    const cards = countOcc(html, 'class="tier-stat-card"');
    const h2s = countOcc(html, /<h2[^>]*>/);
    assert.ok(cards >= h2s, `expected ≥${h2s} tier-stat-cards (one per h2 + intro), got ${cards}`);
    assert.ok(cards >= 5, `expected ≥5 tier-stat-card wrappers, got ${cards}`);
  });

  test(`/integrations/${ex}: Q-W10-7 — utm-injected canonical Nav (preserves Plausible attribution)`, async () => {
    const html = await read(`landing/integrations/${ex}.html`);
    // Per-page utm params on /track-record nav link.
    assert.match(html, new RegExp(`href="/track-record\\?utm_source=tutorial&utm_medium=web&utm_campaign=integration-${ex}"`),
      `utm-injected /track-record Nav link missing for ${ex}`);
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
    assert.ok(html.includes('plausible.io/js/pa-RwGaS0xWrfzs4vNSkMOAX.js'), 'Plausible script preserved');
    // Tailwind CDN preserved (was already loaded pre-W10).
    assert.ok(html.includes('https://cdn.tailwindcss.com'), 'Tailwind CDN preserved');
    // Per-exchange utm params on body-embedded links preserved (≥1 instance from markdown).
    assert.ok(countOcc(html, `utm_campaign=integration-${ex}`) >= 2,
      `utm_campaign=integration-${ex} must appear at least twice (Nav + body links)`);
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
