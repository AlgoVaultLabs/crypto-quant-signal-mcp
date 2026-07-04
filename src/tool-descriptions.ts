/**
 * Tool description constants — generator-level SoT for MCP `tools/list` copy.
 *
 * Hoisted into a pure-data module so the
 * tests/unit/tool-description-keywords.test.ts canary can import without
 * triggering src/index.ts's bottom-of-file `startHttp()` / `startStdio()`
 * bootstrap.
 *
 * TDQS-optimized (GEO-REGISTRY-RANK-TDQS-W1, 2026-06-17). Each description
 * satisfies Glama's six Tool-Definition-Quality dimensions: purpose clarity
 * (first sentence states what the tool RETURNS), usage guidelines (use-when +
 * do-NOT-use-when → sibling tool), behavioral transparency (read-only, live
 * external APIs, no side effects), parameter semantics (type + units + allowed
 * values + example), conciseness (no marketing padding), and contextual
 * completeness (callable with zero external lookup).
 *
 * Forward-stability rule (retires the stale-registry-listing bug class):
 * capability is described QUALITATIVELY — NEVER a hardcoded exchange/asset/
 * venue/timeframe count or win-rate %. tests/unit/tool-description-forward-
 * stability.test.ts fails CI on any such count.
 *
 * The 3 BM25-audited tools (get_trade_call, scan_funding_arb, get_market_regime)
 * still preserve ≥15-of-20 routing/discovery keyword phrases over combined
 * tool+param text and the length budget (desc ≤350 chars; param ≤80 chars) —
 * locked by tool-description-keywords.test.ts. Brand-voice + internal-detail
 * forbidden phrases are locked by the same canary. Public copy follows
 * `feedback_public_copy_professional_concise.md` +
 * `feedback_no_internal_details_in_public_copy.md`.
 */

// get_trade_call (canonical, v1.10.0) + get_trade_signal (alias) share
// TRADE_CALL_DESCRIPTION; the alias appends TRADE_CALL_ALIAS_SUFFIX.
export const TRADE_CALL_DESCRIPTION =
  'Returns a composite verdict — BUY SELL HOLD trade call with confidence and market regime — for one crypto or tokenized-stock perpetual futures. One asset only; for a whole-market scan use scan_trade_calls, for US stocks use get_equity_call. Read-only: reads live exchange APIs, no orders. Verified track record, on-chain verified merkle anchor.';

// KNOWLEDGE-ARTIFACT-W1 (Q-5, 2026-05-18): suffix literal uses the [ALIAS] tag
// prefix pattern so future tool aliases follow the same shape.
export const TRADE_CALL_ALIAS_SUFFIX =
  ' [ALIAS] This tool is an alias of get_trade_call — same behavior, kept for backward compatibility.';

export const SCAN_FUNDING_ARB_DESCRIPTION =
  'Returns ranked cross-venue funding arbitrage across crypto perpetual futures on 7 venues — Hyperliquid Binance Bybit Gate KuCoin Aster OKX — funding rate spreads annualized per venue funding interval, with a per-leg liquidity filter so only tradeable spreads surface, long one venue short another, as a BUY SELL HOLD composite verdict per pair. For a directional trade call use get_trade_call. Read-only, no orders. Verified track record, on-chain verified merkle anchor.';

export const GET_MARKET_REGIME_DESCRIPTION =
  'Returns the market regime — TRENDING_UP TRENDING_DOWN RANGING VOLATILE — with confidence and a strategy hint, for one crypto perpetual futures. Composite verdict blends trend ranging and cross-venue funding rate sentiment. For a US equity use get_equity_regime. Read-only, live exchange APIs. Verified track record, on-chain verified merkle anchor.';

