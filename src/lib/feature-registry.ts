/**
 * FEATURE-REGISTRY-SOT-W1 CH1 — the single Source of Truth for AlgoVault MCP features.
 *
 * North-star: MCP is the SoT for features. Every channel (HTTP API / x402, TG bot,
 * webhook) DERIVES its surface from THIS registry, and a drift canary (CH4) fails the
 * build if any channel falls out of sync.
 *
 * This module is DATA + TYPES ONLY — it imports NO runtime handlers (no cycle).
 * Tool descriptions live in `tool-descriptions.ts`; the registry references them by key.
 */
import {
  TRADE_CALL_DESCRIPTION,
  SCAN_FUNDING_ARB_DESCRIPTION,
  GET_MARKET_REGIME_DESCRIPTION,
  SCAN_TRADE_CALLS_DESCRIPTION,
  SEARCH_KNOWLEDGE_DESCRIPTION,
  CHAT_KNOWLEDGE_DESCRIPTION,
  GET_EQUITY_CALL_DESCRIPTION,
  GET_EQUITY_REGIME_DESCRIPTION,
} from '../tool-descriptions.js';
// SCAN-RANKBY-W1: the rankBy lens set is advertised on /capabilities from the SINGLE
// source (rank-constants.ts) — the bot derives valid lenses, never hardcodes. Pure leaf
// import (no runtime handler) keeps this DATA+TYPES module cycle-free.
import { RANK_BY_VALUES, RANK_BY_ALIASES } from './rank-constants.js';

/**
 * How a feature consumes quota:
 *  - 'per-call'          : 1 call per invocation (no HOLD concept).
 *  - 'per-non-hold'      : 1 call only for an actionable verdict (HOLD is free).
 *  - 'per-non-hold-min1' : 1 call per non-HOLD returned, minimum 1 (the market scanner).
 *  - 'rate-limited'      : NOT metered against the 100/mo call quota — token/usage
 *                          rate-limited separately (limiter: src/lib/chat-rate-limit.ts).
 */
export type QuotaUnit = 'per-call' | 'per-non-hold' | 'per-non-hold-min1' | 'rate-limited';

/**
 * SCAN-RANKBY-W1: a public, derive-not-hardcode advertisement of a tool's
 * selection-lens param (e.g. scan_trade_calls.rankBy). Consumers (the TG bot)
 * read the canonical `values` + `aliases` off /capabilities to validate + forward
 * a raw token. ONE source — these come from rank-constants.ts.
 */
export interface CapabilityLenses {
  /** The input param this lens set applies to (e.g. 'rankBy'). */
  param: string;
  /** Canonical values (the enum). */
  values: string[];
  /** alias → canonical (the bot forwards raw; the MCP resolves). */
  aliases: Record<string, string>;
  /** Default value when the param is omitted. */
  default: string;
}

