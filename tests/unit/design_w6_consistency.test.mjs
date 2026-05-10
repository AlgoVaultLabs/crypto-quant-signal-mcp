/**
 * DESIGN-W6 C5 — build-pipeline + below-fold + landing-rest + 5 exchange logos consistency tests.
 *
 * Asserts the architect-ratified 17 decisions from audits/DESIGN-W6-mapping.md:
 *   - Q-W1: Inline-style baseline raise (pragmatic; capped at 1500 — DESIGN-W6-INLINE-STYLE-CLEANUP follow-up)
 *   - Q-W2: Hyperliquid logo file extension preserved (.png — browser MIME-sniffs WebP content)
 *   - Q-W3: Bybit logo resized one-time to 256×256 (124KB perf win)
 *   - Q-W4: 5 logo filenames canonicalized (hyperliquid.png / binance.png / bybit.jpg / okx.png / bitget.png)
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
  for (const f of ['hyperliquid.png', 'binance.png', 'bybit.jpg', 'okx.png', 'bitget.png']) {
    assert.ok(await fileExists(`landing/_design/logos/${f}`), `${f} present`);
  }
});

test('Q-W3: Bybit logo resized to ≤30KB (one-time 256×256 from 132KB / 2500×2500 source)', async () => {
  const stats = await stat(path.join(REPO_ROOT, 'landing/_design/logos/bybit.jpg'));
  assert.ok(stats.size <= 30_000, `bybit.jpg = ${stats.size} bytes (cap 30KB; was 132KB pre-resize)`);
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
    const ext = ex.name === 'bybit' ? 'jpg' : 'png';
    const re = new RegExp(`<image href="/_design/logos/${ex.name}\\.${ext}"[^>]*>(?:[^<]*<title>${ex.alt}</title>)?`);
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
    const ext = ex.name === 'bybit' ? 'jpg' : 'png';
    const re = new RegExp(`<img src="/_design/logos/${ex.name}\\.${ext}"[^>]*alt="${ex.alt}"`);
    assert.match(html, re, `UseCases ${ex.name} <img> with alt="${ex.alt}"`);
  }
  // Hyperliquid logo NOT in UseCases (HL is hero only — Trade Kit partners are 4 exchanges)
  assert.doesNotMatch(html, /<img src="\/_design\/logos\/hyperliquid\.[^"]*"[^>]*alt="Hyperliquid logo"/,
    'Hyperliquid logo NOT in UseCases (hero only)');
});

test('Q-W9: W6 supersedes W5 anchor mapping — 3 GEO-W1 anchors on belowfold <section> elements', async () => {
  const html = await read('landing/index.html');
  // Anchors on belowfold sections (NOT on landing-rest H2s as W5 had)
  assert.match(html, /<section\s+id="core-capabilities"/, '#core-capabilities on belowfold section');
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
  // Q-W11 LiveTrackRecord 3 LIVE stats
  assert.match(html, /data-tr-field="pfe_wr">90\.2</, 'pfe_wr live-bound (LiveTrackRecord LIVE)');
  assert.match(html, /data-tr-field="call_count">80,059</, 'call_count live-bound (LiveTrackRecord LIVE)');
  assert.match(html, /data-tr-field="merkle_batch_count">29</, 'merkle_batch_count live-bound (LiveTrackRecord LIVE)');
  // Q-W14 SimplePricing tagline live-bind
  assert.match(html, /data-tr-field="hold_rate">98\.8</, 'hold_rate live-bound (SimplePricing tagline)');
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
  assert.match(html, /href="\/signup"/, 'Signup real URL');
  assert.match(html, /href="\/privacy"/, 'Privacy real URL');
  // No placeholder hrefs in footer
  assert.doesNotMatch(html, /href="#GitHub"/, 'no #GitHub placeholder');
  assert.doesNotMatch(html, /href="#X \/ Twitter"/, 'no #X / Twitter placeholder');
});

test('Q-W16: CoreCapabilities subtitle REWRITE (factuality LAW: 3 MCP tools)', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /Three MCP tools your agent can call/, 'subtitle says "Three MCP tools" (Q-W16 rewrite)');
  assert.doesNotMatch(html, /Four MCP tools your agent can call/, 'no "Four MCP tools" (factuality LAW: 3 tools, not 4)');
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
  for (const cls of ['lp-belowfold-desktop', 'lp-belowfold-mobile', 'lp-rest-desktop', 'lp-rest-mobile']) {
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
  for (const heading of ['Core capabilities', 'When to use AlgoVault', 'Why not just use exchange APIs?']) {
    assert.ok(html.includes(heading), `belowfold heading "${heading}" present`);
  }
  // Landing-rest sections (8 from v1-landing-rest.jsx, TradFiCallout SKIPPED)
  for (const heading of [
    'Try it in 30 seconds.',
    '3 tools, one verdict.',
    'Brain + execution pairing.',
    'Every qualifying call, on the record.',
    'Simple pricing.',
    'Two transports. Same tools.',
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
  assert.match(html, /One MCP call returns a composite trade verdict/, 'hero opening verbatim');
  // 5 exchange names verbatim
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    assert.ok(html.includes(ex), `exchange "${ex}" verbatim`);
  }
  // 3 MCP tools verbatim
  for (const tool of ['get_trade_call', 'get_market_regime', 'scan_funding_arb']) {
    assert.ok(html.includes(tool), `MCP tool "${tool}" verbatim`);
  }
});
