/**
 * DESIGN-W8 C5 — Track Record cleanup + Verify Any Call teaser card consistency.
 *
 * Asserts the architect-ratified 5 decisions from audits/DESIGN-W8-mapping.md:
 *   - Q-W8-1: LATEST TRADE CALLS hydrates from cachedData.recentSignals (real .id + .tier,
 *             per-row deep-link to /verify?signalId=<id>); 30s page refresh; canonical
 *             FeedSection no-polling. 8 columns (ID, Time, Tier, Asset, Call, Confidence,
 *             Timeframe, Exchange).
 *   - Q-W8-2: Verify card live-binds — real contract 0x6485...bf81; data-tr-field="merkle_batch_count"
 *             + NEW data-tr-field="latest_batch_at" via /api/merkle-batches.batches[0].published_at;
 *             static "next batch in" placeholder (live countdown deferred to VERIFY-COUNTDOWN-W1).
 *   - Q-W8-3: 2.5s polling IIFE deleted (dead code under Option-B).
 *   - Q-W8-4: renderAll() dead-JS pruned for 5 deleted DOM IDs (#tier-cards, #by-type,
 *             #by-timeframe, #cb-section, #top-assets, #worst-assets, #recent, #tf-tabs).
 *   - Q-W8-5: Verify card heading style — Eyebrow "· VERIFY" + custom inline-styled H2
 *             "Verify Any Call" with mint accent (matches canonical track-record-2.jsx:VerifySection).
 *
 * 8 legacy sections REMOVED — canvas-canonical alignment (track-record-2.jsx TrackRecordPage
 * section order: Hero·Method·Tier·Exchange·Timeframe·Verify·Feed·Footer).
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

function dashboardFn(ts) {
  // Extract just the getPerformanceDashboardHtml function body for scoped grep.
  const start = ts.indexOf('function getPerformanceDashboardHtml');
  const end = ts.indexOf('// ── Smithery sandbox export', start);
  return ts.slice(start, end);
}

test('src/index.ts: W8 Q-W8-1 LATEST TRADE CALLS 8-col table from cachedData.recentSignals', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // 8-col table headers present
  assert.match(dash, /<th>ID<\/th>/, 'col 1: ID');
  assert.match(dash, /<th>Time<\/th>/, 'col 2: Time');
  assert.match(dash, /<th>Tier<\/th>/, 'col 3: Tier');
  assert.match(dash, /<th>Asset<\/th>/, 'col 4: Asset');
  assert.match(dash, /<th>Call<\/th>/, 'col 5: Call');
  assert.match(dash, /<th class="num">Confidence<\/th>/, 'col 6: Confidence');
  assert.match(dash, /<th class="num">Timeframe<\/th>/, 'col 7: Timeframe');
  assert.match(dash, /<th>Exchange<\/th>/, 'col 8: Exchange');
  // Hydration target
  assert.match(dash, /id="tr-recent-calls-tbody"/, 'tbody#tr-recent-calls-tbody');
  // Per-row deep-link to /verify?signalId=<id>
  assert.match(dash, /\/verify\?signalId='\+s\.id/, 'per-row deep-link via real .id');
});

test('src/index.ts: W8 Q-W8-2 Verify card real contract + live-binds', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // Real Basescan contract address. DESIGN-W8-FIX (2026-05-11): rendered text
  // is the FULL EIP-55 checksummed form per Mr.1 directive (mixed-case casing
  // disambiguates the lowercase-input forgery class). The hyperlink href stays
  // case-insensitive on Basescan so we match the EIP-55 form here.
  assert.match(dash, /0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81/, 'real EIP-55 contract address');
  // 0 occurrences of canvas placeholder address pattern in rendered fields
  // (comments are documentation, not rendered fields)
  const placeholderRe = />0x9aF3</;
  assert.ok(!placeholderRe.test(dash), 'no canvas placeholder address in rendered text');
  // Live-bind merkle_batch_count (existing) + NEW latest_batch_at
  assert.match(dash, /data-tr-field="merkle_batch_count"/, 'merkle_batch_count live-bind');
  assert.match(dash, /data-tr-field="latest_batch_at"/, 'NEW latest_batch_at live-bind');
  // Static "next batch in" placeholder (live countdown deferred)
  assert.match(dash, /next batch in/, 'next-batch-in copy present');
});

test('src/index.ts: W8 Q-W8-3 2.5s polling IIFE removed', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  assert.ok(!/setInterval\(fetchTrRecent/.test(dash), 'no fetchTrRecent setInterval');
  assert.ok(!/function fetchTrRecent/.test(dash), 'no fetchTrRecent function definition');
});

test('src/index.ts: W8 Q-W8-4 dead DOM IDs pruned from dashboard HTML', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // 8 deleted legacy DOM IDs — must be 0 in the rendered HTML
  const deadIds = ['tier-cards', 'by-type', 'by-timeframe', 'cb-section', 'cb-body', 'top-assets', 'worst-assets', 'tf-tabs'];
  for (const id of deadIds) {
    const re = new RegExp(`id="${id}"`);
    assert.ok(!re.test(dash), `legacy id="${id}" removed`);
  }
  // Legacy id="recent" (was the 8-col legacy recent-calls table) — removed
  // (the new W8 target is tr-recent-calls-tbody)
  assert.ok(!/id="recent"/.test(dash), 'legacy id="recent" removed');
});

test('src/index.ts: W8 Q-W8-5 Verify Any Call eyebrow + H2 + form structure', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // Eyebrow "· VERIFY"
  assert.match(dash, /verify-any-call-eyebrow/, 'eyebrow class present');
  // H2 "Verify Any Call" with mint accent on "Call"
  assert.match(dash, /<h2 class="verify-any-call-h2">Verify Any <span class="verify-any-call-h2-accent">Call<\/span><\/h2>/, 'canonical H2 markup');
  // Form action to /verify
  assert.match(dash, /action="\/verify"/, 'form action="/verify"');
  // Button label "Verify on-chain"
  assert.match(dash, /Verify on-chain/, 'button label');
  // Submit handler that constructs /verify?id=<encoded>
  assert.match(dash, /function verifyAnyCallSubmit/, 'verifyAnyCallSubmit handler');
  assert.match(dash, /\/verify\?id='\s*\+\s*encodeURIComponent/, 'submit handler builds query-string URL');
});

test('src/index.ts: W8 8 legacy sections removed from dashboard HTML', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // Legacy h2 headings (Title Case) — must be 0 inside dashboard function
  const deadH2 = [
    '<h2>Performance by Tier</h2>',
    '<h2>By Call Type</h2>',
    '<h2>Performance by Confidence Band</h2>',
    '<h2>Top Performing Assets</h2>',
    '<h2>Worst Performing Assets</h2>',
    '<h2>Recent Trade Calls</h2>',
  ];
  for (const h of deadH2) {
    assert.ok(!dash.includes(h), `legacy heading removed: ${h}`);
  }
  // Tamper-Proof Track Record badge content (was inside Block B) — must be 0 rendered
  assert.ok(!/>Tamper-Proof Track Record</.test(dash), 'tamper-proof badge text removed');
});

test('src/index.ts: W8 preservation-LAW — W3/W4/W6 deliverables intact', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // W3 D2-C: 4 tier-stat-cards
  for (const t of ['tier1', 'tier2', 'tier3', 'tier4']) {
    assert.ok(dash.includes(`id="tier-stat-card-${t}"`), `W3 tier-stat-card-${t} preserved`);
  }
  // W4 C3: 5 exchange-stat-cards
  for (const ex of ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET']) {
    assert.ok(dash.includes(`id="exchange-stat-card-${ex}"`), `W4 exchange-stat-card-${ex} preserved`);
  }
  // W4 C3 + W8-FIX (2026-05-11): 8 tf-bar-row entries (1m/3m/1d trimmed)
  for (const tf of ['5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h']) {
    assert.ok(dash.includes(`data-tf="${tf}"`), `W4 tf-bar-row data-tf="${tf}" preserved`);
  }
  // Trimmed TFs MUST be absent from bar chart
  for (const tf of ['1m', '3m', '1d']) {
    assert.ok(!dash.includes(`data-tf="${tf}"`), `W8-FIX: tf-bar-row data-tf="${tf}" trimmed`);
  }
  // W4 panel wrapper preserved
  assert.match(dash, /id="tr-recent-calls-panel"/, 'tr-recent-calls-panel wrapper preserved');
  // Cross-Venue Intelligence callout preserved
  assert.match(dash, /Cross-Venue Intelligence/, 'Cross-Venue Intelligence callout preserved');
  // Methodology section preserved
  assert.match(dash, /<h2>Methodology<\/h2>/, 'Methodology section preserved');
});

test('src/index.ts: W8 Factuality LAW canary — 0 canvas-placeholder values rendered', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // Per-row deep-link uses real .id from server, not fictional values.
  // The canvas placeholder hashes (0x4a2…f91 / #29 · 2026-05-09 18:00 UTC) appear
  // ONLY as INPUT PLACEHOLDER hints (placeholder="0x4a2…f91 · or · 2026-05-09T17:42:18Z"),
  // not as rendered numeric claims — these are example/hint values, not data.
  // The real data-tr-field bindings hydrate at runtime.
  // Assert no rendered "verdict: LONG" / "32 venues integrated" / etc. from canvas
  const renderedFictional = [
    'verdict: LONG',
    '79,616+ trade calls',
    '14.2k weekly',
    '3.1k stars',
  ];
  for (const f of renderedFictional) {
    assert.ok(!dash.includes(f), `Factuality canary: '${f}' not in dashboard HTML`);
  }
});

// ─── DESIGN-W8-FIX (2026-05-11) — spacing + TF trim + Verify live-binds + 8-col + black bg ───

test('src/index.ts: W8-FIX Verify card full EIP-55 contract + Basescan anchor', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // Full EIP-55 checksummed address (not truncated 0x6485...bf81)
  assert.match(dash, /0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81/, 'full EIP-55 address present');
  // Truncated form removed from rendered text
  assert.ok(!/>0x6485&hellip;bf81</.test(dash), 'truncated address removed from rendered text');
  // Contract anchor links to Basescan
  assert.match(dash, /href="https:\/\/basescan\.org\/address\/0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81"/, 'Basescan link');
  assert.match(dash, /verify-any-call-contract-link/, 'contract link class for hover style');
});

test('src/index.ts: W8-FIX merkle_batch_count + latest_batch_at + next_batch_in live-binds', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // merkle_batch_count hydration was MISSING in W8; W8-FIX adds it to load()
  assert.match(dash, /data-tr-field="merkle_batch_count"\]'\)\.forEach/, 'merkle_batch_count hydration in load()');
  // latest_batch_at hydration (from W8, preserved)
  assert.match(dash, /data-tr-field="latest_batch_at"\]'\)\.forEach/, 'latest_batch_at hydration');
  // NEW next_batch_in data-tr-field span in Verify card
  assert.match(dash, /data-tr-field="next_batch_in"/, 'next_batch_in span in Verify card');
  // Countdown function + 60s interval
  assert.match(dash, /function updateNextBatchCountdown/, 'updateNextBatchCountdown function');
  assert.match(dash, /setInterval\(updateNextBatchCountdown,\s*60000\)/, '60s countdown interval');
});

test('src/index.ts: W8-FIX Latest Trade Calls 8-col proportional widths', async () => {
  const ts = await read('src/index.ts');
  const dash = dashboardFn(ts);
  // Override global table max-width:800px for recent-table
  assert.match(dash, /\.recent-table \{[^}]*max-width:\s*none/, 'recent-table max-width: none override');
  // Each column gets percentage width (proportional distribution)
  assert.match(dash, /\.recent-table th:nth-child\(1\),[^{]+\{ width: 15%/, 'col 1 width: 15%');
  assert.match(dash, /\.recent-table th:nth-child\(8\),[^{]+\{ width: 15%/, 'col 8 width: 15%');
});

test('src/index.ts + algovault-design.css: W8-FIX card backgrounds unified to tier-stat-card reference', async () => {
  const ts = await read('src/index.ts');
  const css = await read('landing/_design/algovault-design.css');
  // tier-stat-card reference value (unchanged)
  assert.match(css, /\.tier-stat-card \{[\s\S]*?background:\s*oklch\(0\.18 0\.014 265 \/ 0\.5\)/, 'tier-stat-card reference bg preserved');
  // tr-recent-calls-panel matches reference
  assert.match(css, /\.tr-recent-calls-panel \{[\s\S]*?background:\s*oklch\(0\.18 0\.014 265 \/ 0\.5\)/, 'tr-recent-calls-panel matches reference');
  // verify-any-call-card matches reference (in src/index.ts inline CSS)
  assert.match(ts, /\.verify-any-call-card \{ background: oklch\(0\.18 0\.014 265 \/ 0\.5\)/, 'verify-any-call-card matches reference');
  // methodology + onchain-badge updated
  assert.match(ts, /\.methodology \{ background: oklch\(0\.18 0\.014 265 \/ 0\.5\)/, 'methodology matches reference');
  assert.match(ts, /\.onchain-badge \{[^}]*background: oklch\(0\.18 0\.014 265 \/ 0\.5\)/, 'onchain-badge matches reference');
});

test('algovault-design.css: W8-FIX card spacing gap 16px', async () => {
  const css = await read('landing/_design/algovault-design.css');
  // tier-stat-grid gap raised 14 -> 16
  assert.match(css, /\.tier-stat-grid \{[\s\S]*?gap:\s*16px/, 'tier-stat-grid gap: 16px');
  // exchange-stat-grid gap raised 12 -> 16
  assert.match(css, /\.exchange-stat-grid \{[\s\S]*?gap:\s*16px/, 'exchange-stat-grid gap: 16px');
});