// describe-text for the `search_knowledge` MCP tool. Self-pitching text
// intentionally instructs the calling LLM to call it BEFORE other tools to
// confirm parameter usage. Excluded from the TOP_20_KEYWORDS coverage canary —
// it covers meta-search over the knowledge bundle, not the 3 trading tools.
export const SEARCH_KNOWLEDGE_DESCRIPTION =
  'Returns ranked snippets from the AlgoVault knowledge bundle answering a question about its MCP tools, response shapes, integration patterns (LangChain, LlamaIndex, MAF, CrewAI), or code examples. Call this BEFORE other tool calls to confirm parameter usage and avoid hallucinating tool shapes. Fast: BM25 lexical search, no LLM call, no quota cost. For a synthesized natural-language answer use chat_knowledge. Read-only, no side effects.';

// describe-text for the `chat_knowledge` MCP tool. LLM-synthesized answer with
// citations grounded in the canonical knowledge bundle. Quota-gated separately
// from trading-tool quotas. Excluded from the TOP_20_KEYWORDS coverage canary.
export const CHAT_KNOWLEDGE_DESCRIPTION =
  'Returns a synthesized natural-language answer with citations, grounded in the AlgoVault knowledge bundle (every MCP tool description, response shape, integration tutorial, and code example). Use when you need an explanation, code pattern, or how-to; for raw ranked snippets without LLM synthesis use search_knowledge (faster, no quota cost). Read-only: calls an LLM, no other side effects. Quota: Free 10/month, Starter 50, Pro 200, Enterprise 2000.';

// describe-text for the `scan_trade_calls` MCP tool. Not part of the
// TOP_20_KEYWORDS canary set (like search/chat_knowledge).
export const SCAN_TRADE_CALLS_DESCRIPTION =
  'Returns ranked BUY SELL HOLD trade calls across the top crypto perpetual futures by open interest — one scan for whole-market coverage, each with confidence and market regime. Use this for breadth; use get_trade_call for per-coin depth and reasoning. Read-only: reads live exchange APIs, places no orders.';

// FEATURE-REGISTRY-SOT-W1 CH1: equity descriptions live here (the registry
// references the same source as the index.ts tools/list registration).
export const GET_EQUITY_CALL_DESCRIPTION =
  'Returns a daily-bar BUY/SELL/HOLD trade call for a US stock or ETF — verdict, confidence, market regime, and the technical factors behind it — from Databento EQUS.MINI daily bars. Universe = top US equities by dollar-volume plus index and crypto-proxy ETFs (SPY, QQQ, IBIT); an out-of-universe ticker returns a structured SYMBOL_NOT_IN_UNIVERSE error with nearest-symbol suggestions (accepts BRK-B or BRK.B). Defaults to the stock read; naming a crypto exchange or timeframe routes to the perpetual-futures call instead — for crypto or tokenized-stock perps, use get_trade_call. Read-only: reads a live market-data API, places no orders.';
export const GET_EQUITY_REGIME_DESCRIPTION =
  'Returns the market regime for a US stock or ETF — trending_up, trending_down, compression, or ranging, with a confidence score — derived from daily-bar trend strength (ADX/DI), persistence (Hurst), and volatility compression. Defaults to SPY. For a crypto regime use get_market_regime instead. Read-only: reads a live market-data API.';

// Param describe() strings — type + units + allowed values + example; ≤80 chars
// each for the 3 BM25-audited tools (length-locked by the keyword canary).
export const PARAM_DESC_TRADE_CALL_COIN =
  'Base asset, e.g. BTC ETH SOL signal, or a US stock/ETF ticker (no USDT).';
export const PARAM_DESC_TRADE_CALL_TIMEFRAME =
  'Candle timeframe, 1m to 1d. Default 15m. Crypto quant intraday horizon.';
export const PARAM_DESC_TRADE_CALL_INCLUDE_REASONING =
  'Include reasoning: trend ranging crypto signal and market regime drivers.';
export const PARAM_DESC_TRADE_CALL_EXCHANGE =
  'Crypto venue (default Binance), e.g. Binance Bybit OKX Bitget Hyperliquid.';
