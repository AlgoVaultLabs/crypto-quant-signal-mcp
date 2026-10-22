/**
 * tool-call-pipeline.ts — ARCH-MCP-CALL-PIPELINE-W1 CH2 (Q-PIPE-1 = design A).
 *
 * THE ONE PATH every tool call takes, on every channel: MCP (`/mcp` + stdio), x402 HTTP, okx.ai
 * A2MCP, Virtuals ACP. The module owns the per-call shell that used to be written once per channel —
 * context → admission → dispatch → record → envelope — behind TWO entry points, `callTool` and
 * `toMcpToolResult`. Channels are DATA (`CHANNEL_POLICY`), tools are DATA (`TOOLS`); there is no
 * channel literal on the call path, and a registry row without a `TOOLS` row is a compile error.
 *
 * WHY. The same property was added to one channel's tool path and silently missed the others three
 * times (license forwarding 50182fac · the regime log fields + error arm baf8642b · `rankBy` 7eda8bca)
 * and the perp default timeframe lived in three places that agreed by coincidence — until the CH1
 * harness measured the Virtuals ACP channel serving `1h` where every other channel served `15m`.
 * Two dispatch tables cannot be kept in step by review; one table cannot drift from itself.
 *
 * RULINGS CARRIED (Cowork, 2026-10-15, recorded in audits/ARCH-MCP-CALL-PIPELINE-W1-endpoint-truth.md):
 *   R-1  public outputs byte-identical — the CH1 harness (tests/unit/tool-call-parity.test.ts) is the arbiter.
 *   R-2  NO payment semantics here: prices, `tryClaimPayment`, settle order, facilitators, sampling and
 *        rail mounts stay in the rails. This module never charges.
 *   R-3  stateless: no module-level per-request state; context through the existing ALS accessors or
 *        the explicit `ctx` argument.
 *   R-4  dispatch keyed off FEATURE_REGISTRY names, exhaustive at compile time; aliases via `getFeature`.
 *   R-6  recording is ROW- and COLUMN-exact per channel (Q-PIPE-1 condition 3): MCP records inside the
 *        request scope with the canonical projection; the x402 HTTP twin records OUTSIDE the scope with
 *        the twin projection it has always written (no `confidence`, no HOLD-capture quartet, no
 *        user agent) — a non-NULL `holdCapture` would enrol an x402 row in the hold-decision population
 *        (analytics.ts, `hold-decision-capture.ts`, the directional labeler). A2MCP and ACP record
 *        nothing (Q-PIPE-3 = defer). Arbiter: tests/fixtures/tool-call-parity/recorded-rows.json.
 *   Q-PIPE-2 rows 1–2 (a): every channel's `get_trade_call` goes through `routeTradeCall`, so
 *        `DEFAULT_PERP_TIMEFRAME` (market-route.ts) is the ONLY runtime perp default and the engine's
 *        `|| '1h'` is unreachable from any channel.
 *   Q-PIPE-2 row 12 (a): a DEFINED `timeframe` outside the tool's enum is REFUSED here, before dispatch
 *        (`kind:'refused'`, 400) — the second instance of the SEC-09 class (A2MCP once served `7h` on 4h
 *        candles labelled 7h), so the refusal lives at the one choke point. MCP (zod) and the HTTP rails
 *        (Ajv over the Bazaar schema) refuse earlier; ACP's free-string schema is what this catches.
 *
 * INVARIANTS. Stage order is fixed: alias→canonical · reach check · admission · dispatch · record ·
 * return. `callTool` never rejects for a request-class failure (`refused` / `threw` are outcomes); it
 * throws only for programmer error (unknown tool, channel not declared for the tool). Recording
 * completes before the promise resolves; the rail's `res.json` → settle ordering is untouched.
 * `toMcpToolResult` is pure.
 */
