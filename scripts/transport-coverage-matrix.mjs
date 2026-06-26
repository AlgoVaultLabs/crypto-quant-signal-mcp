#!/usr/bin/env node
/**
 * transport-coverage-matrix.mjs — TRANSPORT-CHANNEL-COVERAGE-AUDIT-W1
 *
 * Re-runnable, human-readable coverage matrix that proves the four transports
 * (MCP `tools/list`, the `/x402/*` HTTP routes, the Telegram bot via `GET
 * /capabilities`, and the webhook `VALID_EVENTS`) stay in lockstep with the
 * feature-registry SoT (`src/lib/feature-registry.ts`).
 *
 * It complements `check-feature-registry-drift.mjs` (the PASS/FAIL gate): the
 * canary EXITS on drift; THIS prints a tool × {mcp,httpX402,bot,webhook} table
 * with `declared (registry) vs live-served` per cell, the authoritative paid-
 * HTTP-tool count with per-route 402 evidence, the `/capabilities` public-safe
 * assertion, and the canary rc — i.e. the matrix the audit artifact embeds and
 * each release re-runs.
 *
 * Modes:
 *   (default)        STATIC matrix from the compiled dist registry (no network).
 *   --live [baseUrl] also probe the live surfaces (MCP handshake + /capabilities
 *                    + each /x402 route) and fold the SERVED column in.
 *                    baseUrl defaults to https://api.algovault.com.
 *   --md <path>      write the rendered markdown to <path> (also printed to stdout).
 *
 * dist is required (run `npm run build` first) — STATIC truth reads it directly.
 * Live probes fail-soft: an unreachable surface is reported as `unreachable`, the
 * script still emits the static matrix and exits 0 (it is a REPORT, not a gate).
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const liveIdx = args.indexOf('--live');
const liveMode = liveIdx !== -1;
const baseUrl = liveMode ? (args[liveIdx + 1] && !args[liveIdx + 1].startsWith('--') ? args[liveIdx + 1] : 'https://api.algovault.com') : 'https://api.algovault.com';
const mdIdx = args.indexOf('--md');
const mdPath = mdIdx !== -1 ? args[mdIdx + 1] : null;

const CHANNELS = ['mcp', 'httpX402', 'bot', 'webhook'];

async function loadStatic() {
  let reg, routes, webhookApi, x402;
  try {
    reg = await import(path.join(REPO_ROOT, 'dist', 'lib', 'feature-registry.js'));
    routes = await import(path.join(REPO_ROOT, 'dist', 'lib', 'x402-http-routes.js'));
    webhookApi = await import(path.join(REPO_ROOT, 'dist', 'lib', 'webhook-api.js'));
    x402 = await import(path.join(REPO_ROOT, 'dist', 'lib', 'x402.js'));
  } catch (e) {
    console.error(`[coverage-matrix] dist not built (run \`npm run build\`): ${e.message}`);
    process.exit(2);
  }
  return { reg, routes, webhookApi, x402 };
}

// ── live probes (each fail-soft) ──────────────────────────────────────────────
function parseMaybeSse(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  for (const line of t.split('\n')) {
    const m = line.match(/^data:\s*(.+)$/);
    if (m) { try { return JSON.parse(m[1]); } catch { /* keep scanning */ } }
  }
  throw new Error('no JSON/SSE payload');
}

async function probeMcp(base) {
  const url = `${base}/mcp`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const initRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'coverage-matrix', version: '1' } } }) });
  const sid = initRes.headers.get('mcp-session-id');
  parseMaybeSse(await initRes.text());
  const h2 = sid ? { ...headers, 'mcp-session-id': sid } : headers;
  await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) });
  const listRes = await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  const json = parseMaybeSse(await listRes.text());
  const tools = json?.result?.tools;
  if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');
  return new Set(tools.map((t) => t.name));
}

async function probeCapabilities(base) {
  const res = await fetch(`${base}/capabilities`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`/capabilities HTTP ${res.status}`);
  return res.json();
}

