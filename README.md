<p align="center">
  <img src="logo.png" alt="AlgoVault" width="120" />
</p>

# crypto-quant-signal-mcp

AI trading brain for crypto perps — composite signals, funding rate arb scanning, and market regime detection via MCP. Powered by Hyperliquid data. Remote-first with x402 micropayments.

## What It Does

Three opinionated tools + one performance resource that combine multiple indicators into a single verdict with confidence score:

| Tool | Description |
|------|-------------|
| `get_trade_signal` | Composite BUY/SELL/HOLD signal combining RSI(14), EMA(9/21), funding rate, OI momentum, and volume |
| `scan_funding_arb` | Cross-venue funding rate arbitrage scanner (Hyperliquid vs Binance vs Bybit) |
| `get_market_regime` | Market regime classification with cross-venue funding sentiment |
| `signal-performance` | Historical signal track record — win rate, Sharpe ratio, profit factor |

## Architecture

```
Remote Server (revenue-generating)
  Agent → HTTP POST → api.algovault.com/signal/mcp
    → x402 payment check → API key check → free tier
    → MCP Server (Streamable HTTP)
    → PostgreSQL (signal tracking)
    → Hyperliquid API

Local Mode (distribution magnet)
  Claude Desktop → stdio → npx crypto-quant-signal-mcp
    → Same tools, free tier only
    → SQLite (local signal tracking)
    → Hyperliquid API
```

## Quick Start

### Remote HTTP (for AI agents)

Connect your MCP client to:
```
https://api.algovault.com/signal/mcp
```

Pay per call via x402 (USDC on Base) — no signup needed.

### Local Install (for Claude Desktop / Cursor)

```bash
npx -y crypto-quant-signal-mcp
```

### Claude Desktop Config

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "crypto-quant-signal": {
      "command": "npx",
      "args": ["-y", "crypto-quant-signal-mcp"],
      "env": {
        "TRANSPORT": "stdio",
        "CQS_API_KEY": "your-pro-key-here"
      }
    }
  }
}
```

No API key needed for free tier — just remove the `CQS_API_KEY` line.

## Pricing

| Feature | Free | Pro ($49/mo) | Enterprise ($299/mo) | x402 (pay per call) |
|---------|------|-------------|---------------------|---------------------|
| `get_trade_signal` | BTC + ETH, 1h only | All 200+ perps, all timeframes | Same + SLA | Full access — $0.02/call |
| `scan_funding_arb` | Top 5 results | Unlimited | Unlimited | Full access — $0.01/call |
| `get_market_regime` | All assets | All assets | All assets + SLA | Full access — $0.02/call |
| `signal-performance` | Full access | Full access | Full access | Free |
| Monthly calls | ~100/day | 15,000/mo | 100,000/mo | Unlimited |
| Overage | Hard cap | $0.01/call | $0.005/call | N/A |

### x402 Micropayments

AI agents pay per HTTP call with USDC on Base chain — no signup, no API key, no billing. Payment receipt is the credential.

### API Key

Set `CQS_API_KEY` environment variable or pass `Authorization: Bearer <key>` header. Enterprise keys start with `ent_`.

## Example Agent Prompts

**Quick signal check:**
> "Get a trade signal for ETH on the 1h timeframe"

**Funding arb scan:**
> "Scan for funding rate arbitrage opportunities with at least 10 bps spread"

**Market regime with cross-venue sentiment:**
> "What's the current market regime for BTC on the 4h chart?"

**Multi-step analysis:**
> "Check the market regime for SOL, then get a trade signal. If it's a BUY, also scan for any funding arb opportunities on SOL."

## Tools Reference

### get_trade_signal

Returns a composite signal by weighting five indicators:

- **RSI(14)** — 25% weight: oversold/overbought detection
- **EMA(9/21) crossover** — 30% weight: trend direction
- **Funding rate** — 20% weight: sentiment from derivatives market
- **OI momentum** — 15% weight: new money confirmation
- **Volume** — 10% weight: conviction multiplier

**Parameters:**
- `coin` (string, required): Asset symbol (e.g. "ETH", "BTC", "SOL")
- `timeframe` (string, default "1h"): "1h", "4h", or "1d"
- `includeReasoning` (boolean, default true): Include human-readable explanation

### scan_funding_arb

Scans Hyperliquid's `predictedFundings` endpoint for cross-venue funding rate differences. Normalizes HL hourly rates vs Binance/Bybit 8h rates and annualizes the spread.

**Parameters:**
- `minSpreadBps` (number, default 5): Minimum spread in basis points
- `limit` (number, default 10): Max results to return

### get_market_regime

Classifies market conditions using ADX(14), ATR(14)/price volatility ratio, price structure (swing high/low analysis), and cross-venue funding sentiment.

**Parameters:**
- `coin` (string, required): Asset symbol
- `timeframe` (string, default "4h"): "1h", "4h", or "1d"

## Performance Tracking

Every signal from `get_trade_signal` is tracked with outcome prices at 1h, 4h, and 24h intervals. Access the track record via the `performance://signal-stats` MCP resource.

- **Remote mode:** PostgreSQL (server-side, aggregated across all users)
- **Local mode:** SQLite at `~/.crypto-quant-signal/performance.db` (private to your machine)

## Self-Hosting

```bash
git clone https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp
cd crypto-quant-signal-mcp
cp .env.example .env  # Edit with your values
npm ci && npm run build
docker compose up -d
```

## Technical Details

- **Data source:** Hyperliquid public API (free, no auth required)
- **Transports:** Streamable HTTP (default, port 3000) + stdio (via `TRANSPORT=stdio`)
- **Storage:** PostgreSQL (remote) or SQLite (local)
- **Exchange adapter:** Pluggable — Hyperliquid today, Binance/Bybit adapters in Phase 2
- **x402 payments:** USDC on Base chain per x402.org spec

## Examples

**Get a trade signal:**
```
User: "Get me a trade signal for BTC on the 1h timeframe"
→ Returns: BUY/SELL/HOLD with 72% confidence, RSI=66.7, EMA cross bullish, funding neutral
```

**Scan funding arbitrage:**
```
User: "Scan for funding rate arbitrage opportunities"
→ Returns: Top 5 cross-venue spreads (HL vs Binance vs Bybit), annualized returns
```

**Check market regime:**
```
User: "What's the market regime for ETH?"
→ Returns: TRENDING_UP, ADX=34.2, volatility moderate, cross-venue funding sentiment
```

## Suite Compatibility

All tools output an `_algovault` metadata block for composability with future AlgoVault tools:

| Tool output | Feeds into (Phase 2+) |
|------------|----------------------|
| `get_trade_signal` | `crypto-quant-risk-mcp`, `crypto-quant-backtest-mcp` |
| `scan_funding_arb` | `crypto-quant-risk-mcp`, `crypto-quant-execution-mcp` |
| `get_market_regime` | `crypto-quant-risk-mcp`, `crypto-quant-backtest-mcp` |

## Privacy Policy

crypto-quant-signal-mcp connects to Hyperliquid's public API (api.hyperliquid.xyz) to fetch market data. In local/stdio mode:
- No data is sent to AlgoVault Labs servers
- Signal history is stored locally in SQLite (~/.crypto-quant-signal/performance.db)
- No personal information is collected
- No telemetry or analytics in local mode

In remote mode (api.algovault.com/mcp), requests are logged for analytics (IP hashed, never stored raw). See https://algovault.com/privacy for full details.

## License

MIT

---

Built by [AlgoVault Labs](https://algovault.com)
