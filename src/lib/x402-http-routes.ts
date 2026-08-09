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
// OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1 (Q2=A): classify EVERY external path,
// including paid x402/a2mcp, via the ONE canonical classifier — no second isbot impl.
import { classifyTraffic } from './traffic-classifier.js';
import { generate402Response, settleX402Async, paymentMatchesToolRoute } from './x402.js';
import { tryClaimPayment, extractPaymentNonce, extractPayerWallet, RAIL_BASE_USDC } from './x402-idempotency-store.js';
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
export function tolerantJson(req: Request, res: Response, next: NextFunction): void {
  express.json()(req, res, (err?: unknown) => {
    if (err) (req as Request & { body: unknown }).body = {};
    next();
  });
}

/** Media types express.json() will parse: application/json and any `+json` structured suffix. */
const JSON_MEDIA_TYPE = /^application\/([\w.+-]+\+)?json$/i;

/**
 * Explain a body that arrived EMPTY on a request which DECLARED one — i.e. `express.json()`
 * silently declined to parse it, rather than the caller genuinely omitting it.
 *
 * WHY THIS EXISTS. `tolerantJson` above swallows *parse errors*, but a content-type that doesn't
 * match isn't an error at all: express.json() simply skips the body and leaves it empty. The
 * caller then fails the JSON Schema with a generic "must have required property" — **after their
 * payment has already verified** — which points at the wrong thing entirely.
 *
 * The live instance (2026-07-29, Circle Gateway): a client passed its own
 * `headers: { 'content-type': 'application/json' }` to an SDK that already sets
 * `Content-Type: application/json`. Both case-different keys survive the SDK's
 * `{...defaults, ...options.headers}` spread, and `fetch` COMBINES them into
 * `"application/json, application/json"`, which no media-type matcher accepts. Measured, not
 * theorised — and a mainstream SDK's own merge produces it, so other agents will hit it too.
 *
 * Returns null when the content-type is fine (the caller really did send an empty body) or when
 * no body was declared — in both cases the schema error is the honest answer. Pure + total.
 */
export function explainDroppedBody(
  contentType: string | undefined,
  contentLength: string | undefined,
): string | null {
  const declared = Number(contentLength);
  // No declared body (or chunked, where we can't tell) → don't claim a problem we can't prove.
  if (!Number.isFinite(declared) || declared <= 0) return null;

  const raw = (contentType ?? '').trim();
  if (raw === '') return 'the request declared a body but sent no content-type header';

  const mediaTypes = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (mediaTypes.length > 1) {
    return `content-type "${raw}" lists ${mediaTypes.length} media types; send exactly one. ` +
      'This is usually a client adding its own content-type on top of an SDK that already sets ' +
      'one — the two case-different header keys get combined into a single comma-joined value.';
  }
  if (!JSON_MEDIA_TYPE.test(mediaTypes[0].split(';')[0].trim())) {
    return `content-type "${raw}" is not a JSON media type`;
  }
  return null;
}

/**
 * THE ONE input gate for every paid tool channel (SEC-09, OPS-AUDIT-REMEDIATION-MEDIUM-W1
 * / Ch3). Extracted from the /x402 route rather than reimplemented, so `/x402/*` and
 * okx.ai `/a2mcp/*` cannot drift — a second validator is a second thing to forget.
 *
 * WHY THE ORDER MATTERS, twice over:
 *  1. `rawBodyKeys` is counted BEFORE `validate()`. Ajv runs with `useDefaults`, so it
 *     MUTATES `input` with schema defaults even on a failing validation — reading the
 *     count afterwards reports a body that "has keys" when the caller sent none.
 *  2. The dropped-body check runs BEFORE and INDEPENDENTLY OF schema validation. Nesting
 *     it inside the `!validate(input)` branch only catches routes whose schema has a
 *     REQUIRED field; on all-optional schemas an unparsed body validates clean as `{}`
 *     and the route serves a DEFAULTS-ONLY result — on /x402 that meant CHARGING for it
 *     (OPS-X402-TRADE-CALL-CONTENT-TYPE-W1 found 3 of 7 payable routes affected). On
 *     /a2mcp/* the same shape returned a wrong-but-plausible verdict to a paying partner.
 *
 * Returns a REASON, not a response: each channel renders its own error envelope/codes.
 */