import { getFeature, type FeatureSpec, type RegistryToolName, type RegistryAliasName } from './feature-registry.js';
import type { LicenseInfo, ExchangeId } from '../types.js';
import {
  requestContext,
  getRequestSessionId,
  getRequestIpHash,
  getRequestSource,
  getRequestIsBackground,
  getRequestRegimeFundingDegraded,
  recordAhaMilestoneCrossing,
  type RequestContext,
} from './license.js';
import { logRequest } from './analytics.js';
import { upsertAgentSession } from './performance-db.js';
import { runAsBatch, runAsCaller } from './upstream-weight-budget.js';
import { x402CallerTag, processScopedTag } from './caller-tags.js';
import { regimeSuccessVerdict, regimeErrorVerdict } from './regime-request-verdict.js';
import { TIMEFRAMES } from './capabilities.js';
import { REGIME_TIMEFRAMES } from './tool-param-schema.js';
import {
  UpstreamRateLimitError,
  EXCHANGE_FALLBACKS,
  TradFiSymbolUnsupportedOnVenueError,
  TierLimitReachedError,
  InsufficientCandlesError,
  buildInsufficientCandlesPayload,
  StaleUpstreamWindowError,
  buildStaleUpstreamWindowPayload,
  TimeframeUnservedError,
  buildTimeframeUnservedPayload,
  buildTierLimitPayload,
} from './errors.js';
import { buildSuggestedX402, isX402NudgeEnabled } from './x402-nudge.js';
import { recordFirstNonHoldVerdict, shouldShowAhaReferral, ahaReferralAlreadyShown } from './aha-event.js';
import { referralCodeForKey } from './referral-store.js';
import { buildAhaHint, buildAhaReferral, buildReferralHint, AHA_HIGH_CONVICTION_CONFIDENCE, type ReferralHint, type AhaReferralFrom } from './nudge-copy.js';
import { getTrackRecord } from './track-record-snapshot.js';
import { renderReceiptText, renderScanReceiptText } from './receipts.js';
import { renderScanDigest } from './scan-digest.js';
import { routeTradeCall } from '../tools/trade-call-router.js';
import { getMarketRegime } from '../tools/get-market-regime.js';
import { scanFundingArb } from '../tools/scan-funding-arb.js';
import { runScanTradeCall } from '../tools/scan-trade-calls.js';
import { getEquityRegime } from './equities/equity-tool-formatters.js';
import { runGetTrackRecord } from '../tools/get-track-record.js';
import { runScanMarketRegimes } from '../tools/scan-market-regimes.js';
import { getKnowledgeSearch, getChatStack, chatTierFor } from '../tools/knowledge-tools.js';
import { formatSearchKnowledgeResponse } from './search-knowledge-formatter.js';
import { chatQuotaApiKey, buildChatQuotaNotice } from './chat-rate-limit.js';
import { formatChatKnowledgeResponse } from './chat-knowledge-formatter.js';
import { recordChatEvent } from './chat-analytics.js';
import type { ScanExchangeId } from './trade-call-scanner.js';
import type { PromotedVenueId } from './capabilities.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A channel — the keys of `FeatureSpec.channels`, so a new rail is a registry change first. */
export type ChannelId = keyof FeatureSpec['channels'];

/** Every canonical tool name the registry declares (literal union — a row here must have a `TOOLS` row). */
export type CanonicalTool = RegistryToolName;
/** Every served name: canonical names plus aliases (e.g. `get_trade_signal`). */
export type ServedTool = CanonicalTool | RegistryAliasName;

declare const VALIDATED_INPUT: unique symbol;
/**
 * A tool input that has passed its channel's validator. Minted ONLY at the three validators — the MCP
 * handler (after the SDK's zod parse), `validateToolInput`'s ok-arm (x402 HTTP + A2MCP) and the ACP
 * worker after its Ajv check + `requirementToParams`. Passing an unbranded object is a tsc error; a raw
 * `req.body` is `any` and slips every brand, which is why `scripts/check-paid-route-validation.mjs`
 * stays as the backstop (Q-PIPE-1 condition 2).
 */
export type ValidatedToolInput = Record<string, unknown> & { readonly [VALIDATED_INPUT]: true };

export interface ToolCallRequest {
  /** The SERVED name — an alias stays an alias here, so `request_log.tool_name` is unchanged. */
  tool: ServedTool | string;
  input: ValidatedToolInput;
  /** REQUIRED and typed — the license-forwarding drift class dies at the one entry point. */
  license: LicenseInfo;
  channel: ChannelId;
  /**
   * Given → the call runs inside `requestContext.run({ ...ctx, license })`; omitted → the ambient
   * request context is inherited (the `/mcp` POST layer installs it before the handler runs).
   */
  ctx?: Omit<RequestContext, 'license'>;
}

