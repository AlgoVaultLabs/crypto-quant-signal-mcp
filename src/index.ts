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
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ExchangeId } from './types.js';
import { getTradeSignal } from './tools/get-trade-call.js';
import { scanFundingArb } from './tools/scan-funding-arb.js';
import { getMarketRegime } from './tools/get-market-regime.js';
import { getSignalPerformance, runBackfill } from './resources/signal-performance.js';
import { refreshGridIfStale } from './lib/cross-asset-grid.js';
import { closeDb, getConfidenceBands, getHoldStats, getMerkleBatches, getSignalWithBatch, getSignalByHash, upsertAgentSession, getSampleSignalsFromLatestBatch, getRecentCallsAsync, type RecentCall } from './lib/performance-db.js';
import { PKG_VERSION } from './lib/pkg-version.js';
import { buildErc8004ReputationBody } from './lib/erc8004-reputation.js';
import { verifyProof } from './lib/merkle.js';
import { warmTierCaches } from './lib/asset-tiers.js';
import { EXCHANGES, EXCHANGE_COUNT, TIMEFRAME_COUNT, getAssetCount, floorRoundTo10 } from './lib/capabilities.js';
import { resolveLicense, resolveLicenseSync, requestContext, getRequestLicense, getRequestSessionId, getRequestIpHash, getRequestVerdict, setRequestVerdict, initQuotaDb } from './lib/license.js';
import { initX402, settleX402Async } from './lib/x402.js';
import { initAnalytics, logRequest, hashIp, getUsageStats, logSkillInvocation } from './lib/analytics.js';
import { ensureProcessedStripeEventsSchema, tryClaimEvent } from './lib/stripe-events-store.js';
import { getAnalyticsSummary } from './resources/analytics-summary.js';
import { getSkillsAnalytics } from './resources/skills-analytics.js';
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
import { UpstreamRateLimitError, EXCHANGE_FALLBACKS, TradFiSymbolUnsupportedOnVenueError, TierLimitReachedError } from './lib/errors.js';
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
  PARAM_DESC_FUNDING_MIN_SPREAD_BPS,
  PARAM_DESC_FUNDING_LIMIT,
  PARAM_DESC_REGIME_COIN,
  PARAM_DESC_REGIME_TIMEFRAME,
  PARAM_DESC_REGIME_EXCHANGE,
} from './tool-descriptions.js';
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
import { getLLMProvider, type LLMProvider } from './lib/llm-provider.js';
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
    const payload = {
      code: err.code,
      error_code: err.code,
      message: err.message,
      current_usage: err.current_usage,
      monthly_limit: err.monthly_limit,
      tier: err.tier,
      suggested_upgrade_url: err.suggested_upgrade_url,
      retry_after_days: err.retry_after_days,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}
import { renderSignupFlowDark } from './lib/signup-flow.js';
import {
  accountPageHandler,
  accountPortalHandler,
  accountRecoverKeyHandler,
} from './lib/account-handlers.js';
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