export type ToolInputRejection =
  | { kind: 'dropped_body'; reason: string; rawBodyKeys: number }
  | { kind: 'invalid_input'; errors: unknown[]; rawBodyKeys: number };

export type ToolInputResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; rejection: ToolInputRejection };

/** ajv.compile is expensive; one compiled validator per tool, built on first use. */
const validatorCache = new Map<string, ValidateFunction>();

function validatorFor(tool: HttpTool): ValidateFunction | null {
  const cached = validatorCache.get(tool);
  if (cached) return cached;
  const spec = BAZAAR_ROUTES[tool];
  if (!spec) return null;
  const v = ajv.compile(spec.inputSchema);
  validatorCache.set(tool, v);
  return v;
}

export function validateToolInput(
  tool: HttpTool,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): ToolInputResult {
  const rawBodyKeys = Object.keys((body ?? {}) as Record<string, unknown>).length;

  const one = (h: string | string[] | undefined): string | undefined =>
    Array.isArray(h) ? h.join(', ') : h;
  const droppedBody = rawBodyKeys === 0
    ? explainDroppedBody(one(headers['content-type']), one(headers['content-length']))
    : null;
  if (droppedBody) return { ok: false, rejection: { kind: 'dropped_body', reason: droppedBody, rawBodyKeys } };

  const input: Record<string, unknown> = { ...((body ?? {}) as Record<string, unknown>) };
  const validate = validatorFor(tool);
  // No declared schema for this tool → nothing to enforce; pass the body through
  // unchanged (same behaviour as before this gate existed).
  if (!validate) return { ok: true, input };
  if (!validate(input)) {
    return { ok: false, rejection: { kind: 'invalid_input', errors: (validate.errors ?? []) as unknown[], rawBodyKeys } };
  }
  return { ok: true, input };
}

