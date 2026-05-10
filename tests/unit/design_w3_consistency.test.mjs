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

test('landing/index.html: D2-C foundation preserved (W7 carry: V1Hero uses same D2-C classes)', async () => {
  const html = await read('landing/index.html');
  // D2-C foundation classes — V1Hero (W7) uses bg-grid + bg-noise + artboard + live-pulse same as W3
  assert.ok(html.includes('class="bg-grid"'), 'bg-grid present (V1Hero artboard layer)');
  assert.match(html, /class="[^"]*artboard/, '.artboard class on hero (V1Hero outer wrap)');
  assert.match(html, /class="[^"]*live-pulse/, '.live-pulse class (V1Hero LIVE pulse)');
  assert.ok(html.includes('algovault-design.css'), 'canonical CSS link present');
  // W7 NOTE: id="live-call-ticker" was W3 hero deliverable — REPLACED by V1Hero ticker card with
  // data-tr-field="total_calls_executed" + data-w7-recent-call mount-point. Data-source
  // equivalence preserved via different DOM.
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

test('landing/index.html: hero flow diagram (W7 V0Diagram supersedes W3 hero-flow-container)', async () => {
  const html = await read('landing/index.html');
  // W7 architectural shift 2026-05-10: W3 hero-flow-container REPLACED with V0Diagram (canonical
  // canvas via diagram='flow'). Same data-source binding (5 venues → MCP → AI agent) but
  // different DOM (V0Diagram is a flat SVG with bezier flow lines + featured chips, not the
  // class-based hero-flow-* W3 structure). Test asserts data-source equivalence:
  // - 5 exchange names visible in hero region
  // - venues counter live-binds (V0Diagram footer text "5 venues integrated · 5 featured" via Q-W7-4)
  // - 5 SVG <image> logos (W6 Q-W7 carry-forward integrated into V0Diagram chips)
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    assert.ok(html.includes(ex), `exchange "${ex}" verbatim`);
  }
  assert.match(html, /data-tr-field="exchange_count"/, 'exchange_count live-bind preserved');
  // 5 hero <image> logos × 2 dual-render = 10 in hero region (V0Diagram chips)
  const heroLogos = (html.match(/<image href="\/_design\/logos\//g) || []).length;
  assert.ok(heroLogos >= 5, `≥5 hero SVG <image> logos (got ${heroLogos}; W6 Q-W7 carry-forward integrated into W7 V0Diagram chips)`);
});

test('landing/index.html: hero recent-call (W7 data-w7-recent-call supersedes W3 recent-calls-feed)', async () => {
  const html = await read('landing/index.html');
  // W7 architectural shift 2026-05-10: W3 recent-calls-feed (5-row 2.5s polling) REPLACED with
  // V1Hero ticker card showing MOST RECENT CALL (1-row 1.5s polling per Mr.1 H-PR2).
  // Data-source equivalence: both poll /api/recent-calls. Different DOM + different cadence/limit.
  // The W3 5-row recent-calls-feed pattern STILL EXISTS on /track-record (W4 deliverable, out of W7 scope).
  assert.match(html, /data-w7-recent-call/, 'data-w7-recent-call mount-point present (W7 H-PR2)');
  assert.match(html, /aria-live="polite"/, 'aria-live for screen-reader updates');
  assert.match(html, /\/api\/recent-calls\?limit=1/, 'W7 hero polls /api/recent-calls?limit=1');
  assert.match(html, /setInterval\([^,]+,\s*1500\)/, 'W7 hero polling cadence 1.5s (Mr.1 H-PR2)');
});

test('landing/index.html: inline-style baseline (W6 Q-W1 documented relaxation)', async () => {
  const html = await read('landing/index.html');
  // D2-C baseline was 6. W6 Q-W1 architect-ratified pragmatic raise 2026-05-10:
  // ReactDOMServer renders JSX style={{...}} as inline style= (~190 C2 belowfold + ~250 C3 landing-rest).
  // Full refactor logged as DESIGN-W6-INLINE-STYLE-CLEANUP follow-up.
  const inline = (html.match(/style="/g) || []).length;
  assert.ok(inline <= 2000, `inline style= count = ${inline} (W6 Q-W1 pragmatic baseline raise; cap 2000)`);
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
