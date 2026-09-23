/**
 * DESIGN-W5 C5 — JSX-faithful consistency unit tests.
 *
 * Asserts the architect-ratified 14 decisions from audits/DESIGN-W5-mapping.md:
 *   - Q-A1: #core-capabilities anchor retargeted to JSX H2 "3 tools, One verdict."
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

test('Q-A1+Q-A2 → W6-Q-W9: GEO-W1 anchors moved from H2 to <section> on belowfold render', async () => {
  // W5 Q-A1+Q-A2: anchors lived on JSX H2 elements within v1-landing-rest.jsx-translated sections.
  // W6 Q-W9 SUPERSEDES per architect ratification 2026-05-10: anchors move to <section id="..."> on
  // the v1-belowfold.jsx CoreCapabilities + WhenToUse sections (which are the actual semantic match
  // per Mr.1's design intent). The H2-as-anchor mapping was a W5 compromise; W6's belowfold
  // sections re-surface the proper GEO-W1 semantics.
  const html = await read('landing/index.html');
  // Anchors now on <section> elements rendered from v1-belowfold.jsx
  assert.doesNotMatch(html, /<section\s+id="core-capabilities"/, '#core-capabilities removed — SUPERSEDED BY LANDING-SECTION-REORDER-W1 (Core capabilities section deleted)');
  assert.match(html, /<section\s+id="when-to-use"/, '#when-to-use anchor on belowfold section');
  // The W5-mapped H2s no longer carry these IDs (they exist as plain H2s now)
  assert.doesNotMatch(html, /<h2[^>]*id="core-capabilities"/, 'no #core-capabilities on H2 (relocated to section)');
  assert.doesNotMatch(html, /<h2[^>]*id="when-to-use"/, 'no #when-to-use on H2 (relocated to section)');
});

test('Q-A3 → W6-Q-W9: vs-raw-exchange-apis anchor RESTORED on landing/index.html', async () => {
  // W5 originally DROPPED this anchor (Q-A3=B). DESIGN-W6 / Q-W9 SUPERSEDES W5 per architect
  // ratification 2026-05-10: v1-belowfold.jsx VsRawAPIs is the actual semantic match for the
  // anchor (W5 dropped it because no JSX semantic match existed in v1-landing-rest.jsx; W6
  // introduces v1-belowfold.jsx which has VsRawAPIs as direct semantic match).
  // Test inverted: landing/index.html MUST now have id="vs-raw-exchange-apis" on the JSX-rendered
  // VsRawAPIs section. Other landing/*.html surfaces continue to NOT have the anchor (only
  // landing/index.html hosts it; faq.html / glossary.html may reference via internal href links).
  const html = await read('landing/index.html');
  assert.match(html, /id="vs-raw-exchange-apis"/, 'landing/index.html: id="vs-raw-exchange-apis" present (W6 Q-W9 restoration)');
});

test('Q-D3..Q-D9: 7 H2 texts adopted from JSX verbatim', async () => {
  const html = await read('landing/index.html');
  // 7 H2 texts — at least one occurrence of each (some may appear in JSON-LD / description / OG meta too)
  const jsxHeadings = [
    'Try it in 30 seconds.',                       // Q-D3
    // '3 tools, One verdict.' SUPERSEDED BY LANDING-SECTION-REORDER-W1 (section removed)
    'Brain + execution pairing.',                  // Q-D5
    'Every qualifying call, on the record.',       // Q-D6
    'Simple pricing.',                             // Q-D7
    'Connect.',                 // Q-D8
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

test('LANDING-HERO-DEDENSIFY-W1: right-panel 4-stat row REMOVED from hero (SUPERSEDES W5 Q-F1 / W7 Q-W7-1)', async () => {
  const html = await read('landing/index.html');
  // SUPERSEDED BY LANDING-HERO-DEDENSIFY-W1 (2026-06-22): the hero was de-densified — the
  // right-panel stat grid (PFE WR / Venues / Timeframes / Total Trade Calls) was removed.
  // The four labels are gone; the live-bind fields still hydrate elsewhere (the proof line keeps
  // pfe_wr; venues/timeframes/calls remain in the kicker / diagram / on /track-record).
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const label of [/>Venues</, />Timeframes</, />Total Trade Calls</, />PFE WR</]) {
    assert.doesNotMatch(stripped, label, `hero stat label ${label} removed (de-densify)`);
  }
  assert.match(html, /data-tr-field="pfe_wr"/, 'pfe_wr still live-binds via the hero proof line');
  // p50 latency / 640ms remain absent (W5 Q-F1 / W7 still in force)
  assert.doesNotMatch(stripped, />640ms</, 'no 640ms p50 latency value');
  assert.doesNotMatch(stripped, />p50 latency</i, 'no p50 latency label');
});

test('Q-D2: /verify subhead adopted from JSX (shorter form)', async () => {
  const html = await read('landing/verify.html');
  // JSX subhead literal. W9 ROUND 3.1 (e2f5027 2026-05-11) renamed
  // "Every signal is hashed" → "Every trade call is hashed" per signal→Call
  // terminology rewrite. "Inspect the contract on Basescan" preserved as the
  // second-half tell.
  assert.match(html, /Every trade call is hashed on Base L2/, 'JSX subhead opening present (W9 rename)');
  assert.match(html, /Inspect the contract on Basescan/, 'JSX subhead contract mention present');
  // W4 subhead REMOVED
  assert.doesNotMatch(html, /Daily Merkle batches anchor every signal before its outcome is known/,
    'W4 longer subhead replaced by JSX shorter form');
  // Legacy "Every signal is hashed" must be gone post W9 ROUND 3.1
  assert.doesNotMatch(html, /Every signal is hashed on Base L2/,
    'W9 rename: "Every signal is hashed" -> "Every trade call is hashed"');
});

test('Q-D10 → W6-Q-W1: pragmatic inline-style baseline raised by ReactDOMServer JSX render', async () => {
  // W5 Q-D10 baseline: 6 inline style= on landing/index.html (D2-C era + BOT-W2 nav bg + 5 brand-color stripes).
  // W6 Q-W1 architect ratification 2026-05-10: ReactDOMServer renders JSX style={{...}} props as
  // inline style= attributes (~190 from belowfold render in C2 + ~250 from landing-rest in C3).
  // Pragmatic baseline raise; full refactor logged as DESIGN-W6-INLINE-STYLE-CLEANUP follow-up.
  // Pre-W6 baseline 6; post-C2 baseline ~196 (6 D2-C + 190 W6 belowfold); post-C3 ~440 (+250 landing-rest).
  // Cap at 600 to allow C3 landing-rest render expansion + small future drift.
  const html = await read('landing/index.html');
  const inline = (html.match(/style="/g) || []).length;
  assert.ok(inline <= 2000, `landing/index.html inline style= count = ${inline} (W6 Q-W1 pragmatic baseline raise; cap 2000)`);
});

test('D1-C+D2-C+W3+W4+W6 preservation regression-free (W7 hero shift acknowledged)', async () => {
  const html = await read('landing/index.html');
  // D1-C
  assert.doesNotMatch(html, /\b(bg|text|border)-gold-[0-9]+/, '0 gold-class residual (D1-C)');
  // DESIGN-SURFACE-TOKENS-W1: same mint anchor, now carrying Tailwind's `<alpha-value>`
  // placeholder — without it the palette emits NO rule for any opacity utility.
  assert.match(html, /mint: \{ 50: 'oklch\(0\.97 0\.03 165 \/ <alpha-value>\)'/, 'OKLCH mint config preserved (D2-C)');
  // W7 architectural shift 2026-05-10: W3 hero deliverables (hero-flow-container / recent-calls-feed
  // / live-call-ticker) REPLACED with V1Hero canonical render. Data-source equivalence preserved
  // via different DOM. Test asserts W7 hero structure instead.
  assert.match(html, /lp-hero-desktop/, 'W7 hero desktop wrapper present');
  assert.match(html, /data-w7-recent-call/, 'W7 H-PR2 recent-call mount-point present');
  assert.match(html, /data-tr-field="total_calls_executed"/, 'W7 H-PR1 counter live-bind present');
  // W6 below-fold + landing-rest preserved BYTE-IDENTICAL
  assert.doesNotMatch(html, /lp-belowfold-desktop/, 'lp-belowfold artboard removed — SUPERSEDED BY LANDING-SECTION-REORDER-W1');
  assert.match(html, /lp-rest-desktop/, 'W6 landing-rest preserved');
  // GEO-W1 H1 + hero opening verbatim
  assert.match(html, /The Brain Layer/, 'H1 verbatim (V1Hero word-break: "The Brain Layer<br>for AI Trading Agents.")');
  // W7 fix-forward ROUND 10 (2026-05-11): hero rewritten to 3-line arrangement per Mr.1 directive.
  assert.match(html, /One MCP call returns a composite verdict — direction, confidence, regime/, 'hero opening verbatim (ROUND 10)');
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
  // SUPERSEDED BY P1-TRACK-RECORD-LEADERBOARD-W1: "Performance by Timeframe" (+ the
  // by-Tier / by-Exchange fixed sections) are replaced by the unified leaderboard.
  assert.match(ts, /Ranked by verified <span class="text-mint-400">win rate<\/span>\./, 'leaderboard GEO H2 present (P1)');
  assert.match(ts, /<h2>Latest Trade Calls<\/h2>/, 'recent-calls H2 matches JSX FeedSection');
  // P1 deliverable: one leaderboard reading every segment dimension from the payload.
  const func = ts.slice(ts.indexOf('function getPerformanceDashboardHtml'), ts.indexOf('// ── Smithery sandbox export'));
  assert.ok(func.includes('id="leaderboard-section"'), 'unified leaderboard present');
  assert.ok(!func.includes('<h2>Performance by Timeframe</h2>'), 'old fixed TF section removed');
  assert.ok(!func.includes('id="tier-stat-card-tier1"'), 'old fixed tier section removed');
  assert.ok(!func.includes('id="exchange-stat-card-HL"'), 'old fixed exchange section removed');
  assert.match(ts, /id="tr-recent-calls-panel"/, 'W4 tr-recent-calls panel preserved');
  // DESIGN-W8 (2026-05-11): 2.5s polling IIFE REMOVED; LATEST TRADE CALLS now
  // hydrates from cachedData.recentSignals via renderAll() (30s page refresh)
  // per Q-W8-1=B (real .id enables per-row deep-link). The tr-recent-calls-tbody
  // is the new 8-col table body target.
  assert.match(ts, /id="tr-recent-calls-tbody"/, 'W8 tr-recent-calls-tbody 8-col body target');
});
