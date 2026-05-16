# TOOL-DESC-AUDIT-W1 — R2 baseline audit (2026-05-16)

Captured BEFORE any rewrite. Sources: live `src/index.ts` (Code's checkout at `/Users/tank/crypto-quant-signal-mcp/`, HEAD `b760af1`) + live `tools/list` response from `https://api.algovault.com/mcp` (persisted to `audits/tool-desc-audit-w1-baseline-tools-list-2026-05-16.json`).

---

## Current source-of-truth descriptions

### `TRADE_CALL_DESCRIPTION` (covers `get_trade_call` + `get_trade_signal` alias)

Location: `src/index.ts:113` — `const TRADE_CALL_DESCRIPTION = "..."` (module-scope-local to `createServer()`, NOT exported).

```
Returns a composite BUY/SELL/HOLD trade call for a perpetual on Binance / Hyperliquid / Bybit / OKX / Bitget. Combines RSI(14), EMA(9/21) crossover, funding rate, OI momentum, and volume into a weighted score with confidence percentage.
```
Length: 236 chars. Alias appends ` (Alias for \`get_trade_call\` since v1.10.0; identical behavior. New agents should call \`get_trade_call\`.)` (+ 105 chars → 341 total).

### `scan_funding_arb` description

Location: `src/index.ts:174` — inline arg to `server.tool(...)`.

```
Scans cross-venue funding rate differences between Hyperliquid, Binance, and Bybit. Returns top arbitrage opportunities ranked by annualized spread.
```
Length: 148 chars.

### `get_market_regime` description

Location: `src/index.ts:217` — inline arg.

```
Classifies the current market regime (TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE) for a Hyperliquid perp using ADX(14), volatility ratio, price structure, and cross-venue funding sentiment.
```
Length: 192 chars. **Stale claim flagged**: "for a Hyperliquid perp" — actually supports 5+2 venues via the `exchange` enum.

---

## Current param `describe()` strings

| Tool | Param | Current `describe()` (length) |
|---|---|---|
| get_trade_call | `coin` | `Asset symbol, e.g. 'ETH', 'BTC', 'SOL'` (38) |
| get_trade_call | `timeframe` | `Candle timeframe. 1m/3m for HFT scalping, 5m/15m for intraday agents (most popular), 30m/1h/2h for swing, 4h/8h/12h/1d for position trading. Free tier: all 11 timeframes available, 100 calls/month.` (~200) |
| get_trade_call | `includeReasoning` | `Include human-readable reasoning` (32) |
| get_trade_call | `exchange` | `Exchange to analyze. 'BINANCE' = Binance USDT-M Futures (default), 'HL' = Hyperliquid, 'BYBIT' = Bybit Linear, 'OKX' = OKX Swap, 'BITGET' = Bitget USDT-M, 'ASTER' = Aster BNB-Chain perp DEX (shadow — experimental), 'EDGEX' = edgeX L2 zk-rollup perp DEX (shadow — experimental). Shadow venues (experimental, not yet on public dashboard) require explicit exchange param; query the mcp://algovault/venues resource for the live per-venue status table. Asset availability varies per venue — pass exchange explicitly to target a specific venue.` (~558) |
| scan_funding_arb | `minSpreadBps` | `Minimum spread in basis points to include (0-10000)` (52) |
| scan_funding_arb | `limit` | `Max results 1-200 (free: max 5)` (31) |
| get_market_regime | `coin` | `Asset symbol, e.g. 'BTC', 'ETH', 'SOL'` (38) |
| get_market_regime | `timeframe` | `Candle timeframe` (16) |
| get_market_regime | `exchange` | `Exchange to analyze. 'HL' = Hyperliquid (default), 'BINANCE' = Binance USDT-M Futures, 'BYBIT' = Bybit Linear, 'OKX' = OKX Swap, 'BITGET' = Bitget USDT-M, 'ASTER' = Aster BNB-Chain perp DEX (shadow — experimental), 'EDGEX' = edgeX L2 zk-rollup perp DEX (shadow — experimental). Shadow venues (experimental, not yet on public dashboard) require explicit exchange param; query the mcp://algovault/venues resource for the live per-venue status table.` (~447) |

Several current param descriptions violate the new ≤80-char budget — material rewrite required.

---

## TOP-20 keyword lock

Adopted verbatim from spec R2 (no swaps). Rationale: spec list aligns with AI-agent-builder search vocabulary observed in the [Anthropic Tool Search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) (regex + BM25 retrieval over name + description + arg-name + arg-description) and the [Arcade benchmark](https://blog.arcade.dev/anthropic-tool-search-claude-mcp-runtime) (56% regex / 64% BM25 at 4,027 tools — keyword tightness compounds with catalog growth).

```ts
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
```

No swaps applied this wave. Coverage target: ≥15-of-20 per tool's combined-text (tool description + sum of its registered param `describe()` strings).

---

## Forbidden-phrase set (canary)

### Brand-voice forbidden (`feedback_public_copy_professional_concise.md`)
`/intelligence layer|powerful|seamless|robust|cutting-edge|industry-leading|Quant LLM|Wall Street Quant Brain/i`

### Internal-detail forbidden (`feedback_no_internal_details_in_public_copy.md`)
`/[A-Z]+-W\d+|Binance-clone|custom L2 envelope|archetype [ABC]|shadow signal production|4h funding cadence|8h funding period|outcome_return_pct|phase_e_/i`

Both canaries apply to **every** tool's combined-text (description + param `describe()`s) post-rewrite.

---

## Length budget

- Tool description: **≤350 chars** (regex retrieval ranks shorter strings faster; substantive lift in BM25 from shorter docs with high-density terms).
- Param `describe()`: **≤80 chars** each.

Current descriptions ALL fail at least one budget cell (see table above). Rewrite required.

---

## Scope outside this wave

- Tool BEHAVIOR (Zod schemas, defaults, enum members) — UNCHANGED.
- `get_market_regime` default `exchange: 'HL'` — UNCHANGED (would require a separate behavior-change wave).
- Shadow-venue enum members (`ASTER`, `EDGEX`) — UNCHANGED. Public descriptions DROP the shadow-detail prose; shadow status lives on the `mcp://algovault/venues` resource (canonical home).
- Lobehub `manifest.json` version — UNCHANGED (separate versioning lineage per WIS `lobehub-manifest-version-lineage-is-separate-flag-on-version-bump`).
