/**
 * HTTP x402 resource endpoints — the CDP Bazaar discovery surface.
 * (X402-BAZAAR-HTTP-REDECLARE-W1)
 *
 * Three HTTP x402 routes (`POST /x402/get_trade_signal`, `/x402/scan_funding_arb`,
 * `/x402/get_market_regime`) that are a **transport + discovery surface**, NOT a
 * second product. Each route calls the SAME core handler function as its MCP tool
 * (single source of truth — `getTradeSignal` / `scanFundingArb` / `getMarketRegime`);
 * if the public output diverges from the MCP tool, that is a bug (see the parity test).
 *
 * Why this exists: the CDP public Bazaar catalog is HTTP-type only — the parent wave's
 * MCP-typed declaration settled (`EXTENSION-RESPONSES:processing`) but never listed.
 * These HTTP resources, declared via HTTP body-discovery, are the listable form.
 *
 * Two-flag firewall (R5): the routes mount + advertise discovery ONLY when
 * `X402_FACILITATOR=cdp` AND `BAZAAR_DISCOVERABLE=true` (`discoveryEnabled`). With the
 * production defaults (`legacy` / `false`) `mountX402HttpRoutes` registers nothing →
 * the routes 404 → production is byte-identical; flip = instant rollback.
 *
 * Paywall (R2): reuses `resolveLicense` (x402 → API key → free). Unpaid (`tier!=='x402'`)
 * → 402 carrying the HTTP resource URL + bazaar extension (the listing channel). Paid →
 * run the core fn, then settle fire-and-forget (R6; HOLD verdicts stay free, like MCP).
 *
 * Input validation: each body is validated against the SAME JSON Schema declared to the
 * Bazaar (`BAZAAR_ROUTES[tool].inputSchema`) via ajv (single source for input shape).
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import Ajv, { type ValidateFunction } from 'ajv';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { resolveLicense, requestContext } from './license.js';
import { hashIp, logRequest } from './analytics.js';
import { clientIp } from './client-ip.js';
import { generate402Response, settleX402Async, paymentMatchesToolRoute } from './x402.js';
import { tryClaimPayment, extractPaymentNonce } from './x402-idempotency-store.js';
import { BAZAAR_ROUTES, bazaarResourceUrl, bazaarRouteDescription } from './x402-bazaar.js';
import { resolveFacilitatorFromEnv } from './x402-facilitator.js';
import { getTradeSignal } from '../tools/get-trade-call.js';
import { scanFundingArb } from '../tools/scan-funding-arb.js';
import { getMarketRegime } from '../tools/get-market-regime.js';
import { runScanTradeCall } from '../tools/scan-trade-calls.js';
import { getEquityCall, getEquityRegime } from './equities/equity-tool-formatters.js';
import { runAsCaller } from './upstream-weight-budget.js';
import type { ScanExchangeId } from './trade-call-scanner.js';
import type { ExchangeId, LicenseInfo, TradeCallResult } from '../types.js';

const ajv = new Ajv({ useDefaults: true, coerceTypes: true, allErrors: true });

/**
 * Tolerant JSON body parser: never lets a malformed/empty body escape as a 400. The CDP
 * Bazaar crawler probes the resource with `bazaar.info.input` (or an empty request) and
 * requires a 402 — if the server returns ANY other status (e.g. express.json's 400 on a
 * body it can't parse) the resource is NOT indexed (CDP support, 2026-06-03). So we
 * swallow parse errors to `{}` and let the paywall return 402 (paid calls with a bad body
 * still get a clean 400 from the ajv check downstream).
 */
function tolerantJson(req: Request, res: Response, next: NextFunction): void {
  express.json()(req, res, (err?: unknown) => {
    if (err) (req as Request & { body: unknown }).body = {};
    next();
  });
}

/** Log every /x402 request's method + final status + UA (so the Bazaar crawler's probe is observable). */
function logCrawl(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const ua = String(req.headers['user-agent'] || '').slice(0, 80);
    const paid = req.headers['x-payment'] ? 'y' : 'n';
    console.log(`[x402-route] ${req.method} ${req.path} status=${res.statusCode} xpayment=${paid} ua="${ua}"`);
  });
  next();
}