export interface FeatureSpec {
  /** Canonical MCP tool name. */
  name: string;
  /** Back-compat alias names that resolve to this feature (e.g. get_trade_signal). */
  aliases: string[];
  /**
   * Which channels expose this feature TODAY. (W2 flips bot/webhook for the scanner, etc.)
   * `a2mcp` = the okx.ai A2MCP paid listing (OKX-AI-FIRST-MOVER-W1). It settles USDT0 on
   * X Layer (`eip155:196`) via the OKX managed facilitator and ships DARK behind the
   * `OKX_AI_ENABLED` two-flag firewall — the flag decides whether the route mounts; THIS
   * flag decides whether the tool is eligible for the okx.ai listing (equities + knowledge
   * excluded). The listed tool set DERIVES from this field — see `okxA2mcpTools()`.
   * `acp` = the Virtuals ACP untokenized-seller offerings (P1-ACP-SELLER-SEED). Same two-flag
   * shape: `ACP_ENABLED` decides whether the seller worker starts; THIS flag decides which tools
   * are offered. The offering set DERIVES from this field — see `acpChannelTools()` + offerings.ts.
   */
  channels: { mcp: boolean; httpX402: boolean; bot: boolean; webhook: boolean; a2mcp: boolean; acp: boolean };
  /**
   * Webhook event type this feature emits, if any. CONSUMED server-side to derive
   * webhook-api's VALID_EVENTS (FEATURE-PARITY-CHANNELS-W1 CH1 — the SoT for the
   * webhook event set). NB: the TG-bot COMMAND name is deliberately NOT a registry
   * field — a command name is a bot-UX decision, not a universal feature property
   * /capabilities consumers need; the registry owns the WHAT (channel reach), the
   * bot owns the HOW (command name), the drift canary enforces no-drift (A1).
   */
  webhookEvent?: string;
  /** Quota model (see QuotaUnit). */
  quota: { unit: QuotaUnit; holdFree: boolean };
  /** x402 pay-per-call pricing in USD. `null` = not yet priced. */
  x402: { basePriceUsd: number; perUnitUsd?: number } | null;
  /** Key into tool-descriptions.ts (resolved by DESCRIPTIONS below). */
  descriptionRef: string;
  /** SCAN-RANKBY-W1: optional selection-lens advertisement (e.g. scan_trade_calls.rankBy). */
  lenses?: CapabilityLenses;
  enabled: boolean;
  /**
   * NAV-PLATFORM-GENERATOR-W1 (A4): whether this tool appears on PUBLIC brand surfaces —
   * the nav Platform ▸ Tools mega-menu + the /tools index page. Default `true` (undefined ==
   * listed). Set `false` to keep a LIVE tool OUT of public marketing copy WITHOUT disabling
   * it: `tools/list` and the GET /capabilities projection are UNCHANGED by this field
   * (it is deliberately NOT projected — see projectCapabilities). This is orthogonal to
   * `enabled` (liveness) and `channels` (per-channel reach): it governs discovery/listing
   * only. Equities are held here per the standing "equities public-copy HOLD" — flip to
   * `true` (or delete) and they resurface across nav + /tools in one edit. Consumed by
   * `publicToolNames()` → nav-manifest.ts + the /tools generator.
   */
  publicListing?: boolean;
}

/** descriptionRef → canonical description string (descriptions stay in tool-descriptions.ts). */
const DESCRIPTIONS: Record<string, string> = {
  TRADE_CALL_DESCRIPTION,
  SCAN_FUNDING_ARB_DESCRIPTION,
  GET_MARKET_REGIME_DESCRIPTION,
  SCAN_TRADE_CALLS_DESCRIPTION,
  SEARCH_KNOWLEDGE_DESCRIPTION,
  CHAT_KNOWLEDGE_DESCRIPTION,
  GET_EQUITY_CALL_DESCRIPTION,
  GET_EQUITY_REGIME_DESCRIPTION,
};

/**
 * The registry — ONE entry per canonical tool, populated from CURRENT reality
 * (verified live @ FEATURE-REGISTRY-SOT-W1 Step-0, 2026-06-08). Channel flags reflect
 * TODAY; scanner/equity x402 are `null` (pricing deferred to a follow-up, pending $/unit).
 */
