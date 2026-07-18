/**
 * CIRCLE-GATEWAY-MIGRATE-W1 R5 — LIVE Circle Gateway testnet proof.
 *
 * Gated behind `INTEGRATION=1` (needs network to gateway-api-testnet.circle.com). Default
 * `npm test` SKIPS this file. Salvaged from the parked `feature/circle-gateway-x402-batching`
 * branch (its `/server` import path, INTEGRATION gate, and 503 "no supported networks" branch were
 * all correct); the staged branch's `createGatewayMiddleware` shape was NOT — that's Path A, which
 * cannot dual-advertise (architect R0 Q2 → Path B).
 *
 * SCOPE — what this can and cannot prove:
 *   ✅ Circle's testnet facilitator is live and advertises Base Sepolia
 *   ✅ the REAL BatchFacilitatorClient + GatewayEvmScheme compose into our resource server
 *   ✅ a real 402 accepts[] carries Circle's REAL verifyingContract
 *   ❌ a real SETTLE — that needs a buyer wallet with USDC deposited into the GatewayWallet
 *      contract on Base Sepolia (operator funding). Tracked as the ≤14d follow-up per R5.
 *
 * MAINNET IS NEVER TOUCHED: the module's allow-list refuses any non-testnet host/network.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { x402ResourceServer } from '@x402/core/server';
import {
  createCircleFacilitator,
  createGatewayScheme,
  probeCircleFacilitator,
  resolveCircleGatewayFromEnv,
  CIRCLE_TESTNET_FACILITATOR_URL,
  GATEWAY_EIP712_DOMAIN_NAME,
} from '../../src/lib/circle-gateway.js';

const GW_NET = 'eip155:84532'; // Base Sepolia
const GW_SELLER = '0x1111111111111111111111111111111111111111';
const LIVE_ENV = { CIRCLE_GATEWAY_ENABLED: 'true', CIRCLE_GATEWAY_SELLER_ADDRESS: GW_SELLER };

describe.skipIf(!process.env.INTEGRATION)('R5 — Circle Gateway testnet (LIVE)', () => {
  it('testnet facilitator is reachable and advertises exact on Base Sepolia', async () => {
    const res = await fetch(`${CIRCLE_TESTNET_FACILITATOR_URL}/v1/x402/supported`);
    if (res.status === 503) {
      throw new Error('Circle Gateway testnet returned 503 (no supported networks) — likely unreachable from this network.');
    }
    expect(res.status).toBe(200);

    const body = (await res.json()) as { kinds: Array<{ scheme: string; network: string; extra?: Record<string, unknown> }> };
    const baseSepolia = body.kinds.find((k) => k.network === GW_NET);
    expect(baseSepolia).toBeTruthy();

    // The load-bearing contract: Gateway IS `exact`; GatewayWalletBatched is extra.name.
    expect(baseSepolia!.scheme).toBe('exact');
    expect(baseSepolia!.extra?.name).toBe(GATEWAY_EIP712_DOMAIN_NAME);
    expect(baseSepolia!.extra?.verifyingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Every kind Circle advertises is `exact` — no exceptions.
    for (const k of body.kinds) expect(k.scheme).toBe('exact');
  }, 30_000);

  it('the REAL BatchFacilitatorClient probes clean against testnet', async () => {
    const config = resolveCircleGatewayFromEnv(LIVE_ENV);
    expect(config.enabled).toBe(true);
    expect(config.useStub).toBe(false);
    expect(config.facilitatorUrl).toBe(CIRCLE_TESTNET_FACILITATOR_URL);

    const probe = await probeCircleFacilitator(config);
    expect(probe).not.toBeNull();
    expect(probe!.verifyingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 30_000);

  it('a real 402 accepts[] carries Circle\'s LIVE verifyingContract (R3′ end-to-end)', async () => {
    const config = resolveCircleGatewayFromEnv(LIVE_ENV);
    const facilitator = createCircleFacilitator(config);

    const srv = new x402ResourceServer([facilitator] as never);
    srv.register(GW_NET, createGatewayScheme() as never);
    await srv.initialize();

    expect(srv.getSupportedKind(2, GW_NET as never, 'exact')).toBeTruthy();

    const reqs = (await srv.buildPaymentRequirements({
      scheme: 'exact', network: GW_NET, payTo: GW_SELLER, price: '$0.02',
    } as never)) as Array<{ scheme: string; network: string; amount: string; payTo: string; extra?: Record<string, unknown> }>;

    expect(reqs).toHaveLength(1);
    expect(reqs[0].scheme).toBe('exact');
    expect(reqs[0].network).toBe(GW_NET);
    expect(reqs[0].payTo).toBe(GW_SELLER);
    expect(reqs[0].amount).toBe('20000'); // $0.02 × 1e6 — same SoT price as the CDP rail
    // Merged through by GatewayEvmScheme.enhancePaymentRequirements from the LIVE facilitator.
    expect(reqs[0].extra?.name).toBe(GATEWAY_EIP712_DOMAIN_NAME);
    expect(reqs[0].extra?.verifyingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 45_000);

  it('mainnet stays structurally unreachable even under INTEGRATION (AC5)', () => {
    const c = resolveCircleGatewayFromEnv({
      ...LIVE_ENV,
      CIRCLE_GATEWAY_FACILITATOR_URL: 'https://gateway-api.circle.com',
    });
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/testnet-only/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPS-CIRCLE-GATEWAY-TESTNET-SETTLE-W1 — REAL Base-Sepolia settle (closes the R5 escape-hatch)
//
// Requires operator-funded Base-Sepolia keys at ~/.config/algovault/circle-testnet.env.
// Skips cleanly (never red) when INTEGRATION is unset OR the key file is absent OR the buyer
// is unfunded — CI must never depend on faucet state.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { bootLocalGatewaySeller, type LocalGatewaySeller } from './helpers/local-gateway-seller.js';

const KEYFILE = join(homedir(), '.config', 'algovault', 'circle-testnet.env');
const readKeys = (): Record<string, string> => {
  if (!existsSync(KEYFILE)) return {};
  return Object.fromEntries(
    readFileSync(KEYFILE, 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
};
const K = readKeys();
const HAVE_KEYS = Boolean(K.CIRCLE_TESTNET_BUYER_PRIVATE_KEY && K.CIRCLE_GATEWAY_SELLER_PRIVATE_KEY);
const RUN = Boolean(process.env.INTEGRATION) && HAVE_KEYS;

/**
 * Poll a Gateway balance until it covers `min`, or until `budgetMs` elapses.
 *
 * Sized for FINALITY, not network latency: Circle credits a deposit only after the deposit
 * block is finalized, and Base Sepolia's finality lag is ~25 min. A short poll reads 0 and
 * looks like a failed deposit even though the USDC has already left the wallet.
 */
