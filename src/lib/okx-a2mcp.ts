/**
 * okx-a2mcp.ts — OKX.AI A2MCP settlement channel (OKX-AI-FIRST-MOVER-W1).
 *
 * ADDITIVE X-Layer x402 acceptance path that lets AlgoVault list its paid signal suite on
 * okx.ai's A2MCP marketplace. Mirrors `x402-facilitator.ts`: env → config → a PURE
 * selection (the unit-test seam) → construct. Ships DARK behind the `OKX_AI_ENABLED`
 * two-flag firewall; Stub-first, so the wave ships regardless of OKX production readiness.
 *
 * RAIL (ratified by Mr.1 2026-06-30 — see vault audits/OKX-AI-FIRST-MOVER-endpoint-truth.md §9):
 * standard x402 `exact` (EIP-3009) on X Layer (`eip155:196`), settled by the OKX MANAGED
 * facilitator (`OKXFacilitatorClient`, `feePayer=true` → OKX pays gas + KYT; NO self-run OKB
 * settler wallet). Token = USDT0 `0x779Ded0c…3736` (EIP-3009 verified on-chain 2026-06-30:
 * `authorizationState()`→0, `name()`="USD₮0", 6-dec). The Base/USDC rail
 * (`x402.ts` / `x402-bazaar.ts` / `x402-http-routes.ts`) is UNTOUCHED — this is a separate,
 * additive channel; only `callCoreHandler` + `HTTP_TOOLS` are REUSED (tool-output parity).
 *
 * TWO-FLAG FIREWALL:
 *   - outer `OKX_AI_ENABLED` ∈ {true,false} (default false). false → `mountOkxA2mcpRoutes`
 *     returns [] → routes never register → prod is byte-identical; flip = instant rollback.
 *   - inner per-tool `channels.a2mcp` in the registry → decides WHICH tools are listed
 *     (the listed set DERIVES from the registry via `okxA2mcpTools()` — no hardcoded list).
 * STUB-FIRST: `OKX_AI_ENABLED=true` but OKX creds / payTo absent → `StubOkxA2mcpProvider`
 *   ([STUB] 402 + [STUB] receipt; the wave's tested surface).
 *
 * LIVE-UNVERIFIED NOTE: the live path is wired against the `@okxweb3/x402-*` v0.1.x .d.ts
 * (typed, compiles) but CANNOT be exercised without OKX dev-portal creds + the manual okx.ai
 * registration (R5, Mr.1). At enablement, confirm the USDT0 asset/domain resolution against
 * `facilitator.getSupported()` before flipping `OKX_AI_ENABLED=true`.
 */
import express, { type Express, type Request, type Response } from 'express';
import {
  XLAYER_NETWORK,
  XLAYER_USDT0,
  XLAYER_USDT0_DECIMALS,
  XLAYER_USDT0_EIP712_NAME,
  A2MCP_PREFIX,
  okxA2mcpTools,
  okxA2mcpPriceUsdt0,
  resolveOkxA2mcpConfig,
  selectOkxA2mcp,
} from './okx-a2mcp-config.js';
import type { OkxA2mcpEnv, OkxA2mcpMode, ResolvedOkxA2mcp } from './okx-a2mcp-config.js';
import { HTTP_TOOLS, callCoreHandler, type HttpTool } from './x402-http-routes.js';
import type { LicenseInfo } from '../types.js';
// OKX managed facilitator (HMAC-signed verify/settle → web3.okx.com). Live path only —
// constructed lazily inside mountLive(), so importing this module is side-effect-free.
import { OKXFacilitatorClient } from '@okxweb3/x402-core';
import { x402ResourceServer, x402HTTPResourceServer } from '@okxweb3/x402-core/server';
import { registerExactEvmScheme } from '@okxweb3/x402-evm/exact/server';
import { paymentMiddlewareFromHTTPServer } from '@okxweb3/x402-express';

