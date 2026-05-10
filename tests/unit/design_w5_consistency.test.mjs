/**
 * DESIGN-W5 C5 — JSX-faithful consistency unit tests.
 *
 * Asserts the architect-ratified 14 decisions from audits/DESIGN-W5-mapping.md:
 *   - Q-A1: #core-capabilities anchor retargeted to JSX H2 "3 tools, one verdict."
 *   - Q-A2: #when-to-use anchor retargeted to JSX H2 "Brain + execution pairing."
 *   - Q-A3: #vs-raw-exchange-apis anchor DROPPED (CI canary literal-string check)
 *   - Q-D1: 4-tier pricing preserved (Free/Starter/Pro/Enterprise; NO X402 5th card)
 *   - Q-D2: /verify subhead adopted from JSX (shorter Claude Design intent)
 *   - Q-D3..Q-D9: 7 H2 texts adopted from JSX verbatim
 *   - Q-D10: pragmatic — no NEW inline style= (W4 baseline 6 preserved)
 *   - Q-F1: hero 3-stat row (venues / timeframes / signals) — p50 latency REMOVED
 *
 * Plus regression-free preservation of D1-C+D2-C+W3+W4 deliverables.
 *
 * Run via:   node --test tests/unit/design_w5_consistency.test.mjs
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

test('Q-A1+Q-A2: GEO-W1 anchors retargeted to JSX-translated H2s', async () => {
  const html = await read('landing/index.html');
  // Q-A1: #core-capabilities now lives on the JSX H2 "3 tools, one verdict."
  assert.match(html, /<h2[^>]*id="core-capabilities"[^>]*>3 tools, one verdict\.<\/h2>/,
    'core-capabilities anchor on JSX-translated H2');
  // Q-A2: #when-to-use now lives on JSX H2 "Brain + execution pairing."
  assert.match(html, /<h2[^>]*id="when-to-use"[^>]*>Brain \+ execution pairing\.<\/h2>/,
    'when-to-use anchor on JSX-translated H2');
});

test('Q-A3: vs-raw-exchange-apis anchor DROPPED across all landing/*.html', async () => {
  // CI canary per architect: grep -c '#vs-raw-exchange-apis' landing/*.html = 0
  const files = ['landing/index.html', 'landing/faq.html', 'landing/glossary.html',
                 'landing/docs.html', 'landing/skills.html', 'landing/integrations.html',
                 'landing/verify.html', 'landing/privacy.html'];
  for (const f of files) {
    const c = await read(f);
    assert.doesNotMatch(c, /#vs-raw-exchange-apis/, `${f}: no #vs-raw-exchange-apis literal anchor reference`);
    assert.doesNotMatch(c, /id="vs-raw-exchange-apis"/, `${f}: no id="vs-raw-exchange-apis" attribute`);
  }
});

test('Q-D3..Q-D9: 7 H2 texts adopted from JSX verbatim', async () => {
  const html = await read('landing/index.html');
  // 7 H2 texts — at least one occurrence of each (some may appear in JSON-LD / description / OG meta too)
  const jsxHeadings = [
    'Try it in 30 seconds.',                       // Q-D3
    '3 tools, one verdict.',                       // Q-D4
    'Brain + execution pairing.',                  // Q-D5
    'Every qualifying call, on the record.',       // Q-D6
    'Simple pricing.',                             // Q-D7
    'Two transports. Same tools.',                 // Q-D8
    'Frequently asked.',                           // Q-D9
  ];
  for (const heading of jsxHeadings) {
    assert.ok(html.includes(heading), `JSX H2 "${heading}" present (architect Q-D3..Q-D9 OVERRIDE → ADOPT JSX)`);
  }
});

test('Q-D1: 4-tier pricing preserved (NO X402 5th card)', async () => {
  const html = await read('landing/index.html');
  // 4 tier names from spec preservation rule 4 + D1-C ratification
  for (const tier of ['Free', 'Starter', 'Pro', 'Enterprise']) {
    assert.ok(html.includes(tier), `tier "${tier}" preserved`);
  }
  // X402 5th card NOT promoted with JSX UPPERCASE label (architect-ratified Q-D1 = A;
  // X402 stays as pre-existing per-call payment rail callout — Title Case "x402 Per Call",
  // NOT JSX UPPERCASE "X402 PER CALL"). Test is case-SENSITIVE so existing
  // `x402 Per Call` callout doesn't false-positive.
  assert.doesNotMatch(html, /X402 PER CALL/, 'no JSX UPPERCASE X402 PER CALL pricing card (Q-D1 architect-ratified A)');
});

test('Q-F1: hero 3-stat row (venues/timeframes/signals); p50 latency REMOVED', async () => {
  const html = await read('landing/index.html');
  // 3 stat labels present
  assert.match(html, />Venues</, 'Venues stat present');
  assert.match(html, />Timeframes</, 'Timeframes stat present');
  assert.match(html, />Signals</, 'Signals stat present');
  // 3 data-tr-field bindings (live)
  assert.match(html, /data-tr-field="exchange_count"/, 'venues binds to exchange_count');
  assert.match(html, /data-tr-field="timeframe_count"/, 'timeframes binds to timeframe_count');
  assert.match(html, /data-tr-field="call_count"/, 'signals binds to call_count');
  // p50 latency UI element NOT present (Q-F1 architect-ratified A: REMOVE).
  // Note: test scope is rendered markup only — strips HTML comments first so source-code
  // comments referencing the removal don't false-positive. The 3-stat row's actual <div>
  // tree must not contain any p50/latency/640ms stat label or value.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  // Find the 3-stat row by its grid-cols-3 layout sibling to recent-calls-feed close
  const heroEnd = stripped.indexOf('grid grid-cols-3');
  const heroEndSlice = heroEnd > -1 ? stripped.slice(heroEnd, heroEnd + 1500) : '';
  assert.doesNotMatch(heroEndSlice, /p50|latency|640ms/i, 'no p50/latency UI element in hero 3-stat row markup');
});

test('Q-D2: /verify subhead adopted from JSX (shorter form)', async () => {
  const html = await read('landing/verify.html');
  // JSX subhead literal
  assert.match(html, /Every signal is hashed on Base L2/, 'JSX subhead opening present');
  assert.match(html, /Inspect the contract on Basescan/, 'JSX subhead contract mention present');
  // W4 subhead REMOVED
  assert.doesNotMatch(html, /Daily Merkle batches anchor every signal before its outcome is known/,
    'W4 longer subhead replaced by JSX shorter form');
});

test('Q-D10: pragmatic inline-style baseline preserved (no NEW W5 additions)', async () => {
  const html = await read('landing/index.html');
  // D2-C baseline 6 inline style= attributes (BOT-W2 nav bg + 5 exchange-pill brand colors).
  // W5 spec rule 11 says "no inline style= in OUTPUT" but architect ratified Q-D10=B (pragmatic);
  // existing 54 across 3 surfaces preserved; no NEW additions in W5.
  const inline = (html.match(/style="/g) || []).length;
  assert.ok(inline <= 6, `landing/index.html inline style= count = ${inline} (W4 baseline 6; Q-D10 pragmatic — no W5 increase)`);
});

test('D1-C+D2-C+W3+W4 preservation (regression-free)', async () => {
  const html = await read('landing/index.html');
  // D1-C
  assert.doesNotMatch(html, /\b(bg|text|border)-gold-[0-9]+/, '0 gold-class residual (D1-C)');
  assert.match(html, /mint: \{ 50: 'oklch\(0\.97 0\.03 165\)'/, 'OKLCH mint config preserved (D2-C)');
  // W3 deliverables
  assert.match(html, /class="hero-flow-container"/, 'W3 hero flow preserved');
  assert.match(html, /id="recent-calls-feed"/, 'W3 LAST_CALLS feed preserved');
  assert.match(html, /id="live-call-ticker"/, 'W3 ticker DOM preserved');
  // GEO-W1 H1 + hero opening verbatim
  assert.match(html, /The Brain Layer for AI Trading Agents/, 'H1 verbatim');
  assert.match(html, /One MCP call returns a composite trade verdict/, 'hero opening verbatim');
  // 5 exchange names
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    assert.ok(html.includes(ex), `exchange "${ex}" preserved`);
  }
  // 3 MCP tools
  for (const tool of ['get_trade_call', 'get_market_regime', 'scan_funding_arb']) {
    assert.ok(html.includes(tool), `MCP tool "${tool}" preserved`);
  }
});

test('src/index.ts: dashboard JSX-faithful H2 alignment + W3+W4 deliverables preserved', async () => {
  const ts = await read('src/index.ts');
  // C3 H2 alignment per JSX track-record-2.jsx mapping
  assert.match(ts, /<h2>Performance by Timeframe<\/h2>/, 'TF H2 matches JSX (parenthetical dropped)');
  assert.match(ts, /<h2>Latest Trade Calls<\/h2>/, 'recent-calls H2 matches JSX FeedSection');
  // W3+W4 deliverables preserved
  for (const k of ['tier1', 'tier2', 'tier3', 'tier4']) {
    assert.ok(ts.includes(`id="tier-stat-card-${k}"`), `W3 tier-stat-card-${k} preserved`);
  }
  for (const ex of ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET']) {
    assert.ok(ts.includes(`id="exchange-stat-card-${ex}"`), `W4 exchange-stat-card-${ex} preserved`);
  }
  for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']) {
    assert.ok(ts.includes(`data-tf="${tf}"`), `W4 tf-bar-row data-tf="${tf}" preserved`);
  }
  assert.match(ts, /id="tr-recent-calls-panel"/, 'W4 tr-recent-calls panel preserved');
  assert.match(ts, /setInterval\(fetchTrRecent,\s*2500\)/, 'W4 tr-recent-calls 2.5s polling preserved');
});