function createServer(): McpServer {
  const server = new McpServer({
    name: 'crypto-quant-signal-mcp',
    version: PKG_VERSION,
  });

  // ── Tool 1: get_trade_call (canonical, v1.10.0) + get_trade_signal (alias for back-compat) ──
  // The handler is identical; we register the same factory under two names so
  // existing agents calling `get_trade_signal` continue to work without changes.
  // The `_algovault.tool` field in the response always reports `get_trade_call`
  // (the canonical name). TRADE_CALL_DESCRIPTION + TRADE_CALL_ALIAS_SUFFIX +
  // param describe() constants are module-scope-exported above (see
  // TOOL-DESC-AUDIT-W1 block) so the keyword canary test can import them.
  const TRADE_CALL_SCHEMA = {
    coin: z.string().max(20).describe(PARAM_DESC_TRADE_CALL_COIN),
    timeframe: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']).default('15m').describe(PARAM_DESC_TRADE_CALL_TIMEFRAME),
    includeReasoning: z.boolean().default(true).describe(PARAM_DESC_TRADE_CALL_INCLUDE_REASONING),
    exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT']).default('BINANCE').describe(PARAM_DESC_TRADE_CALL_EXCHANGE),
  };
  function makeTradeCallHandler(toolNameForAnalytics: 'get_trade_call' | 'get_trade_signal') {
    return async ({ coin, timeframe, includeReasoning, exchange }: { coin: string; timeframe: '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d'; includeReasoning: boolean; exchange: ExchangeId }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        const result = await getTradeSignal({ coin, timeframe, includeReasoning, exchange, license });
        // Verdict stored for x402 settlement skip (HOLDs don't settle)
        setRequestVerdict(result.call);
        // Quota tracking is handled inside getTradeSignal (HOLDs are free)
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: toolNameForAnalytics,
          asset: coin,
          timeframe,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          verdict: result.call,
          confidence: result.confidence,
          ipHash: getRequestIpHash(),
          isBotInternal: license.tier === 'internal',
        });
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: toolNameForAnalytics,
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    };
  }
  server.tool(
    'get_trade_call',
    TRADE_CALL_DESCRIPTION,
    TRADE_CALL_SCHEMA,
    { readOnlyHint: true, openWorldHint: true },
    makeTradeCallHandler('get_trade_call')
  );
  server.tool(
    'get_trade_signal',
    TRADE_CALL_DESCRIPTION + TRADE_CALL_ALIAS_SUFFIX,
    TRADE_CALL_SCHEMA,
    { readOnlyHint: true, openWorldHint: true },
    makeTradeCallHandler('get_trade_signal')
  );

  // ── Tool 2: scan_funding_arb ──
  server.tool(
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
    { readOnlyHint: true, openWorldHint: true },
    async ({ minSpreadBps, limit }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Quota tracking is handled inside scanFundingArb
        const result = await scanFundingArb({ minSpreadBps, limit, license });
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
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        return toolErrorContent(err);
      }
    }
  );

  // ── Tool 3: get_market_regime ──
  server.tool(
    'get_market_regime',
    GET_MARKET_REGIME_DESCRIPTION,
    {
      coin: z.string().max(20).describe(PARAM_DESC_REGIME_COIN),
      timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe(PARAM_DESC_REGIME_TIMEFRAME),
      exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX', 'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT']).default('HL').describe(PARAM_DESC_REGIME_EXCHANGE),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ coin, timeframe, exchange }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Quota tracking is handled inside getMarketRegime
        const result = await getMarketRegime({ coin, timeframe, exchange });
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
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
  server.tool(
    'search_knowledge',
    SEARCH_KNOWLEDGE_DESCRIPTION,
    {
      query: z.string().min(3).max(500).describe('Natural-language search query (3-500 chars).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max ranked results (1-50, default 10).'),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ query, limit }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        const { index, engine } = await getKnowledgeSearch();
        const results = await engine.query(query, limit ?? 10);
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
  server.tool(
    'chat_knowledge',
    CHAT_KNOWLEDGE_DESCRIPTION,
    {
      question: z.string().min(5).max(500).describe('Natural-language question (5-500 chars).'),
      model: z.enum(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']).optional().describe('Optional model override (default claude-haiku-4-5-20251001).'),
    },
    { readOnlyHint: true, openWorldHint: true },
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
        const result = await chatEngine.chat(question, { model });
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
      return {
        contents: [{
          uri: 'performance://signal-performance',
          text: JSON.stringify(stats, null, 2),
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
      description: "Per-venue lifecycle state machine: shadow / promoted / retired. Each venue carries asset_count, min_buy_sell_sample, integration timestamp, and last evaluation stats. New venues default to 'shadow' (experimental — not yet on the public /track-record dashboard) and auto-promote via daily cron when PFE WR ≥0.80 over asset_count×10 BUY/SELL signals (HOLDs excluded). Agents querying with a shadow venue's exchange_id should surface an 'experimental' caveat to the end user.",
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
        venues: venues.map(v => ({
          exchange_id: v.exchange_id,
          status: v.status,
          asset_count: v.asset_count,
          min_buy_sell_sample: v.min_buy_sell_sample,
          integrated_at: v.integrated_at,
          promoted_at: v.promoted_at,
          retired_at: v.retired_at,
          extension_count: v.extension_count,
          last_eval_at: v.last_eval_at,
          last_eval_pfe_wr: v.last_eval_pfe_wr,
          last_eval_buy_sell_count: v.last_eval_buy_sell_count,
          notes: v.notes,
        })),
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

  const { default: express } = await import('express');
  const { default: rateLimit } = await import('express-rate-limit');

  const app = express();
  app.set('trust proxy', 1); // Trust Caddy reverse proxy for req.secure, req.ip
  const port = parseInt(process.env.PORT || '3000', 10);

  // CORS — restrict to same-origin + algovault.com
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'https://api.algovault.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-payment, mcp-session-id, x-algovault-skill-slug');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Rate limiting
  app.use('/mcp', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
  app.use('/analytics', rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));
  app.use('/webhooks', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

  // Store active transports for session management (with last-activity tracking)
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActivity = new Map<string, number>();
  const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  // Periodic cleanup of stale sessions (every 5 minutes)
  const sessionCleanupInterval = setInterval(() => {
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
  const INTEGRATION_EXCHANGES = ['binance', 'okx', 'bybit', 'bitget'] as const;
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
        case 'customer.subscription.created':
          await handleSubscriptionCreated(event);
          break;
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
    if (plan !== 'starter' && plan !== 'pro' && plan !== 'enterprise') {
      return res.status(400).send(getSignupPageHtml());
    }

    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const utmSource = typeof req.query.utm_source === 'string' ? req.query.utm_source : undefined;
      const utmCampaign = typeof req.query.utm_campaign === 'string' ? req.query.utm_campaign : undefined;
      // Derive a session-unique client_reference_id for downstream attribution
      // join even when UTM tags are absent (e.g. direct /signup typing).
      const clientReferenceId = `${utmSource ?? 'direct'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const url = await createCheckoutSession(plan, baseUrl, {
        utmSource,
        utmCampaign,
        clientReferenceId,
      });
      if (!url) return res.status(500).send('Stripe not configured or missing price IDs');
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

    // Organic visit (no session_id) — render paywall CTA + no API-key reveal.
    if (!sessionId) {
      return res.send(getWelcomePageHtml(null, null, null, { utmSource, utmCampaign }));
    }

    try {
      const { apiKey, tier, email } = await getCustomerApiKey(sessionId);
      res.send(getWelcomePageHtml(apiKey, tier, email, { utmSource, utmCampaign }));
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
      // post-C1 backfill → no behavior change at deploy. Shadow venues
      // (when they exist post-C5) get their own /api/performance-shadow
      // endpoint. Fail-open: if venue-store lookup throws, fall through
      // to unfiltered byExchange so the public surface doesn't break on
      // a venues-table outage.
      let filteredByExchange = stats.byExchange;
      let shadow_venue_count = 0;
      try {
        const promoted = await listVenues('promoted');
        const shadow = await listVenues('shadow');
        shadow_venue_count = shadow.length;
        const promotedIds = new Set(promoted.map(v => v.exchange_id));
        if (promotedIds.size > 0) {
          filteredByExchange = Object.fromEntries(
            Object.entries(stats.byExchange).filter(([ex]) => promotedIds.has(ex)),
          );
        }
      } catch (err) {
        console.error('[performance-public] venues filter failed (fail-open):', err instanceof Error ? err.message : err);
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
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch performance stats' });
    }
  });

  // ── /api/performance-shadow (EXCHANGE-SHADOW-PROMOTE-W1 / C4) ──
  // Transparency endpoint for shadow venues — same per-venue stat shape as
  // /api/performance-public.byExchange.<EX> but filtered to status='shadow'
  // rows. Public, no auth. Adds lifecycle metadata (asset_count,
  // min_buy_sell_sample, days_since_integration, extension_count,
  // last_eval_*) so consumers can see how close each shadow venue is to
  // promotion.
  app.get('/api/performance-shadow', async (_req, res) => {
    try {
      const shadow = await listVenues('shadow');
      const stats = shadow.length > 0 ? await getSignalPerformance() : null;
      const nowSec = Math.floor(Date.now() / 1000);
      const venues = shadow.map(v => {
        const integratedSec = Math.floor(new Date(v.integrated_at).getTime() / 1000);
        const ex = stats?.byExchange?.[v.exchange_id] ?? null;
        return {
          exchange_id: v.exchange_id,
          status: v.status,
          asset_count: v.asset_count,
          min_buy_sell_sample: v.min_buy_sell_sample,
          integrated_at: v.integrated_at,
          days_since_integration: Math.floor((nowSec - integratedSec) / 86400),
          extension_count: v.extension_count,
          last_eval_at: v.last_eval_at,
          last_eval_pfe_wr: v.last_eval_pfe_wr,
          last_eval_buy_sell_count: v.last_eval_buy_sell_count,
          // Mirror the per-venue aggregate shape from byExchange (when stats
          // include the venue; some shadow venues may not yet have signals).
          current_buy_sell_count: ex?.count ?? 0,
          current_pfe_wr: ex?.pfeWinRate ?? null,
          byTimeframe: ex?.byTimeframe ?? {},
          byTier: ex?.byTier ?? {},
          byCallType: ex?.byCallType ?? {},
        };
      });
      res.json({ venues, updated_at: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch shadow venue stats' });
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

  app.get('/track-record', (_req, res) => {
    res.send(getPerformanceDashboardHtml({ isPublic: true }));
  });

  // ── Merkle verification endpoints (public, no auth) ──
  const MERKLE_CONTRACT_ADDR = process.env.MERKLE_CONTRACT_ADDRESS || '';

  app.get('/api/verify-signal', async (req, res) => {
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
    let _analyticsProvider: 'anthropic' | 'stub' | 'openai' | 'gemini' = 'anthropic';
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
    // Resolve license per-request using 3-tier gate: x402 → API key → free
    // Async because x402 verification hits the Facilitator
    const { license, pendingSettlement } = await resolveLicense(
      req.headers as Record<string, string | undefined>,
    );

    // Hash client IP for privacy-safe analytics
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || (req.headers['x-real-ip'] as string)
      || req.socket.remoteAddress
      || 'unknown';
    const ipHash = hashIp(clientIp);
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // C6 (algovault-skills SKILLS-W1): per-Skill attribution.
    // If the request carries X-AlgoVault-Skill-Slug AND is a tools/call,
    // log the invocation fire-and-forget BEFORE dispatching to the transport.
    // Slug values are public (Skill names are open-source); user_agent is
    // truncated to 200 chars in logSkillInvocation.
    const skillSlugHeader = (req.headers['x-algovault-skill-slug'] as string | undefined)?.trim();
    if (skillSlugHeader && req.method === 'POST' && req.body && typeof req.body === 'object') {
      const body = req.body as { method?: string; params?: { name?: string } };
      if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
        // Fire-and-forget; never blocks the request.
        try {
          logSkillInvocation(skillSlugHeader, body.params.name, sessionId, req.headers['user-agent'] as string | undefined);
        } catch { /* best-effort */ }
      }
    }

    // Run the entire request handling inside AsyncLocalStorage context
    // so tool handlers read the correct per-request license
    await requestContext.run({ license, sessionId, ipHash }, async () => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

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

  const httpServer = app.listen(port, () => {
    console.log(`crypto-quant-signal-mcp running on http://0.0.0.0:${port}/mcp`);
    console.log(`Health check: http://0.0.0.0:${port}/health`);
    // Warm tier caches in background (xyz symbols, OI rankings, liquid memes)
    warmTierCaches().catch(() => {});

    // Auto-backfill: evaluate pending signals every 5 minutes
    console.log('[backfill] Auto-backfill enabled: every 5 minutes');
    setTimeout(() => runBackfill().catch(() => {}), 10_000); // first run after 10s
    setInterval(() => runBackfill().catch(() => {}), 300_000); // then every 5 min

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
    clearInterval(sessionCleanupInterval);
    if (adminCleanupInterval) clearInterval(adminCleanupInterval);
    for (const transport of transports.values()) {
      transport.close?.();
    }
    transports.clear();
    sessionLastActivity.clear();
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
<div class="logo"><span>&#x1f4ca;</span><div><h1>AlgoVault Analytics</h1><div class="subtitle">crypto-quant-signal-mcp</div></div></div>
<div id="loading">Loading analytics...</div>
<div id="content" style="display:none">
  <div class="grid">
    <div class="card"><div class="label">Total Calls (All Time)</div><div class="value" id="total-all"></div></div>
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
</style>
</head>
<body>
<!-- DESIGN-W11 / C2 / Q-W11-1+Q-W11-4: canonical Nav VERBATIM from live algovault.com per audits/DESIGN-W11-canonical-chrome-extract.md §1. Track Record link uses active-link styling (text-mint-400 font-medium) replacing hover:text-white transition. Brand-mark wrap uses /account precedent (direct ahref + aria-label + cross-origin href). -->
<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">
  <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
    <a href="https://algovault.com/" class="flex items-center gap-2.5" aria-label="AlgoVault home">
      <img src="/logo.png" alt="AlgoVault Logo" class="w-7 h-7 rounded-md">
      <span class="text-white font-semibold text-sm">AlgoVault Labs</span>
    </a>
    <div class="hidden sm:flex items-center gap-6 text-sm text-gray-400">
      <a href="/track-record" class="text-mint-400 font-medium">Track Record</a>
      <a href="https://algovault.com/how-it-works" class="hover:text-white transition">How it works</a>
      <a href="https://algovault.com/#pricing" class="hover:text-white transition">Pricing</a>
      <a href="https://algovault.com/integrations" class="hover:text-white transition">Integrations</a>
      <a href="https://algovault.com/skills" class="hover:text-white transition">Skills</a>
      <a href="https://algovault.com/docs.html" class="hover:text-white transition">Docs</a>
      <a href="https://algovault.com/verify" class="hover:text-white transition">Verify</a>
      <a href="https://api.algovault.com/account" class="hover:text-white transition">Account</a>
      <a href="https://api.algovault.com/signup" class="px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition">Signup</a>
    </div>
  </div>
</nav>
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
  <p class="text-sm" style="color:var(--fg-3)">v<span data-tr-field="pkg_version">${PKG_VERSION}</span> &middot; <span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> Exchanges &middot; <span data-tr-field="asset_count">736</span> assets</p>
</div>
<div id="loading">Loading performance data...</div>
<div id="content" style="display:none">
  <!-- Exchange Logo Strip -->
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap">
    <span style="color:#6e7681;font-size:12px;text-transform:uppercase;letter-spacing:1px">Analyzing</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#4ade80">Hyperliquid</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#F0B90B">Binance</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#F7A600">Bybit</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#fff">OKX</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#00C8BC">Bitget</span>
  </div>
  <!-- Cross-Venue Intelligence Callout -->
  <div style="background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.15);border-radius:10px;padding:12px 18px;margin-bottom:16px;font-size:13px;color:#c9d1d9">
    <strong style="color:#58a6ff">Cross-Venue Intelligence</strong> &mdash; Signals are generated per exchange using native order books, funding rates, and OI data. The only MCP server analyzing 5 derivatives venues simultaneously.
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

  <!-- DESIGN-W3 / C4: Performance by Asset Tier — canonical track-record.jsx
       TierSection translation. 4 tier-stat-cards (T1/T2/T3/T4) hydrated from
       /api/performance-public.byTier on page load (NOT polling — tier
       breakdown is slow-moving). Uses .tier-stat-grid + .tier-stat-card from
       D2-C/D3-C1 algovault-design.css. Tier colors are SEMANTIC non-brand
       (Tier 1 blue / T2 green / T3 purple / T4 orange) — preserved per D1-C;
       NOT mint-swapped. Sits ABOVE the existing tier-cards JS-hydrated grid
       (preserved untouched for backward compat). -->
  <div class="section"><h2>Performance by Asset Tier</h2>
    <div class="tier-stat-grid" id="tier-stat-grid">
      <div class="tier-stat-card" id="tier-stat-card-tier1" data-tier-color="#58a6ff">
        <div class="tier-stat-card-stripe"></div>
        <div class="tier-stat-card-header">
          <div>
            <span class="tier-stat-tier-label">T1</span>
            <div class="tier-stat-name" data-tr-field="tier_t1_name">Blue Chip</div>
          </div>
          <span class="tier-stat-sample" data-tr-field="tier_t1_sample">BTC &middot; ETH</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="tier_t1_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-pfe-bar"><div class="tier-stat-pfe-fill" id="tier-stat-pfe-tier1"></div></div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="tier_t1_n">&mdash;</div>
        </div>
      </div>
      <div class="tier-stat-card" id="tier-stat-card-tier2" data-tier-color="#3fb950">
        <div class="tier-stat-card-stripe"></div>
        <div class="tier-stat-card-header">
          <div>
            <span class="tier-stat-tier-label">T2</span>
            <div class="tier-stat-name" data-tr-field="tier_t2_name">Major Alts</div>
          </div>
          <span class="tier-stat-sample" data-tr-field="tier_t2_sample">&mdash;</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="tier_t2_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-pfe-bar"><div class="tier-stat-pfe-fill" id="tier-stat-pfe-tier2"></div></div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="tier_t2_n">&mdash;</div>
        </div>
      </div>
      <div class="tier-stat-card" id="tier-stat-card-tier3" data-tier-color="#bc8cff">
        <div class="tier-stat-card-stripe"></div>
        <div class="tier-stat-card-header">
          <div>
            <span class="tier-stat-tier-label">T3</span>
            <div class="tier-stat-name" data-tr-field="tier_t3_name">TradFi</div>
          </div>
          <span class="tier-stat-sample" data-tr-field="tier_t3_sample">&mdash;</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="tier_t3_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-pfe-bar"><div class="tier-stat-pfe-fill" id="tier-stat-pfe-tier3"></div></div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="tier_t3_n">&mdash;</div>
        </div>
      </div>
      <div class="tier-stat-card" id="tier-stat-card-tier4" data-tier-color="#d29922">
        <div class="tier-stat-card-stripe"></div>
        <div class="tier-stat-card-header">
          <div>
            <span class="tier-stat-tier-label">T4</span>
            <div class="tier-stat-name" data-tr-field="tier_t4_name">Meme &amp; Micro</div>
          </div>
          <span class="tier-stat-sample" data-tr-field="tier_t4_sample">&mdash;</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="tier_t4_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-pfe-bar"><div class="tier-stat-pfe-fill" id="tier-stat-pfe-tier4"></div></div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="tier_t4_n">&mdash;</div>
        </div>
      </div>
    </div>
  </div>

  <!-- DESIGN-W4 / C3: Performance by Exchange — translated from track-record-2.jsx
       ExchangeSection. 5 cards (Hyperliquid/Binance/Bybit/OKX/Bitget verbatim)
       hydrated from /api/performance-public.byExchange on page load (extends
       applyView(); no polling — exchange breakdown is slow-moving). Brand colors
       match Supported Exchanges row on landing. -->
  <div class="section"><h2>Performance by Exchange</h2>
    <div class="exchange-stat-grid" id="exchange-stat-grid">
      <div class="exchange-stat-card" id="exchange-stat-card-HL" data-exchange-color="#4ade80">
        <div class="exchange-stat-card-stripe"></div>
        <div class="exchange-stat-card-logo">
          <span class="exchange-stat-card-mark">H</span>
          <span>Hyperliquid</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="ex_HL_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="ex_HL_n">&mdash;</div>
        </div>
      </div>
      <div class="exchange-stat-card" id="exchange-stat-card-BINANCE" data-exchange-color="#F0B90B">
        <div class="exchange-stat-card-stripe"></div>
        <div class="exchange-stat-card-logo">
          <span class="exchange-stat-card-mark">B</span>
          <span>Binance</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="ex_BINANCE_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="ex_BINANCE_n">&mdash;</div>
        </div>
      </div>
      <div class="exchange-stat-card" id="exchange-stat-card-BYBIT" data-exchange-color="#F7A600">
        <div class="exchange-stat-card-stripe"></div>
        <div class="exchange-stat-card-logo">
          <span class="exchange-stat-card-mark">BY</span>
          <span>Bybit</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="ex_BYBIT_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="ex_BYBIT_n">&mdash;</div>
        </div>
      </div>
      <div class="exchange-stat-card" id="exchange-stat-card-OKX" data-exchange-color="#ffffff">
        <div class="exchange-stat-card-stripe"></div>
        <div class="exchange-stat-card-logo">
          <span class="exchange-stat-card-mark">O</span>
          <span>OKX</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="ex_OKX_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="ex_OKX_n">&mdash;</div>
        </div>
      </div>
      <div class="exchange-stat-card" id="exchange-stat-card-BITGET" data-exchange-color="#00C8BC">
        <div class="exchange-stat-card-stripe"></div>
        <div class="exchange-stat-card-logo">
          <span class="exchange-stat-card-mark">BG</span>
          <span>Bitget</span>
        </div>
        <div class="tier-stat-wr-row">
          <span class="tier-stat-wr"><span data-tr-field="ex_BITGET_wr">&mdash;</span><span class="tier-stat-wr-suffix">%</span></span>
          <span class="tier-stat-wr-cap">WR</span>
        </div>
        <div class="tier-stat-divider">
          <div class="tier-stat-n-cap">n =</div>
          <div class="tier-stat-n" data-tr-field="ex_BITGET_n">&mdash;</div>
        </div>
      </div>
    </div>
  </div>

  <!-- DESIGN-W4 / C3 + DESIGN-W8-FIX (2026-05-11) + OPS-DASHBOARD-3M-DISPLAY-W1
       (2026-05-23): Performance by Timeframe canonical bar chart — translated
       from track-record-2.jsx TimeframeSection.
       9 evaluated timeframes (3m / 5m / 15m / 30m / 1h / 2h / 4h / 8h / 12h).
       1m / 1d trimmed per Mr.1 directive — 1m stays shadow pending sample-
       density accrual; 1d shows wide variance due to small n. 3m joined
       the dashboard on 2026-05-23 (slot #3 best by PFE) after clearing
       shadow-mode decision gates per SHADOW-REVEAL-3M-W1 (2026-05-19).
       Hydrated from /api/performance-public.byTimeframe on page load. The
       "11 TIMEFRAMES" marketing claim is preserved verbatim across landing /
       signup / faq / docs (claim of SUPPORTED TF count via the get_trade_call
       MCP tool, distinct from the 9-row evaluated-WR chart granularity). -->
  <div class="section"><h2>Performance by Timeframe</h2>
    <div class="tf-bar-chart" id="tf-bar-chart">
      <div class="tf-bar-row" data-tf="3m"><span class="tf-bar-label">3m</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-3m"></div></div><span class="tf-bar-value" data-tr-field="tf_3m_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="5m"><span class="tf-bar-label">5m</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-5m"></div></div><span class="tf-bar-value" data-tr-field="tf_5m_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="15m"><span class="tf-bar-label">15m</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-15m"></div></div><span class="tf-bar-value" data-tr-field="tf_15m_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="30m"><span class="tf-bar-label">30m</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-30m"></div></div><span class="tf-bar-value" data-tr-field="tf_30m_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="1h"><span class="tf-bar-label">1h</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-1h"></div></div><span class="tf-bar-value" data-tr-field="tf_1h_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="2h"><span class="tf-bar-label">2h</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-2h"></div></div><span class="tf-bar-value" data-tr-field="tf_2h_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="4h"><span class="tf-bar-label">4h</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-4h"></div></div><span class="tf-bar-value" data-tr-field="tf_4h_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="8h"><span class="tf-bar-label">8h</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-8h"></div></div><span class="tf-bar-value" data-tr-field="tf_8h_wr">&mdash;</span></div>
      <div class="tf-bar-row" data-tf="12h"><span class="tf-bar-label">12h</span><div class="tf-bar-track"><div class="tf-bar-fill" id="tf-bar-fill-12h"></div></div><span class="tf-bar-value" data-tr-field="tf_12h_wr">&mdash;</span></div>
    </div>
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

  // DESIGN-W8 / C4 (2026-05-11): legacy #tier-cards JS-hydrated grid rendering
  // REMOVED — superseded by W3 4-tier-stat-card grid hydrated below.
  var bt = d.byTier || {};
  var exTier = s.byTier || {};

  // DESIGN-W3 / C4: hydrate canonical .tier-stat-card[data-tr-field] spans from
  // /api/performance-public.byTier. Page-load only (no polling — tier breakdown
  // is slow-moving). Sets --tier-color via setProperty (no inline style=).
  ['tier1','tier2','tier3','tier4'].forEach(function(k){
    var t = bt[k]; if (!t) return;
    var tc = exTier[k] || { count: 0, pfeWinRate: null };
    var card = document.getElementById('tier-stat-card-' + k);
    if (!card) return;
    var color = card.getAttribute('data-tier-color') || t.color;
    if (color) card.style.setProperty('--tier-color', color);
    var setText = function(field, val){
      var el = card.querySelector('[data-tr-field="' + field + '"]');
      if (el) el.textContent = val;
    };
    var tag = 't' + t.tier; // t1..t4
    setText('tier_' + tag + '_name', t.name || '—');
    var sample = (t.assets||[]).slice(0,3).join(' · ');
    setText('tier_' + tag + '_sample', sample || '—');
    var wrPct = (tc.pfeWinRate != null) ? (tc.pfeWinRate * 100).toFixed(1) : '—';
    setText('tier_' + tag + '_wr', wrPct);
    setText('tier_' + tag + '_n', (tc.count != null ? tc.count.toLocaleString() : '—'));
    var fill = document.getElementById('tier-stat-pfe-' + k);
    if (fill && tc.pfeWinRate != null) fill.style.width = (tc.pfeWinRate * 100).toFixed(1) + '%';
  });

  // DESIGN-W4 / C3: hydrate canonical .exchange-stat-card spans from
  // /api/performance-public.byExchange. Page-load only — exchange breakdown
  // is slow-moving. Brand colors set via data-exchange-color → --exchange-color
  // CSS custom property (no inline style=).
  var byEx = d.byExchange || {};
  ['HL','BINANCE','BYBIT','OKX','BITGET'].forEach(function(ex){
    var card = document.getElementById('exchange-stat-card-' + ex);
    if (!card) return;
    var color = card.getAttribute('data-exchange-color');
    if (color) card.style.setProperty('--exchange-color', color);
    var exData = byEx[ex] || { count: 0, pfeWinRate: null };
    var wrEl = card.querySelector('[data-tr-field="ex_' + ex + '_wr"]');
    var nEl  = card.querySelector('[data-tr-field="ex_' + ex + '_n"]');
    if (wrEl) wrEl.textContent = (exData.pfeWinRate != null) ? (exData.pfeWinRate * 100).toFixed(1) : '—';
    if (nEl)  nEl.textContent  = (exData.count != null) ? exData.count.toLocaleString() : '—';
  });

  // DESIGN-W4 / C3 + DESIGN-W8-FIX (2026-05-11) + OPS-DASHBOARD-3M-DISPLAY-W1
  // (2026-05-23): hydrate canonical .tf-bar-chart from
  // /api/performance-public.byTimeframe. Page-load only. Renders 9 evaluated
  // TFs (3m/5m/15m/30m/1h/2h/4h/8h/12h); 1m/1d trimmed per Mr.1 directive
  // (1m stays shadow pending sample-density accrual; 1d high variance).
  // 3m joined 2026-05-23 (slot #3 best by PFE) after clearing shadow-mode
  // gates per SHADOW-REVEAL-3M-W1 (2026-05-19).
  // "11 TIMEFRAMES" marketing claim preserved elsewhere — refers to SUPPORTED
  // TF count via get_trade_call MCP tool, not evaluated-WR chart granularity.
  var byTF = d.byTimeframe || {};
  ['3m','5m','15m','30m','1h','2h','4h','8h','12h'].forEach(function(tf){
    var row = document.querySelector('[data-tf="' + tf + '"]');
    if (!row) return;
    var tfData = byTF[tf] || { pfeWinRate: null };
    var valEl = row.querySelector('[data-tr-field="tf_' + tf + '_wr"]');
    var fill = document.getElementById('tf-bar-fill-' + tf);
    if (tfData.pfeWinRate != null) {
      var pct = (tfData.pfeWinRate * 100).toFixed(1);
      if (valEl) valEl.textContent = pct + '%';
      if (fill) fill.style.width = pct + '%';
    } else {
      if (valEl) valEl.textContent = '—';
    }
  });

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
    var exchanges = [{id:'all',label:'ALL Exchanges'},{id:'HL',label:'Hyperliquid'},{id:'BINANCE',label:'Binance'},{id:'BYBIT',label:'Bybit'},{id:'OKX',label:'OKX'},{id:'BITGET',label:'Bitget'}];
    // DESIGN-W11-FF-CARD-BG (2026-05-15): inline style block REMOVED — relies on
    // .tab + .tab.active CSS rules (canonical bg + mint active text/border per
    // Q-CARDBG-1 + Q-CARDBG-2). font-size:13px overrides .tab default 12px →
    // preserved via inline style ONLY for that single value.
    exTabs.innerHTML = exchanges.map(function(ex){
      var isActive = activeExchangeFilter === ex.id;
      return '<div class="tab'+(isActive?' active':'')+'" data-ex="'+ex.id+'" style="font-size:13px" onclick="setExchangeFilter(\\''+ex.id+'\\')">'+ex.label+'</div>';
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
<!-- DESIGN-W11 / C2 / Q-W11-4: canonical Footer VERBATIM (desktop variant) from live algovault.com per audits/DESIGN-W11-canonical-chrome-extract.md §2. Matches /account ACCOUNT_FOOTER_HTML byte-identical. -->
<footer style="padding:44px 80px 56px;border-top:1px solid var(--line);background:oklch(0.13 0.012 265);display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:24px;font-size:13px;color:var(--fg-3)">
  <div style="display:flex;align-items:center;gap:10px">
    <img src="/logo.png" alt="AlgoVault" style="width:22px;height:22px;border-radius:6px;object-fit:contain;flex-shrink:0">
    <span style="color:var(--fg-2)">Built by AlgoVault Labs</span>
  </div>
  <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap">
    <a href="https://github.com/AlgoVaultLabs" target="_blank" rel="noopener" style="color:var(--fg-3);text-decoration:none">GitHub</a>
    <a href="https://x.com/AlgoVaultLabs" target="_blank" rel="noopener" style="color:var(--fg-3);text-decoration:none">X / Twitter</a>
    <a href="/signup" style="color:var(--fg-3);text-decoration:none">Signup</a>
    <a href="/privacy" style="color:var(--fg-3);text-decoration:none">Privacy</a>
  </div>
</footer>
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
    <span style="color:#4ade80;font-size:12px;font-weight:600">Hyperliquid</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#F0B90B;font-size:12px;font-weight:600">Binance</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#F7A600;font-size:12px;font-weight:600">Bybit</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#fff;font-size:12px;font-weight:600">OKX</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#00C8BC;font-size:12px;font-weight:600">Bitget</span>
  </div>
  ${renderSignupFlowDark()}
  <div class="plans">
    <div class="plan">
      <h2>Starter</h2>
      <div class="price">$9.99<span>/mo</span></div>
      <ul>
        <li>3,000 calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets (crypto + TradFi)</li>
        <li>All timeframes (1m to 1d)</li>
        <li>Email support</li>
      </ul>
      <a class="btn" href="/signup?plan=starter">Subscribe to Starter</a>
    </div>
    <div class="plan popular">
      <div class="pop-badge">MOST POPULAR</div>
      <h2>Pro</h2>
      <div class="price">$49<span>/mo</span></div>
      <ul>
        <li>15,000 calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets (crypto + TradFi)</li>
        <li>All timeframes (1m to 1d)</li>
        <li>Priority support</li>
      </ul>
      <a class="btn" href="/signup?plan=pro">Subscribe to Pro</a>
    </div>
    <div class="plan">
      <h2>Enterprise</h2>
      <div class="price">$299<span>/mo</span></div>
      <ul>
        <li>100,000 calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets &amp; timeframes</li>
        <li>SLA guarantee</li>
        <li>Dedicated support</li>
      </ul>
      <a class="btn ent" href="/signup?plan=enterprise">Subscribe to Enterprise</a>
    </div>
  </div>
</div>
</body>
</html>`;
}


// ── Entry Point ──
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