// ─────────────────────── extracted PURE config (FUNNEL-FIX-AGENT-X402-NUDGE-W1) ───────────────────────
// The X-Layer constants + env→config→selection + the registry-derived listed set + the price now
// live in the LEAF module `okx-a2mcp-config.ts` — so the SDK-free x402 nudge (`x402-nudge.ts`) can
// import `selectOkxA2mcp`/`okxA2mcpTools`/constants WITHOUT dragging this module's @okxweb3 SDK +
// `x402-http-routes` graph (which imports every tool handler → a consumer init cycle). Re-exported
// here verbatim so existing importers (index.ts, the okx test) are byte-unchanged. The boot path
// (`buildOkxHttpResourceServer`/`registerExactEvmScheme`/`mountLive`) is UNTOUCHED.
export {
  XLAYER_NETWORK,
  XLAYER_USDT0,
  XLAYER_USDT0_DECIMALS,
  XLAYER_USDT0_EIP712_NAME,
  OKX_FACILITATOR_DEFAULT_URL,
  A2MCP_PREFIX,
  okxA2mcpTools,
  okxA2mcpPriceUsdt0,
  resolveOkxA2mcpConfig,
  selectOkxA2mcp,
} from './okx-a2mcp-config.js';
export type { OkxA2mcpEnv, OkxA2mcpConfig, OkxA2mcpMode, ResolvedOkxA2mcp } from './okx-a2mcp-config.js';

// ─────────────────────── provider interface + Stub (the tested surface) ───────────────────────
export interface OkxChallenge {
  status: number;
  headerName: string;
  header: string;
  body: unknown;
}
export interface OkxSettleReceipt {
  settled: boolean;
  mode: OkxA2mcpMode;
  tx?: string;
  reason?: string;
}

/** The settlement provider contract (OKXPaymentInterface). Both Stub + Live conform. */
export interface OkxA2mcpProvider {
  readonly mode: OkxA2mcpMode;
  /** Build the x402-v2 402 challenge (eip155:196 / USDT0 / price / payTo) for a tool. */
  buildChallenge(tool: string): OkxChallenge;
  /** Verify + settle an inbound payment. Stub returns a synthetic [STUB] receipt. */
  settle(tool: string, headers: Record<string, string | undefined>): Promise<OkxSettleReceipt>;
}

/** x402 tier for a paid caller (identical to what resolveLicense returns on a paid x402 call). */
const X402_LICENSE: LicenseInfo = { tier: 'x402', key: null };

/** Build a realistic x402-v2 402 body for an X Layer / USDT0 route (marker-tagged for stub). */
function buildXLayer402Body(tool: string, payTo: string, stub: boolean): Record<string, unknown> {
  const atomic = String(Math.round(okxA2mcpPriceUsdt0(tool) * 10 ** XLAYER_USDT0_DECIMALS));
  return {
    x402Version: 2,
    error: 'Payment Required',
    ...(stub ? { _stub: true } : {}),
    resource: {
      url: `https://api.algovault.com${A2MCP_PREFIX}/${tool}`,
      description: `${stub ? '[STUB] ' : ''}${tool} — AlgoVault signal lookup (okx.ai A2MCP)`,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: XLAYER_NETWORK,
        maxAmountRequired: atomic,
        asset: XLAYER_USDT0,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: XLAYER_USDT0_EIP712_NAME },
      },
    ],
  };
}

/**
 * Realistic [STUB] provider — no network, no creds. This is the DEFAULT dark behavior
 * (OKX_AI_ENABLED=true but unprovisioned) and the wave's unit-tested surface.
 */
export class StubOkxA2mcpProvider implements OkxA2mcpProvider {
  readonly mode = 'stub' as const;
  constructor(private readonly payTo: string = '0xSTUB000000000000000000000000000000000000') {}

  buildChallenge(tool: string): OkxChallenge {
    const body = buildXLayer402Body(tool, this.payTo, true);
    return {
      status: 402,
      headerName: 'PAYMENT-REQUIRED',
      header: Buffer.from(JSON.stringify(body)).toString('base64'),
      body,
    };
  }

  async settle(_tool: string, headers: Record<string, string | undefined>): Promise<OkxSettleReceipt> {
    const paid = Boolean(headers['x-payment'] || headers['payment-signature']);
    if (!paid) return { settled: false, mode: 'stub', reason: 'payment_required' };
    return { settled: true, mode: 'stub', tx: `0xSTUB${'0'.repeat(59)}` };
  }
}

