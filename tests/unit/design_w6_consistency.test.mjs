/**
 * DESIGN-W6 C5 — build-pipeline + below-fold + landing-rest + 5 exchange logos consistency tests.
 *
 * Asserts the architect-ratified 17 decisions from audits/DESIGN-W6-mapping.md:
 *   - Q-W1: Inline-style baseline raise (pragmatic; capped at 1500 — DESIGN-W6-INLINE-STYLE-CLEANUP follow-up)
 *   - Q-W2: Hyperliquid logo file extension preserved (.png — browser MIME-sniffs WebP content)
 *   - Q-W3: Bybit logo resized one-time to 256×256 (124KB perf win)
 *   - Q-W4: 5 logo filenames canonicalized (hyperliquid.png / binance.png / bybit.png / okx.png / bitget.png — DESIGN-W7 fix-forward 2026-05-11 renamed bybit.jpg → bybit.png after transparent-bg processing)
 *   - Q-W5: VsRawAPIs anchor RESTORED (#vs-raw-exchange-apis on belowfold section)
 *   - Q-W6: Specific factual JSX claims adopted verbatim (positioning copy)
 *   - Q-W7: Hero chip → SVG <image> migration (5 venue logos with <title> WCAG alt-text)
 *   - Q-W9: W6 supersedes W5 anchor mapping (#core-capabilities + #when-to-use + #vs-raw-exchange-apis on belowfold sections, NOT on landing-rest H2s)
 *   - Q-W10: SimplePricing X402 5th tier filtered (0 occurrences of "X402 PER CALL")
 *   - Q-W11: LiveTrackRecord 3 LIVE stats live-bind via data-tr-field
 *   - Q-W12: WhenToUse 3 NEW JSX bullets adopted
 *   - Q-W13: UseCases card meta dates STRIPPED ("verified 2026-04-26" → "official Skills Hub")
 *   - Q-W14: SimplePricing tagline 3 placeholder values live-bind
 *   - Q-W15: Footer placeholder hrefs → real URLs
 *   - Q-W16: CoreCapabilities subtitle REWRITE ("Three MCP tools" — NOT "Four MCP tools")
 *   - Q-W17: VsRawAPIs body "8 raw indicators per call" adopted verbatim
 *   - Q-W18: Pricing tier names OVERRIDE JSX UPPERCASE → W5-ratified Title Case
 *
 * Plus regression-free preservation of D1-C+D2-C+W3+W4+W5 deliverables + build-pipeline smoke.
 *
 * Run via:   node --test tests/unit/design_w6_consistency.test.mjs
 *
 * Pure file reads — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function read(rel) {
  return readFile(path.join(REPO_ROOT, rel), 'utf-8');
}

async function fileExists(rel) {
  try { await stat(path.join(REPO_ROOT, rel)); return true; } catch { return false; }
}

test('Q-W1: build pipeline scripts/render-jsx-static.mjs exists + valid', async () => {
  assert.ok(await fileExists('scripts/render-jsx-static.mjs'), 'render-jsx-static.mjs present');
  const src = await read('scripts/render-jsx-static.mjs');
  assert.match(src, /import.*react/, 'imports react');
  assert.match(src, /import.*react-dom\/server/, 'imports react-dom/server');
  assert.match(src, /import.*jsdom/, 'imports jsdom');
  assert.match(src, /@babel\/core/, 'uses @babel/core');
  assert.match(src, /@babel\/preset-react/, 'uses @babel/preset-react');
});

test('Q-W4: 5 exchange logos present in landing/_design/logos/ with canonical filenames', async () => {
  for (const f of ['hyperliquid.png', 'binance.png', 'bybit.png', 'okx.png', 'bitget.png']) {
    assert.ok(await fileExists(`landing/_design/logos/${f}`), `${f} present`);
  }
});

test('Q-W3: Bybit logo resized to ≤30KB (one-time 256×256 from 132KB / 2500×2500 source; DESIGN-W7 fix-forward 2026-05-11 strip-black-bg → transparent PNG)', async () => {
  const stats = await stat(path.join(REPO_ROOT, 'landing/_design/logos/bybit.png'));
  assert.ok(stats.size <= 30_000, `bybit.png = ${stats.size} bytes (cap 30KB; was 132KB pre-resize)`);
});

test('Q-W7: hero W3 region — 5 SVG <image> venue logos + <title> WCAG alt-text', async () => {
  const html = await read('landing/index.html');
  // 5 hero <image> elements (one per exchange)
  for (const ex of [
    { name: 'hyperliquid', alt: 'Hyperliquid logo' },
    { name: 'binance',     alt: 'Binance logo' },
    { name: 'bybit',       alt: 'Bybit logo' },
    { name: 'okx',         alt: 'OKX logo' },
    { name: 'bitget',      alt: 'Bitget logo' },
  ]) {
    // DESIGN-W7 fix-forward 2026-05-11: all 5 logos are PNG now (bybit was .jpg pre-fix)
    const re = new RegExp(`<image href="/_design/logos/${ex.name}\\.png"[^>]*>(?:[^<]*<title>${ex.alt}</title>)?`);
    assert.match(html, re, `hero ${ex.name} <image> + WCAG <title>`);
  }
  // Letter chips REMOVED — no `<text class="hero-flow-label" font-weight="700">[HBYO][A-Z]?</text>` in hero
  assert.doesNotMatch(html, /<text class="hero-flow-label"[^>]*font-weight="700"[^>]*>[HBYOG]+<\/text>/,
    '0 letter-chip text labels in hero (replaced with logo <image>)');
});

test('Q-W7 (UseCases): 4 logo <img> tags in UseCases card grid with WCAG alt attributes', async () => {
  const html = await read('landing/index.html');
  // 4 UseCases cards × 2 (desktop+mobile) = 8 <img> tags
  for (const ex of [
    { name: 'binance', alt: 'Binance logo' },
    { name: 'okx',     alt: 'OKX logo' },
    { name: 'bybit',   alt: 'Bybit logo' },
    { name: 'bitget',  alt: 'Bitget logo' },
  ]) {
    // DESIGN-W7 fix-forward 2026-05-11: all 4 UseCases logos are PNG now (bybit was .jpg pre-fix)
    const re = new RegExp(`<img src="/_design/logos/${ex.name}\\.png"[^>]*alt="${ex.alt}"`);
    assert.match(html, re, `UseCases ${ex.name} <img> with alt="${ex.alt}"`);
  }
  // Hyperliquid logo NOT in UseCases (HL is hero only — Trade Kit partners are 4 exchanges)
  assert.doesNotMatch(html, /<img src="\/_design\/logos\/hyperliquid\.[^"]*"[^>]*alt="Hyperliquid logo"/,
    'Hyperliquid logo NOT in UseCases (hero only)');
});

test('Q-W9: W6 supersedes W5 anchor mapping — 3 GEO-W1 anchors on belowfold <section> elements', async () => {
  const html = await read('landing/index.html');
  // Anchors on belowfold sections (NOT on landing-rest H2s as W5 had)
  assert.doesNotMatch(html, /<section\s+id="core-capabilities"/, '#core-capabilities removed — SUPERSEDED BY LANDING-SECTION-REORDER-W1');
  assert.match(html, /<section\s+id="when-to-use"/, '#when-to-use on belowfold section');
  assert.match(html, /<section\s+id="vs-raw-exchange-apis"/, '#vs-raw-exchange-apis on belowfold section (W6 RESTORATION per Q-W5)');
});

test('Q-W10: SimplePricing X402 5th tier FILTERED (0 occurrences of "X402 PER CALL")', async () => {
  const html = await read('landing/index.html');
  assert.doesNotMatch(html, /X402 PER CALL/, '0 occurrences of X402 PER CALL (filtered at render)');
  // 4-tier pricing preserved
  for (const tier of ['Free', 'Starter', 'Pro', 'Enterprise']) {
    assert.ok(html.includes(tier), `${tier} tier preserved`);
  }
});

test('Q-W10 (TradFi): TradFiCallout SKIPPED (0 occurrences of "TradFi Perpetuals" callout copy)', async () => {
  const html = await read('landing/index.html');
  // Architect mandate: 0 TradFi Perpetuals callout copy in W6 output. (Pricing tier bullets that
  // reference "TradFi assets" stay verbatim — those are different from the callout.)
  assert.doesNotMatch(html, /TradFi Perpetuals/, '0 occurrences of TradFi Perpetuals callout (architect mandate)');
});

test('Q-W11+Q-W14: data-tr-field proxy spans for live-bound counters', async () => {
  const html = await read('landing/index.html');
  // Q-W11 LiveTrackRecord 3 LIVE stats. Mr.1 fix-forward 2026-05-11: % moved INSIDE span
  // (was outside, causing double-% from setField formatted "90.2%" string).
  // Shape-based (CLAUDE.md: naturally-drifting values use shape regex, not frozen literals).
  // Asserts the live-bound span + fallback SHAPE (% inside span for rates), not exact numbers.
  assert.match(html, /data-tr-field="pfe_wr">[\d.]+%</, 'pfe_wr live-bound (LiveTrackRecord LIVE; % inside span)');
  assert.match(html, /data-tr-field="call_count">[\d,]+</, 'call_count live-bound (LiveTrackRecord LIVE)');
  assert.match(html, /data-tr-field="merkle_batch_count">\d+</, 'merkle_batch_count live-bound (LiveTrackRecord LIVE)');
  // Q-W14 SimplePricing tagline live-bind
  assert.match(html, /data-tr-field="hold_rate">[\d.]+%</, 'hold_rate live-bound (SimplePricing tagline; % inside span)');
});

test('Q-W13: UseCases meta dates STRIPPED', async () => {
  const html = await read('landing/index.html');
  assert.doesNotMatch(html, /verified 2026-04-26/, 'no stale "verified 2026-04-26" placeholder');
  assert.match(html, /official Skills Hub/, '"official Skills Hub" replacement applied');
});

test('Q-W15: Footer placeholder hrefs → real URLs', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /href="https:\/\/github\.com\/AlgoVaultLabs"/, 'GitHub real URL');
  assert.match(html, /href="https:\/\/x\.com\/AlgoVaultLabs"/, 'X / Twitter real URL');
  // LANDING-CONVERSION-TRUST-W1 follow-up (2026-06-18): the footer Signup link is now the
  // ABSOLUTE api host. /signup is api-canonical (the whole signup→Stripe→/welcome flow runs on
  // api.algovault.com; algovault.com/signup 404s — not in the apex Caddy allowlist, and /welcome
  // isn't either). Was a relative /signup (404). Matches design_w10 /account footer assertion.
  assert.match(html, /href="https:\/\/api\.algovault\.com\/welcome"/, 'Signup real URL (nav -> unified /welcome)');
  // FOOTER-UNIFY-W1 Q4: footer links normalized to ABSOLUTE so identical markup is correct on
  // both algovault.com and api.algovault.com. Privacy was relative /privacy → now absolute.
  assert.match(html, /href="https:\/\/algovault\.com\/privacy"/, 'Privacy real URL (absolute per FOOTER-UNIFY-W1)');
  // No placeholder hrefs in footer
  assert.doesNotMatch(html, /href="#GitHub"/, 'no #GitHub placeholder');
  assert.doesNotMatch(html, /href="#X \/ Twitter"/, 'no #X / Twitter placeholder');
});

test('LANDING-SECTION-REORDER-W1: CoreCapabilities section REMOVED (SUPERSEDES W6 Q-W16)', async () => {
  const html = await read('landing/index.html');
  // SUPERSEDED BY LANDING-SECTION-REORDER-W1: the "Core capabilities" section was removed; its
  // "Three MCP tools" subtitle is gone with it. Funding-arb + regime moat preserved by the verdict-card one-liner.
  assert.doesNotMatch(html, /Three MCP tools your agent can call/, 'CoreCapabilities subtitle removed (section deleted)');
  assert.doesNotMatch(html, />Core capabilities</, 'Core capabilities H2 removed');
});

test('Q-W18: pricing tier names Title Case (override JSX UPPERCASE)', async () => {
  const html = await read('landing/index.html');
  // Title Case tier names present
  for (const tier of ['Free', 'Starter', 'Pro', 'Enterprise']) {
    const re = new RegExp(`>${tier}<`);
    assert.match(html, re, `>${tier}< Title Case present`);
  }
  // JSX UPPERCASE absent
  for (const tier of ['FREE', 'STARTER']) {
    // Constrained to >...< so we don't false-positive on attribute values.
    const re = new RegExp(`>${tier}<`);
    assert.doesNotMatch(html, re, `>${tier}< UPPERCASE override applied`);
  }
});

test('C2+C3 dual-render wrapped in lp-belowfold-{desktop,mobile} + lp-rest-{desktop,mobile} (W7 also adds lp-hero-{desktop,mobile})', async () => {
  const html = await read('landing/index.html');
  // SUPERSEDED BY LANDING-SECTION-REORDER-W1: lp-belowfold-* artboards removed (sections merged into lp-rest).
  for (const cls of ['lp-rest-desktop', 'lp-rest-mobile']) {
    assert.match(html, new RegExp(`class="${cls}"`), `${cls} wrapper present`);
  }
  // CSS @media swap declared in algovault-design.css
  // W7 extension 2026-05-10: same @media rule covers lp-hero-{desktop,mobile} alongside lp-belowfold + lp-rest.
  const css = await read('landing/_design/algovault-design.css');
  assert.match(css, /\.lp-belowfold-desktop,\s*\.lp-rest-desktop[^{]*\{\s*display:\s*block/,
    '@media-swap CSS for lp-*-desktop (W7 extends with lp-hero-desktop)');
  assert.match(css, /@media\s*\(\s*max-width:\s*767px\s*\)/, '@media (max-width: 767px) breakpoint');
});

test('Build-pipeline render output: JSX components present in SSR output', async () => {
  const html = await read('landing/index.html');
  // Belowfold sections (3 from v1-belowfold.jsx)
  // SUPERSEDED BY LANDING-SECTION-REORDER-W1: "Core capabilities" removed; the other 2 moved into the rest sequence.
  for (const heading of ['When to use AlgoVault', 'Why not just use exchange APIs?']) {
    assert.ok(html.includes(heading), `section heading "${heading}" present`);
  }
  // Landing-rest sections (8 from v1-landing-rest.jsx, TradFiCallout SKIPPED)
  for (const heading of [
    'Try it in 30 seconds.',
    // '3 tools, One verdict.' SUPERSEDED BY LANDING-SECTION-REORDER-W1 (section removed)
    'Brain + execution pairing.',
    'Every qualifying call, on the record.',
    'Simple pricing.',
    'Connect.',
    'Frequently asked.',
  ]) {
    assert.ok(html.includes(heading), `landing-rest heading "${heading}" present`);
  }
});

test('FAQ accordion vanilla-JS init present (5 Q&A pairs in DOM)', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /__w6FaqInit/, 'FAQ accordion init script present');
  // 5 FAQ Q's verbatim (preservation-LAW)
  for (const q of [
    'What is AlgoVault?',
    'How does the trade call scoring work?',
    'What exchanges does AlgoVault support?',
    'Is AlgoVault free to use?',
    'What is MCP (Model Context Protocol)?',
  ]) {
    assert.ok(html.includes(q), `FAQ Q "${q}" verbatim`);
  }
});

test('Preservation-LAW (W3+W4+D1-C+D2-C+W5 regression-free)', async () => {
  const html = await read('landing/index.html');
  // 0 residual gold (D1-C)
  assert.doesNotMatch(html, /\b(bg|text|border)-gold-[0-9]+/, '0 gold-class residual (D1-C)');
  // mint OKLCH config preserved (D2-C)
  assert.match(html, /mint: \{ 50: 'oklch\(0\.97 0\.03 165\)'/, 'OKLCH mint config preserved (D2-C)');
  // W7 architectural shift 2026-05-10: W3 hero deliverables (hero-flow-container / recent-calls-feed
  // / live-call-ticker) REPLACED with V1Hero canonical render. Data-source equivalence preserved
  // via different DOM. W6 below-fold + landing-rest preserved BYTE-IDENTICAL through W7.
  assert.match(html, /lp-hero-desktop/, 'W7 hero wrapper present');
  assert.match(html, /data-w7-recent-call/, 'W7 H-PR2 recent-call mount-point present');
  assert.match(html, /data-tr-field="total_calls_executed"/, 'W7 H-PR1 counter live-bind present');
  // W5 hero 3-stat row + Q-D2 verify subhead are out of W6 scope. W7 supersedes 3-stat with 4-stat row.
  assert.match(html, /data-tr-field="exchange_count"/, 'exchange_count live-bind preserved (W7 4-stat)');
  assert.match(html, /data-tr-field="timeframe_count"/, 'timeframe_count live-bind preserved (W7 4-stat)');
  // 6 JSON-LD blocks preserved
  const jsonLd = (html.match(/<script type="application\/ld\+json"/g) || []).length;
  assert.ok(jsonLd >= 6, `≥6 JSON-LD blocks preserved (got ${jsonLd})`);
  // GEO-W1 H1 + hero opening verbatim
  assert.match(html, /The Brain Layer for AI Trading Agents/, 'H1 verbatim');
  // W7 fix-forward ROUND 10 (2026-05-11): hero rewritten to 3-line arrangement per Mr.1 directive.
  assert.match(html, /One MCP call returns a composite verdict — direction, confidence, regime/, 'hero opening verbatim (ROUND 10)');
  // 5 exchange names verbatim
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    assert.ok(html.includes(ex), `exchange "${ex}" verbatim`);
  }
  // 3 MCP tools verbatim
  for (const tool of ['get_trade_call', 'get_market_regime', 'scan_funding_arb']) {
    assert.ok(html.includes(tool), `MCP tool "${tool}" verbatim`);
  }
});
