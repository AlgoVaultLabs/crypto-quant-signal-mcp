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
 *                             B. each live /x402/<tool> that 402s prices == /capabilities x402.basePriceUsd,
 *                                on EVERY accepts[] entry (404 = skipped; route-SET parity is the STATIC
 *                                check's job via HTTP_TOOLS). The challenge is read by the ONE decoder
 *                                `decodeX402Challenge` (body accepts[] for x402Version 1|2, else the base64
 *                                `payment-required` header); price = `amount` (v2) ?? `maxAmountRequired` (v1).
 *                                A 402 with no readable price is a drift (price_field_unreadable) — before
 *                                OPS-A2MCP-SERVED-TRUTH-W1 this leg read only the v1 field, so on the v2
 *                                bodies prod serves it compared nothing and could not fail.
 *                                Prints ONE line: `LEG_B price=AGREE|DISAGREE|INDETERMINATE compared=<routes>`
 *                                (compared=0 ⇒ INDETERMINATE: a pass over zero routes is not a pass).
 *                             C. DECLARED vs SERVED (OPS-A2MCP-SERVED-TRUTH-W1): for each paid HTTP rail
 *                                (httpX402 → /x402, a2mcp → /a2mcp) declared true on ≥1 /capabilities entry,
 *                                GET <prefix>/<first declared canonical tool> and classify (`classifyLegC`):
 *                                402 + decodable v2 challenge, no _stub → AGREE · 402 with _stub → DISAGREE
 *                                stub · 404 → DISAGREE not_mounted · 503 + `X-Rail-State: initializing;
 *                                since=<ISO>` older than 30 min → DISAGREE stuck_initializing, younger →
 *                                INDETERMINATE initializing · anything else / timeout → INDETERMINATE.
 *                                acp declared → INDETERMINATE no_external_liveness_surface (ruling R-6);
 *                                a rail declared nowhere → NOT_DECLARED. Prints exactly ONE line per rail:
 *                                `LEG_C <rail>=AGREE|DISAGREE|INDETERMINATE|NOT_DECLARED reason=<r>`; each
 *                                DISAGREE joins the drifts (exit 1; the --alert body names rail, route, reason).
 *                                Why: /a2mcp/* answered 404 for weeks while /capabilities declared a2mcp:true
 *                                and nothing compared the two.
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
 *                           Also adds leg-C rail `simulated`, probing <base>/a2mcp/__leg_c_simulated__
 *                           (404 by construction) → `LEG_C simulated=DISAGREE` — proves leg C can go red.
 *
 * Exit codes: 0 = in-sync OR fail-open (unreachable); 1 = drift detected; 2 = fatal (bad usage / dist missing in --check).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

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

// ──────────────── x402 challenge decoding — ONE parser for legs B and C ────────────────
// Pure + exported so tests/unit/feature-registry-drift-legs.test.ts drives every branch.

function tryJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try { return JSON.parse(text); } catch { return null; }
}

function tryBase64Json(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try { return JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8')); } catch { return null; }
}

/** A parsed object is an x402 challenge when it names version 1|2 and carries an accepts[] array. */
function asChallenge(o) {
  return o && typeof o === 'object' && (o.x402Version === 1 || o.x402Version === 2) && Array.isArray(o.accepts)
    ? o
    : null;
}

/**
 * Decode an HTTP 402 x402 challenge from its body text and/or its `payment-required` header.
 * Returns null when neither decodes; otherwise
 *   { body, header, accepts, x402Version, stub }
 * where `body`/`header` are each the decoded challenge or null, `accepts`/`x402Version` come from
 * the body when it decodes (else the header), and `stub` is true when either raw object carries
 * `_stub: true` (the okx-a2mcp [STUB] marker).
 */
export function decodeX402Challenge(bodyText, paymentRequiredHeader) {
  const rawBody = tryJson(bodyText);
  const rawHeader = tryBase64Json(paymentRequiredHeader);
  const body = asChallenge(rawBody);
  const header = asChallenge(rawHeader);
  const primary = body ?? header;
  if (!primary) return null;
  return {
    body,
    header,
    accepts: primary.accepts,
    x402Version: primary.x402Version,
    stub: rawBody?._stub === true || rawHeader?._stub === true,
  };
}

/** The atomic price of one accepts[] entry: `amount` (v2) ?? `maxAmountRequired` (v1), digits only; else null. */
export function acceptsEntryAtomic(entry) {
  const v = entry?.amount ?? entry?.maxAmountRequired;
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

/**
 * Leg B, one route. `status`/`bodyText`/`paymentRequiredHeader` come from GET /x402/<tool>.
 *   404                → { kind: 'skip' }                         (untouched pre-wave behaviour)
 *   non-402            → { kind: 'drift', drifts: [...] }         (untouched pre-wave behaviour)
 *   402, no price read → { kind: 'drift', drifts: [price_field_unreadable] }
 *   402, prices read   → { kind: 'compared', drifts: [one per mismatching entry] }
 * Prices are atomic 6-dp units (every served asset — USDC on Base and OP — is 6-dp), so /1e6.
 */
export function evaluateLegBRoute({ name, status, bodyText, paymentRequiredHeader, expectedUsd }) {
  if (status === 404) return { kind: 'skip', drifts: [] };
  if (status !== 402) return { kind: 'drift', drifts: [`/x402/${name} expected 402, got ${status}`] };
  const ch = decodeX402Challenge(bodyText, paymentRequiredHeader);
  const entries = ch?.accepts ?? [];
  const atomics = entries.map(acceptsEntryAtomic);
  if (entries.length === 0 || atomics.some((a) => a === null)) {
    return { kind: 'drift', drifts: [`/x402/${name} 402 has no readable price (reason=price_field_unreadable)`] };
  }
  const drifts = [];
  atomics.forEach((a, i) => {
    const usd = Number(a) / 1e6;
    if (Math.abs(usd - expectedUsd) > 1e-9) {
      const net = entries[i]?.network ?? `accepts[${i}]`;
      drifts.push(`/x402/${name} price $${usd} on ${net} != registry $${expectedUsd}`);
    }
  });
  return { kind: 'compared', drifts };
}

/** Leg B's one token: any disagreement ⇒ DISAGREE; zero routes compared ⇒ INDETERMINATE; else AGREE. */
export function legBVerdict({ compared, disagreements }) {
  if (disagreements > 0) return 'DISAGREE';
  if (compared === 0) return 'INDETERMINATE';
  return 'AGREE';
}

export const LEG_C_STUCK_MS = 30 * 60 * 1000;

/** The leg-C rails: paid HTTP rails are probed at their route prefix; ACP has no external surface (R-6). */
export const LEG_C_RAILS = [
  { rail: 'httpX402', prefix: '/x402' },
  { rail: 'a2mcp', prefix: '/a2mcp' },
  { rail: 'acp', prefix: null },
];

/** Canonical name of the first /capabilities entry declaring `rail` true, or null when none does. */
export function firstDeclaredCanonical(capsTools, rail) {
  const t = (capsTools ?? []).find((x) => x?.channels?.[rail] === true);
  return t ? (t.canonical ?? t.name) : null;
}

/**
 * Classify one leg-C probe. `status` null = no response (timeout / network error).
 * Returns { token: 'AGREE'|'DISAGREE'|'INDETERMINATE', reason }.
 */
export function classifyLegC({ status, bodyText, paymentRequiredHeader, railStateHeader, nowMs }) {
  if (status === null || status === undefined) return { token: 'INDETERMINATE', reason: 'no_response' };
  if (status === 402) {
    if (tryJson(bodyText)?._stub === true) return { token: 'DISAGREE', reason: 'stub' };
    const ch = decodeX402Challenge(bodyText, paymentRequiredHeader);
    if (ch?.stub) return { token: 'DISAGREE', reason: 'stub' };
    if (ch && (ch.body?.x402Version === 2 || ch.header)) return { token: 'AGREE', reason: 'served_402' };
    return { token: 'INDETERMINATE', reason: 'undecodable_402' };
  }
  if (status === 404) return { token: 'DISAGREE', reason: 'not_mounted' };
  if (status === 503) {
    const m = /^\s*initializing;\s*since=(\S+)\s*$/.exec(railStateHeader ?? '');
    const since = m ? Date.parse(m[1]) : NaN;
    if (!Number.isFinite(since)) return { token: 'INDETERMINATE', reason: 'http_503' };
    return nowMs - since > LEG_C_STUCK_MS
      ? { token: 'DISAGREE', reason: 'stuck_initializing' }
      : { token: 'INDETERMINATE', reason: 'initializing' };
  }
  return { token: 'INDETERMINATE', reason: `http_${status}` };
}

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
    // (d) a2mcp price DERIVES 1:1 from TOOL_PRICING (same product, same price every channel — Mr.1 R4 2026-06-30).
    const a2Price = okx.okxA2mcpPriceUsdt0(name);
    if (f?.x402 && a2Price !== f.x402.basePriceUsd) {
      drifts.push(`a2mcp price for ${name} (${a2Price}) != registry basePriceUsd (${f.x402.basePriceUsd}) — must derive 1:1 from TOOL_PRICING`);
    }
  }

  // 7. acp (Virtuals ACP untokenized seller) parity — P1-ACP-SELLER-SEED.
  //    (a) the OFFERED set DERIVES from the registry (offerings' canonical tools == registry acp set) —
  //        no hardcoded ACP tool list (single-derivation lock);
  //    (b) every acp tool is PRICED (x402!=null) — a paid ACP offering needs a setBudget price.
  const acpOfferings = await import(path.join(REPO_ROOT, 'dist', 'channels', 'acp', 'offerings.js'));
  const regAcp = FEATURE_REGISTRY.filter((f) => f.enabled && f.channels.acp).map((f) => f.name).sort();
  const offeredAcp = [...acpOfferings.acpOfferedTools()].sort();
  if (!eq(offeredAcp, regAcp)) {
    drifts.push(`acp offerings=[${offeredAcp}] != registry acp set=[${regAcp}] — every channels.acp tool needs exactly one offering`);
  }
  for (const name of regAcp) {
    if (!getFeature(name)?.x402) drifts.push(`acp tool ${name} is UNPRICED (x402:null) — a paid ACP offering needs a price`);
  }

  if (drifts.length === 0) {
    log(`STATIC in-sync ✅ — ${toolNames.length} tools, ${regHttpX402.length} gated x402 routes, ${regEvents.length} webhook events, ${regA2mcp.length} a2mcp tools, ${regAcp.length} acp offerings, projection clean`);
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

/** GET one leg-C route and classify it; a timeout or network error is INDETERMINATE (never a page). */
async function probeLegC(base, route) {
  try {
    const r = await fetch(`${base}${route}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const bodyText = await r.text().catch(() => '');
    return classifyLegC({
      status: r.status,
      bodyText,
      paymentRequiredHeader: r.headers.get('payment-required'),
      railStateHeader: r.headers.get('x-rail-state'),
      nowMs: Date.now(),
    });
  } catch (e) {
    log(`leg C ${route} probe failed (INDETERMINATE): ${e.message}`);
    return classifyLegC({ status: null });
  }
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

  // B. x402 price parity: each priced+httpX402 capability whose /x402 route 402s must match the
  //    price on EVERY accepts[] entry, read through the one decoder (v2 `amount`, v1 fallback).
  let legBCompared = 0;
  let legBDisagreements = 0;
  for (const t of capsTools) {
    if (!t.channels?.httpX402 || !t.x402) continue;
    try {
      const r = await fetch(`${base}/x402/${t.name}`, { method: 'GET', headers: { Accept: 'application/json' } });
      const bodyText = r.status === 402 ? await r.text() : '';
      const out = evaluateLegBRoute({
        name: t.name,
        status: r.status,
        bodyText,
        paymentRequiredHeader: r.headers.get('payment-required'),
        expectedUsd: t.x402.basePriceUsd,
      });
      if (out.kind === 'skip') continue; // 404: priced-but-not-gated — route-set is STATIC check's job
      if (out.kind === 'compared') legBCompared++;
      if (out.drifts.length > 0) { legBDisagreements++; drifts.push(...out.drifts); }
    } catch (e) {
      log(`/x402/${t.name} probe skipped (fail-open): ${e.message}`);
    }
  }
  console.log(`LEG_B price=${legBVerdict({ compared: legBCompared, disagreements: legBDisagreements })} compared=${legBCompared}`);

  // C. DECLARED vs SERVED — one line per rail; every DISAGREE joins the drifts.
  const legC = [];
  for (const { rail, prefix } of LEG_C_RAILS) {
    const tool = firstDeclaredCanonical(capsTools, rail);
    if (!tool) { legC.push({ rail, token: 'NOT_DECLARED', reason: 'declared_on_no_capability' }); continue; }
    if (!prefix) { legC.push({ rail, token: 'INDETERMINATE', reason: 'no_external_liveness_surface' }); continue; }
    legC.push({ rail, route: `${prefix}/${tool}`, ...(await probeLegC(base, `${prefix}/${tool}`)) });
  }
  if (simulateDrift) {
    const route = '/a2mcp/__leg_c_simulated__';
    legC.push({ rail: 'simulated', route, ...(await probeLegC(base, route)) });
    log('SIMULATE: leg C probes a route that cannot exist (expect LEG_C simulated=DISAGREE)');
  }
  for (const c of legC) {
    console.log(`LEG_C ${c.rail}=${c.token} reason=${c.reason}`);
    if (c.token === 'DISAGREE') {
      drifts.push(`LEG_C ${c.rail} declared on /capabilities but not served: GET ${c.route} → ${c.reason}`);
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
// Only when run as a program: the leg-B/leg-C classifiers above are imported by unit tests, and an
// import must never parse argv, hit the network or exit the test runner.
// Compared by REALPATH: Node resolves the main module through symlinks while argv[1] is as typed,
// so a plain string compare would turn a run from a symlinked checkout into a silent exit-0 no-op.
function sameFile(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}
const isMain = Boolean(process.argv[1]) && sameFile(process.argv[1], __filename);
if (isMain) {
  if (!checkMode && !liveMode) {
    fail('usage: check-feature-registry-drift.mjs (--check | --live <baseUrl> [--alert] [--simulate-drift])');
    process.exit(2);
  }
  if (liveMode) {
    await runLive(baseUrl);
  } else {
    await runStatic();
  }
}
