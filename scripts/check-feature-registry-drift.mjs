#!/usr/bin/env node
/**
 * check-feature-registry-drift.mjs — FEATURE-REGISTRY-SOT-W1 CH4
 *
 * Drift canary that locks parity between the feature registry (the SoT,
 * src/lib/feature-registry.ts) and every channel that DERIVES its surface from it.
 * "MCP is the single Source of Truth; a channel that falls out of sync fails the build."
 *
 * TWO complementary modes (each checks what its execution context CAN reach):
 *
 *   --check                 STATIC parity (imports compiled dist; NO network). The CI
 *                           pre-publish gate + the in-container check. Asserts:
 *                             1. projectCapabilities() names == allToolNames()  (projection covers every callable name)
 *                             2. TOOL_PRICING derives from the registry: canonical + EACH alias
 *                                of every priced feature maps to basePriceUsd; unpriced features
 *                                have NO key (CH3 derive parity)
 *                             3. HTTP_TOOLS alias-resolved->canonical == registry httpX402 priced set
 *                                (CH3 gated/discoverable route-set parity)
 *                             4. projection leaks ZERO internal fields (descriptionRef / outcome_* / eligible_non_hold)
 *                             5. webhook VALID_EVENTS == registry webhook-flagged set
 *                             6. a2mcp (okx.ai A2MCP) set DERIVES from the registry, is priced + httpX402,
 *                                and EXCLUDES equities (OKX-AI-FIRST-MOVER-W1; --check-only — the okx.ai
 *                                listing is an external marketplace and the routes ship dark behind OKX_AI_ENABLED)
 *
 *   --live <baseUrl>        LIVE parity (HTTP only; dist-FREE so it runs on the host or against
 *                           prod). Uses GET /capabilities as the registry's LIVE projection and
 *                           asserts the OTHER channels match it:
 *                             A. live tools/list (3-step MCP handshake) name-set == /capabilities names (MCP channel)
 *                             B. each live /x402/<tool> that 402s prices == /capabilities x402.basePriceUsd
 *                                (404 = a priced-but-not-gated canonical name, e.g. get_trade_call — skipped;
 *                                 route-SET parity is the STATIC check's job via HTTP_TOOLS)
 *                           fail-open: a network/unreachable error logs + exits 0 (never pages on a blip).
 *
 *   --alert                 (with --live) on CONFIRMED drift, feed the contract alert body to
 *                           send_telegram.sh (alert_id FEATURE_REGISTRY_DRIFT, CRITICAL_PERSISTENT).
 *                           Honors DRY_RUN_TG (the wrapper skips the real POST). Wrapper path via
 *                           env SEND_TELEGRAM (default /opt/algovault-monitoring/send_telegram.sh).
 *
 *   --simulate-drift        (with --live) inject a synthetic ghost tool into the registry-expected
 *                           set so the MCP channel necessarily mismatches → proves the canary catches
 *                           drift (rc=1 + alert body). Non-destructive (no file/endpoint mutation).
 *
 * Exit codes: 0 = in-sync OR fail-open (unreachable); 1 = drift detected; 2 = fatal (bad usage / dist missing in --check).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const alertMode = args.includes('--alert');
const simulateDrift = args.includes('--simulate-drift');
const liveIdx = args.indexOf('--live');
const liveMode = liveIdx !== -1;
const baseUrl = liveMode ? (args[liveIdx + 1] || process.env.CANARY_BASE_URL || 'https://api.algovault.com') : null;

const SEND_TELEGRAM = process.env.SEND_TELEGRAM || '/opt/algovault-monitoring/send_telegram.sh';
const RUNBOOK = 'docs/RUNBOOK-FEATURE-REGISTRY.md';
const SOURCE_LOG = '/var/log/algovault-monitoring-feature-registry-drift.log';

function log(...m) { console.log('[feature-registry-drift]', ...m); }
function fail(...m) { console.error('[feature-registry-drift]', ...m); }

/** Build the contract-shaped TG alert body (resolver substitutes the W{NEXT} template). */
function alertBody(drifts) {
  const summary = drifts.map((d) => `  • ${d}`).join('\n');
  return [
    '🛑 FEATURE_REGISTRY_DRIFT',
    `A channel surface no longer matches the feature registry (SoT) — ${drifts.length} mismatch(es).`,
    summary,
    'Action: dispatch OPS-FEATURE-REGISTRY-DRIFT-W{NEXT} via Cowork → Claude Code',
    `Audit shape: ${RUNBOOK}`,
    `Source log: ${SOURCE_LOG}`,
  ].join('\n');
}