// ─────────────────────── mount (the effect boundary) ───────────────────────
/**
 * a2mcp routes reuse the SAME core handlers as the Base x402 routes (output parity). The
 * canonical `get_trade_call` maps to the `get_trade_signal` handler (the HTTP_TOOLS keying,
 * per Cowork A2 2026-05-29); every other a2mcp tool is its own HTTP_TOOLS entry.
 */
function toHttpTool(tool: string): HttpTool | undefined {
  const alias = tool === 'get_trade_call' ? 'get_trade_signal' : tool;
  return (HTTP_TOOLS as readonly string[]).includes(alias) ? (alias as HttpTool) : undefined;
}

/**
 * Mount the okx.ai A2MCP X-Layer routes on the Express app — ONLY when OKX_AI_ENABLED=true.
 * Async because the LIVE path pre-initializes the x402 resource server (validates the scheme
 * config + syncs the facilitator) before mounting. **Boot-safe:** any LIVE-mount failure is
 * caught → a2mcp stays DARK, the app never crash-loops (the two-flag firewall's intent; an
 * uncaught async init throw crash-looped prod once — OKX-AI-FIRST-MOVER incident 2026-07-01).
 * Returns the mounted paths ([] when off / stub-empty / live-failed → prod byte-identical).
 */
export async function mountOkxA2mcpRoutes(app: Express, env: OkxA2mcpEnv = process.env): Promise<string[]> {
  const resolved = selectOkxA2mcp(resolveOkxA2mcpConfig(env));
  if (!resolved.active) return [];
  const tools = okxA2mcpTools();
  if (resolved.mode === 'live') {
    try {
      return await mountLive(app, tools, resolved);
    } catch (err: unknown) {
      console.error(
        '[okx-a2mcp] LIVE mount failed — leaving a2mcp DARK (app boot unaffected):',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }
  console.warn(
    '[STUB] OKX_AI_ENABLED=true but OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE/OKX_A2MCP_PAYTO missing — ' +
      'mounting [STUB] a2mcp routes (no real settlement). Provision creds + payTo to go live.',
  );
  return mountStub(app, tools, new StubOkxA2mcpProvider());
}

/** Dark [STUB] routes: GET → [STUB] 402; POST with any payment header → run the core handler. */
function mountStub(app: Express, tools: string[], provider: StubOkxA2mcpProvider): string[] {
  const mounted: string[] = [];
  for (const tool of tools) {
    const ht = toHttpTool(tool);
    if (!ht) continue;
    const route = `${A2MCP_PREFIX}/${tool}`;
    app.get(route, (_req: Request, res: Response) => {
      const c = provider.buildChallenge(tool);
      res.setHeader(c.headerName, c.header);
      res.status(c.status).json(c.body);
    });
    app.post(route, express.json(), async (req: Request, res: Response) => {
      try {
        const receipt = await provider.settle(tool, req.headers as Record<string, string | undefined>);
        if (!receipt.settled) {
          const c = provider.buildChallenge(tool);
          res.setHeader(c.headerName, c.header);
          res.status(c.status).json(c.body);
          return;
        }
        const result = await callCoreHandler(ht, (req.body ?? {}) as Record<string, unknown>, X402_LICENSE);
        res.setHeader(
          'PAYMENT-RESPONSE',
          Buffer.from(JSON.stringify({ status: 'settled', _stub: true, transaction: receipt.tx })).toString('base64'),
        );
        res.json(result);
      } catch (err: unknown) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'internal_error', code: 'OKX_A2MCP_STUB_ERROR', message: err instanceof Error ? err.message : 'handler failed' });
        }
      }
    });
    mounted.push(route);
  }
  return mounted;
}

/**
 * Build the x402 HTTP resource server for the a2mcp routes. **Registers the `exact` EVM scheme
 * for X Layer** — the step whose omission threw `RouteConfigurationError: No scheme
 * implementation registered for "exact" on network "eip155:196"` and crash-looped the server
 * (OKX-AI-FIRST-MOVER incident 2026-07-01). Exported so the boot-test can `initialize()` it with
 * a fake facilitator and prove it no longer throws. `facilitator` is any `FacilitatorClient`.
 */
