/**
 * OPS-CIRCLE-GATEWAY-TESTNET-SETTLE-W1 — LOCAL flag-ON Gateway seller instance.
 *
 * Boots a throwaway Express server that speaks the x402 v2 HTTP protocol using **AlgoVault's
 * own** Gateway primitives, so a real Base-Sepolia settle exercises the code we actually ship:
 *
 *   - `resolveCircleGatewayFromEnv()` — the real two-flag firewall + testnet allow-list
 *   - `probeCircleFacilitator()`      — the real fail-open probe + real `BatchFacilitatorClient`
 *   - `createGatewayScheme()`         — the real `GatewayEvmScheme`
 *   - `TOOL_PRICING`                  — the real single price SoT (no second price source)
 *   - `encodePaymentRequiredHeader` / `encodePaymentResponseHeader` from `@x402/core/http`
 *     — the SAME protocol encoders `src/lib/x402-http-routes.ts` uses in production
 *   - `findMatchingRequirements` → `verifyPayment` → `settlePayment` — the SAME resource-server
 *     call sequence as `verifyX402Payment()` / `settleX402Async()` in `src/lib/x402.ts`
 *
 * SCOPE (documented honestly — see the wave's proof artifact):
 *  - The CDP facilitator is deliberately NOT co-mounted. The default legacy facilitator
 *    (x402.org) advertises `exact/eip155:84532` but NOT `exact/eip155:8453`, so a local dual
 *    mount would either null the resource server (prod's base-mainnet config) or put CDP and
 *    Gateway on the SAME `(scheme, network)` key — the exact collision already flagged as the
 *    mainnet blocker. This instance therefore proves the GATEWAY rail, not rail coexistence.
 *  - Settlement is AWAITED here (production settles fire-and-forget after responding) so the
 *    test can assert a real settle and capture the transaction for the proof artifact.
 *
 * NEVER used by prod: test-support only, bound to 127.0.0.1 on an ephemeral port.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { x402ResourceServer } from '@x402/core/server';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import {
  createGatewayScheme,
  probeCircleFacilitator,
  resolveCircleGatewayFromEnv,
} from '../../../src/lib/circle-gateway.js';
import { TOOL_PRICING } from '../../../src/lib/x402.js';

export interface LocalGatewaySeller {
  baseUrl: string;
  /** CAIP-2 network the Gateway scheme advertises on (Base Sepolia). */
  network: string;
  /** USD price served, sourced from the real TOOL_PRICING SoT. */
  price: number;
  /** Settle results captured per paid request (proof artifact input). */
  settlements: Array<Record<string, unknown>>;
  /** Why any paid request was rejected — without this a 402 is undiagnosable. */
  failures: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * Boot the local flag-ON seller. Returns null when the Gateway config resolves disabled or the
 * facilitator probe fails — callers should skip rather than fail (mirrors the fail-open contract).
 */