/** Fire the alert via send_telegram.sh (severity-gate/cooldown/DRY_RUN/fail-open live in the wrapper). */
function sendAlert(drifts) {
  const body = alertBody(drifts);
  try {
    const r = spawnSync(SEND_TELEGRAM, ['FEATURE_REGISTRY_DRIFT', 'CRITICAL_PERSISTENT', '-'], {
      input: body,
      encoding: 'utf8',
      timeout: 20000,
    });
    if (r.error) { fail(`send_telegram invoke failed (fail-open): ${r.error.message}`); return; }
    log(`send_telegram rc=${r.status}${process.env.DRY_RUN_TG ? ' (DRY_RUN_TG)' : ''}`);
    if (r.stdout) log(`send_telegram stdout: ${r.stdout.trim()}`);
  } catch (e) {
    fail(`send_telegram threw (fail-open): ${e.message}`);
  }
}

// ──────────────────────────── STATIC mode (imports dist) ────────────────────────────
async function runStatic() {
  let reg;
  try {
    reg = await import(path.join(REPO_ROOT, 'dist', 'lib', 'feature-registry.js'));
  } catch (e) {
    fail(`dist not built (run \`npm run build\`): ${e.message}`);
    process.exit(2);
  }
  const x402 = await import(path.join(REPO_ROOT, 'dist', 'lib', 'x402.js'));
  const routes = await import(path.join(REPO_ROOT, 'dist', 'lib', 'x402-http-routes.js'));
  const webhookApi = await import(path.join(REPO_ROOT, 'dist', 'lib', 'webhook-api.js'));
  const { FEATURE_REGISTRY, allToolNames, getFeature, projectCapabilities, webhookEventTypes } = reg;
  const { TOOL_PRICING } = x402;
  const { HTTP_TOOLS } = routes;
  const { VALID_EVENTS } = webhookApi;

  const drifts = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // 1. projection covers every callable name
  const projNames = projectCapabilities().tools.map((t) => t.name).sort();
  const toolNames = [...allToolNames()].sort();
  if (!eq(projNames, toolNames)) {
    drifts.push(`projectCapabilities names != allToolNames: proj=[${projNames}] reg=[${toolNames}]`);
  }

  // 2. TOOL_PRICING derives from the registry (canonical + alias for priced; absent for unpriced)
  for (const f of FEATURE_REGISTRY) {
    for (const name of [f.name, ...f.aliases]) {
      const got = TOOL_PRICING[name];
      if (f.x402) {
        if (got !== f.x402.basePriceUsd) drifts.push(`TOOL_PRICING[${name}]=${got} != registry $${f.x402.basePriceUsd}`);
      } else if (got !== undefined) {
        drifts.push(`TOOL_PRICING[${name}]=${got} but registry says unpriced (x402:null)`);
      }
    }
  }

  // 3. HTTP_TOOLS (gated/discoverable route set) alias-resolved == registry httpX402 priced set
  const regHttpX402 = FEATURE_REGISTRY.filter((f) => f.channels.httpX402 && f.x402).map((f) => f.name).sort();
  const httpResolved = [...new Set([...HTTP_TOOLS].map((n) => getFeature(n)?.name))].sort();
  if (!eq(httpResolved, regHttpX402)) {
    drifts.push(`HTTP_TOOLS(resolved)=[${httpResolved}] != registry httpX402=[${regHttpX402}]`);
  }

  // 4. projection leaks zero internal fields
  const FORBIDDEN = ['descriptionRef', 'outcome_return_pct', 'outcome_price', 'eligible_non_hold'];
  for (const t of projectCapabilities().tools) {
    for (const k of Object.keys(t)) {
      if (FORBIDDEN.includes(k)) drifts.push(`projection leaks internal field "${k}" on ${t.name}`);
    }
  }

  // 5. webhook VALID_EVENTS == registry webhook-flagged webhookEvent set
  //    (FEATURE-PARITY-CHANNELS-W1 CH5 — the webhook channel DERIVES its accepted
  //    event set from the registry; a hand-edited 2nd list drifts here. /capabilities
  //    omits webhookEvent (A1), so this parity lives in --check, which reads
  //    VALID_EVENTS + the registry directly from dist.)
  const regEvents = [...webhookEventTypes()].sort();
  let liveEvents = [...VALID_EVENTS].sort();
  if (simulateDrift) liveEvents = [...liveEvents, '__ghost_event__'].sort();
  if (!eq(liveEvents, regEvents)) {
    drifts.push(`webhook VALID_EVENTS=[${liveEvents}] != registry webhookEvent set=[${regEvents}]`);
  }

  // 6. a2mcp (okx.ai A2MCP) parity — OKX-AI-FIRST-MOVER-W1.
  //    (a) the LISTED set DERIVES from the registry (okxA2mcpTools() == enabled a2mcp features) —
  //        no hardcoded okx.ai tool list anywhere (single-derivation lock);
  //    (b) every a2mcp tool is PRICED (x402!=null) + httpX402 (settlement rides the x402 transport) —
  //        a paid A2MCP listing cannot expose an unpriced/no-transport tool;
  //    (c) equities are NEVER a2mcp (securities / okx.ai UA §7.1 HOLD).
  const okx = await import(path.join(REPO_ROOT, 'dist', 'lib', 'okx-a2mcp.js'));
  const regA2mcp = FEATURE_REGISTRY.filter((f) => f.enabled && f.channels.a2mcp).map((f) => f.name).sort();
  const derivedA2mcp = [...okx.okxA2mcpTools()].sort();
  if (!eq(derivedA2mcp, regA2mcp)) {
    drifts.push(`okxA2mcpTools()=[${derivedA2mcp}] != registry a2mcp set=[${regA2mcp}]`);
  }
  for (const name of regA2mcp) {
    const f = getFeature(name);
    if (!f?.x402) drifts.push(`a2mcp tool ${name} is UNPRICED (x402:null) — a paid A2MCP listing needs a price`);
    if (!f?.channels?.httpX402) drifts.push(`a2mcp tool ${name} lacks httpX402 — A2MCP settlement rides the x402 transport`);
    if (/^get_equity_/.test(name)) drifts.push(`a2mcp tool ${name} is an equity (securities/§7.1 HOLD — must be a2mcp:false)`);
  }

  if (drifts.length === 0) {
    log(`STATIC in-sync ✅ — ${toolNames.length} tools, ${regHttpX402.length} gated x402 routes, ${regEvents.length} webhook events, ${regA2mcp.length} a2mcp tools, projection clean`);
    process.exit(0);
  }
  fail(`STATIC DRIFT (${drifts.length}):`);
  drifts.forEach((d) => fail(`  • ${d}`));
  process.exit(1);
}

