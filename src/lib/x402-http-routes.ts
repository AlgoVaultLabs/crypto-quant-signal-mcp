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
import { resolveLicense, requestContext } from './license.js';
import { hashIp, logRequest } from './analytics.js';
import { generate402Response, settleX402Async } from './x402.js';
import { BAZAAR_ROUTES, bazaarResourceUrl, bazaarRouteDescription } from './x402-bazaar.js';
import { resolveFacilitatorFromEnv } from './x402-facilitator.js';
import { getTradeSignal } from '../tools/get-trade-call.js';
import { scanFundingArb } from '../tools/scan-funding-arb.js';
import { getMarketRegime } from '../tools/get-market-regime.js';
import { runAsCaller } from './upstream-weight-budget.js';
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

/** The paid, Bazaar-discoverable HTTP tools (must match BAZAAR_ROUTES / TOOL_PRICING). */
export const HTTP_TOOLS = ['get_trade_signal', 'scan_funding_arb', 'get_market_regime'] as const;
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
  }
  });
}

function clientIpHash(req: Request): string {
  const clientIp =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.headers['x-real-ip'] as string | undefined) ||
    req.socket.remoteAddress ||
    'unknown';
  return hashIp(clientIp);
}

/**
 * Mount the 3 HTTP x402 resource routes on the Express app — ONLY when the two-flag
 * firewall resolves to cdp + discoverable. Returns the list of mounted route paths
 * (empty array when flags are off → routes never registered → 404).
 */
export function mountX402HttpRoutes(app: Express): string[] {
  const resolved = resolveFacilitatorFromEnv();
  if (!resolved.discoveryEnabled) return []; // defaults (legacy/false) → not mounted

  const mounted: string[] = [];
  for (const tool of HTTP_TOOLS) {
    const spec = BAZAAR_ROUTES[tool];
    if (!spec) continue; // defensive: only declared tools
    const validate: ValidateFunction = ajv.compile(spec.inputSchema);
    const routePath = `/x402/${tool}`;

    // x402 discovery challenge (GET). The CDP Bazaar indexer crawls the resource URL
    // with a GET — it MUST return a 402 (the x402 payment-required challenge), NOT 404,
    // or the route is never indexed (live-verified: every listed Bazaar resource 402s/
    // 405s on GET; a POST-only route 404s on GET and stays unlisted forever despite the
    // settle returning `processing`). The actual paid invocation is the POST below.
    app.get(routePath, logCrawl, (_req: Request, res: Response) => {
      const r = generate402Response(tool, {
        resourceUrl: bazaarResourceUrl(tool),
        description: bazaarRouteDescription(tool),
        includeExtensions: true,
      });
      res.status(r.status).json(r.body);
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
        const r = generate402Response(tool, {
          resourceUrl: bazaarResourceUrl(tool),
          description: bazaarRouteDescription(tool),
          includeExtensions: true,
        });
        return res.status(r.status).json(r.body);
      }

      // Validate body against the SAME schema declared to the Bazaar (defaults applied).
      const input: Record<string, unknown> = { ...(req.body ?? {}) };
      if (!validate(input)) {
        return res.status(400).json({
          error: 'invalid_input',
          code: 'X402_HTTP_INVALID_INPUT',
          details: validate.errors ?? [],
          suggested_fix: `Body must satisfy the published JSON Schema for ${tool}.`,
        });
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