export async function bootLocalGatewaySeller(opts: {
  sellerAddress: string;
  /** Tool whose price is served — resolved from TOOL_PRICING, never hardcoded. */
  tool?: string;
}): Promise<LocalGatewaySeller | null> {
  const tool = opts.tool ?? 'get_trade_signal';
  const price = TOOL_PRICING[tool as keyof typeof TOOL_PRICING] as number | undefined;
  if (typeof price !== 'number') throw new Error(`no TOOL_PRICING entry for ${tool}`);

  // Real config resolution — same env contract as prod, testnet allow-list enforced.
  const config = resolveCircleGatewayFromEnv({
    CIRCLE_GATEWAY_ENABLED: 'true',
    CIRCLE_GATEWAY_SELLER_ADDRESS: opts.sellerAddress,
  } as NodeJS.ProcessEnv);
  if (!config.enabled || config.useStub) return null; // Stub can never settle — skip, don't fake.

  const probe = await probeCircleFacilitator(config);
  if (!probe) return null; // fail-open: facilitator unreachable → skip

  const srv = new x402ResourceServer([probe.facilitator] as never);
  srv.register(config.network as `${string}:${string}`, createGatewayScheme() as never);
  await srv.initialize();

  const requirements = (await srv.buildPaymentRequirements({
    scheme: 'exact',
    network: config.network as `${string}:${string}`,
    payTo: config.sellerAddress,
    price: `$${price}`,
  } as never)) as unknown[];

  const settlements: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const routePath = `/x402/${tool}`;
  const handler = async (req: express.Request, res: express.Response) => {
    // x402 **v2** clients (incl. Circle's GatewayClient) send the signed payload in
    // `Payment-Signature`. `X-PAYMENT` is the v1 header our CDP rail reads. Accept BOTH —
    // reading only `x-payment` makes a v2 payment invisible and 402s forever.
    const sigHeader = req.headers['payment-signature'] as string | undefined;
    const raw = (sigHeader ?? req.headers['x-payment'] ?? req.headers['X-PAYMENT']) as string | undefined;

    // Unpaid → the x402 v2 402 challenge, byte-shaped like generate402Response().
    if (!raw) {
      const body = {
        x402Version: 2,
        error: 'Payment Required',
        resource: {
          url: `${baseUrl}${routePath}`,
          description: `Payment for ${tool} tool call`,
          mimeType: 'application/json',
        },
        accepts: requirements,
      };
      try {
        res.setHeader(
          'PAYMENT-REQUIRED',
          encodePaymentRequiredHeader(body as Parameters<typeof encodePaymentRequiredHeader>[0]),
        );
      } catch { /* header is additive; body carries accepts[] regardless */ }
      res.status(402).json(body);
      return;
    }

    // Paid → mirror src/lib/x402.ts: match → verify → settle.
    let payload: unknown;
    try {
      payload = sigHeader
        ? decodePaymentSignatureHeader(sigHeader) // x402 v2 canonical
        : JSON.parse(raw); // v1 raw-JSON x-payment (this repo's CDP shape)
    } catch {
      try {
        payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); // base64 variant
      } catch {
        res.status(400).json({ error: 'unparseable x-payment' });
        return;
      }
    }

    const match = srv.findMatchingRequirements(
      requirements as Parameters<typeof srv.findMatchingRequirements>[0],
      payload as Parameters<typeof srv.findMatchingRequirements>[1],
    );
    if (!match) {
      failures.push({ stage: 'findMatchingRequirements', detail: 'no requirement matched the payload', payload });
      res.status(402).json({ error: 'no matching requirements' });
      return;
    }

    const verify = await srv.verifyPayment(
      payload as Parameters<typeof srv.verifyPayment>[0],
      match as Parameters<typeof srv.verifyPayment>[1],
    );
    if (!verify.isValid) {
      failures.push({ stage: 'verifyPayment', reason: verify.invalidReason, message: (verify as { invalidMessage?: string }).invalidMessage });
      res.status(402).json({ error: 'verify failed', reason: verify.invalidReason });
      return;
    }

    // AWAITED (prod fires-and-forgets) so the proof can assert a REAL settle.
    const settle = await srv.settlePayment(
      payload as Parameters<typeof srv.settlePayment>[0],
      match as Parameters<typeof srv.settlePayment>[1],
    );
    settlements.push({ ...settle } as Record<string, unknown>);

    if (!settle.success) {
      failures.push({ stage: 'settlePayment', reason: settle.errorReason, message: (settle as { errorMessage?: string }).errorMessage });
      res.status(402).json({ error: 'settle failed', reason: settle.errorReason });
      return;
    }

    try {
      res.setHeader(
        'PAYMENT-RESPONSE',
        encodePaymentResponseHeader(settle as Parameters<typeof encodePaymentResponseHeader>[0]),
      );
    } catch { /* additive */ }

    // Stand-in payload: this wave proves the PAYMENT rail, not the tool's business logic
    // (which is covered by its own suites and would add live-venue flakiness here).
    res.status(200).json({ ok: true, tool, paidUsd: price, payer: verify.payer });
  };

  app.get(routePath, handler);
  app.post(routePath, handler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    network: config.network,
    price,
    settlements,
    failures,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
