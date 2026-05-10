/**
 * DESIGN-W4 C5 — Tier B consistency unit tests.
 *
 * Asserts that:
 *   - landing/_design/algovault-design.css contains the W4 extensions
 *     (try-3step-card, tool-card, use-case-card, tamper-proof-callout,
 *     dev-code-block, footer-w4, exchange-stat-grid, tf-bar-chart,
 *     tr-recent-calls-panel, verify-input-panel, verify-result-panel,
 *     howit-grid, verify-faq-list, recent-verifications-empty) +
 *     D2-C + W3 classes preserved BYTE-IDENTICAL.
 *   - landing/index.html below-fold polish applied (try-3step-card ×3,
 *     tamper-proof-callout, footer-w4) + W3 deliverables preserved
 *     (hero-flow-container, recent-calls-feed, ticker DOM).
 *   - src/index.ts getPerformanceDashboardHtml has W4 sections
 *     (exchange-stat-card ×5, tf-bar-row ×11, tr-recent-calls-panel) +
 *     W3 tier-stat-card preserved + 4 data-tier-color attrs +
 *     fetchTrRecent polling at 2500ms.
 *   - landing/verify.html rebuilt with W4 H1 + verify-input-panel +
 *     verify-result-panel + howit-grid (4 steps) + verify-faq-list +
 *     recent-verifications-empty placeholder + form behavior preserved
 *     (verifySignal + #verify-btn + #signal-id).
 *   - 4-tier pricing preserved (Free/Starter/Pro/Enterprise — no X402).
 *   - 0 residual gold across all 3 affected files.
 *
 * Run via:   node --test tests/unit/design_w4_consistency.test.mjs
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

test('algovault-design.css: D2-C + W3 + W4 layers all present', async () => {
  const css = await read('landing/_design/algovault-design.css');

  // D2-C foundation
  for (const cls of ['.artboard', '.bg-grid', '.bg-radial-violet', '.bg-radial-accent', '.bg-noise', '.live-pulse']) {
    assert.match(css, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `D2-C class ${cls} preserved`);
  }
  // W3 foundation
  for (const cls of ['.hero-flow-container', '.recent-calls-feed', '.tier-stat-card']) {
    assert.match(css, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `W3 class ${cls} preserved`);
  }
  // W4 below-fold extensions
  for (const cls of ['.try-3step-card', '.tool-card', '.use-case-card', '.tamper-proof-callout', '.dev-code-block', '.footer-w4']) {
    assert.match(css, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `W4 below-fold class ${cls}`);
  }
  // W4 Track Record extensions
  for (const cls of ['.exchange-stat-grid', '.exchange-stat-card', '.tf-bar-chart', '.tf-bar-row', '.tf-bar-fill', '.tr-recent-calls-panel']) {
    assert.match(css, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `W4 Track Record class ${cls}`);
  }
  // W4 Verify extensions
  for (const cls of ['.verify-input-panel', '.verify-input-field', '.verify-input-button', '.verify-result-panel', '.verify-result-row', '.howit-grid', '.howit-step', '.howit-step-number', '.verify-faq-list', '.recent-verifications-empty']) {
    assert.match(css, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `W4 Verify class ${cls}`);
  }
});

test('landing/index.html: W3 deliverables preserved + W4 below-fold polish', async () => {
  const html = await read('landing/index.html');
  // W3 preservation
  assert.match(html, /class="hero-flow-container"/, 'W3 hero-flow-container preserved');
  assert.match(html, /id="recent-calls-feed"/, 'W3 LAST_CALLS feed preserved');
  assert.match(html, /id="live-call-ticker"/, 'live-call-ticker DOM preserved');
  assert.match(html, /class="[^"]*artboard/, 'D2-C artboard preserved');
  // W4 below-fold polish (additive)
  const try3 = (html.match(/try-3step-card/g) || []).length;
  assert.ok(try3 >= 3, `try-3step-card on 3 quickstart steps (got ${try3})`);
  assert.match(html, /tamper-proof-callout/, 'tamper-proof-callout class applied');
  assert.match(html, /footer-w4/, 'footer-w4 class applied');
  // 4-tier preserved
  assert.ok(html.includes('Starter') && html.includes('Pro') && html.includes('Enterprise'), '4-tier names preserved');
  // 0 residual gold
  assert.doesNotMatch(html, /\b(bg|text|border)-gold-[0-9]+/, '0 gold-class residual');
});

test('landing/index.html: hero opening + H1 + 5 exchanges + MCP tools verbatim', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /One MCP call returns a composite trade verdict/, 'hero opening verbatim');
  assert.match(html, /The Brain Layer for AI Trading Agents/, 'H1 verbatim');
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    assert.ok(html.includes(ex), `exchange "${ex}" verbatim`);
  }
  for (const tool of ['get_trade_call', 'get_market_regime', 'scan_funding_arb']) {
    assert.ok(html.includes(tool), `MCP tool "${tool}" verbatim`);
  }
});

test('landing/index.html: D2-C inline-style baseline preserved (no W4 NEW additions)', async () => {
  const html = await read('landing/index.html');
  const inline = (html.match(/style="/g) || []).length;
  // D2-C baseline 6 (BOT-W2 nav bg + 5 exchange-pill brand colors). W4 must not increase.
  assert.ok(inline <= 6, `inline style= count = ${inline} (D2-C baseline 6 — must not increase)`);
});

test('src/index.ts: getPerformanceDashboardHtml W3 + W4 layers both present', async () => {
  const ts = await read('src/index.ts');
  // W3 tier-stat preservation
  for (const k of ['tier1', 'tier2', 'tier3', 'tier4']) {
    assert.ok(ts.includes(`id="tier-stat-card-${k}"`), `W3 tier-stat-card-${k} preserved`);
  }
  // W4 exchange-stat (5 cards)
  for (const ex of ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET']) {
    assert.ok(ts.includes(`id="exchange-stat-card-${ex}"`), `W4 exchange-stat-card-${ex}`);
  }
  // W4 tf-bar 11 rows (1m..1d)
  for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']) {
    assert.ok(ts.includes(`data-tf="${tf}"`), `W4 tf-bar-row data-tf="${tf}"`);
  }
  // W4 tr-recent-calls panel + polling
  assert.match(ts, /id="tr-recent-calls-panel"/, 'tr-recent-calls-panel container');
  assert.match(ts, /id="tr-recent-calls-rows"/, 'tr-recent-calls-rows hydration target');
  assert.match(ts, /function fetchTrRecent/, 'fetchTrRecent function');
  assert.match(ts, /setInterval\(fetchTrRecent,\s*2500\)/, 'tr-recent-calls polling cadence 2500ms');
  // byExchange + byTimeframe hydration
  assert.match(ts, /d\.byExchange/, 'byExchange hydration reference');
  assert.match(ts, /d\.byTimeframe/, 'byTimeframe hydration reference');
  assert.match(ts, /setProperty\('--exchange-color'/, 'exchange color via setProperty (no inline style=)');
});

test('landing/verify.html: W4 rebuild — H1 + panels + howit + form preserved', async () => {
  const html = await read('landing/verify.html');
  // W4 H1 (different from old "Verify Call Integrity")
  assert.match(html, /<h1[^>]*>Verify Any AlgoVault Trade Call<\/h1>/, 'W4 H1 verbatim');
  // W4 panels
  assert.match(html, /class="verify-input-panel"/, 'verify-input-panel applied');
  assert.match(html, /verify-result-panel/, 'verify-result-panel applied');
  // W4 howit-grid (4 steps)
  assert.match(html, /class="howit-grid"/, 'howit-grid container');
  const howitSteps = (html.match(/class="howit-step"/g) || []).length;
  assert.ok(howitSteps >= 4, `>=4 howit-step elements (got ${howitSteps})`);
  // W4 verify-faq-list
  assert.match(html, /class="verify-faq-list"/, 'verify-faq-list container');
  const verifyFaqs = (html.match(/class="verify-faq-item"/g) || []).length;
  assert.ok(verifyFaqs >= 3, `>=3 verify-faq-item (got ${verifyFaqs})`);
  // W4 recent-verifications-empty placeholder
  assert.match(html, /recent-verifications-empty/, 'recent-verifications-empty placeholder (VERIFY-RECENT-FEED-W1 deferral)');
  // PRESERVE existing form behavior
  assert.match(html, /id="signal-id"/, '#signal-id input preserved');
  assert.match(html, /id="verify-btn"/, '#verify-btn button preserved');
  assert.match(html, /verifySignal\(\)/, 'verifySignal() function preserved');
  // PRESERVE algovault-design.css link
  assert.match(html, /algovault-design\.css/, 'D2-C canonical loader preserved');
  // 0 residual gold
  assert.doesNotMatch(html, /\b(bg|text|border)-gold-[0-9]+/, '0 gold-class residual');
});

test('all 3 W4 surfaces: 0 residual gold-Tailwind-classes + 0 hardcoded fictional metrics', async () => {
  const idx = await read('landing/index.html');
  const ts = await read('src/index.ts');
  const verify = await read('landing/verify.html');

  for (const [name, c] of [['index', idx], ['src/index.ts', ts], ['verify', verify]]) {
    assert.doesNotMatch(c, /\b(bg|text|border)-gold-[0-9]+/, `0 gold-class in ${name}`);
  }
  // Hardcoded fictional metrics from JSX (architect mapping = REMOVED) — must NOT appear in production HTML
  // 1247892 (useTickingCounter), 14.2k (npm), 3.1k (GitHub stars) — NOT in landing/index.html
  assert.doesNotMatch(idx, /1247892|14\.2k weekly|3\.1k GitHub/, 'fictional W3-mapped metrics absent from index.html');
});
