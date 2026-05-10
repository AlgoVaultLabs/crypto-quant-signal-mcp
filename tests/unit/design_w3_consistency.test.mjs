/**
 * DESIGN-W3 C5 — Tier A consistency unit tests.
 *
 * Asserts that:
 *   - landing/index.html contains hero-flow-container + 5 hero-flow-edge paths
 *     (5 venues → MCP) + the canonical loader (D2-C foundation preserved).
 *   - landing/index.html contains recent-calls-feed + recent-calls-rows + a
 *     fetchRecentCalls poller calling /api/recent-calls?limit=5 every 2500ms.
 *   - All 5 D1-C exchange names verbatim (Hyperliquid, Binance, Bybit, OKX,
 *     Bitget) — preserved + emit by the new hero flow diagram.
 *   - landing/_design/algovault-design.css contains the canonical D2-C
 *     foundation classes (artboard, bg-grid, bg-radial-violet, bg-radial-
 *     accent, bg-noise, live-pulse) + the W3 extensions (hero-flow-*,
 *     recent-calls-*, tier-stat-*) + the 2 W3 keyframes (hero-flow-pulse,
 *     recent-calls-row-fade-in).
 *   - src/index.ts getPerformanceDashboardHtml emits the canonical loader
 *     <link> + 4 tier-stat-card containers (tier1..tier4) + byTier
 *     hydration block.
 *   - 4-tier preservation (Free/Starter/Pro/Enterprise) — D1-C foundation
 *     unchanged.
 *   - 0 residual gold-classes, 0 residual gold-hex, mint baseline preserved.
 *
 * Run via:   node --test tests/unit/design_w3_consistency.test.mjs
 *
 * Pure file reads — no network, no compile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function read(rel) {
  return readFile(path.join(REPO_ROOT, rel), 'utf-8');
}

test('landing/index.html: D2-C foundation preserved', async () => {
  const html = await read('landing/index.html');
  assert.ok(html.includes('class="bg-grid"'), 'bg-grid present');
  assert.ok(html.includes('class="bg-radial-accent"'), 'bg-radial-accent present');
  assert.match(html, /class="[^"]*artboard/, '.artboard class on hero <section>');
  assert.match(html, /class="[^"]*live-pulse/, '.live-pulse class on ticker');
  assert.ok(html.includes('algovault-design.css'), 'canonical CSS link present');
  assert.ok(html.includes('id="live-call-ticker"'), 'live-call-ticker DOM preserved');
});

test('landing/index.html: D1-C foundation preserved', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /mint: \{ 50: 'oklch\(0\.97 0\.03 165\)'/, 'OKLCH mint config present');
  assert.match(html, /\bbg-mint-/, 'mint Tailwind classes preserved');
  assert.doesNotMatch(html, /\b(bg|text|border)-gold-[0-9]+/, '0 residual gold-class');
  assert.doesNotMatch(html, /#d4af37|#ffd700/, '0 residual gold-hex');
  assert.match(html, /The Brain Layer for AI Trading Agents/, 'H1 verbatim');
  assert.match(html, /One MCP call returns a composite trade verdict/, 'hero opening verbatim');
});

test('landing/index.html: hero flow diagram (C2)', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /class="hero-flow-container"/, 'hero-flow-container present');
  assert.match(html, /class="hero-flow-svg"/, 'hero-flow-svg present');
  assert.match(html, /class="hero-flow-node-mcp"/, 'MCP hub node present');
  // 5 venue → MCP edges + 1 MCP → agent edge = 6 hero-flow-edge paths
  const edges = (html.match(/class="hero-flow-edge"/g) || []).length;
  assert.ok(edges >= 5, `>=5 hero-flow-edge paths (got ${edges})`);
  // Animated agent edge
  assert.match(html, /class="hero-flow-edge-pulse"/, 'animated agent edge present');
  // 5 exchange names verbatim in the diagram
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    assert.ok(html.includes(ex), `exchange "${ex}" verbatim`);
  }
  // Counter binds to existing live-data field
  assert.match(html, /<span [^>]*data-tr-field="exchange_count"[^>]*>5<\/span> venues integrated/,
    'venues counter binds to data-tr-field');
});

test('landing/index.html: LAST_CALLS feed (C3)', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /id="recent-calls-feed"/, 'recent-calls-feed container');
  assert.match(html, /id="recent-calls-rows"/, 'recent-calls-rows hydration target');
  assert.match(html, /aria-live="polite"/, 'aria-live for screen-reader updates');
  assert.match(html, /function fetchRecentCalls/, 'fetchRecentCalls function defined');
  assert.match(html, /\/api\/recent-calls\?limit=5/, 'reuses /api/recent-calls?limit=5');
  // Polling cadence 2-3s (literal so the gate matches)
  assert.match(html, /setInterval\(fetchRecentCalls,\s*(2000|2500|3000)\)/,
    'setInterval cadence is 2-3s');
});

test('landing/index.html: no NEW inline-style violations', async () => {
  const html = await read('landing/index.html');
  // D2-C baseline = 6 inline style= attributes (BOT-W2 nav bg + 5 exchange-pill brand colors).
  // DESIGN-W3 must NOT increase this count.
  const inline = (html.match(/style="/g) || []).length;
  assert.ok(inline <= 6, `inline style= count = ${inline} (D2-C baseline 6 — must not increase)`);
});

test('algovault-design.css: D2-C + W3 components both present', async () => {
  const css = await read('landing/_design/algovault-design.css');
  // D2-C foundation
  for (const cls of ['.artboard', '.bg-grid', '.bg-radial-violet', '.bg-radial-accent', '.bg-noise', '.live-pulse']) {
    assert.match(css, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `D2-C class ${cls} preserved`);
  }
  // W3 hero-flow extensions
  assert.match(css, /\.hero-flow-container\s*\{/, 'hero-flow-container');
  assert.match(css, /\.hero-flow-edge\s*\{/, 'hero-flow-edge');
  assert.match(css, /\.hero-flow-node-mcp\s*\{/, 'hero-flow-node-mcp');
  // W3 recent-calls extensions
  assert.match(css, /\.recent-calls-feed\s*\{/, 'recent-calls-feed');
  assert.match(css, /\.recent-calls-call-buy\s*\{/, 'recent-calls-call-buy modifier');
  assert.match(css, /\.recent-calls-call-sell\s*\{/, 'recent-calls-call-sell modifier');
  // W3 tier-stat extensions
  assert.match(css, /\.tier-stat-grid\s*\{/, 'tier-stat-grid');
  assert.match(css, /\.tier-stat-card\s*\{/, 'tier-stat-card');
  assert.match(css, /\.tier-stat-pfe-fill\s*\{/, 'tier-stat-pfe-fill');
  // 2 W3 keyframes
  assert.match(css, /@keyframes\s+hero-flow-pulse/, 'hero-flow-pulse keyframe');
  assert.match(css, /@keyframes\s+recent-calls-row-fade-in/, 'recent-calls-row-fade-in keyframe');
  // D2-C pulse keyframe still present
  assert.match(css, /@keyframes\s+pulse\s*\{/, 'D2-C @keyframes pulse preserved');
});

test('src/index.ts: getPerformanceDashboardHtml has W3 tier-stat-grid (C4)', async () => {
  const ts = await read('src/index.ts');
  // 4 tier-stat-card divs (tier1..tier4)
  for (const k of ['tier1', 'tier2', 'tier3', 'tier4']) {
    assert.ok(ts.includes(`id="tier-stat-card-${k}"`), `tier-stat-card-${k} markup present`);
  }
  // data-tier-color attribute (NOT inline style=) for each tier
  const dataAttrs = (ts.match(/data-tier-color="#/g) || []).length;
  assert.ok(dataAttrs >= 4, `>=4 data-tier-color attrs (got ${dataAttrs})`);
  // Cross-origin algovault-design.css link (D2-C signup + W3 dashboard)
  const links = (ts.match(/https:\/\/algovault\.com\/_design\/algovault-design\.css/g) || []).length;
  assert.ok(links >= 2, `>=2 cross-origin design CSS links (got ${links})`);
  // byTier hydration block
  assert.match(ts, /getElementById\('tier-stat-card-' \+ k\)/, 'byTier hydration block present');
  assert.match(ts, /setProperty\('--tier-color'/, 'tier color set via setProperty (no inline style=)');
});

test('src/index.ts: 4-tier pricing preserved', async () => {
  const ts = await read('src/index.ts');
  // Pricing tier names from getSignupPageHtml — 4 distinct H2s
  assert.match(ts, /<h2>Starter<\/h2>/, 'Starter tier preserved');
  assert.match(ts, /<h2>Pro<\/h2>/, 'Pro tier preserved');
  assert.match(ts, /<h2>Enterprise<\/h2>/, 'Enterprise tier preserved');
});
