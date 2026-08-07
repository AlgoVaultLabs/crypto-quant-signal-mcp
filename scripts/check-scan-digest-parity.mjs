#!/usr/bin/env node
/**
 * check-scan-digest-parity.mjs — SCAN-DIGEST-MCP-PARITY-W1 CH4
 *
 * Single-derivation canary: the scan digest is computed ONCE (enrichScanCall +
 * renderScanDigestLine) and EVERY channel PROJECTS from it. Fails the build the moment
 * a channel forks the digest format. Asserts:
 *   1. renderScanDigestLine(enrichScanCall(DETAIL)) === LOCKED_LINE — the byte-identical
 *      format contract. The bot's tests/test_scan_digest_render.py pins the SAME
 *      LOCKED_LINE for the SAME fixture (cross-repo): a format change on EITHER side
 *      fails its suite unless BOTH + this contract move together (the cadence-mirror
 *      discipline, one level up).
 *   2. webhook scan_digest payload calls[] === enrichScanCall output — buildPayload is a
 *      PASSTHROUGH; the webhook channel never re-assembles (deep-equal).
 *   3. MCP content[1] (renderScanDigest) is built from renderScanDigestLine per call.
 *   4. enrichScanCall is allow-listed — never outcome_* / raw indicators (even when polluted).
 *
 *   --check                (default) OFFLINE; imports compiled dist; NO network.
 *   --simulate-divergence  compares the renderer against a TAMPERED contract → the parity
 *                          necessarily fails → rc=1, proving the canary has teeth.
 *   --live <baseUrl>       LIVE: a stateless /mcp tools/call scan_trade_calls(includeReasoning)
 *                          → STRUCTURAL parity (enriched shape + no forbidden keys). Fail-open.
 *
 * Exit codes: 0 = parity OK; 1 = divergence; 2 = fatal (dist missing / bad usage).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const argv = process.argv.slice(2);
const args = new Set(argv);
const MODE_LIVE = args.has('--live');
const MODE_DIVERGE = args.has('--simulate-divergence');
const LIVE_BASE = (() => {
  const i = argv.indexOf('--live');
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'https://api.algovault.com';
})();

const FAILS = [];
const fail = (m) => FAILS.push(m);

// ── The shared cross-repo fixture + locked line (identical to the MCP vitest
//    tests/unit/scan-digest-enrich.test.ts AND the bot tests/test_scan_digest_render.py). ──
const DETAIL = {
  coin: 'CL',
  timeframe: '4h',
  call: 'BUY',
  confidence: 60,
  regime: 'TRENDING_UP',
  price: 71.49,
  reasoning: 'Trending regime, upward bias. Funding pressure mild.',
  indicators: {
    funding_rate: -0.0009,
    funding_state: 'ELEVATED',
    oi_change_pct: 10.0,
    oi_change_window: '24h',
    trend_persistence: 'HIGH',
    breakout_pending: 'INACTIVE',
  },
};
const EXCHANGE = 'BINANCE';
const LOCKED_LINE =
  '🟢 CL — BUY @ $71.49 · 60% conviction · TRENDING_UP\n' +
  // OPS-RECEIPTS-FACTORS-DIRECTION-FIX-W1 R2 — RE-BASELINED. Class 1 (falsehood).
  // WAS `… · OI +10.0% (24h) ↑`. The OI arrow was derived from the sign of the delta for
  // an input that feeds no weight term and no adjustment. `funding elevated ↑` is Class 2
  // (a deferred naming collision, not a falsehood) and deliberately still stands.
  // The BOT side moves in the SAME wave — this contract is the lockstep pin.
  '   📊 trend persistence HIGH · funding elevated ↑ · OI +10.0% (24h)\n' +
  '   💡 Trending regime, upward bias';

let scanDigest, webhook;
try {
  scanDigest = await import(path.join(REPO_ROOT, 'dist', 'lib', 'scan-digest.js'));
  webhook = await import(path.join(REPO_ROOT, 'dist', 'lib', 'webhook-delivery.js'));
} catch (e) {
  console.error('[scan-digest-parity] FATAL — dist not built (run `npm run build`):', e.message);
  process.exit(2);
}
const { enrichScanCall, renderScanDigestLine, renderScanDigest } = scanDigest;
const { buildPayload } = webhook;

// ── (1) the byte-identical digest-line contract (cross-repo pin) ──
function checkLockedLine(expected) {
  const line = renderScanDigestLine(enrichScanCall(DETAIL, EXCHANGE));
  if (line !== expected) {
    fail(
      'renderScanDigestLine drift vs the locked cross-repo contract\n' +
        `      got:  ${JSON.stringify(line)}\n` +
        `      want: ${JSON.stringify(expected)}`,
    );
  }
}

// ── (2) the webhook channel projects from enrichScanCall (passthrough, no fork) ──
function checkWebhookParity() {
  const enriched = enrichScanCall(DETAIL, EXCHANGE);
  const payload = buildPayload(
    { type: 'scan_digest', cadence: '1h', timeframe: '4h', exchange: EXCHANGE, calls: [enriched], generated_at: 1_700_000_000 },
    'parity-1',
  );
  const wcall = payload?.data?.calls?.[0];
  if (JSON.stringify(wcall) !== JSON.stringify(enriched)) {
    fail('webhook scan_digest calls[0] != enrichScanCall output — the webhook channel forked the digest');
  }
}

// ── (3) MCP content[1] is built from renderScanDigestLine per call ──
function checkContentProjection() {
  const enriched = enrichScanCall(DETAIL, EXCHANGE);
  const digest = renderScanDigest([enriched], { topN: 20, timeframe: '4h', exchange: EXCHANGE });
  if (!digest.includes(renderScanDigestLine(enriched))) {
    fail('renderScanDigest (content[1]) does not project from renderScanDigestLine');
  }
}

// ── (4) enrichScanCall allow-list (no outcome_* / raw indicators) ──
function checkAllowList() {
  const polluted = { ...DETAIL, outcome_return_pct: 12.34, outcome_price: 65432.1 };
  const j = JSON.stringify(enrichScanCall(polluted, EXCHANGE));
  if (/outcome_/.test(j)) fail('enrichScanCall leaked an outcome_* field');
  if (/"indicators"\s*:/.test(j)) fail('enrichScanCall leaked the raw indicators object');
}

async function checkLive(base) {
  const url = `${base.replace(/\/$/, '')}/mcp`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'scan_trade_calls', arguments: { topN: 10, exchange: 'BINANCE', timeframe: '15m', includeReasoning: true } },
  });
  let json;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body,
    });
    const text = await res.text();
    // stateless SSE or JSON — pull the data: line if SSE.
    const payload = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') : text;
    json = JSON.parse(payload);
  } catch (e) {
    console.log(`  ~ LIVE ${url} unreachable (fail-open): ${e.message}`);
    return;
  }
  let result;
  try {
    result = JSON.parse(json.result.content[0].text);
  } catch {
    fail('LIVE: could not parse content[0] envelope');
    return;
  }
  if (/outcome_/.test(JSON.stringify(result))) fail('LIVE: forbidden outcome_* in scan output');
  const nonHold = (result.calls || []).filter((c) => c.call !== 'HOLD');
  if (nonHold.length === 0) {
    console.log('  · LIVE: 0 actionable calls right now — structural parity not exercised (fail-open)');
    return;
  }
  for (const c of nonHold) {
    if (!Array.isArray(c.factors)) fail(`LIVE: enriched call ${c.coin} missing factors[]`);
    if (typeof c.price !== 'number') fail(`LIVE: enriched call ${c.coin} missing price`);
    if (typeof c.reasoning !== 'string') fail(`LIVE: enriched call ${c.coin} missing reasoning`);
  }
  if (!FAILS.length) console.log(`  ✓ LIVE ${url}: ${nonHold.length} enriched calls (factors+price+reasoning, no outcome_*)`);
}

// ── run ──
try {
  // Assertion (1) drives the --simulate-divergence proof: tamper the CONTRACT so the
  // (correct) renderer output no longer matches → the canary MUST flag it.
  checkLockedLine(MODE_DIVERGE ? LOCKED_LINE.replace('conviction', 'conf') : LOCKED_LINE);
  checkWebhookParity();
  checkContentProjection();
  checkAllowList();
  if (MODE_LIVE) await checkLive(LIVE_BASE);
} catch (e) {
  console.error('[scan-digest-parity] FATAL:', e);
  process.exit(2);
}

if (MODE_DIVERGE) {
  if (FAILS.length > 0) {
    console.log(`[scan-digest-parity] --simulate-divergence: detected ${FAILS.length} divergence(s) as expected → rc=1`);
    process.exit(1);
  }
  console.error('[scan-digest-parity] --simulate-divergence: expected a divergence but found none — canary has no teeth!');
  process.exit(2);
}

if (FAILS.length) {
  console.error(`[scan-digest-parity] ❌ ${FAILS.length} parity failure(s):`);
  for (const f of FAILS) console.error('  - ' + f);
  process.exit(1);
}
console.log(
  `[scan-digest-parity] ✅ ${MODE_LIVE ? 'LIVE' : 'offline'} parity OK — one enrichScanCall/renderScanDigestLine; ` +
    'webhook + content[1] project from it; allow-listed; line byte-identical to the bot pin.',
);
process.exit(0);
