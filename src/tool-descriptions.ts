/**
 * Tool description constants — TOOL-DESC-AUDIT-W1 (2026-05-16).
 *
 * Hoisted into a pure-data module so the
 * tests/unit/tool-description-keywords.test.ts canary can import without
 * triggering src/index.ts's bottom-of-file `startHttp()` / `startStdio()`
 * bootstrap.
 *
 * Rewritten for Anthropic Tool Search regex + BM25 retrieval ranking against
 * `tools/list` name + description + arg-name + arg-description. Coverage
 * target: ≥15-of-20 keyword phrases per tool's combined-text (tool
 * description + sum of registered param describe() strings). Length budget:
 * tool descriptions ≤350 chars; param descriptions ≤80 chars.
 *
 * Brand-voice + internal-detail forbidden phrases are locked by the canary.
 * Public copy follows `feedback_public_copy_professional_concise.md` +
 * `feedback_no_internal_details_in_public_copy.md`.
 */

// get_trade_call (canonical, v1.10.0) + get_trade_signal (alias) share
// TRADE_CALL_DESCRIPTION; the alias appends TRADE_CALL_ALIAS_SUFFIX.
export const TRADE_CALL_DESCRIPTION =
  'Composite verdict BUY SELL HOLD trade call. Name a crypto exchange (Binance Bybit OKX Bitget Hyperliquid — default Binance) or a timeframe (default 15m) for crypto or tokenized-stock perpetual futures; pass only a US stock or ETF ticker for a daily-bar stock read. Returns market regime. Verified track record, on-chain verified merkle anchor.';

// KNOWLEDGE-ARTIFACT-W1 (Q-5, 2026-05-18): suffix literal updated to use the
// [ALIAS] tag prefix pattern so future tool aliases follow the same shape.
// Public MCP tools/list output for get_trade_signal changes — cache-refresh
// notice shipped in CHANGELOG.md + README.md "What's new in v1.14.1".
export const TRADE_CALL_ALIAS_SUFFIX =
  ' [ALIAS] This tool is an alias of get_trade_call — same behavior, kept for backward compatibility.';

export const SCAN_FUNDING_ARB_DESCRIPTION =
  'Cross-venue funding arbitrage scanner. Funding rate spreads across Binance Bybit OKX Bitget Hyperliquid perpetual futures — long one, short other. Composite verdict, multi-exchange funding intelligence. MCP tool for trading. AI trading signal for crypto quant + Claude trading agents. Verified track record, on-chain verified merkle anchor on Base.';

export const GET_MARKET_REGIME_DESCRIPTION =
  'Market regime classifier — TRENDING_UP TRENDING_DOWN RANGING VOLATILE — for crypto perpetual futures on Binance Bybit OKX Bitget Hyperliquid. Composite verdict blends trend ranging signals, volatility, cross-venue funding rate sentiment. Returns label, confidence, strategy hint. MCP tool for trading. Verified track record, merkle anchor on Base.';

// AV-CHAT-MCP-W1 (C2, 2026-05-18) — describe-text for the `search_knowledge`
// MCP tool. Locked verbatim per spec L169. Self-pitching describe-text
// intentionally reads as an instruction to the calling LLM agent ("Use this
// BEFORE attempting any tool call to confirm correct parameter usage and
// avoid hallucinating tool shapes"). Excluded from TOP_20_KEYWORDS coverage
// canary — this tool covers a different concern (meta-search over the
// knowledge bundle) than the 3 trading tools.
export const SEARCH_KNOWLEDGE_DESCRIPTION =
  'Ask AlgoVault any question about its MCP tools, response shapes, integration patterns (LangChain / LlamaIndex / MAF / CrewAI), or code examples. Returns ranked snippets from the canonical knowledge bundle. Use this BEFORE attempting any tool call to confirm correct parameter usage and avoid hallucinating tool shapes. Fast (BM25 lexical search, no LLM call, no quota cost). For natural-language synthesized answers, use chat_knowledge instead.';

// AV-CHAT-MCP-W1 (C3, 2026-05-18) — describe-text for the `chat_knowledge`
// MCP tool. Locked verbatim per spec L264-266. LLM-synthesized answer with
// citations grounded in the canonical knowledge bundle. Quota-gated separately
// from trading-tool quotas (Free 10/mo, Starter 50/mo, Pro 200/mo, Enterprise
// 2000/mo). Excluded from TOP_20_KEYWORDS coverage canary.
export const CHAT_KNOWLEDGE_DESCRIPTION =
  'Ask AlgoVault a natural-language question — get a synthesized answer with citations, grounded in the canonical knowledge bundle (every MCP tool description, response shape, integration tutorial, and code example). Use this when you need an explanation, code pattern, or "how do I" answer. For raw ranked snippets without LLM synthesis, use search_knowledge (faster, no quota cost). Quota: Free 10/month, Starter 50/month, Pro 200/month, Enterprise 2000/month.';

// SCAN-TRADE-CALLS-W1 (C3) — describe-text for the `scan_trade_calls` MCP tool.
// Pre-approved verbatim (numerical-citation LAW: the only figures are the topN
// parameter range "1-100", a capability bound, not a track-record claim).
// Not part of the TOP_20_KEYWORDS canary set (like search/chat_knowledge).
export const SCAN_TRADE_CALLS_DESCRIPTION =
  'Cross-asset market scanner — composite verdict BUY SELL HOLD trade calls across the top 1-100 crypto perpetual futures by open interest on Binance Bybit OKX Bitget Hyperliquid. Returns ranked non-HOLD calls with confidence and market regime. One scan, whole-market coverage for AI trading agents. Use get_trade_call for per-coin depth and reasoning.';

