#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getTradeSignal } from './tools/get-trade-signal.js';
import { scanFundingArb } from './tools/scan-funding-arb.js';
import { getMarketRegime } from './tools/get-market-regime.js';
import { getSignalPerformance } from './resources/signal-performance.js';
import { closeDb } from './lib/performance-db.js';

const server = new McpServer({
  name: 'crypto-quant-signal-mcp',
  version: '1.0.0',
});

// ── Tool 1: get_trade_signal ──
server.tool(
  'get_trade_signal',
  "Returns a composite BUY/SELL/HOLD signal for a Hyperliquid perp. Combines RSI(14), EMA(9/21) crossover, funding rate, OI momentum, and volume into a weighted score with confidence percentage.",
  {
    coin: z.string().describe("Asset symbol, e.g. 'ETH', 'BTC', 'SOL'"),
    timeframe: z.enum(['1h', '4h', '1d']).default('1h').describe('Candle timeframe (free: 1h only)'),
    includeReasoning: z.boolean().default(true).describe('Include human-readable reasoning'),
  },
  async ({ coin, timeframe, includeReasoning }) => {
    try {
      const result = await getTradeSignal({ coin, timeframe, includeReasoning });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
    }
  }
);

// ── Tool 2: scan_funding_arb ──
server.tool(
  'scan_funding_arb',
  'Scans cross-venue funding rate differences between Hyperliquid, Binance, and Bybit. Returns top arbitrage opportunities ranked by annualized spread.',
  {
    minSpreadBps: z.number().default(5).describe('Minimum spread in basis points to include'),
    limit: z.number().default(10).describe('Max results (free: max 5)'),
  },
  async ({ minSpreadBps, limit }) => {
    try {
      const result = await scanFundingArb({ minSpreadBps, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
    }
  }
);

// ── Tool 3: get_market_regime ──
server.tool(
  'get_market_regime',
  'Classifies the current market regime (TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE) for a Hyperliquid perp using ADX(14), volatility ratio, and price structure analysis. Helps decide between trend-following vs mean-reversion strategies.',
  {
    coin: z.string().describe("Asset symbol, e.g. 'BTC', 'ETH', 'SOL'"),
    timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe('Candle timeframe'),
  },
  async ({ coin, timeframe }) => {
    try {
      const result = await getMarketRegime({ coin, timeframe });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
    }
  }
);

// ── Resource: signal-performance ──
server.resource(
  'signal-stats',
  'performance://signal-stats',
  { description: 'Historical signal performance metrics — win rate, Sharpe ratio, profit factor, and per-asset breakdowns. Updated on each access with latest outcome data.' },
  async () => {
    const stats = await getSignalPerformance();
    return { contents: [{ uri: 'performance://signal-stats', mimeType: 'application/json', text: JSON.stringify(stats, null, 2) }] };
  }
);

// ── Start server ──
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = () => {
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});
