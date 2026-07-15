#!/usr/bin/env node

/**
 * crypto-quant-signal-mcp — Dual transport MCP server.
 *
 * Default: Streamable HTTP on port 3000 (remote server mode)
 * Optional: stdio transport via TRANSPORT=stdio env var (local npx use)
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer, ResourceTemplate, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ExchangeId } from './types.js';
import { routeTradeCall } from './tools/trade-call-router.js';
import { scanFundingArb } from './tools/scan-funding-arb.js';
import { getMarketRegime } from './tools/get-market-regime.js';
import { runScanTradeCall, SCAN_TRADE_CALLS_SCHEMA, SCAN_TRADE_CALLS_DESCRIPTION } from './tools/scan-trade-calls.js';
import { getSignalPerformance, runBackfill } from './resources/signal-performance.js';
import { refreshGridIfStale } from './lib/cross-asset-grid.js';
import { renderBrandFooter } from './lib/footer-content.js';
import { closeDb, getConfidenceBands, getHoldStats, getMerkleBatches, getSignalWithBatch, getSignalByHash, upsertAgentSession, getSampleSignalsFromLatestBatch, getRecentCallsAsync, type RecentCall } from './lib/performance-db.js';
import { registerWebhookRoutes, resolveOwner, authRequired } from './lib/webhook-api.js';
import { formatShadowVenuePublic, formatVenueForResource } from './lib/venue-public-formatter.js';
import { startDeliveryWorker } from './lib/webhook-delivery.js';
import { startScanDigestScheduler, stopScanDigestScheduler } from './lib/scan-digest-scheduler.js';
import { PKG_VERSION } from './lib/pkg-version.js';
import { buildErc8004ReputationBody } from './lib/erc8004-reputation.js';
import { buildPublicCtaBlock } from './lib/public-cta.js';
import { verifyProof } from './lib/merkle.js';
import { warmTierCaches } from './lib/asset-tiers.js';
import { EXCHANGES, EXCHANGE_COUNT, TIMEFRAME_COUNT, getAssetCount, floorRoundTo10 } from './lib/capabilities.js';
import { resolveLicense, resolveLicenseSync, requestContext, getRequestLicense, getRequestSessionId, getRequestIpHash, getRequestSource, getRequestVerdict, setRequestVerdict, initQuotaDb, checkQuota, checkInternalBypass, recordAhaMilestoneCrossing } from './lib/license.js';
import { initX402, settleX402Async, buildX402PaymentRequiredResult } from './lib/x402.js';
import { mountX402HttpRoutes, HTTP_TOOLS } from './lib/x402-http-routes.js';
import { mountOkxA2mcpRoutes } from './lib/okx-a2mcp.js';
import { startAcpSellerWorker } from './channels/acp/seller-worker.js';
import { PUBLIC_READONLY_TOOL_ANNOTATIONS } from './tool-annotations.js';
import { getEquityRegime } from './lib/equities/equity-tool-formatters.js';
import { getEquityPerformance } from './lib/equities/equity-performance.js';
import { getEquityPool } from './lib/equities/equity-store.js';
import { initAnalytics, logRequest, hashIp, getUsageStats, logSkillInvocation } from './lib/analytics.js';
import { clientIp } from './lib/client-ip.js';
import { ensureProcessedStripeEventsSchema, tryClaimEvent } from './lib/stripe-events-store.js';
import { upsertSignupEmail, markConfirmationSent, tryClaimSignupEmailEvent } from './lib/signup-emails-store.js';
import { sendReferredFreeKeyEmail, sendFreeKeyEmail } from './lib/email.js';
import { validateSignupEmail } from './lib/email-validation.js';
import { getAnalyticsSummary } from './resources/analytics-summary.js';
import { getSkillsAnalytics } from './resources/skills-analytics.js';
import { generateFunnelSnapshot } from './lib/funnel-snapshot.js';
import { recordFunnelEvent } from './lib/performance-db.js';
import { classifyCtaEventType } from './lib/cta-attribution.js';
import { recordFirstNonHoldVerdict, shouldShowAhaReferral, ahaReferralAlreadyShown } from './lib/aha-event.js';
import { referralCodeForKey } from './lib/referral-store.js'; // REFERRAL-INPRODUCT-NUDGE-W1: keyed→code, keyless→null
// ACTIVATION-NUDGE-W1 (2026-06-18): the one-time aha upgrade_hint render reuses
// C1's single first-non-HOLD detection; the warmer keeps the track-record SoT
// fresh for all nudge copy (started once at server boot, below).
import { buildAhaHint, buildAhaReferral, buildReferralHint, AHA_HIGH_CONVICTION_CONFIDENCE, type ReferralHint, type AhaReferralFrom } from './lib/nudge-copy.js';
import { getTrackRecord, startTrackRecordWarmer } from './lib/track-record-snapshot.js';
import { renderReceiptText, renderScanReceiptText } from './lib/receipts.js';
import { renderScanDigest } from './lib/scan-digest.js';
import { startReceiptTrackRecordWarmer } from './lib/receipts-track-record.js';
import { getPqlCandidates } from './lib/pql.js';
import {
  captureArgvTrackToken,
  resolveTrackTokenForRequest,
  shouldEmitForRequest,
  resolveSessionIdentity,
  type IdentityTier,
} from './lib/track-token.js';
import { recordMcpToolsListEvent } from './lib/tools-list-event.js';
import { classifyTraffic } from './lib/traffic-classifier.js';
import { resolveSource, classifySource, shouldEmitConnect } from './lib/attribution-sources.js';
import {
  isStripeConfigured,
  constructWebhookEvent,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  createCheckoutSession,
  getCustomerApiKey,
  validateApiKey,
  summarizeCheckoutCompleted,
} from './lib/stripe.js';
import { UpstreamRateLimitError, EXCHANGE_FALLBACKS, TradFiSymbolUnsupportedOnVenueError, TierLimitReachedError, InsufficientCandlesError, buildInsufficientCandlesPayload, buildTierLimitPayload } from './lib/errors.js';
// FUNNEL-FIX-AGENT-X402-NUDGE-W1: at the quota edge, offer the agent an in-protocol x402
// pay-per-call rail. The helper is a LEAF (imports only pure/SDK modules) so this root import
// adds no cycle. Dark behind X402_NUDGE_ENABLED (default OFF ⇒ envelope byte-identical).
import { buildSuggestedX402, isX402NudgeEnabled } from './lib/x402-nudge.js';
import { runAsBatch, runAsCaller } from './lib/upstream-weight-budget.js';
import { listVenues } from './lib/venue-store.js';
import { checkBotInternalAuth } from './lib/bot-auth.js';
import { getWelcomePageHtml } from './lib/welcome-page.js';
import {
  TRADE_CALL_DESCRIPTION,
  TRADE_CALL_ALIAS_SUFFIX,
  SCAN_FUNDING_ARB_DESCRIPTION,
  GET_MARKET_REGIME_DESCRIPTION,
  SEARCH_KNOWLEDGE_DESCRIPTION,
  CHAT_KNOWLEDGE_DESCRIPTION,
  PARAM_DESC_TRADE_CALL_COIN,
  PARAM_DESC_TRADE_CALL_TIMEFRAME,
  PARAM_DESC_TRADE_CALL_INCLUDE_REASONING,
  PARAM_DESC_TRADE_CALL_EXCHANGE,
  PARAM_DESC_TRADE_CALL_ASSET_CLASS,
  PARAM_DESC_FUNDING_MIN_SPREAD_BPS,
  PARAM_DESC_FUNDING_LIMIT,
  PARAM_DESC_REGIME_COIN,
  PARAM_DESC_REGIME_TIMEFRAME,
  PARAM_DESC_REGIME_EXCHANGE,
  GET_EQUITY_CALL_DESCRIPTION,
  GET_EQUITY_REGIME_DESCRIPTION,
} from './tool-descriptions.js';
import { allToolNames, projectCapabilities } from './lib/feature-registry.js';
import {
  getKnowledgeBundle,
  getKnowledgeIndex,
  listKnowledgeResources,
  VERSION_SLUG_REGEX,
} from './lib/knowledge-store.js';
// AV-CHAT-MCP-W1 (C2, 2026-05-18) — knowledge search substrate. Module-level
// singletons shared between the MCP tool handler (in createServer()) and the
// /api/search Express route (in startHttp()). C3 wires its ChatEngine to
// receive the SAME SearchEngine instance via constructor injection.
import { KnowledgeIndex } from './lib/knowledge-index.js';
import { SearchEngine, type SearchResult } from './lib/search-engine.js';
import { ResultCache } from './lib/result-cache.js';
import { formatSearchKnowledgeResponse } from './lib/search-knowledge-formatter.js';
// AV-CHAT-MCP-W1 (C3, 2026-05-18) — chat substrate. ChatEngine reuses the
// SearchEngine singleton from C2; quota tracked separately via ChatRateLimit
// against the new `chat_usage_monthly` Postgres table.
import { getLLMProvider, type LLMProvider, type LLMProviderName } from './lib/llm-provider.js';
import { ChatEngine, type ChatResult } from './lib/chat-engine.js';
import { ChatRateLimit, ensureChatUsageTable, type ChatTier } from './lib/chat-rate-limit.js';
import { formatChatKnowledgeResponse } from './lib/chat-knowledge-formatter.js';
// CHAT-USAGE-ANALYTICS-W1 (2026-05-18) — single recording middleware for both
// chat surfaces (MCP tool + HTTP route). PII-safe (SHA256 hash + length only).
// Cowork Q-4 Path B: persists provider name so LLM-PROVIDER-A/B-W1 + stub-key-
// rotation visibility flow from day one.
import { ensureChatAnalyticsSchema, recordChatEvent } from './lib/chat-analytics.js';
import { getChatAnalyticsHtml } from './lib/chat-analytics-dashboard.js';
// GEO-MEASUREMENT-W1 (C1, 2026-05-19): geo_query_runs + geo_mentions schema
// + geo_weekly_summary view. Idempotent DDL fired at module-init.
import { ensureGeoSchema } from './lib/geo-storage.js';
// GEO-MEASUREMENT-W1 (C2, 2026-05-19): admin GEO dashboard at /admin/geo-dashboard.
import { getGeoDashboardData, renderGeoDashboardHtml } from './lib/geo-dashboard.js';

/**
 * Format a thrown error into the MCP tool-content payload. v1.10.2: when the
 * cause is `UpstreamRateLimitError`, emit a structured `{error_code, exchange,
 * retry_after_seconds, suggestion}` shape instead of a flat `{error: <string>}`
 * so MCP clients can pattern-match on `error_code === "UPSTREAM_RATE_LIMIT"`
 * and auto-fallback to a different exchange.
 */