// ──────────────────────────── LIVE mode (HTTP only, dist-free) ────────────────────────────
function parseMaybeSse(text) {
  // streamable-HTTP may return SSE frames (`event: message\ndata: {...}`) or raw JSON.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  for (const line of trimmed.split('\n')) {
    const m = line.match(/^data:\s*(.+)$/);
    if (m) { try { return JSON.parse(m[1]); } catch { /* keep scanning */ } }
  }
  throw new Error('no JSON/SSE payload in response');
}

async function fetchToolsList(base) {
  // 3-step streamable-HTTP handshake: initialize → notifications/initialized → tools/list.
  const url = `${base}/mcp`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const initRes = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'drift-canary', version: '1' } } }),
  });
  const sid = initRes.headers.get('mcp-session-id');
  parseMaybeSse(await initRes.text()); // drain
  const h2 = sid ? { ...headers, 'mcp-session-id': sid } : headers;
  await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) });
  const listRes = await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  const json = parseMaybeSse(await listRes.text());
  const tools = json?.result?.tools;
  if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');
  return tools.map((t) => t.name).sort();
}

async function runLive(base) {
  const drifts = [];
  let capsTools;
  try {
    // /capabilities = the registry's LIVE projection (the SoT side).
    const capsRes = await fetch(`${base}/capabilities`, { headers: { Accept: 'application/json' } });
    if (!capsRes.ok) throw new Error(`/capabilities HTTP ${capsRes.status}`);
    const caps = await capsRes.json();
    capsTools = caps?.tools;
    if (!Array.isArray(capsTools)) throw new Error('/capabilities has no tools[]');
  } catch (e) {
    // fail-open: registry projection unreachable → don't page on a blip.
    fail(`LIVE fail-open (registry projection unreachable): ${e.message}`);
    process.exit(0);
  }

  let expectedNames = capsTools.map((t) => t.name).sort();
  if (simulateDrift) {
    expectedNames = [...expectedNames, 'ghost_drift_tool'].sort();
    log('SIMULATE: injected ghost_drift_tool into the registry-expected set');
  }

  // A. MCP channel: live tools/list == /capabilities names
  try {
    const liveTools = await fetchToolsList(base);
    const missing = expectedNames.filter((n) => !liveTools.includes(n));
    const extra = liveTools.filter((n) => !expectedNames.includes(n));
    if (missing.length) drifts.push(`tools/list MISSING registry tool(s): [${missing}]`);
    if (extra.length) drifts.push(`tools/list has tool(s) NOT in registry: [${extra}]`);
  } catch (e) {
    fail(`LIVE fail-open (tools/list unreachable): ${e.message}`);
    process.exit(0);
  }

  // B. x402 price parity: each priced+httpX402 capability whose /x402 route 402s must match the price.
  for (const t of capsTools) {
    if (!t.channels?.httpX402 || !t.x402) continue;
    try {
      const r = await fetch(`${base}/x402/${t.name}`, { method: 'GET', headers: { Accept: 'application/json' } });
      if (r.status === 404) continue; // priced-but-not-gated canonical (e.g. get_trade_call) — route-set is STATIC check's job
      if (r.status !== 402) { drifts.push(`/x402/${t.name} expected 402, got ${r.status}`); continue; }
      const body = await r.json().catch(() => null);
      const atomic = body?.accepts?.[0]?.maxAmountRequired;
      if (atomic !== undefined) {
        const usd = Number(atomic) / 1e6;
        if (Math.abs(usd - t.x402.basePriceUsd) > 1e-9) {
          drifts.push(`/x402/${t.name} price $${usd} != registry $${t.x402.basePriceUsd}`);
        }
      }
    } catch (e) {
      log(`/x402/${t.name} probe skipped (fail-open): ${e.message}`);
    }
  }

  if (drifts.length === 0) {
    log(`LIVE in-sync ✅ — ${expectedNames.length} tools match across MCP + /capabilities + x402 (${base})`);
    process.exit(0);
  }
  fail(`LIVE DRIFT (${drifts.length}):`);
  drifts.forEach((d) => fail(`  • ${d}`));
  if (alertMode) sendAlert(drifts);
  process.exit(1);
}

// ──────────────────────────── dispatch ────────────────────────────
if (!checkMode && !liveMode) {
  fail('usage: check-feature-registry-drift.mjs (--check | --live <baseUrl> [--alert] [--simulate-drift])');
  process.exit(2);
}
if (liveMode) {
  await runLive(baseUrl);
} else {
  await runStatic();
}