export const FEATURE_REGISTRY: FeatureSpec[] = [
  {
    name: 'get_trade_call',
    aliases: ['get_trade_signal'],
    channels: { mcp: true, httpX402: true, bot: true, webhook: true, a2mcp: true, acp: true },
    webhookEvent: 'trade_call',
    quota: { unit: 'per-non-hold', holdFree: true },
    x402: { basePriceUsd: 0.02 },
    descriptionRef: 'TRADE_CALL_DESCRIPTION',
    enabled: true,
  },
  {
    name: 'get_market_regime',
    aliases: [],
    channels: { mcp: true, httpX402: true, bot: true, webhook: true, a2mcp: true, acp: false },
    webhookEvent: 'regime_shift',
    quota: { unit: 'per-call', holdFree: false },
    x402: { basePriceUsd: 0.02 },
    descriptionRef: 'GET_MARKET_REGIME_DESCRIPTION',
    enabled: true,
  },
  {
    name: 'scan_funding_arb',
    aliases: [],
    // BOT-FUNDING-SOT-W1 (2026-06-15): exposed on the TG bot (/funding) — the
    // bot's command surface FOLLOWS this flag (capabilities → BOT_TOOL_SURFACE).
    // webhook stays false (no scan_funding_arb webhookEvent defined).
    channels: { mcp: true, httpX402: true, bot: true, webhook: false, a2mcp: true, acp: true },
    quota: { unit: 'per-call', holdFree: false },
    x402: { basePriceUsd: 0.01 },
    descriptionRef: 'SCAN_FUNDING_ARB_DESCRIPTION',
    enabled: true,
  },
  {
    name: 'scan_trade_calls',
    aliases: [],
    // FEATURE-PARITY-CHANNELS-W1 CH1: the scanner now reaches the webhook
    // (scheduled scan_digest) + bot (/scan pull + /scanwatch push) channels —
    // flipping these two flags is what makes /scan appear on both push channels.
    channels: { mcp: true, httpX402: true, bot: true, webhook: true, a2mcp: true, acp: true },
    webhookEvent: 'scan_digest',
    quota: { unit: 'per-non-hold-min1', holdFree: true },
    // OPS-X402-PRICING-EXPANSION-W1: FLAT $0.02/scan. x402 declares the price in the
    // 402 BEFORE the tool runs, so it CANNOT bill per-result — the per-result
    // max(1, non-HOLD) rule is the FREE-quota rail ONLY (supersedes the earlier per-unit proposal).
    x402: { basePriceUsd: 0.02 },
    descriptionRef: 'SCAN_TRADE_CALLS_DESCRIPTION',
    // SCAN-RANKBY-W1: advertise the universe-selection lens set (single source).
    lenses: { param: 'rankBy', values: [...RANK_BY_VALUES], aliases: { ...RANK_BY_ALIASES }, default: 'oi' },
    enabled: true,
  },
  {
    name: 'get_equity_call',
    aliases: [],
    channels: { mcp: true, httpX402: true, bot: false, webhook: false, a2mcp: false, acp: false },
    quota: { unit: 'per-non-hold', holdFree: true }, // HOLD-free per QUOTA-CONSISTENCY-COUNT-ALL-W1
    x402: { basePriceUsd: 0.02 }, // OPS-X402-PRICING-EXPANSION-W1: flat $0.02/call (free rail unchanged)
    descriptionRef: 'GET_EQUITY_CALL_DESCRIPTION',
    enabled: true,
    publicListing: false, // equities public-copy HOLD (NAV-PLATFORM-GENERATOR-W1 A4) — live tool, kept off public nav/tools; flip to surface
  },
  {
    name: 'get_equity_regime',
    aliases: [],
    channels: { mcp: true, httpX402: true, bot: false, webhook: false, a2mcp: false, acp: false },
    quota: { unit: 'per-call', holdFree: false },
    x402: { basePriceUsd: 0.02 }, // OPS-X402-PRICING-EXPANSION-W1: flat $0.02/call (free rail unchanged)
    descriptionRef: 'GET_EQUITY_REGIME_DESCRIPTION',
    enabled: true,
    publicListing: false, // equities public-copy HOLD (NAV-PLATFORM-GENERATOR-W1 A4) — live tool, kept off public nav/tools; flip to surface
  },
  {
    name: 'chat_knowledge',
    aliases: [],
    channels: { mcp: true, httpX402: false, bot: false, webhook: false, a2mcp: false, acp: false },
    quota: { unit: 'rate-limited', holdFree: false }, // limiter: src/lib/chat-rate-limit.ts (token/usage, NOT 100/mo call-quota)
    x402: null,
    descriptionRef: 'CHAT_KNOWLEDGE_DESCRIPTION',
    enabled: true,
  },
  {
    name: 'search_knowledge',
    aliases: [],
    channels: { mcp: true, httpX402: false, bot: false, webhook: false, a2mcp: false, acp: false },
    quota: { unit: 'rate-limited', holdFree: false }, // limiter: src/lib/chat-rate-limit.ts (token/usage, NOT 100/mo call-quota)
    x402: null,
    descriptionRef: 'SEARCH_KNOWLEDGE_DESCRIPTION',
    enabled: true,
  },
];

/** Resolve a tool name OR alias to its FeatureSpec — closes the canonical-key gap. */
export function getFeature(nameOrAlias: string): FeatureSpec | undefined {
  return FEATURE_REGISTRY.find((f) => f.name === nameOrAlias || f.aliases.includes(nameOrAlias));
}

