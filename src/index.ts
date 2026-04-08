#!/usr/bin/env node

/**
 * crypto-quant-signal-mcp — Dual transport MCP server.
 *
 * Default: Streamable HTTP on port 3000 (remote server mode)
 * Optional: stdio transport via TRANSPORT=stdio env var (local npx use)
 */
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getTradeSignal } from './tools/get-trade-signal.js';
import { scanFundingArb } from './tools/scan-funding-arb.js';
import { getMarketRegime } from './tools/get-market-regime.js';
import { getSignalPerformance } from './resources/signal-performance.js';
import { closeDb } from './lib/performance-db.js';
import { resolveLicense, resolveLicenseSync, requestContext, getRequestLicense, getRequestSessionId, getRequestIpHash, trackCall } from './lib/license.js';
import { initX402, settleX402Async } from './lib/x402.js';
import { initAnalytics, logRequest, hashIp, getUsageStats } from './lib/analytics.js';
import { getAnalyticsSummary } from './resources/analytics-summary.js';

function createServer(): McpServer {
  const server = new McpServer({
    name: 'crypto-quant-signal-mcp',
    version: '1.4.0',
  });

  // ── Tool 1: get_trade_signal ──
  server.tool(
    'get_trade_signal',
    "Returns a composite BUY/SELL/HOLD signal for a Hyperliquid perp. Combines RSI(14), EMA(9/21) crossover, funding rate, OI momentum, and volume into a weighted score with confidence percentage.",
    {
      coin: z.string().describe("Asset symbol, e.g. 'ETH', 'BTC', 'SOL'"),
      timeframe: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']).default('15m').describe('Candle timeframe. All Hyperliquid intervals supported. 1m/3m for HFT scalping, 5m/15m for intraday agents (most popular), 30m/1h/2h for swing, 4h/8h/12h/1d for position trading. Free tier: 15m and 1h only.'),
      includeReasoning: z.boolean().default(true).describe('Include human-readable reasoning'),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ coin, timeframe, includeReasoning }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        trackCall(license);
        const result = await getTradeSignal({ coin, timeframe, includeReasoning, license });
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'get_trade_signal',
          asset: coin,
          timeframe,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          verdict: result.signal,
          confidence: result.confidence,
          ipHash: getRequestIpHash(),
        });
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
    { readOnlyHint: true, openWorldHint: true },
    async ({ minSpreadBps, limit }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        trackCall(license);
        const result = await scanFundingArb({ minSpreadBps, limit, license });
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'scan_funding_arb',
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
        });
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
    'Classifies the current market regime (TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE) for a Hyperliquid perp using ADX(14), volatility ratio, price structure, and cross-venue funding sentiment.',
    {
      coin: z.string().describe("Asset symbol, e.g. 'BTC', 'ETH', 'SOL'"),
      timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe('Candle timeframe'),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ coin, timeframe }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        trackCall(license);
        const result = await getMarketRegime({ coin, timeframe });
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'get_market_regime',
          asset: coin,
          timeframe,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
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

  return server;
}