export function buildOkxHttpResourceServer(
  facilitator: ConstructorParameters<typeof x402ResourceServer>[0],
  tools: string[],
  payTo: string,
): x402HTTPResourceServer {
  const server = new x402ResourceServer(facilitator);
  registerExactEvmScheme(server, { networks: [XLAYER_NETWORK] });
  const routes: ConstructorParameters<typeof x402HTTPResourceServer>[1] = {};
  for (const tool of tools) {
    if (!toHttpTool(tool)) continue;
    routes[`POST ${A2MCP_PREFIX}/${tool}`] = {
      accepts: [
        {
          scheme: 'exact',
          network: XLAYER_NETWORK,
          payTo,
          // Money (string) — ExactEvmScheme's MoneyParser resolves the USDT0 AssetAmount for eip155:196.
          price: String(okxA2mcpPriceUsdt0(tool)),
          maxTimeoutSeconds: 300,
          extra: { asset: XLAYER_USDT0, name: XLAYER_USDT0_EIP712_NAME },
        },
      ],
      description: `${tool} — AlgoVault signal lookup (okx.ai A2MCP)`,
      mimeType: 'application/json',
    };
  }
  return new x402HTTPResourceServer(server, routes);
}

/**
 * LIVE routes: the OKX managed facilitator gates each route (verify+settle on X Layer), then the
 * SAME core handler runs (output parity). Pre-`initialize()`s (validates the scheme/route config +
 * syncs the facilitator's supported kinds) so a misconfig or unreachable facilitator throws HERE
 * and is caught by `mountOkxA2mcpRoutes` (→ DARK, no crash). Still LIVE-UNVERIFIED end-to-end
 * until a real buyer settles USDT0 on X Layer (R5/R6).
 */
async function mountLive(app: Express, tools: string[], resolved: ResolvedOkxA2mcp): Promise<string[]> {
  const facilitator = new OKXFacilitatorClient({
    apiKey: resolved.apiKey!,
    secretKey: resolved.secretKey!,
    passphrase: resolved.passphrase!,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    // syncSettle=true → the facilitator waits for on-chain confirmation and returns status="success".
    syncSettle: true,
  });
  const httpServer = buildOkxHttpResourceServer(facilitator, tools, resolved.payTo!);
  // Validate scheme/route config + sync supported kinds NOW (throws on misconfig → caller keeps DARK).
  await httpServer.initialize();
  // Already initialized → mount with syncFacilitatorOnStart=false (no duplicate boot sync). The
  // middleware gates the configured routes (unpaid → 402; paid → next()); non-matching requests
  // pass straight through, so app-level use() leaves the Base rail unaffected.
  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  const mounted: string[] = [];
  for (const tool of tools) {
    const ht = toHttpTool(tool);
    if (!ht) continue;
    const route = `${A2MCP_PREFIX}/${tool}`;
    // GET → 402 discovery challenge. Crawlers/validators (à la the CDP Bazaar indexer) probe the
    // resource URL with a GET and require a 402, not a 404, to index/validate it. The OKX middleware
    // only gates the configured POST route, so a GET falls through to here — we emit the same
    // x402-v2 challenge (eip155:196 / USDT0 / price / payTo) via the shared builder. Paid invocation
    // is still POST-only.
    app.get(route, (_req: Request, res: Response) => {
      const body = buildXLayer402Body(tool, resolved.payTo!, false);
      try {
        res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
      } catch {
        /* body still carries the payload */
      }
      res.status(402).json(body);
    });
    app.post(route, express.json(), async (req: Request, res: Response) => {
      try {
        const result = await callCoreHandler(ht, (req.body ?? {}) as Record<string, unknown>, X402_LICENSE);
        res.json(result);
      } catch (err: unknown) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'internal_error', code: 'OKX_A2MCP_HANDLER_ERROR', message: err instanceof Error ? err.message : 'handler failed' });
        }
      }
    });
    mounted.push(route);
  }
  return mounted;
}