export type ToolCallOutcome =
  | { ok: true; tool: string; input: ValidatedToolInput; result: unknown }
  /** An in-band refusal: a quota notice, a track-record section refusal, an undeclared timeframe, a future 401. */
  | { ok: false; kind: 'refused'; tool: string; input: ValidatedToolInput; payload: Record<string, unknown>; http: { status: number }; mcpIsError: true }
  /** The engine threw. The rail renders its own 500; MCP renders the typed error through `toolErrorContent`. */
  | { ok: false; kind: 'threw'; tool: string; input: ValidatedToolInput; error: unknown };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Channel policy — every per-channel fact, as data the compiler checks
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ChannelPolicy {
  /** The registry flag this channel is reached through (the reach check). */
  flag: ChannelId;
  /** Write a `request_log` row? (R-6: MCP + x402 yes · A2MCP + ACP no, Q-PIPE-3 deferred) */
  requestLog: boolean;
  /** Write the `agent_sessions` cohort row? (MCP only, 4 cohort tools) */
  agentSession: boolean;
  /**
   * Record INSIDE the request scope (the ALS supplies session id, ip hash, user agent and the
   * HOLD-capture stamp) — or OUTSIDE it, with only the explicit `ctx` fields, which is what the x402
   * twin has always written. Q-PIPE-1 condition 3.
   */
  recordInScope: boolean;
  /** `canonical` = the MCP handler's field set · `twin` = the x402 twin's (asset/timeframe from the input, no confidence). */
  logProjection: 'canonical' | 'twin';
  /**
   * The channel's upstream-weight attribution around the engine call. MCP is the tool's own literal
   * tag (each TOOLS row wraps its engine in `runAsCaller('<tool>', …)`, exactly as the handlers did);
   * the paid rails ADD the innermost `x402CallerTag(served)` frame the twin always added
   * (OPS-RATELIMIT-CALLER-ATTRIBUTION-W1: paid-HTTP demand attributed distinctly from MCP demand).
   * `currentCaller()` reads the innermost frame, so the budget sees exactly what it saw before.
   */
  attribute: <T>(served: string, fn: () => Promise<T>) => Promise<T>;
}

const mcpAttribution = <T>(_served: string, fn: () => Promise<T>): Promise<T> => fn();
const x402Attribution = <T>(served: string, fn: () => Promise<T>): Promise<T> => runAsCaller(x402CallerTag(served), fn);

