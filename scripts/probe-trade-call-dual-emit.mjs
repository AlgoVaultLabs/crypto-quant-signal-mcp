#!/usr/bin/env node
/**
 * probe-trade-call-dual-emit.mjs — verifies the v1.10.0 dual-emit invariant
 * end-to-end against the live MCP server.
 *
 * Asserts:
 *   1. `get_trade_call` returns a response containing BOTH `signal` AND `call`
 *      with the same value.
 *   2. `get_trade_signal` (alias) returns identical shape — signal === call.
 *   3. `/api/performance-public` exposes BOTH `totalSignals` AND `totalCalls`
 *      (equal values) AND BOTH `bySignalType` AND `byCallType` (deep-equal).
 *
 * Used by the C2 verification gate. Exits 0 + prints `DUAL_EMIT_OK` on pass;
 * exits 1 with diagnostic on fail.
 *
 * Targets `https://api.algovault.com` by default; override via env var
 * `MCP_BASE_URL` for local testing (e.g. `MCP_BASE_URL=http://127.0.0.1:3000`).
 *
 * Auth: free tier suffices for BTC/1h. If running locally without an admin
 * key, no env auth is needed; `Authorization` header is included opportunistically
 * via `MCP_API_KEY` env var if set.
 */
const BASE = process.env.MCP_BASE_URL || 'https://api.algovault.com';
const API_KEY = process.env.MCP_API_KEY || '';
const AUTH_HEADER = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};

function fail(msg) {
  console.error('DUAL_EMIT_FAIL: ' + msg);
  process.exit(1);
}

async function mcpInitAndCall(toolName, args) {
  // Step 1: initialize, capture mcp-session-id from response headers
  const initRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...AUTH_HEADER },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dual-emit-probe', version: '1.0' } },
      id: 1,
    }),
  });
  if (!initRes.ok) fail(`init HTTP ${initRes.status}`);
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) fail('no mcp-session-id header in init response');

  // Step 2: notify initialized (MCP protocol requires this before tool/call)
  await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sessionId, ...AUTH_HEADER },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  // Step 3: tools/call
  const callRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sessionId, ...AUTH_HEADER },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: toolName, arguments: args }, id: 2 }),
  });
  if (!callRes.ok) fail(`tools/call HTTP ${callRes.status}`);
  const raw = await callRes.text();
  // Response may be SSE-wrapped (data: …) or plain JSON
  let body;
  const m = raw.match(/data:\s*(\{.*\})/s);
  if (m) body = JSON.parse(m[1]);
  else body = JSON.parse(raw);
  if (body.error) fail(`tools/call error: ${JSON.stringify(body.error)}`);
  const txt = body?.result?.content?.[0]?.text;
  if (!txt) fail(`no result text for ${toolName}: ${JSON.stringify(body).slice(0, 300)}`);
  const inner = JSON.parse(txt);
  if (inner.error) fail(`tool ${toolName} returned error: ${inner.error}`);
  return inner;
}

async function main() {
  // Probe 1: get_trade_call
  const callRes = await mcpInitAndCall('get_trade_call', { coin: 'BTC', timeframe: '1h' });
  if (callRes.signal === undefined) fail(`get_trade_call response missing 'signal' field`);
  if (callRes.call === undefined) fail(`get_trade_call response missing 'call' field`);
  if (callRes.signal !== callRes.call) fail(`get_trade_call: signal (${callRes.signal}) !== call (${callRes.call})`);
  const tool = callRes._algovault?.tool;
  if (tool !== 'get_trade_call') fail(`get_trade_call _algovault.tool === '${tool}', expected 'get_trade_call'`);
  console.log(`  ✓ get_trade_call: signal=call=${callRes.call}, _algovault.tool=${tool}`);

  // Probe 2: get_trade_signal (alias)
  const aliasRes = await mcpInitAndCall('get_trade_signal', { coin: 'BTC', timeframe: '1h' });
  if (aliasRes.signal === undefined) fail(`get_trade_signal alias response missing 'signal' field`);
  if (aliasRes.call === undefined) fail(`get_trade_signal alias response missing 'call' field`);
  if (aliasRes.signal !== aliasRes.call) fail(`get_trade_signal: signal !== call`);
  // Note: _algovault.tool reports 'get_trade_call' regardless of which name was called (canonical reporting).
  console.log(`  ✓ get_trade_signal alias: signal=call=${aliasRes.call}, resolved to canonical handler`);

  // Probe 3: /api/performance-public dual-keys
  const perfRes = await fetch(`${BASE}/api/performance-public`);
  if (!perfRes.ok) fail(`/api/performance-public HTTP ${perfRes.status}`);
  const perf = await perfRes.json();
  if (perf.totalSignals === undefined) fail(`/api/performance-public missing 'totalSignals'`);
  if (perf.totalCalls === undefined) fail(`/api/performance-public missing 'totalCalls'`);
  if (perf.totalSignals !== perf.totalCalls) fail(`totalSignals (${perf.totalSignals}) !== totalCalls (${perf.totalCalls})`);
  if (!perf.bySignalType) fail(`/api/performance-public missing 'bySignalType'`);
  if (!perf.byCallType) fail(`/api/performance-public missing 'byCallType'`);
  if (JSON.stringify(perf.bySignalType) !== JSON.stringify(perf.byCallType)) {
    fail(`bySignalType !== byCallType`);
  }
  console.log(`  ✓ /api/performance-public: totalSignals=totalCalls=${perf.totalCalls}, bySignalType≡byCallType`);

  // v1.10.0 bucket fields present in indicators
  const ind = callRes.indicators || {};
  for (const k of ['trend_persistence', 'funding_state', 'breakout_pending']) {
    if (ind[k] === undefined) fail(`indicators.${k} missing in get_trade_call response`);
  }
  console.log(`  ✓ bucket fields populated: trend_persistence=${ind.trend_persistence}, funding_state=${ind.funding_state}, breakout_pending=${ind.breakout_pending}`);

  console.log('\nDUAL_EMIT_OK');
}

main().catch((e) => fail(`unhandled: ${e.message || e}`));
