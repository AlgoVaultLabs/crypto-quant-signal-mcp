#!/usr/bin/env node
/**
 * OPS-MCP-SESSION-RESILIENCE-W1 — post-deploy live canary for the stateless /mcp transport.
 *
 * Asserts the remote transport is STATELESS, i.e. the post-deploy session-death bug class is
 * structurally gone:
 *   1. `initialize` issues NO Mcp-Session-Id (a session id ⇒ stateful regression).
 *   2. `tools/list` with no session id ⇒ 200 with ≥1 tool.
 *   3. a random STALE Mcp-Session-Id is IGNORED ⇒ 200, not an error (the bug-class probe —
 *      under the old stateful path this returned 400 / -32000 "Server not initialized").
 *
 * Exit 0 = stateless/healthy OR endpoint unreachable (FAIL-OPEN — never pages on a transient
 * network blip). Exit 1 = stateful regression. No Telegram path here.
 *
 * OWNER — corrected by OPS-AUDIT-REMEDIATION-HIGH-W1 (SEC-21 / SEC-34). This header used to claim
 * that "the existing security / feature-registry canary cadence that invokes this script owns
 * escalation". No such cadence invoked it: the script was committed and run by NOTHING, and the
 * owner it named did not exist, so the escalation chain was empty end to end. Its real owner is
 * now a POST-DEPLOY step in .github/workflows/deploy.yml — the step runs right after the deploy
 * that could regress statelessness, and stays fail-open per this script's own exit contract.
 *
 * Usage:
 *   node scripts/check-mcp-stateless.mjs              # probe prod (api.algovault.com/mcp)
 *   MCP_ENDPOINT=https://host/mcp node scripts/check-mcp-stateless.mjs
 *   node scripts/check-mcp-stateless.mjs --selftest   # offline: prove the evaluator flags a
 *                                                      # synthetic stateful regression (AC8)
 */

const EP = process.env.MCP_ENDPOINT || 'https://api.algovault.com/mcp';
const TIMEOUT_MS = Number(process.env.MCP_CANARY_TIMEOUT_MS || 20000);
const ACCEPT = 'application/json, text/event-stream';

/**
 * Pure evaluator — given the three observed responses, return the list of regressions.
 * Exported shape kept simple so --selftest can exercise it with synthetic inputs.
 */
export function evaluateStateless({ initSid, initStatus, listStatus, nTools, staleStatus, staleError }) {
  const failures = [];
  if (initSid) failures.push(`initialize issued Mcp-Session-Id=${initSid} (STATEFUL regression)`);
  if (initStatus !== 200) failures.push(`initialize status ${initStatus} != 200`);
  if (listStatus !== 200 || !(nTools >= 1)) failures.push(`tools/list (no session) status=${listStatus} tools=${nTools}`);
  if (staleStatus !== 200 || staleError) {
    failures.push(`stale Mcp-Session-Id rejected: status=${staleStatus} err=${JSON.stringify(staleError)} (STATEFUL regression — the post-deploy session-death class)`);
  }
  return failures;
}

function parseSse(text) {
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
}

async function rpc(headers, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(EP, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT, ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = parseSse(text); } catch { /* non-JSON body */ }
    return { status: r.status, sid: r.headers.get('mcp-session-id'), json };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  if (process.argv.includes('--selftest')) {
    // Synthetic STATEFUL response set — the evaluator MUST flag it (proves the canary can fail).
    const bad = evaluateStateless({ initSid: 'abc-123', initStatus: 200, listStatus: 200, nTools: 9, staleStatus: 400, staleError: { code: -32000, message: 'Server not initialized' } });
    const good = evaluateStateless({ initSid: null, initStatus: 200, listStatus: 200, nTools: 9, staleStatus: 200, staleError: null });
    if (bad.length >= 2 && good.length === 0) {
      console.log('[mcp-stateless-canary] selftest OK — evaluator flags stateful regression, passes stateless');
      process.exit(0);
    }
    console.error('[mcp-stateless-canary] selftest FAILED', { bad, good });
    process.exit(1);
  }

  let init, list, stale;
  try {
    init = await rpc({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stateless-canary', version: '1.0' } } });
    list = await rpc({}, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    stale = await rpc({ 'Mcp-Session-Id': '00000000-0000-4000-8000-000000000000' }, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  } catch (e) {
    console.log(`[mcp-stateless-canary] FAIL-OPEN: ${EP} unreachable (${e && e.message ? e.message : e}) — exit 0`);
    process.exit(0);
  }

  const nTools = list.json && list.json.result && Array.isArray(list.json.result.tools) ? list.json.result.tools.length : 0;
  const failures = evaluateStateless({
    initSid: init.sid, initStatus: init.status,
    listStatus: list.status, nTools,
    staleStatus: stale.status, staleError: stale.json && stale.json.error,
  });

  if (failures.length) {
    console.error(`[mcp-stateless-canary] REGRESSION on ${EP}:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[mcp-stateless-canary] OK — stateless on ${EP} (no session id issued; stale id ignored; ${nTools} tools)`);
  process.exit(0);
}

main();