const CHANNEL_POLICY: Record<ChannelId, ChannelPolicy> = {
  mcp: { flag: 'mcp', requestLog: true, agentSession: true, recordInScope: true, logProjection: 'canonical', attribute: mcpAttribution },
  httpX402: { flag: 'httpX402', requestLog: true, agentSession: false, recordInScope: false, logProjection: 'twin', attribute: x402Attribution },
  a2mcp: { flag: 'a2mcp', requestLog: false, agentSession: false, recordInScope: false, logProjection: 'twin', attribute: x402Attribution },
  acp: { flag: 'acp', requestLog: false, agentSession: false, recordInScope: false, logProjection: 'twin', attribute: x402Attribution },
  // The bot and webhook channels never call in-process (they are HTTP clients of /mcp). A declared
  // row beats an exclusion: they record nothing here, exactly like the two deferred rails.
  bot: { flag: 'bot', requestLog: false, agentSession: false, recordInScope: false, logProjection: 'twin', attribute: x402Attribution },
  webhook: { flag: 'webhook', requestLog: false, agentSession: false, recordInScope: false, logProjection: 'twin', attribute: x402Attribution },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tool table — every per-tool fact, exhaustive over the registry
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a tool's `run` returns: the public result, or an in-band refusal (a quota notice …). */
type RunResult =
  | { kind: 'ok'; result: unknown }
  | { kind: 'refused'; payload: Record<string, unknown>; http: { status: number } };

/** Facts read INSIDE the request scope right after dispatch, handed to the log projection. */
interface ScopeSnapshot { regimeFundingDegraded: boolean }

/** The fields a tool adds to the common `request_log` row, per arm. `null` = no row on that arm. */
interface LogFields { asset?: string; timeframe?: string; verdict?: string; confidence?: number; regime?: string | null; exchange?: string }

type Attribute = <T>(served: string, fn: () => Promise<T>) => Promise<T>;
interface ToolRow {
  /**
   * The ONE engine call, wrapped in the tool's OWN literal `runAsCaller('<tool>', …)` (the
   * scripts/check-caller-tags.mjs contract: every caller name is a literal or a registered builder)
   * with the channel's attribution innermost. Defaults are derived exactly once in here (never in a channel).
   */
  run: (input: ValidatedToolInput, license: LicenseInfo, attribute: Attribute, served: string) => Promise<RunResult & { route?: { timeframe: string } }>;
  /** Both arms. Success is called with the result; the error arm with the thrown error. */
  logSuccess: (input: ValidatedToolInput, result: unknown, route: { timeframe: string } | undefined, scope: ScopeSnapshot) => LogFields;
  logError: ((input: ValidatedToolInput, err: unknown) => LogFields) | null;
  /** Write a row when the tool REFUSED in-band? (get_track_record logs its refusal; chat_knowledge does not.) */
  logOnRefusal: boolean;
  /** `upsertAgentSession` when the channel policy allows and a session id exists (4 tools today). */
  cohort: boolean;
  /** Admission: a DEFINED `input.timeframe` outside this set is refused before dispatch (Q-PIPE-2 row 12). */
  timeframes: readonly string[] | null;
  /** Post-step on the result object (the aha / referral hint). Self-guarding; a no-op on paid tiers and sessionless calls. */
  enrich: ((result: unknown, license: LicenseInfo, input: ValidatedToolInput, served: string) => Promise<void>) | null;
  /** MCP `content[1]`: the human receipt / scan digest projected from the SAME result. */
  mcpText: ((result: unknown, input: ValidatedToolInput) => string | null) | null;
  /** The MCP refusal envelope's JSON shape — byte-parity with the handlers that pre-dated the pipeline. */
  refusalJson: 'pretty' | 'compact';
}

const INVALID_TIMEFRAME = 'INVALID_TIMEFRAME';

/** A tool's wall-time clock, started once per call. */
const nowMs = (): number => Date.now();

const TRADE_CALL_ROW: ToolRow = {
  run: async (input, license, attribute, served) => {
    // Q-PIPE-2 rows 1–2 (a): every channel resolves the route ONCE here — `DEFAULT_PERP_TIMEFRAME`
    // (market-route.ts) is the only runtime perp default; the engine's `|| '1h'` is unreachable.
    const dispatch = () => attribute(served, () => routeTradeCall({
      coin: input.coin as string,
      timeframe: input.timeframe as string | undefined,
      includeReasoning: input.includeReasoning as boolean | undefined,
      exchange: input.exchange as ExchangeId | undefined,
      assetClass: input.assetClass as 'perp' | 'equity' | undefined,
      license,
    }));
    // The alias keeps its own caller tag (as the two MCP handlers did). `processScopedTag` emits the
    // bare name from PID 1 — the MCP server — and `name@<entrypoint>` from the ACP worker's standalone
    // entry, which is the caller-tag gate's contract for a lib shared by several entrypoints.
    const { route, result } = served === 'get_trade_signal'
      ? await runAsCaller(processScopedTag('get_trade_signal'), dispatch)
      : await runAsCaller(processScopedTag('get_trade_call'), dispatch);
    return { kind: 'ok', result, route };
  },
  logSuccess: (input, result, route) => ({
    asset: input.coin as string,
    timeframe: route?.timeframe,
    verdict: (result as { call?: 'BUY' | 'SELL' | 'HOLD' }).call,
    confidence: (result as { confidence?: number }).confidence,
  }),
  logError: null,
  logOnRefusal: false,
  cohort: true,
  timeframes: TIMEFRAMES,
  enrich: async (result, license, input, served) => {
    // CONVERSION-MEASUREMENT-W1 C1 / ACTIVATION-NUDGE-W1 / REFERRAL-INPRODUCT-NUDGE-W1 — moved
    // verbatim from the MCP handler. Every predicate below is a no-op for a paid tier and for a
    // call with no session, so on the paid rails this never writes and never mutates.
    const verdict = (result as { call?: 'BUY' | 'SELL' | 'HOLD' }).call;
    const isAha = recordFirstNonHoldVerdict({
      verdict,
      tier: license.tier,
      sessionId: getRequestSessionId(),
      tool: served,
      asset: input.coin as string,
    });
    const ahaMeta = (result as { _algovault?: { upgrade_hint?: string; referral_hint?: ReferralHint } })._algovault;
    if (!ahaMeta) return;
    const refCode = referralCodeForKey(license.key);
    const sid = getRequestSessionId() ?? null;
    let aha: { from: AhaReferralFrom; verdict?: string; callCountUser?: number } | null = null;
    if (refCode && sid && !ahaReferralAlreadyShown(sid)) {
      const conf = (result as { confidence?: number }).confidence ?? 0;
      if (isAha && conf >= AHA_HIGH_CONVICTION_CONFIDENCE && (verdict === 'BUY' || verdict === 'SELL')) {
        aha = { from: 'aha_call', verdict };
      } else {
        const milestone = await recordAhaMilestoneCrossing(license);
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
      ahaMeta.upgrade_hint = buildAhaHint(getTrackRecord());
    }
  },
  mcpText: (result) => {
    const rcpt = result as { _receipts?: Parameters<typeof renderReceiptText>[0]; reasoning?: string };
    return rcpt._receipts ? renderReceiptText(rcpt._receipts, rcpt.reasoning ?? '') : null;
  },
  refusalJson: 'compact',
};

const TOOLS: { readonly [K in CanonicalTool]: ToolRow } = {
  get_trade_call: TRADE_CALL_ROW,
  get_market_regime: {
    run: async (input, license, attribute, served) => ({
      kind: 'ok',
      result: await runAsCaller(processScopedTag('get_market_regime'), () => attribute(served, () => getMarketRegime({
        coin: input.coin as string,
        timeframe: input.timeframe as string,
        exchange: input.exchange as ExchangeId,
        license,
      }))),
    }),
      // OPS-HL-INTERACTIVE-STARVATION-W1 · OPS-ALARM-SINGLE-DERIVATION-W1 CH1: verdict is the CALL
    // OUTCOME (OK · DEGRADED_FUNDING_BUDGET · ERR_<code>) through the ONE regime-request-verdict
    // module; the funding-leg flag is read inside the request scope (ScopeSnapshot).
    logSuccess: (input, result, _route, scope) => ({
      asset: input.coin as string,
      timeframe: input.timeframe as string,
      verdict: regimeSuccessVerdict(scope.regimeFundingDegraded),
      regime: (result as { regime?: string }).regime ?? null,
      exchange: input.exchange as string,
    }),
    logError: (input, err) => ({
      asset: input.coin as string,
      timeframe: input.timeframe as string,
      verdict: regimeErrorVerdict(err),
      regime: null,
      exchange: input.exchange as string,
    }),
    logOnRefusal: false,
    cohort: true,
    timeframes: REGIME_TIMEFRAMES,
    enrich: null,
    mcpText: null,
    refusalJson: 'compact',
  },
  scan_funding_arb: {
    run: async (input, license, attribute, served) => ({
      kind: 'ok',
      result: await runAsCaller(processScopedTag('scan_funding_arb'), () => attribute(served, () => scanFundingArb({ minSpreadBps: input.minSpreadBps as number, limit: input.limit as number, license }))),
    }),
      logSuccess: () => ({}),
    logError: null,
    logOnRefusal: false,
    cohort: true,
    timeframes: null,
    enrich: null,
    mcpText: null,
    refusalJson: 'compact',
  },
  scan_trade_calls: {
    run: async (input, license, attribute, served) => {
      const scan = () => attribute(served, () => runScanTradeCall(
        {
          topN: input.topN as number,
          timeframe: input.timeframe as string,
          exchange: input.exchange as ScanExchangeId,
          minConfidence: input.minConfidence as number | undefined,
          includeHolds: input.includeHolds as boolean,
          limit: input.limit as number,
          // SCAN-RANKBY-W1: forwarded on EVERY channel. Unreachable from the x402 rail today because
          // the frozen Bazaar schema rejects `rankBy` before the gate (Q-PIPE-2 rows 5–8, ruled (b));
          // a later widening is therefore schema-only.
          rankBy: input.rankBy as string | undefined,
          includeReasoning: input.includeReasoning as boolean | undefined,
          oiChangeWindow: input.oiChangeWindow as Parameters<typeof runScanTradeCall>[0]['oiChangeWindow'],
          oiBasis: input.oiBasis as Parameters<typeof runScanTradeCall>[0]['oiBasis'],
          minLiquidityUsd: input.minLiquidityUsd as number | undefined,
        },
        license,
      ));
      // OPS-HL-INTERACTIVE-PRIORITY-W1: a background-priority caller (today: the bot's weekly
      // scan-showcase cron) runs its venue fan-out in the BATCH lane, so it waits for capacity
      // instead of consuming HL's interactive reserve.
      const result = getRequestIsBackground()
        ? await runAsBatch(scan, processScopedTag('scan_trade_calls'))
        : await runAsCaller(processScopedTag('scan_trade_calls'), scan);
      return { kind: 'ok', result };
    },
    logSuccess: (input) => ({ timeframe: input.timeframe as string }),
    logError: null,
    logOnRefusal: false,
    cohort: true,
    timeframes: TIMEFRAMES,
    enrich: null,
    mcpText: (result, input) => {
      const scanRes = result as { calls?: unknown[]; _receipts?: Parameters<typeof renderScanReceiptText>[0] };
      if (input.includeReasoning && Array.isArray(scanRes.calls)) {
        // SCAN-DIGEST-MCP-PARITY-W1 CH1 — digest mode: the enriched digest, NO proof footer.
        const digest = renderScanDigest(
          scanRes.calls as Parameters<typeof renderScanDigest>[0],
          { topN: input.topN as number, timeframe: input.timeframe as string, exchange: input.exchange as string, rankBy: input.rankBy as string | undefined },
        );
        return digest || null;
      }
      // P0 VERDICT-WITH-RECEIPTS-W1: bare mode keeps the proof footer.
      const footer = scanRes._receipts ? renderScanReceiptText(scanRes._receipts) : '';
      return footer || null;
    },
    refusalJson: 'compact',
  },
  get_equity_call: {
    // TRADE-CALL-ROUTING-RESOLVER-W1: default to the equity read ONLY when bare (no venue, no
    // timeframe); a supplied crypto venue/TF routes to perp — resolveMarketRoute is authoritative.
    run: async (input, license, attribute, served) => {
      const exchange = input.exchange as ExchangeId | undefined;
      const timeframe = input.timeframe as string | undefined;
      const assetClass = !exchange && !timeframe ? ('equity' as const) : undefined;
      const { route, result } = await runAsCaller(processScopedTag('get_equity_call'), () => attribute(served, () => routeTradeCall({ coin: input.symbol as string, exchange, timeframe, assetClass, license })));
      return { kind: 'ok', result, route };
    },
      logSuccess: (input) => ({ asset: input.symbol as string }),
    logError: null,
    logOnRefusal: false,
    cohort: false,
    timeframes: TIMEFRAMES,
    enrich: null,
    mcpText: null,
    refusalJson: 'compact',
  },
  get_equity_regime: {
    run: async (input, license, attribute, served) => ({ kind: 'ok', result: await runAsCaller(processScopedTag('get_equity_regime'), () => attribute(served, () => getEquityRegime({ symbol: input.symbol as string | undefined, license }))) }),
      logSuccess: (input) => ({ asset: (input.symbol as string | undefined) ?? 'SPY' }),
    logError: null,
    logOnRefusal: false,
    cohort: false,
    timeframes: null,
    enrich: null,
    mcpText: null,
    refusalJson: 'compact',
  },
  chat_knowledge: {
    // AV-CHAT-MCP-W1 (C3) — moved verbatim from the MCP handler. Quota-gated separately via ChatRateLimit.
    run: async (input, license, attribute, served) => {
      const question = input.question as string;
      const model = input.model as string | undefined;
      const startMs = nowMs();
      const { index, chatEngine, rateLimit, llm } = await getChatStack();
      const tier = chatTierFor(license.tier);
      const quotaKey = chatQuotaApiKey(license.key, getRequestIpHash() ?? null);
      const check = await rateLimit.check(quotaKey, tier);
      if (!check.allowed) {
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
          latencyMs: nowMs() - startMs,
          errorCode: 'CHAT_QUOTA_EXHAUSTED',
        });
        return { kind: 'refused', payload: buildChatQuotaNotice(tier, check) as unknown as Record<string, unknown>, http: { status: 429 } };
      }
      const result = await runAsCaller(processScopedTag('chat_knowledge'), () => attribute(served, () => chatEngine.chat(question, { model } as Parameters<typeof chatEngine.chat>[1])));
      // Record AFTER successful LLM call (rate-limit reflects actual usage)
      await rateLimit.record(quotaKey, result.usage);
      const bundle = index.getBundle();
      const response = formatChatKnowledgeResponse(result, bundle, Math.max(0, check.remaining - 1), license);
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
        latencyMs: nowMs() - startMs,
      });
      return { kind: 'ok', result: response };
    },
      logSuccess: () => ({}),
    logError: null,
    logOnRefusal: false,
    cohort: false,
    timeframes: null,
    enrich: null,
    mcpText: null,
    refusalJson: 'compact',
  },
  search_knowledge: {
    // AV-CHAT-MCP-W1 (C2) — moved verbatim. BM25 lexical retrieval over the KnowledgeBundle.
    run: async (input, license, attribute, served) => {
      const query = input.query as string;
      const limit = input.limit as number | undefined;
      const { index, engine } = await getKnowledgeSearch();
      const results = await runAsCaller(processScopedTag('search_knowledge'), () => attribute(served, () => engine.query(query, limit ?? 10)));
      const bundle = index.getBundle();
      return { kind: 'ok', result: formatSearchKnowledgeResponse(query, results, bundle, license) };
    },
      logSuccess: () => ({}),
    logError: null,
    logOnRefusal: false,
    cohort: false,
    timeframes: null,
    enrich: null,
    mcpText: null,
    refusalJson: 'compact',
  },
  get_track_record: {
    // DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2: refuses in-band (structured payload + isError) rather than throwing.
    run: async (input, _license, attribute, served) => {
      const { payload, isError } = await runAsCaller(processScopedTag('get_track_record'), () => attribute(served, () => runGetTrackRecord({ include: input.include as NonNullable<Parameters<typeof runGetTrackRecord>[0]>['include'] })));
      return isError
        ? { kind: 'refused', payload: payload as unknown as Record<string, unknown>, http: { status: 503 } }
        : { kind: 'ok', result: payload };
    },
      logSuccess: () => ({}),
    logError: null,
    logOnRefusal: true,
    cohort: false,
    timeframes: null,
    enrich: null,
    mcpText: null,
    refusalJson: 'pretty',
  },
  scan_market_regimes: {
    // SCAN-MARKET-REGIMES-W1-V2 CH2: refuses in-band (structured payload + isError) — unbilled — and
    // never throws for an unserved or stale pair. Interactive lane, like scan_trade_calls; a lens or a
    // liquidity floor is the only upstream read, and it reuses that tool's cached lens fetch.
    run: async (input, license, attribute, served) => {
      const out = await runAsCaller(processScopedTag('scan_market_regimes'), () => attribute(served, () => runScanMarketRegimes(
        {
          exchange: input.exchange as PromotedVenueId,
          timeframe: input.timeframe as Parameters<typeof runScanMarketRegimes>[0]['timeframe'],
          regime: input.regime as Parameters<typeof runScanMarketRegimes>[0]['regime'],
          minConfidence: input.minConfidence as number | undefined,
          maxRegimeAgeBars: input.maxRegimeAgeBars as number | undefined,
          assetClass: input.assetClass as Parameters<typeof runScanMarketRegimes>[0]['assetClass'],
          minLiquidityUsd: input.minLiquidityUsd as number | undefined,
          coins: input.coins as string[] | undefined,
          rankBy: input.rankBy as string | undefined,
          topN: input.topN as number | undefined,
          oiChangeWindow: input.oiChangeWindow as Parameters<typeof runScanMarketRegimes>[0]['oiChangeWindow'],
          oiBasis: input.oiBasis as Parameters<typeof runScanMarketRegimes>[0]['oiBasis'],
          sortBy: input.sortBy as Parameters<typeof runScanMarketRegimes>[0]['sortBy'],
          limit: input.limit as number | undefined,
          offset: input.offset as number | undefined,
        },
        license,
      )));
      return out.kind === 'ok'
        ? { kind: 'ok', result: out.response }
        : { kind: 'refused', payload: out.payload as unknown as Record<string, unknown>, http: { status: out.status } };
    },
    logSuccess: (input) => ({ timeframe: input.timeframe as string, exchange: input.exchange as string }),
    logError: null,
    logOnRefusal: false,
    cohort: false,
    timeframes: REGIME_TIMEFRAMES,
    enrich: null,
    mcpText: null,
    refusalJson: 'compact',
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// callTool — the one path
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function callTool(req: ToolCallRequest): Promise<ToolCallOutcome> {
  const feature = getFeature(req.tool);
  if (!feature) throw new Error(`[tool-call-pipeline] unknown tool "${req.tool}" — not in FEATURE_REGISTRY`);
  const row = TOOLS[feature.name as CanonicalTool];
  const policy = CHANNEL_POLICY[req.channel];
  if (!feature.channels[policy.flag]) {
    throw new Error(`[tool-call-pipeline] "${req.tool}" is not declared on channel "${req.channel}" (FEATURE_REGISTRY.channels)`);
  }
  const { license, input } = req;
  const startMs = nowMs();

  // One run of the stages inside the request scope. The caller either hands us a ctx (the HTTP rails)
  // or has already installed one (the /mcp POST layer; stdio has none and the accessors default).
  const inScope = async (): Promise<{ outcome: ToolCallOutcome; log: LogFields | null; sessionId?: string; ipHash?: string; source?: string }> => {
    // Admission (Q-PIPE-2 row 12): a DEFINED timeframe the tool's enum does not serve is refused here.
    const tf = input.timeframe;
    if (row.timeframes && typeof tf === 'string' && !row.timeframes.includes(tf)) {
      return {
        outcome: {
          ok: false, kind: 'refused', tool: req.tool, input, mcpIsError: true, http: { status: 400 },
          payload: {
            error: 'invalid_input',
            code: INVALID_TIMEFRAME,
            message: `timeframe '${tf}' is not served for ${req.tool}.`,
            valid_timeframes: [...row.timeframes],
            suggested_action: `Pass one of: ${row.timeframes.join(', ')} (or omit for the default).`,
          },
        },
        log: null,
      };
    }
    try {
      const r = await row.run(input, license, policy.attribute, req.tool);
      const scope: ScopeSnapshot = { regimeFundingDegraded: getRequestRegimeFundingDegraded() };
      const ids = { sessionId: getRequestSessionId(), ipHash: getRequestIpHash(), source: getRequestSource() };
      if (r.kind === 'refused') {
        return { outcome: { ok: false, kind: 'refused', tool: req.tool, input, payload: r.payload, http: r.http, mcpIsError: true }, log: row.logOnRefusal ? {} : null, ...ids };
      }
      if (row.enrich) await row.enrich(r.result, license, input, req.tool);
      return { outcome: { ok: true, tool: req.tool, input, result: r.result }, log: row.logSuccess(input, r.result, r.route, scope), ...ids };
    } catch (err: unknown) {
      return { outcome: { ok: false, kind: 'threw', tool: req.tool, input, error: err }, log: row.logError ? row.logError(input, err) : null, sessionId: getRequestSessionId(), ipHash: getRequestIpHash(), source: getRequestSource() };
    }
  };

  const ran = req.ctx
    ? await requestContext.run({ ...req.ctx, license } as RequestContext, inScope)
    : await inScope();

  // Record — row- and column-exact per channel (R-6 / Q-PIPE-1 condition 3).
  if (policy.requestLog && ran.log) {
    const responseTimeMs = nowMs() - startMs;
    const common = { toolName: req.tool, licenseTier: license.tier, responseTimeMs, isBotInternal: license.tier === 'internal' };
    const emit = () => {
      try {
        if (policy.logProjection === 'canonical') {
          logRequest({ sessionId: ran.sessionId, ...common, ...ran.log, ipHash: ran.ipHash });
        } else {
          // The x402 twin's field set, exactly: asset/timeframe straight from the (gate-defaulted)
          // input, verdict/regime/exchange when the tool has them, NO confidence, explicit session,
          // ip hash and automation flag from the ctx — never the scope's HOLD capture or user agent.
          const twin: LogFields = {};
          if (typeof input.coin === 'string') twin.asset = input.coin;
          if (typeof input.timeframe === 'string') twin.timeframe = input.timeframe;
          if (ran.log?.verdict !== undefined) twin.verdict = ran.log.verdict;
          if (ran.log && 'regime' in ran.log) twin.regime = ran.log.regime;
          if (ran.log?.exchange !== undefined) twin.exchange = ran.log.exchange;
          logRequest({ sessionId: req.ctx?.sessionId, ...common, ...twin, ipHash: req.ctx?.ipHash, isAutomated: req.ctx?.isAutomated });
        }
      } catch { /* best-effort; never blocks the call */ }
    };
    if (policy.recordInScope && req.ctx) await requestContext.run({ ...req.ctx, license } as RequestContext, async () => emit());
    else emit();
  }
  if (policy.agentSession && row.cohort && ran.outcome.ok && ran.sessionId) {
    upsertAgentSession({
      sessionId: ran.sessionId,
      tool: req.tool,
      tier: license.tier,
      ipHash: ran.ipHash ?? null,
      source: ran.source ?? null,
    }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
  }
  return ran.outcome;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// toMcpToolResult — the MCP envelope, projected from the outcome
// ─────────────────────────────────────────────────────────────────────────────────────────────

type McpToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

export function toMcpToolResult(o: ToolCallOutcome): McpToolResult {
  const row = TOOLS[(getFeature(o.tool)?.name ?? o.tool) as CanonicalTool];
  if (o.ok) {
    const content: { type: 'text'; text: string }[] = [{ type: 'text' as const, text: JSON.stringify(o.result, null, 2) }];
    const extra = row?.mcpText ? row.mcpText(o.result, o.input) : null;
    if (extra) content.push({ type: 'text' as const, text: extra });
    return { content };
  }
  if (o.kind === 'refused') {
    const text = row?.refusalJson === 'pretty' ? JSON.stringify(o.payload, null, 2) : JSON.stringify(o.payload);
    return { content: [{ type: 'text' as const, text }], isError: true };
  }
  return toolErrorContent(o.error);
}

/** The typed-error → MCP payload map — moved verbatim from `src/index.ts`. */
function toolErrorContent(err: unknown): McpToolResult & { isError: true } {
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
    // FUNNEL-FIX-AGENT-X402-NUDGE-W1: additive `suggested_x402` in-protocol pay-per-call branch,
    // derived from the feature-registry channels{} SoT + live rail predicates; omitted when
    // X402_NUDGE_ENABLED is off, no public rail is live, or the tool is HELD.
    const suggestedX402 = isX402NudgeEnabled() && err.tool ? buildSuggestedX402(err.tool, err.limit) : undefined;
    const payload = buildTierLimitPayload(err, { suggestedX402 });
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  if (err instanceof InsufficientCandlesError) {
    const payload = buildInsufficientCandlesPayload(err);
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  if (err instanceof StaleUpstreamWindowError) {
    // OPS-SERVED-CANDLE-TRUTH-W1 CH1: the getAdapter seam refused a stale serving window (src/lib/exchange-adapter.ts).
    const payload = buildStaleUpstreamWindowPayload(err);
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  if (err instanceof TimeframeUnservedError) {
    // OPS-SERVED-CANDLE-TRUTH-W1 CH2: the venue does not serve the timeframe (refused before any request).
    const payload = buildTimeframeUnservedPayload(err);
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}