/** Every live MCP tool NAME (canonical + aliases) — must equal the live `tools/list` set. */
export function allToolNames(): string[] {
  return FEATURE_REGISTRY.flatMap((f) => [f.name, ...f.aliases]);
}

/**
 * NAV-PLATFORM-GENERATOR-W1 (A4) — canonical tool names eligible for PUBLIC brand surfaces
 * (nav Platform ▸ Tools + /tools index), in registry order. Membership rule lives HERE (the
 * SoT): ENABLED and not `publicListing: false`. Aliases are excluded by construction (only
 * `f.name`). This is the ONE derivation both nav-manifest.ts and the /tools generator project
 * from — flipping an equity's `publicListing` (or adding a tool) updates every public surface.
 * NB: independent of `tools/list` (all enabled tools, incl. equities + the alias) and of the
 * /capabilities projection (unchanged) — a listing decision, not a liveness/reach decision.
 */
export function publicToolNames(): string[] {
  return FEATURE_REGISTRY.filter((f) => f.enabled && f.publicListing !== false).map((f) => f.name);
}

/**
 * The webhook event types — the `webhookEvent` of every ENABLED webhook-flagged
 * feature, in registry order. The SINGLE SoT for webhook-api's VALID_EVENTS
 * (FEATURE-PARITY-CHANNELS-W1 CH1): retires the hand-maintained 2nd list, so
 * adding a future webhook tool needs only a registry row. The drift canary (CH5)
 * asserts the live VALID_EVENTS equals this set.
 */
export function webhookEventTypes(): string[] {
  return FEATURE_REGISTRY
    .filter((f) => f.enabled && f.channels.webhook && f.webhookEvent)
    .map((f) => f.webhookEvent as string);
}

/**
 * The tools eligible for Virtuals ACP offerings — the `channels.acp` of every ENABLED feature,
 * in registry order. SoT for the ACP offering set (P1-ACP-SELLER-SEED): offerings.ts must cover
 * this set, and a coverage canary fails the build if a `channels.acp` tool has no offering.
 * Mirrors okxA2mcpTools() / webhookEventTypes().
 */
export function acpChannelTools(): string[] {
  return FEATURE_REGISTRY.filter((f) => f.enabled && f.channels.acp).map((f) => f.name);
}

/** One public-safe descriptor per CALLABLE tool name (canonical + each alias). */
export interface PublicCapability {
  /** The callable tool name (a canonical name OR an alias). */
  name: string;
  /** The canonical name this resolves to (== name for canonical entries). */
  canonical: string;
  channels: { mcp: boolean; httpX402: boolean; bot: boolean; webhook: boolean; a2mcp: boolean; acp: boolean };
  quota: { unit: QuotaUnit; holdFree: boolean };
  x402: { basePriceUsd: number; perUnitUsd?: number } | null;
  description: string;
  /** SCAN-RANKBY-W1: selection-lens set when the tool advertises one (e.g. rankBy). */
  lenses?: CapabilityLenses;
  enabled: boolean;
}

/**
 * PUBLIC-SAFE projection for GET /capabilities. ONE entry per callable name
 * (canonical + each alias) so a consumer can look up any name it might call.
 * Emits ONLY public fields — no internal quota keys, no `outcome_*` /
 * `eligible_non_hold`, no `descriptionRef`, no handler refs.
 */
export function projectCapabilities(): { tools: PublicCapability[] } {
  const tools: PublicCapability[] = [];
  for (const f of FEATURE_REGISTRY) {
    if (!f.enabled) continue;
    const base = {
      canonical: f.name,
      channels: f.channels,
      quota: { unit: f.quota.unit, holdFree: f.quota.holdFree },
      x402: f.x402,
      description: DESCRIPTIONS[f.descriptionRef] ?? '',
      // SCAN-RANKBY-W1: surface the lens set (omitted when the tool has none).
      ...(f.lenses ? { lenses: f.lenses } : {}),
      enabled: f.enabled,
    };
    tools.push({ name: f.name, ...base });
    for (const alias of f.aliases) tools.push({ name: alias, ...base });
  }
  return { tools };
}
