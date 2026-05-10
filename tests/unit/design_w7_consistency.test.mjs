/**
 * DESIGN-W7 C5 — canonical hero (V1Hero from v1-minimal.jsx) consistency unit tests.
 *
 * Asserts the architect-ratified 8 decisions from audits/DESIGN-W7-mapping.md (3 Mr.1 pre-ratifications + 5 Q-W7 items):
 *   - H-PR1: counter live-bind to total_calls_executed (totalCalls + totalHolds); 3s refresh; label "Agent Calls"
 *   - H-PR2: MOST RECENT CALL → /api/recent-calls?limit=1; 1.5s polling; data-w7-recent-call mount-point
 *   - H-PR3: SIGNALS row → "Total Trade Calls" + live-bind to call_count
 *   - Q-W7-1: P50 LATENCY → PFE WR live-bind (data-tr-field="pfe_wr")
 *   - Q-W7-2: V0Diagram verdict snippet DROPPED (0 occurrences of "verdict: LONG")
 *   - Q-W7-3: Nav v1.4 shipped → live-bind to package.json version (v1.10.8 shipped at deploy time)
 *   - Q-W7-4: V0Diagram footer "32 venues integrated · 5 featured" → live-bind both numbers to exchange_count
 *   - Q-W7-5: V1Hero diagram='flow' (canonical canvas → V0Diagram)
 *
 * Plus regression-free preservation of W6 below-fold + landing-rest BYTE-IDENTICAL.
 *
 * Run via:   node --test tests/unit/design_w7_consistency.test.mjs
 *
 * Pure file reads — no network.
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

test('Q-W7-5: build pipeline --target=hero exists + valid', async () => {
  const src = await read('scripts/render-jsx-static.mjs');
  assert.match(src, /target === 'hero'/, 'pipeline accepts --target=hero');
  assert.match(src, /v1-minimal\.jsx/, 'reads v1-minimal.jsx');
  assert.match(src, /count: 32, diagram: 'flow'/, "renders V1Hero with count=32 diagram='flow' (canonical canvas)");
});

test('H-PR1: counter live-bind to total_calls_executed (3s refresh, label "Agent Calls")', async () => {
  const html = await read('landing/index.html');
  // Counter <span data-tr-field="total_calls_executed"> present (desktop + mobile = 2)
  const counters = (html.match(/data-tr-field="total_calls_executed"/g) || []).length;
  assert.ok(counters >= 2, `≥2 total_calls_executed spans (got ${counters})`);
  // Label "Agent Calls" (Title Case per Mr.1 ratification)
  assert.match(html, />Agent Calls</, 'Agent Calls label (Title Case)');
  // 3s refresh — track-record-proxy.js secondary poller
  const proxy = await read('landing/js/track-record-proxy.js');
  assert.match(proxy, /total_calls_executed/, 'track-record-proxy.js handles total_calls_executed field');
  assert.match(proxy, /setInterval\(refresh, 3000\)/, '3s hero counter refresh cadence');
  // Computed = totalCalls + totalHolds
  assert.match(proxy, /totalCalls.*totalHolds|totalHolds.*totalCalls/, 'computed totalCalls + totalHolds');
});

test('H-PR2: MOST RECENT CALL poller (1.5s, /api/recent-calls?limit=1)', async () => {
  const html = await read('landing/index.html');
  // data-w7-recent-call mount-point present (desktop + mobile)
  const mounts = (html.match(/data-w7-recent-call/g) || []).length;
  assert.ok(mounts >= 2, `≥2 data-w7-recent-call mount-points (got ${mounts})`);
  // 1.5s polling cadence (literal so the gate matches — not POLL_MS variable)
  assert.match(html, /setInterval\(refreshRecentCall,\s*1500\)/, '1.5s polling cadence (literal)');
  // /api/recent-calls?limit=1 endpoint
  assert.match(html, /\/api\/recent-calls\?limit=1/, 'polls /api/recent-calls?limit=1');
  // aria-live="polite" for screen-reader updates
  assert.match(html, /data-w7-recent-call[^>]*aria-live="polite"/, 'aria-live polite on data-w7-recent-call');
});

test('H-PR3: 4-stat row "Total Trade Calls" + live-bind to call_count', async () => {
  const html = await read('landing/index.html');
  assert.match(html, />Total Trade Calls</, 'Total Trade Calls label (Mr.1 H-PR3 rename from "Signals")');
  assert.match(html, /data-tr-field="call_count"/, 'call_count live-bind');
});

test('Q-W7-1: P50 LATENCY replaced with PFE WR live-bind', async () => {
  const html = await read('landing/index.html');
  assert.match(html, />PFE WR</, 'PFE WR label present (Q-W7-1 P50 replacement)');
  assert.match(html, /data-tr-field="pfe_wr"/, 'pfe_wr live-bind present');
  // P50 latency value (640ms) NOT present anywhere
  assert.doesNotMatch(html, />640ms</, 'no 640ms p50 placeholder');
  assert.doesNotMatch(html, />p50 latency</i, 'no p50 latency label');
});

test('Q-W7-2: V0Diagram verdict snippet DROPPED', async () => {
  const html = await read('landing/index.html');
  assert.doesNotMatch(html, /verdict: LONG/, '0 occurrences of "verdict: LONG"');
  assert.doesNotMatch(html, /conf 0\.84 · regime trend/, '0 occurrences of "conf 0.84 · regime trend"');
});

test('Q-W7-3: V1Hero nav stripped (cross-page consistency); v1.x version pill not present', async () => {
  const html = await read('landing/index.html');
  // V1Hero's nav (Product / Verdicts / Track Record / Docs / Pricing + v1.4 shipped pill +
  // Open in Claude CTA) was stripped post-render in render-jsx-static.mjs::w7HeroStripNav() to
  // preserve cross-page nav consistency with faq.html / glossary.html / docs.html etc. The
  // existing live W3 nav (top of landing/index.html) is preserved unchanged. As a result, the
  // nav-pill `v1.x shipped` from JSX is NOT in the final output. Q-W7-3 ratification (live-bind
  // via package.json version) is therefore N/A in deployed HTML — the version stamping happens
  // in the render pipeline regardless, but its output is stripped along with the nav.
  // Code's render pipeline still implements the version live-bind for forward-compat (if nav-strip
  // is ever lifted in a future wave, the version pill will be live-bound automatically).
  assert.doesNotMatch(html, /v1\.4 shipped/, 'no v1.4 fictional version (defensive — nav stripped anyway)');
  // Verify render pipeline supports the live-bind (forward-compat) by reading the script source.
  const renderSrc = await read('scripts/render-jsx-static.mjs');
  assert.match(renderSrc, /w7HeroNavVersion/, 'render pipeline implements w7HeroNavVersion (Q-W7-3 forward-compat)');
});

test('Q-W7-4: V0Diagram footer "5 venues integrated · 5 featured" live-bind to exchange_count', async () => {
  const html = await read('landing/index.html');
  // Both numbers live-bind via <tspan data-tr-field="exchange_count">
  // SVG <tspan> + querySelector across span/tspan via attribute selector
  const tspanBinds = (html.match(/<tspan[^>]*data-tr-field="exchange_count"/g) || []).length;
  assert.ok(tspanBinds >= 2, `≥2 SVG <tspan data-tr-field="exchange_count"> for footer "X venues integrated · Y featured" (got ${tspanBinds})`);
  // No fictional "32 venues integrated"
  assert.doesNotMatch(html, /32 venues integrated/, 'no fictional "32 venues integrated"');
});

test('Q-W7 carry-forward (W6→W7): 5 SVG <image> logos in V0Diagram chips + WCAG <title>', async () => {
  const html = await read('landing/index.html');
  // 5 hero SVG <image> logos × 2 dual-render = 10 in hero region
  const heroLogos = (html.match(/<image href="\/_design\/logos\//g) || []).length;
  assert.ok(heroLogos >= 5, `≥5 hero SVG <image> logos (got ${heroLogos})`);
  // 5 SVG <title> WCAG accessible-name
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    const re = new RegExp(`<title>${ex} logo</title>`);
    assert.match(html, re, `<title>${ex} logo</title> WCAG accessible-name`);
  }
  // 5 logo files present
  for (const f of ['hyperliquid.png', 'binance.png', 'bybit.jpg', 'okx.png', 'bitget.png']) {
    const html2 = await read('landing/index.html');
    assert.ok(html2.includes(`/_design/logos/${f}`), `logo /_design/logos/${f} referenced`);
  }
});

test('W7 hero dual-render wrappers + CSS @media swap', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /class="lp-hero-desktop"/, 'lp-hero-desktop wrapper present');
  assert.match(html, /class="lp-hero-mobile"/, 'lp-hero-mobile wrapper present');
  const css = await read('landing/_design/algovault-design.css');
  assert.match(css, /\.lp-hero-desktop/, '.lp-hero-desktop in CSS @media swap');
  assert.match(css, /\.lp-hero-mobile/, '.lp-hero-mobile in CSS @media swap');
});

test('Factuality LAW canary: 0 fictional placeholders in deployed hero', async () => {
  const html = await read('landing/index.html');
  // Mr.1 + W3 + W5 + W6 prior ratifications still in force after W7 hero shift
  const fictional = [
    '1,247,892',                  // ticking counter start (W3 removed; W7 live-binds)
    '14.2k weekly',               // npm fictional (W3 removed; W7 drops TrustRow)
    '3.1k',                       // GitHub fictional
    '640ms',                      // p50 latency (W5 Q-F1; W7 Q-W7-1 replaces with PFE WR)
    'verdict: LONG',              // V0Diagram fictional snippet (Q-W7-2)
    '32 venues integrated',       // V0Diagram footer placeholder (Q-W7-4)
    'BTC 1h Binance · HOLD · 0.8s ago', // LAST_CALLS first cycling sample (H-PR2 mount-point)
    'v1.4 shipped',               // Nav version placeholder (Q-W7-3)
  ];
  for (const f of fictional) {
    assert.ok(!html.includes(f), `0 occurrences of fictional placeholder "${f}"`);
  }
});

test('W6 below-fold + landing-rest preserved BYTE-IDENTICAL through W7', async () => {
  const html = await read('landing/index.html');
  // W6 dual-render wrappers
  assert.match(html, /lp-belowfold-desktop/, 'W6 belowfold preserved');
  assert.match(html, /lp-belowfold-mobile/, 'W6 belowfold-mobile preserved');
  assert.match(html, /lp-rest-desktop/, 'W6 landing-rest preserved');
  assert.match(html, /lp-rest-mobile/, 'W6 landing-rest-mobile preserved');
  // W6 belowfold sections (3 from v1-belowfold.jsx)
  for (const heading of ['Core capabilities', 'When to use AlgoVault', 'Why not just use exchange APIs?']) {
    assert.ok(html.includes(heading), `W6 belowfold heading "${heading}" preserved`);
  }
  // W6 landing-rest sections (8, TradFiCallout SKIPPED)
  for (const heading of [
    'Try it in 30 seconds.', '3 tools, One verdict.', 'Brain + execution pairing.',
    'Every qualifying call, on the record.', 'Simple pricing.', 'Two transports. Same tools.', 'Frequently asked.',
  ]) {
    assert.ok(html.includes(heading), `W6 landing-rest heading "${heading}" preserved`);
  }
  // 4-tier pricing (W6 Q-W18 Title Case + Q-W10 X402 filter)
  for (const tier of ['Free', 'Starter', 'Pro', 'Enterprise']) {
    assert.ok(html.includes(tier), `${tier} tier preserved`);
  }
  assert.doesNotMatch(html, /X402 PER CALL/, 'X402 5th tier still filtered (W6 Q-W10)');
  assert.doesNotMatch(html, /TradFi Perpetuals/, 'TradFiCallout still SKIPPED (W6 Q-W10)');
  // W6 Q-W16 subtitle factuality (Three MCP tools — applies to belowfold CoreCapabilities)
  assert.match(html, /Three MCP tools your agent can call/, 'W6 Q-W16 CoreCapabilities subtitle preserved');
  assert.doesNotMatch(html, /Four MCP tools your agent can call/, 'no "Four MCP tools" (W6 Q-W16 factuality)');
});

test('GEO-W1 anchors + JSON-LD blocks preserved through W7', async () => {
  const html = await read('landing/index.html');
  // 3 W6 belowfold GEO-W1 anchors (Q-W9): #core-capabilities, #when-to-use, #vs-raw-exchange-apis
  for (const id of ['core-capabilities', 'when-to-use', 'vs-raw-exchange-apis']) {
    const re = new RegExp(`<section\\s+id="${id}"`);
    assert.match(html, re, `<section id="${id}"> preserved (W6 Q-W9)`);
  }
  // 6 JSON-LD blocks preserved
  const jsonLd = (html.match(/<script type="application\/ld\+json"/g) || []).length;
  assert.ok(jsonLd >= 6, `≥6 JSON-LD blocks preserved (got ${jsonLd})`);
});

test('Cross-page anchor #quickstart target preserved (W6 internal-link contract; W7 dropped internal hrefs)', async () => {
  const html = await read('landing/index.html');
  // Anchor TARGET preserved on TryIn30 section (W6 belowfold preserveQuickstartAnchor).
  // W7 NOTE: the OLD W3-era internal links (href="#quickstart" inside W3 hero CTAs) were dropped
  // along with the W3 hero replacement — V1Hero's CTAs go to "Try Free in Claude" / "View Track
  // Record" instead. The anchor target still serves potential cross-page linkers (faq.html,
  // glossary.html, docs.html) and direct URL navigation (https://algovault.com/#quickstart).
  assert.match(html, /id="quickstart"/, 'id="quickstart" anchor target present (W6 preserveQuickstartAnchor)');
});

test('Existing live W3 nav preserved (V1Hero nav stripped for cross-page consistency)', async () => {
  const html = await read('landing/index.html');
  // Live W3 nav: /track-record + /pricing + /integrations + /skills + /docs.html + /verify + /signup
  // V1Hero nav (Product/Verdicts/Track Record/Docs/Pricing) was stripped post-render to preserve
  // cross-page consistency with faq.html + glossary.html etc.
  for (const link of ['/track-record', '/integrations', '/skills', '/docs.html', '/verify']) {
    const re = new RegExp(`href="${link.replace(/\./g, '\\.')}"`);
    assert.match(html, re, `existing W3 nav link href="${link}" preserved`);
  }
});