async function waitForGatewayCredit(
  client: GatewayClient,
  min: bigint,
  budgetMs: number,
  label: string,
): Promise<Awaited<ReturnType<GatewayClient['getBalances']>>> {
  const deadline = Date.now() + budgetMs;
  let bal = await client.getBalances();
  while (bal.gateway.available < min && Date.now() < deadline) {
    const leftMin = Math.round((deadline - Date.now()) / 60_000);
    console.log(`[gateway-credit] waiting on ${label}: available=${bal.gateway.formattedAvailable} need=${Number(min) / 1e6} (~${leftMin}m budget left)`);
    await new Promise((r) => setTimeout(r, 15_000));
    bal = await client.getBalances();
  }
  return bal;
}

describe.skipIf(!RUN)('OPS-CIRCLE-GATEWAY-TESTNET-SETTLE-W1 — real Base-Sepolia settle', () => {
  let seller: LocalGatewaySeller | null = null;
  const proof: Record<string, unknown> = { wave: 'OPS-CIRCLE-GATEWAY-TESTNET-SETTLE-W1', chain: 'baseSepolia (eip155:84532)' };

  afterAll(async () => {
    if (seller) await seller.close();
    try {
      mkdirSync('audits', { recursive: true });
      writeFileSync('audits/OPS-CIRCLE-GATEWAY-TESTNET-SETTLE-W1-proof.json', JSON.stringify(proof, null, 2));
    } catch { /* artifact is best-effort */ }
  });

  it('R1/R2/R3 — deposit → pay → REAL settle → seller credited → withdraw', async () => {
    const buyer = new GatewayClient({ chain: 'baseSepolia', privateKey: K.CIRCLE_TESTNET_BUYER_PRIVATE_KEY as `0x${string}` });
    const sellerClient = new GatewayClient({ chain: 'baseSepolia', privateKey: K.CIRCLE_GATEWAY_SELLER_PRIVATE_KEY as `0x${string}` });

    seller = await bootLocalGatewaySeller({ sellerAddress: sellerClient.address });
    expect(seller, 'local flag-ON Gateway seller must boot (facilitator reachable)').not.toBeNull();
    const s = seller!;
    proof.sellerAddress = sellerClient.address;
    proof.buyerAddress = buyer.address;
    proof.priceUsd = s.price;
    proof.route = `${s.baseUrl}/x402/get_trade_signal`;

    // ── unpaid 402 carries the Gateway entry ──
    const unpaid = await fetch(`${s.baseUrl}/x402/get_trade_signal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unpaid.status).toBe(402);
    const challenge = (await unpaid.json()) as { accepts: Array<Record<string, unknown>> };
    expect(challenge.accepts.length).toBeGreaterThan(0);
    expect(challenge.accepts[0].scheme).toBe('exact');
    expect(challenge.accepts[0].network).toBe('eip155:84532');
    expect((challenge.accepts[0].extra as Record<string, unknown>)?.name).toBe('GatewayWalletBatched');
    proof.challengeAccepts = challenge.accepts;

    // ── R1: fund the buyer's Gateway balance if short ──
    const priceAtomic = BigInt(Math.round(s.price * 1e6));
    let bBal = await buyer.getBalances();
    proof.buyerBefore = { wallet: bBal.wallet.formatted, gatewayAvailable: bBal.gateway.formattedAvailable };
    if (bBal.gateway.available < priceAtomic) {
      // FINALITY, not latency: Gateway credits a deposit only once its block is FINALIZED.
      // Base Sepolia finality lag is ~744 blocks ≈ 25 min (measured 2026-07-18), so a
      // seconds-scale poll will always read 0 and wrongly look like a failed deposit.
      // Wait FIRST — a prior run's deposit may still be in flight — before spending more USDC.
      bBal = await waitForGatewayCredit(buyer, priceAtomic, 4 * 60_000, 'pre-existing deposit');
      if (bBal.gateway.available < priceAtomic) {
        const dep = await buyer.deposit('1');
        proof.deposit = { depositTxHash: dep.depositTxHash, approvalTxHash: dep.approvalTxHash, amount: dep.formattedAmount };
        bBal = await waitForGatewayCredit(buyer, priceAtomic, 35 * 60_000, 'new deposit');
      }
      proof.buyerAfterDeposit = { gatewayAvailable: bBal.gateway.formattedAvailable };
    }
    expect(bBal.gateway.available, 'buyer Gateway balance must cover the price').toBeGreaterThanOrEqual(priceAtomic);

    // ── R2: seller balance BEFORE ──
    const sellerBefore = await sellerClient.getBalances();
    proof.sellerBefore = { total: sellerBefore.gateway.formattedTotal, available: sellerBefore.gateway.formattedAvailable };

    // ── R1: pay the local AlgoVault route → real batched settle ──
    let pay;
    try {
      pay = await buyer.pay(`${s.baseUrl}/x402/get_trade_signal`, { method: 'POST', body: {} });
    } catch (err) {
      // Surface the SERVER-side reason — `pay()` only reports "Payment Required".
      proof.payFailures = s.failures;
      console.error('[settle-diag] server rejections:', JSON.stringify(s.failures, null, 2));
      throw err;
    }
    proof.pay = { status: pay.status, amount: pay.formattedAmount, transaction: pay.transaction, data: pay.data };
    expect(pay.status).toBe(200);
    expect((pay.data as { ok?: boolean })?.ok).toBe(true);

    // The server-side settle must have really succeeded (Stub always fails by design).
    expect(s.settlements.length).toBeGreaterThan(0);
    const settle = s.settlements[s.settlements.length - 1];
    proof.settlement = settle;
    expect(settle.success, `settle must succeed: ${JSON.stringify(settle)}`).toBe(true);
    expect(String(settle.transaction ?? '')).not.toBe('');

    // ── R2 (spec as written — VERIFIED CORRECT): the payer is debited AND the seller's
    // Gateway balance is credited by exactly the tool price once the transfer COMPLETES.
    //
    // Timing is the whole trick: the credit lands only on `completed`, and the lifecycle is
    // received → batched → completed with a measured ~36 min latency on testnet. Observing the
    // seller at 0/0 before then means "not yet", NOT "never" (an earlier revision of this test
    // wrongly concluded the latter and asserted the opposite model).
    const buyerAfterPay = await buyer.getBalances();
    const buyerDebit = bBal.gateway.available - buyerAfterPay.gateway.available;
    proof.buyerDebitAtomic = buyerDebit.toString();
    proof.priceAtomic = priceAtomic.toString();
    expect(buyerDebit, 'payer Gateway balance must be debited by exactly the tool price').toBe(priceAtomic);

    const findTransfer = async () => {
      const r = await buyer.searchTransfers({});
      const l = ((r as { transfers?: unknown[] }).transfers ?? r) as Array<Record<string, string>>;
      return (Array.isArray(l) ? l : []).find((t) => t.id === String(settle.transaction));
    };
    const record = await findTransfer();
    proof.transferRecord = record;
    expect(record, 'Circle must hold a transfer record for the settlement id').toBeTruthy();
    expect(record!.fromAddress.toLowerCase()).toBe(buyer.address.toLowerCase());
    expect(record!.toAddress.toLowerCase()).toBe(sellerClient.address.toLowerCase());
    expect(record!.amount).toBe(priceAtomic.toString());

    // Wait for the seller credit — budgeted well past the observed ~36 min completion latency.
    const sellerCredit = await waitForGatewayCredit(
      sellerClient,
      sellerBefore.gateway.total + priceAtomic,
      50 * 60_000,
      'seller credit (transfer completion)',
    );
    const delta = sellerCredit.gateway.total - sellerBefore.gateway.total;
    proof.sellerAfter = { total: sellerCredit.gateway.formattedTotal, available: sellerCredit.gateway.formattedAvailable };
    proof.sellerDeltaAtomic = delta.toString();
    proof.transferFinal = await findTransfer().then((t) => ({ status: t?.status, txHash: t?.txHash }));
    expect(delta, 'seller Gateway balance must be credited by exactly the tool price').toBe(priceAtomic);

    // ── R3 (spec as written): the seller withdraws to real on-chain USDC.
    //
    // `withdraw()` is NOT gasless — it sends an on-chain gatewayMint() from the withdrawer's own
    // wallet — and it is NOT atomic: the API burns the ledger balance BEFORE the mint, so a mint
    // that reverts (e.g. out of gas) STRANDS the funds with no SDK retry path. Hence the explicit
    // gas pre-flight below, and an explicit maxFee cap instead of the SDK's 2.01 USDC default.
    const WITHDRAW_FEE_USDC = 0.01;
    const sellerGas = await sellerClient.publicClient.getBalance({ address: sellerClient.address });
    proof.sellerGasWei = sellerGas.toString();
    expect(sellerGas, 'seller needs native gas — withdraw() writes on-chain and strands funds if it reverts').toBeGreaterThan(0n);

    const availUsd = Number(sellerCredit.gateway.available) / 1e6;
    if (availUsd > WITHDRAW_FEE_USDC) {
      const amt = (availUsd - WITHDRAW_FEE_USDC).toFixed(2);
      const w = await sellerClient.withdraw(amt, { maxFee: '0.05' });
      proof.withdraw = { mintTxHash: w.mintTxHash, amount: w.formattedAmount, recipient: w.recipient, feeUsdc: WITHDRAW_FEE_USDC };
      expect(String(w.mintTxHash)).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // Wait for the receipt before reading the balance: an immediate read returns the PRE-tx
      // value (stale read-after-write observed twice on Base Sepolia RPCs).
      const rc = await sellerClient.publicClient.waitForTransactionReceipt({ hash: w.mintTxHash });
      expect(rc.status).toBe('success');
      const post = await sellerClient.getBalances();
      proof.sellerWalletAfterWithdraw = post.wallet.formatted;
      expect(post.wallet.balance, 'withdrawn USDC must land on-chain in the seller wallet').toBeGreaterThan(0n);
    } else {
      proof.withdrawSkipped = `available ${availUsd} <= fee ${WITHDRAW_FEE_USDC}`;
    }
  }, 2_700_000);
});