/**
 * Send the x402 402 challenge. **The x402 v2 HTTP transport delivers the PaymentRequired
 * payload via a base64-encoded `PAYMENT-REQUIRED` response HEADER — the CDP Bazaar crawler
 * reads it THERE, not in the body** (CDP eng, 2026-06-06: "embeds it in the response body
 * — bazaar discovery will reject it"). We set the header (canonical SDK encoder) AND keep
 * the JSON body (human/debug + existing clients).
 */
function send402(res: Response, tool: string, opts?: { resourceUrl?: string; discoverable?: boolean }): void {
  const r = generate402Response(tool, {
    resourceUrl: opts?.resourceUrl ?? bazaarResourceUrl(tool),
    description: bazaarRouteDescription(tool),
    includeExtensions: opts?.discoverable ?? true,
  });
  try {
    res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(r.body as Parameters<typeof encodePaymentRequiredHeader>[0]));
  } catch { /* best-effort; body still carries the payload */ }
  res.status(r.status).json(r.body);
}

/**
 * The paid, GATED + Bazaar-discoverable HTTP tools. This is the x402 ENFORCEMENT allow-list:
 * `index.ts` keys `isPricedTool` off it, and it must match `BAZAAR_ROUTES` (the discovery SoT).
 *
 * FEATURE-REGISTRY-SOT-W1 CH3 — deliberately NOT registry-derived (kept alias-keyed): the
 * trade-call feature is canonical `get_trade_call` in the registry, but its GATED + discoverable
 * HTTP name is the back-compat alias `get_trade_signal` (ratified Cowork A2, 2026-05-29 —
 * `get_trade_call` is intentionally free + non-discoverable). Deriving this list from the
 * registry's canonical `httpX402` names would SWAP `get_trade_signal`→`get_trade_call`,
 * simultaneously UN-gating the paid tool AND gating the free one — a non-additive payment-surface
 * break (architect A3: x402-shape byte-identical). Registry↔HTTP_TOOLS parity is instead enforced
 * by the CH4 drift canary (alias-resolved).
 */
export const HTTP_TOOLS = ['get_trade_signal', 'scan_funding_arb', 'get_market_regime', 'scan_trade_calls', 'get_equity_call', 'get_equity_regime'] as const;
export type HttpTool = (typeof HTTP_TOOLS)[number];

/**
 * Dispatch a validated body to the SAME core handler the MCP tool uses — called
 * identically to the MCP `server.tool` handlers (parity is the contract). Returns
 * the tool's existing public output object.
 */
export async function callCoreHandler(
  tool: HttpTool,
  input: Record<string, unknown>,
  license: LicenseInfo,
): Promise<unknown> {
  // OPS-RATELIMIT-CALLER-ATTRIBUTION-W1: tag x402 HTTP traffic (the HTTP-twin of the MCP
  // tools — same lib fns, separate handlers) so paid-HTTP demand is attributed distinctly
  // from MCP demand. Weight class unchanged (interactive) — zero behavior change.
  return runAsCaller(`x402:${tool}`, () => {
  switch (tool) {
    case 'get_trade_signal':
      return getTradeSignal({
        coin: input.coin as string,
        timeframe: input.timeframe as string,
        includeReasoning: input.includeReasoning as boolean,
        exchange: input.exchange as ExchangeId,
        license,
      });
    case 'scan_funding_arb':
      return scanFundingArb({
        minSpreadBps: input.minSpreadBps as number,
        limit: input.limit as number,
        license,
      });
    case 'get_market_regime':
      // Matches the MCP handler exactly (does not forward license — parity).
      return getMarketRegime({
        coin: input.coin as string,
        timeframe: input.timeframe as string,
        exchange: input.exchange as ExchangeId,
      });
    // OPS-X402-PRICING-EXPANSION-W1: the 3 newly-priced tools — SAME core fns the MCP
    // handlers call (index.ts), so the x402-HTTP twin is byte-parity. The x402 CHARGE is
    // the flat declared 402 price (effectivePrice=$0.02); tier:'x402' bypasses the free
    // counter, so runScanTradeCall's max(1,N) is a no-op here (flat, never per-result).
    case 'scan_trade_calls':
      return runScanTradeCall(
        {
          topN: input.topN as number,
          timeframe: input.timeframe as string,
          exchange: input.exchange as ScanExchangeId,
          minConfidence: input.minConfidence as number | undefined,
          includeHolds: input.includeHolds as boolean,
          limit: input.limit as number,
          // SCAN-RANKBY-W1: forward the lens on the x402 channel too (parity). Default
          // 'oi' when absent → byte-identical paid scan; resolveRankBy owns validation.
          rankBy: input.rankBy as string | undefined,
        },
        license,
      );
    case 'get_equity_call':
      return getEquityCall({ symbol: input.symbol as string, license });
    case 'get_equity_regime':
      return getEquityRegime({ symbol: input.symbol as string | undefined, license });
    default: {
      // tsc-exhaustiveness: a tool added to HTTP_TOOLS without a dispatch case here is a
      // COMPILE error (forgot-to-wire is structurally impossible).
      const _exhaustive: never = tool;
      throw new Error(`callCoreHandler: unhandled x402 tool ${String(_exhaustive)}`);
    }
  }
  });
}

