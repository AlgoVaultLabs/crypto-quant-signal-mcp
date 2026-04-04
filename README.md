# crypto-quant-signal-mcp

AI trading brain for crypto perps — composite signals, funding rate arb scanning, and market regime detection via MCP. Powered by Hyperliquid data.

## What It Does

Three opinionated tools + one performance resource that combine multiple indicators into a single verdict with confidence score:

| Tool | Description |
|------|-------------|
| `get_trade_signal` | Composite BUY/SELL/HOLD signal combining RSI(14), EMA(9/21), funding rate, OI momentum, and volume |
| `scan_funding_arb` | Cross-venue funding rate arbitrage scanner (Hyperliquid vs Binance vs Bybit) |
| `get_market_regime` | Market regime classification (TRENDING_UP/DOWN, RANGING, VOLATILE) with strategy suggestions |
| `signal-performance` | Historical signal track record — win rate, Sharpe ratio, profit factor |

## Quick Start

### Install

```bash
npm install -g crypto-quant-signal-mcp
```

Or run directly with npx:

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
        "CQS_API_KEY": "your-pro-key-here"
      }
    }
  }
}
```

No API key needed for free tier — just remove the `env` block.

## Free vs Pro

| Feature | Free | Pro ($29/mo) |
|---------|------|-------------|
| `get_trade_signal` | BTC + ETH, 1h only | All 200+ perps, 1h/4h/1d |
| `scan_funding_arb` | Top 5 results | Unlimited |
| `get_market_regime` | All assets, all timeframes | Same |
| `signal-performance` | Full access | Full access |

Set `CQS_API_KEY` environment variable for Pro access.

## Example Agent Prompts

**Quick signal check:**
> "Get a trade signal for ETH on the 1h timeframe"

**Funding arb scan:**
> "Scan for funding rate arbitrage opportunities with at least 10 bps spread"

**Market regime:**
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

Classifies market conditions using ADX(14), ATR(14)/price volatility ratio, and price structure (swing high/low analysis).

**Parameters:**
- `coin` (string, required): Asset symbol
- `timeframe` (string, default "4h"): "1h", "4h", or "1d"

## Performance Tracking

Every signal from `get_trade_signal` is stored locally in a SQLite database at `~/.crypto-quant-signal/performance.db`. The server automatically backfills outcome prices at 1h, 4h, and 24h intervals.

Access the track record via the `performance://signal-stats` MCP resource — it returns win rate, average return, Sharpe ratio, max drawdown, and profit factor broken down by signal type and asset.

## Technical Details

- **Data source:** Hyperliquid public API (free, no auth required)
- **Transport:** stdio (local MCP)
- **Storage:** SQLite via better-sqlite3 (local to your machine)
- **Zero dependencies on external services** — works fully offline after candle data is fetched

## License

MIT
