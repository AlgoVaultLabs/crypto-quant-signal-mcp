/**
 * P1-TRACK-RECORD-LEADERBOARD-W1 — behavioral + structural tests for the unified
 * /track-record leaderboard that replaced the 3 fixed per-segment sections.
 *
 * Behavioral: the REAL inline controller (extracted verbatim from src/index.ts —
 * no logic duplication) is executed in jsdom against a fixed perf fixture, then
 * driven via the same setLbDim / setLbSort / toggleLbDir / setLbMinN handlers the
 * page wires to its control pills. Asserts:
 *   - per-dimension render (Venue / Asset / Timeframe / Tier)
 *   - sort by WR + by n, asc + desc (worst-first in one tap)
 *   - min-sample FILTER (Q-P1-4: hides below floor; n>=0 restores; default 30)
 *   - low-sample muted "small sample" tag fires on shown sub-threshold rows
 *   - Timeframe set excludes 1d/1m via HIDE_TFS (Q-P1-8 single source)
 *   - Asset caption live-counted from the payload (Q-P1-7: no hardcoded total)
 *   - outcome_return_pct / P&L NEVER rendered (Data Integrity allow-list)
 *   - auto-refresh re-render: mutating cachedData + re-render shows new numbers
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

async function readSrc() {
  return readFile(resolve(REPO, 'src/index.ts'), 'utf8');
}

// TRACK-RECORD-EXCHANGE-BRAND-COLORS-W1: the controller now interpolates the
// server-side VENUE_BRAND_COLORS SoT (var VENUE_BRAND_COLORS = ${JSON.stringify(...)})
// to colour the ANALYZING chip row. Re-rendering the controller (below) needs that
// object in scope, so read the REAL palette from its SoT module (no duplication /
// drift — same values the server ships). The object literal's `KEY: '#hex'` entries
// are parsed; the prose/JSDoc above the `export const` is excluded by slicing from it.
async function readBrandColors() {
  const t = await readFile(resolve(REPO, 'src/lib/venue-brand-colors.ts'), 'utf8');
  const start = t.indexOf('export const VENUE_BRAND_COLORS');
  const body = t.slice(start, t.indexOf('};', start));
  const obj = {};
  for (const m of body.matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)) obj[m[1]] = m[2];
  assert.ok(Object.keys(obj).length >= 15, 'brand-colour SoT parsed (>=15 entries)');
  return obj;
}
function perfFunc(src) {
  return src.slice(src.indexOf('function getPerformanceDashboardHtml'), src.indexOf('// ── Smithery sandbox export'));
}

// Extract the dashboard's inline <script> (the leaderboard controller lives here).
function extractInlineScript(src) {
  const func = perfFunc(src);
  const m = func.match(/<script>\n(var PERF_URL[\s\S]*?)<\/script>/);
  assert.ok(m, 'dashboard inline <script> with the leaderboard controller must exist');
  return m[1];
}

// The inline script is authored INSIDE a TS template literal, so the source form
// carries template-literal escapes (e.g. \\' -> \') + ${perfEndpoint}. Evaluate it
// exactly as the server does to get the real browser JS, then run THAT (no logic
// duplication — we execute the shipped controller verbatim).
function renderControllerJs(src, brandColors) {
  const raw = extractInlineScript(src);
  const fn = new Function('perfEndpoint', 'cbEndpoint', 'VENUE_BRAND_COLORS', 'return `' + raw + '`');
  return fn('/api/performance-public', '/api/confidence-bands-public', brandColors);
}

const FIXTURE = {
  overall: { pfeWinRate: 0.9, totalCalls: 1000, totalEvaluated: 1000 },
  totalHolds: 9000,
  period: { from: '2026-04-10', to: '2026-06-21' },
  byExchange: {
    HL:      { count: 500, evaluated: 500, pfeWinRate: 0.95 },
    BINANCE: { count: 300, evaluated: 300, pfeWinRate: 0.90 },
    BYBIT:   { count: 200, evaluated: 200, pfeWinRate: 0.85 },
    OKX:     { count: 100, evaluated: 100, pfeWinRate: 0.80 },
    BITGET:  { count: 50,  evaluated: 50,  pfeWinRate: 0.70 },
  },
  byTier: {
    tier1: { tier: 1, name: 'Blue Chip', label: 'Tier 1', color: '#58a6ff', count: 400, pfeWinRate: 0.93 },
    tier2: { tier: 2, name: 'Major Alts', label: 'Tier 2', color: '#3fb950', count: 300, pfeWinRate: 0.91 },
    tier3: { tier: 3, name: 'TradFi', label: 'Tier 3', color: '#bc8cff', count: 200, pfeWinRate: 0.90 },
    tier4: { tier: 4, name: 'Meme', label: 'Tier 4', color: '#d29922', count: 100, pfeWinRate: 0.88 },
  },
  byTimeframe: {
    '3m': { count: 600, evaluated: 600, pfeWinRate: 0.94 },
    '1h': { count: 200, evaluated: 200, pfeWinRate: 0.88 },
    '12h': { count: 50, evaluated: 50, pfeWinRate: 0.80 },
    '1d': { count: 995, evaluated: 995, pfeWinRate: 0.54 }, // excluded from leaderboard via HIDE_TFS
  },
  byAsset: {
    BTC:  { count: 500, tier: 1, pfeWinRate: 0.96 },
    ETH:  { count: 300, tier: 1, pfeWinRate: 0.93 },
    SOL:  { count: 80,  tier: 2, pfeWinRate: 0.90 },
    TINY: { count: 5,   tier: 4, pfeWinRate: 0.60 }, // below default n>=30 floor
  },
};

const SCAFFOLD = `<!DOCTYPE html><html><body>
  <div id="loading"></div><div id="content"></div><div id="updated"></div>
  <div class="tabs" id="lb-dim-pills">
    <div class="tab active" data-dim="exchange"></div><div class="tab" data-dim="asset"></div>
    <div class="tab" data-dim="timeframe"></div><div class="tab" data-dim="tier"></div>
  </div>
  <div class="tabs" id="lb-sort-pills">
    <div class="tab active" data-sort="wr"></div><div class="tab" data-sort="n"></div>
    <div class="tab" id="lb-dir"></div>
  </div>
  <div class="tabs" id="lb-minn-pills">
    <div class="tab" data-minn="0"></div><div class="tab active" data-minn="30"></div>
    <div class="tab" data-minn="100"></div><div class="tab" data-minn="500"></div>
  </div>
  <table><tbody id="lb-tbody"></tbody></table>
  <div id="lb-caption"></div>
</body></html>`;

async function freshWindow() {
  const script = renderControllerJs(await readSrc(), await readBrandColors());
  const dom = new JSDOM(SCAFFOLD, { runScripts: 'outside-only' });
  const w = dom.window;
  w.fetch = () => new Promise(() => {}); // load()'s fetch never settles → no async noise
  w.setInterval = () => 0;               // don't register real timers in the test
  w.eval(script);                        // top-level var/function become window props
  w.cachedData = FIXTURE;
  return w;
}
const body = (w) => w.document.getElementById('lb-tbody').innerHTML;
const caption = (w) => w.document.getElementById('lb-caption').textContent;

test('leaderboard: Venue dimension renders all 5 venues, WR desc by default', async () => {
  const w = await freshWindow();
  w.renderLeaderboard();
  const html = body(w);
  for (const v of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) assert.ok(html.includes(v), `${v} row present`);
  assert.ok(html.includes('95.0%'), 'HL WR rendered');
  assert.ok(html.indexOf('Hyperliquid') < html.indexOf('Bitget'), 'default WR-desc puts best (HL 95%) above worst (Bitget 70%)');
});

test('leaderboard: worst-first reachable in one direction tap', async () => {
  const w = await freshWindow();
  w.renderLeaderboard();
  w.toggleLbDir(); // one tap -> asc
  const html = body(w);
  assert.ok(html.indexOf('Bitget') < html.indexOf('Hyperliquid'), 'asc puts worst (Bitget 70%) first');
});

test('leaderboard: sort by Calls (n) orders by sample size', async () => {
  const w = await freshWindow();
  w.setLbSort('n'); // desc by n
  const html = body(w);
  assert.ok(html.indexOf('Hyperliquid') < html.indexOf('OKX'), 'HL (n=500) above OKX (n=100) when sorting by n');
});

test('leaderboard: Tier dimension renders 4 tiers with names', async () => {
  const w = await freshWindow();
  w.setLbDim('tier');
  const html = body(w);
  for (const t of ['Blue Chip', 'Major Alts', 'TradFi', 'Meme']) assert.ok(html.includes(t), `${t} tier present`);
  assert.ok(html.includes('Tier 1') && html.includes('Tier 4'), 'tier labels present');
});

test('leaderboard: Timeframe dimension EXCLUDES 1d/1m (Q-P1-8 HIDE_TFS single source)', async () => {
  const w = await freshWindow();
  w.setLbDim('timeframe');
  const html = body(w);
  assert.ok(html.includes('<strong>3m</strong>'), '3m present');
  assert.ok(html.includes('<strong>1h</strong>'), '1h present');
  assert.ok(html.includes('<strong>12h</strong>'), '12h present');
  assert.ok(!html.includes('<strong>1d</strong>'), '1d excluded (not in published aggregate)');
});

test('leaderboard: Asset min-sample FILTER hides sub-floor at n>=30; n>=0 restores + tags (Q-P1-4/7)', async () => {
  const w = await freshWindow();
  w.setLbDim('asset'); // default floor n>=30
  let html = body(w);
  assert.ok(html.includes('BTC') && html.includes('SOL'), 'n>=30 assets shown');
  assert.ok(!html.includes('TINY'), 'sub-floor asset (n=5) hidden at n>=30');
  assert.ok(!html.includes('small sample'), 'no small-sample tag while sub-floor rows hidden');
  assert.match(caption(w), /3 of 4 assets/, 'live caption: 3 of 4 assets (no hardcoded total)');
  // n>=0 restores everything, sub-threshold rows shown but tagged + muted
  w.setLbMinN(0);
  html = body(w);
  assert.ok(html.includes('TINY'), 'n>=0 restores the sub-floor asset');
  assert.ok(html.includes('small sample'), 'restored sub-floor row carries the muted small-sample tag');
  assert.match(caption(w), /4 of 4 assets/, 'live caption updates to 4 of 4');
});

test('leaderboard: NO outcome_return_pct / P&L rendered in any dimension (Data Integrity)', async () => {
  const w = await freshWindow();
  for (const dim of ['exchange', 'asset', 'timeframe', 'tier']) {
    w.setLbDim(dim);
    w.setLbMinN(0);
    const html = body(w);
    assert.ok(!/outcome_return_pct|outcome_price|outcome_won|"pnl"|"roi"|P&L|profit/i.test(html), `no P&L leak in ${dim} dimension`);
  }
});

test('leaderboard: auto-refresh re-renders numbers from the (mutated) payload', async () => {
  const w = await freshWindow();
  w.renderLeaderboard();
  assert.ok(body(w).includes('95.0%'), 'initial HL WR 95.0%');
  // simulate the 30s load() refresh delivering a new payload value
  w.cachedData.byExchange.HL.pfeWinRate = 0.50;
  w.renderLeaderboard();
  assert.ok(body(w).includes('50.0%'), 'HL WR re-rendered to the new live value');
});

// ── Structural (source) assertions ──────────────────────────────────────────
test('source: leaderboard controller wired into the 30s refresh + no new setInterval', async () => {
  const func = perfFunc(await readSrc());
  assert.ok(/function renderLeaderboard\(\)/.test(func), 'renderLeaderboard defined');
  assert.ok(/renderLeaderboard\(\);/.test(func), 'renderLeaderboard called (from renderAll, on the 30s loop)');
  assert.ok(/HIDE_TFS\[tf\]/.test(func), 'TF dimension filtered via HIDE_TFS (single source)');
  assert.ok(/id="leaderboard-section"/.test(func), 'server-rendered leaderboard section present');
});

test('source: Dataset JSON-LD with variableMeasured, no synthetic aggregateRating', async () => {
  const func = perfFunc(await readSrc());
  assert.ok(/"@type":"Dataset"/.test(func), 'Dataset JSON-LD present');
  assert.ok(/"PFE Win Rate"/.test(func) && /"Sample Size"/.test(func), 'variableMeasured PropertyValues present');
  assert.ok(!/"aggregateRating"/.test(func), 'no synthetic aggregateRating');
});
