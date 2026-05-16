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
  'Composite verdict BUY SELL HOLD trade call for crypto perpetual futures on Binance Bybit OKX Bitget Hyperliquid. Returns verdict, confidence, market regime, funding rate, reasoning. Verified track record, merkle anchor on Base — on-chain verified. MCP tool for trading. Cross-venue multi-exchange AI trading signal for Claude trading agents.';

export const TRADE_CALL_ALIAS_SUFFIX =
  ' (Alias for `get_trade_call` since v1.10.0; identical behavior. New agents should call `get_trade_call`.)';

export const SCAN_FUNDING_ARB_DESCRIPTION =
  'Cross-venue funding arbitrage scanner. Funding rate spreads across Binance Bybit OKX Bitget Hyperliquid perpetual futures — long one, short other. Composite verdict, multi-exchange funding intelligence. MCP tool for trading. AI trading signal for crypto quant + Claude trading agents. Verified track record, on-chain verified merkle anchor on Base.';

export const GET_MARKET_REGIME_DESCRIPTION =
  'Market regime classifier — TRENDING_UP TRENDING_DOWN RANGING VOLATILE — for crypto perpetual futures on Binance Bybit OKX Bitget Hyperliquid. Composite verdict blends trend ranging signals, volatility, cross-venue funding rate sentiment. Returns label, confidence, strategy hint. MCP tool for trading. Verified track record, merkle anchor on Base.';

// Param describe() strings — ≤80 chars each.
export const PARAM_DESC_TRADE_CALL_COIN =
  'Asset — BTC ETH SOL signal for crypto perpetual futures or TradFi symbol.';
export const PARAM_DESC_TRADE_CALL_TIMEFRAME =
  'Candle timeframe (1m to 1d) for crypto quant agents. Default 15m intraday.';
export const PARAM_DESC_TRADE_CALL_INCLUDE_REASONING =
  'Include reasoning for the trade call verdict (regime, trend ranging signals).';
export const PARAM_DESC_TRADE_CALL_EXCHANGE =
  "Exchange — 'BINANCE' = Binance USDT-M Futures (default), HL/BYBIT/OKX/BITGET.";
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