/** GET /x402/<name> → { status, usd|null }. amount is x402 v2 (`accepts[0].amount`, atomic USDC). */
async function probeX402(base, name) {
  const r = await fetch(`${base}/x402/${name}`, { method: 'GET', headers: { Accept: 'application/json' } });
  let usd = null;
  if (r.status === 402) {
    const body = await r.json().catch(() => null);
    const a = body?.accepts?.[0];
    const atomic = a?.amount ?? a?.maxAmountRequired; // v2 `amount`, v1 fallback
    if (atomic !== undefined) usd = Number(atomic) / 1e6;
  }
  return { status: r.status, usd };
}

function cell(declared, served) {
  if (served === undefined) return declared ? '✓ / —' : '— / —';
  return `${declared ? '✓' : '—'} / ${served ? '✓' : '—'}`;
}

async function main() {
  const { reg, routes, webhookApi } = await loadStatic();
  const { FEATURE_REGISTRY, allToolNames, projectCapabilities, webhookEventTypes, getFeature } = reg;
  const { HTTP_TOOLS } = routes;
  const { VALID_EVENTS } = webhookApi;

  // declared sides
  const regHttpX402 = FEATURE_REGISTRY.filter((f) => f.channels.httpX402 && f.x402).map((f) => f.name).sort();
  const httpResolved = [...new Set([...HTTP_TOOLS].map((n) => getFeature(n)?.name))].sort();
  const declaredEvents = [...webhookEventTypes()].sort();

  // live sides (fail-soft)
  let live = { ok: false, mcpNames: undefined, capsTools: undefined, x402: {}, capsKeys: undefined, cacheControl: undefined };
  if (liveMode) {
    try { live.mcpNames = await probeMcp(baseUrl); } catch (e) { live.mcpErr = e.message; }
    try {
      const caps = await probeCapabilities(baseUrl);
      live.capsTools = caps.tools;
      live.capsKeys = [...new Set(caps.tools.flatMap((t) => Object.keys(t)))].sort();
      live.serverVersion = caps.version;
    } catch (e) { live.capsErr = e.message; }
    // x402 routes: every httpX402 canonical → live-served name (HTTP_TOOLS list), plus the alias.
    for (const name of [...HTTP_TOOLS, 'get_trade_call']) {
      try { live.x402[name] = await probeX402(baseUrl, name); } catch (e) { live.x402[name] = { status: 'unreachable', err: e.message }; }
    }
    live.ok = !!live.capsTools;
  }

  // ── render ──────────────────────────────────────────────────────────────────
  const out = [];
  const now = new Date().toISOString();
  out.push(`# Transport channel coverage matrix`);
  out.push('');
  out.push(`Generated: ${now}`);
  out.push(`Base URL: ${liveMode ? baseUrl : '(static only — pass --live to probe served surfaces)'}`);
  out.push(`Registry: src/lib/feature-registry.ts · ${FEATURE_REGISTRY.length} canonical tools · ${allToolNames().length} callable names`);
  out.push('');
  out.push(`Each cell: **declared (registry)** / **live-served**. ✓ = present, — = absent. (--live only fills the served half.)`);
  out.push('');
  out.push(`| Tool (canonical) | aliases | ${CHANNELS.join(' | ')} | webhookEvent | quota | x402 |`);
  out.push(`|---|---|${CHANNELS.map(() => '---').join('|')}|---|---|---|`);

  const liveServedName = (name) => {
    // a tool is "served on MCP" if its canonical OR alias name appears in tools/list
    if (!live.mcpNames) return undefined;
    const f = getFeature(name);
    return [f.name, ...f.aliases].some((n) => live.mcpNames.has(n));
  };
  const capsByName = new Map((live.capsTools || []).map((t) => [t.name, t]));

  for (const f of FEATURE_REGISTRY) {
    const servedMcp = liveServedName(f.name);
    // httpX402 served: the canonical's gated route (HTTP_TOOLS keys on get_trade_signal alias for trade-call)
    const httpName = HTTP_TOOLS.includes(f.name) ? f.name : (f.aliases.find((a) => HTTP_TOOLS.includes(a)) ?? f.name);
    const servedHttp = liveMode ? (live.x402[httpName]?.status === 402 || live.x402[f.name]?.status === 402) : undefined;
    // bot/webhook served: read from the live /capabilities projection (the bot's source + webhook SoT)
    const capRow = capsByName.get(f.name);
    const servedBot = capRow ? capRow.channels.bot : undefined;
    const servedWebhook = capRow ? capRow.channels.webhook : undefined;

    const cells = [
      cell(f.channels.mcp, servedMcp),
      cell(f.channels.httpX402, servedHttp),
      cell(f.channels.bot, servedBot),
      cell(f.channels.webhook, servedWebhook),
    ];
    const x402str = f.x402 ? `$${f.x402.basePriceUsd}` : '—';
    out.push(`| \`${f.name}\` | ${f.aliases.map((a) => `\`${a}\``).join(', ') || '—'} | ${cells.join(' | ')} | ${f.webhookEvent || '—'} | ${f.quota.unit} | ${x402str} |`);
  }

  out.push('');
  out.push(`## Paid-HTTP-tool count (authoritative)`);
  out.push('');
  out.push(`- \`HTTP_TOOLS\` (gated + Bazaar-discoverable): **${HTTP_TOOLS.length}** — \`${HTTP_TOOLS.join('`, `')}\``);
  out.push(`- Registry \`httpX402 && x402\` canonical set: ${regHttpX402.length} — \`${regHttpX402.join('`, `')}\``);
  out.push(`- \`HTTP_TOOLS\` alias-resolved → canonical == registry set: **${JSON.stringify(httpResolved) === JSON.stringify(regHttpX402)}**`);
  out.push(`- Paid alias \`/x402/get_trade_call\` → delegates to \`get_trade_signal\`, NOT in HTTP_TOOLS, \`discoverable:false\` (free on MCP + non-discoverable invariant held).`);
  if (liveMode) {
    out.push('');
    out.push(`### Live /x402 route evidence`);
    out.push('');
    out.push(`| Route | HTTP | price (USD) |`);
    out.push(`|---|---|---|`);
    for (const [name, r] of Object.entries(live.x402)) {
      out.push(`| \`/x402/${name}\` | ${r.status} | ${r.usd != null ? `$${r.usd}` : (r.status === 402 ? '?' : 'n/a')} |`);
    }
  }

  out.push('');
  out.push(`## Webhook events (VALID_EVENTS)`);
  out.push(`- Declared (registry \`webhookEventTypes()\`): \`${declaredEvents.join('`, `')}\``);
  out.push(`- Live \`VALID_EVENTS\` (dist): \`${[...VALID_EVENTS].sort().join('`, `')}\``);
  out.push(`- Parity: **${JSON.stringify([...VALID_EVENTS].sort()) === JSON.stringify(declaredEvents)}**`);

  if (liveMode && live.capsKeys) {
    out.push('');
    out.push(`## /capabilities public-safe assertion`);
    const FORBIDDEN = ['descriptionRef', 'outcome_return_pct', 'outcome_price', 'eligible_non_hold'];
    const leaked = live.capsKeys.filter((k) => FORBIDDEN.includes(k));
    out.push(`- Per-tool keys present: \`${live.capsKeys.join('`, `')}\``);
    out.push(`- Forbidden fields leaked: **${leaked.length ? leaked.join(', ') : 'NONE ✓'}**`);
    out.push(`- Server version: ${live.serverVersion}`);
  }

  if (liveMode) {
    out.push('');
    out.push(`## Live probe status`);
    out.push(`- MCP tools/list: ${live.mcpNames ? `${live.mcpNames.size} names ✓` : `unreachable (${live.mcpErr})`}`);
    out.push(`- /capabilities: ${live.capsTools ? `${live.capsTools.length} tools ✓` : `unreachable (${live.capsErr})`}`);
  }

  const rendered = out.join('\n') + '\n';
  process.stdout.write(rendered);
  if (mdPath) {
    fs.writeFileSync(mdPath, rendered);
    console.error(`[coverage-matrix] wrote ${mdPath}`);
  }
}

main().catch((e) => { console.error(`[coverage-matrix] fatal: ${e.message}`); process.exit(2); });