/** Log every /x402 request's method + final status + UA (so the Bazaar crawler's probe is observable). */
function logCrawl(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const ua = String(req.headers['user-agent'] || '').slice(0, 80);
    // Count BOTH dialects: v2 clients send `Payment-Signature`, v1 sends `x-payment`.
    // Reading only v1 logged every real v2 payment as `paid=n` — i.e. as an unpaid crawl,
    // the observability half of the v1/v2 defect (OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1).
    const v2 = req.headers['payment-signature'];
    const paid = v2 || req.headers['x-payment'] ? 'y' : 'n';
    const dialect = v2 ? 'v2' : (req.headers['x-payment'] ? 'v1' : '-');
    console.log(`[x402-route] ${req.method} ${req.path} status=${res.statusCode} paid=${paid} dialect=${dialect} ua="${ua}"`);
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
      // OPS-QUOTA-EXHAUSTION-NOTICE-W1: forwards the license, like every sibling. The old
      // comment claimed parity with the MCP handler — true, but both were wrong: without it a
      // PAID x402 caller ran as keyless free and was metered against (and eventually refused
      // by) the free 100/mo cap on a shared IP bucket. Parity is preserved; both are fixed.
      return getMarketRegime({
        coin: input.coin as string,
        timeframe: input.timeframe as string,
        exchange: input.exchange as ExchangeId,
        license,
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
    // The compiled validator now lives in `validateToolInput`'s per-tool cache (SEC-09),
    // so the route no longer compiles its own — one derivation, one compile.

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
      //
      // The gate itself now lives in `validateToolInput` (SEC-09) so the okx.ai /a2mcp/*
      // channel enforces the IDENTICAL contract instead of a second copy. Both ordering
      // subtleties — count-before-validate, and dropped-body-before-schema — are
      // documented there and are the whole reason this is one function.
      const gate = validateToolInput(tool, req.body, req.headers as Record<string, string | string[] | undefined>);
      if (!gate.ok) {
        const rej = gate.rejection;
        if (rej.kind === 'dropped_body') {
          console.warn(
            `[x402-route] dropped-body REJECT for ${routePath} paid=y ` +
            `content-type=${JSON.stringify(req.headers['content-type'] ?? null)} ` +
            `content-length=${JSON.stringify(req.headers['content-length'] ?? null)} ` +
            `reason=${JSON.stringify(rej.reason)}`,
          );
          // Never a schema error here — the body never reached the validator. No settlement is
          // attempted: this precedes tryClaimPayment and settleX402Async, so the caller is not charged.
          return res.status(400).json({
            error: 'invalid_content_type',
            code: 'X402_HTTP_INVALID_CONTENT_TYPE',
            message: `Payment verified, but the request body could not be read: ${rej.reason}`,
            suggested_fix:
              'Send the body as JSON under a single `content-type: application/json` header, then ' +
              'retry. You were NOT charged — no settlement was attempted for this request.',
          });
        }
        // A PAID, VERIFIED request that we then refuse must NEVER be silent. Both 2026-07-29
        // Circle Gateway failures were invisible here — the only trace was `status=400 paid=y`
        // with no reason (OPS-CIRCLE-GATEWAY-PAY-REGRESSION-W1).
        console.warn(
          `[x402-route] input-validation REJECT for ${routePath} paid=y ` +
          `content-type=${JSON.stringify(req.headers['content-type'] ?? null)} ` +
          `body-keys=${rej.rawBodyKeys}` +
          ` errors=${JSON.stringify(rej.errors.slice(0, 3))}`,
        );
        return res.status(400).json({
          error: 'invalid_input',
          code: 'X402_HTTP_INVALID_INPUT',
          details: rej.errors,
          suggested_fix: `Body must satisfy the published JSON Schema for ${tool}.`,
        });
      }
      const input: Record<string, unknown> = gate.input;

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
      // (already-claimed nonce) → 402 without serving/settling. Fail-safe on DB error too, per
      // default-deny on the paid path — but the two refusals are DIFFERENT ON THE WIRE, which is
      // the whole reason the outcome is a union and not a boolean:
      //   `'ALREADY_CLAIMED'` → 402 `X402_PAYMENT_REPLAY`     — terminal; do NOT retry (:460-468)
      //   `'INDETERMINATE'`   → 402 `X402_CLAIM_UNAVAILABLE`
      //                              + `retryable: true`      — transient; DO retry (:444-458)
      // A client that cannot tell them apart converts our database blip into their permanent
      // failure. _(Corrected REVENUE-METER-TRUTH-W6 CH7 — this said "tryClaimPayment returns
      // false → reject", a boolean retired by OPS-ZERO-VS-UNKNOWN-W3, sitting 13 lines above the
      // comment at :441-442 that explicitly forbids the two-state reading.)_
      const settlementReq = (pendingSettlement.requirements ?? {}) as { amount?: unknown };
      const paidAmount = typeof settlementReq.amount === 'string'
        ? settlementReq.amount
        : settlementReq.amount != null ? String(settlementReq.amount) : '';
      const nonce = extractPaymentNonce(pendingSettlement.paymentPayload);
      // OPS-X402-WALLET-ATTRIBUTION-W1: capture the ERC-3009 payer wallet additively (fail-open —
      // undefined → the EMPTY STRING, never affects the claim decision). Base/USDC rail (HTTP /x402).
      // _(Corrected 2026-08-04 REVENUE-METER-TRUTH-W1 CH1 — this said "NULL column". The store writes
      // `payerWallet ?? ''` (x402-idempotency-store.ts:113) and the column is `NOT NULL DEFAULT ''`
      // per SEC-49, so the NULL described here has never existed. Read-side filters written against
      // that phantom NULL let 4 unattributable rows count as a paying wallet.)_
      const payerWallet = extractPayerWallet(pendingSettlement.paymentPayload);
      // OPS-ZERO-VS-UNKNOWN-W3: THREE outcomes. A truthy/falsy test here would silently
      // reintroduce the exact conflation this wave removes, so the outcome is matched by name.
      const outcome = await tryClaimPayment(nonce ?? '', tool, paidAmount, payerWallet, RAIL_BASE_USDC);
      if (outcome === 'INDETERMINATE') {
        // We could not determine claim state, so we refuse — never double-settle. But we say SO,
        // because the client's retry decision depends on it: "already used" is terminal and a
        // well-built client will not retry, which would convert a transient fault into a
        // permanent failure. Static message + a stable machine-readable code (SEC-50 precedent);
        // the underlying error is logged server-side only, never on the wire.
        console.error(`[x402-route] claim INDETERMINATE for ${routePath} — refusing (payment NOT settled, proof still spendable)`);
        res.status(402).json({
          x402Version: 2,
          error: 'Payment Required',
          code: 'X402_CLAIM_UNAVAILABLE',
          message: 'Could not verify payment state right now. Your payment proof was NOT consumed — retry shortly.',
          retryable: true,
        });
        return;
      }
      if (outcome === 'ALREADY_CLAIMED') {
        console.warn(`[x402-route] payment-replay REJECT for ${routePath} (nonce already claimed)`);
        res.status(402).json({
          x402Version: 2,
          error: 'Payment Required',
          code: 'X402_PAYMENT_REPLAY',
          message: 'This payment proof has already been used; submit a fresh payment.',
        });
        return;
      }

      const ipHash = clientIpHash(req);
      // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: classify this paid request ONCE.
      // A settled x402/a2mcp call is a real tool call (hadRealToolCall:true) and never
      // internal-tier. Stored in the ALS for any in-handler logRequest AND passed
      // explicitly to the logRequest below (which runs AFTER run() resolves, outside the
      // ALS scope). Note: the read-path (getUsageStats) counts ALL paid as genuine
      // regardless of this flag — this is truthful per-row telemetry only.
      const authenticity = classifyTraffic({
        ua: req.headers['user-agent'] as string | undefined,
        ip: clientIp(req),
        hadRealToolCall: true,
        isInternalTier: false,
      });
      try {
        const result = await requestContext.run(
          { license, sessionId: undefined, ipHash, isAutomated: authenticity.is_automated },
          () => callCoreHandler(tool, input, license),
        );

        // Public output == MCP tool output (single source of truth).
        res.json(result);

        // Async settle (R6): fire-and-forget after the response.
        //
        // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-A): every verdict settles, HOLD included —
        // byte-for-byte the same rule as the MCP path in index.ts, which is the point. The two
        // rails previously each carried their own copy of the HOLD skip, so "which verdicts are
        // free" was answerable differently depending on how you called the same tool.
        //
        // Reached only after `res.json(result)`, so an error path still never settles.
        if (pendingSettlement) {
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
            // Explicit — this logRequest runs after run() resolves (outside the ALS).
            isAutomated: authenticity.is_automated,
          });
        } catch { /* best-effort; never blocks the request */ }
      } catch (err: unknown) {
        if (!res.headersSent) {
          // SEC-50 (OPS-AUDIT-REMEDIATION-LOW-W1): the raw upstream message went to the client,
          // which leaks internal paths, hostnames and driver text on a PAID public route. Log it
          // server-side; the wire keeps the machine-readable `code` it already had.
          console.error(
            '[x402-http] handler error:',
            err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err),
          );
          res.status(500).json({
            error: 'internal_error',
            code: 'X402_HTTP_HANDLER_ERROR',
            message: 'An internal error occurred while handling the x402 request.',
          });
        }
      }
    });

    mounted.push(routePath);
  }
  return mounted;
}
