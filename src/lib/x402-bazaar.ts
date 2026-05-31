/**
 * Bazaar discovery metadata for AlgoVault's paid x402 MCP tools.
 * (X402-CDP-BAZAAR-DISCOVERY-W1)
 *
 * The CDP x402 Bazaar catalogs a route the first time a real settle completes
 * through the CDP Facilitator with accepted discovery-extension metadata. CDP's
 * semantic search ranks by buyer reach + transaction volume + recency +
 * METADATA QUALITY (rich descriptions, input/output schemas, examples) — so the
 * declarations below are outcome-framed for autonomous-agent discovery, never
 * bare endpoint names.
 *
 * DATA INTEGRITY (THE LAW): descriptions/examples expose ONLY public PFE framing.
 * No `outcome_return_pct`, Phase-E, or internal-wave tokens — enforced by
 * `assertNoBazaarLeak()` at declaration time + a CI test.
 *
 * Scope: ONLY the 3 actually-402-gated tools (TOOL_PRICING) are declared.
 * `get_trade_call` is intentionally FREE (North Star: free-tier generosity) and
 * is therefore NOT discoverable — confirmed by Cowork (A2, 2026-05-29).
 *
 * Input schemas mirror the live zod schemas in src/index.ts; output examples
 * mirror the live public response shapes (probed 2026-05-29, leak-verified).
 */
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

/**
 * Tokens that must never appear in any public Bazaar description/example.
 * Lower-cased substring match. Mirrors the Data-Integrity "internal-only" set.
 */
export const FORBIDDEN_BAZAAR_TOKENS: readonly string[] = [
  'outcome_return_pct',
  'outcome_price',
  'phase e',
  'phase-e',
  'outcome wr',
  'outcome win',
  'internal-only',
] as const;

/** All 17 supported derivatives venues (mirrors TRADE_CALL_SCHEMA / regime enum). */
const VENUE_ENUM = [
  'HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX', 'GATE', 'MEXC',
  'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT',
] as const;

export interface BazaarRouteSpec {
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Input example — must validate against `inputSchema` (strict). */
  example: Record<string, unknown>;
  output: { example: unknown };
}

/**
 * The paid, discoverable tools. Keys MUST match TOOL_PRICING in x402.ts.
 */
export const BAZAAR_ROUTES: Record<string, BazaarRouteSpec> = {
  get_trade_signal: {
    toolName: 'get_trade_signal',
    description:
      'Composite BUY / SELL / HOLD trade verdict for a perpetual-futures market, with a 0–100 confidence score, the current market regime, live price, and multi-factor reasoning (funding rate, open-interest change, 24h volume, trend persistence, breakout state) across 17 derivatives venues. Verdict accuracy is independently auditable via a Merkle-anchored track record on Base. When the queried market is a HOLD, returns the nearest higher-confidence setups so an agent can route to an actionable market.',
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', maxLength: 20, description: 'Asset symbol, e.g. BTC, ETH, SOL, XRP.' },
        timeframe: {
          type: 'string',
          enum: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'],
          default: '15m',
          description: 'Candle timeframe for the verdict.',
        },
        exchange: {
          type: 'string',
          enum: [...VENUE_ENUM],
          default: 'BINANCE',
          description: 'Derivatives venue to evaluate.',
        },
        includeReasoning: { type: 'boolean', default: true, description: 'Include human-readable reasoning.' },
      },
      required: ['coin'],
      additionalProperties: false,
    },
    example: { coin: 'BTC', timeframe: '4h', exchange: 'BINANCE', includeReasoning: true },
    output: {
      example: {
        call: 'BUY',
        confidence: 72,
        price: 73737.9,
        indicators: {
          funding_rate: 0.0000635,
          funding_state: 'NORMAL',
          oi_change_pct: 1.4,
          volume_24h: 9799352510,
          trend_persistence: 'HIGH',
          breakout_pending: 'ACTIVE',
        },
        regime: 'TRENDING_UP',
        reasoning: 'Trending regime with upward bias; funding mild; open interest building; breakout active.',
        coin: 'BTC',
        timeframe: '4h',
      },
    },
  },

  scan_funding_arb: {
    toolName: 'scan_funding_arb',
    description:
      'Ranked cross-venue funding-rate arbitrage scanner: in a single call it scans hundreds of perpetual-futures pairs and surfaces those whose funding spread between venues exceeds a caller-set basis-point threshold. Each opportunity returns the per-venue funding rates, the best long/short venue pair, the spread in bps, the annualized capture, a conviction grade, and the next funding times.',
    inputSchema: {
      type: 'object',
      properties: {
        minSpreadBps: {
          type: 'number',
          minimum: 0,
          maximum: 10000,
          default: 5,
          description: 'Minimum funding spread to report, in basis points (0–10000).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 10,
          description: 'Maximum ranked opportunities to return (1–200).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    example: { minSpreadBps: 5, limit: 10 },
    output: {
      example: {
        opportunities: [
          {
            coin: 'BTC',
            rates: { BINANCE: 0.0000635, BYBIT: 0.000182 },
            bestArb: {
              longVenue: 'BINANCE',
              shortVenue: 'BYBIT',
              spreadBps: 11.9,
              annualizedPct: 104.2,
              direction: 'Long Binance / Short Bybit',
              urgency: 'SOON',
              rankScore: 78.4,
            },
            conviction: 'HIGH',
            nextFundingTimes: { BINANCE: 1780070400, BYBIT: 1780070400 },
          },
        ],
        scannedPairs: 230,
      },
    },
  },

  get_market_regime: {
    toolName: 'get_market_regime',
    description:
      'Market-regime classifier for a perpetual-futures market: returns the regime (e.g. TRENDING_UP / TRENDING_DOWN / RANGING) with a 0–100 confidence, ADX-based trend metrics (strength, slope), volatility state, price structure, cross-venue funding sentiment, and a plain-language strategy suggestion (trend-following vs mean-reversion, position-sizing guidance) so an agent can pick the right playbook before entering.',
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', maxLength: 20, description: 'Asset symbol, e.g. BTC, ETH, SOL.' },
        timeframe: {
          type: 'string',
          enum: ['1h', '4h', '1d'],
          default: '4h',
          description: 'Candle timeframe for regime classification.',
        },
        exchange: {
          type: 'string',
          enum: [...VENUE_ENUM],
          default: 'HL',
          description: 'Derivatives venue to evaluate.',
        },
      },
      required: ['coin'],
      additionalProperties: false,
    },
    example: { coin: 'BTC', timeframe: '4h', exchange: 'BINANCE' },
    output: {
      example: {
        regime: 'TRENDING_UP',
        confidence: 65,
        metrics: {
          adx: 31.1,
          adx_interpretation: 'Strong trend',
          trend_strength: 'MODERATE',
          cross_venue_funding_sentiment: 'NEUTRAL',
        },
        suggestion: 'Moderate uptrend — favor trend-following; conservative-to-normal position sizing.',
        coin: 'BTC',
        timeframe: '4h',
      },
    },
  },
};