export const PARAM_DESC_TRADE_CALL_ASSET_CLASS =
  "Force engine: 'perp' or 'equity'. Cross-venue multi-exchange AI trading signal.";
export const PARAM_DESC_FUNDING_MIN_SPREAD_BPS =
  'Minimum funding rate spread in bps. Cross-venue multi-exchange crypto signal.';
export const PARAM_DESC_FUNDING_LIMIT =
  'Max ranked results, e.g. 5 (free tier cap). Crypto quant AI trading signal.';
export const PARAM_DESC_REGIME_COIN =
  'Base asset crypto signal, e.g. BTC ETH SOL signal. Crypto quant regime.';
export const PARAM_DESC_REGIME_TIMEFRAME =
  'Candle timeframe, e.g. 1h 4h 1d. Buy sell hold AI trading signal context.';
export const PARAM_DESC_REGIME_EXCHANGE =
  'Crypto venue, e.g. Binance Bybit OKX Bitget Hyperliquid. Multi-exchange.';
// scan_trade_calls param describe() strings.
export const PARAM_DESC_SCAN_TOP_N =
  'How many top perps by open interest to scan, 1 to 100 (default 20).';
export const PARAM_DESC_SCAN_TIMEFRAME =
  'Candle timeframe, 1m to 1d for the scan. Default 15m intraday.';
export const PARAM_DESC_SCAN_EXCHANGE =
  'Venue: BINANCE (default) HL BYBIT OKX BITGET.';
export const PARAM_DESC_SCAN_MIN_CONFIDENCE =
  'Optional confidence floor, 0 to 100, applied to non-HOLD trade calls.';
export const PARAM_DESC_SCAN_INCLUDE_HOLDS =
  'Include HOLD calls after non-HOLD (default false). HOLDs never cost quota.';
export const PARAM_DESC_SCAN_LIMIT =
  'Max ranked calls to return, 1 to 100 (default 10). Non-HOLD ranked first.';
// SCAN-RANKBY-W1: universe-selection lens (default oi). funding_* rank among the
// most-liquid perps. NB: not in the BM25 keyword canary (scan is not audited).
export const PARAM_DESC_SCAN_RANK_BY =
  'Universe lens: oi (default) volume gainers losers movers funding_positive funding_negative volatility oi_change ' +
  '(aliases vol gain lose move pfr nfr atr oid). funding_*/volatility/oi_change rank among the most-liquid perps; ' +
  'oi_change = real 24h open-interest %Δ.';
// SCAN-DIGEST-MCP-PARITY-W1: opt-in per-call enrichment (default false ⇒ bare
// verdict cells, byte-identical). Orthogonal to rankBy — compose them.
export const PARAM_DESC_SCAN_INCLUDE_REASONING =
  'Enrich each non-HOLD call with price, the top 2-3 drivers, and one-line reasoning ' +
  '(default false → bare verdict cells). HOLDs stay bare. Same per-call detail as get_trade_call.';
// SCAN-RANKBY-REFINEMENTS-W1 CH1: OI-delta window for the oi_change lens.
export const PARAM_DESC_SCAN_OI_CHANGE_WINDOW =
  'OI-delta window for rankBy=oi_change: 1h, 4h, or 24h (default 24h). Ignored by other lenses.';
// SCAN-RANKBY-REFINEMENTS-W1 CH3: OI-delta basis for the oi_change lens.
export const PARAM_DESC_SCAN_OI_BASIS =
  'OI-delta basis for rankBy=oi_change: notional (default, USD) or contracts (base-coin, price-independent). Ignored by other lenses.';

// Top-20 keyword phrases the canary asserts each of the 3 BM25-audited tools'
// combined-text contains ≥15 of (case-insensitive substring match). Sourced
// from observed AI-agent-builder search vocabulary + the Anthropic Tool Search
// docs (regex + BM25 over name + description + arg-name + arg-description).
// LOCKED as the single source of truth — any change requires a separate
// spec-time decision.
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