// ── Stdio Mode ──
async function startStdio() {
  initAnalytics();
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

  const { default: express } = await import('express');

  const app = express();
  const port = parseInt(process.env.PORT || '3000', 10);

  // Store active transports for session management
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'crypto-quant-signal-mcp', version: '1.4.0' });
  });

  // Admin analytics (only if ADMIN_API_KEY is set)
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey) {
    // JSON API
    app.get('/analytics', async (req, res) => {
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
        || (req.query.key as string);
      if (token !== adminKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const stats = await getUsageStats();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch analytics' });
      }
    });

    // Visual dashboard
    app.get('/dashboard', (req, res) => {
      const key = req.query.key as string;
      if (key !== adminKey) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      res.send(getDashboardHtml(key));
    });

    // Signal performance JSON (admin-only)
    app.get('/performance', async (req, res) => {
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
        || (req.query.key as string);
      if (token !== adminKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const stats = await getSignalPerformance();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch performance stats' });
      }
    });

    // Signal performance dashboard (admin-only)
    app.get('/performance-dashboard', (req, res) => {
      const key = req.query.key as string;
      if (key !== adminKey) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      res.send(getPerformanceDashboardHtml(key));
    });
  }

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

    // Run the entire request handling inside AsyncLocalStorage context
    // so tool handlers read the correct per-request license
    await requestContext.run({ license, sessionId, ipHash }, async () => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (req.method === 'GET') {
          if (sessionId && transports.has(sessionId)) {
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
          } else {
            res.status(404).json({ error: 'Session not found' });
          }
          return;
        }

        // POST — main request path
        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res, req.body);
        } else {
          // New session
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
            },
          });

          transport.onclose = () => {
            const sid = (transport as unknown as { sessionId?: string }).sessionId;
            if (sid) transports.delete(sid);
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
      if (pendingSettlement) {
        settleX402Async(pendingSettlement);
      }
    });
  });

  const httpServer = app.listen(port, () => {
    console.log(`crypto-quant-signal-mcp running on http://0.0.0.0:${port}/mcp`);
    console.log(`Health check: http://0.0.0.0:${port}/health`);
  });

  const shutdown = () => {
    console.log('Shutting down...');
    for (const transport of transports.values()) {
      transport.close?.();
    }
    transports.clear();
    closeDb();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Dashboard HTML ──

function getDashboardHtml(apiKey: string): string {
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
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
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
    <div class="card"><div class="label">Unique Sessions (24h)</div><div class="value orange" id="sessions-24h"></div></div>
  </div>
  <div class="grid">
    <div class="section"><h2>Calls by Tool</h2><table><thead><tr><th>Tool</th><th>Calls</th><th></th></tr></thead><tbody id="by-tool"></tbody></table></div>
    <div class="section"><h2>Calls by Tier</h2><table><thead><tr><th>Tier</th><th>Calls</th><th></th></tr></thead><tbody id="by-tier"></tbody></table></div>
  </div>
  <div class="grid">
    <div class="section"><h2>Top Assets</h2><table><thead><tr><th>Asset</th><th>Calls</th><th></th></tr></thead><tbody id="top-assets"></tbody></table></div>
    <div class="section"><h2>Avg Response Time</h2><table><thead><tr><th>Tool</th><th>ms</th></tr></thead><tbody id="avg-time"></tbody></table></div>
  </div>
  <div class="refresh">Auto-refreshes every 30s &middot; <span id="updated"></span></div>
</div>
<script>
const KEY = '${apiKey}';
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
async function load() {
  try {
    const r = await fetch('/analytics?key=' + KEY);
    const d = await r.json();
    document.getElementById('total-all').textContent = d.totalCalls.allTime;
    document.getElementById('total-24h').textContent = d.totalCalls.last24h;
    document.getElementById('total-7d').textContent = d.totalCalls.last7d;
    document.getElementById('sessions-24h').textContent = d.uniqueSessions.last24h;
    renderRows('by-tool', d.byTool);
    renderRows('by-tier', d.byTier);
    renderAssets(d.topAssets);
    const timeEl = document.getElementById('avg-time');
    const timeEntries = Object.entries(d.avgResponseTimeMs);
    timeEl.innerHTML = timeEntries.length
      ? timeEntries.map(([k,v]) => '<tr><td>'+k+'</td><td>'+v+'ms</td></tr>').join('')
      : '<tr><td colspan="2" style="color:#8b949e">No data yet</td></tr>';
    document.getElementById('updated').textContent = 'Updated: ' + new Date(d.generatedAt).toLocaleString();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch(e) { document.getElementById('loading').textContent = 'Failed to load: ' + e.message; }
}
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

function getPerformanceDashboardHtml(apiKey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlgoVault Signal Performance</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 24px; }
  .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 18px; }
  .card .label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .card .sub { color: #8b949e; font-size: 11px; margin-top: 4px; }
  .green { color: #3fb950 !important; }
  .red { color: #f85149 !important; }
  .gold { color: #d29922 !important; }
  .purple { color: #bc8cff !important; }
  .cyan { color: #56d4dd !important; }
  .muted { color: #8b949e !important; }
  .section { margin-bottom: 28px; }
  .section h2 { font-size: 14px; color: #8b949e; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 12px; overflow: hidden; border: 1px solid #30363d; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #21262d; font-size: 13px; }
  th { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; background: #0d1117; }
  th.num { text-align: right; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-wrap { width: 80px; display: inline-block; }
  .bar { height: 6px; border-radius: 3px; min-width: 2px; }
  .bar.g { background: #3fb950; }
  .bar.r { background: #f85149; }
  .bar.b { background: #58a6ff; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .badge-buy { background: #0d2818; color: #3fb950; }
  .badge-sell { background: #2d0b0e; color: #f85149; }
  .badge-hold { background: #1c1c1c; color: #8b949e; }
  .refresh { color: #8b949e; font-size: 12px; margin-top: 16px; }
  #loading { color: #8b949e; font-size: 16px; padding: 40px; text-align: center; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .recent-signal { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #21262d; font-size: 13px; }
  .recent-signal:last-child { border-bottom: none; }
  .recent-list { background: #161b22; border: 1px solid #30363d; border-radius: 12px; overflow: hidden; max-height: 520px; overflow-y: auto; }
  .empty { color: #8b949e; padding: 40px; text-align: center; font-size: 14px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid #30363d; background: #161b22; color: #8b949e; transition: all 0.15s; }
  .tab:hover { border-color: #58a6ff80; }
  .tab.active { background: #58a6ff20; color: #58a6ff; border-color: #58a6ff; }
  .methodology { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; }
  .methodology h3 { font-size: 13px; color: #58a6ff; margin-bottom: 8px; }
  .methodology p { font-size: 12px; color: #8b949e; line-height: 1.6; margin-bottom: 8px; }
  .methodology .metric { display: flex; gap: 8px; margin-bottom: 6px; font-size: 12px; }
  .methodology .metric .name { color: #e1e4e8; font-weight: 600; min-width: 120px; }
  .methodology .metric .desc { color: #8b949e; }
  .pfe-bar { display: inline-block; height: 8px; border-radius: 4px; background: #3fb950; opacity: 0.7; vertical-align: middle; }
  .mae-bar { display: inline-block; height: 8px; border-radius: 4px; background: #f85149; opacity: 0.7; vertical-align: middle; }
</style>
</head>
<body>
<div class="logo">
  <img src="/logo.png" width="36" height="36" style="border-radius:8px" onerror="this.style.display='none'">
  <div><h1>Signal Performance</h1><div class="subtitle">v1.4 &middot; PFE/MAE tracking &middot; admin only &middot; auto-refreshes</div></div>
</div>
<div id="loading">Loading performance data...</div>
<div id="content" style="display:none">
  <!-- KPI Cards (4) -->
  <div class="grid">
    <div class="card"><div class="label">Total Signals</div><div class="value" id="total"></div><div class="sub" id="period"></div></div>
    <div class="card"><div class="label">Win Rate</div><div class="value" id="winrate"></div><div class="sub">outcome return in signal direction</div></div>
    <div class="card"><div class="label">PFE Win Rate</div><div class="value" id="pfe-winrate"></div><div class="sub">peak favorable excursion &gt; 0</div></div>
    <div class="card"><div class="label">Profit Factor</div><div class="value" id="pf"></div><div class="sub">gross wins / gross losses</div></div>
  </div>

  <!-- Signal type breakdown -->
  <div class="section"><h2>By Signal Type</h2>
    <table>
      <thead><tr><th>Type</th><th class="num">Count</th><th class="num">Win Rate</th><th class="num">Avg Return</th><th>Bar</th></tr></thead>
      <tbody id="by-type"></tbody>
    </table>
  </div>

  <!-- Timeframe tabs + table -->
  <div class="section">
    <h2>Performance by Timeframe</h2>
    <div class="tabs" id="tf-tabs"></div>
    <table>
      <thead><tr><th>Timeframe</th><th class="num">Signals</th><th class="num">Win Rate</th><th class="num">PFE Win</th><th class="num">Avg Return</th><th class="num">Avg PFE</th><th class="num">Avg MAE</th><th class="num">Profit Factor</th></tr></thead>
      <tbody id="by-timeframe"></tbody>
    </table>
  </div>

  <div class="grid-2">
    <!-- Top Performers -->
    <div class="section"><h2>Top Performing Assets</h2>
      <table>
        <thead><tr><th>Asset</th><th class="num">Signals</th><th class="num">Win Rate</th><th class="num">Avg Return</th></tr></thead>
        <tbody id="top-assets"></tbody>
      </table>
    </div>

    <!-- Worst Performers -->
    <div class="section"><h2>Worst Performing Assets</h2>
      <table>
        <thead><tr><th>Asset</th><th class="num">Signals</th><th class="num">Win Rate</th><th class="num">Avg Return</th></tr></thead>
        <tbody id="worst-assets"></tbody>
      </table>
    </div>
  </div>

  <!-- Recent signals with PFE/MAE -->
  <div class="section"><h2>Recent Signals</h2>
    <div class="recent-list" id="recent"></div>
  </div>

  <!-- Methodology section -->
  <div class="section">
    <h2>Methodology</h2>
    <div class="methodology" id="methodology"></div>
  </div>

  <div class="refresh">Auto-refreshes every 30s &middot; <span id="updated"></span></div>
</div>

<script>
const KEY = '${apiKey}';
const TF_ORDER = ['1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d'];
let activeTfFilter = 'all';

function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : '\\u2014'; }
function retPct(v) { return v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '\\u2014'; }
function retClass(v) { return v != null ? (v >= 0 ? 'green' : 'red') : 'muted'; }
function wrClass(v) { return v != null ? (v >= 0.5 ? 'green' : v >= 0.3 ? 'gold' : 'red') : 'muted'; }
function pfClass(v) { return v != null ? (v >= 1.5 ? 'green' : v >= 1.0 ? 'gold' : 'red') : 'muted'; }
function badge(sig) { return '<span class="badge badge-' + sig.toLowerCase() + '">' + sig + '</span>'; }
function timeAgo(ts) {
  const s = Math.floor(Date.now()/1000 - ts);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function setTfFilter(tf) {
  activeTfFilter = tf;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tf === tf));
  renderTimeframes();
  renderRecent();
}

let cachedData = null;

function renderTimeframes() {
  const d = cachedData;
  if (!d) return;
  const tfEl = document.getElementById('by-timeframe');
  const timeframes = d.byTimeframe ? Object.entries(d.byTimeframe) : [];
  const filtered = activeTfFilter === 'all' ? timeframes : timeframes.filter(([tf]) => tf === activeTfFilter);
  if (filtered.length) {
    const sorted = filtered.sort((a,b) => TF_ORDER.indexOf(a[0]) - TF_ORDER.indexOf(b[0]));
    tfEl.innerHTML = sorted.map(([tf, v]) =>
      '<tr><td><strong>' + tf + '</strong></td>' +
      '<td class="num">' + v.count + '</td>' +
      '<td class="num ' + wrClass(v.winRate) + '">' + pct(v.winRate) + '</td>' +
      '<td class="num ' + wrClass(v.pfeWinRate) + '">' + pct(v.pfeWinRate) + '</td>' +
      '<td class="num ' + retClass(v.avgReturnPct) + '">' + retPct(v.avgReturnPct) + '</td>' +
      '<td class="num ' + (v.avgPFE != null && v.avgPFE >= 0 ? 'green' : 'muted') + '">' + retPct(v.avgPFE) + '</td>' +
      '<td class="num ' + (v.avgMAE != null ? 'red' : 'muted') + '">' + retPct(v.avgMAE) + '</td>' +
      '<td class="num ' + pfClass(v.profitFactor) + '">' + (v.profitFactor != null ? v.profitFactor.toFixed(2) : '\\u2014') + '</td></tr>'
    ).join('');
  } else {
    tfEl.innerHTML = '<tr><td colspan="8" class="empty">No data for this timeframe</td></tr>';
  }
}

function renderRecent() {
  const d = cachedData;
  if (!d) return;
  const recentEl = document.getElementById('recent');
  let recent = d.recentSignals || [];
  if (activeTfFilter !== 'all') recent = recent.filter(s => s.timeframe === activeTfFilter);

  if (recent.length) {
    recentEl.innerHTML = recent.map(s => {
      const isBuy = s.signal === 'BUY';
      const pfe = s.pfe_return_pct;
      const mae = s.mae_return_pct;
      // Direction-adjusted for display
      const pfeDir = pfe != null ? (isBuy ? pfe : -pfe) : null;
      const maeDir = mae != null ? (isBuy ? mae : -mae) : null;

      return '<div class="recent-signal">' +
        badge(s.signal) +
        '<strong style="width:55px">' + s.coin + '</strong>' +
        '<span class="muted" style="width:35px;text-align:center">' + s.timeframe + '</span>' +
        '<span style="width:80px">$' + (s.price_at_signal < 1 ? s.price_at_signal.toFixed(4) : s.price_at_signal.toLocaleString()) + '</span>' +
        '<span style="width:45px">' + s.confidence + '%</span>' +
        '<span style="width:70px;text-align:right" class="' + retClass(s.outcome_return_pct) + '">' +
          (s.outcome_return_pct != null ? retPct(s.outcome_return_pct) : '<span class="muted">\\u2026</span>') + '</span>' +
        '<span style="width:70px;text-align:right" class="' + (pfeDir != null && pfeDir > 0 ? 'green' : 'muted') + '" title="PFE">' +
          (pfeDir != null ? '+' + pfeDir.toFixed(2) + '%' : '') + '</span>' +
        '<span style="width:70px;text-align:right" class="' + (maeDir != null && maeDir < 0 ? 'red' : 'muted') + '" title="MAE">' +
          (maeDir != null ? maeDir.toFixed(2) + '%' : '') + '</span>' +
        '<span class="muted" style="margin-left:auto">' + timeAgo(s.created_at) + '</span>' +
      '</div>';
    }).join('');
  } else {
    recentEl.innerHTML = '<div class="empty">No signals' + (activeTfFilter !== 'all' ? ' for ' + activeTfFilter : '') + ' yet.</div>';
  }
}

async function load() {
  try {
    const r = await fetch('/performance?key=' + KEY);
    const d = await r.json();
    cachedData = d;

    // KPIs
    document.getElementById('total').textContent = d.totalSignals.toLocaleString();
    document.getElementById('period').textContent = d.period ? d.period.from + ' \\u2192 ' + d.period.to : '';

    const wr = d.overall.winRate;
    const wrEl = document.getElementById('winrate');
    wrEl.textContent = pct(wr);
    wrEl.className = 'value ' + wrClass(wr);

    const pfeWr = d.overall.pfeWinRate;
    const pfeWrEl = document.getElementById('pfe-winrate');
    pfeWrEl.textContent = pct(pfeWr);
    pfeWrEl.className = 'value ' + wrClass(pfeWr);

    const pf = d.overall.profitFactor;
    const pfEl = document.getElementById('pf');
    pfEl.textContent = pf != null ? pf.toFixed(2) : '\\u2014';
    pfEl.className = 'value ' + pfClass(pf);

    // By signal type
    const typeEl = document.getElementById('by-type');
    const types = Object.entries(d.bySignalType || {});
    if (types.length) {
      const maxCount = Math.max(...types.map(([,v]) => v.count));
      typeEl.innerHTML = types.map(([type, v]) =>
        '<tr><td>' + badge(type) + '</td>' +
        '<td class="num">' + v.count + '</td>' +
        '<td class="num ' + wrClass(v.winRate) + '">' + pct(v.winRate) + '</td>' +
        '<td class="num ' + retClass(v.avgReturnPct) + '">' + retPct(v.avgReturnPct) + '</td>' +
        '<td><div class="bar-wrap"><div class="bar b" style="width:' + Math.round(v.count/maxCount*100) + '%"></div></div></td></tr>'
      ).join('');
    } else {
      typeEl.innerHTML = '<tr><td colspan="5" class="empty">No signals yet</td></tr>';
    }

    // Timeframe tabs
    const tabsEl = document.getElementById('tf-tabs');
    const availTfs = d.byTimeframe ? Object.keys(d.byTimeframe).sort((a,b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b)) : [];
    tabsEl.innerHTML = '<div class="tab' + (activeTfFilter === 'all' ? ' active' : '') + '" data-tf="all" onclick="setTfFilter(\'all\')">All</div>' +
      availTfs.map(tf => '<div class="tab' + (activeTfFilter === tf ? ' active' : '') + '" data-tf="' + tf + '" onclick="setTfFilter(\'' + tf + '\')">' + tf + '</div>').join('');

    renderTimeframes();

    // Assets
    const assets = Object.entries(d.byAsset || {})
      .filter(([,v]) => v.avgReturnPct != null)
      .map(([coin, v]) => ({ coin, ...v }));

    const topAssets = [...assets].sort((a,b) => (b.avgReturnPct||0) - (a.avgReturnPct||0)).slice(0, 15);
    const worstAssets = [...assets].sort((a,b) => (a.avgReturnPct||0) - (b.avgReturnPct||0)).slice(0, 15);

    function renderAssetTable(id, list) {
      const el = document.getElementById(id);
      if (!list.length) { el.innerHTML = '<tr><td colspan="4" class="empty">Waiting for outcome data...</td></tr>'; return; }
      el.innerHTML = list.map(a =>
        '<tr><td><strong>' + a.coin + '</strong></td>' +
        '<td class="num">' + a.count + '</td>' +
        '<td class="num ' + wrClass(a.winRate) + '">' + pct(a.winRate) + '</td>' +
        '<td class="num ' + retClass(a.avgReturnPct) + '">' + retPct(a.avgReturnPct) + '</td></tr>'
      ).join('');
    }
    renderAssetTable('top-assets', topAssets);
    renderAssetTable('worst-assets', worstAssets);

    // Recent signals with PFE/MAE
    renderRecent();

    // Methodology
    const methEl = document.getElementById('methodology');
    const m = d.methodology || {};
    if (Object.keys(m).length) {
      methEl.innerHTML = '<h3>How metrics are calculated</h3>' +
        Object.entries(m).map(([key, desc]) =>
          '<div class="metric"><span class="name">' + key.replace(/_/g, ' ') + '</span><span class="desc">' + desc + '</span></div>'
        ).join('');
    } else {
      methEl.innerHTML = '<p class="muted">Methodology data will appear once signals are evaluated.</p>';
    }

    document.getElementById('updated').textContent = 'Updated: ' + new Date().toLocaleString();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch(e) { document.getElementById('loading').textContent = 'Error: ' + e.message; }
}
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

// ── Smithery sandbox export ──
// Allows Smithery to scan tools/resources without starting the server.
// See https://smithery.ai/docs/deploy#sandbox-server
export function createSandboxServer() {
  return createServer();
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
