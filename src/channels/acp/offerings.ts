/**
 * offerings.ts — Virtuals ACP offering definitions + requirement schemas (P1-ACP-SELLER-SEED).
 *
 * The launch set of paid AlgoVault offerings on Virtuals ACP. Each offering maps a
 * buyer-facing offering NAME → an existing HTTP_TOOLS handler (the reuse seam) + a draft-07
 * JSON Schema for the requirement payload (ajv-validated by the worker before setBudget).
 *
 * DUAL ROLE:
 *   1. The Source-of-Truth Mr.1 copy-pastes into the app.virtuals.io Seller profile
 *      (docs/RUNBOOK-VIRTUALS-ACP-ONBOARDING.md) — name + description + requirement schema.
 *   2. The worker's offering→tool dispatch map: the seller reads back the offering name via
 *      `session.job?.description` (set by the buyer's createJobFromOffering) and looks it up here.
 *
 * DATA + TYPES ONLY — imports NO runtime handler (cycle-free), mirrors feature-registry.ts.
 * The acp-flagged tool SET lives in the registry (`channels.acp`); this module owns the SURFACE
 * (offering name + schema + tool mapping) LOCALLY. A coverage canary (tests/unit) asserts every
 * `channels.acp` tool has an offering here — the channel-derives-set-from-registry pattern: the
 * registry decides membership, the consumer decides presentation, the canary enforces no-drift.
 *
 * Buyer-facing copy uses the canonical tool name `get_trade_call` (NEVER the back-compat alias
 * `get_trade_signal`); the alias is only the internal HTTP_TOOLS dispatch key.
 */
import type { HttpTool } from '../../lib/x402-http-routes.js';

/** Virtuals ACP SLA floor (SDK `MIN_SLA_MINS`). Signal lookups are sub-second/synchronous. */
export const ACP_SLA_MINUTES = 5;

export interface AcpOffering {
  /** Buyer-facing offering name. MUST match the name registered on the Virtuals profile —
   *  the seller reads it back via `session.job?.description` to dispatch. */
  name: string;
  /** Canonical AlgoVault tool this offering fulfils (public copy uses this, not the alias). */
  canonicalTool: string;
  /** The HTTP_TOOLS handler key `callCoreHandler` dispatches on (get_trade_call → get_trade_signal). */
  httpTool: HttpTool;
  /** One-line TDQS-grade description mirroring the live MCP tool description. */
  description: string;
  /** Draft-07 JSON Schema for the job requirement payload (ajv-validated before setBudget). */
  requirementSchema: Record<string, unknown>;
  /** SLA in minutes (Virtuals floor = 5). */
  slaMinutes: number;
}

export const ACP_OFFERINGS: readonly AcpOffering[] = Object.freeze([
  {
    name: 'AlgoVault Trade Call',
    canonicalTool: 'get_trade_call',
    httpTool: 'get_trade_signal',
    description:
      'Composite perp trade verdict (BUY / SELL / HOLD) with confidence score and market regime for a crypto asset, aggregated across 5 perp venues. Read-only; on-chain Merkle-verified track record.',
    requirementSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      required: ['coin'],
      properties: {
        coin: { type: 'string', minLength: 1, maxLength: 20, description: 'Asset ticker, e.g. BTC, ETH, SOL.' },
        timeframe: { type: 'string', description: 'Candle timeframe (e.g. 15m, 1h, 4h, 1d). Defaults to 1h.' },
        exchange: { type: 'string', description: 'Optional perp venue override (e.g. BINANCE, BYBIT, HL).' },
      },
    },
    slaMinutes: ACP_SLA_MINUTES,
  },
  {
    name: 'AlgoVault Market Scan',
    canonicalTool: 'scan_trade_calls',
    httpTool: 'scan_trade_calls',
    description:
      'Ranked multi-asset scan of actionable perp trade calls across the venue universe — verdict, confidence and regime per asset. Read-only.',
    requirementSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        topN: { type: 'integer', minimum: 1, maximum: 50, description: 'How many top-ranked assets to score.' },
        timeframe: { type: 'string', description: 'Candle timeframe (default 1h).' },
        exchange: { type: 'string', description: 'Optional venue filter.' },
        rankBy: { type: 'string', description: 'Universe-selection lens (default oi).' },
        minConfidence: { type: 'number', minimum: 0, maximum: 100, description: 'Minimum confidence filter.' },
        includeHolds: { type: 'boolean', description: 'Include HOLD verdicts in the result.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max rows returned.' },
      },
    },
    slaMinutes: ACP_SLA_MINUTES,
  },
  {
    name: 'AlgoVault Funding Arb',
    canonicalTool: 'scan_funding_arb',
    httpTool: 'scan_funding_arb',
    description:
      'Cross-venue perpetual funding-rate arbitrage scanner — ranked spread opportunities with urgency and conviction. Read-only.',
    requirementSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        minSpreadBps: { type: 'number', minimum: 0, description: 'Minimum funding spread in basis points (default 5).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max opportunities returned (default 10).' },
      },
    },
    slaMinutes: ACP_SLA_MINUTES,
  },
]);

/** Resolve an offering by its buyer-facing name (== `session.job?.description`). */
/** Normalize an offering name for matching — case/space/underscore-insensitive — so the worker
 *  tolerates the platform's registration naming (e.g. "AlgoVault Trade Call" registered as
 *  "algovault_tradecall" / "algoVault_MarketScan"). The buyer's job.description is matched via this. */
export function normalizeOfferingName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function offeringByName(name: string | null | undefined): AcpOffering | undefined {
  if (!name) return undefined;
  const exact = ACP_OFFERINGS.find((o) => o.name === name);
  if (exact) return exact;
  const norm = normalizeOfferingName(name);
  return ACP_OFFERINGS.find((o) => normalizeOfferingName(o.name) === norm);
}

/**
 * The canonical tools that HAVE an ACP offering here — the surface-coverage canary target.
 * A `channels.acp`-flagged registry tool with no entry in this set fails the coverage test.
 */
export function acpOfferedTools(): string[] {
  return ACP_OFFERINGS.map((o) => o.canonicalTool);
}

/**
 * Project a validated requirement payload → the flat params `callCoreHandler` expects.
 * Picks ONLY the schema-declared property keys (drops unknowns) so the deliverable path is
 * byte-parity with the x402/MCP handlers for the same inputs.
 */
export function requirementToParams(offering: AcpOffering, requirement: Record<string, unknown>): Record<string, unknown> {
  const props = (offering.requirementSchema.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (requirement[key] !== undefined) out[key] = requirement[key];
  }
  return out;
}