/**
 * Throws if any forbidden internal token leaks into a public Bazaar payload.
 * Fail-loud per Data-Integrity LAW. `ctx` identifies the offending route/field.
 */
export function assertNoBazaarLeak(payload: unknown, ctx: string): void {
  const haystack = JSON.stringify(payload ?? '').toLowerCase();
  for (const token of FORBIDDEN_BAZAAR_TOKENS) {
    if (haystack.includes(token)) {
      throw new Error(`[bazaar] Data-Integrity leak in ${ctx}: forbidden token "${token}"`);
    }
  }
}

/** Is this tool a paid, Bazaar-discoverable route? */
export function isDiscoverableTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(BAZAAR_ROUTES, toolName);
}

/**
 * Public base host for the HTTP x402 resource endpoints — the Bazaar-discoverable
 * URLs. Overridable via env for Sepolia/staging; defaults to the live MCP host.
 */
export const X402_HTTP_BASE = process.env.X402_PUBLIC_BASE_URL || 'https://api.algovault.com';

/** Canonical HTTP x402 resource URL for a paid tool — the route the Bazaar lists. */
export function bazaarResourceUrl(toolName: string): string {
  return `${X402_HTTP_BASE}/x402/${toolName}`;
}

/** Public, outcome-framed description for a tool's HTTP resource (used on the 402 + Bazaar). */
export function bazaarRouteDescription(toolName: string): string | undefined {
  return BAZAAR_ROUTES[toolName]?.description;
}

/**
 * Build the `extensions` object for a tool's payment requirements, declaring the
 * CDP Bazaar discovery metadata. Returns `{}` for non-discoverable tools.
 * Runs the leak guard over the full declared extension (fail-loud).
 *
 * X402-BAZAAR-HTTP-REDECLARE-W1: switched from MCP-type (`info.input.type:"mcp"`)
 * to **HTTP body-discovery** (`DeclareBodyDiscoveryExtensionConfig`, `bodyType:"json"`).
 * The CDP public Bazaar catalog is HTTP-type only (live-verified: 0 of 41,559 resources
 * are `type:"mcp"`), so the MCP-typed declaration settled (`EXTENSION-RESPONSES:processing`)
 * but never listed. Same outcome-framed descriptions/schemas/examples are reused; the
 * resource identity is now the HTTP route URL (see `bazaarResourceUrl`). `method` is
 * omitted at declaration (the server extension sets it from the live POST request);
 * `description` rides on the 402 resource, not the discovery config.
 */
export function declareBazaarRoute(toolName: string): Record<string, unknown> {
  const spec = BAZAAR_ROUTES[toolName];
  if (!spec) return {};
  assertNoBazaarLeak({ d: spec.description, e: spec.example, o: spec.output }, `route ${toolName}`);
  const ext = declareDiscoveryExtension({
    bodyType: 'json',
    input: spec.example,
    inputSchema: spec.inputSchema,
    output: spec.output,
  });
  // The 3 x402 resource routes are POST. declareDiscoveryExtension strips `method`
  // (the SDK expects `bazaarResourceServerExtension.enrichDeclaration` to set it from
  // the live request inside the x402ResourceServer pipeline). Our Express 402 path
  // bypasses that pipeline, so bake method=POST here: the declared schema ALREADY
  // requires `method` (enum POST/PUT/PATCH) — without `info.input.method` the
  // declaration is self-inconsistent and CDP returns EXTENSION-RESPONSES: rejected.
  const bz = (ext as { bazaar?: { info?: { input?: { type?: string; method?: string } } } }).bazaar;
  if (bz?.info?.input && bz.info.input.type === 'http') {
    bz.info.input.method = 'POST';
  }
  assertNoBazaarLeak(ext, `declared extension ${toolName}`);
  return ext;
}
