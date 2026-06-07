#!/usr/bin/env node
/**
 * PoC — X402-02: verify-time replay window (no server-side idempotency).
 *
 * SELF-CONTAINED. Imports NOTHING from src/. Models the verify/settle lifecycle of
 * src/lib/x402.ts + the call sites in index.ts:2196 and x402-http-routes.ts:202.
 *
 * FACTS (from source reads, cited):
 *  - verifyX402Payment (x402.ts:215-258) is STATELESS: it keeps no record of which
 *    payment payloads it has already accepted (the only Map is `toolRequirements`,
 *    used for matching, not dedup). The @x402/core server verify is likewise
 *    stateless (delegates to the facilitator).
 *  - settleX402Async (x402.ts:266-284) is FIRE-AND-FORGET: both call sites invoke it
 *    AFTER res.json(...) has been sent (index.ts:2196-2200; x402-http-routes.ts:198+203).
 *  - The only nonce-consuming step is the on-chain transferWithAuthorization at
 *    SETTLE (the ERC-3009 nonce is burned on-chain). The facilitator's verify
 *    (@x402/evm exact/facilitator verifyEIP3009) simulates the transfer, so once the
 *    nonce is consumed on-chain a replay FAILS verify — BUT only AFTER settle lands.
 *
 * CONSEQUENCE: between the first verify-pass and the first on-chain settle-confirm
 * (~2s per x402.ts header doc), the SAME X-PAYMENT header replayed concurrently
 * passes verify every time → N paid resources served, ONE on-chain charge.
 *
 * This PoC models the lifecycle with a fake stateless verifier + an async settle that
 * consumes the nonce after a delay, and shows N concurrent replays all served before
 * the nonce is burned. It moves no funds and contacts no network.
 *
 * Run:  node audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/x402-replay-window.mjs
 */

// On-chain nonce ledger (what the blockchain knows). Starts empty.
const consumedNonces = new Set();

// Facilitator verify: passes iff the nonce is NOT yet consumed on-chain (models
// simulateEip3009Transfer succeeding while the authorization is still spendable).
// STATELESS at our layer — there is no "already verified this header" memory.
function facilitatorVerify(payment) {
  const consumed = consumedNonces.has(payment.nonce);
  return { isValid: !consumed }; // consumed nonce → simulate reverts → invalid
}

// settleX402Async modeled: fire-and-forget; consumes the nonce on-chain after `settleMs`.
function settleAsync(payment, settleMs) {
  setTimeout(() => { consumedNonces.add(payment.nonce); }, settleMs);
}

// One request as the server handles it: verify → (serve) → fire-and-forget settle.
function handleRequest(payment, settleMs) {
  const v = facilitatorVerify(payment);
  if (!v.isValid) return { served: false };
  // resource is served HERE (res.json) ...
  settleAsync(payment, settleMs); // ... settle fires AFTER, async
  return { served: true };
}

async function main() {
  const SETTLE_MS = 2000;            // ~2s settle latency (x402.ts doc)
  const REPLAYS = 20;                // attacker fires 20 concurrent replays of ONE proof
  const payment = { nonce: '0xdeadbeefcafef00d', value: '20000' }; // one valid $0.02 proof

  console.log('=== X402-02 PoC: verify-time replay window (no idempotency store) ===\n');
  console.log(`Attacker holds ONE valid X-PAYMENT proof (nonce=${payment.nonce}, $0.02).`);
  console.log(`Fires ${REPLAYS} concurrent copies within the ~${SETTLE_MS}ms settle window.\n`);

  // All replays arrive before the first settle consumes the nonce on-chain.
  let served = 0;
  for (let i = 0; i < REPLAYS; i++) {
    if (handleRequest(payment, SETTLE_MS).served) served++;
  }

  console.log(`Within the settle window: ${served}/${REPLAYS} replays SERVED a paid resource.`);
  const onchainBefore = consumedNonces.size;
  console.log(`On-chain charges queued so far: nonce consumed yet? ${onchainBefore > 0 ? 'yes' : 'no (settle still pending)'}`);

  // Let settle land (nonce burned on-chain), then prove a LATER replay is rejected.
  await new Promise((r) => setTimeout(r, SETTLE_MS + 200));
  const afterSettle = handleRequest(payment, SETTLE_MS);
  console.log(`\nAfter settle lands (nonce burned on-chain): replay served? ${afterSettle.served} (expected false).`);

  const exploitable = served > 1 && afterSettle.served === false;
  console.log(`\nNet: ${served} paid resources served for 1 on-chain charge ($0.02). Replay is BOUNDED to the`);
  console.log(`pre-first-settle window, but UNBOUNDED in count within it (no per-payment idempotency claim).`);
  console.log(`\n=== RESULT:`, exploitable ? 'REPLAY WINDOW CONFIRMED ===' : 'inconclusive ===');
  process.exit(exploitable ? 0 : 1);
}
main();