// FEATURE-REGISTRY-SOT-W1 CH1: equity descriptions relocated here (verbatim) from the
// index.ts inline consts so the feature registry can reference them. index.ts imports
// these + drops its inline copies in CH2 (single source for both tools/list + /capabilities).
export const GET_EQUITY_CALL_DESCRIPTION =
  'Daily-bar trade call (BUY/SELL/HOLD) for a US stock or ETF, from Databento EQUS.MINI daily bars, ' +
  'with confidence, market regime, and the technical factors that drove it. Universe = top US equities ' +
  'by dollar-volume plus index and crypto-proxy ETFs (SPY, QQQ, IBIT, …); out-of-universe tickers return ' +
  'a structured SYMBOL_NOT_IN_UNIVERSE error with nearest-symbol suggestions (accepts BRK-B or BRK.B). ' +
  'Defaults to the stock read; passing a crypto exchange or timeframe routes to the perpetual-futures ' +
  'call instead. For crypto or tokenized-stock perps, prefer get_trade_call.';
export const GET_EQUITY_REGIME_DESCRIPTION =
  'Market regime for a US equity or ETF (defaults to SPY): trending_up, trending_down, ' +
  'compression, or ranging, with a confidence score. Derived from daily-bar trend strength ' +
  '(ADX/DI), persistence (Hurst), and volatility compression.';

// Param describe() strings — ≤80 chars each.
export const PARAM_DESC_TRADE_CALL_COIN =
  'Ticker — crypto signal (BTC ETH SOL signal) or a US stock/ETF ticker.';
export const PARAM_DESC_TRADE_CALL_TIMEFRAME =
  'Candle timeframe (1m to 1d) for crypto quant agents. Default 15m intraday.';
export const PARAM_DESC_TRADE_CALL_INCLUDE_REASONING =
  'Include reasoning for the trade call verdict (regime, trend ranging signals).';
export const PARAM_DESC_TRADE_CALL_EXCHANGE =
  'Crypto venue, default Binance — cross-venue multi-exchange perp routing.';
export const PARAM_DESC_TRADE_CALL_ASSET_CLASS =
  "Force engine: 'perp' or 'equity'. MCP tool for trading — AI trading signal.";
export const PARAM_DESC_FUNDING_MIN_SPREAD_BPS =
  'Minimum funding rate spread (bps) for buy sell hold trade call cross-venue scan.';
export const PARAM_DESC_FUNDING_LIMIT =
  'Max funding arbitrage results returned (free tier cap 5). Crypto signal query.';
export const PARAM_DESC_REGIME_COIN =
  'Asset symbol — BTC ETH SOL signal. Crypto quant trade call classification.';
export const PARAM_DESC_REGIME_TIMEFRAME =
  'Candle timeframe — 1h 4h 1d. Buy sell hold regime context for AI trading signal.';
export const PARAM_DESC_REGIME_EXCHANGE =
  'Exchange BINANCE HL BYBIT OKX BITGET. Multi-exchange Claude trading agent.';
// SCAN-TRADE-CALLS-W1 (C3) — scan_trade_calls param describe() strings (≤80 chars).
export const PARAM_DESC_SCAN_TOP_N =
  'Scan the top-N perps by open interest (1-100, default 20). Whole-market scan.';
export const PARAM_DESC_SCAN_TIMEFRAME =
  'Candle timeframe (1m to 1d) for the scan. Default 15m intraday.';
export const PARAM_DESC_SCAN_EXCHANGE =
  'Venue: BINANCE (default) HL BYBIT OKX BITGET — top perps by open interest.';
export const PARAM_DESC_SCAN_MIN_CONFIDENCE =
  'Optional min confidence (0-100) filter applied to non-HOLD trade calls.';
export const PARAM_DESC_SCAN_INCLUDE_HOLDS =
  'Include HOLD calls after non-HOLD (default false). HOLDs never cost quota.';
export const PARAM_DESC_SCAN_LIMIT =
  'Max ranked calls returned (1-100, default 10). Non-HOLD ranked first.';

// Top-20 keyword phrases the canary asserts each tool's combined-text contains
// ≥15 of (case-insensitive substring match). Sourced from observed AI-agent-
// builder search vocabulary and the Anthropic Tool Search docs (regex + BM25
// over name + description + arg-name + arg-description). Locked here as the
// single source of truth — any change requires a separate spec-time decision.
export const TOP_20_KEYWORDS = [
  'crypto signal',
  'trade call',
  'buy sell hold',
  'funding arbitrage',
  'funding rate',
  'market regime',
  'trend ranging',
  'cross-venue',
  'multi-exchange',
  'composite verdict',
  'verified track record',
  'merkle anchor',
  'Binance Bybit OKX Bitget Hyperliquid',
  'MCP tool for trading',
  'Claude trading agent',
  'AI trading signal',
  'crypto quant',
  'perpetual futures',
  'BTC ETH SOL signal',
  'on-chain verified',
] as const;
