<p align="center">
  <img src="https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/logo.png" alt="AlgoVault" width="120" />
</p>

# crypto-quant-signal-mcp

The call intelligence layer for AI trading agents — composite quant calls across 5 exchanges (Hyperliquid, Binance, Bybit, OKX, Bitget), cross-venue arbitrage detection, and regime-aware market classification via MCP.

[![npm version](https://img.shields.io/npm/v/crypto-quant-signal-mcp)](https://www.npmjs.com/package/crypto-quant-signal-mcp)
[![npm downloads](https://img.shields.io/npm/dw/crypto-quant-signal-mcp)](https://www.npmjs.com/package/crypto-quant-signal-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![On-Chain Verified](https://img.shields.io/badge/Track_Record-On--Chain_Verified-blue?logo=ethereum)](https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81)

**[Live Track Record](https://algovault.com/track-record)** — 91%+ directional accuracy across 19,000+ trade calls on 5 exchanges. Public, no login required.

---

## Why AlgoVault

Most MCP trading servers give you raw data — prices, order books, candles. Your agent still has to figure out what to do with it.

AlgoVault is different. We give your agent **one answer**: a directional verdict with a confidence score, built from a multi-factor composite scoring engine tuned on production quant systems. Every call is tracked, every outcome is measured, and the full track record is public from day one.

**What makes this not just another indicator wrapper:**

- **Composite scoring, not single-indicator noise.** Multiple orthogonal signals — momentum oscillators, trend structure, derivatives positioning, volume dynamics, open interest flow — fused into a single weighted verdict. The weights are calibrated from live market outcome data, not textbook defaults.
- **Regime-aware call generation.** Calls are filtered through a market regime classifier before emission. The engine knows when to issue calls and when to stay silent — a trend-following setup in a ranging market gets suppressed, not broadcast.
- **Cross-venue intelligence.** Full signal generation on 5 exchanges — Hyperliquid, Binance, Bybit, OKX, and Bitget — with native candle, OI, funding, and volume data per venue. Cross-venue funding arbitrage scanning across all venues. Nobody else does multi-exchange derivatives analysis via MCP.
- **Published track record with every release.** Every call is recorded with outcome prices at multiple horizons. Win rate, profit factor, and expected value are computed continuously. No cherry-picking, no survivorship bias.
- **Adaptive scoring.** Indicator weights are retuned monthly from outcome data. The engine learns what works and adjusts — the call you get today is better than the one from last month.
- **Crypto + TradFi coverage.** 290+ assets across 5 exchanges — standard crypto perps on all venues, TradFi perpetuals (stocks, indices, commodities, FX) on Hyperliquid, and liquidity-filtered meme coins. Assets are classified into quality tiers with per-exchange signal generation.

---

## Try It in 30 Seconds

No code. No API key. No install.

**Step 1.** Open Claude → Settings → Integrations → Add custom connector

**Step 2.** Enter the name and URL:

| Field | Value |
|-------|-------|
| Name | `Crypto Quant Signal` |
| URL | `https://api.algovault.com/mcp` |

![Add Connector](https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/docs/screenshots/Add-Connector.png)

**Step 3.** Ask Claude anything:

> "Get me a trade signal for ETH on the 4h timeframe"

> "Get me a trade signal for BTC on Binance, 1h timeframe"

![BTC Signal Result](https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/docs/screenshots/BTC-signal.png)

That's it. Your Claude now has a quant analyst built in.

---

## Tools

### `get_trade_signal`

Returns a composite **BUY / SELL / HOLD** verdict with confidence score for any supported asset on any of 5 supported exchanges — crypto perps, TradFi perpetuals (stocks, indices, commodities, FX), and liquidity-filtered meme coins on Hyperliquid.

Under the hood: a multi-factor scoring engine evaluates momentum, trend structure, derivatives sentiment, open interest dynamics, and volume conviction. Scores pass through regime-aware filters and adaptive post-processing gates — including funding flow analysis, volatility regime detection, and trend persistence decay — before a final verdict is emitted.

Only high-conviction calls are generated. The engine is designed to stay silent when the edge is unclear.

**Parameters:**
- `coin` (string, required): Asset symbol — e.g. `"ETH"`, `"BTC"`, `"SOL"`, `"GOLD"`, `"TSLA"`, or any of 290+ supported assets
- `timeframe` (string, default `"15m"`): `"1m"`, `"3m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`, `"2h"`, `"4h"`, `"8h"`, `"12h"`, `"1d"`
- `exchange` (string, default `"HL"`): `"HL"` (Hyperliquid), `"BINANCE"`, `"BYBIT"`, `"OKX"`, `"BITGET"`. TradFi assets (GOLD, TSLA, etc.) are HL-only.
- `includeReasoning` (boolean, default `true`): Human-readable explanation of the call logic

**Output includes:** call direction, confidence score (0–100), all computed indicator values, detected market regime, reasoning narrative, and `_algovault` metadata for downstream tool composability.

Responses also include optional `closest_tradeable` (on HOLD verdicts) and `try_next` (always, when the cross-asset grid has non-HOLD cells) as signal-surface expansion fields — exploration hints across the BTC/ETH/SOL/BNB/XRP/DOGE × 5m/15m/1h/4h grid, not trade recommendations.

### `scan_funding_arb`

Scans cross-venue funding rate differentials across Hyperliquid, Binance, and Bybit. Normalizes hourly vs 8-hour rate conventions, computes basis-point spreads, and ranks opportunities by composite score (spread magnitude, time urgency, and funding conviction from 24h history). OKX and Bitget funding data is available via their respective adapters — arb scanning expansion is planned.

This is the only MCP server that provides cross-venue funding arbitrage intelligence — long one exchange, short another, capture the spread.

**Parameters:**
- `minSpreadBps` (number, default `5`): Minimum spread in basis points to include
- `limit` (number, default `10`): Maximum results returned

**Output includes:** per-opportunity venue rates, optimal long/short direction, annualized spread percentage, and next funding timestamps.

### `get_market_regime`

Classifies the current market environment into one of four regimes: **TRENDING_UP**, **TRENDING_DOWN**, **RANGING**, or **VOLATILE**.

Uses a multi-dimensional classification approach combining directional strength measurement with ADX slope analysis (detecting trend strengthening vs exhaustion), volume-weighted pivot detection, ATR-adaptive funding thresholds, and cross-venue funding sentiment divergence. The regime classification directly informs how `get_trade_signal` filters its output — agents can also use it independently for strategy selection and position sizing.

**Parameters:**
- `coin` (string, required): Asset symbol
- `timeframe` (string, default `"4h"`): Candle timeframe for analysis
- `exchange` (string, default `"HL"`): Exchange to analyze — same options as get_trade_signal

**Output includes:** regime label, confidence score, underlying metrics (trend strength, volatility interpretation, price structure), cross-venue funding sentiment, and a plain-English strategy suggestion.

---

## Performance Tracking

Every call is tracked from emission to outcome. No exceptions.

**What we measure:**
- Outcome prices at timeframe-appropriate evaluation windows
- PFE Win Rate — did price move in the call direction at any point during the evaluation window
- Expected Value — probability-weighted average return per call
- Profit Factor — gross wins divided by gross losses
- Peak Favorable Excursion (PFE) and Maximum Adverse Excursion (MAE)
- Running statistics per asset, timeframe, and quality tier

**HOLD calls are free** — when the engine says "don't trade," you don't pay. Only BUY and SELL verdicts are charged via x402 or count against subscription quotas. This aligns our incentives: you only pay when we see a tradeable opportunity.

- **HOLD Rate**: Percentage of scans where the engine declines to issue a trade call. A high HOLD rate (currently ~84%) means the engine is selective — it only calls BUY/SELL when conditions align across multiple indicators.

**Infrastructure:**
- Remote mode: PostgreSQL with automated outcome backfill
- Local mode: SQLite at `~/.crypto-quant-signal/performance.db`
- Only high-confidence BUY/SELL calls are tracked — HOLD is excluded
- Signals are tracked per exchange — the track record shows performance on each venue independently

### On-Chain Verification

Every call is hashed (keccak256) at creation time and anchored on Base L2 via daily Merkle batches. This makes the track record tamper-proof — we cannot edit past calls.

- **Contract**: [`0x6485...0f81`](https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81) (Base L2)
- **Verify any call**: `https://api.algovault.com/api/verify-signal?signalId=<ID>`
- **View all batches**: `https://api.algovault.com/api/merkle-batches`
- **Visual verification**: [algovault.com/verify](https://algovault.com/verify)

---

## Pricing

| Feature | Free | Starter ($9.99/mo) | Pro ($49/mo) | Enterprise ($299/mo) | x402 (per call) |
|---------|------|-------------------|-------------|---------------------|-----------------|
| Exchanges | HL only | All 5 | All 5 | All 5 | All 5 |
| Assets | BTC, ETH | All 290+ | All 290+ | All 290+ | All 290+ |
| Asset classes | Crypto only | Crypto + TradFi | Crypto + TradFi | Crypto + TradFi | Crypto + TradFi |
| Timeframes | 15m, 1h | All 11 | All 11 | All 11 | All 11 |
| Funding arb results | Top 5 | Unlimited | Unlimited | Unlimited | Unlimited |
| Track record | Full access | Full access | Full access | Full access | Full access |
| Monthly calls | ~100/day | 3,000/mo | 15,000/mo | 100,000/mo | Unlimited |
| Support | Community | Email | Priority | Dedicated | — |
| Price | $0 | $9.99/mo | $49/mo | $299/mo | $0.01–0.05/call |
| HOLD calls | Free | Free | Free | Free | Free |

\* HOLD verdicts (engine says "don't trade") are always free across all tiers — no x402 charge, no quota deduction.

**x402 micropayments:** AI agents pay per HTTP call with USDC on Base — no signup, no API key, no billing. The payment receipt is the credential. See [x402.org](https://x402.org).

**Subscriptions:** Sign up at [api.algovault.com/signup](https://api.algovault.com/signup). Starter ($9.99/mo) unlocks all assets and timeframes. API key delivered instantly after checkout.

---

## For Developers

### Remote endpoint (recommended)

```
https://api.algovault.com/mcp
```

Streamable HTTP transport. Compatible with any MCP client — Claude, Cursor, Cline, custom agents.

### Local install via npx

```bash
npx -y crypto-quant-signal-mcp
```

### Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "crypto-quant-signal": {
      "command": "npx",
      "args": ["-y", "crypto-quant-signal-mcp"],
      "env": { "TRANSPORT": "stdio" }
    }
  }
}
```

### npm install

```bash
npm install crypto-quant-signal-mcp
```

### Self-hosting

```bash
git clone https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp
cd crypto-quant-signal-mcp
cp .env.example .env  # Edit with your values
npm ci && npm run build
docker compose up -d
```

---

## Architecture

```
Agent / Claude / Cursor
  │
  ▼
api.algovault.com/mcp (Streamable HTTP)
  │
  ├─ x402 payment verification (USDC on Base)
  ├─ API key / subscription check
  ├─ Free tier fallback
  │
  ▼
MCP Server (Express + @modelcontextprotocol/sdk)
  │
  ├─ Composite Scoring Engine
  │    ├─ Multi-factor indicator fusion
  │    ├─ Regime-aware signal filtering
  │    └─ Adaptive post-processing gates
  │
  ├─ Asset Classification Engine
  │    ├─ 4-tier quality system (Blue Chip → Major Alt → TradFi → Meme)
  │    └─ Liquidity filter for meme/micro assets
  │
  ├─ Exchange Adapter Layer
  │    ├─ Hyperliquid (crypto + TradFi xyz perps)
  │    ├─ Binance USDT-M Futures
  │    ├─ Bybit Linear
  │    ├─ OKX Swap
  │    └─ Bitget USDT-M
  │
  ├─ Performance Tracker
  │    └─ PostgreSQL (remote) / SQLite (local)
  │
  └─ Exchange Public APIs (free, no auth — all 5 venues)
```

**Exchange adapter pattern:** All exchange interactions go through the `ExchangeAdapter` interface — supporting full signal generation on all 5 exchanges. Each adapter implements candles, OI, funding rates, and current price via native exchange APIs. TradFi perps are Hyperliquid-exclusive.

---

## Suite Composability

Every tool output includes an `_algovault` metadata block declaring version and compatible downstream tools:

| This tool | Feeds into (Phase 2+) |
|-----------|----------------------|
| `get_trade_signal` | `crypto-quant-risk-mcp` (position sizing) · `crypto-quant-backtest-mcp` (validation) |
| `scan_funding_arb` | `crypto-quant-execution-mcp` (optimal entry/exit) · `crypto-quant-risk-mcp` (exposure) |
| `get_market_regime` | `crypto-quant-risk-mcp` (regime-aware sizing) · `crypto-quant-backtest-mcp` (filtered backtests) |

Schemas are designed for composability. All tools share consistent `timestamp`, `coin`, and `_algovault` fields — downstream tools accept these objects directly as input.

---

## Privacy

**Local mode:** Zero telemetry. No data sent to AlgoVault servers. Call history stored on your machine only.

**Remote mode:** Request metadata logged for analytics (IP hashed, never stored raw). See [privacy policy](https://api.algovault.com/privacy).

---

## License

MIT

---

> **Disclaimer:** AlgoVault provides directional entry interpretation for AI agents. Exit timing is determined by your agent or strategy. This is not financial advice. Past performance does not guarantee future results.

Built by [AlgoVault Labs](https://algovault.com)

[Landing page](https://algovault.com) · [API endpoint](https://api.algovault.com/mcp)