function toolErrorContent(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (err instanceof UpstreamRateLimitError) {
    const fallbacks = EXCHANGE_FALLBACKS[err.exchange] ?? [];
    const fallbackList = fallbacks.length > 0 ? fallbacks.join(', ') : 'a different exchange';
    const retryHint = err.retryAfterSeconds !== null
      ? ` (or wait ${err.retryAfterSeconds}s and retry)`
      : ' (or retry in a few minutes)';
    const payload = {
      error: err.message,
      error_code: err.code,
      exchange: err.exchange,
      retry_after_seconds: err.retryAfterSeconds,
      suggestion: `Try ${fallbackList} instead${retryHint}.`,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  if (err instanceof TradFiSymbolUnsupportedOnVenueError) {
    const payload = {
      error: err.code,
      error_code: err.code,
      message: err.message,
      coin: err.coin,
      requested_exchange: err.requestedExchange,
      suggested_venues: err.suggestedVenues,
      probed_at: err.probedAt,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  if (err instanceof TierLimitReachedError) {
    // FUNNEL-FIX-AGENT-X402-NUDGE-W1: additive `suggested_x402` in-protocol pay-per-call branch
    // (the agent can settle with its own wallet, no human signup) alongside the intact Stripe/
    // referral fields — closes the quota-crossing→paid leak (a machine can't fill a Stripe
    // checkout). Derived from the feature-registry channels{} SoT + live rail predicates; omitted
    // (envelope byte-identical) when X402_NUDGE_ENABLED is off, no public rail is live, or the
    // tool is HELD. The allow-list formatter (buildTierLimitPayload) is the single wire shape.
    const suggestedX402 = isX402NudgeEnabled() && err.tool ? buildSuggestedX402(err.tool) : undefined;
    const payload = buildTierLimitPayload(err, { suggestedX402 });
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  if (err instanceof InsufficientCandlesError) {
    const payload = buildInsufficientCandlesPayload(err);
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}
import { renderSignupFlowDark, renderPlanCards } from './lib/signup-flow.js';
import {
  accountPageHandler,
  accountPortalHandler,
  accountRecoverKeyHandler,
  accountReferralsHandler,
  accountPayoutAddressHandler,
} from './lib/account-handlers.js';
import { renderSiteNav } from './lib/site-nav.js';
import { getTopAssetsByOI } from './lib/oi-ranking.js';

/** Timing-safe string comparison to prevent side-channel attacks on admin key. */
function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Knowledge search singletons ──
// AV-CHAT-MCP-W1 (C2, 2026-05-18). One KnowledgeIndex + ResultCache + SearchEngine
// per process; lazy-initialized on first use; subsequent calls reuse the same
// instance. The watcher inside KnowledgeIndex rebuilds the BM25 docs whenever
// /app/dist/knowledge/latest.json changes (30s poll). C3 ChatEngine constructor
// receives the SAME SearchEngine instance so chat-engine context is fresh.
let _searchEnginePromise: Promise<{
  index: KnowledgeIndex;
  engine: SearchEngine;
}> | null = null;

function getKnowledgeBundlePath(): string {
  if (process.env.KNOWLEDGE_BUNDLE_PATH) return process.env.KNOWLEDGE_BUNDLE_PATH;
  // Compiled location: dist/index.js → dist/knowledge/latest.json
  return path.resolve(__dirname, 'knowledge', 'latest.json');
}

async function getKnowledgeSearch(): Promise<{ index: KnowledgeIndex; engine: SearchEngine }> {
  if (!_searchEnginePromise) {
    _searchEnginePromise = (async () => {
      const bundlePath = getKnowledgeBundlePath();
      const index = new KnowledgeIndex(bundlePath);
      await index.build();
      const cache = new ResultCache<SearchResult[]>({ ttlMs: 3_600_000, max: 500 });
      const engine = new SearchEngine(index, cache);
      return { index, engine };
    })();
  }
  return _searchEnginePromise;
}

// ── Chat singletons (AV-CHAT-MCP-W1 C3) ──
// One ChatEngine + LLMProvider + ChatRateLimit + ResultCache<ChatResult> per
// process. ChatEngine reuses the SAME SearchEngine instance from
// getKnowledgeSearch() — single SoT for the index + retrieval.
const ALLOWED_CHAT_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
]);

let _chatEnginePromise: Promise<{
  index: KnowledgeIndex;
  chatEngine: ChatEngine;
  rateLimit: ChatRateLimit;
  llm: LLMProvider;
}> | null = null;

async function getChatStack(): Promise<{
  index: KnowledgeIndex;
  chatEngine: ChatEngine;
  rateLimit: ChatRateLimit;
  llm: LLMProvider;
}> {
  if (!_chatEnginePromise) {
    _chatEnginePromise = (async () => {
      const { index, engine } = await getKnowledgeSearch();
      const llm = getLLMProvider();
      const cache = new ResultCache<ChatResult>({ ttlMs: 86_400_000, max: 200 });
      const chatEngine = new ChatEngine(engine, llm, cache);
      const rateLimit = new ChatRateLimit();
      return { index, chatEngine, rateLimit, llm };
    })();
  }
  return _chatEnginePromise;
}

/**
 * Map LicenseTier → ChatTier. License tiers `internal` and `x402` map to
 * `enterprise` (effectively unmetered for the chat surface).
 */
function chatTierFor(licenseTier: string): ChatTier {
  if (licenseTier === 'free') return 'free';
  if (licenseTier === 'starter') return 'starter';
  if (licenseTier === 'pro') return 'pro';
  // 'enterprise' | 'internal' | 'x402' | any other paid tier
  return 'enterprise';
}

function chatQuotaApiKey(licenseKey: string | null, ipHash: string | null): string {
  // Free-tier callers have no api_key — bucket by ip_hash so anonymous
  // traffic doesn't share a single global counter.
  return licenseKey ?? `ip:${ipHash ?? 'unknown'}`;
}

/**
 * OPS-MCP-SESSION-RESILIENCE-W1: single shared session-correlation resolver
 * (single-derivation rule). Used by BOTH the funnel / skill-attribution emit AND
 * the per-request requestContext ALS store under stateless transport mode, so every
 * consumer — recordFunnelEvent + the per-tool cohort sites via getRequestSessionId()
 * — projects from ONE value, never re-derived per site.
 *
 * Precedence (architect A1 = Option B), hardened to NEVER return null/empty (an empty
 * session_id would collapse the activation funnel as badly as null):
 *   X-AlgoVault-Track-Token  → preserves the per-(session,track_token) funnel dedup for tagged callers
 *   ?? ipHash                → stable per-client, privacy-safe, SAME id as the free:${ipHash} quota key
 *   ?? randomUUID()          → only if both absent (rare behind Caddy)
 * Stateless issues no Mcp-Session-Id, so this stops COUNT(DISTINCT session_id) collapsing
 * to null without UUID-inflating it per request.
 */
export function resolveSessionCorrelationId(
  headers: Record<string, unknown>,
  ipHash: string,
): string {
  // OPS-ACTIVATION-LEAK-FIX-W1 CH2: thin `.id` projection of the shared
  // resolveSessionIdentity (single-derivation LAW). The id and its identity tier
  // (token|fallback|anon) now derive from ONE branch, so the funnel's
  // identity_coverage can never disagree with the correlation id. Precedence
  // (token ?? ipHash ?? uuid) is byte-identical to the prior inline form.
  return resolveSessionIdentity(headers, ipHash).id;
}

/**
 * OPS-MCP-SESSION-RESILIENCE-W1: stateless Streamable-HTTP request handler. A fresh
 * McpServer + transport per POST (sessionIdGenerator: undefined → no session issued or
 * validated → nothing can be orphaned by a deploy / idle-reap / restart / replica).
 * GET/DELETE → 405 (no SSE stream, no session to delete) — matches the official SDK
 * stateless example. Exported so tests/ops-mcp-session-resilience-w1.test.ts can drive
 * the REAL handler over a live http.Server.
 */
export async function handleMcpStateless(
  req: import('express').Request,
  res: import('express').Response,
  makeServer: () => McpServer,
): Promise<void> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    return;
  }
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    try { transport.close(); server.close(); } catch { /* best-effort cleanup */ }
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'crypto-quant-signal-mcp',
    version: PKG_VERSION,
  });

  // FEATURE-REGISTRY-SOT-W1 CH2: tool registration is registry-DRIVEN. Each tool's
  // existing handler + Zod schema are UNCHANGED — `register(...)` (same arg order as
  // server.tool) collects them into `toolDefs`; the loop after the declarations
  // registers exactly the set FEATURE_REGISTRY declares (canonical + aliases), and a
  // bidirectional parity guard throws if the registry and the handler defs diverge.
  type RegDef = { description: string; schema: z.ZodRawShape; annotations: Record<string, unknown>; handler: unknown };
  const toolDefs: Record<string, RegDef> = {};
  // Generic so the handler's args are inferred from the Zod schema EXACTLY as server.tool
  // did (preserves each handler's existing typed destructuring; no `any` regression).
  const register = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    annotations: Record<string, unknown>,
    handler: ToolCallback<S>,
  ): void => {
    toolDefs[name] = { description, schema, annotations, handler: handler as unknown };
  };

  // ── Tool 1: get_trade_call (canonical, v1.10.0) + get_trade_signal (alias for back-compat) ──
  // The handler is identical; we register the same factory under two names so
  // existing agents calling `get_trade_signal` continue to work without changes.
  // The `_algovault.tool` field in the response always reports `get_trade_call`
  // (the canonical name). TRADE_CALL_DESCRIPTION + TRADE_CALL_ALIAS_SUFFIX +
  // param describe() constants are module-scope-exported above (see
  // TOOL-DESC-AUDIT-W1 block) so the keyword canary test can import them.
  // TRADE-CALL-ROUTING-RESOLVER-W1: timeframe + exchange are optional (NO Zod
  // .default) so the shared resolver can distinguish "the caller named a venue/TF"
  // (→ perp) from "bare" (→ equity-universe routing). Omitting them still yields
  // 15m / BINANCE — the defaults are applied by resolveMarketRoute — so existing
  // callers are unaffected at runtime. `assetClass` forces the engine.
  const TRADE_CALL_SCHEMA = {
    coin: z.string().max(20).describe(PARAM_DESC_TRADE_CALL_COIN),
    timeframe: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']).optional().describe(PARAM_DESC_TRADE_CALL_TIMEFRAME),
    includeReasoning: z.boolean().default(true).describe(PARAM_DESC_TRADE_CALL_INCLUDE_REASONING),
    exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT']).optional().describe(PARAM_DESC_TRADE_CALL_EXCHANGE),
    assetClass: z.enum(['perp', 'equity']).optional().describe(PARAM_DESC_TRADE_CALL_ASSET_CLASS),
  };
  function makeTradeCallHandler(toolNameForAnalytics: 'get_trade_call' | 'get_trade_signal') {
    return async ({ coin, timeframe, includeReasoning, exchange, assetClass }: { coin: string; timeframe?: '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d'; includeReasoning: boolean; exchange?: ExchangeId; assetClass?: 'perp' | 'equity' }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Single-derivation: resolve the route once + dispatch to the perp or equity
        // engine. The model picking get_trade_call or get_equity_call yields the same
        // contract-correct engine. Quota is handled inside whichever engine runs.
        const { route, result } = await runAsCaller(toolNameForAnalytics, () => routeTradeCall({ coin, timeframe, includeReasoning, exchange, assetClass, license }));
        const verdict = (result as { call?: 'BUY' | 'SELL' | 'HOLD' }).call;
        // Verdict stored for x402 settlement skip (HOLDs / error paths don't settle).
        setRequestVerdict(verdict ?? 'HOLD');
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: toolNameForAnalytics,
          asset: coin,
          timeframe: route.timeframe,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          verdict,
          confidence: (result as { confidence?: number }).confidence,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        // CONVERSION-MEASUREMENT-W1 C1: aha event — the first BUY/SELL a FREE
        // session receives (the activation leading indicator). Emits a NEW
        // `first_non_hold_verdict` event_type ONLY; the deployed quota/CTA
        // captures and the /api/admin/funnel-snapshot endpoint are untouched.
        // Deduped per session (bounded LRU) + read-side DISTINCT; fail-open.
        const isAha = recordFirstNonHoldVerdict({
          verdict,
          tier: license.tier,
          sessionId: getRequestSessionId(),
          tool: toolNameForAnalytics,
          asset: coin,
        });
        // ACTIVATION-NUDGE-W1: celebrate-the-aha render. Reuse C1's SINGLE
        // first-non-HOLD-per-session decision (the return value) — never
        // re-derive it — to attach the one-time aha upgrade_hint. Free-only +
        // idempotent are already enforced inside recordFirstNonHoldVerdict.
        // Precedence aha > soft: overwrite any soft quota nudge the tool set
        // (the 100% limit is a separate error envelope, not reached here).
        // REFERRAL-INPRODUCT-NUDGE-W1: the aha value moment now offers a referral
        // hint to KEYED users — high-conviction first non-HOLD (reuse isAha + the
        // confidence gate) or a usage milestone — capped to ≤1 per session across
        // all aha triggers (single-source `shouldShowAhaReferral`, first wins).
        // Keyless aha keeps the existing upgrade hint (no link to show). aha > soft.
        const ahaMeta = (result as { _algovault?: { upgrade_hint?: string; referral_hint?: ReferralHint } })._algovault;
        if (ahaMeta) {
          const refCode = referralCodeForKey(license.key);
          const sid = getRequestSessionId() ?? null;
          // Evaluate triggers only when a keyed user still has a free session slot —
          // so a milestone crossing isn't committed when the slot is already spent.
          let aha: { from: AhaReferralFrom; verdict?: string; callCountUser?: number } | null = null;
          if (refCode && sid && !ahaReferralAlreadyShown(sid)) {
            const conf = (result as { confidence?: number }).confidence ?? 0;
            if (isAha && conf >= AHA_HIGH_CONVICTION_CONFIDENCE && (verdict === 'BUY' || verdict === 'SELL')) {
              aha = { from: 'aha_call', verdict };                          // (a) high-conviction call
            } else {
              const milestone = await recordAhaMilestoneCrossing(license);  // (c) usage milestone
              if (milestone !== null) aha = { from: 'aha_milestone', callCountUser: milestone };
            }
          }
          if (aha && refCode && sid && shouldShowAhaReferral(sid)) {
            ahaMeta.upgrade_hint = buildAhaReferral({
              from: aha.from, code: refCode, stats: getTrackRecord(),
              verdict: aha.verdict, callCountUser: aha.callCountUser,
            });
            ahaMeta.referral_hint = buildReferralHint({ from: aha.from, code: refCode });
          } else if (isAha) {
            // Keyless aha (or no referral fired) → the existing upgrade hint, unchanged.
            ahaMeta.upgrade_hint = buildAhaHint(getTrackRecord());
          }
        }
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: toolNameForAnalytics,
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
            source: getRequestSource() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
        // P0 VERDICT-WITH-RECEIPTS-W1: content[0] stays the JSON envelope (now with
        // the additive `_receipts` sibling) so any consumer parsing content[0] is
        // unaffected; content[1] carries the human-readable receipt, projected from
        // the SAME `_receipts` (single-derivation). Equity-engine results have no
        // `_receipts` → no human receipt (perp-only scope).
        const content: { type: 'text'; text: string }[] = [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ];
        const rcpt = result as { _receipts?: Parameters<typeof renderReceiptText>[0]; reasoning?: string };
        if (rcpt._receipts) {
          content.push({ type: 'text' as const, text: renderReceiptText(rcpt._receipts, rcpt.reasoning ?? '') });
        }
        return { content };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    };
  }
  register(
    'get_trade_call',
    TRADE_CALL_DESCRIPTION,
    TRADE_CALL_SCHEMA,
    { title: 'Composite Trade Call', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    makeTradeCallHandler('get_trade_call')
  );
  register(
    'get_trade_signal',
    TRADE_CALL_DESCRIPTION + TRADE_CALL_ALIAS_SUFFIX,
    TRADE_CALL_SCHEMA,
    { title: 'Trade Signal', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    makeTradeCallHandler('get_trade_signal')
  );

  // ── Tool 2: scan_funding_arb ──
  register(
    'scan_funding_arb',
    SCAN_FUNDING_ARB_DESCRIPTION,
    {
      // DoS-prevention bounds (delta audit 2026-04-15): minSpreadBps clamped to
      // [0, 10000] bps (0-100%), limit clamped to [1, 200] integers. Paid tier
      // downstream clamp via getFundingArbLimit() is preserved; these are the
      // hard boundary validation at the handler edge.
      minSpreadBps: z.number().min(0).max(10_000).default(5).describe(PARAM_DESC_FUNDING_MIN_SPREAD_BPS),
      limit: z.number().int().min(1).max(200).default(10).describe(PARAM_DESC_FUNDING_LIMIT),
    },
    { title: 'Funding Arbitrage Scanner', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    async ({ minSpreadBps, limit }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Quota tracking is handled inside scanFundingArb
        const result = await runAsCaller('scan_funding_arb', () => scanFundingArb({ minSpreadBps, limit, license }));
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'scan_funding_arb',
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: 'scan_funding_arb',
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
            source: getRequestSource() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );

  // ── Tool 3: get_market_regime ──
  register(
    'get_market_regime',
    GET_MARKET_REGIME_DESCRIPTION,
    {
      coin: z.string().max(20).describe(PARAM_DESC_REGIME_COIN),
      timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe(PARAM_DESC_REGIME_TIMEFRAME),
      exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT']).default('HL').describe(PARAM_DESC_REGIME_EXCHANGE),
    },
    { title: 'Market Regime Classifier', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    async ({ coin, timeframe, exchange }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Quota tracking is handled inside getMarketRegime
        const result = await runAsCaller('get_market_regime', () => getMarketRegime({ coin, timeframe, exchange }));
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'get_market_regime',
          asset: coin,
          timeframe,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: 'get_market_regime',
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
            source: getRequestSource() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );

  // ── Tools: get_equity_call + get_equity_regime (EQUITIES-ENGINE-W1) ──
  // US equities daily-bar verdict engine (Databento EQUS.MINI). Free-tier quota
  // wiring identical to the crypto free tools (handled inside getEquityCall via
  // trackCall). Verdicts are precomputed nightly; the handler is a DB read.
  // GET_EQUITY_CALL_DESCRIPTION + GET_EQUITY_REGIME_DESCRIPTION are imported from
  // tool-descriptions.ts (FEATURE-REGISTRY-SOT-W1 CH2 dedup; the registry references the same source).
  register(
    'get_equity_call',
    GET_EQUITY_CALL_DESCRIPTION,
    {
      symbol: z.string().max(12).describe('US equity/ETF ticker, e.g. AAPL, SPY, BRK.B (BRK-B also accepted).'),
      // TRADE-CALL-ROUTING-RESOLVER-W1: additive optional routing params. Symbol-only
      // callers behave exactly as today (daily-bar equity). Naming a crypto venue or a
      // timeframe routes to the perpetual-futures engine via the shared resolver.
      exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT']).optional().describe('Optional crypto venue — naming one routes to the perp call (prefer get_trade_call).'),
      timeframe: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']).optional().describe('Optional candle timeframe — supplying one routes to the perp call.'),
    },
    { title: 'Equity Trade Call', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    async ({ symbol, exchange, timeframe }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Default to the equity read ONLY when bare (no venue, no timeframe). A supplied
        // crypto venue/TF routes to perp — resolveMarketRoute is authoritative.
        const assetClass = !exchange && !timeframe ? ('equity' as const) : undefined;
        const { result } = await runAsCaller('get_equity_call', () => routeTradeCall({ coin: symbol, exchange, timeframe, assetClass, license }));
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'get_equity_call',
          asset: symbol,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );
  register(
    'get_equity_regime',
    GET_EQUITY_REGIME_DESCRIPTION,
    { symbol: z.string().max(12).optional().describe('US equity/ETF ticker; defaults to SPY.') },
    { title: 'Equity Market Regime', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    async ({ symbol }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        const result = await runAsCaller('get_equity_regime', () => getEquityRegime({ symbol, license }));
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'get_equity_regime',
          asset: symbol ?? 'SPY',
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );

  // ── Tool: scan_trade_calls (SCAN-TRADE-CALLS-W1) — cross-asset market scanner ──
  // Thin handler: quota gate + envelope live in src/tools/scan-trade-calls.ts
  // (runScanTradeCall); the scanner compute is src/lib/trade-call-scanner.ts.
  register(
    'scan_trade_calls',
    SCAN_TRADE_CALLS_DESCRIPTION,
    SCAN_TRADE_CALLS_SCHEMA,
    { title: 'Market Scanner', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    async ({ topN, timeframe, exchange, minConfidence, includeHolds, limit, rankBy, includeReasoning, oiChangeWindow, oiBasis }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        const result = await runAsCaller('scan_trade_calls', () => runScanTradeCall(
          { topN, timeframe, exchange, minConfidence, includeHolds, limit, rankBy, includeReasoning, oiChangeWindow, oiBasis },
          license,
        ));
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'scan_trade_calls',
          timeframe,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: 'scan_trade_calls',
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
            source: getRequestSource() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
        // content[0] = the JSON envelope (with the shared `_receipts` block).
        const content: { type: 'text'; text: string }[] = [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ];
        const scanRes = result as {
          calls?: unknown[];
          _receipts?: Parameters<typeof renderScanReceiptText>[0];
        };
        if (includeReasoning && Array.isArray(scanRes.calls)) {
          // SCAN-DIGEST-MCP-PARITY-W1 CH1 — digest mode: content[1] = the enriched
          // digest (header + renderScanDigestLine per actionable call), NO Proof
          // footer (parity with OPS-SCANWATCH-ROCKET-NO-PROOF). The structured
          // `_receipts` envelope still rides in content[0].
          const digest = renderScanDigest(
            scanRes.calls as Parameters<typeof renderScanDigest>[0],
            { topN, timeframe, exchange, rankBy },
          );
          if (digest) content.push({ type: 'text' as const, text: digest });
        } else {
          // P0 VERDICT-WITH-RECEIPTS-W1: bare mode keeps the proof footer so a scan
          // screenshot carries the proof beside the per-row verdicts (byte-identical).
          const footer = scanRes._receipts ? renderScanReceiptText(scanRes._receipts) : '';
          if (footer) content.push({ type: 'text' as const, text: footer });
        }
        return { content };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );

  // ── Tool 4: search_knowledge ──
  // AV-CHAT-MCP-W1 (C2, 2026-05-18). BM25 lexical retrieval over the auto-
  // generated KnowledgeBundle (dist/knowledge/latest.json). Free, fast, no
  // LLM call, no quota cost. Bundle is rebuilt automatically on every release
  // via KNOWLEDGE-ARTIFACT-W1's `release-knowledge.yml` workflow; the
  // KnowledgeIndex fs.watchFile poll picks up changes within 30s.
  register(
    'search_knowledge',
    SEARCH_KNOWLEDGE_DESCRIPTION,
    {
      query: z.string().min(3).max(500).describe('Natural-language search query (3-500 chars).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max ranked results (1-50, default 10).'),
    },
    { title: 'Knowledge Search', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    async ({ query, limit }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        const { index, engine } = await getKnowledgeSearch();
        const results = await runAsCaller('search_knowledge', () => engine.query(query, limit ?? 10));
        const bundle = index.getBundle();
        const response = formatSearchKnowledgeResponse(query, results, bundle);
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'search_knowledge',
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );

  // ── Tool 5: chat_knowledge ──
  // AV-CHAT-MCP-W1 (C3, 2026-05-18). LLM-synthesized answer with citations
  // grounded in the canonical knowledge bundle. Quota-gated separately from
  // trading-tool quotas via ChatRateLimit (Free 10/mo, Starter 50/mo,
  // Pro 200/mo, Enterprise 2000/mo). Falls back to StubLLMProvider with
  // [STUB] response if ANTHROPIC_API_KEY is unset (server boots cleanly).
  register(
    'chat_knowledge',
    CHAT_KNOWLEDGE_DESCRIPTION,
    {
      question: z.string().min(5).max(500).describe('Natural-language question (5-500 chars).'),
      model: z.enum(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']).optional().describe('Optional model override (default claude-haiku-4-5-20251001).'),
    },
    { title: 'Knowledge Q&A', ...PUBLIC_READONLY_TOOL_ANNOTATIONS },
    async ({ question, model }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        const { index, chatEngine, rateLimit, llm } = await getChatStack();
        const tier = chatTierFor(license.tier);
        const quotaKey = chatQuotaApiKey(license.key, getRequestIpHash() ?? null);
        const check = await rateLimit.check(quotaKey, tier);
        if (!check.allowed) {
          const days = Math.max(1, Math.ceil((check.resetAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
          // CHAT-USAGE-ANALYTICS-W1: quota-exhausted recorded as event (errorCode, cost=0)
          recordChatEvent({
            apiKeyId: license.key,
            apiKeyTier: tier,
            surface: 'mcp_tool',
            question,
            answer: '',
            citationsCount: 0,
            model: model ?? 'claude-haiku-4-5-20251001',
            provider: llm.name,
            usage: { promptTokens: 0, completionTokens: 0 },
            latencyMs: Date.now() - startMs,
            errorCode: 'CHAT_QUOTA_EXHAUSTED',
          });
          const payload = {
            code: 'CHAT_QUOTA_EXHAUSTED',
            message: `Monthly chat quota exhausted for tier ${tier} (${check.limit}/mo). Resets in ${days} day(s).`,
            retry_after_days: days,
            limit: check.limit,
            tier,
            upgrade_url: 'https://algovault.com/#pricing',
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
        }
        const result = await runAsCaller('chat_knowledge', () => chatEngine.chat(question, { model }));
        // Record AFTER successful LLM call (rate-limit reflects actual usage)
        await rateLimit.record(quotaKey, result.usage);
        const bundle = index.getBundle();
        const response = formatChatKnowledgeResponse(result, bundle, Math.max(0, check.remaining - 1));
        // CHAT-USAGE-ANALYTICS-W1: record success event AFTER response built (fire-and-forget)
        recordChatEvent({
          apiKeyId: license.key,
          apiKeyTier: tier,
          surface: 'mcp_tool',
          question,
          answer: result.answer,
          citationsCount: result.citations.length,
          model: result.model,
          provider: llm.name,
          usage: result.usage,
          latencyMs: Date.now() - startMs,
        });
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'chat_knowledge',
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );

  // FEATURE-REGISTRY-SOT-W1 CH2: registry-driven registration — register exactly the
  // names FEATURE_REGISTRY declares (canonical + aliases), pulling each tool's verbatim
  // handler/schema/annotations/description from toolDefs. Bidirectional parity guard:
  // a registry name with no handler def — or a handler def absent from the registry —
  // throws at boot (drift can't ship silently; the CH4 canary enforces the same live).
  for (const name of allToolNames()) {
    const d = toolDefs[name];
    if (!d) throw new Error(`[feature-registry] "${name}" is in FEATURE_REGISTRY but has no handler def in createServer()`);
    (server as { tool: (n: string, desc: string, s: z.ZodRawShape, a: Record<string, unknown>, h: unknown) => void }).tool(
      name, d.description, d.schema, d.annotations, d.handler,
    );
  }
  for (const defName of Object.keys(toolDefs)) {
    if (!allToolNames().includes(defName)) throw new Error(`[feature-registry] handler def "${defName}" is not in FEATURE_REGISTRY (registration drift)`);
  }

  // ── Signal performance: admin-only (via /dashboard and /analytics) ──
  // Removed from public MCP tools — track record will be re-exposed
  // once signal quality is improved via weight retuning.

  // ── Resource: analytics-summary (pro/enterprise/x402 only) ──
  server.resource(
    'usage-stats',
    'analytics://usage-stats',
    { description: 'Request analytics — call counts, tool breakdown, tier distribution, top assets, response times. Requires Pro or higher.' },
    async () => {
      const stats = await getAnalyticsSummary();
      return { contents: [{ uri: 'analytics://usage-stats', mimeType: 'application/json', text: JSON.stringify(stats, null, 2) }] };
    }
  );

  // signal-performance resource: PFE win rate only.
  // Non-negotiable for every signal-producing tool per AlgoVault build rules.
  // Re-registered after earlier refactor removed the server.resource() call.
  // Import at line 17 (getSignalPerformance, runBackfill) is already present.
  // NOTE: Outcome-based WR (from Phase E, outcome_return_pct) is INTERNAL to
  // AlgoVault's quant engine — never exposed via MCP or any public surface.
  server.resource(
    'signal-performance',
    'performance://signal-performance',
    { description: 'Signal track record — PFE win rates by timeframe, asset, tier, and signal type. Measures whether price moved in the signal direction during the evaluation window.' },
    async () => {
      const stats = await getSignalPerformance();
      // EQUITIES-ENGINE-W1 E6: ADDITIVE `equities` key (PFE-only). Crypto keys
      // byte-unchanged. Fail-open — equity DB issues must never break the crypto
      // resource (graceful pre-data shape on error).
      let equities: unknown;
      try {
        equities = await getEquityPerformance(getEquityPool());
      } catch {
        equities = { state: 'pre_data', overall: { totalCalls: 0, totalEvaluated: 0, pfeWinRate: null } };
      }
      return {
        contents: [{
          uri: 'performance://signal-performance',
          text: JSON.stringify({ ...stats, equities }, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  // ── DESIGN-W9 (2026-05-11): verify://signal/{id} resource ──
  // PUBLIC-ONLY response shape per Q-W9-6 architect ratification: {status, leaf, root, batch, tx}.
  // Phase-E aggregate columns (per-signal evaluation result + return basis-points) are
  // INTENTIONALLY OMITTED — Data Integrity LAW (those numbers stay internal). Mr.1 directive #4
  // ("MCP resource — Want to verify in code? — are we able to make this?") becomes LIVE here.
  //
  // {id} acceptance per Q-W9-8 BOTH-form ratification:
  //   - `0x…` prefix → look up by signal_hash (matches JSX VFooter demo `verify://signal/0x4a2…f91`)
  //   - else → parseInt({id}) → look up by integer DB ID (matches existing /api/verify-signal flow)
  server.resource(
    'verify-signal',
    new ResourceTemplate('verify://signal/{id}', { list: undefined }),
    {
      description: 'Verify a single trade-call signal against its on-chain Merkle proof. Returns {status, leaf, root, batch, tx} — PUBLIC-ONLY shape (no outcome / PFE fields). Accepts both integer DB ID (e.g. 12345) and hex leaf hash (e.g. 0x4a2c…7f91).',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const rawId = String((variables as any).id || '');
      // Q-W9-8 dual-form: hex `0x…` → hash lookup; else integer DB ID.
      const isHex = rawId.startsWith('0x') || rawId.startsWith('0X');
      let row: any = null;
      let status: 'verified' | 'pending' | 'notfound' = 'notfound';
      if (isHex) {
        row = await getSignalByHash(rawId);
      } else {
        const intId = parseInt(rawId, 10);
        if (Number.isFinite(intId) && intId > 0) {
          row = await getSignalWithBatch(intId);
        }
      }
      const body: Record<string, unknown> = {
        _algovault: {
          tool: 'verify-signal',
          version: PKG_VERSION,
          source: 'verify://signal/{id}',
          ts: new Date().toISOString(),
        },
      };
      if (!row) {
        body.status = 'notfound';
        body.requested_id = rawId;
      } else if (!row.merkle_batch_id || !row.merkle_root) {
        // Signal recorded but not yet committed to an on-chain Merkle batch.
        status = 'pending';
        body.status = status;
        body.leaf = row.signal_hash || null;
        body.requested_id = rawId;
      } else {
        status = 'verified';
        body.status = status;
        body.leaf = row.signal_hash;
        body.root = row.merkle_root;
        body.batch = row.merkle_batch_id;
        body.tx = row.tx_hash;
        // NOTE (Q-W9-6 Data Integrity LAW): per-signal Phase-E evaluation fields (won-flag,
        // peak-favorable-excursion basis points, return percentage) are intentionally omitted
        // from this public-facing shape. Phase-E aggregates flow through the separate
        // `performance://signal-performance` resource (rate-only aggregate; no per-signal data).
      }
      // Discard unused status var (lint guard).
      void status;
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(body, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  // ── Resource: venues (EXCHANGE-SHADOW-PROMOTE-W1 / C2) ──
  // Live per-venue lifecycle status table. PUBLIC — exposes the same
  // information surfaced via /api/performance-shadow (C4) but in MCP-resource
  // form so agents can self-discover supported venues + their experimental/
  // production state. Sortable enumeration:
  //   - status='promoted': production-grade; appear in /api/performance-public
  //   - status='shadow': experimental; opt-in via explicit exchange param;
  //     NOT yet on dashboard; auto-promote when ≥80% PFE WR over
  //     asset_count×10 BUY/SELL signals (HOLDs excluded).
  //   - status='retired': terminal; do NOT route new traffic here.
  server.resource(
    'venues',
    'mcp://algovault/venues',
    {
      description: "Per-venue lifecycle state machine: shadow / promoted / retired. Each venue carries asset_count, integration + lifecycle timestamps (integrated_at / promoted_at / retired_at), and extension_count. New venues default to 'shadow' (experimental — not yet on the public /track-record dashboard) and are flagged ready-for-promotion when PFE WR clears the internal bar; an operator launches the promotion. Agents querying with a shadow venue's exchange_id should surface an 'experimental' caveat to the end user.",
      mimeType: 'application/json',
    },
    async () => {
      const venues = await listVenues();
      const body = {
        _algovault: {
          tool: 'venues',
          version: PKG_VERSION,
          ts: new Date().toISOString(),
        },
        // SV-01 (OPS-AUDIT-REMEDIATION-MED-W1): allow-list formatter strips the
        // internal promotion threshold (min_buy_sell_sample) + last_eval_*
        // evaluation internals. Single source shared with /api/performance-shadow.
        venues: venues.map(formatVenueForResource),
      };
      return {
        contents: [{
          uri: 'mcp://algovault/venues',
          mimeType: 'application/json',
          text: JSON.stringify(body, null, 2),
        }],
      };
    }
  );

  // ── Resource: skills-analytics (PUBLIC — slug-level aggregates, no user data) ──
  // C6 (algovault-skills SKILLS-W1) — surfaces per-Skill call counts so any
  // agent can see which Skills drive volume. Public-safe: slugs are public
  // artifacts (visible in github.com/AlgoVaultLabs/algovault-skills/skills/).
  server.resource(
    'skills-analytics',
    'analytics://skills',
    { description: 'Per-Skill invocation counters (calls_24h, calls_7d, calls_all_time, first/last seen) for the algovault-skills plugin. Public — slug-level aggregates only.' },
    async () => {
      const stats = await getSkillsAnalytics();
      return {
        contents: [{
          uri: 'analytics://skills',
          text: JSON.stringify(stats, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  // ── Resource: knowledge bundle (PUBLIC — auto-generated per-release artifact) ──
  // KNOWLEDGE-ARTIFACT-W1 (2026-05-18). Each registered URI is backed by a
  // file in dist/knowledge/. `algovault://knowledge/latest` always points at
  // the most-recent generated bundle; `algovault://knowledge/algovault-
  // knowledge-vX.Y.Z` pins a specific version. The bundle includes every MCP
  // tool description, response-shape audit snapshot, integration tutorial,
  // and code example — indexed for LLM consumption (future algovault.search
  // + algovault.chat). See audits/knowledge-shape-snapshot-2026-05-18.json
  // for the public-shape contract + drift_check_command.
  for (const res of listKnowledgeResources()) {
    server.resource(
      res.name,
      res.uri,
      { description: res.description, mimeType: 'application/json' },
      async () => {
        // Slug = the trailing path segment after `algovault://knowledge/`.
        const slugMatch = res.uri.match(/^algovault:\/\/knowledge\/(.+)$/);
        if (!slugMatch) {
          throw new Error(`Invalid knowledge URI: ${res.uri}`);
        }
        const rawSlug = slugMatch[1];
        // 'latest' is direct; version-pinned URIs are 'algovault-knowledge-vX.Y.Z'.
        const versionSlug = rawSlug === 'latest' ? 'latest' : rawSlug.replace(/^algovault-knowledge-/, '');
        const bundle = getKnowledgeBundle(versionSlug);
        if (!bundle) {
          throw new Error(`Knowledge bundle not found for ${versionSlug}`);
        }
        return {
          contents: [
            {
              uri: res.uri,
              mimeType: 'application/json',
              text: JSON.stringify(bundle, null, 2),
            },
          ],
        };
      }
    );
  }

  return server;
}

// ── Stdio Mode ──
async function startStdio() {
  initAnalytics();
  initQuotaDb();
  // ACTIVATION-PAYWALL-W1: processed_stripe_events idempotency table.
  // Single multi-statement dbExec per CLAUDE.md "Postgres DDL bundling" rule.
  ensureProcessedStripeEventsSchema();
  const server = createServer();
  const transport = new StdioServerTransport();

  // Stdio mode: resolve license from env synchronously (no x402 in stdio).
  // AsyncLocalStorage enterWith() keeps it active for all async work in this context.
  const license = resolveLicenseSync({});
  requestContext.enterWith({ license });

  await server.connect(transport);

  const shutdown = () => {
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── HTTP Mode (Streamable HTTP) ──
async function startHttp() {
  // Initialize x402 on-chain verification (no-ops if not configured)
  await initX402();
  initAnalytics();
  initQuotaDb();
  // ACTIVATION-PAYWALL-W1: processed_stripe_events idempotency table.
  // Single multi-statement dbExec per CLAUDE.md "Postgres DDL bundling" rule.
  ensureProcessedStripeEventsSchema();

  // REFERRAL-LIGHT-W1 (C3): ensure the live Stripe webhook is subscribed to
  // invoice.paid + charge.refunded (read→union→write, *=no-op, fail-open + runbook).
  // Fire-and-forget so a Stripe API hiccup never delays server boot.
  void import('./lib/referral-accrual.js').then((m) => m.ensureReferralWebhookEvents()).catch(() => {});

  const { default: express } = await import('express');
  const { default: rateLimit } = await import('express-rate-limit');

  const app = express();
  app.set('trust proxy', 1); // Trust Caddy reverse proxy for req.secure, req.ip
  const port = parseInt(process.env.PORT || '3000', 10);

  // CORS — restrict to same-origin + algovault.com
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'https://api.algovault.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-payment, mcp-session-id, x-algovault-skill-slug, x-algovault-track-token');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Rate limiting
  app.use('/mcp', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
  app.use('/analytics', rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));
  app.use('/webhooks', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

  // OPS-MCP-SESSION-RESILIENCE-W1: the remote MCP transport runs STATELESS by default
  // (sessionIdGenerator: undefined → no session issued or validated → nothing can be
  // orphaned by a deploy / idle-reap / restart, and no sticky-routing 404 under horizontal
  // scale-out). MCP_STATELESS=0 restores the legacy stateful path below (instant rollback).
  const MCP_STATELESS = process.env.MCP_STATELESS !== '0';

  // Stateful-only session registry + idle reaper — allocated and ticking ONLY when
  // MCP_STATELESS=0. Under the default stateless path nothing allocates and no interval
  // leaks (R4).
  let statefulTransports: Map<string, StreamableHTTPServerTransport> | undefined;
  let statefulLastActivity: Map<string, number> | undefined;
  let sessionCleanupInterval: ReturnType<typeof setInterval> | undefined;
  if (!MCP_STATELESS) {
    // Store active transports for session management (with last-activity tracking)
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const sessionLastActivity = new Map<string, number>();
    const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
    statefulTransports = transports;
    statefulLastActivity = sessionLastActivity;

    // Periodic cleanup of stale sessions (every 5 minutes)
    sessionCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, lastActive] of sessionLastActivity) {
        if (now - lastActive > SESSION_TTL_MS) {
          const transport = transports.get(sid);
          if (transport) {
            transport.close?.();
            transports.delete(sid);
          }
          sessionLastActivity.delete(sid);
          console.debug(`Session ${sid.slice(0, 8)}... evicted (idle ${Math.round((now - lastActive) / 60_000)}m)`);
        }
      }
    }, 5 * 60 * 1000);
  }

  // Glama.ai ownership verification
  app.get('/.well-known/glama.json', (_req, res) => {
    res.json({
      $schema: 'https://glama.ai/mcp/schemas/connector.json',
      maintainers: [{ email: 'admin@algovault.com' }],
    });
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'crypto-quant-signal-mcp', version: PKG_VERSION, stripe: isStripeConfigured() });
  });

  // FEATURE-REGISTRY-SOT-W1 CH2: machine-readable feature descriptor. Every channel
  // (bot + webhook in W2) DERIVES its surface from this (the public-safe projection of
  // FEATURE_REGISTRY) — no hand-maintained per-channel slice. No internal fields.
  app.get('/capabilities', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.json({ server: 'crypto-quant-signal-mcp', version: PKG_VERSION, ...projectCapabilities() });
  });

  // ── Integration tutorial mirrors ──
  // Static HTML pre-rendered from algovault-skills/docs/integrations/<x>.md
  // by scripts/render-integrations.mjs. Allowlist-only: anything outside the
  // 4-exchange + 4-framework set 404s (no path traversal risk; no fs lookups
  // for unknown slugs). Caddy routes /integrations/* AND /docs/integrations/*
  // here ahead of the static catch-all (see Caddyfile algovault.com block).
  //
  // Canonical path is /integrations/<slug>. The /docs/integrations/<slug>
  // path was the original URL; it is preserved as a 301 redirect so any
  // pre-2026-05-18 external link, npm-published README link, or indexed
  // search-result keeps resolving (search-engine SEO juice + agent-builder
  // clicks both inherit the new path).
  //
  // CJS-friendly path resolution (matches src/lib/pkg-version.ts pattern):
  // tsconfig targets CommonJS via Node16, so __dirname is available natively
  // and `import.meta.url` is forbidden. Read each mirror once at startup
  // into INTEGRATION_HTML so per-request overhead is a Map.get(), no fs hit.
  // BROKER-PAIRING-CRYPTO-W1 (2026-06-05): +3 crypto agentic-trading kit pages
  // (gemini/kraken/alpaca). Allow-list gates /integrations/:slug → 404 otherwise.
  const INTEGRATION_EXCHANGES = ['binance', 'okx', 'bybit', 'bitget', 'gemini', 'kraken', 'alpaca'] as const;
  const INTEGRATION_FRAMEWORKS = ['langchain', 'llamaindex', 'maf', 'crewai'] as const;
  // INTEGRATIONS-FULL-STACK-W1 C4 (2026-05-19): 5 MCP-client landing pages
  // (Plain HTTP/curl stays inline-only per Q-PLAIN-HTTP=NO; not in allow-list).
  const INTEGRATION_MCP_CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'cline', 'smithery'] as const;
  const ALL_INTEGRATION_SLUGS = [...INTEGRATION_EXCHANGES, ...INTEGRATION_FRAMEWORKS, ...INTEGRATION_MCP_CLIENTS];
  const INTEGRATION_HTML = new Map<string, string>();
  {
    // dist/index.js → ../landing/integrations
    const integrationsDir = path.resolve(__dirname, '..', 'landing', 'integrations');
    for (const slug of ALL_INTEGRATION_SLUGS) {
      try {
        INTEGRATION_HTML.set(slug, fs.readFileSync(path.join(integrationsDir, `${slug}.html`), 'utf8'));
      } catch (err) {
        console.warn(`integration mirror ${slug}.html not loaded at startup:`, err instanceof Error ? err.message : err);
      }
    }
  }
  app.get('/integrations/:slug', (req, res) => {
    const slug = (req.params.slug || '').toLowerCase().replace(/\.html$/, '');
    const html = INTEGRATION_HTML.get(slug);
    if (!html) {
      return res.status(404).type('text/plain').send('Integration not found');
    }
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.type('text/html').send(html);
  });
  app.get('/docs/integrations/:slug', (req, res) => {
    const slug = (req.params.slug || '').toLowerCase().replace(/\.html$/, '');
    return res.redirect(301, `/integrations/${slug}`);
  });

  // ── /skills page (WEBSITE-REFRESH-W1 C4) ──
  // Pre-loaded at startup into a string for zero-fs-hit per-request serving.
  // Same CJS __dirname pattern as the integration mirrors above (see
  // src/lib/pkg-version.ts:10 for the canonical "no import.meta.url under
  // CJS tsconfig" gotcha + fix).
  let SKILLS_HTML: string | null = null;
  try {
    SKILLS_HTML = fs.readFileSync(path.resolve(__dirname, '..', 'landing', 'skills.html'), 'utf8');
  } catch (err) {
    console.warn('skills.html not loaded at startup:', err instanceof Error ? err.message : err);
  }
  app.get('/skills', (_req, res) => {
    if (!SKILLS_HTML) {
      return res.status(500).type('text/plain').send('skills page not available');
    }
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.type('text/html').send(SKILLS_HTML);
  });

  // ── /integrations index page (WEBSITE-REFRESH-CLEANUP-W1 R4) ──
  // Manifest-driven listing of all integrations (mirrors the /skills pattern).
  // Pre-loaded at startup into a string for zero-fs-hit per-request serving.
  // Caddy routes /integrations here ahead of the static catch-all so future
  // edits to landing/integrations.html don't require a Caddy reload.
  let INTEGRATIONS_INDEX_HTML: string | null = null;
  try {
    INTEGRATIONS_INDEX_HTML = fs.readFileSync(path.resolve(__dirname, '..', 'landing', 'integrations.html'), 'utf8');
  } catch (err) {
    console.warn('integrations.html not loaded at startup:', err instanceof Error ? err.message : err);
  }
  app.get('/integrations', (_req, res) => {
    if (!INTEGRATIONS_INDEX_HTML) {
      return res.status(500).type('text/plain').send('integrations page not available');
    }
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.type('text/html').send(INTEGRATIONS_INDEX_HTML);
  });

  // (REMOVED 2026-04-24) Public per-Skill analytics page. Per-Skill funnel data
  // is competitive intel, not public moat-proof. Migrated to admin-gated tab on
  // /dashboard. New endpoint: /dashboard/api/skills-analytics (JSON, admin-only).
  // The X-AlgoVault-Skill-Slug header interceptor in app.all('/mcp', ...) is
  // UNTOUCHED — slug logging continues; only the public surface was removed.

  // ── Stripe Webhook (raw body required — must be before express.json()) ──
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

    try {
      const event = constructWebhookEvent(req.body as Buffer, sig);
      if (!event) return res.status(400).json({ error: 'Stripe not configured' });

      switch (event.type) {
        case 'customer.subscription.created': {
          const conv = await handleSubscriptionCreated(event);
          // REFERRAL-LIGHT-W1 (C3): if this paid signup carried a ref code (stamped
          // on the subscription by createCheckoutSession), attribute the conversion +
          // grant the referee bonus with the freshly-minted key. Fail-open; the
          // entitlement (key + welcome email) already happened inside the handler.
          if (conv?.refCode) {
            try {
              const { onPaidConversion } = await import('./lib/referral-accrual.js');
              await onPaidConversion({ customerId: conv.customerId, apiKey: conv.apiKey, refCode: conv.refCode, email: conv.email });
            } catch (err) {
              console.error('Stripe webhook: referral paid-conversion hook failed (fail-open):', err instanceof Error ? err.message : err);
            }
          }
          break;
        }
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event);
          break;
        case 'checkout.session.completed': {
          // ACTIVATION-PAYWALL-W1: structured tier promotion + UTM round-trip.
          const summary = summarizeCheckoutCompleted(event);
          if (!summary) {
            console.warn(`Stripe webhook: checkout.session.completed with unparseable session payload (event ${event.id})`);
            break;
          }
          // Idempotency BEFORE side-effect: claim the event-id, dedup retries.
          const isNew = await tryClaimEvent({
            event_id: event.id,
            event_type: event.type,
            session_id: summary.sessionId,
            customer_email: summary.customerEmail,
            amount_total: summary.amountTotal,
            metadata: {
              tier: summary.tier,
              utm_source: summary.utmSource,
              utm_campaign: summary.utmCampaign,
              client_reference_id: summary.clientReferenceId,
            },
          });
          if (!isNew) {
            console.log(`Stripe webhook: duplicate checkout.session.completed (event ${event.id}) — already processed`);
            return res.json({ received: true, status: 'duplicate' });
          }
          // Attribution write: NEW request_log row anchoring the conversion.
          // Per CLAUDE.md "load-bearing side-effect inside try/except needs a
          // companion success-path log" — both branches log.
          try {
            const referrerTag = summary.utmSource
              ? `utm:${summary.utmSource}${summary.utmCampaign ? `:${summary.utmCampaign}` : ''}`
              : null;
            logRequest({
              sessionId: summary.sessionId,
              toolName: 'stripe_checkout_completed',
              licenseTier: summary.tier,
              responseTimeMs: 0,
              verdict: referrerTag ?? undefined,
              isBotInternal: false,
            });
            console.log(`Stripe webhook: checkout.session.completed processed — tier=${summary.tier} session=${summary.sessionId} utm=${summary.utmSource ?? 'none'}/${summary.utmCampaign ?? 'none'}`);
          } catch (logErr) {
            console.error('Stripe webhook: request_log attribution write failed:', logErr instanceof Error ? logErr.message : logErr);
            // Don't rethrow — the event-id is already claimed; Stripe won't retry.
          }
          // SUBSCRIBER-ATTRIBUTION-SPINE-W1 (C2): auto-profile this conversion
          // (channel · country · cold/warm · latency) into subscriber_profiles —
          // the productized SUBSCRIBER-ATTRIBUTION-DIAGNOSIS-W1. Runs ONLY here
          // (the isNew branch, after tryClaimEvent) so a webhook replay never
          // re-profiles; the upsert is ALSO idempotent on customer_id. Fire-and-
          // forget + fail-open: MUST NOT block/slow/fail the webhook ACK, and the
          // entitlement grant rides a SEPARATE event (customer.subscription.created),
          // so it is wholly unaffected.
          try {
            const { buildSubscriberProfile } = await import('./lib/subscriber-attribution.js');
            void buildSubscriberProfile(event.data.object).catch((profErr) => {
              console.error('Stripe webhook: subscriber profiler failed (fail-open):', profErr instanceof Error ? profErr.message : profErr);
            });
          } catch (dispatchErr) {
            console.error('Stripe webhook: subscriber profiler dispatch failed (fail-open):', dispatchErr instanceof Error ? dispatchErr.message : dispatchErr);
          }
          break;
        }
        case 'invoice.paid': {
          // REFERRAL-LIGHT-W1 (C3): accrue 30% referral commission (idempotent on
          // the event id; auto Stripe-credit or usdc_pending). Fail-open internally.
          const { processInvoicePaid } = await import('./lib/referral-accrual.js');
          await processInvoicePaid(event);
          break;
        }
        case 'charge.refunded': {
          // REFERRAL-LIGHT-W1 (C3): claw back any commission accrued on the refund.
          const { processChargeRefunded } = await import('./lib/referral-accrual.js');
          await processChargeRefunded(event);
          break;
        }
        default:
          console.log(`Stripe webhook: unhandled event ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook error:', err instanceof Error ? err.message : err);
      res.status(400).json({ error: 'Webhook verification failed' });
    }
  });

  // ── Signup (redirects to Stripe Checkout) ──
  // ACTIVATION-PAYWALL-W1: forwards UTM query params (utm_source, utm_campaign)
  // through to Stripe metadata so `checkout.session.completed` attribution
  // round-trips into `request_log`.
  app.get('/signup', async (req, res) => {
    const plan = req.query.plan as string;
    const utmSource = typeof req.query.utm_source === 'string' ? req.query.utm_source : undefined;
    const utmCampaign = typeof req.query.utm_campaign === 'string' ? req.query.utm_campaign : undefined;
    const upgradeFrom = typeof req.query.upgrade_from === 'string' ? req.query.upgrade_from : undefined;
    // Derive a session-unique client_reference_id for downstream attribution
    // join even when UTM tags are absent (e.g. direct /signup typing).
    const clientReferenceId = `${utmSource ?? 'direct'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    // ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28) + LANDING-CONVERSION-TRUST-W1 (2026-06-19):
    // capture the CTA click BEFORE the plan-gate so keyless / plan-less landing clicks are
    // measured too (the early-return on an absent/invalid plan previously skipped them).
    // Recorded before the Stripe redirect so clicks that never complete checkout still count
    // (funnel diff stage 7 → 8). Landing-sourced clicks (`upgrade_from=landing_*`) get a
    // DISTINCT `landing_cta_clicked` event so cold-acquisition does NOT inflate the
    // `upgrade_cta_clicked` nudge-conversion stage (CANONICAL_STAGE_ORDER stage 7).
    // Lazy-import + fail-open.
    if (upgradeFrom && upgradeFrom.length > 0 && upgradeFrom.length <= 40) {
      try {
        const { recordFunnelEvent } = await import('./lib/performance-db.js');
        recordFunnelEvent({
          eventType: classifyCtaEventType(upgradeFrom),
          sessionId: clientReferenceId,
          licenseTier: 'free',
          meta: {
            plan: plan ?? null,
            upgrade_from: upgradeFrom,
            utm_source: utmSource ?? null,
            utm_campaign: utmCampaign ?? null,
          },
        });
      } catch (err) {
        // Fail-open per CLAUDE.md `## Automation-first recovery → fail-open`.
        console.warn('[cta_clicked] recordFunnelEvent failed:', err instanceof Error ? err.message : err);
      }
    }

    // REFERRAL-LIGHT-W1 (C3): capture ?ref= — validate (invalid → ignore, NEVER
    // block checkout) + record a ref-click funnel signal. Carried into Stripe
    // checkout metadata for the paid path; the free path uses /api/signup-email.
    let refCode: string | undefined;
    const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
    if (ref) {
      try {
        const { resolveCode } = await import('./lib/referral-store.js');
        const code = await resolveCode(ref);
        if (code) {
          refCode = code.code;
          const { recordFunnelEvent } = await import('./lib/performance-db.js');
          recordFunnelEvent({ eventType: 'referral_click', sessionId: clientReferenceId, licenseTier: 'free', meta: { code: code.code, plan: plan ?? null } });
        }
      } catch (err) {
        console.warn('[/signup referral] capture failed (fail-open):', err instanceof Error ? err.message : err);
      }
    }

    if (plan !== 'starter' && plan !== 'pro' && plan !== 'enterprise') {
      // REFERRAL-WEB-FIX-W1: an old shared link /signup?ref=CODE (no plan) → redirect to
      // the branded apex referee landing /join?ref= (which actually grants the free 500).
      // /join validates the ref; a no-ref no-plan visit keeps the paid-plans page.
      if (ref) {
        return res.redirect(302, `https://algovault.com/join?ref=${encodeURIComponent(ref)}`);
      }
      return res.status(400).send(getSignupPageHtml());
    }

    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const url = await createCheckoutSession(plan, baseUrl, {
        utmSource,
        utmCampaign,
        clientReferenceId,
        refCode,
      });
      if (!url) return res.status(500).send('Stripe not configured or missing price IDs');
      // SUBSCRIBER-ATTRIBUTION-SPINE-W1 (C1): persist the click attribution so
      // the conversion webhook (C2) can JOIN to it by client_reference_id —
      // closing the blind spot SUBSCRIBER-ATTRIBUTION-DIAGNOSIS-W1 hit. Lazy-
      // import + fire-and-forget + fail-open (mirrors the recordFunnelEvent arm
      // above): a capture error MUST NOT affect the 303 redirect, its latency,
      // or the client_reference_id value. ip_hash via the existing hashIp helper
      // (the requestContext ALS is only entered for /mcp, so derive the IP from
      // the proxy headers like the /mcp handler does).
      try {
        // OPS-MCP-DEFENSE-IN-DEPTH-W1 R2: derive from req.ip (trust proxy=1) via the
        // shared clientIp helper — byte-identical to the prior raw-XFF leftmost parse
        // under the deployed Caddy replace-mode topology, robust to a proxy reconfig.
        const ip = clientIp(req);
        const { recordSignupAttribution } = await import('./lib/subscriber-attribution.js');
        recordSignupAttribution({
          clientReferenceId,
          utmSource: utmSource ?? null,
          utmMedium: typeof req.query.utm_medium === 'string' ? req.query.utm_medium : null,
          utmCampaign: utmCampaign ?? null,
          referrer: (req.headers['referer'] as string | undefined) ?? null,
          landingPath: typeof req.query.landing_path === 'string'
            ? req.query.landing_path
            : (req.headers['referer'] as string | undefined) ?? null,
          tierRequested: plan,
          ipHash: ip ? hashIp(ip) : null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
      } catch (err) {
        console.warn('[/signup attribution] capture failed (fail-open):', err instanceof Error ? err.message : err);
      }
      res.redirect(303, url);
    } catch (err) {
      console.error('Stripe checkout error:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to create checkout session');
    }
  });

  // ── Welcome (shows API key after successful checkout OR paywall CTA on organic visit) ──
  // ACTIVATION-PAYWALL-W1: organic visits (no session_id) get the paywall CTA
  // arm. Post-checkout visits (session_id present) get the API-key reveal.
  // UTM query params are surfaced to the template so the paywall button
  // preserves the attribution chain through to Stripe.
  app.get('/welcome', async (req, res) => {
    const sessionId = req.query.session_id as string | undefined;
    const utmSource = typeof req.query.utm_source === 'string' ? req.query.utm_source : null;
    const utmCampaign = typeof req.query.utm_campaign === 'string' ? req.query.utm_campaign : null;

    // FUNNEL-FIX-HUMAN-SIGNUP-W1: render the value-before-email + OAuth options only when flagged;
    // each OAuth button renders ONLY when its real creds exist (no stub buttons shown to users).
    const { isNewSignupEnabled, isUnifiedSigninEnabled, getAuthProvider } = await import('./lib/auth-providers.js');
    const newSignupEnabled = isNewSignupEnabled();
    // FUNNEL-FIX-AUTH-UNIFY-W1: outer flag → the ONE shared sign-in card on the organic arm.
    const unifiedSignin = isUnifiedSigninEnabled();
    const oauthProviders = { google: getAuthProvider('google').live, github: getAuthProvider('github').live };
    const src = typeof req.query.src === 'string' ? req.query.src : null;

    // Organic visit (no session_id) — render paywall CTA + no API-key reveal.
    if (!sessionId) {
      return res.send(getWelcomePageHtml(null, null, null, { utmSource, utmCampaign, newSignupEnabled, oauthProviders, unifiedSignin, src }));
    }

    try {
      const { apiKey, tier, email } = await getCustomerApiKey(sessionId);
      res.send(getWelcomePageHtml(apiKey, tier, email, { utmSource, utmCampaign, newSignupEnabled, oauthProviders, unifiedSignin, src }));
    } catch (err) {
      console.error('Welcome page error:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to retrieve your API key. Please contact support@algovault.com');
    }
  });

  // ── /account self-service portal ──
  // Per-IP rate-limit for the email-recovery path (5 req/IP/hr) — prevents
  // abuse / scraping. /account/portal needs a valid API key to do anything,
  // so it doesn't need a separate IP limit beyond the existing trust-proxy.
  const recoverKeyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many recovery requests. Try again in an hour.',
  });

  app.get('/account', accountPageHandler);
  app.post('/account/portal', express.urlencoded({ extended: false }), accountPortalHandler);
  app.post('/account/recover-key', recoverKeyLimiter, express.urlencoded({ extended: false }), accountRecoverKeyHandler);
  // REFERRAL-LIGHT-W1 (C4): referral dashboard (paste key) + public terms page.
  app.post('/account/referrals', express.urlencoded({ extended: false }), accountReferralsHandler);
  // REFERRAL-PAYOUT-OPS-W1 (C1): save/clear the referrer's Base USDC payout address.
  app.post('/account/referrals/payout-address', express.urlencoded({ extended: false }), accountPayoutAddressHandler);
  app.get('/referral-terms', async (_req, res) => {
    const { renderReferralTermsPage } = await import('./lib/referral-pages.js');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderReferralTermsPage());
  });
  // LANDING-REFERRAL-PAGE-W1: public, indexable /referral explainer + share
  // destination (incentive-first; CTA routes anon visitors to /account). Served
  // on the apex via the Caddyfile `handle /referral` reverse_proxy (same path as
  // /track-record) so algovault.com/referral resolves; mirrors /referral-terms.
  app.get('/referral', async (req, res) => {
    const { renderReferralLandingPage } = await import('./lib/referral-pages.js');
    // FUNNEL-FIX-AUTH-UNIFY-W1: outer flag OFF → email-only legacy page (byte-identical);
    // ON → the shared sign-in card (referral reachable by one-tap Google/GitHub).
    const { isUnifiedSigninEnabled, isNewSignupEnabled, getAuthProvider } = await import('./lib/auth-providers.js');
    const unifiedSignin = isUnifiedSigninEnabled();
    const referralOpts = unifiedSignin
      ? {
          unifiedSignin,
          newSignupEnabled: isNewSignupEnabled(),
          oauthProviders: { google: getAuthProvider('google').live, github: getAuthProvider('github').live },
          src: typeof req.query.src === 'string' ? req.query.src : null,
        }
      : {};
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderReferralLandingPage(referralOpts));
  });
  // REFERRAL-WEB-FIX-W1: the branded apex referee landing every web share link points
  // to. Validates ?ref= (invalid/missing → graceful general start-free, no bonus claim);
  // the start-free form carries ref → /api/signup-email?ref= → real 500 grant. Apex-served
  // via the Caddyfile `handle /join` reverse_proxy (same mechanism as /track-record).
  app.get('/join', async (req, res) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    let refValid = false;
    let code: string | undefined;
    if (ref) {
      try {
        const { resolveCode } = await import('./lib/referral-store.js');
        const c = await resolveCode(ref);
        if (c) { refValid = true; code = c.code; }
      } catch (err) {
        console.warn('[/join] ref resolve failed (graceful general landing):', err instanceof Error ? err.message : err);
      }
    }
    const { renderJoinPage } = await import('./lib/referral-pages.js');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderJoinPage({ refValid, code }));
  });

  // TG-REFERRAL-W1 (C1): internal JSON API for the Telegram bot (algovault-bot),
  // which calls these over loopback with the internal-bypass key. They resolve/mint
  // a TG user's referral code and record a TG referral attribution, reusing the
  // referral engine as the single SoT. Bot-only: 401 unless checkInternalBypass
  // passes (two-flag BOT_INTERNAL_BYPASS_ENABLED + X-AlgoVault-Internal-Key).
  app.get('/api/referral/code', async (req, res) => {
    if (!checkInternalBypass(req.headers as Record<string, string | undefined>)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const tg = req.query.tg;
      const chatId = typeof tg === 'string' ? tg.trim() : '';
      if (!chatId || !/^-?\d{1,20}$/.test(chatId)) {
        return res.status(400).json({ ok: false, error: 'invalid_tg' });
      }
      const { resolveTgReferralCode } = await import('./lib/referral-api.js');
      const result = await resolveTgReferralCode(chatId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[/api/referral/code] error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  app.post('/api/referral/attribute', express.json({ limit: '2kb' }), async (req, res) => {
    if (!checkInternalBypass(req.headers as Record<string, string | undefined>)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const body = (req.body ?? {}) as { ref_code?: unknown; tg_chat_id?: unknown };
      const refCode = typeof body.ref_code === 'string' ? body.ref_code : '';
      const raw = body.tg_chat_id;
      const chatId = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
      if (!refCode || !chatId || !/^-?\d{1,20}$/.test(chatId)) {
        return res.status(400).json({ ok: false, error: 'ref_code_and_tg_chat_id_required' });
      }
      const { attributeTgReferral } = await import('./lib/referral-api.js');
      const result = await attributeTgReferral(refCode, chatId);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[/api/referral/attribute] error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // REFERRAL-PARITY-NOTIFS-W1 / C1 — notification queue (bot-only, internal-key-gated):
  // the bot pulls pending TG rows, marks them delivered, and writes the opt-out pref.
  app.get('/api/referral/notifications', async (req, res) => {
    if (!checkInternalBypass(req.headers as Record<string, string | undefined>)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
      const { listPendingNotifications } = await import('./lib/referral-store.js');
      const rows = await listPendingNotifications('tg', limit); // the bot drains the tg channel only
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        notifications: rows.map((r) => ({ id: r.id, code: r.referrer_code, event: r.event, payload: r.payload_json ? JSON.parse(r.payload_json) : null })),
      });
    } catch (err) {
      console.error('[/api/referral/notifications] error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  app.post('/api/referral/notifications/:id/delivered', express.json({ limit: '2kb' }), async (req, res) => {
    if (!checkInternalBypass(req.headers as Record<string, string | undefined>)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const { getNotificationById, markNotificationDelivered } = await import('./lib/referral-store.js');
      const row = await getNotificationById(id);
      if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
      markNotificationDelivered(id);
      return res.json({ ok: true, id, status: 'delivered' });
    } catch (err) {
      console.error('[/api/referral/notifications/:id/delivered] error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  app.post('/api/referral/notify-pref', express.json({ limit: '2kb' }), async (req, res) => {
    if (!checkInternalBypass(req.headers as Record<string, string | undefined>)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const body = (req.body ?? {}) as { tg?: unknown; opt_out?: unknown };
      const raw = body.tg;
      const chatId = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
      if (!chatId || !/^-?\d{1,20}$/.test(chatId)) return res.status(400).json({ ok: false, error: 'invalid_tg' });
      const optOut = body.opt_out === true || body.opt_out === 'true' || body.opt_out === 1;
      const { tgIdentity } = await import('./lib/referral-api.js');
      const { ensureUserCode, setNotifyOptOut } = await import('./lib/referral-store.js');
      const code = await ensureUserCode(tgIdentity(chatId)); // deterministic — the TG referrer's own code
      await setNotifyOptOut(code, optOut);
      return res.json({ ok: true, opt_out: optOut });
    } catch (err) {
      console.error('[/api/referral/notify-pref] error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // Public one-click email unsubscribe (signed; low-stakes notify pref → same notify_opt_out column).
  app.get('/referral/notify/unsubscribe', async (req, res) => {
    try {
      const code = typeof req.query.c === 'string' ? req.query.c : '';
      const sig = typeof req.query.t === 'string' ? req.query.t : '';
      const { isValidCodeFormat } = await import('./lib/referral-constants.js');
      const { notifyUnsubSig } = await import('./lib/referral-notify.js');
      const { setNotifyOptOut, resolveCode } = await import('./lib/referral-store.js');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (!isValidCodeFormat(code) || sig !== notifyUnsubSig(code) || !(await resolveCode(code))) {
        return res.status(400).send('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#1f2328"><h2>Invalid link</h2><p>This unsubscribe link is invalid or expired. Manage notifications from the Telegram bot (/notifications) or contact support@algovault.com.</p></body>');
      }
      await setNotifyOptOut(code, true);
      return res.send('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#1f2328"><h2>Notifications off</h2><p>You won&#39;t receive referral join/earnings notifications anymore. Changed your mind? Re-enable from the Telegram bot (<code>/notifications</code>).</p></body>');
    } catch (err) {
      console.error('[/referral/notify/unsubscribe] error:', err instanceof Error ? err.message : err);
      return res.status(500).send('Internal error');
    }
  });

  // Admin analytics (only if ADMIN_API_KEY is set)
  let adminCleanupInterval: ReturnType<typeof setInterval> | undefined;
  const adminKeyRaw = process.env.ADMIN_API_KEY;
  if (adminKeyRaw) {
    const adminKey: string = adminKeyRaw;
    // Admin session management — avoids embedding the key in dashboard HTML
    const adminSessions = new Map<string, number>(); // token → expiresAt
    const ADMIN_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
    const ADMIN_COOKIE_NAME = 'av_admin_session';

    // Periodic cleanup of expired admin sessions (every 30 minutes)
    adminCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [token, expiresAt] of adminSessions) {
        if (now > expiresAt) adminSessions.delete(token);
      }
    }, 30 * 60 * 1000);

    function createAdminSession(): string {
      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL);
      return token;
    }

    function isValidAdminSession(cookieHeader?: string): boolean {
      if (!cookieHeader) return false;
      const match = cookieHeader.match(new RegExp(`${ADMIN_COOKIE_NAME}=([a-f0-9]+)`));
      if (!match) return false;
      const token = match[1];
      const expiresAt = adminSessions.get(token);
      if (!expiresAt || Date.now() > expiresAt) {
        adminSessions.delete(token);
        return false;
      }
      return true;
    }

    /** Check admin auth: Bearer token, query key, or session cookie. */
    function isAdminAuthorized(req: import('express').Request): boolean {
      // Bearer token or query key
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
        || (req.query.key as string);
      if (token && safeCompare(token, adminKey)) return true;
      // Session cookie
      return isValidAdminSession(req.headers.cookie);
    }

    // JSON API
    app.get('/analytics', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const stats = await getUsageStats();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch analytics' });
      }
    });

    // Visual dashboard — key in URL sets a session cookie, then redirects to clean URL
    app.get('/dashboard', (req, res) => {
      const key = req.query.key as string;
      if (key && safeCompare(key, adminKey)) {
        // Authenticate: set session cookie, redirect to clean URL
        const sessionToken = createAdminSession();
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL / 1000}${req.secure ? '; Secure' : ''}`);
        return res.redirect(303, '/dashboard');
      }
      if (!isValidAdminSession(req.headers.cookie)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      res.send(getDashboardHtml());
    });

    // Signal performance JSON (admin-only)
    app.get('/performance', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const [stats, holdStats] = await Promise.all([getSignalPerformance(), getHoldStats()]);
        res.json({ ...stats, ...holdStats });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch performance stats' });
      }
    });

    // Skills analytics JSON (admin-only) — backs the Skills section of /dashboard.
    // Same data the previous public /analytics/skills page consumed; that public
    // route is being removed in the same wave (per Data Integrity two-commit
    // pattern: this admin endpoint ships first, public is stripped in commit 2).
    // Auth: shared isAdminAuthorized — Bearer header OR ?key= query OR admin cookie.
    app.get('/dashboard/api/skills-analytics', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const stats = await getSkillsAnalytics();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch skills analytics' });
      }
    });

    // ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): admin-only 14-stage funnel snapshot.
    // Wraps the same `generateFunnelSnapshot()` library function used by the
    // weekly systemd-timer snapshot pipeline (scripts/funnel-snapshot.ts CLI +
    // commit-funnel-snapshot.sh). Window selectable via ?window=24h|7d|14d|30d|all_time
    // (default 14d). Returns full FunnelSnapshot JSON with all 14 stages +
    // stage_retentions + weakest_stage_transition. Same admin-auth pattern as
    // /dashboard/api/skills-analytics. window_label echo so clients verify the
    // server interpreted ?window correctly.
    app.get('/api/admin/funnel-snapshot', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const windowRaw = String(req.query.window ?? '14d').trim().toLowerCase();
        const windowToDays: Record<string, number> = {
          '24h': 1,
          '7d': 7,
          '14d': 14,
          '30d': 30,
          'all_time': 3650,
        };
        const days = windowToDays[windowRaw];
        if (days === undefined) {
          return res.status(400).json({
            error: 'Invalid window',
            allowed: Object.keys(windowToDays),
            got: windowRaw,
          });
        }
        const snapshot = await generateFunnelSnapshot({ days });
        // CONVERSION-MEASUREMENT-W1 C3: surface the scored PQL cohort additively
        // (env-thresholded; fail-open → empty cohort, never 500s the endpoint).
        const pql_cohort = await getPqlCandidates();
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          window_label: windowRaw,
          ...snapshot,
          pql_cohort,
        });
      } catch (err) {
        console.error(`[/api/admin/funnel-snapshot] internal error: ${err instanceof Error ? err.message : err}`);
        res.status(500).json({ error: 'Failed to generate funnel snapshot' });
      }
    });

    // CHAT-USAGE-ANALYTICS-W1 (2026-05-18): admin-only chat analytics dashboard.
    // PII-safe (SHA256 hash + length only; no raw question text). Surfaces
    // LLM-PROVIDER-A/B-W1 trigger status (≥100 queries/day × 7 consecutive
    // days) and stub-provider banner alert (Cowork Q-4 Path B).
    app.get('/admin/chat-analytics', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      try {
        const lookback = Math.max(1, Math.min(180, parseInt(String(req.query.days ?? '90'), 10) || 90));
        const html = await getChatAnalyticsHtml({ lookbackDays: lookback });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (err) {
        console.error(`[/admin/chat-analytics] internal error: ${err instanceof Error ? err.message : err}`);
        res.status(500).send('Internal error rendering chat analytics dashboard');
      }
    });

    // GEO-MEASUREMENT-W1 (C2, 2026-05-19): admin GEO dashboard. Measures whether
    // LLMs recommend AlgoVault when asked about crypto trading agents. Mirrors
    // chat-analytics auth pattern: inline isAdminAuthorized(req) check.
    app.get('/admin/geo-dashboard', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      try {
        const lookbackWeeks = Math.max(1, Math.min(52, parseInt(String(req.query.weeks ?? '12'), 10) || 12));
        const data = await getGeoDashboardData({ lookbackWeeks });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderGeoDashboardHtml(data));
      } catch (err) {
        console.error(`[/admin/geo-dashboard] internal error: ${err instanceof Error ? err.message : err}`);
        res.status(500).send('Internal error rendering GEO dashboard');
      }
    });

    // Signal performance dashboard (admin-only)
    app.get('/performance-dashboard', (req, res) => {
      const key = req.query.key as string;
      if (key && safeCompare(key, adminKey)) {
        const sessionToken = createAdminSession();
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL / 1000}${req.secure ? '; Secure' : ''}`);
        return res.redirect(303, '/performance-dashboard');
      }
      if (!isValidAdminSession(req.headers.cookie)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      res.send(getPerformanceDashboardHtml());
    });

    // Top assets by OI (admin-only)
    app.get('/api/top-assets', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
        const assets = await getTopAssetsByOI(limit);
        res.json({ assets, count: assets.length, cachedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch OI ranking' });
      }
    });

    // Confidence band analysis (admin-only)
    app.get('/api/confidence-bands', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const bands = await getConfidenceBands();
        res.json({ bands, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch confidence bands' });
      }
    });

    // REFERRAL-LIGHT-W1 (C4): referral admin surfaces — same isAdminAuthorized gate
    // (Bearer / ?key= / admin cookie) as the precedents.
    app.get('/admin/referrals', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      try {
        const { topReferrers, listRecentLedger } = await import('./lib/referral-store.js');
        const { renderAdminReferralsPage } = await import('./lib/referral-pages.js');
        const { dbQuery } = await import('./lib/performance-db.js');
        const top = await topReferrers(20);
        const ledger = await listRecentLedger(50);
        const codeRows = await dbQuery<{ c: number | string }>('SELECT COUNT(*) AS c FROM referral_codes', []);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderAdminReferralsPage({
          codeCount: codeRows.length ? Number(codeRows[0].c) : 0,
          topReferrers: top.map((t) => ({ code: t.code, signups: t.signups, conversions: t.conversions, accruedUsdE2: t.accrued_usd_e2 })),
          recentLedger: ledger.map((l) => ({ id: l.id, code: l.code, commissionUsdE2: l.commission_usd_e2, status: l.status, createdAt: l.created_at })),
        }));
      } catch (err) {
        console.error('[/admin/referrals] error:', err instanceof Error ? err.message : err);
        res.status(500).send('Internal error rendering referrals admin');
      }
    });

    app.get('/admin/referrals/payouts', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      try {
        const { pendingPayouts } = await import('./lib/referral-store.js');
        const { renderAdminPayoutsPage } = await import('./lib/referral-pages.js');
        const { REFERRAL_TERMS } = await import('./lib/referral-constants.js');
        const pending = await pendingPayouts(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderAdminPayoutsPage({
          pending: pending.map((p) => ({ code: p.code, ownerEmail: p.owner_email, payoutAddress: p.payout_address, pendingUsdE2: p.pending_usd_e2, rowCount: p.row_count, ledgerIds: p.ledger_ids })),
          batchTotalUsdE2: pending.reduce((s, p) => s + p.pending_usd_e2, 0),
          adminKey: typeof req.query.key === 'string' ? req.query.key : undefined,
        }));
      } catch (err) {
        console.error('[/admin/referrals/payouts] error:', err instanceof Error ? err.message : err);
        res.status(500).send('Internal error rendering payouts');
      }
    });

    // REFERRAL-PAYOUT-OPS-W1 (C2): Approve-all — execute the ≥ min batch via the
    // PayoutSender (C2 = Stub → reports not-configured; C3 = CDP server-wallet send),
    // then re-render the (reduced) queue with a result flash. Operator-triggered only.
    app.post('/admin/referrals/payouts/approve-all', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      try {
        const { pendingPayouts } = await import('./lib/referral-store.js');
        const { renderAdminPayoutsPage } = await import('./lib/referral-pages.js');
        const { REFERRAL_TERMS } = await import('./lib/referral-constants.js');
        const { executeApproveAllBatch, getPayoutSender } = await import('./lib/referral-payout.js');
        const { batchCapE2 } = await import('./lib/payout-config.js');
        const sender = await getPayoutSender();
        const result = await executeApproveAllBatch(sender, { maxBatchUsdE2: batchCapE2() });
        console.log(`[/admin/referrals/payouts/approve-all] sender=${result.senderKind} paid=${result.paid.length} total=${result.totalPaidUsdE2}e2 skippedNoAddr=${result.skippedNoAddress.length} failed=${result.failed.length}`);
        const pending = await pendingPayouts(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderAdminPayoutsPage({
          pending: pending.map((p) => ({ code: p.code, ownerEmail: p.owner_email, payoutAddress: p.payout_address, pendingUsdE2: p.pending_usd_e2, rowCount: p.row_count, ledgerIds: p.ledger_ids })),
          batchTotalUsdE2: pending.reduce((s, p) => s + p.pending_usd_e2, 0),
          adminKey: typeof req.query.key === 'string' ? req.query.key : undefined,
          result: {
            senderKind: result.senderKind,
            paidCount: result.paid.length,
            totalPaidUsdE2: result.totalPaidUsdE2,
            skippedNoAddress: result.skippedNoAddress,
            failed: result.failed,
          },
        }));
      } catch (err) {
        console.error('[/admin/referrals/payouts/approve-all] error:', err instanceof Error ? err.message : err);
        res.status(500).send('Internal error executing payout batch');
      }
    });

    app.post('/admin/referrals/payouts/:id/paid', express.json({ limit: '2kb' }), async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const id = parseInt(String(req.params.id), 10);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
        const txRef = typeof req.body?.tx_ref === 'string' ? req.body.tx_ref.slice(0, 200) : null;
        const { getLedgerById, markLedger } = await import('./lib/referral-store.js');
        const row = await getLedgerById(id);
        if (!row) return res.status(404).json({ error: 'ledger_row_not_found' });
        if (row.status !== 'usdc_pending') return res.status(409).json({ error: 'not_pending', status: row.status });
        markLedger(id, 'usdc_paid', txRef);
        console.log(`[/admin/referrals] ledger ${id} marked usdc_paid (tx_ref=${txRef ? 'set' : 'none'})`);
        return res.json({ ok: true, id, status: 'usdc_paid' });
      } catch (err) {
        console.error('[/admin/referrals/payouts/:id/paid] error:', err instanceof Error ? err.message : err);
        return res.status(500).json({ error: 'internal_error' });
      }
    });

    app.post('/admin/referrals/mint', express.json({ limit: '2kb' }), async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const code = typeof req.body?.code === 'string' ? req.body.code : '';
        const ownerLabel = typeof req.body?.owner_label === 'string' ? req.body.owner_label.slice(0, 120) : '';
        const ownerEmail = typeof req.body?.owner_email === 'string' ? req.body.owner_email.slice(0, 254) : null;
        if (!code || !ownerLabel) return res.status(400).json({ error: 'code_and_owner_label_required' });
        const { mintPartnerCode } = await import('./lib/referral-store.js');
        const row = await mintPartnerCode({ code, owner_label: ownerLabel, owner_email: ownerEmail });
        return res.json({ ok: true, code: row.code, kind: row.kind });
      } catch (err) {
        // mintPartnerCode throws on bad format / duplicate — surface as 400.
        return res.status(400).json({ error: 'mint_failed', detail: err instanceof Error ? err.message : String(err) });
      }
    });

    // SUBSCRIBER-ATTRIBUTION-SPINE-W1 (C3): operator subscriber tracker.
    // JSON is ADMIN_API_KEY-gated (PII flows ONLY with a valid Bearer). The HTML
    // shell below is PII-free + ungated; it prompts for the key client-side and
    // sends it ONLY as a Bearer header on this XHR (never the URL / a server log).
    app.get('/api/admin/subscribers', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 500);
        const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
        const { listSubscriberProfiles, aggregateProfiles } = await import('./lib/subscriber-attribution.js');
        const rows = await listSubscriberProfiles({ limit, offset });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ aggregates: aggregateProfiles(rows), count: rows.length, subscribers: rows });
      } catch (err) {
        console.error(`[/api/admin/subscribers] internal error: ${err instanceof Error ? err.message : err}`);
        res.status(500).json({ error: 'Failed to fetch subscribers' });
      }
    });

    // PII-free HTML shell (ungated by design — auth happens client-side via the
    // gated XHR above; the served HTML contains no subscriber data).
    app.get('/admin/subscribers', async (_req, res) => {
      try {
        const { renderSubscribersAdminHtml } = await import('./lib/subscriber-attribution.js');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderSubscribersAdminHtml());
      } catch (err) {
        console.error(`[/admin/subscribers] internal error: ${err instanceof Error ? err.message : err}`);
        res.status(500).send('Internal error rendering subscriber tracker');
      }
    });

    // H0-C4-MEASURE-CLOSE: always-on activation-funnel scoreboard (INTERNAL/META).
    // JSON — the single getFunnelScoreboard() aggregation (composes the existing
    // generateFunnelSnapshot + subscriber-attribution + Stripe census; adds no MCP
    // tool, no version bump). Admin-gated like every /dashboard/api/* endpoint.
    app.get('/dashboard/api/funnel-scoreboard', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        // FUNNEL-SCOREBOARD-V2: ?window=7|30|90|180|365|all (default all) scopes both funnels.
        const allowed = new Set(['7', '30', '90', '180', '365', 'all']);
        const wRaw = String(req.query.window ?? 'all');
        const window = (allowed.has(wRaw) ? wRaw : 'all') as '7' | '30' | '90' | '180' | '365' | 'all';
        const { getFunnelScoreboard } = await import('./lib/funnel-scoreboard.js');
        const scoreboard = await getFunnelScoreboard({ window });
        res.setHeader('Cache-Control', 'no-store');
        res.json(scoreboard);
      } catch (err) {
        console.error(`[/dashboard/api/funnel-scoreboard] internal error: ${err instanceof Error ? err.message : err}`);
        res.status(500).json({ error: 'Failed to compute funnel scoreboard' });
      }
    });

    // HTML shell — cookie-gated EXACTLY like /dashboard (anonymous → 401; ?key= sets
    // the session cookie then redirects). The served HTML embeds no data; it fetches
    // the gated JSON above via a same-origin XHR carrying the admin cookie.
    app.get('/dashboard/funnel', (req, res) => {
      const key = req.query.key as string;
      if (key && safeCompare(key, adminKey)) {
        const sessionToken = createAdminSession();
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL / 1000}${req.secure ? '; Secure' : ''}`);
        return res.redirect(303, '/dashboard/funnel');
      }
      if (!isValidAdminSession(req.headers.cookie)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Lazy require keeps the shell out of the hot import graph; sync render.
      import('./lib/funnel-dashboard-html.js')
        .then(({ renderFunnelDashboardHtml }) => res.send(renderFunnelDashboardHtml()))
        .catch((err) => {
          console.error(`[/dashboard/funnel] render error: ${err instanceof Error ? err.message : err}`);
          res.status(500).send('Internal error rendering funnel scoreboard');
        });
    });
  }

  // ── Public track record (no auth) ──
  // WEBSITE-REFRESH-CLEANUP-W1 R2: also returns `hold_rate` (computed from
  // existing totalHolds + totalCalls — additive only, no consumer breakage).
  // hold_rate = totalHolds / (totalHolds + totalCalls) * 100, rounded to 1
  // decimal place. Powers the live Pricing M3 badge ("XX.X% HOLD rate") via
  // landing/js/track-record-proxy.js.
  app.get('/api/performance-public', async (_req, res) => {
    try {
      // AUTO-TRACE-W1: capability counters added (asset_count, exchange_count,
      // timeframe_count) — read by landing/js/track-record-proxy.js to populate
      // every `data-tr-field="<name>"` span on track-record / signup / docs /
      // landing pages, so onboarding the 6th exchange auto-updates public copy.
      const [stats, holdStats, asset_count] = await Promise.all([
        getSignalPerformance(),
        getHoldStats(),
        getAssetCount(),
      ]);
      const totalHolds = holdStats.totalHolds || 0;
      const totalCalls = stats.totalCalls || 0;
      const denom = totalHolds + totalCalls;
      const hold_rate = denom > 0 ? Math.round((totalHolds / denom) * 1000) / 10 : 0;

      // SHADOW-SEED-W1: shadow-mode timeframes (1m, 3m) are stripped from
      // `byTimeframe` aggregation by default. The env flag
      // `SHADOW_REVEAL_TIMEFRAMES` (comma-list) toggles individual timeframes
      // back on once Mr.1 has reviewed the 2-week digest data. Default = both
      // hidden. To unlock 3m only: `SHADOW_REVEAL_TIMEFRAMES=3m` + container
      // restart. To unlock both: `SHADOW_REVEAL_TIMEFRAMES=1m,3m`.
      const shadowReveal = new Set(
        (process.env.SHADOW_REVEAL_TIMEFRAMES ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const SHADOW_TIMEFRAMES = ['1m', '3m'] as const;
      const filteredByTimeframe = stats.byTimeframe
        ? Object.fromEntries(
            Object.entries(stats.byTimeframe).filter(
              ([tf]) => !SHADOW_TIMEFRAMES.includes(tf as '1m' | '3m') || shadowReveal.has(tf),
            ),
          )
        : stats.byTimeframe;
      // EXCHANGE-SHADOW-PROMOTE-W1 / C4: filter `byExchange` to only
      // `venues.status='promoted'` rows. Existing 5 venues all promoted
      // post-C1 backfill → no behavior change at deploy. Shadow venues get
      // their own (auth-gated) /api/performance-shadow endpoint.
      //
      // SV-02 (OPS-AUDIT-REMEDIATION-MED-W1): FAIL-CLOSED. The prior code
      // defaulted to the UNFILTERED stats.byExchange and skipped the filter
      // when the promoted set was empty (and the catch left it unfiltered) —
      // so a venues-table outage / empty-table leaked shadow rows onto the
      // PUBLIC surface (Data-Integrity LAW violation). Now: default EMPTY,
      // ALWAYS filter to promotedIds (empty-promoted → empty, never all), and
      // on any lookup error set EMPTY. The happy path (5 promoted) is
      // byte-identical. Never let a missing filter dependency widen the
      // public response.
      let filteredByExchange: typeof stats.byExchange = {};
      let shadow_venue_count = 0;
      try {
        const promoted = await listVenues('promoted');
        const shadow = await listVenues('shadow');
        shadow_venue_count = shadow.length;
        const promotedIds = new Set(promoted.map(v => v.exchange_id));
        filteredByExchange = Object.fromEntries(
          Object.entries(stats.byExchange).filter(([ex]) => promotedIds.has(ex)),
        );
      } catch (err) {
        console.error('[performance-public] venues filter failed → fail-CLOSED → empty byExchange:', err instanceof Error ? err.message : err);
        filteredByExchange = {};
      }
      const filteredStats = { ...stats, byTimeframe: filteredByTimeframe, byExchange: filteredByExchange };

      res.json({
        ...filteredStats,
        ...holdStats,
        hold_rate,
        asset_count,
        exchange_count: EXCHANGE_COUNT,
        timeframe_count: TIMEFRAME_COUNT,
        shadow_venue_count,
        // OPS-PUBLIC-API-CONVERT-NUDGE-W1: additive machine-readable conversion
        // CTA. Existing fields byte-unchanged; single-derivation from
        // src/lib/public-cta.ts (no data withheld, no rate-limit).
        _algovault: buildPublicCtaBlock(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch performance stats' });
    }
  });

  // ── /api/performance-shadow (EXCHANGE-SHADOW-PROMOTE-W1 / C4) ──
  // Transparency endpoint for shadow venues — same per-venue stat shape as
  // /api/performance-public.byExchange.<EX> but filtered to status='shadow'
  // rows. AUTH-GATED (SV-01): requires an API key. Adds public lifecycle
  // metadata (asset_count, integrated_at, days_since_integration,
  // extension_count) so authed consumers can see each shadow venue's state.
  // The internal promotion threshold (min_buy_sell_sample) + last_eval_*
  // evaluation internals are stripped by the allow-list formatter.
  app.get('/api/performance-shadow', async (req, res) => {
    // SV-01 (OPS-AUDIT-REMEDIATION-MED-W1): shadow performance is internal —
    // auth-gate it behind an API key (same owner-resolution + 401 shape as the
    // webhook routes; single source). Premature public disclosure of not-yet-
    // promoted venue performance contradicts the "shadow until promoted" posture
    // (Mr.1 confirmed auth-gate; prior REVERT-DASHBOARD-SHADOW-COPY-W1).
    const { license } = await resolveOwner(req);
    if (!license.key) {
      return authRequired(res, 'An API key is required.');
    }
    try {
      const shadow = await listVenues('shadow');
      const stats = shadow.length > 0 ? await getSignalPerformance() : null;
      const nowSec = Math.floor(Date.now() / 1000);
      // SV-01: allow-list formatter — strips min_buy_sell_sample + last_eval_*
      // (shared with the mcp://venues resource so both surfaces inherit it).
      const venues = shadow.map(v =>
        formatShadowVenuePublic(v, stats?.byExchange?.[v.exchange_id] ?? null, nowSec),
      );
      return res.json({ venues, updated_at: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch shadow venue stats' });
    }
  });

  app.get('/api/confidence-bands-public', async (_req, res) => {
    try {
      const bands = await getConfidenceBands();
      res.json({ bands, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch confidence bands' });
    }
  });

  app.get('/track-record', (req, res) => {
    // LANDING-CONVERSION-TRUST-W1: instrument the landing/pricing → track-record click
    // as a NON-stage funnel quality signal (reuses C1 recordFunnelEvent; does NOT alter
    // CANONICAL_STAGE_ORDER=14). Fires only when a `?from=` source is present;
    // fire-and-forget + fail-open (a capture error never affects the page render).
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    if (from && from.length > 0 && from.length <= 40) {
      try {
        recordFunnelEvent({
          eventType: 'track_record_viewed',
          sessionId: `${from}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          licenseTier: 'free',
          meta: { from },
        });
      } catch (err) {
        console.warn('[track_record_viewed] recordFunnelEvent failed:', err instanceof Error ? err.message : err);
      }
    }
    res.send(getPerformanceDashboardHtml({ isPublic: true }));
  });

  // ── Merkle verification endpoints (public, no auth) ──
  const MERKLE_CONTRACT_ADDR = process.env.MERKLE_CONTRACT_ADDRESS || '';

  app.get('/api/verify-signal', async (req, res) => {
    // WEBHOOK-HARDENING-W1 C3: dual lookup — `?hash=<signal_hash>` (the form
    // baked into every webhook verify_url) OR the existing `?signalId=<int>`.
    // The signalId path below is byte-for-byte unchanged.
    const hashParam = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';
    if (hashParam) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hashParam)) {
        return res.status(400).json({ error: 'invalid hash (expected 0x + 64 hex chars)' });
      }
      try {
        const s = await getSignalByHash(hashParam);
        if (!s) {
          return res.status(404).json({ error: 'Signal not found', hash: hashParam, hint: 'No trade call matches this hash. Check the value from your webhook payload.' });
        }
        if (!s.signal_hash || !s.merkle_batch_id) {
          return res.json({
            verified: false,
            reason: 'Trade call recorded, awaiting next daily Merkle batch (00:05 UTC)',
            // PUBLIC allow-list only (no Phase-E keys). Calls-not-signals public names + existing render-compat names.
            signal: { id: s.id, coin: s.coin, call: s.signal, direction: s.signal, confidence: s.confidence, timeframe: s.timeframe, exchange: s.exchange, regime: s.regime },
          });
        }
        const proof = typeof s.merkle_proof === 'string' ? JSON.parse(s.merkle_proof) : s.merkle_proof;
        const isValid = verifyProof(s.signal_hash as `0x${string}`, proof, s.merkle_root as `0x${string}`);
        return res.json({
          verified: isValid,
          signal: {
            id: s.id, coin: s.coin, call: s.signal, direction: s.signal, confidence: s.confidence,
            timeframe: s.timeframe, exchange: s.exchange, regime: s.regime,
            price_at_call: s.price_at_signal, price: s.price_at_signal, timestamp: s.created_at, hash: s.signal_hash,
          },
          batch: {
            id: s.merkle_batch_id, root: s.merkle_root, signalCount: s.signal_count,
            txHash: s.tx_hash, blockNumber: s.block_number, publishedAt: s.published_at,
            basescanUrl: `https://basescan.org/tx/${s.tx_hash}`,
          },
          proof,
          contractAddress: MERKLE_CONTRACT_ADDR,
          howToVerify: 'Check the Merkle root on-chain at the contract address on Base. The call hash + proof should reconstruct the published root.',
        });
      } catch {
        return res.status(500).json({ error: 'Verification failed' });
      }
    }

    const signalId = parseInt(req.query.signalId as string);
    if (!signalId || isNaN(signalId)) {
      return res.status(400).json({ error: 'signalId required (integer)' });
    }
    try {
      const s = await getSignalWithBatch(signalId);
      if (!s) return res.status(404).json({ error: 'Signal not found' });

      if (!s.signal_hash || !s.merkle_batch_id) {
        return res.json({
          verified: false,
          reason: 'Signal not yet included in a Merkle batch',
          signal: { id: s.id, coin: s.coin, direction: s.signal, confidence: s.confidence },
        });
      }

      const proof = typeof s.merkle_proof === 'string' ? JSON.parse(s.merkle_proof) : s.merkle_proof;
      const isValid = verifyProof(s.signal_hash as `0x${string}`, proof, s.merkle_root as `0x${string}`);

      res.json({
        verified: isValid,
        signal: {
          id: s.id, coin: s.coin, direction: s.signal, confidence: s.confidence,
          timeframe: s.timeframe, price: s.price_at_signal, timestamp: s.created_at, hash: s.signal_hash,
        },
        batch: {
          id: s.merkle_batch_id, root: s.merkle_root, signalCount: s.signal_count,
          txHash: s.tx_hash, blockNumber: s.block_number, publishedAt: s.published_at,
          basescanUrl: `https://basescan.org/tx/${s.tx_hash}`,
        },
        proof,
        contractAddress: MERKLE_CONTRACT_ADDR,
        howToVerify: 'Check the Merkle root on-chain at the contract address on Base. The signal hash + proof should reconstruct the published root.',
      });
    } catch {
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  app.get('/api/merkle-batches', async (_req, res) => {
    try {
      const batches = await getMerkleBatches();
      res.json({
        batches: batches.map((b: any) => ({
          ...b,
          basescanUrl: `https://basescan.org/tx/${b.tx_hash}`,
        })),
        contractAddress: MERKLE_CONTRACT_ADDR,
        chain: 'Base (8453)',
        // OPS-PUBLIC-API-CONVERT-NUDGE-W1: additive machine-readable conversion
        // CTA (single-derivation from src/lib/public-cta.ts). Existing fields
        // byte-unchanged.
        _algovault: buildPublicCtaBlock(),
      });
    } catch {
      res.status(500).json({ error: 'Failed to load batches' });
    }
  });

  // Verify sample IDs — 5 signals from the latest Merkle batch for the /verify Try-It pills
  let verifySampleCache: { batchId: number | null; data: unknown } = { batchId: -1, data: null };
  app.get('/api/verify-sample-ids', async (_req, res) => {
    try {
      const result = await getSampleSignalsFromLatestBatch(5);
      // Cache by batchId — only recompute when a new batch lands
      if (result.batchId !== verifySampleCache.batchId) {
        verifySampleCache = { batchId: result.batchId, data: result };
      }
      res.json(verifySampleCache.data);
    } catch {
      res.status(500).json({ error: 'Failed to load verify samples' });
    }
  });

  // LANDING-LIVE-CALL-TICKER-W1: public endpoint feeding the live agent-calls
  // ticker on landing/index.html. Returns up to 10 most-recent rows from the
  // signals table, sanitized for public consumption (NO outcome_*, NO Phase E
  // fields, NO tier, NO id, NO merkle_* — see getRecentCallsAsync). 2s
  // server-side memoize keyed by limit; cap=10 enforced via 400 Bad Request.
  // Architect-ratified shape: {slug, exchange, timeframe, call, confidence,
  //                            created_at_iso, seconds_ago}.
  const RECENT_CALLS_TTL_MS = 2_000;
  const recentCallsCache = new Map<number, { value: RecentCall[]; expiresAt: number }>();
  app.get('/api/recent-calls', async (req, res) => {
    const raw = req.query.limit;
    const parsed = raw === undefined ? 1 : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      return res.status(400).json({ error: 'limit must be between 1 and 10' });
    }
    try {
      const now = Date.now();
      const cached = recentCallsCache.get(parsed);
      if (cached && cached.expiresAt > now) {
        return res.json(cached.value);
      }
      const value = await getRecentCallsAsync(parsed);
      recentCallsCache.set(parsed, { value, expiresAt: now + RECENT_CALLS_TTL_MS });
      res.json(value);
    } catch {
      res.status(500).json({ error: 'Failed to fetch recent calls' });
    }
  });

  // ERC-8004-W1 / C3: public read endpoint exposing the AlgoVault ERC-8004
  // agent identity + (deferred) reputation rollup. Path 3 active per Plan-Mode
  // Amendment C: score=null, status='pending', attestation_registry=null
  // (ValidationRegistry not canonically deployed on Base mainnet + Reputation
  // Registry self-feedback rejected — wait for ERC-8004-W2). 5-min cache.
  // Shape locked by audits/api-erc-8004-reputation-shape-snapshot-<date>.json.
  const ERC8004_REPUTATION_CACHE_TTL_MS = 5 * 60 * 1000;
  let erc8004ReputationCacheAt: number | null = null;
  app.get('/api/erc-8004-reputation', async (_req, res) => {
    try {
      const now = Date.now();
      if (!erc8004ReputationCacheAt || now - erc8004ReputationCacheAt > ERC8004_REPUTATION_CACHE_TTL_MS) {
        erc8004ReputationCacheAt = now;
      }
      const freshness = Math.floor((now - erc8004ReputationCacheAt) / 1000);
      res.json(
        buildErc8004ReputationBody({
          pkgVersion: PKG_VERSION,
          agentId: process.env.ERC8004_AGENT_ID || null,
          firstRegisteredAt: process.env.ERC8004_FIRST_REGISTERED_AT || null,
          freshnessSeconds: freshness,
        }),
      );
    } catch {
      res.status(500).json({ error: 'Failed to load erc-8004 reputation' });
    }
  });

  // ── KNOWLEDGE-ARTIFACT-W1 (2026-05-18): public knowledge bundle endpoints ──
  // Cache: bundle files are read once at server boot (knowledge-store lazy
  // load); served with Cache-Control: public, max-age=3600. Container restart
  // is the cache invalidation boundary (every deploy).
  // Drift contract: audits/knowledge-shape-snapshot-2026-05-18.json.
  const KNOWLEDGE_CACHE_HEADER = 'public, max-age=3600';

  app.get('/knowledge/index.json', (_req, res) => {
    const idx = getKnowledgeIndex();
    if (!idx) {
      return res.status(404).json({ error: 'Knowledge index not available' });
    }
    res.setHeader('Cache-Control', KNOWLEDGE_CACHE_HEADER);
    res.json(idx);
  });

  app.get('/knowledge/latest.json', (_req, res) => {
    const bundle = getKnowledgeBundle('latest');
    if (!bundle) {
      return res.status(404).json({ error: 'Latest knowledge bundle not available' });
    }
    res.setHeader('Cache-Control', KNOWLEDGE_CACHE_HEADER);
    res.json(bundle);
  });

  app.get('/knowledge/:slug.json', (req, res) => {
    const slug = req.params.slug;
    // Two acceptable shapes: 'latest' (handled above but defensive) and
    // 'vX.Y.Z' (regex-validated to prevent path traversal / arbitrary file
    // reads). Anything else → 400.
    if (slug !== 'latest' && !VERSION_SLUG_REGEX.test(slug)) {
      return res.status(400).json({ error: 'Invalid version slug; expected v<MAJOR>.<MINOR>.<PATCH>' });
    }
    const bundle = getKnowledgeBundle(slug);
    if (!bundle) {
      return res.status(404).json({ error: `Knowledge bundle not found for ${slug}` });
    }
    res.setHeader('Cache-Control', KNOWLEDGE_CACHE_HEADER);
    res.json(bundle);
  });

  // ── AV-CHAT-MCP-W1 (C3, 2026-05-18): ensure chat_usage_monthly table ──
  // Fire-and-forget DDL at server boot. Idempotent (CREATE TABLE IF NOT EXISTS).
  ensureChatUsageTable();

  // ── CHAT-USAGE-ANALYTICS-W1 (2026-05-18): ensure chat_analytics_events + daily view ──
  // Fire-and-forget DDL: table + 4 indexes + chat_analytics_daily view.
  // Idempotent. Same pattern as ensureChatUsageTable.
  ensureChatAnalyticsSchema();

  // ── GEO-MEASUREMENT-W1 (C1, 2026-05-19): ensure geo_query_runs + geo_mentions
  // + geo_weekly_summary view. Fire-and-forget DDL; idempotent.
  ensureGeoSchema();

  // ── AV-CHAT-MCP-W1 (C2, 2026-05-18): /api/search HTTP endpoint ──
  // BM25 lexical retrieval over the auto-generated KnowledgeBundle. Shape
  // contract: audits/search-knowledge-shape-snapshot-2026-05-18.json (6
  // sections incl. error_contract + drift_check_command). HTTP cache 5min;
  // in-memory result cache 1h via ResultCache primitive.
  app.post('/api/search', express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const body = (req.body ?? {}) as { query?: unknown; limit?: unknown };
      if (typeof body.query !== 'string') {
        return res.status(400).json({ code: 'INVALID_QUERY', message: 'query field is required and must be a string' });
      }
      const query = body.query;
      if (query.length < 3) {
        return res.status(400).json({ code: 'QUERY_TOO_SHORT', message: 'query must be at least 3 characters' });
      }
      if (query.length > 500) {
        return res.status(400).json({ code: 'QUERY_TOO_LONG', message: 'query must be at most 500 characters' });
      }
      let limit = 10;
      if (typeof body.limit === 'number' && Number.isFinite(body.limit)) {
        limit = Math.max(1, Math.min(50, Math.floor(body.limit)));
      }
      const { index, engine } = await getKnowledgeSearch();
      const results = await engine.query(query, limit);
      const bundle = index.getBundle();
      const response = formatSearchKnowledgeResponse(query, results, bundle);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(response);
    } catch (err) {
      console.error(`[/api/search] internal error: ${err instanceof Error ? err.message : err}`);
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'search engine path failed' });
    }
  });

  // ── POWER-USER-OUTREACH-W1-V2 (2026-05-28): /api/signup-email ──
  // Free-tier email opt-in capture from /welcome paywall CTA. Distinct from
  // GET /signup (Stripe Checkout redirect for paid tiers). Insert idempotent
  // via signup_emails.email UNIQUE constraint + processed_signup_email_events
  // claim. Confirmation email fire-and-forget so a Resend outage never 500s
  // the request. Public-shape: see audits/signup-email-shape-snapshot-2026-06-21.json
  // CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): outbound webhook subscription API
  // (POST/GET/DELETE /api/webhooks + POST /api/webhooks/:id/test). Universal
  // access gated only by the monthly call quota; ships dark — the delivery worker
  // only runs when WEBHOOK_DELIVERY_ENABLED=true (registration routes are always
  // mounted so subscribers can pre-register, but nothing is delivered until the
  // flag is on).
  registerWebhookRoutes(app);

  // REFERRAL-LIGHT-W1 (C3): per-IP limiter on the public opt-in (mirrors recoverKeyLimiter).
  const signupEmailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many signup requests. Try again in an hour.',
  });
  app.post('/api/signup-email', signupEmailLimiter, express.json({ limit: '2kb' }), async (req, res) => {
    try {
      const body = (req.body ?? {}) as { email?: unknown; source?: unknown; optin_consent?: unknown; ref?: unknown; ephemeral_key?: unknown };
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const source = typeof body.source === 'string' ? body.source : 'welcome-paywall';
      const optinConsent = body.optin_consent === true;

      // REFERRAL-FREE-KEY-SIGNUP-W1 (D4): syntax + disposable-domain + MX validation
      // (fail-open on transient DNS). Specific reason so the form can message it.
      const v = await validateSignupEmail(email);
      if (!v.ok) {
        return res.status(400).json({ ok: false, error: v.reason });
      }
      // Consent is NO LONGER required (D4): the free account + key email are
      // transactional. The marketing opt-in is recorded separately, ONLY when the
      // box is checked — so signup_emails keeps its consenting-list semantics.
      const allowedSources = new Set(['welcome-paywall', 'outreach-reply', 'manual', 'referral-page', 'join-page']);
      const safeSource = (allowedSources.has(source) ? source : 'welcome-paywall') as 'welcome-paywall' | 'outreach-reply' | 'manual' | 'referral-page' | 'join-page';

      const claim = await tryClaimSignupEmailEvent(email, 'optin');
      const result = optinConsent
        ? await upsertSignupEmail({ email, source: safeSource, optin_consent: true })
        : { inserted: false };
      const optinAt = new Date().toISOString();

      // Referred path UNCHANGED: a valid, non-self ref mints the key + grants the +500
      // referee bonus + attribution. Non-referred → key only, NO bonus (the +500 stays
      // referral-exclusive). Fail-open; never blocks the 200.
      const ref = typeof body.ref === 'string' ? body.ref : undefined;
      let referral: { applied: boolean; freeKey: string | null; bonusCalls: number } = { applied: false, freeKey: null, bonusCalls: 0 };
      if (ref) {
        try {
          const { processFreeReferralSignup } = await import('./lib/referral-accrual.js');
          const r = await processFreeReferralSignup(email, ref);
          referral = { applied: r.applied, freeKey: r.freeKey, bonusCalls: r.bonusCalls };
        } catch (err) {
          console.error(`[/api/signup-email] referral processing failed (fail-open): ${err instanceof Error ? err.message : err}`);
        }
      }

      // REFERRAL-FREE-KEY-SIGNUP-W1: mint an av_free_ key for EVERY signup (idempotent
      // on email), then derive the persisted referral code + share link. The keyless
      // free tier (no key passed) is untouched — this only ADDS the opt-in account.
      const { mintFreeKey, isEphemeralKey } = await import('./lib/free-keys-store.js');
      const { ensureUserCode } = await import('./lib/referral-store.js');
      const { shareLink } = await import('./lib/referral-constants.js');
      const { isNewSignupEnabled } = await import('./lib/auth-providers.js');
      // FUNNEL-FIX-HUMAN-SIGNUP-W1: if this signup CLAIMS a prior ephemeral key (deferred
      // email), MERGE it (email = identity; idempotent; no double key) instead of minting
      // anew — behind NEW_SIGNUP_ENABLED. Legacy path (no ephemeral_key / flag off) unchanged.
      const ephemeralKey = typeof body.ephemeral_key === 'string' ? body.ephemeral_key : null;
      let key: string;
      if (referral.freeKey) {
        key = referral.freeKey;
      } else if (ephemeralKey && isNewSignupEnabled() && (await isEphemeralKey(ephemeralKey))) {
        const { captureEmail } = await import('./lib/deferred-signup.js');
        key = (await captureEmail(ephemeralKey, email, ref ?? null)).key;
      } else {
        key = await mintFreeKey(email);
      }
      const referralCode = await ensureUserCode(key, email);
      const referralLink = shareLink(referralCode);

      // Transactional key email (NOT gated on marketing consent) — referred → bonus
      // variant; non-referred → generic account/link variant (no quota-bump framing).
      // Deduped via the per-second claim. markConfirmationSent only when a marketing
      // row exists (consented). Fire-and-forget; Resend outage logs but never 500s.
      if (claim.claimed) {
        const sendKeyEmail = referral.applied
          ? sendReferredFreeKeyEmail(email, key, ref ?? null)
          : sendFreeKeyEmail(email, key, referralLink);
        sendKeyEmail
          .then(async (sent) => {
            if (sent?.id) {
              if (optinConsent) await markConfirmationSent(email);
              console.log(`[/api/signup-email] key email sent to ${email[0]}***@*** id=${sent.id}`);
            }
          })
          .catch((err: unknown) => {
            console.error(`[/api/signup-email] key email send failed: ${err instanceof Error ? err.message : err}`);
          });
      }

      return res.status(200).json({
        ok: true,
        optin_at: optinAt,
        inserted: result.inserted,
        // REFERRAL-FREE-KEY-SIGNUP-W1: key + referral code/link returned for EVERY signup
        // (over the caller's own request; never logged). referral_applied/bonus_calls
        // ONLY when a ref applied (+500 referral-exclusive).
        key,
        referral_code: referralCode,
        referral_link: referralLink,
        ...(referral.applied ? { referral_applied: true, bonus_calls: referral.bonusCalls } : {}),
      });
    } catch (err) {
      console.error(`[/api/signup-email] internal error: ${err instanceof Error ? err.message : err}`);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // ── FUNNEL-FIX-HUMAN-SIGNUP-W1: value-before-email + one-tap sign-in ──
  // ALL new-signup routes are behind NEW_SIGNUP_ENABLED (default OFF → 404, invisible).
  // The legacy email-first flow above stays intact. MCP/TG surfaces untouched.

  // Value BEFORE email: mint an ephemeral key + return a real signal, no email required.
  app.post('/api/start-free', express.json({ limit: '2kb' }), async (req, res) => {
    const { isNewSignupEnabled } = await import('./lib/auth-providers.js');
    if (!isNewSignupEnabled()) return res.status(404).json({ ok: false, error: 'not_found' });
    try {
      const q = req.query as Record<string, string | undefined>;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 200 ? v : null);
      const { startFree } = await import('./lib/deferred-signup.js');
      const result = await startFree({
        src: str(q.src) ?? str(b.src),
        ref: str(q.ref) ?? str(b.ref),
        utm_source: str(q.utm_source) ?? str(b.utm_source),
        utm_campaign: str(q.utm_campaign) ?? str(b.utm_campaign),
        landing_path: str(q.landing_path),
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error(`[/api/start-free] internal error: ${err instanceof Error ? err.message : err}`);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // One-tap OAuth start: redirect to the IdP (or the Stub loopback) with a CSRF state cookie.
  app.get('/auth/:provider', async (req, res) => {
    const { isNewSignupEnabled, getAuthProvider, generateOAuthState, safeRedirectPath } = await import('./lib/auth-providers.js');
    if (!isNewSignupEnabled()) return res.status(404).send('Not found');
    const id = req.params.provider;
    if (id !== 'google' && id !== 'github') return res.status(404).send('Unknown provider');
    try {
      const provider = getAuthProvider(id);
      const state = generateOAuthState();
      const next = safeRedirectPath(req.query.next);
      const redirectUri = `https://${req.get('host')}/auth/${id}/callback`;
      const secure = req.secure || req.get('x-forwarded-proto') === 'https';
      // Short-lived, HttpOnly CSRF + next cookies (10 min).
      res.setHeader('Set-Cookie', [
        `av_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${secure ? '; Secure' : ''}`,
        `av_oauth_next=${encodeURIComponent(next)}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${secure ? '; Secure' : ''}`,
        ...(typeof req.query.src === 'string' ? [`av_oauth_src=${encodeURIComponent(req.query.src.slice(0, 60))}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${secure ? '; Secure' : ''}`] : []),
      ]);
      return res.redirect(302, provider.authorizeUrl({ state, redirectUri }));
    } catch (err) {
      console.error(`[/auth/${id}] internal error: ${err instanceof Error ? err.message : err}`);
      return res.status(500).send('Sign-in error');
    }
  });

  // OAuth callback: verify state → exchange → issue a free key for the verified email.
  app.get('/auth/:provider/callback', async (req, res) => {
    const { isNewSignupEnabled, getAuthProvider, safeRedirectPath } = await import('./lib/auth-providers.js');
    if (!isNewSignupEnabled()) return res.status(404).send('Not found');
    const id = req.params.provider;
    if (id !== 'google' && id !== 'github') return res.status(404).send('Unknown provider');
    try {
      const cookie = req.headers.cookie ?? '';
      const readCookie = (n: string): string | null => {
        const m = cookie.match(new RegExp(`${n}=([^;]+)`));
        return m ? decodeURIComponent(m[1]) : null;
      };
      const expectState = readCookie('av_oauth_state');
      const gotState = typeof req.query.state === 'string' ? req.query.state : '';
      if (!expectState || !gotState || !safeCompare(expectState, gotState)) {
        return res.status(400).send('Invalid or expired sign-in state. Please try again.');
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) return res.status(400).send('Missing authorization code.');
      const provider = getAuthProvider(id);
      const redirectUri = `https://${req.get('host')}/auth/${id}/callback`;
      const profile = await provider.exchange({ code, redirectUri });

      // Issue (or return the existing) free key for the verified email — email = identity.
      const { mintFreeKey } = await import('./lib/free-keys-store.js');
      const { ensureUserCode } = await import('./lib/referral-store.js');
      const { shareLink } = await import('./lib/referral-constants.js');
      const key = await mintFreeKey(profile.email);
      const referralCode = await ensureUserCode(key, profile.email);
      const referralLink = shareLink(referralCode);
      // Attribution first-touch survives the redirect: stamp ?src (cookie) against the key.
      try {
        const src = readCookie('av_oauth_src');
        const { recordSignupAttribution } = await import('./lib/subscriber-attribution.js');
        recordSignupAttribution({ clientReferenceId: key, utmSource: src, tierRequested: 'free' });
      } catch { /* best-effort */ }
      // Clear the CSRF cookies.
      res.setHeader('Set-Cookie', [
        'av_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0',
        'av_oauth_next=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0',
        'av_oauth_src=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0',
      ]);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const stubNote = provider.live ? '' : ' <em>(stub — set the provider OAuth creds to go live)</em>';
      return res.send(
        `<!doctype html><meta charset="utf-8"><title>You're in — AlgoVault</title>` +
        `<body style="font-family:system-ui;background:#0d1117;color:#c9d1d9;max-width:560px;margin:60px auto;padding:0 20px">` +
        `<h1 style="color:#56d364">You're in via ${id}${stubNote}</h1>` +
        `<p>Your free API key (100 calls/mo, no card):</p>` +
        `<pre style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;user-select:all">${key}</pre>` +
        `<p>Referral link: <a style="color:#58a6ff" href="${referralLink}">${referralLink}</a></p>` +
        `<p style="color:#8b949e;font-size:13px">Use it as <code>Authorization: Bearer &lt;key&gt;</code>. <a style="color:#58a6ff" href="/account">Manage your account →</a></p></body>`,
      );
    } catch (err) {
      console.error(`[/auth/${id}/callback] internal error: ${err instanceof Error ? err.message : err}`);
      return res.status(500).send('Sign-in error. Please try again.');
    }
  });

  // ── AV-CHAT-MCP-W1 (C3, 2026-05-18): /api/chat HTTP endpoint ──
  // LLM-synthesized answer with citations. Quota tracked separately from
  // tool quotas via ChatRateLimit + chat_usage_monthly table. Falls back
  // to [STUB] LLM if ANTHROPIC_API_KEY unset. Shape contract:
  // audits/chat-knowledge-shape-snapshot-2026-05-18.json (6 sections,
  // 6 error codes incl. CHAT_QUOTA_EXHAUSTED + INVALID_MODEL).
  app.post('/api/chat', express.json({ limit: '8kb' }), async (req, res) => {
    const startMs = Date.now();
    // CHAT-USAGE-ANALYTICS-W1: hoist for analytics fallback (validation errors fire before full ctx)
    let _analyticsQuestion = '';
    let _analyticsApiKey: string | null = null;
    let _analyticsTier: ChatTier = 'free';
    // GEO-MEASUREMENT-W2 (C1) enum-widening cascade: LLMProviderName widened
    // with 'perplexity' (architect-ratified). Annotate with the canonical type
    // (not a stale 4-literal) so future engines need zero touch here. Behavior
    // unchanged — type annotation only.
    let _analyticsProvider: LLMProviderName = 'anthropic';
    let _analyticsModel = 'claude-haiku-4-5-20251001';
    try {
      const body = (req.body ?? {}) as { question?: unknown; model?: unknown };
      if (typeof body.question !== 'string') {
        return res.status(400).json({ code: 'INVALID_QUESTION', message: 'question field is required and must be a string' });
      }
      const question = body.question;
      _analyticsQuestion = question;
      if (question.length < 5) {
        return res.status(400).json({ code: 'QUESTION_TOO_SHORT', message: 'question must be at least 5 characters' });
      }
      if (question.length > 500) {
        return res.status(400).json({ code: 'QUESTION_TOO_LONG', message: 'question must be at most 500 characters' });
      }
      let model: string | undefined;
      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || !ALLOWED_CHAT_MODELS.has(body.model)) {
          return res.status(400).json({
            code: 'INVALID_MODEL',
            message: 'model must be one of the allowed values',
            allowed_models: [...ALLOWED_CHAT_MODELS],
          });
        }
        model = body.model;
        _analyticsModel = model;
      }

      const license = getRequestLicense();
      const { index, chatEngine, rateLimit, llm } = await getChatStack();
      _analyticsProvider = llm.name;
      const tier = chatTierFor(license.tier);
      _analyticsApiKey = license.key;
      _analyticsTier = tier;
      const quotaKey = chatQuotaApiKey(license.key, getRequestIpHash() ?? null);
      const check = await rateLimit.check(quotaKey, tier);
      if (!check.allowed) {
        const days = Math.max(1, Math.ceil((check.resetAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
        // CHAT-USAGE-ANALYTICS-W1: quota-exhausted recorded as event
        recordChatEvent({
          apiKeyId: _analyticsApiKey,
          apiKeyTier: tier,
          surface: 'http_endpoint',
          question,
          answer: '',
          citationsCount: 0,
          model: _analyticsModel,
          provider: _analyticsProvider,
          usage: { promptTokens: 0, completionTokens: 0 },
          latencyMs: Date.now() - startMs,
          errorCode: 'CHAT_QUOTA_EXHAUSTED',
        });
        return res.status(429).json({
          code: 'CHAT_QUOTA_EXHAUSTED',
          message: `Monthly chat quota exhausted for tier ${tier} (${check.limit}/mo). Resets in ${days} day(s).`,
          retry_after_days: days,
          limit: check.limit,
          tier,
          upgrade_url: 'https://algovault.com/#pricing',
        });
      }
      const result = await chatEngine.chat(question, model ? { model } : undefined);
      await rateLimit.record(quotaKey, result.usage);
      const bundle = index.getBundle();
      const response = formatChatKnowledgeResponse(result, bundle, Math.max(0, check.remaining - 1));
      res.setHeader('Cache-Control', 'no-store');
      res.json(response);
      // CHAT-USAGE-ANALYTICS-W1: record success AFTER res.json (fire-and-forget)
      recordChatEvent({
        apiKeyId: _analyticsApiKey,
        apiKeyTier: tier,
        surface: 'http_endpoint',
        question,
        answer: result.answer,
        citationsCount: result.citations.length,
        model: result.model,
        provider: _analyticsProvider,
        usage: result.usage,
        latencyMs: Date.now() - startMs,
      });
    } catch (err) {
      console.error(`[/api/chat] internal error: ${err instanceof Error ? err.message : err}`);
      // CHAT-USAGE-ANALYTICS-W1: record internal-error event for observability
      if (_analyticsQuestion) {
        recordChatEvent({
          apiKeyId: _analyticsApiKey,
          apiKeyTier: _analyticsTier,
          surface: 'http_endpoint',
          question: _analyticsQuestion,
          answer: '',
          citationsCount: 0,
          model: _analyticsModel,
          provider: _analyticsProvider,
          usage: { promptTokens: 0, completionTokens: 0 },
          latencyMs: Date.now() - startMs,
          errorCode: 'INTERNAL_ERROR',
        });
      }
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'chat engine path failed' });
    }
  });

  // BOT-W2 / D1-C: bot validates api_keys it receives via /start auth_<key>
  // deep-link from /welcome. Two-flag firewall reuses the W1 internal-bypass
  // env (BOT_INTERNAL_BYPASS_ENABLED + ALGOVAULT_INTERNAL_BYPASS_KEY).
  // NOT exposed via the MCP transport — this is a server-internal HTTP route.
  app.get('/api/bot/validate-key', async (req, res) => {
    const auth = checkBotInternalAuth(req.headers as Record<string, string | undefined>);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }
    const apiKey = ((req.query.api_key as string | undefined) || '').trim();
    if (!apiKey) {
      return res.status(400).json({ error: 'api_key_required' });
    }
    const result = await validateApiKey(apiKey);
    if (!result.valid || !result.tier) {
      return res.status(404).json({ valid: false });
    }
    return res.json({
      valid: true,
      customer_id: result.customerId || null,
      tier: result.tier,
    });
  });

  // MCP endpoint
  app.all('/mcp', express.json(), async (req, res) => {
    // OPS-X402-MCP-PRICE-BINDING-W1: for a priced `tools/call` POST, bind the x402
    // grant/settle to the CALLED tool's effective price. Parse the tool name (+ its
    // timeframe arg) so `resolveLicense` matches the proof against ONLY this tool's
    // requirement, enforces the per-tool floor, and claims the nonce BEFORE settle.
    // A cross-tool / underpaid / replayed proof → no x402 grant, no settle, and an
    // `x402Downgrade.reason` we use below. Non-priced or non-tools/call requests pass
    // no tool → the prior flattened behavior is unchanged.
    const mcpBody = (req.method === 'POST' && req.body && typeof req.body === 'object')
      ? (req.body as { method?: string; params?: { name?: string; arguments?: { timeframe?: unknown } } })
      : undefined;
    const callTool = (mcpBody?.method === 'tools/call' && typeof mcpBody.params?.name === 'string')
      ? mcpBody.params.name
      : undefined;
    const isPricedTool = !!callTool && (HTTP_TOOLS as readonly string[]).includes(callTool);
    const callTimeframe = typeof mcpBody?.params?.arguments?.timeframe === 'string'
      ? (mcpBody.params.arguments.timeframe as string)
      : undefined;

    // Resolve license per-request using 3-tier gate: x402 → API key → free
    // Async because x402 verification hits the Facilitator
    const { license, pendingSettlement, x402Downgrade } = isPricedTool
      ? await resolveLicense(
          req.headers as Record<string, string | undefined>,
          { tool: callTool, timeframe: callTimeframe },
        )
      : await resolveLicense(
          req.headers as Record<string, string | undefined>,
        );

    // Hash client IP for privacy-safe analytics + the free-tier quota key.
    // OPS-MCP-DEFENSE-IN-DEPTH-W1 R2: req.ip (trust proxy=1) via the shared clientIp
    // helper — the raw leftmost-XFF parse was spoofable the moment a proxy hop
    // APPENDS instead of replacing; req.ip resolves the nearest-trusted-hop value
    // (byte-identical under the deployed Caddy replace-mode topology).
    const ipHash = hashIp(clientIp(req) || 'unknown');
    // OPS-MCP-SESSION-RESILIENCE-W1: single-derivation correlation id. Stateless issues no
    // Mcp-Session-Id, so resolve ONE id (track-token ?? ipHash ?? uuid) used for the funnel +
    // skill-attribution emit AND the requestContext ALS store (read by getRequestSessionId()
    // at the per-tool cohort sites). Stateful (=0) preserves the prior header-based value.
    // OPS-ACTIVATION-LEAK-FIX-W1 CH2: resolve the shared identity ONCE (id + tier)
    // so the mcp_connect + mcp_tools_list emits below stamp the SAME tier the
    // correlation id was derived from (single-derivation). `sessionId` is the
    // byte-identical `.id`, so every downstream consumer is unaffected.
    const sessionIdentity = MCP_STATELESS
      ? resolveSessionIdentity(req.headers as Record<string, unknown>, ipHash)
      : null;
    const sessionId = MCP_STATELESS
      ? sessionIdentity!.id
      : (req.headers['mcp-session-id'] as string | undefined);
    // Identity tier for funnel coverage. Under the deprecated stateful path
    // (MCP_STATELESS=0) the POST-layer funnel emits don't meaningfully join, so a
    // default 'anon' label is harmless (only read when sessionId is set + stateless).
    const identityTier: IdentityTier = sessionIdentity?.tier ?? 'anon';

    // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: classify THIS request ONCE
    // (single-derivation — the ONE authoritative automated-vs-human verdict). Pure fn
    // of (UA, IP, tier, is-this-a-real-call). Stored in the requestContext ALS below so
    // `logRequest()` stamps `request_log.is_automated` per call, and REUSED by the
    // once-per-session `mcp_connect` emit — byte-identical for tier!=='internal', so
    // `funnel_events.meta_json.is_automated` / `by_authenticity` do NOT drift. Computed
    // for every request; only consumed on POST tool-calls (harmless on GET/handshake).
    const requestAuthenticity = classifyTraffic({
      ua: req.headers['user-agent'] as string | undefined,
      ip: clientIp(req),
      hadRealToolCall: (req.body as { method?: string } | undefined)?.method === 'tools/call',
      isInternalTier: license.tier === 'internal',
    });

    // C6 (algovault-skills SKILLS-W1): per-Skill attribution.
    // If the request carries X-AlgoVault-Skill-Slug AND is a tools/call,
    // log the invocation fire-and-forget BEFORE dispatching to the transport.
    // Slug values are public (Skill names are open-source); user_agent is
    // truncated to 200 chars in logSkillInvocation.
    //
    // DASH-EXTERNAL-ONLY-W1-PATCH-A (2026-05-24): write-side gate — skip the
    // entire attribution write when license.tier === 'internal' (algovault-bot
    // loopback or any future internal consumer carrying the bypass header).
    // Internal traffic should never count toward public Skills analytics. Pair
    // with the read-side filter on getSkillInvocationStats() + the
    // is_bot_internal column on skill_invocations (belt + suspenders defense).
    const skillSlugHeader = (req.headers['x-algovault-skill-slug'] as string | undefined)?.trim();
    if (skillSlugHeader && req.method === 'POST' && req.body && typeof req.body === 'object' && license.tier !== 'internal') {
      const body = req.body as { method?: string; params?: { name?: string } };
      if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
        // Fire-and-forget; never blocks the request.
        try {
          logSkillInvocation(skillSlugHeader, body.params.name, sessionId, req.headers['user-agent'] as string | undefined, false);
        } catch { /* best-effort */ }
      }
    }

    // TG-BROADCAST-STACK-W1 CH6 (2026-05-28): track-token capture for the
    // /unlock_premium_alerts npm-install verification path β. Header
    // `X-AlgoVault-Track-Token` (set by stdio-client wrapper) takes
    // precedence over `--track-token=` argv (process-wide fallback).
    // Idempotent per (session_id, token); first tools/call emits one
    // funnel_events row, subsequent calls suppressed. The bot's */10 cron
    // polls funnel_events for matching tokens. Fire-and-forget; non-blocking.
    if (req.method === 'POST' && req.body && typeof req.body === 'object' && license.tier !== 'internal') {
      const body = req.body as { method?: string; params?: { name?: string } };
      if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
        const trackToken = resolveTrackTokenForRequest(req.headers as Record<string, unknown>);
        if (trackToken && shouldEmitForRequest(sessionId ?? null, trackToken)) {
          try {
            recordFunnelEvent({
              eventType: 'first_tool_call_with_track_token',
              sessionId: sessionId ?? null,
              licenseTier: license.tier,
              meta: {
                track_token: trackToken,
                tool_name: body.params.name,
                source: (req.headers['x-algovault-track-token'] ? 'header' : 'argv'),
              },
            });
          } catch { /* best-effort; never blocks request */ }
        }
      }
    }

    // ATTRIBUTION-CONNECTION-SRC-W1: cache-safe per-channel source capture at the
    // CONNECTION layer — NEVER the tools-list (that is the whole point: `?src=` is
    // set once per listing + version-invariant, so attribution never forces the
    // cached-tools/list refresh). Read the deterministic `?src=` query with a UA
    // heuristic fallback; resolve {source, source_confidence}; emit ONE deduped
    // `mcp_connect` funnel_event per session (the SHARED resolveSessionCorrelationId
    // id — same as the funnel / skill / track-token emits; do not invent a key).
    // Fire-and-forget; never blocks, never touches the JSON-RPC envelope or tool
    // registration. Internal-tier (bot loopback) excluded — mirrors the skill /
    // track-token write-side gate. NOTE: local-stdio (`npx`) makes no call here, so
    // the `npm` channel is intentionally connect-uncapturable (see attribution-sources.ts).
    if (req.method === 'POST' && sessionId && license.tier !== 'internal' && shouldEmitConnect(sessionId)) {
      try {
        const { source, source_confidence } = resolveSource({
          srcParam: req.query?.src,
          userAgent: req.headers['user-agent'],
          origin: req.headers['origin'],
          referer: req.headers['referer'],
        });
        // OPS-ACTIVATION-LEAK-FIX-W1 CH3: tag automated vs human via the ONE canonical
        // classifier (single-derivation). Tags additively into meta_json — the row is
        // NEVER dropped (Data Integrity). OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1:
        // REUSES the per-request `requestAuthenticity` computed once above (the SAME
        // verdict that stamps request_log.is_automated) instead of re-calling — this
        // block only runs when tier!=='internal', for which the hoisted call's
        // isInternalTier is false, so the emitted value is byte-identical (no drift).
        const authenticity = requestAuthenticity;
        recordFunnelEvent({
          eventType: 'mcp_connect',
          sessionId,
          licenseTier: license.tier,
          // identity_tier (CH2): projected from the SHARED resolveSessionIdentity tier so
          // identity_coverage reads per-session stitchability off the once-per-session
          // connect event. is_automated/reason (CH3): the canonical classifyTraffic verdict
          // for by_authenticity. All additive to the existing {source, source_confidence}.
          meta: {
            source,
            source_confidence,
            identity_tier: identityTier,
            is_automated: authenticity.is_automated,
            automated_reason: authenticity.reason,
          },
        });
      } catch { /* best-effort; never blocks request */ }
    }

    // OPS-ACTIVATION-LEAK-FIX-W1 CH2 (Q1-A): capture `mcp_tools_list` (funnel stage 2)
    // at the POST layer by peeking the already-parsed JSON-RPC envelope BEFORE the SDK
    // consumes it. The high-level McpServer answers `tools/list` internally → it never
    // reaches a per-tool handler → never `logRequest`'d → request_log has 0 'tools/list'
    // rows all-time (the source of the 0.000% artifact). Emit here via the SHARED
    // resolveSessionIdentity id + bounded-LRU per-session dedup; the snapshot now reads
    // this from funnel_events (request_log kept as a 0-fallback). Fire-and-forget,
    // fail-open; internal-tier excluded; the tools/list RESPONSE is byte-identical
    // (side-effect emit only — nothing here touches `res` or the envelope).
    if (
      req.method === 'POST' &&
      sessionId &&
      license.tier !== 'internal' &&
      req.body &&
      typeof req.body === 'object' &&
      (req.body as { method?: string }).method === 'tools/list'
    ) {
      recordMcpToolsListEvent({ sessionId, licenseTier: license.tier, identityTier });
    }

    // FUNNEL-FIX-ATTRIBUTION-W1: resolve the classified acquisition source ONCE here (request
    // headers in scope) and thread it via the ALS to the agent_sessions first-touch stamp.
    // Additive — resolveSessionIdentity + the stateless resolver are untouched.
    const attributionSource = classifySource({
      srcParam: req.query?.src,
      utmSource: req.query?.utm_source, // OPS-UTM-SHORTEN-W1: legacy backward-compat fallback (behind ?src)
      userAgent: req.headers['user-agent'],
      origin: req.headers['origin'],
      referer: req.headers['referer'],
    }).source;

    // Run the entire request handling inside AsyncLocalStorage context
    // so tool handlers read the correct per-request license
    await requestContext.run({ license, sessionId, ipHash, isAutomated: requestAuthenticity.is_automated, source: attributionSource }, async () => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        // OPS-X402-MCP-PRICE-BINDING-W1: an x402 proof was presented for a priced
        // tool but was NOT honored (cross-tool / underpaid / replayed) → the license
        // was downgraded to free/API-key with `pendingSettlement` cleared (no settle).
        // Peek quota (read-only; inside ALS so the free-tier key uses the real ipHash;
        // the quota_hit_block funnel event it fires on a free-block is CORRECT here and
        // won't double-fire because we short-circuit before tool dispatch). If quota is
        // EXHAUSTED, return a precise `X402_PAYMENT_REQUIRED` JSON-RPC tool-result-error
        // built from the CALLED tool's payment requirements + the downgrade reason —
        // instead of the generic quota error. If quota REMAINS, fall through and serve
        // the call within the free/non-x402 quota (identical to a no-proof call).
        if (x402Downgrade && callTool) {
          const q = checkQuota(license);
          if (!q.allowed) {
            // Exhausted free quota + an unhonored proof → precise X402_PAYMENT_REQUIRED
            // (built from the CALLED tool's requirements), as a short-circuit (do NOT
            // dispatch to the transport). Shared builder so the envelope shape stays
            // identical to what the test asserts (no drift).
            res.json(buildX402PaymentRequiredResult(callTool, x402Downgrade.reason, (req.body as { id?: unknown })?.id));
            return;
          }
          // Quota remains → serve free below (no x402 grant, no settle). Optional
          // companion note: skipped — injecting `_algovault.x402_note` into the SDK's
          // tool result would require intercepting the transport's serialized output
          // (the result object is built inside the per-tool handler, downstream of this
          // short-circuit), which is awkward + risks corrupting the JSON-RPC envelope.
          // The downgrade is already observable via logs/analytics; left as a no-op.
        }

        // OPS-MCP-SESSION-RESILIENCE-W1: default stateless transport — fresh server +
        // transport per request (no session issued/validated → nothing to orphan on a
        // deploy / idle-reap / restart / replica). GET/DELETE → 405. The legacy stateful
        // path is preserved behind MCP_STATELESS=0 as the instant-rollback lever.
        if (MCP_STATELESS) {
          await handleMcpStateless(req, res, createServer);
        } else {
          const transports = statefulTransports!;
          const sessionLastActivity = statefulLastActivity!;

          if (req.method === 'GET') {
            if (sessionId && transports.has(sessionId)) {
              sessionLastActivity.set(sessionId, Date.now());
              const transport = transports.get(sessionId)!;
              await transport.handleRequest(req, res, req.body);
            } else {
              res.status(400).json({ error: 'No active session. Send a POST first.' });
            }
            return;
          }

          if (req.method === 'DELETE') {
            if (sessionId && transports.has(sessionId)) {
              const transport = transports.get(sessionId)!;
              await transport.handleRequest(req, res, req.body);
              transports.delete(sessionId);
              sessionLastActivity.delete(sessionId);
            } else {
              res.status(404).json({ error: 'Session not found' });
            }
            return;
          }

          // POST — main request path
          if (sessionId && transports.has(sessionId)) {
            sessionLastActivity.set(sessionId, Date.now());
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res, req.body);
          } else {
            // New session
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (sid) => {
                transports.set(sid, transport);
                sessionLastActivity.set(sid, Date.now());
              },
            });

            transport.onclose = () => {
              const sid = (transport as unknown as { sessionId?: string }).sessionId;
              if (sid) {
                transports.delete(sid);
                sessionLastActivity.delete(sid);
              }
            };

            const server = createServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
          }
        }
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }

      // Fire-and-forget: settle x402 payment after response is sent
      // Free HOLDs: skip settlement when get_trade_signal returned HOLD
      if (pendingSettlement && getRequestVerdict() !== 'HOLD') {
        settleX402Async(pendingSettlement);
      }
    });
  });

  // X402-BAZAAR-HTTP-REDECLARE-W1: mount the HTTP x402 resource routes (the CDP Bazaar
  // discovery surface) — ONLY when X402_FACILITATOR=cdp AND BAZAAR_DISCOVERABLE=true.
  // Defaults (legacy/false) → nothing mounted → /x402/* returns 404 (byte-identical prod).
  const x402HttpRoutes = mountX402HttpRoutes(app);
  if (x402HttpRoutes.length > 0) {
    console.log(`x402 HTTP resource routes mounted (CDP Bazaar discovery): ${x402HttpRoutes.join(', ')}`);
  }

  // OKX-AI-FIRST-MOVER-W1: mount the okx.ai A2MCP X-Layer (eip155:196 / USDT0) settlement
  // routes — ONLY when OKX_AI_ENABLED=true. Default (unset) → nothing mounted → /a2mcp/* 404
  // → byte-identical prod. Stub-first: enabled-but-unprovisioned → [STUB] routes. Additive to
  // the Base/USDC x402 rail above (that rail is untouched).
  const okxA2mcpRoutes = await mountOkxA2mcpRoutes(app);
  if (okxA2mcpRoutes.length > 0) {
    console.log(`okx.ai A2MCP routes mounted (X Layer / USDT0): ${okxA2mcpRoutes.join(', ')}`);
  }

  // P1-ACP-SELLER-SEED: start the Virtuals ACP seller worker — ONLY when ACP_ENABLED=true.
  // Default (unset) → selectAcp returns 'off' → the worker never starts → prod byte-identical.
  // Fire-and-forget: the worker runs a long-lived SSE agent (like the bot channel, NOT a request
  // path), so it must not block the HTTP server boot; it is boot-safe internally (a live-connect
  // failure leaves ACP dark, never crash-loops). Stub-first: enabled-but-unprovisioned → [STUB] seller.
  void startAcpSellerWorker()
    .then((r) => {
      if (r.started) console.log(`Virtuals ACP seller worker started (mode=${r.mode})`);
    })
    .catch((e) => console.error('[ACP] worker bootstrap error (ACP stays dark):', e instanceof Error ? e.message : e));

  const httpServer = app.listen(port, () => {
    console.log(`crypto-quant-signal-mcp running on http://0.0.0.0:${port}/mcp`);
    console.log(`Health check: http://0.0.0.0:${port}/health`);
    // Warm tier caches in background (xyz symbols, OI rankings, liquid memes)
    warmTierCaches().catch(() => {});

    // ACTIVATION-NUDGE-W1: start the track-record warmer (the live PFE-WR + call
    // count source for the soft/aha/limit nudge copy). Started here so it only
    // runs in the long-lived server process — never in a test or short-lived
    // cron that merely imports the nudge builders.
    startTrackRecordWarmer();

    // P0 VERDICT-WITH-RECEIPTS-W1: start the in-process receipt track-record warmer
    // (live PFE-WR + evaluated-count + window behind the per-call `_receipts` proof
    // line). Sourced from the in-process performance stats (NOT an HTTP self-call);
    // long-lived process only, mirroring the nudge warmer above.
    startReceiptTrackRecordWarmer();

    // Auto-backfill: evaluate pending signals every 5 minutes
    console.log('[backfill] Auto-backfill enabled: every 5 minutes');
    // OPS-HL-RATELIMITER-W2: the in-server backfill is bulk → run in `batch`
    // weight class so its HL candle fetches wait behind the shared weight budget
    // and yield the interactive reserve to live MCP tool callers.
    setTimeout(() => runAsBatch(() => runBackfill(), 'backfill').catch(() => {}), 10_000); // first run after 10s
    setInterval(() => runAsBatch(() => runBackfill(), 'backfill').catch(() => {}), 300_000); // then every 5 min

    // CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): outbound webhook delivery worker.
    // Ships DARK — only starts when WEBHOOK_DELIVERY_ENABLED=true. Flag-off = zero
    // new behavior (worker never starts; the post-insert detection hook in
    // recordSignal is also flag-gated). Registration routes stay mounted either
    // way so subscribers can pre-register. Mirrors the backfill setInterval above.
    if (process.env.WEBHOOK_DELIVERY_ENABLED === 'true') {
      console.log('[webhook-delivery] WEBHOOK_DELIVERY_ENABLED=true — starting outbound delivery worker');
      startDeliveryWorker();
      // FEATURE-PARITY-CHANNELS-W1 CH2: the scheduled scan-digest producer rides the
      // same flag — it enqueues scan_digest deliveries that the worker above drains.
      startScanDigestScheduler();
    }

    // LATENCY-W1 C3: background grid warmer.
    //   Pre-empts the 60s GRID_TTL_MS so user-facing get_trade_signal calls
    //   ALWAYS hit warm cache (cuts p95 from ~27s → <2s; cache-miss tail
    //   eliminated entirely). With C2's parallel refresh @ concurrency 6,
    //   each refresh costs ~1-2s wall-time and ~12 HL roundtrips. At 50s
    //   cadence: 12 req / 50 s = 0.24 req/s avg (<0.5% of HL's 50 req/s
    //   budget). RAM impact: bounded by cachedSnapshot (24 cells × ~200B)
    //   ≈ 5KB. Skipped during tests so unit suites don't burn upstream.
    if (process.env.NODE_ENV !== 'test') {
      console.log('[grid-warmer] Background grid pre-warm enabled: 50s interval');
      // Initial warmup ~5s after boot (lets DB init + first-request warmup finish)
      setTimeout(() => {
        refreshGridIfStale().catch((err) =>
          console.debug('[grid-warmer] initial refresh failed:', err instanceof Error ? err.message : err)
        );
      }, 5_000);
      // Periodic refresh — pre-empts the 60s TTL with 10s safety margin
      setInterval(() => {
        refreshGridIfStale().catch((err) =>
          console.debug('[grid-warmer] periodic refresh failed:', err instanceof Error ? err.message : err)
        );
      }, 50_000);
    }
  });

  const shutdown = () => {
    console.log('Shutting down...');
    if (sessionCleanupInterval) clearInterval(sessionCleanupInterval);
    if (adminCleanupInterval) clearInterval(adminCleanupInterval);
    stopScanDigestScheduler();
    if (statefulTransports) {
      for (const transport of statefulTransports.values()) {
        transport.close?.();
      }
      statefulTransports.clear();
    }
    statefulLastActivity?.clear();
    closeDb();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Dashboard HTML ──

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlgoVault Analytics</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; }
  .card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: 700; color: #58a6ff; }
  .card .value.green { color: #3fb950; }
  .card .value.purple { color: #bc8cff; }
  .card .value.orange { color: #d29922; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 16px; color: #8b949e; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 12px; overflow: hidden; border: 1px solid #30363d; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  td { font-size: 14px; }
  .bar { height: 8px; background: #58a6ff; border-radius: 4px; min-width: 4px; }
  .refresh { color: #8b949e; font-size: 12px; margin-top: 16px; }
  #loading { color: #8b949e; font-size: 16px; padding: 40px; text-align: center; }
  .logo { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 28px; }
  .logo span { font-size: 28px; }
</style>
</head>
<body>
<div class="logo"><span>&#x1f4ca;</span><div><h1>AlgoVault Analytics</h1><div class="subtitle">crypto-quant-signal-mcp &middot; external calls only</div></div></div>
<div id="loading">Loading analytics...</div>
<div id="content" style="display:none">
  <div class="grid">
    <div class="card"><div class="label">Total Calls (All Time)</div><div class="value" id="total-all"></div><div style="color:#6e7681;font-size:11px;margin-top:8px">Excludes internal loopback (e.g. algovault-bot)</div></div>
    <div class="card"><div class="label">Last 24 Hours</div><div class="value green" id="total-24h"></div></div>
    <div class="card"><div class="label">Last 7 Days</div><div class="value purple" id="total-7d"></div></div>
    <div class="card"><div class="label">Unique Sessions (All Time)</div><div class="value" id="sessions-all"></div></div>
    <div class="card"><div class="label">Unique Sessions (24h)</div><div class="value orange" id="sessions-24h"></div></div>
  </div>
  <div class="grid">
    <div class="section"><h2>Calls by Tool</h2><table><thead><tr><th>Tool</th><th>Calls</th><th></th></tr></thead><tbody id="by-tool"></tbody></table></div>
    <div class="section"><h2>Calls by Tier</h2><table><thead><tr><th>Tier</th><th>Calls</th><th></th></tr></thead><tbody id="by-tier"></tbody></table></div>
  </div>
  <div class="grid">
    <div class="section"><h2>Top Assets</h2><table><thead><tr><th>Asset</th><th>Calls</th><th></th></tr></thead><tbody id="top-assets"></tbody></table></div>
    <div class="section">
      <h2>Response Time (last 7d) &middot; <span style="color:#6e7681;font-size:11px;text-transform:none;letter-spacing:0">p50 = typical · p95 = slow tail · n = sample count</span></h2>
      <table>
        <thead><tr><th>Tool</th><th style="text-align:right">n</th><th style="text-align:right">p50 ms</th><th style="text-align:right">p95 ms</th><th style="text-align:right">min</th><th style="text-align:right">max</th></tr></thead>
        <tbody id="latency-rows"></tbody>
      </table>
    </div>
  </div>
  <div class="section">
    <h2>Skills Analytics (algovault-skills plugin) &middot; <span id="skills-summary" style="color:#8b949e;font-size:12px;text-transform:none;letter-spacing:0">loading...</span></h2>
    <table>
      <thead><tr><th>Slug</th><th style="text-align:right">24h</th><th style="text-align:right">7d</th><th style="text-align:right">All-time</th><th>Last invoked</th></tr></thead>
      <tbody id="skills-rows"></tbody>
    </table>
  </div>
  <div class="refresh">Auto-refreshes every 30s &middot; <span id="updated"></span></div>
</div>
<script>
function renderRows(id, obj, max) {
  const el = document.getElementById(id);
  const entries = Object.entries(obj);
  if (!entries.length) { el.innerHTML = '<tr><td colspan="3" style="color:#8b949e">No data yet</td></tr>'; return; }
  const m = max || Math.max(...entries.map(e => Number(e[1])));
  el.innerHTML = entries.map(([k, v]) =>
    '<tr><td>' + k + '</td><td>' + v + '</td><td style="width:50%"><div class="bar" style="width:' + Math.round(Number(v)/m*100) + '%"></div></td></tr>'
  ).join('');
}
function renderAssets(data) {
  const el = document.getElementById('top-assets');
  if (!data.length) { el.innerHTML = '<tr><td colspan="3" style="color:#8b949e">No data yet</td></tr>'; return; }
  const max = data[0]?.calls || 1;
  el.innerHTML = data.map(d =>
    '<tr><td>' + d.asset + '</td><td>' + d.calls + '</td><td style="width:50%"><div class="bar" style="width:' + Math.round(d.calls/max*100) + '%"></div></td></tr>'
  ).join('');
}
// Canonical 20 Skill slugs — table renders all 20 even with zero invocations.
// Kept in sync with skills/manifest.json in github.com/AlgoVaultLabs/algovault-skills.
const SKILL_SLUGS = ['quick-btc-check','portfolio-scanner','regime-aware-trading','funding-arb-monitor','full-3-tool-pipeline','multi-timeframe-confirmation','tradfi-rotation','risk-gated-entry','funding-sentiment-dashboard','contrarian-meme-scanner','divergence-detector','hourly-digest-bot','hedging-advisor','volatility-breakout-watch','cross-asset-correlation','funding-cash-and-carry','weekend-vs-weekday-patterns','agent-portfolio-rebalance','smart-dca-bot','multi-agent-war-room'];
// Canonical license tiers — Calls by Tier table renders all 5 even at zero
// count, so operators can monitor enterprise + x402 traffic the moment it
// starts (instead of "tier just appeared today" silent change). Order is
// price-asc with x402 last (pay-per-call sits outside the subscription ladder).
// Kept in sync with LicenseTier enum in src/types.ts.
const LICENSE_TIERS = ['free','starter','pro','enterprise','x402'];
function escSlug(s) { return String(s).replace(/[<>&]/g,''); }
function fmtTs(s) {
  if (!s) return '<span style="color:#6e7681">never</span>';
  const t = new Date(s);
  return isNaN(t.getTime()) ? s : t.toISOString().slice(0,16).replace('T',' ') + 'Z';
}
async function loadSkills() {
  try {
    const r = await fetch('/dashboard/api/skills-analytics', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const bySlug = new Map((d.perSlug || []).map(x => [x.slug, x]));
    const rows = SKILL_SLUGS.map(slug => {
      const x = bySlug.get(slug) || { calls_24h:0, calls_7d:0, calls_all_time:0, last_seen:null };
      return '<tr>'
        + '<td><a style="color:#58a6ff;text-decoration:none" href="https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/'+escSlug(slug)+'/SKILL.md"><code>'+escSlug(slug)+'</code></a></td>'
        + '<td style="text-align:right;color:#3fb950;font-variant-numeric:tabular-nums">'+x.calls_24h+'</td>'
        + '<td style="text-align:right;color:#bc8cff;font-variant-numeric:tabular-nums">'+x.calls_7d+'</td>'
        + '<td style="text-align:right;color:#58a6ff;font-variant-numeric:tabular-nums">'+x.calls_all_time+'</td>'
        + '<td style="color:#8b949e">'+fmtTs(x.last_seen)+'</td>'
        + '</tr>';
    }).join('');
    document.getElementById('skills-rows').innerHTML = rows;
    document.getElementById('skills-summary').textContent =
      d.totalInvocations + ' total invocations across ' + d.totalSlugs + '/20 active slugs';
  } catch (e) {
    document.getElementById('skills-rows').innerHTML =
      '<tr><td colspan="5" style="color:#f85149">Failed to load skills analytics: ' + e.message + '</td></tr>';
  }
}
async function load() {
  try {
    const r = await fetch('/analytics', { credentials: 'same-origin' });
    const d = await r.json();
    document.getElementById('total-all').textContent = d.totalCalls.allTime;
    document.getElementById('total-24h').textContent = d.totalCalls.last24h;
    document.getElementById('total-7d').textContent = d.totalCalls.last7d;
    document.getElementById('sessions-all').textContent = d.uniqueSessions.allTime;
    document.getElementById('sessions-24h').textContent = d.uniqueSessions.last24h;
    renderRows('by-tool', d.byTool);
    // Pre-fill all 5 canonical license tiers (zero-fill missing) so empty
    // buckets like enterprise + x402 always show as "0" rows. Mirrors the
    // SKILL_SLUGS pattern at line ~1066: explicit canonical-list expansion
    // beats "render whatever the API returns" for monitoring surfaces.
    const tierFilled = Object.fromEntries(LICENSE_TIERS.map(t => [t, (d.byTier && d.byTier[t]) || 0]));
    renderRows('by-tier', tierFilled);
    renderAssets(d.topAssets);
    // C1 (LATENCY-W1): truthful per-tool latency table — n / p50 / p95 / min / max.
    // Replaces the misleading single-number avg (a bimodal distribution averaged 7.8s
    // even though typical p50 was ~1s). Sorted by p95 ascending so tail outliers float to bottom.
    const latencyEl = document.getElementById('latency-rows');
    const stats = Array.isArray(d.toolStats) ? d.toolStats : [];
    if (!stats.length) {
      latencyEl.innerHTML = '<tr><td colspan="6" style="color:#8b949e">No data yet</td></tr>';
    } else {
      latencyEl.innerHTML = stats.map(function (s) {
        var dim = s.insufficient_data ? ' style="color:#6e7681"' : '';
        var p50 = s.insufficient_data ? '<span style="color:#6e7681">— <small>(n&lt;5)</small></span>' : (s.p50_ms + 'ms');
        var p95 = s.insufficient_data ? '<span style="color:#6e7681">—</span>' : (s.p95_ms + 'ms');
        var minMs = s.min_ms == null ? '—' : (s.min_ms + 'ms');
        var maxMs = s.max_ms == null ? '—' : (s.max_ms + 'ms');
        return '<tr' + dim + '><td>' + s.tool_name + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + s.n + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#3fb950">' + p50 + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#facc15">' + p95 + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#8b949e">' + minMs + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#8b949e">' + maxMs + '</td>'
             + '</tr>';
      }).join('');
    }
    document.getElementById('updated').textContent = 'Updated: ' + new Date(d.generatedAt).toLocaleString();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
    // Kick off skills section load in parallel — independent endpoint, won't
    // block the main render even on slow DB query.
    loadSkills();
  } catch(e) { document.getElementById('loading').textContent = 'Failed to load: ' + e.message; }
}
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

function getPerformanceDashboardHtml(opts?: { isPublic?: boolean }): string {
  const isPublic = opts?.isPublic ?? false;
  const perfEndpoint = isPublic ? '/api/performance-public' : '/performance';
  const cbEndpoint = isPublic ? '/api/confidence-bands-public' : '/api/confidence-bands';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Track Record — AlgoVault Labs</title>
<meta name="description" content="AlgoVault's live trade-call track record. Every signal is Merkle-anchored on Base L2 for independent on-chain verification. Don't trust; verify.">
<link rel="canonical" href="https://algovault.com/track-record">
<!-- BEGIN: AlgoVault canonical design loader (DESIGN-W3 / C4, cross-origin) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://algovault.com/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
<link rel="icon" type="image/png" href="/logo.png">
<!-- DESIGN-W11 / C2 / R-2 inline-fix: Tailwind CDN for canonical Nav utility classes (hidden sm:flex, text-gray-400, hover:text-white, text-mint-400, bg-mint-500/15) -->
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        navy: { 900: '#060a14', 800: '#0a0e1a', 700: '#0f1526', 600: '#161d30' },
        mint: { 50: 'oklch(0.97 0.03 165)', 100: 'oklch(0.94 0.06 165)', 200: 'oklch(0.91 0.09 165)', 300: 'oklch(0.89 0.13 165)', 400: 'oklch(0.86 0.16 165)', 500: 'oklch(0.78 0.18 165)', 600: 'oklch(0.66 0.18 165)', 700: 'oklch(0.54 0.16 165)', 800: 'oklch(0.42 0.12 165)', 900: 'oklch(0.32 0.08 165)' },
        steel: { 400: '#8b9bb5', 500: '#7b8ca0', 600: '#5e6d82' }
      }
    }
  }
}
</script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* DESIGN-W11 / C2 / Q-W11-2: REPLACED body styles per architect ratification. background/color/font-family use canonical CSS vars; padding+max-width move to artboard wrapper. Pre-W11: body { padding:24px; max-width:1400px; margin:0 auto; background:#0f1117; color:#e1e4e8 } */
  body { font-family: var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); background: var(--bg); color: var(--fg); margin: 0; padding: 0; }
  h1 { font-size: 24px; font-weight: 700; }
  .subtitle { color: #6e7681; font-size: 12px; margin-top: 6px; letter-spacing: 0.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
  .call-type-verification-row { display: flex; gap: 1.5rem; align-items: flex-start; }
  .call-type-verification-row .call-type-section { flex: 1; min-width: 0; }
  .call-type-verification-row .tamper-proof-card { flex: 0 0 340px; }
  @media (max-width: 768px) { .call-type-verification-row { flex-direction: column; } .call-type-verification-row .call-type-section, .call-type-verification-row .tamper-proof-card { width: 100%; flex: none; } }
  /* DESIGN-W11-FF-CARD-BG (2026-05-15): bg + border unified to canonical
     tier-stat-card / exchange-stat-card reference per Mr.1 directive. Was:
     background:#161b22; border:1px solid #30363d. Now: canonical oklch +
     var(--line). padding:18px kept (within ±4px of tier-stat 22 / exchange-
     stat 20 — Q-CARDBG-4 tolerance). */
  .card { background: oklch(0.18 0.014 265 / 0.5); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
  .card .label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .card .value.hero { font-size: 32px; }
  .card .sub { color: #8b949e; font-size: 11px; margin-top: 4px; }
  .green { color: #3fb950 !important; } .red { color: #f85149 !important; } .gold { color: #d29922 !important; } .muted { color: #8b949e !important; }
  .section { margin-bottom: 28px; }
  .section h2 { font-size: 14px; color: #8b949e; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; max-width: 800px; border-collapse: collapse; background: #161b22; border-radius: 12px; overflow: hidden; border: 1px solid #30363d; }
  th, td { padding: 12px 16px; border-bottom: 1px solid #21262d; font-size: 13px; text-align: center; font-variant-numeric: tabular-nums; }
  td:first-child, th:first-child { text-align: left; }
  th { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; background: #0d1117; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .badge-buy { background: #0d2818; color: #3fb950; } .badge-sell { background: #2d0b0e; color: #f85149; } .badge-hold { background: #1c1c1c; color: #8b949e; }
  /* DESIGN-W11-FF-CARD-BG (2026-05-15): filter pill bg + border unified to
     canonical tier-stat-card reference per Mr.1 directive (Q-CARDBG-2/3).
     border-radius:8px preserved (Q-CARDBG-3 — pills are CONTROLS, not content
     cards; rounded shape is UX affordance). Active-state per Q-CARDBG-1:
     text + border ONLY (no bg-tint). Exchange-tab active uses canonical mint
     (#5BEEB3); tier-tab active uses per-tier color via inline JS style
     (T1 blue / T2 green / T3 purple / T4 orange) — Q-CARDBG-1 RELAXATION
     to preserve per-tier semantic color identity. */
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid var(--line); background: oklch(0.18 0.014 265 / 0.5); color: #8b949e; transition: all 0.15s; }
  .tab:hover { border-color: #5BEEB380; } .tab.active { color: #5BEEB3; border-color: #5BEEB3; font-weight: 600; }
  .tier-tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tier-tab { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid var(--line); background: oklch(0.18 0.014 265 / 0.5); color: #8b949e; transition: all 0.15s; }
  .tier-tab:hover { border-color: #5BEEB380; } .tier-tab.active { border-width: 2px; }
  .tier-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; }
  .tradfi-badge { background: linear-gradient(135deg, #bc8cff20, #8957e520); border: 1px solid #bc8cff40; color: #bc8cff; font-size: 11px; padding: 4px 10px; border-radius: 6px; font-weight: 600; }
  /* DESIGN-W8-FIX (2026-05-11): onchain-badge bg unified to .tier-stat-card reference. */
  .onchain-badge { display: flex; align-items: center; gap: 10px; background: oklch(0.18 0.014 265 / 0.5); border: 1px solid #238636; border-radius: 10px; padding: 12px 18px; margin-bottom: 20px; }
  .onchain-badge .badge-icon { font-size: 18px; }
  .onchain-badge .badge-text { color: #3fb950; font-weight: 700; font-size: 14px; }
  .onchain-badge .badge-detail { color: #8b949e; font-size: 12px; }
  #merkle-stats { text-align:center; color:#8b949e; font-size:12px; margin-bottom:16px; }
  .tier-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 28px; }
  @media (max-width: 768px) { .tier-grid { grid-template-columns: 1fr; } }
  .tier-card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; }
  .tier-card .tc-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .tier-card .tc-name { font-size: 14px; font-weight: 700; }
  .tier-card .tc-assets { font-size: 11px; color: #8b949e; margin-bottom: 10px; }
  .tier-card .tc-stats { display: flex; flex-direction: column; gap: 4px; }
  .tier-card .tc-stat { display: flex; justify-content: space-between; align-items: baseline; }
  .tier-card .tc-stat .tc-label { font-size: 12px; color: #8b949e; }
  .tier-card .tc-stat .tc-val { font-size: 16px; font-weight: 700; text-align: right; }
  .tier-card .tc-stat .tc-val.pfe-hero { font-size: 20px; font-weight: 800; }
  .refresh { color: #8b949e; font-size: 12px; margin-top: 16px; }
  #loading { color: #8b949e; font-size: 16px; padding: 40px; text-align: center; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .empty { color: #8b949e; padding: 40px; text-align: center; font-size: 14px; }
  /* DESIGN-W8-FIX (2026-05-11): methodology bg unified to .tier-stat-card reference. */
  .methodology { background: oklch(0.18 0.014 265 / 0.5); border: 1px solid #30363d; border-radius: 12px; padding: 20px; font-size: 13px; line-height: 1.7; color: #c9d1d9; }
  .methodology p { margin-top: 12px; } .methodology p:first-child { margin-top: 0; }
  .methodology table { width: auto; background: transparent; border: none; margin-top: 8px; }
  .methodology table th { border: none; padding: 4px 24px 4px 0; color: #8b949e; font-weight: 600; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; background: transparent; }
  .methodology table td { border: none; padding: 3px 24px 3px 0; color: #c9d1d9; }
  .methodology code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .id-link { color: #5BEEB3; text-decoration: none; font-family: monospace; font-size: 12px; } .id-link:hover { text-decoration: underline; color: #82EFB8; }
  /* DESIGN-W11-FF3 (2026-05-14): Latest Trade Calls 6-col even-distribution
     widths per Mr.1 directive (Call + Confidence cols REMOVED for Data Integrity).
     100% / 6 cols = 16.66% each. Cols: ID / Time / Tier / Asset / Timeframe /
     Exchange. table-layout:fixed preserves consistent column rendering across
     varying row content (e.g. "#93097" vs "#88150", "Hyperliquid" vs "OKX"). */
  /* DESIGN-W11-FF-CARD-BG part-3 (2026-05-15): recent-table bg override.
     Global table-bg #161b22 + th-bg #0d1117 rules (above) were OVERRIDING
     the canonical .tr-recent-calls-panel wrapper bg oklch(0.18 0.014 265
     slash 0.5) inside the LATEST TRADE CALLS panel. Fix: make .recent-table
     plus its th/td transparent so the canonical panel bg shows through.
     Methodology tables unaffected (.methodology table has its own
     background:transparent scoping). */
  .recent-table { table-layout: fixed; max-width: none; width: 100%; background: transparent; border: none; }
  .recent-table th, .recent-table td { background: transparent; }
  .recent-table th { border-bottom: 1px solid var(--line); }
  .recent-table th:nth-child(1), .recent-table td:nth-child(1) { width: 16.66%; }
  .recent-table th:nth-child(2), .recent-table td:nth-child(2) { width: 16.66%; }
  .recent-table th:nth-child(3), .recent-table td:nth-child(3) { width: 16.66%; }
  .recent-table th:nth-child(4), .recent-table td:nth-child(4) { width: 16.66%; }
  .recent-table th:nth-child(5), .recent-table td:nth-child(5) { width: 16.66%; }
  .recent-table th:nth-child(6), .recent-table td:nth-child(6) { width: 16.66%; }
  /* DESIGN-W8 / C2: Verify Any Call card — matches canonical track-record-2.jsx:VerifySection */
  .verify-any-call-section { margin-bottom: 28px; }
  /* DESIGN-W8-FIX (2026-05-11): bg unified with .tier-stat-card reference per
     Mr.1's "match Performance by Asset Tier card bg" directive — drops the
     mint-tint gradient. Border retains subtle mint accent for accent identity. */
  .verify-any-call-card { background: oklch(0.18 0.014 265 / 0.5); border: 1px solid rgba(91,238,179,0.25); border-radius: 14px; padding: 32px 36px; display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: start; }
  @media (max-width: 768px) { .verify-any-call-card { grid-template-columns: 1fr; gap: 24px; padding: 24px 22px; } }
  .verify-any-call-eyebrow { color: #5BEEB3; font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 14px; }
  .verify-any-call-h2 { font-family: 'Inter Tight', sans-serif; font-size: 32px; font-weight: 500; letter-spacing: -0.02em; line-height: 1.05; color: #f0eee9; margin: 0 0 14px; text-transform: none; }
  .verify-any-call-h2-accent { color: #5BEEB3; }
  .verify-any-call-p { font-size: 14.5px; color: #c9d1d9; line-height: 1.55; margin: 0 0 22px; max-width: 460px; }
  .verify-any-call-em { color: #5BEEB3; font-style: normal; }
  .verify-any-call-meta { display: flex; flex-direction: column; gap: 10px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #c9d1d9; }
  .verify-any-call-meta-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .verify-any-call-meta-label { color: #6e7681; }
  .verify-any-call-meta-mono { color: #e1e4e8; }
  .verify-any-call-meta-accent { color: #5BEEB3; }
  /* DESIGN-W8-FIX (2026-05-11): full EIP-55 contract address as clickable link. */
  .verify-any-call-contract-link { text-decoration: none; word-break: break-all; }
  .verify-any-call-contract-link:hover { text-decoration: underline; }
  .verify-any-call-meta-dot { color: #6e7681; }
  .verify-any-call-basescan { color: #8b949e; text-decoration: none; margin-left: auto; font-size: 11px; }
  .verify-any-call-basescan:hover { color: #5BEEB3; }
  .verify-any-call-meta-pulse { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #5BEEB3; box-shadow: 0 0 8px rgba(91,238,179,0.5); }
  .verify-any-call-form { display: flex; flex-direction: column; gap: 12px; }
  .verify-any-call-form-label { color: #6e7681; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; }
  .verify-any-call-form-row { display: flex; gap: 10px; align-items: stretch; }
  @media (max-width: 768px) { .verify-any-call-form-row { flex-direction: column; } }
  .verify-any-call-input { flex: 1; height: 48px; padding: 0 16px; font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #f0eee9; background: #0d1117; border: 1px solid #30363d; border-radius: 10px; outline: none; }
  .verify-any-call-input:focus { border-color: rgba(91,238,179,0.45); }
  .verify-any-call-btn { background: #5BEEB3; color: #0a2b1f; height: 48px; padding: 0 22px; font-size: 14.5px; font-weight: 600; border: none; border-radius: 10px; white-space: nowrap; flex-shrink: 0; cursor: pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 8px 24px -8px rgba(91,238,179,0.55); }
  .verify-any-call-btn:hover { background: #82EFB8; }
  .verify-any-call-form-sub { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: #6e7681; line-height: 1.55; margin-top: 4px; }
  .verify-any-call-form-sub-mid { color: #c9d1d9; }
  /* P1-TRACK-RECORD-LEADERBOARD-W1: 3 ratified new classes (Q-P1-5). Everything
     else reuses .recent-table / .tab / .tf-bar-track / .tf-bar-fill / .tier-badge. */
  .lb-scroll { max-height: 560px; overflow: auto; background: oklch(0.18 0.014 265 / 0.5); border: 1px solid var(--line); border-radius: 12px; }
  .lb-scroll::-webkit-scrollbar { width: 10px; }
  .lb-scroll::-webkit-scrollbar-thumb { background: #30363d; border-radius: 8px; }
  .lb-rank { color: #6e7681; font-variant-numeric: tabular-nums; font-size: 12px; text-align: left; }
  .lb-small-sample { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #8b949e; background: oklch(0.22 0.012 265); border: 1px solid var(--line); }
</style>
<!-- P1-TRACK-RECORD-LEADERBOARD-W1 (R4 GEO): schema.org Dataset for the track
     record. Baseline JSON-LD on /track-record was 0 (probed); this adds 1.
     variableMeasured = PFE Win Rate + Sample Size (descriptive PropertyValue
     nodes — NO hardcoded metric values, forward-stable). No aggregateRating
     (Data Integrity + Google rich-results policy). Server-rendered raw HTML. -->
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Dataset","name":"AlgoVault trade-call track record","description":"Per-segment directional accuracy (PFE win rate) and sample size for AlgoVault trade calls, broken down by venue, asset, timeframe, and asset tier. Every call is Merkle-anchored on Base L2 for independent on-chain verification.","url":"https://algovault.com/track-record","isAccessibleForFree":true,"creator":{"@type":"Organization","name":"AlgoVault Labs","url":"https://algovault.com"},"measurementTechnique":"Peak Favorable Excursion (PFE) within each timeframe's evaluation window; confidence of at least 60% trade calls only","variableMeasured":[{"@type":"PropertyValue","name":"PFE Win Rate","description":"Share of trade calls where price moved in the called direction at any point during the evaluation window."},{"@type":"PropertyValue","name":"Sample Size","description":"Number of evaluated BUY/SELL trade calls in the segment (n)."}]}
</script>
</head>
<body>
<!-- LANDING-MOBILE-NAV-FUNCTION-RENDERED-W1: canonical Nav via shared renderSiteNav() (src/lib/site-nav.ts) — desktop byte-identical to the prior inline nav (Track Record active) + mobile hamburger/#mobile-menu panel/controller. -->
${renderSiteNav()}
<!-- DESIGN-W11 / C2 / Q-W11-3: canonical artboard wrapper OPEN (max-width:1400px preserves dashboard layout; 80px top padding clears 56px fixed Nav + breathing). Foreground content stacks above 3 bg-* layers via position:relative;z-index:1. -->
<main class="lp-track-record">
  <div class="artboard" style="padding:80px 24px 64px;max-width:1400px;margin:0 auto;width:100%">
    <div class="bg-grid"></div>
    <div class="bg-radial-accent"></div>
    <div class="bg-noise"></div>
    <div style="position:relative;z-index:1">
<!-- DESIGN-W11-FF (2026-05-14): brand block restyle per Mr.1 visual review.
     (1) Logo icon REMOVED (redundant with canonical Nav brand-mark above).
     (2) H1 enlarged to canonical content-H1 hierarchy (text-5xl sm:text-6xl
         font-semibold tracking-tight; matches /verify + /account treatment).
     (3) Partial Plasma Mint accent on "Track Record" noun phrase via
         <span class="text-mint-400"> — matches canonical mint-on-page-name
         pattern across the site.
     (4) Left-alignment intact (no text-center / mx-auto / justify-center).
     FF-REL-1 inline-fix: spec proposed class="text-fg" / class="text-fg-muted"
     but canonical CSS + Tailwind config define neither — using inline
     style="color:var(--fg)" / style="color:var(--fg-3)" per /account +
     landing precedent. Subtitle data-tr-field spans preserved byte-identical;
     pkg_version added as 45th unique data-tr-field key (additive; baseline 44 still satisfied via ≥). -->
<!-- DESIGN-W11-FF2 (2026-05-14): added mb-8 (32px margin-bottom) for canonical
     section-gap rhythm between brand block and exchange-logo strip below
     (matches Cross-Venue ↔ On-Chain Verified visual gap per Mr.1 directive). -->
<div class="space-y-2 mb-8">
  <h1 class="text-5xl sm:text-6xl font-semibold tracking-tight" style="color:var(--fg)">Live <span class="text-mint-400">Track Record</span></h1>
  <p class="text-sm" style="color:#5BEEB3">v<span data-tr-field="pkg_version">${PKG_VERSION}</span> &middot; <span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> Exchanges &middot; <span data-tr-field="asset_count">736</span> assets</p>
</div>
<div id="loading">Loading performance data...</div>
<div id="content" style="display:none">
  <!-- Exchange Logo Strip -->
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap">
    <span style="color:#6e7681;font-size:12px;text-transform:uppercase;letter-spacing:1px">Analyzing</span>
    <span id="analyzing-chips">${EXCHANGES.map(e => '<span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#8b949e">' + e.label + '</span>').join('')}</span>
  </div>
  <!-- Cross-Venue Intelligence Callout -->
  <div style="background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.15);border-radius:10px;padding:12px 18px;margin-bottom:16px;font-size:13px;color:#c9d1d9">
    <strong style="color:#58a6ff">Cross-Venue Intelligence</strong> &mdash; Trade calls are generated per exchange using native order books, funding rates, and OI data. The only MCP server analyzing ${EXCHANGE_COUNT} derivatives venues simultaneously.
  </div>
  <!-- On-Chain Verification Badge -->
  <div class="onchain-badge" id="onchain-badge" style="display:none">
    <span class="badge-icon">&#x1f517;</span>
    <div><span class="badge-text">On-Chain Verified</span><br><span class="badge-detail">Every call hashed on Base L2 — daily Merkle root published on-chain</span></div>
  </div>
  <div id="merkle-stats"></div>

  <!-- Exchange Filter Tabs -->
  <div class="tabs" id="exchange-tabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"></div>

  <!-- Tier Filter Tabs -->
  <div class="tier-tabs" id="tier-tabs"></div>

  <!-- KPI Cards (4) -->
  <div class="grid">
    <div class="card"><div class="label">Total Trade Calls</div><div class="value" id="total"></div><div class="sub" id="period"></div></div>
    <div class="card"><div class="label">PFE Win Rate</div><div class="value hero" id="pfe-wr"></div><div class="sub">Directional Accuracy</div></div>
  </div>
  <div id="eval-indicator" style="text-align:center;color:#8b949e;font-size:13px;margin:-8px 0 12px 0"></div>

  <!-- P1-TRACK-RECORD-LEADERBOARD-W1: unified filterable/sortable leaderboard.
       REPLACES the 3 fixed sections (Performance by Asset Tier / Exchange /
       Timeframe). Rows render client-side from the already-fetched
       /api/performance-public payload (cachedData.byExchange / byAsset /
       byTimeframe / byTier) via renderLeaderboard(), re-rendered on the existing
       30s load() loop — NO new setInterval. PFE WR + n (count) ONLY (allow-list;
       never the internal return / P&L fields). Controls: dimension pills (Q-P1-3 default
       Venue), sort (WR / n) + direction toggle (worst-first in one tap), and a
       min-sample FILTER (Q-P1-4: hides below the floor; n >= 0 restores
       everything; default n >= 30) with a muted "small sample" tag on shown
       sub-threshold rows. Timeframe set = byTimeframe minus HIDE_TFS (Q-P1-8
       single-source — the set composing the published aggregate; 1m/1d excluded).
       Asset caption live-rendered from the payload row count (Q-P1-7: never
       hardcoded). GEO heading: kicker -> sentence-case H2 (mint noun) -> dek. -->
  <div class="section" id="leaderboard-section">
    <div style="margin-bottom:18px">
      <div style="color:#5BEEB3;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">track record &middot; leaderboard</div>
      <h2 style="font-family:'Inter Tight',sans-serif;font-size:28px;font-weight:500;letter-spacing:-0.02em;line-height:1.1;color:#f0eee9;text-transform:none;margin:0 0 10px">Ranked by verified <span class="text-mint-400">win rate</span>.</h2>
      <p style="font-size:14px;color:#c9d1d9;line-height:1.55;max-width:640px;margin:0">Filter by venue, asset, timeframe, or tier. Sort by win rate or sample size &mdash; low-sample rows are tagged, never hidden.</p>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px 28px;margin-bottom:16px;align-items:flex-end">
      <div role="group" aria-label="Leaderboard dimension">
        <div style="color:#6e7681;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Dimension</div>
        <div class="tabs" id="lb-dim-pills" style="margin-bottom:0">
          <div class="tab active" data-dim="exchange" onclick="setLbDim('exchange')">Venue</div>
          <div class="tab" data-dim="asset" onclick="setLbDim('asset')">Asset</div>
          <div class="tab" data-dim="timeframe" onclick="setLbDim('timeframe')">Timeframe</div>
          <div class="tab" data-dim="tier" onclick="setLbDim('tier')">Tier</div>
        </div>
      </div>
      <div role="group" aria-label="Leaderboard sort">
        <div style="color:#6e7681;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Sort</div>
        <div class="tabs" id="lb-sort-pills" style="margin-bottom:0">
          <div class="tab active" data-sort="wr" onclick="setLbSort('wr')">Win rate</div>
          <div class="tab" data-sort="n" onclick="setLbSort('n')">Calls (n)</div>
          <div class="tab" id="lb-dir" onclick="toggleLbDir()" title="Toggle sort direction (worst-first in one tap)">&darr; high&rarr;low</div>
        </div>
      </div>
      <div role="group" aria-label="Minimum sample size filter">
        <div style="color:#6e7681;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Min sample</div>
        <div class="tabs" id="lb-minn-pills" style="margin-bottom:0">
          <div class="tab" data-minn="0" onclick="setLbMinN(0)">n &ge; 0</div>
          <div class="tab active" data-minn="30" onclick="setLbMinN(30)">n &ge; 30</div>
          <div class="tab" data-minn="100" onclick="setLbMinN(100)">n &ge; 100</div>
          <div class="tab" data-minn="500" onclick="setLbMinN(500)">n &ge; 500</div>
        </div>
      </div>
    </div>
    <div class="lb-scroll">
      <table class="recent-table" style="table-layout:fixed;min-width:560px">
        <thead><tr>
          <th style="width:9%;text-align:left;position:sticky;top:0;background:#0d1117;z-index:2">#</th>
          <th style="width:45%;text-align:left;position:sticky;top:0;background:#0d1117;z-index:2">Segment</th>
          <th style="width:32%;text-align:left;position:sticky;top:0;background:#0d1117;z-index:2">PFE Win Rate</th>
          <th style="width:14%;text-align:right;position:sticky;top:0;background:#0d1117;z-index:2">Calls (n)</th>
        </tr></thead>
        <tbody id="lb-tbody"><tr><td colspan="4" class="empty">Loading leaderboard&hellip;</td></tr></tbody>
      </table>
    </div>
    <div id="lb-caption" style="color:#6e7681;font-size:12px;margin-top:10px;display:none"></div>
  </div>

  <!-- DESIGN-W8-FIX / C2 (2026-05-11): Verify Any Call teaser card — translated
       from Design/AlgoVault Track Record v1/track-record-2.jsx VerifySection.
       FULL EIP-55 contract address (per Mr.1 directive 2026-05-11 — on-chain
       public, zero risk); clickable to Basescan. Live-bound merkle_batch_count
       + latest_batch_at hydrated from /api/merkle-batches.batches[0]; NEW
       next_batch_in countdown live-computed client-side (60s refresh) from
       next-00:05-UTC daily Merkle publish cadence. -->
  <div class="section verify-any-call-section">
    <div class="verify-any-call-card">
      <div class="verify-any-call-left">
        <div class="verify-any-call-eyebrow">&middot; VERIFY</div>
        <h2 class="verify-any-call-h2">Verify Any <span class="verify-any-call-h2-accent">Call</span></h2>
        <p class="verify-any-call-p">Every Call is hashed on Base L2 <em class="verify-any-call-em">before</em> the outcome is known. Inspect the contract on Basescan &mdash; we can&rsquo;t edit history.</p>
        <div class="verify-any-call-meta">
          <div class="verify-any-call-meta-row">
            <span class="verify-any-call-meta-label">contract</span>
            <a class="verify-any-call-meta-mono verify-any-call-meta-accent verify-any-call-contract-link" href="https://basescan.org/address/0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81" target="_blank" rel="noopener">0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81</a>
            <a class="verify-any-call-basescan" href="https://basescan.org/address/0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81" target="_blank" rel="noopener">basescan &#x2197;</a>
          </div>
          <div class="verify-any-call-meta-row">
            <span class="verify-any-call-meta-label">latest batch</span>
            <span class="verify-any-call-meta-mono">#<span data-tr-field="merkle_batch_count">&mdash;</span></span>
            <span class="verify-any-call-meta-dot">&middot;</span>
            <span class="verify-any-call-meta-mono" data-tr-field="latest_batch_at">&mdash;</span>
          </div>
          <div class="verify-any-call-meta-row">
            <span class="verify-any-call-meta-pulse"></span>
            <span class="verify-any-call-meta-mono">next batch in <span class="verify-any-call-meta-accent" data-tr-field="next_batch_in">&mdash;</span></span>
          </div>
        </div>
      </div>
      <form class="verify-any-call-form" action="/verify" method="get" onsubmit="return verifyAnyCallSubmit(event);">
        <label class="verify-any-call-form-label" for="verify-any-call-input">call id or call timestamp</label>
        <div class="verify-any-call-form-row">
          <input id="verify-any-call-input" name="id" type="text" class="verify-any-call-input" placeholder="0x4a2&hellip;f91   &middot;   or   2026-05-09T17:42:18Z" aria-label="Call ID or call timestamp" autocomplete="off">
          <button type="submit" class="verify-any-call-btn">Verify on-chain &rarr;</button>
        </div>
        <div class="verify-any-call-form-sub">opens <span class="verify-any-call-form-sub-mid">algovault.com/verify?id=&hellip;</span> &middot; shareable, deep-linkable proof page</div>
      </form>
    </div>
  </div>

  <!-- DESIGN-W8 / C1: Latest Trade Calls 8-col table — sources from
       cachedData.recentSignals (already loaded via /api/performance-public,
       30s refresh) per Q-W8-1=B. Real .id enables per-row deep-link to
       /verify?signalId=<id>; real .tier from server. Wrapper + header
       preserved from W4 panel; inner placeholder replaced with table. -->
  <div class="section"><h2>Latest Trade Calls</h2>
    <div class="tr-recent-calls-panel" id="tr-recent-calls-panel" aria-live="polite">
      <div class="tr-recent-calls-panel-header">
        <span>CALL STREAM &middot; LIVE</span>
        <span class="recent-calls-feed-tick"><span class="live-pulse"></span>tick</span>
      </div>
      <div id="tr-recent-calls-rows">
        <!-- DESIGN-W11-FF3 (2026-05-14): Call + Confidence columns REMOVED per Mr.1 Data Integrity directive ("should not be disclosure at here"). Public track record now shows 6 cols: ID, Time, Tier, Asset, Timeframe, Exchange. NOTE: underlying API /api/performance-public.recentSignals STILL returns .call + .confidence fields (legacy leakage flagged in LANDING-LIVE-CALL-TICKER-W1 audit snapshot); a follow-up wave should sanitize the API response shape to enforce Data Integrity LAW at the data layer, not just the UI layer. -->
        <table class="recent-table"><thead><tr><th>ID</th><th>Time</th><th>Tier</th><th>Asset</th><th class="num">Timeframe</th><th>Exchange</th></tr></thead>
        <tbody id="tr-recent-calls-tbody"><tr><td colspan="6" class="empty">Loading recent calls&hellip;</td></tr></tbody></table>
      </div>
    </div>
  </div>

  <!-- DESIGN-W8 / C3 (2026-05-11): 8 legacy sections REMOVED — content
       superseded by W3 4-tier-stat-cards (above), W4 5-exchange-stat-cards
       (above), W4 tf-bar-chart (above), W8 latest-calls 8-col panel
       (above), W8 verify teaser card (above). Architect-ratified per
       audits/DESIGN-W8-mapping.md ratification path B/canonical. Deleted:
       legacy tier-grid · call-type table · tamper-proof-record badge
       (integrated into Verify card) · legacy timeframe table · confidence-
       band table · top-performing assets · worst-performing assets ·
       legacy recent-calls table (rendering pattern repurposed as
       tr-recent-calls-tbody 8-col renderer in renderAll()). -->

  <!-- Methodology -->
  <div class="section"><h2>Methodology</h2>
    <div class="methodology">
      <p><strong>Total Trade Calls</strong> = BUY + SELL only. HOLDs excluded (stored separately).</p>
      <p><strong>PFE Win Rate</strong> = Percentage of trade calls where price moved in the called direction at any point during the evaluation window. Only confidence &ge; 60% signals are recorded and evaluated.</p>
      <p style="margin-top:16px"><strong>Evaluation Windows</strong></p>
      <table><thead><tr><th>Timeframe</th><th>Candles</th><th>Total Time</th></tr></thead><tbody>
        <tr><td>3m</td><td>12</td><td>36 minutes</td></tr><tr><td>5m</td><td>12</td><td>1 hour</td></tr><tr><td>15m</td><td>12</td><td>3 hours</td></tr>
        <tr><td>30m</td><td>8</td><td>4 hours</td></tr><tr><td>1h</td><td>8</td><td>8 hours</td></tr>
        <tr><td>2h</td><td>6</td><td>12 hours</td></tr><tr><td>4h</td><td>6</td><td>24 hours</td></tr>
        <tr><td>8h</td><td>4</td><td>32 hours</td></tr><tr><td>12h</td><td>4</td><td>48 hours</td></tr>
        <tr><td>1d</td><td>3</td><td>3 days</td></tr>
      </tbody></table>
      <p style="margin-top:16px"><strong>Asset Tiers</strong></p>
      <table><thead><tr><th>Tier</th><th>Name</th><th>Description</th></tr></thead><tbody>
        <tr><td style="color:#58a6ff">Tier 1</td><td>Blue Chip</td><td>BTC, ETH</td></tr>
        <tr><td style="color:#3fb950">Tier 2</td><td>Major Alts</td><td>Top 20 by notional OI across <span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges (dynamic, hourly)</td></tr>
        <tr><td style="color:#bc8cff">Tier 3</td><td>TradFi</td><td>Stocks, indices, commodities, FX</td></tr>
        <tr><td style="color:#d29922">Tier 4</td><td>Meme &amp; Micro</td><td>Meme &amp; micro-caps (liquidity-filtered: top 50 OI or &gt;$10M vol)</td></tr>
      </tbody></table>
      <p><strong>Default view</strong> shows all assets across all tiers. Use tier tabs to filter by quality tier.</p>
      <p style="margin-top:16px;color:#6e7681;font-size:11px"><em>This is not financial advice. Past performance does not guarantee future results.</em></p>
    </div>
  </div>

  <div class="refresh">Auto-refreshes every 30s &middot; <span id="updated"></span></div>
</div>

<script>
var PERF_URL = '${perfEndpoint}';
var CB_URL = '${cbEndpoint}';
var MERKLE_URL = '/api/merkle-batches';
var TF_ORDER = ['1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d'];
var TIER_COLORS = {1:'#58a6ff',2:'#3fb950',3:'#bc8cff',4:'#d29922'};
var TIER_NAMES = {1:'Blue Chip',2:'Major Alts',3:'TradFi',4:'Meme & Micro'};
var activeTfFilter = 'all';
var activeTierFilter = 'all'; // default: All Assets
var activeExchangeFilter = 'all'; // default: show ALL exchanges
var cachedData = null;

function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : '—'; }
function wrClass(v) { return v != null ? (v >= 0.5 ? 'green' : v >= 0.3 ? 'gold' : 'red') : 'muted'; }
function pfeClass(v) { return v != null ? (v >= 0.6 ? 'green' : v >= 0.45 ? 'gold' : 'red') : 'muted'; }
function pfClass(v) { return v != null ? (v >= 1.5 ? 'green' : v >= 1.0 ? 'gold' : 'red') : 'muted'; }
function evClass(v) { return v != null ? (v > 0 ? 'green' : 'red') : 'muted'; }
function badge(sig) { return '<span class="badge badge-' + sig.toLowerCase() + '">' + sig + '</span>'; }
function tierBadge(t) { return '<span class="tier-badge" style="background:' + (TIER_COLORS[t]||'#8b949e') + '20;color:' + (TIER_COLORS[t]||'#8b949e') + '">T' + t + '</span>'; }
function timeAgo(ts) { var s=Math.floor(Date.now()/1000-ts); if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }

function tierMatch(tier) {
  if (activeTierFilter === 'all') return true;
  return tier === parseInt(activeTierFilter);
}

// Get the correct data source based on active exchange + tier filters.
// 2-dimensional: exchange × tier → overall KPIs + sub-aggregates.
var HIDE_TFS = {'1d':1,'1D':1}; // Timeframes hidden from dashboard UI (data preserved in API)
function src() {
  var d = cachedData; if (!d) return null;
  var empty = { totalCalls: 0, totalEvaluated: 0, pfeWinRate: null };

  // Step 1: select exchange-level data
  var exAll, exByTF, exByType, exByAsset, exByTier;
  if (activeExchangeFilter === 'all') {
    exAll = d.overall;
    exByTF = d.byTimeframe || {};
    exByType = d.byCallType || {};
    exByAsset = d.byAsset || {};
    exByTier = d.byTier || {};
  } else {
    var ex = (d.byExchange || {})[activeExchangeFilter];
    if (!ex) return { overall: empty, byTF: {}, byType: {}, byAsset: {}, byTier: {} };
    exAll = { totalCalls: ex.count, totalEvaluated: ex.evaluated, pfeWinRate: ex.pfeWinRate };
    exByTF = ex.byTimeframe || {};
    exByType = ex.byCallType || {};
    exByAsset = ex.byAsset || {};
    exByTier = ex.byTier || {};
  }

  // Step 2: apply tier filter to KPIs
  var overall = exAll;
  if (activeTierFilter !== 'all') {
    var tk = 'tier' + activeTierFilter;
    var tier = exByTier[tk];
    if (tier) {
      overall = { totalCalls: tier.count || 0, totalEvaluated: tier.evaluated || 0, pfeWinRate: tier.pfeWinRate };
    } else {
      overall = empty;
    }
  }

  // Filter hidden timeframes from byTF
  var filteredTF = {};
  Object.keys(exByTF).forEach(function(k){ if (!HIDE_TFS[k]) filteredTF[k] = exByTF[k]; });

  return { overall: overall, byTF: filteredTF, byType: exByType, byAsset: exByAsset, byTier: exByTier };
}

function getFilteredRecent() {
  var all = cachedData ? (cachedData.recentSignals || []) : [];
  return all.filter(function(s) {
    if (!tierMatch(s.tier)) return false;
    if (activeExchangeFilter !== 'all' && s.exchange !== activeExchangeFilter) return false;
    return true;
  });
}

function setExchangeFilter(ex) {
  activeExchangeFilter = ex;
  document.querySelectorAll('#exchange-tabs .tab').forEach(function(t){
    var isActive = t.dataset.ex === ex;
    t.classList.toggle('active', isActive);
    t.style.borderColor = isActive ? '#58a6ff' : '#30363d';
    t.style.color = isActive ? '#58a6ff' : '#8b949e';
    t.style.background = isActive ? '#58a6ff20' : '#161b22';
  });
  renderAll();
}

// DESIGN-W8 / C4 (2026-05-11): setTfFilter REMOVED — #tf-tabs DOM deleted
// with legacy "Performance by Timeframe" table block per Q-W8-4. activeTfFilter
// pinned at 'all' (KPI cards now always show overall, no TF-filter UI).

function setTierFilter(mode) {
  activeTierFilter = mode;
  document.querySelectorAll('.tier-tab').forEach(function(t){
    var isActive = t.dataset.tier === mode;
    t.className = 'tier-tab' + (isActive ? ' active' : '');
    if (isActive) { t.style.borderColor = t.dataset.color || '#58a6ff'; t.style.color = t.dataset.color || '#58a6ff'; t.style.background = (t.dataset.color||'#58a6ff') + '20'; }
    else { t.style.borderColor = '#30363d'; t.style.color = '#8b949e'; t.style.background = '#161b22'; }
  });
  renderAll();
}

// ── P1-TRACK-RECORD-LEADERBOARD-W1: unified leaderboard controller ──────────
// Renders ONE sortable/filterable table from the already-fetched payload
// (cachedData.byExchange / byAsset / byTimeframe / byTier). Re-rendered by
// renderAll() on the existing 30s load() loop — adds NO setInterval. PFE WR +
// n (count) ONLY (allow-list; never internal return / P&L fields). Replaces the 3
// fixed per-segment hydration blocks (tier-stat-card / exchange-stat-card /
// tf-bar-chart) removed from renderAll().
var LB_DIM = 'exchange';      // Q-P1-3 default dimension: Venue
var LB_SORT = 'wr';           // 'wr' | 'n'
var LB_SORT_DIR = 'desc';     // 'desc' (high->low) | 'asc' (worst-first)
var LB_MIN_N = 30;            // Q-P1-4 filter floor (n>=0 = show everything); default 30
var LB_SMALL_N = 30;          // muted "small sample" tag bar (single source w/ default floor)
// OPS-VENUE-GO-LIVE-2026-06-30: promoted 5→12. The 7 appended alphabetically after
// the original 5 (display order). Brand colors: BINGX/GATE/HTX/KUCOIN/MEXC are exact
// brand hex; ASTER/PHEMEX brand-aligned (official hex not publicly retrievable).
var LB_EX_LABEL = { HL: 'Hyperliquid', BINANCE: 'Binance', BYBIT: 'Bybit', OKX: 'OKX', BITGET: 'Bitget', ASTER: 'Aster', BINGX: 'BingX', GATE: 'Gate.io', HTX: 'HTX', KUCOIN: 'KuCoin', MEXC: 'MEXC', PHEMEX: 'Phemex' };
var LB_EX_COLOR = { HL: '#4ade80', BINANCE: '#F0B90B', BYBIT: '#F7A600', OKX: '#ffffff', BITGET: '#00C8BC', ASTER: '#A855F7', BINGX: '#0058FB', GATE: '#17E6A1', HTX: '#0091D4', KUCOIN: '#23AF91', MEXC: '#1972E2', PHEMEX: '#818CF8' };
var LB_EX_ORDER = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'BINGX', 'GATE', 'HTX', 'KUCOIN', 'MEXC', 'PHEMEX'];

// Build the row set for the active dimension from cachedData. Each row = {label, wr, n, [color], [tier]}.
function lbRows() {
  var d = cachedData; if (!d) return [];
  var rows = [];
  if (LB_DIM === 'exchange') {
    var be = d.byExchange || {};
    LB_EX_ORDER.forEach(function(ex){ var e = be[ex]; if (!e) return;
      rows.push({ label: LB_EX_LABEL[ex] || ex, wr: e.pfeWinRate, n: e.count || 0, color: LB_EX_COLOR[ex] }); });
  } else if (LB_DIM === 'tier') {
    var bt = d.byTier || {};
    ['tier1','tier2','tier3','tier4'].forEach(function(k){ var t = bt[k]; if (!t) return;
      rows.push({ label: (t.label || ('Tier ' + t.tier)) + ' &middot; ' + (t.name || ''), wr: t.pfeWinRate, n: t.count || 0, color: t.color }); });
  } else if (LB_DIM === 'timeframe') {
    var btf = d.byTimeframe || {};
    // Q-P1-8: TF set = byTimeframe minus HIDE_TFS (single-source; equals the set
    // composing the published aggregate PFE WR — 1m latency-excluded, 1d not in aggregate).
    Object.keys(btf).forEach(function(tf){ if (HIDE_TFS[tf]) return;
      rows.push({ label: tf, wr: btf[tf].pfeWinRate, n: btf[tf].count || 0 }); });
    rows.sort(function(a,b){ return TF_ORDER.indexOf(a.label) - TF_ORDER.indexOf(b.label); });
  } else if (LB_DIM === 'asset') {
    var ba = d.byAsset || {};
    Object.keys(ba).forEach(function(sym){ var a = ba[sym];
      rows.push({ label: sym, wr: a.pfeWinRate, n: a.count || 0, tier: a.tier }); });
  }
  return rows;
}

function lbSorted(rows) {
  var dir = LB_SORT_DIR === 'asc' ? 1 : -1;
  return rows.slice().sort(function(a,b){
    var av = LB_SORT === 'n' ? a.n : (a.wr == null ? -1 : a.wr);
    var bv = LB_SORT === 'n' ? b.n : (b.wr == null ? -1 : b.wr);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    if (a.n !== b.n) return b.n - a.n; // stable tiebreak: larger sample first
    return a.label < b.label ? -1 : 1;
  });
}

function renderLeaderboard() {
  var tbody = document.getElementById('lb-tbody'); if (!tbody) return;
  var all = lbRows();
  var total = all.length;
  var shown = lbSorted(all.filter(function(r){ return (r.n || 0) >= LB_MIN_N; })); // Q-P1-4: real filter
  if (!shown.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No segments at n &ge; ' + LB_MIN_N + '. Lower the min-sample filter.</td></tr>';
  } else {
    tbody.innerHTML = shown.map(function(r, i){
      var wrTxt = r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '—';
      var wrW = r.wr != null ? (r.wr * 100).toFixed(1) : 0;
      var small = (r.n || 0) < LB_SMALL_N;
      var dot = r.color ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + r.color + ';margin-right:8px;vertical-align:middle"></span>' : '';
      var tierB = r.tier ? '<span class="tier-badge" style="background:' + (TIER_COLORS[r.tier] || '#8b949e') + '20;color:' + (TIER_COLORS[r.tier] || '#8b949e') + '">T' + r.tier + '</span> ' : '';
      var tag = small ? ' <span class="lb-small-sample">small sample</span>' : '';
      return '<tr' + (small ? ' style="opacity:0.6"' : '') + '>'
        + '<td class="lb-rank">' + (i + 1) + '</td>'
        + '<td style="text-align:left">' + dot + tierB + '<strong>' + r.label + '</strong>' + tag + '</td>'
        + '<td style="text-align:left"><div style="display:flex;align-items:center;gap:10px"><div class="tf-bar-track" style="flex:1;max-width:170px"><div class="tf-bar-fill" style="width:' + wrW + '%"></div></div><span style="min-width:54px;font-weight:600;color:var(--fg)">' + wrTxt + '</span></div></td>'
        + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + (r.n || 0).toLocaleString() + '</td>'
        + '</tr>';
    }).join('');
  }
  var cap = document.getElementById('lb-caption');
  if (cap) {
    if (LB_DIM === 'asset') {
      // Live counts from the payload (Q-P1-7: never hardcoded). "assets with evaluated calls"
      // is a different denominator than the landing's live asset_count — kept distinct so the
      // two can never contradict.
      cap.textContent = shown.length + ' of ' + total + ' assets with evaluated calls shown';
      cap.style.display = '';
    } else { cap.style.display = 'none'; }
  }
}

function lbActivate(containerId, key, val) {
  var c = document.getElementById(containerId); if (!c) return;
  c.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-' + key) === String(val)); });
}
function setLbDim(dim) { LB_DIM = dim; lbActivate('lb-dim-pills', 'dim', dim); renderLeaderboard(); }
function setLbSort(s) { LB_SORT = s; lbActivate('lb-sort-pills', 'sort', s); renderLeaderboard(); }
function toggleLbDir() { LB_SORT_DIR = LB_SORT_DIR === 'desc' ? 'asc' : 'desc'; var el = document.getElementById('lb-dir'); if (el) el.innerHTML = LB_SORT_DIR === 'desc' ? '&darr; high&rarr;low' : '&uarr; low&rarr;high'; renderLeaderboard(); }
function setLbMinN(n) { LB_MIN_N = n; lbActivate('lb-minn-pills', 'minn', n); renderLeaderboard(); }

function renderAll() {
  var d = cachedData; if (!d) return;
  var s = src(); if (!s) return;

  // KPIs — from server-side aggregates (not recomputed from recentSignals)
  if (activeTfFilter === 'all') {
    var pfeEl = document.getElementById('pfe-wr');
    pfeEl.textContent = pct(s.overall.pfeWinRate); pfeEl.className = 'value hero ' + pfeClass(s.overall.pfeWinRate);
    document.getElementById('total').textContent = (s.overall.totalCalls || 0).toLocaleString();
    document.getElementById('period').textContent = d.period ? d.period.from + ' → ' + d.period.to : 'Tracked & Evaluated';
  } else {
    var tfv = (s.byTF || {})[activeTfFilter];
    if (tfv) {
      var pfe2 = document.getElementById('pfe-wr');
      pfe2.textContent = pct(tfv.pfeWinRate); pfe2.className = 'value hero ' + pfeClass(tfv.pfeWinRate);
      document.getElementById('total').textContent = (tfv.count || 0).toLocaleString();
      document.getElementById('period').textContent = activeTfFilter + ' timeframe';
    }
  }

  // Evaluated indicator (with HOLD rate)
  var evalEl = document.getElementById('eval-indicator');
  if (evalEl) {
    var th = d.totalHolds || 0;
    var totalGenerated = (s.overall.totalCalls||0) + th;
    var holdRate = totalGenerated > 0 ? ((th / totalGenerated) * 100).toFixed(0) + '%' : '—';
    evalEl.textContent = 'Trade Calls: ' + (s.overall.totalCalls||0).toLocaleString() + ' · Evaluated: ' + (s.overall.totalEvaluated||0).toLocaleString() + ' · PFE Win Rate: ' + pct(s.overall.pfeWinRate) + ' · HOLD Rate: ' + holdRate;
  }

  // P1-TRACK-RECORD-LEADERBOARD-W1: the 3 fixed per-segment hydration blocks
  // (tier-stat-card / exchange-stat-card / tf-bar-chart) are REPLACED by the
  // unified leaderboard, re-rendered from cachedData on every load() (30s loop).
  renderLeaderboard();

  // DESIGN-W8 / C4 (2026-05-11): legacy #by-type, #by-timeframe, #top-assets,
  // #worst-assets, #cb-body renderers REMOVED — DOM elements deleted per Q-W8-4
  // (8-section canonical cleanup). Data still hydrates W3 4-tier-stat-card grid
  // + W4 5-exchange-stat-card grid + W4 tf-bar-chart (above).

  // DESIGN-W8 / C4 (2026-05-11): LATEST TRADE CALLS 8-col table hydration
  // (per Q-W8-1=B). Sources from cachedData.recentSignals (real .id enables
  // per-row deep-link to /verify?signalId=<id>; real .tier from server).
  // 30s page-level refresh; 2.5s polling IIFE DELETED per Q-W8-3=A.
  var recentEl = document.getElementById('tr-recent-calls-tbody');
  if (recentEl) {
    var recent = getFilteredRecent().slice(0,20);
    if (recent.length) {
      // DESIGN-W11-FF3 (2026-05-14): Call + Confidence <td> cells REMOVED per Mr.1 Data Integrity directive. 6-col row: ID / Time / Tier / Asset / Timeframe / Exchange.
      recentEl.innerHTML = recent.map(function(s){return '<tr><td><a href="/verify?signalId='+s.id+'" class="id-link">#'+s.id+'</a></td><td class="muted">'+timeAgo(s.created_at)+'</td><td>'+tierBadge(s.tier)+'</td><td><strong>'+s.coin+'</strong></td><td class="num">'+s.timeframe+'</td><td class="muted">'+(s.exchange||'HL')+'</td></tr>';}).join('');
    } else { recentEl.innerHTML='<tr><td colspan="6" class="empty">No trade calls'+(activeTfFilter!=='all'?' for '+activeTfFilter:'')+' yet.</td></tr>'; }
  }
}

async function load() {
  try {
    var r = await fetch(PERF_URL, { credentials: 'same-origin' });
    var d = await r.json();
    cachedData = d;

    // Tier filter tabs
    var ttEl = document.getElementById('tier-tabs');
    ttEl.innerHTML = [
      {id:'all',label:'All Assets',color:'#8b949e'},
      {id:'1',label:'Tier 1',color:'#58a6ff'},
      {id:'2',label:'Tier 2',color:'#3fb950'},
      {id:'3',label:'Tier 3 ✦',color:'#bc8cff'},
      {id:'4',label:'Tier 4',color:'#d29922'},
    ].map(function(t){
      var isActive = activeTierFilter === t.id;
      // DESIGN-W11-FF-CARD-BG (2026-05-15): Q-CARDBG-1 active state = text + border
      // (NO bg-tint per spec; was 'background:'+t.color+'20' creating per-tier bg
      // differentiation that violated the canonical card-bg unification). Per-tier
      // color identity preserved on text + border-color (T1 blue / T2 green /
      // T3 purple / T4 orange) — Q-CARDBG-1 RELAXATION because color encodes
      // tier semantically; mint-only would lose tier visual identity.
      var style = isActive ? 'border-color:'+t.color+';color:'+t.color : '';
      return '<div class="tier-tab'+(isActive?' active':'')+'" data-tier="'+t.id+'" data-color="'+t.color+'" style="'+style+'" onclick="setTierFilter(\\''+t.id+'\\')">'+t.label+'</div>';
    }).join('');

    // Exchange filter tabs
    var exTabs = document.getElementById('exchange-tabs');
    // OPS-VENUE-GO-LIVE Phase B (R3b-TR): data-driven from LB_EX_ORDER (the single SoT the
    // leaderboard uses) → shows all 12 promoted venues now, auto-grows to 17 with zero edits.
    var exchanges = [{id:'all',label:'ALL Exchanges'}].concat(LB_EX_ORDER.map(function(ex){ return {id:ex,label:LB_EX_LABEL[ex]||ex}; }));
    // DESIGN-W11-FF-CARD-BG (2026-05-15): inline style block REMOVED — relies on
    // .tab + .tab.active CSS rules (canonical bg + mint active text/border per
    // Q-CARDBG-1 + Q-CARDBG-2). font-size:13px overrides .tab default 12px →
    // preserved via inline style ONLY for that single value.
    exTabs.innerHTML = exchanges.map(function(ex){
      var isActive = activeExchangeFilter === ex.id;
      return '<div class="tab'+(isActive?' active':'')+'" data-ex="'+ex.id+'" style="font-size:13px" onclick="setExchangeFilter(\\''+ex.id+'\\')">'+ex.label+'</div>';
    }).join('');

    // OPS-VENUE-GO-LIVE Phase B (R3b-TR): Analyzing chip row — same LB_EX_ORDER SoT (12 now, auto-grows to 17)
    var chipsEl = document.getElementById('analyzing-chips');
    if (chipsEl) chipsEl.innerHTML = LB_EX_ORDER.map(function(ex){
      return '<span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:'+(LB_EX_COLOR[ex]||'#c9d1d9')+'">'+(LB_EX_LABEL[ex]||ex)+'</span>';
    }).join('');

    // DESIGN-W8 / C4 (2026-05-11): #tf-tabs population REMOVED — DOM target
    // deleted with legacy "Performance by Timeframe" table block per Q-W8-4.
    // Confidence-bands fetch REMOVED — #cb-section + #cb-body DOM deleted.

    renderAll();

    // Merkle on-chain badge + DESIGN-W8 latest_batch_at hydration for Verify card
    try {
      var mr = await fetch(MERKLE_URL);
      var md = await mr.json();
      if (md.batches && md.batches.length > 0) {
        document.getElementById('onchain-badge').style.display = 'flex';
        var totalVerified = md.batches.reduce(function(a,b){return a+(parseInt(b.signal_count)||0);},0);
        var latest = md.batches[0];
        document.getElementById('merkle-stats').innerHTML = 'On-Chain Proof: ' + md.batches.length + ' batch' + (md.batches.length>1?'es':'') + ' published · ' + totalVerified.toLocaleString() + ' calls verified · <a href="https://basescan.org/address/' + md.contractAddress + '" target="_blank" style="color:#58a6ff">View on Basescan →</a>';
        // DESIGN-W8-FIX / C3 (2026-05-11): hydrate Verify card's latest batch
        // number + timestamp. Batch # from latest.batch_id; timestamp formatted
        // as "YYYY-MM-DD HH:MM UTC" (matches canonical track-record-2.jsx).
        if (latest.batch_id != null) {
          document.querySelectorAll('[data-tr-field="merkle_batch_count"]').forEach(function(el){ el.textContent = latest.batch_id; });
        }
        if (latest.published_at) {
          var dt = new Date(latest.published_at);
          var pad = function(n){return String(n).padStart(2,'0');};
          var batchAtStr = dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth()+1) + '-' + pad(dt.getUTCDate()) + ' ' + pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes()) + ' UTC';
          document.querySelectorAll('[data-tr-field="latest_batch_at"]').forEach(function(el){ el.textContent = batchAtStr; });
        }
      }
    } catch(e) { /* merkle stats are best-effort */ }

    document.getElementById('updated').textContent = 'Updated: ' + new Date().toLocaleString();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch(e) { document.getElementById('loading').textContent = 'Error: ' + e.message; }
}
load();
setInterval(load, 30000);

// DESIGN-W8 / C4 (2026-05-11): DESIGN-W4 2.5s /api/recent-calls polling IIFE
// REMOVED — LATEST TRADE CALLS panel now hydrates from cachedData.recentSignals
// via renderAll() (30s page refresh) per Q-W8-1=B. Drops 2.5s dependency on
// /api/recent-calls (sanitized public endpoint lacks .id + .tier needed for
// 8-col table). Canonical track-record-2.jsx FeedSection has no polling.

// DESIGN-W8 / C2: Verify Any Call form submit handler.
// Form action="/verify" already provides graceful no-JS fallback; this handler
// trims whitespace and constructs the canonical query-string URL.
function verifyAnyCallSubmit(ev) {
  try {
    var input = document.getElementById('verify-any-call-input');
    var v = (input && input.value || '').trim();
    if (v) {
      ev.preventDefault();
      window.location.href = '/verify?id=' + encodeURIComponent(v);
      return false;
    }
    // Empty input → fall through to native form GET → /verify
    return true;
  } catch (e) { return true; }
}

// DESIGN-W8-FIX (2026-05-11): live countdown to next Merkle batch publish.
// Merkle batches publish daily at 00:05 UTC (confirmed via /api/merkle-batches
// historical data: every batch's published_at lies in [00:05, 00:06) UTC).
// Updates every 60s; format "Xh Ym" matches canonical track-record-2.jsx.
function updateNextBatchCountdown() {
  try {
    var now = new Date();
    var nextBatch = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5, 0));
    if (nextBatch <= now) {
      nextBatch = new Date(nextBatch.getTime() + 86400000); // +1 day
    }
    var diffMs = nextBatch - now;
    var hours = Math.floor(diffMs / 3600000);
    var minutes = Math.floor((diffMs % 3600000) / 60000);
    var str = hours + 'h ' + minutes + 'm';
    document.querySelectorAll('[data-tr-field="next_batch_in"]').forEach(function(el){ el.textContent = str; });
  } catch (e) { /* best-effort */ }
}
updateNextBatchCountdown();
setInterval(updateNextBatchCountdown, 60000);
</script>
    </div>
  </div>
</main>
<!-- FOOTER-UNIFY-W1: canonical brand footer from the single SoT (src/lib/footer-content.ts renderBrandFooter). Was the inline DESIGN-W11 literal + PH-BADGE-COMPACT-W1 badge. -->
${renderBrandFooter('desktop')}
</body>
</html>`;
}

// ── Smithery sandbox export ──
// Allows Smithery to scan tools/resources without starting the server.
// See https://smithery.ai/docs/deploy#sandbox-server
export function createSandboxServer() {
  return createServer();
}

// ── Signup Page HTML ──

function getSignupPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlgoVault — Subscribe</title>
<!-- BEGIN: AlgoVault canonical design loader (DESIGN-W2 / D2-C, cross-origin) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://algovault.com/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; }
  .container { max-width: 960px; width: 100%; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: #8b949e; margin-bottom: 32px; font-size: 14px; }
  .plans { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
  @media (max-width: 768px) { .plans { grid-template-columns: 1fr; } }
  .plan { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; position: relative; }
  .plan.popular { border-color: #34D199; }
  .plan h2 { font-size: 20px; margin-bottom: 4px; }
  .plan .price { font-size: 36px; font-weight: 700; color: #58a6ff; margin: 12px 0; }
  .plan .price span { font-size: 16px; font-weight: 400; color: #8b949e; }
  .plan ul { list-style: none; margin: 16px 0 24px; }
  .plan ul li { padding: 4px 0; color: #c9d1d9; font-size: 14px; }
  .plan ul li::before { content: '\\2713'; color: #3fb950; margin-right: 8px; }
  .btn { display: inline-block; background: #238636; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 16px; font-weight: 600; transition: background 0.15s; }
  .btn:hover { background: #2ea043; }
  .btn.ent { background: #8957e5; }
  .btn.ent:hover { background: #a371f7; }
  .pop-badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #34D199; color: #0f1117; font-size: 11px; font-weight: 700; padding: 3px 12px; border-radius: 20px; letter-spacing: 0.5px; }
</style>
</head>
<body>
<div class="container">
  <h1>AlgoVault Subscriptions</h1>
  <div class="subtitle">Free tier includes all assets and all 11 timeframes &mdash; capped at 100 calls/month. Upgrade for higher monthly limits and unlimited funding-arb results.</div>
  <div style="display:flex;justify-content:center;gap:12px;margin-bottom:24px;flex-wrap:wrap">
    ${EXCHANGES.map(e => '<span style="color:#8b949e;font-size:12px;font-weight:600">' + e.label + '</span>').join('<span style="color:#6e7681">&middot;</span>')}
  </div>
  ${renderSignupFlowDark()}
  ${renderPlanCards()}
  <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px 28px;margin-top:20px;display:flex;flex-wrap:wrap;align-items:center;gap:16px;justify-content:space-between">
    <div style="flex:1;min-width:260px">
      <h2 style="font-size:18px;margin-bottom:6px;color:#e1e4e8">No subscription? Pay-per-call with x402</h2>
      <div style="color:#8b949e;font-size:14px;line-height:1.5">Agents can skip signup entirely &mdash; pay per call in USDC on Base. From $0.01/call &middot; $0.02 standard. No Stripe, no API key. HOLD trade calls free.</div>
    </div>
    <a class="btn" href="https://algovault.com/docs.html#x402" style="background:#1f6feb;white-space:nowrap">Pay per call with x402 &rarr;</a>
  </div>
</div>
</body>
</html>`;
}


// ── Entry Point ──
// TG-BROADCAST-STACK-W1 CH6 (2026-05-28): capture `--track-token=` from
// process.argv at startup (no-op if absent). Used by the /unlock_premium_alerts
// viral mechanic — see src/lib/track-token.ts for full semantics.
// OPS-MCP-SESSION-RESILIENCE-W1: boot only as the entrypoint (node dist/index.js / npx
// stdio). The guard makes this module import-safe so the stateless handler + correlation
// resolver can be unit-tested without binding a port or connecting upstreams.
if (require.main === module) {
  captureArgvTrackToken();

  const transport = (process.env.TRANSPORT || 'http').toLowerCase();

  if (transport === 'stdio') {
    startStdio().catch((err) => {
      console.error('Fatal:', err);
      closeDb();
      process.exit(1);
    });
  } else {
    startHttp().catch((err) => {
      console.error('Fatal:', err);
      closeDb();
      process.exit(1);
    });
  }
}
