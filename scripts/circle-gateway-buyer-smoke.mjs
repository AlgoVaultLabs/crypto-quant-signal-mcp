#!/usr/bin/env node
/**
 * CIRCLE-GATEWAY-FLIP-SMOKE-W1 R3 — Circle Gateway BUYER smoke (OP Mainnet, live prod).
 *
 * OPERATOR-RUN ONLY. This script spends REAL money (deposits ~1 USDC + a little OP-Mainnet
 * ETH gas, then pays a $0.02 tool call). Claude generated it and never sees the buyer key.
 *
 * Proven flow, adapted from tests/integration/circle-gateway-testnet.test.ts (Base Sepolia) to
 * OP Mainnet + the live endpoint. Uses Circle's own client SDK (@circle-fin/x402-batching/client),
 * which wraps the EIP-712 signing against the GatewayWalletBatched domain and emits the x402-v2
 * `Payment-Signature` header the server was taught to read (OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1).
 *
 *   getBalances()  ->  deposit("1") if the Gateway balance is short  ->  pay()  ->  settlement id
 *
 * WHERE THE SETTLEMENT ID COMES FROM — read this, it is NOT what a naive read of x402 suggests.
 * Production sends the 200 tool result FIRST and then settles FIRE-AND-FORGET
 * (src/lib/x402-http-routes.ts:321-327), so the paid HTTP response carries NO PAYMENT-RESPONSE
 * header and `pay().transaction` is EMPTY. The settlement id is Circle's transfer id, which appears
 * a moment later via searchTransfers(). This script polls for it.
 *
 * EVERY VERDICT SETTLES, HOLD INCLUDED — since PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 CH5
 * (`fdaf659`, live on prod 2026-08-09 08:32 UTC). Both rails used to carry their own copy of a
 * `verdict !== 'HOLD'` settle guard; neither does now (src/index.ts + src/lib/x402-http-routes.ts),
 * so a HOLD is a chargeable call like any other and this script asserts the settlement on EVERY
 * verdict. There is no longer any verdict for which "HTTP 200 and no settlement id" is an EXPECTED
 * outcome, so it is never explained by a HOLD and never a reason to re-roll — investigate it. (It
 * can still be a timing miss: settle is fire-and-forget and Circle batches, which is why the tail
 * branch below warns and hands you a poll command instead of asserting a hard failure at 3 min.)
 *
 * The retired path left a fingerprint worth knowing when you read old rows: a pre-CH5 HOLD
 * CLAIMED the nonce and then never moved the money, so it persists as
 * `processed_x402_payments.settlement_state='CLAIMED_UNSETTLED'`. All 7 x402 `get_trade_signal`
 * calls ever made are exactly that (measured 2026-08-10). They are history, not a live defect.
 *
 * ── RUN ─────────────────────────────────────────────────────────────────────────────────────
 *   Put the buyer key OUTSIDE any git repo (mode 600):
 *     mkdir -p ~/.config/algovault && printf 'BUYER_PRIVATE_KEY=0x<key>\n' > ~/.config/algovault/circle-buyer.env && chmod 600 ~/.config/algovault/circle-buyer.env
 *   Then, from the repo root (so the SDK resolves):
 *     node scripts/circle-gateway-buyer-smoke.mjs
 *
 * Optional env overrides:
 *   BUYER_PRIVATE_KEY        key inline (else read from BUYER_ENV_FILE)
 *   BUYER_ENV_FILE           default ~/.config/algovault/circle-buyer.env
 *   SMOKE_TOOL               default get_trade_signal  (get_market_regime / scan_trade_calls always charge)
 *   SMOKE_BODY               default {"coin":"BTC","timeframe":"1h"}
 *   OP_RPC_URL               custom OP-Mainnet RPC (default: SDK's public RPC; override if rate-limited)
 *   DEPOSIT_USDC             deposit CEILING, default "1" (auto-capped at your wallet balance — only the ~$0.02 price must be covered; the deposit is withdrawable later)
 *   DEPOSIT_CREDIT_BUDGET_MIN default 40  (deposit credits only after finality — tens of minutes)
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '@circle-fin/x402-batching/client';

// ── Constants (all PUBLIC — no secrets here) ──────────────────────────────────────────────────
const CHAIN = 'optimism';                // OP Mainnet (eip155:10) — collision-free vs CDP's eip155:8453
const SELLER = '0x11447b963c1408E7c84868314eF2fe9304768717'; // Gateway seller (receives the credit)
const EXPECTED_BUYER = '0x7DA6DE194fED97fB745137FADDde5699AFe37A45'; // operator's funded buyer EOA
const TOOL = process.env.SMOKE_TOOL || 'get_trade_signal';
const BODY = JSON.parse(process.env.SMOKE_BODY || '{"coin":"BTC","timeframe":"1h"}');
const URL = `https://api.algovault.com/x402/${TOOL}`;
const DEPOSIT_USDC = process.env.DEPOSIT_USDC || '1';
const CREDIT_BUDGET_MS = Number(process.env.DEPOSIT_CREDIT_BUDGET_MIN || 40) * 60_000;
// Tools whose response carries a `.call` verdict. `/x402/get_trade_call` is a paid ALIAS route
// that delegates to get_trade_signal's handler (x402-http-routes.ts:335), so BOTH return the
// trade-call shape. This is a DISPLAY set — it decides what the `verdict` line prints, and waives
// nothing. (Its predecessor, HOLD_WAIVING_TOOLS, named the same two tools but skipped the
// settlement assertion on a HOLD; retired by OPS-X402-SMOKE-HOLD-WAIVER-RETIRE-W1.)
const VERDICT_BEARING_TOOLS = new Set(['get_trade_signal', 'get_trade_call']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (atomic) => (Number(atomic) / 1e6).toFixed(6);
const eth = (wei) => (Number(wei) / 1e18).toFixed(6);
const line = () => console.log('─'.repeat(78));

// ── Load the buyer key (never printed) ────────────────────────────────────────────────────────
function loadBuyerKey() {
  if (process.env.BUYER_PRIVATE_KEY) return process.env.BUYER_PRIVATE_KEY.trim();
  const f = process.env.BUYER_ENV_FILE || join(homedir(), '.config', 'algovault', 'circle-buyer.env');
  if (!existsSync(f)) {
    console.error(`✖ No key. Set BUYER_PRIVATE_KEY, or create ${f} with a line:  BUYER_PRIVATE_KEY=0x...`);
    process.exit(2);
  }
  const kv = Object.fromEntries(
    readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
  if (!kv.BUYER_PRIVATE_KEY) { console.error(`✖ ${f} has no BUYER_PRIVATE_KEY=… line`); process.exit(2); }
  return kv.BUYER_PRIVATE_KEY;
}

async function main() {
  line();
  console.log('Circle Gateway BUYER smoke — OP Mainnet (eip155:10) — LIVE prod');
  console.log(`tool=${TOOL}  url=${URL}  body=${JSON.stringify(BODY)}`);
  line();

  const buyer = new GatewayClient({
    chain: CHAIN,
    privateKey: loadBuyerKey(),
    ...(process.env.OP_RPC_URL ? { rpcUrl: process.env.OP_RPC_URL } : {}),
  });

  console.log(`buyer address : ${buyer.address}`);
  // HARD EXIT, not a warning. On 2026-07-29 this script was run with the SELLER's key: the
  // derived address equalled the advertised payTo, Circle rejected the burn intent
  // `self_transfer` (its code for sender == recipient), and the failure was indistinguishable
  // from a server-side payment bug — it cost a full diagnostic cycle. A smoke script that
  // silently signs with the wrong key is worse than one that refuses to run.
  if (buyer.address.toLowerCase() !== EXPECTED_BUYER.toLowerCase()) {
    const msg = `derived buyer ${buyer.address} ≠ expected ${EXPECTED_BUYER}`;
    if (!process.env.ALLOW_UNEXPECTED_BUYER) {
      console.error(`✖ ${msg}`);
      console.error('  BUYER_PRIVATE_KEY is not the funded buyer key.');
      console.error(`  If it is the SELLER key (${SELLER}), Circle rejects the payment as \`self_transfer\`.`);
      console.error('  Fix the key, or set ALLOW_UNEXPECTED_BUYER=1 to proceed deliberately.');
      process.exit(2);
    }
    console.warn(`⚠ ${msg} — continuing (ALLOW_UNEXPECTED_BUYER=1).`);
  }
  console.log(`chainConfig   : usdc=${buyer.chainConfig.usdc} gatewayWallet=${buyer.chainConfig.gatewayWallet}`);

  // Authoritative price/payTo: read the live 402's Gateway (eip155:10) entry directly.
  const chal = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) });
  if (chal.status !== 402) { console.error(`✖ expected 402 from ${URL}, got ${chal.status} — is the route mounted?`); process.exit(1); }
  const gw = ((await chal.json()).accepts || []).find((a) => a.network === 'eip155:10' && a.extra?.name === 'GatewayWalletBatched');
  if (!gw) {
    console.error(`✖ ${URL} advertises no Gateway (eip155:10 / GatewayWalletBatched) option — R1/R2 must be green (CIRCLE_GATEWAY_ENABLED=true) first.`);
    process.exit(1);
  }
  const priceAtomic = BigInt(gw.amount);
  console.log(`gateway price : ${usd(priceAtomic)} USDC  payTo=${gw.payTo}`);
  if ((gw.payTo || '').toLowerCase() !== SELLER.toLowerCase()) {
    console.warn(`⚠ advertised payTo ${gw.payTo} ≠ expected seller ${SELLER}`);
  }
  // Structural `self_transfer` guard — compares against the LIVE advertised payTo, so it holds
  // even if the EXPECTED_BUYER/SELLER constants above ever drift. Deliberately has NO override:
  // a burn intent whose sender IS the recipient can never settle.
  if (buyer.address.toLowerCase() === (gw.payTo || '').toLowerCase()) {
    console.error(`✖ buyer ${buyer.address} IS the advertised payTo — Circle rejects this as \`self_transfer\`.`);
    console.error('  You are signing with the seller key. Use the BUYER key.');
    process.exit(2);
  }

  // ── balances + gas ──
  let bal = await buyer.getBalances();
  const gasWei = await buyer.publicClient.getBalance({ address: buyer.address });
  console.log(`wallet USDC   : ${bal.wallet.formatted}`);
  console.log(`gateway avail : ${bal.gateway.formattedAvailable}`);
  console.log(`native ETH    : ${eth(gasWei)} (needed only for deposit; pay() is gasless)`);

  // ── deposit if the Gateway balance is short ──
  if (bal.gateway.available < priceAtomic) {
    if (gasWei === 0n) { console.error('✖ buyer has 0 OP-Mainnet ETH — deposit() is an on-chain tx and needs gas.'); process.exit(1); }
    // Only the PRICE must be covered. Deposit up to DEPOSIT_USDC (a ceiling, default 1) but never
    // more than the wallet holds — so a wallet with a little under the ceiling still works.
    if (bal.wallet.balance < priceAtomic) {
      console.error(`✖ buyer wallet USDC ${bal.wallet.formatted} < price ${usd(priceAtomic)} — fund it with OP-Mainnet USDC.`); process.exit(1);
    }
    const ceilingAtomic = BigInt(Math.round(Number(DEPOSIT_USDC) * 1e6));
    const depositStr = bal.wallet.balance <= ceilingAtomic ? bal.wallet.formatted : DEPOSIT_USDC;
    const depositAtomic = bal.wallet.balance <= ceilingAtomic ? bal.wallet.balance : ceilingAtomic;
    // If USDC is ALREADY approved for the GatewayWallet, deposit is a SINGLE tx. Skipping the
    // approve avoids the approve→deposit nonce race that public OP RPCs hit (they serve a stale
    // nonce for the 2nd tx). A re-run after a failed first deposit lands here — the approve is
    // already mined — so it just sends the deposit at the correct nonce.
    let skipApprovalCheck = false;
    try {
      const allowance = await buyer.publicClient.readContract({
        address: buyer.chainConfig.usdc,
        abi: [{ name: 'allowance', type: 'function', stateMutability: 'view',
                inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'allowance',
        args: [buyer.address, buyer.chainConfig.gatewayWallet],
      });
      skipApprovalCheck = allowance >= depositAtomic;
      console.log(`  USDC allowance=${usd(allowance)} → ${skipApprovalCheck ? 'already approved → deposit-only (avoids the nonce race)' : 'will approve + deposit'}`);
    } catch { /* allowance read is best-effort; fall through to normal approve+deposit */ }
    console.log(`\n→ depositing ${depositStr} USDC into the GatewayWallet (on-chain${skipApprovalCheck ? ', deposit only' : ': approve + deposit'}; withdrawable later)…`);
    const dep = await buyer.deposit(depositStr, skipApprovalCheck ? { skipApprovalCheck: true } : {});
    console.log(`  approvalTx=${dep.approvalTxHash ?? '(already approved)'}  depositTx=${dep.depositTxHash}`);
    console.log('  ⏳ Gateway credits a deposit only after block FINALITY (tens of minutes). Polling…');
    const deadline = Date.now() + CREDIT_BUDGET_MS;
    while (bal.gateway.available < priceAtomic && Date.now() < deadline) {
      await sleep(20_000);
      bal = await buyer.getBalances();
      console.log(`  … gateway available=${bal.gateway.formattedAvailable} (need ${usd(priceAtomic)}; ~${Math.round((deadline - Date.now()) / 60_000)}m budget left)`);
    }
    if (bal.gateway.available < priceAtomic) {
      console.error(`✖ deposit not yet credited within budget. The USDC left your wallet (depositTx above) — re-run this script later; it resumes once credited.`);
      process.exit(3);
    }
    console.log(`  ✓ credited. gateway available=${bal.gateway.formattedAvailable}`);
  }

  // ── snapshot transfers + balance BEFORE pay (to identify the new settlement + prove the debit) ──
  const beforeIds = new Set(((await buyer.searchTransfers({ from: buyer.address }).catch(() => ({ transfers: [] }))).transfers || []).map((t) => t.id));
  const availBefore = bal.gateway.available;

  // ── PAY ──
  console.log(`\n→ paying ${URL} …`);
  let pay;
  try {
    pay = await buyer.pay(URL, { method: 'POST', body: BODY });
  } catch (err) {
    console.error(`✖ pay() threw: ${err?.message ?? err}`);
    console.error('  Diagnose: buyer Gateway balance funded? v2 Payment-Signature fix deployed? facilitator reachable?');
    process.exit(1);
  }

  // Keying this on get_trade_signal ALONE printed `verdict: PAID` for a SMOKE_TOOL=get_trade_call
  // run that had in fact returned HOLD — and is why the old waiver could never fire for
  // get_trade_call despite naming it. Both alias spellings now report their real verdict.
  const verdict = VERDICT_BEARING_TOOLS.has(TOOL) ? (pay.data && pay.data.call) : 'PAID';
  line();
  console.log(`HTTP status   : ${pay.status}`);
  console.log(`verdict       : ${verdict ?? '(n/a)'}`);

  // NO WAIVER. Every verdict settles since CH5, so the run always proceeds to the settlement
  // assertion below — a HOLD is a chargeable call and must produce a settlement id like any other.
  // ── find the settlement id via searchTransfers (pay().transaction is empty on prod) ──
  console.log('settle model  : fire-and-forget server-side → settlement id arrives via searchTransfers, not the HTTP response.');
  let settlement = null;
  const findDeadline = Date.now() + 3 * 60_000;
  while (Date.now() < findDeadline) {
    const res = await buyer.searchTransfers({ from: buyer.address }).catch(() => ({ transfers: [] }));
    settlement = (res.transfers || []).find(
      (t) => !beforeIds.has(t.id) && t.toAddress?.toLowerCase() === SELLER.toLowerCase() && t.amount === priceAtomic.toString(),
    );
    if (settlement) break;
    await sleep(6_000);
  }

  const availAfter = (await buyer.getBalances()).gateway.available;
  const debit = availBefore - availAfter;
  console.log(`buyer debit   : ${usd(debit)} USDC  (expected ${usd(priceAtomic)})`);

  if (settlement) {
    line();
    console.log(`✅ SETTLEMENT ID : ${settlement.id}`);
    console.log(`   status        : ${settlement.status}  (received→batched→completed; seller credit lands on 'completed', ~tens of min)`);
    console.log(`   ${settlement.fromAddress} → ${settlement.toAddress}  amount=${usd(settlement.amount)} USDC`);
    line();
    console.log('NEXT (R4): report this HTTP 200 + settlement id back. Seller credit is verified separately (poll, ~36 min batched latency).');
    process.exit(0);
  }

  console.log('⚠ HTTP 200 and buyer debited, but no transfer record surfaced within 3 min.');
  console.log(`  NB verdict was ${verdict ?? '(n/a)'} — since CH5 that is NOT an explanation: every verdict settles.`);
  console.log('  Either the settle is still in flight (async + Circle batching), or something is wrong. Poll before concluding.');
  console.log(`  Settle is async; check shortly:  node -e "import('@circle-fin/x402-batching/client').then(async m => { const c=new m.GatewayClient({chain:'optimism',privateKey:process.env.BUYER_PRIVATE_KEY}); console.log((await c.searchTransfers({from:c.address})).transfers.slice(0,3)); })"`);
  process.exit(0);
}

main().catch((e) => { console.error('✖ fatal:', e); process.exit(1); });