function clientIpHash(req: Request): string {
  // OPS-MCP-DEFENSE-IN-DEPTH-W1 R2: third in-class raw-XFF site (audit-cited) —
  // same shared clientIp(req) derivation as the /mcp quota + attribution sites.
  return hashIp(clientIp(req) || 'unknown');
}

/**
 * Mount the HTTP x402 resource routes (one per HTTP_TOOLS entry) on the Express app — ONLY when the two-flag
 * firewall resolves to cdp + discoverable. Returns the list of mounted route paths
 * (empty array when flags are off → routes never registered → 404).
 */
export function mountX402HttpRoutes(app: Express): string[] {
  const resolved = resolveFacilitatorFromEnv();
  if (!resolved.discoveryEnabled) return []; // defaults (legacy/false) → not mounted

  const mounted: string[] = [];
  // LANDING-X402-CALL-ROUTE-W1 (2026-06-23): mount the canonical HTTP_TOOLS routes PLUS a paid
  // ALIAS /x402/get_trade_call. get_trade_call is the promoted canonical tool name, but the gated
  // HTTP route was historically keyed on the back-compat alias get_trade_signal (Cowork A2,
  // 2026-05-29). The alias delegates to get_trade_signal's pricing/handler/binding/idempotency
  // (`tool` stays 'get_trade_signal' in the loop body), so a payment verifies —
  // paymentMatchesToolRoute is resource-URL-agnostic: it keys off get_trade_signal's
  // asset/network/payTo + price floor, not the path. It is deliberately NOT added to HTTP_TOOLS
  // (so isPricedTool + the MCP free-tier path stay byte-identical) and is sent with
  // discoverable:false (no bazaar extension → NOT Bazaar-cataloged), so the A2/A3 invariants
  // (get_trade_call free on MCP + non-discoverable) hold. /x402/get_trade_signal stays mounted
  // for back-compat. This lets the public docs promote /x402/get_trade_call without a 404.
  const routeSpecs: Array<{ routePath: string; tool: HttpTool; send402Opts?: { resourceUrl?: string; discoverable?: boolean } }> = [
    ...HTTP_TOOLS.map((t) => ({ routePath: `/x402/${t}`, tool: t })),
    {
      routePath: '/x402/get_trade_call',
      tool: 'get_trade_signal' as HttpTool,
      send402Opts: { resourceUrl: bazaarResourceUrl('get_trade_call'), discoverable: false },
    },
  ];
  for (const { routePath, tool, send402Opts } of routeSpecs) {
    const spec = BAZAAR_ROUTES[tool];
    if (!spec) continue; // defensive: only declared tools
    const validate: ValidateFunction = ajv.compile(spec.inputSchema);

    // x402 discovery challenge (GET). The CDP Bazaar indexer crawls the resource URL
    // with a GET — it MUST return a 402 (the x402 payment-required challenge), NOT 404,
    // or the route is never indexed (live-verified: every listed Bazaar resource 402s/
    // 405s on GET; a POST-only route 404s on GET and stays unlisted forever despite the
    // settle returning `processing`). The actual paid invocation is the POST below.
    app.get(routePath, logCrawl, (_req: Request, res: Response) => {
      send402(res, tool, send402Opts);
    });

    app.post(routePath, logCrawl, tolerantJson, async (req: Request, res: Response) => {
      const startMs = Date.now();
      // 3-tier gate; x402 verification hits the CDP facilitator.
      const { license, pendingSettlement } = await resolveLicense(
        req.headers as Record<string, string | undefined>,
      );

      // Paywall: require a settled-capable x402 payment. No payment → 402 carrying
      // the HTTP resource URL + bazaar extension (the channel that earns the listing).
      if (license.tier !== 'x402' || !pendingSettlement) {
        send402(res, tool, send402Opts);
        return;
      }

      // Validate body against the SAME schema declared to the Bazaar (defaults applied).
      // Done BEFORE the price-binding check so the (defaults-applied) timeframe is known
      // for the per-timeframe premium assertion (X402-03).
      const input: Record<string, unknown> = { ...(req.body ?? {}) };
      if (!validate(input)) {
        return res.status(400).json({
          error: 'invalid_input',
          code: 'X402_HTTP_INVALID_INPUT',
          details: validate.errors ?? [],
          suggested_fix: `Body must satisfy the published JSON Schema for ${tool}.`,
        });
      }

      // X402-01 / X402-03 — per-route price binding (the chokepoint the audit
      // flagged). `verifyX402Payment` (called inside resolveLicense) matched the
      // proof against the FLATTENED cross-tool pool, so a $0.01 scan_funding_arb
      // proof would satisfy this $0.02 route. Re-assert here that the matched
      // requirement belongs to THIS tool's route AND covers its effective
      // (timeframe-aware) price. Mismatch (cross-tool downgrade OR premium-timeframe
      // underpay) → 402, do NOT serve, do NOT settle.
      const timeframe = typeof input.timeframe === 'string' ? (input.timeframe as string) : undefined;
      if (!paymentMatchesToolRoute(pendingSettlement, tool, timeframe)) {
        console.warn(`[x402-route] payment-binding REJECT for ${routePath} (cross-tool or underpaid proof)`);
        send402(res, tool, send402Opts);
        return;
      }

      // X402-02 — bounded single-use claim BEFORE serving, to close the pre-settle
      // replay window (verify is stateless + settle is fire-and-forget, so the same
      // proof replayed concurrently within the ~2s settle window would unlock N
      // resources for ONE on-chain charge). Claim the ERC-3009 nonce; a replay
      // (already-claimed nonce) → 402 without serving/settling. Fail-safe on DB error
      // (tryClaimPayment returns false → reject) per default-deny on the paid path.
      const settlementReq = (pendingSettlement.requirements ?? {}) as { amount?: unknown };
      const paidAmount = typeof settlementReq.amount === 'string'
        ? settlementReq.amount
        : settlementReq.amount != null ? String(settlementReq.amount) : '';
      const nonce = extractPaymentNonce(pendingSettlement.paymentPayload);
      const claimed = await tryClaimPayment(nonce ?? '', tool, paidAmount);
      if (!claimed) {
        console.warn(`[x402-route] payment-replay REJECT for ${routePath} (nonce already claimed or unclaimable)`);
        res.status(402).json({
          x402Version: 2,
          error: 'Payment Required',
          code: 'X402_PAYMENT_REPLAY',
          message: 'This payment proof has already been used; submit a fresh payment.',
        });
        return;
      }

      const ipHash = clientIpHash(req);
      try {
        const result = await requestContext.run(
          { license, sessionId: undefined, ipHash },
          () => callCoreHandler(tool, input, license),
        );

        // Public output == MCP tool output (single source of truth).
        res.json(result);

        // Async settle (R6): fire-and-forget after response. get_trade_signal HOLDs
        // stay free (no capture), exactly like the MCP path.
        const verdict = tool === 'get_trade_signal' ? (result as TradeCallResult).call : 'PAID';
        if (pendingSettlement && verdict !== 'HOLD') {
          settleX402Async(pendingSettlement);
        }

        // Analytics parity (data flywheel) — fire-and-forget.
        try {
          logRequest({
            sessionId: undefined,
            toolName: tool,
            asset: typeof input.coin === 'string' ? (input.coin as string) : undefined,
            timeframe: typeof input.timeframe === 'string' ? (input.timeframe as string) : undefined,
            licenseTier: license.tier,
            responseTimeMs: Date.now() - startMs,
            verdict: tool === 'get_trade_signal' ? (result as TradeCallResult).call : undefined,
            ipHash,
            isBotInternal: false,
          });
        } catch { /* best-effort; never blocks the request */ }
      } catch (err: unknown) {
        if (!res.headersSent) {
          res.status(500).json({
            error: 'internal_error',
            code: 'X402_HTTP_HANDLER_ERROR',
            message: err instanceof Error ? err.message : 'handler failed',
          });
        }
      }
    });

    mounted.push(routePath);
  }
  return mounted;
}
