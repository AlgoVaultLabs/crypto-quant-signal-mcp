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
import {
  isStripeConfigured,
  constructWebhookEvent,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  createCheckoutSession,
  getCustomerApiKey,
} from './lib/stripe.js';
import { getTopAssetsByOI } from './lib/oi-ranking.js';

function createServer(): McpServer {
  const server = new McpServer({
    name: 'crypto-quant-signal-mcp',
    version: '1.5.0',
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
    res.json({ status: 'ok', server: 'crypto-quant-signal-mcp', version: '1.5.0', stripe: isStripeConfigured() });
  });

  // ── Stripe Webhook (raw body required — must be before express.json()) ──
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

    try {
      const event = constructWebhookEvent(req.body as Buffer, sig);
      if (!event) return res.status(400).json({ error: 'Stripe not configured' });

      switch (event.type) {
        case 'customer.subscription.created':
          await handleSubscriptionCreated(event);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event);
          break;
        default:
          console.log(`Stripe webhook: unhandled event ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook error:', err instanceof Error ? err.message : err);
      res.status(400).json({ error: 'Webhook verification failed' });
    }
  });

  // ── Signup (redirects to Stripe Checkout) ──
  app.get('/signup', async (req, res) => {
    const plan = req.query.plan as string;
    if (plan !== 'pro' && plan !== 'enterprise') {
      return res.status(400).send(getSignupPageHtml());
    }

    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const url = await createCheckoutSession(plan, baseUrl);
      if (!url) return res.status(500).send('Stripe not configured or missing price IDs');
      res.redirect(303, url);
    } catch (err) {
      console.error('Stripe checkout error:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to create checkout session');
    }
  });

  // ── Welcome (shows API key after successful checkout) ──
  app.get('/welcome', async (req, res) => {
    const sessionId = req.query.session_id as string;
    if (!sessionId) return res.status(400).send('Missing session_id');

    try {
      const { apiKey, tier, email } = await getCustomerApiKey(sessionId);
      res.send(getWelcomePageHtml(apiKey, tier, email));
    } catch (err) {
      console.error('Welcome page error:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to retrieve your API key. Please contact support@algovault.com');
    }
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

    // Top assets by OI (admin-only)
    app.get('/api/top-assets', async (req, res) => {
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
        || (req.query.key as string);
      if (token !== adminKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
        const assets = await getTopAssetsByOI(limit);
        res.json({ assets, count: assets.length, cachedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch OI ranking' });
      }
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
  .logo { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 28px; }
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
    <div class="card"><div class="label">Unique Sessions (All Time)</div><div class="value" id="sessions-all"></div></div>
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
    document.getElementById('sessions-all').textContent = d.uniqueSessions.allTime;
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
  h1 { font-size: 24px; font-weight: 700; }
  .subtitle { color: #6e7681; font-size: 12px; margin-top: 6px; letter-spacing: 0.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 18px; }
  .card .label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .card .sub { color: #8b949e; font-size: 11px; margin-top: 4px; }
  .green { color: #3fb950 !important; }
  .red { color: #f85149 !important; }
  .gold { color: #d29922 !important; }
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
  .empty { color: #8b949e; padding: 40px; text-align: center; font-size: 14px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid #30363d; background: #161b22; color: #8b949e; transition: all 0.15s; }
  .tab:hover { border-color: #58a6ff80; }
  .tab.active { background: #58a6ff20; color: #58a6ff; border-color: #58a6ff; }
  .filter-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
  .filter-row .label { font-size: 11px; color: #6e7681; text-transform: uppercase; letter-spacing: 1px; margin-right: 4px; }
  .tab.gold-active { background: #d2992220; color: #d29922; border-color: #d29922; }
  .tab.gold-active:hover { border-color: #d29922; }
  .methodology { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; font-size: 13px; line-height: 1.7; color: #c9d1d9; }
  .methodology p { margin-top: 12px; }
  .methodology p:first-child { margin-top: 0; }
  .methodology table { width: auto; background: transparent; border: none; margin-top: 8px; }
  .methodology table th { border: none; padding: 4px 24px 4px 0; color: #8b949e; font-weight: 600; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; background: transparent; }
  .methodology table td { border: none; padding: 3px 24px 3px 0; color: #c9d1d9; }
  .methodology table td:first-child { color: #8b949e; }
  .methodology code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="logo">
  <img src="/logo.png" width="36" height="36" style="border-radius:8px" onerror="this.style.display='none'">
  <div><h1>Signal Performance</h1><div class="subtitle">v1.5.0</div></div>
</div>
<div id="loading">Loading performance data...</div>
<div id="content" style="display:none">
  <!-- Asset Filter -->
  <div class="filter-row">
    <span class="label">Assets:</span>
    <div class="tab active" id="asset-all" onclick="setAssetFilter('all')">All Assets</div>
    <div class="tab" id="asset-top50" onclick="setAssetFilter('top50')">Top 50 OI</div>
    <span id="oi-status" style="font-size:11px;color:#6e7681;margin-left:4px"></span>
  </div>

  <!-- KPI Cards (3) -->
  <div class="grid">
    <div class="card"><div class="label">Total Signals</div><div class="value" id="total"></div><div class="sub" id="period"></div></div>
    <div class="card"><div class="label">Win Rate</div><div class="value" id="winrate"></div><div class="sub">1-Candle Direction Hit Rate</div></div>
    <div class="card"><div class="label">Profit Factor</div><div class="value" id="pf"></div><div class="sub">Total Profit / Total Loss</div></div>
  </div>

  <!-- Signal type breakdown -->
  <div class="section"><h2>By Signal Type</h2>
    <table>
      <thead><tr><th>Type</th><th class="num">Count</th><th class="num">Win Rate</th><th class="num">Avg Return</th><th>Bar</th></tr></thead>
      <tbody id="by-type"></tbody>
    </table>
  </div>

  <!-- Timeframe tabs + table -->
  <div class="section" id="tf-table-section">
    <h2>Performance by Timeframe</h2>
    <div class="tabs" id="tf-tabs"></div>
    <table>
      <thead><tr><th>Timeframe</th><th class="num">Signals</th><th class="num">Win Rate</th><th class="num">Avg Return</th><th class="num">Profit Factor</th></tr></thead>
      <tbody id="by-timeframe"></tbody>
    </table>
  </div>

  <div class="grid-2">
    <div class="section"><h2>Top Performing Assets</h2>
      <table>
        <thead><tr><th>Asset</th><th class="num">Signals</th><th class="num">Win Rate</th><th class="num">Avg Return</th></tr></thead>
        <tbody id="top-assets"></tbody>
      </table>
    </div>
    <div class="section"><h2>Worst Performing Assets</h2>
      <table>
        <thead><tr><th>Asset</th><th class="num">Signals</th><th class="num">Win Rate</th><th class="num">Avg Return</th></tr></thead>
        <tbody id="worst-assets"></tbody>
      </table>
    </div>
  </div>

  <!-- Recent signals -->
  <div class="section"><h2>Recent Signals</h2>
    <table>
      <thead><tr><th>Time</th><th>Asset</th><th>Signal</th><th class="num">Confidence</th><th class="num">Return (1c)</th></tr></thead>
      <tbody id="recent"></tbody>
    </table>
  </div>

  <!-- Methodology -->
  <div class="section">
    <h2>Methodology</h2>
    <div class="methodology" id="methodology">
      <p><strong>Win Rate</strong> = Total Wins / Total Signals after 1 candle.</p>
      <p><strong>Profit Factor</strong> = Total Profit / Total Loss at eval window close. [&gt;1.0 = profitable, &gt;2.0 = strong.]</p>
      <p><strong>Avg Return</strong> = Mean return per signal at eval window close.</p>
      <p style="margin-top:16px"><strong>Evaluation Windows</strong></p>
      <table>
        <thead><tr><th>Timeframe</th><th>Candles</th><th>Total Time</th></tr></thead>
        <tbody>
          <tr><td>5m</td><td>12</td><td>1 hour</td></tr>
          <tr><td>15m</td><td>12</td><td>3 hours</td></tr>
          <tr><td>30m</td><td>8</td><td>4 hours</td></tr>
          <tr><td>1h</td><td>8</td><td>8 hours</td></tr>
          <tr><td>2h</td><td>6</td><td>12 hours</td></tr>
          <tr><td>4h</td><td>6</td><td>24 hours</td></tr>
          <tr><td>8h</td><td>4</td><td>32 hours</td></tr>
          <tr><td>12h</td><td>4</td><td>48 hours</td></tr>
          <tr><td>1d</td><td>3</td><td>3 days</td></tr>
        </tbody>
      </table>
      <p style="margin-top:16px"><strong>Signal Filter</strong> = Only confidence &ge; 60% signals recorded. HOLDs excluded.</p>
      <p><strong>Data Source</strong> = Hyperliquid public API (<code>candleSnapshot</code> + <code>metaAndAssetCtxs</code>).</p>
    </div>
  </div>

  <div class="refresh">Auto-refreshes every 30s &middot; <span id="updated"></span></div>
</div>

<script>
const KEY = '${apiKey}';
const TF_ORDER = ['1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d'];
let activeTfFilter = 'all';
let activeAssetFilter = 'all';
let top50Coins = null; // null = not loaded yet, [] = loaded

function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : '\\u2014'; }
function retPct(v) { return v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '\\u2014'; }
function retClass(v) { return v != null ? (v >= 0 ? 'green' : 'red') : 'muted'; }
function wrClass(v) { return v != null ? (v >= 0.5 ? 'green' : v >= 0.3 ? 'gold' : 'red') : 'muted'; }
function pfClass(v) { return v != null ? (v >= 1.5 ? 'green' : v >= 1.0 ? 'gold' : 'red') : 'muted'; }
function badge(sig) { return '<span class="badge badge-' + sig.toLowerCase() + '">' + sig + '</span>'; }
function timeAgo(ts) {
  var s = Math.floor(Date.now()/1000 - ts);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function setTfFilter(tf) {
  activeTfFilter = tf;
  document.querySelectorAll('#tf-tabs .tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tf === tf); });
  renderAll();
}

async function setAssetFilter(mode) {
  activeAssetFilter = mode;
  document.getElementById('asset-all').className = 'tab' + (mode === 'all' ? ' active' : '');
  document.getElementById('asset-top50').className = 'tab' + (mode === 'top50' ? ' gold-active' : '');
  if (mode === 'top50' && top50Coins === null) {
    document.getElementById('oi-status').textContent = 'Loading...';
    try {
      var r = await fetch('/api/top-assets?key=' + KEY);
      var j = await r.json();
      top50Coins = j.assets.map(function(a) { return a.coin; });
      document.getElementById('oi-status').textContent = top50Coins.length + ' coins loaded';
    } catch(e) {
      document.getElementById('oi-status').textContent = 'Failed to load OI data';
      activeAssetFilter = 'all';
      document.getElementById('asset-all').className = 'tab active';
      document.getElementById('asset-top50').className = 'tab';
      return;
    }
  }
  if (mode === 'top50' && top50Coins) {
    document.getElementById('oi-status').textContent = top50Coins.length + ' coins';
  } else {
    document.getElementById('oi-status').textContent = '';
  }
  renderAll();
}

var cachedData = null;

function pnlDir(s) { var r = s.outcome_return_pct || 0; return Math.max(s.signal === 'SELL' ? -r : r, -100); }

function getFilteredSignals() {
  var all = cachedData ? (cachedData.recentSignals || []) : [];
  if (activeAssetFilter === 'top50' && top50Coins) {
    return all.filter(function(s) { return top50Coins.indexOf(s.coin) !== -1; });
  }
  return all;
}

function recomputeOverall(signals) {
  var nonHold = signals.filter(function(s) { return s.signal !== 'HOLD'; });
  var eval1c = nonHold.filter(function(s) { return s.return_1candle != null; });
  var wins1c = eval1c.filter(function(s) { return s.return_1candle > 0; });
  var wr = eval1c.length > 0 ? wins1c.length / eval1c.length : null;
  var evalEW = nonHold.filter(function(s) { return s.outcome_return_pct != null; });
  var returns = evalEW.map(pnlDir);
  var gp = returns.filter(function(r) { return r > 0; }).reduce(function(a,b){return a+b;}, 0);
  var gl = Math.abs(returns.filter(function(r) { return r < 0; }).reduce(function(a,b){return a+b;}, 0));
  var pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : null);
  return { totalEvaluated: eval1c.length, total: signals.length, winRate: wr, profitFactor: pf };
}

function recomputeTF(signals) {
  var nonHold = signals.filter(function(s) { return s.signal !== 'HOLD'; });
  var tfs = {};
  nonHold.forEach(function(s) { if (!tfs[s.timeframe]) tfs[s.timeframe] = []; tfs[s.timeframe].push(s); });
  var result = {};
  Object.keys(tfs).forEach(function(tf) {
    var group = tfs[tf];
    var e1c = group.filter(function(s) { return s.return_1candle != null; });
    var w1c = e1c.filter(function(s) { return s.return_1candle > 0; });
    var eEW = group.filter(function(s) { return s.outcome_return_pct != null; });
    var rets = eEW.map(pnlDir);
    var gp = rets.filter(function(r){return r>0;}).reduce(function(a,b){return a+b;},0);
    var gl = Math.abs(rets.filter(function(r){return r<0;}).reduce(function(a,b){return a+b;},0));
    var pf = gl > 0 ? gp/gl : (gp > 0 ? Infinity : null);
    var avg = rets.length > 0 ? rets.reduce(function(a,b){return a+b;},0)/rets.length : null;
    result[tf] = { count: Math.max(e1c.length, eEW.length), winRate: e1c.length > 0 ? w1c.length/e1c.length : null, avgReturnPct: avg, profitFactor: pf };
  });
  return result;
}

function renderSignalTypes() {
  if (!cachedData) return;
  var allSignals = getFilteredSignals();
  var typeEl = document.getElementById('by-type');
  var typeCounts = {};
  ['BUY','SELL','HOLD'].forEach(function(type) {
    var group = allSignals.filter(function(s) { return s.signal === type; });
    var evalGroup = group.filter(function(s) { return s.return_1candle != null && type !== 'HOLD'; });
    var winsGroup = evalGroup.filter(function(s) { return s.return_1candle > 0; });
    var ewGroup = group.filter(function(s) { return s.outcome_return_pct != null && type !== 'HOLD'; });
    var returnsGroup = ewGroup.map(pnlDir);
    typeCounts[type] = {
      count: type === 'HOLD' ? group.length : evalGroup.length,
      winRate: type === 'HOLD' ? null : (evalGroup.length > 0 ? winsGroup.length / evalGroup.length : null),
      avgReturnPct: type === 'HOLD' ? null : (returnsGroup.length > 0 ? returnsGroup.reduce(function(a,b){return a+b;},0)/returnsGroup.length : null),
    };
  });
  var types = Object.entries(typeCounts);
  if (types.length) {
    var maxCount = Math.max.apply(null, types.map(function(e) { return e[1].count; }));
    typeEl.innerHTML = types.map(function(e) {
      var type = e[0], v = e[1];
      return '<tr><td>' + badge(type) + '</td>' +
        '<td class="num">' + v.count + '</td>' +
        '<td class="num ' + wrClass(v.winRate) + '">' + pct(v.winRate) + '</td>' +
        '<td class="num ' + retClass(v.avgReturnPct) + '">' + retPct(v.avgReturnPct) + '</td>' +
        '<td><div class="bar-wrap"><div class="bar b" style="width:' + (maxCount > 0 ? Math.round(v.count/maxCount*100) : 0) + '%"></div></div></td></tr>';
    }).join('');
  } else {
    typeEl.innerHTML = '<tr><td colspan="5" class="empty">No signals yet</td></tr>';
  }
}

function renderAll() {
  var d = cachedData;
  if (!d) return;

  var allSignals = getFilteredSignals();
  var useRecomputed = activeAssetFilter === 'top50';
  var overallStats = useRecomputed ? recomputeOverall(allSignals) : d.overall;
  var tfStats = useRecomputed ? recomputeTF(allSignals) : d.byTimeframe;

  // KPIs — update for selected TF
  if (activeTfFilter === 'all') {
    document.getElementById('total').textContent = (overallStats.totalEvaluated || overallStats.total || d.totalSignals || 0).toLocaleString();
    document.getElementById('period').textContent = d.period ? d.period.from + ' \\u2192 ' + d.period.to : '';
    var wr = overallStats.winRate;
    var wrEl = document.getElementById('winrate');
    wrEl.textContent = pct(wr);
    wrEl.className = 'value ' + wrClass(wr);
    var pf = overallStats.profitFactor;
    var pfEl = document.getElementById('pf');
    pfEl.textContent = pf != null ? pf.toFixed(2) : '\\u2014';
    pfEl.className = 'value ' + pfClass(pf);
  } else {
    var v = (tfStats || {})[activeTfFilter];
    if (v) {
      document.getElementById('total').textContent = (v.count || 0).toLocaleString();
      document.getElementById('period').textContent = activeTfFilter + ' timeframe';
      var wr2 = v.winRate;
      var wrEl2 = document.getElementById('winrate');
      wrEl2.textContent = pct(wr2);
      wrEl2.className = 'value ' + wrClass(wr2);
      var pf2 = v.profitFactor;
      var pfEl2 = document.getElementById('pf');
      pfEl2.textContent = pf2 != null ? pf2.toFixed(2) : '\\u2014';
      pfEl2.className = 'value ' + pfClass(pf2);
    }
  }

  // TF table
  var tfEl = document.getElementById('by-timeframe');
  var timeframes = tfStats ? Object.entries(tfStats) : [];
  var filtered = activeTfFilter === 'all' ? timeframes : timeframes.filter(function(e) { return e[0] === activeTfFilter; });
  if (filtered.length) {
    var sorted = filtered.sort(function(a,b) { return TF_ORDER.indexOf(a[0]) - TF_ORDER.indexOf(b[0]); });
    tfEl.innerHTML = sorted.map(function(e) {
      var tf = e[0], v = e[1];
      return '<tr><td><strong>' + tf + '</strong></td>' +
        '<td class="num">' + v.count + '</td>' +
        '<td class="num ' + wrClass(v.winRate) + '">' + pct(v.winRate) + '</td>' +
        '<td class="num ' + retClass(v.avgReturnPct) + '">' + retPct(v.avgReturnPct) + '</td>' +
        '<td class="num ' + pfClass(v.profitFactor) + '">' + (v.profitFactor != null ? v.profitFactor.toFixed(2) : '\\u2014') + '</td></tr>';
    }).join('');
  } else {
    tfEl.innerHTML = '<tr><td colspan="5" class="empty">No data for this timeframe</td></tr>';
  }

  // Assets — filter by TF
  var tfSignals = activeTfFilter === 'all' ? allSignals : allSignals.filter(function(s) { return s.timeframe === activeTfFilter; });
  var nonHoldSignals = tfSignals.filter(function(s) { return s.signal !== 'HOLD'; });

  function computeAssets(signals) {
    var map = {};
    signals.forEach(function(s) {
      if (!map[s.coin]) map[s.coin] = { coin: s.coin, count: 0, wins: 0, evaluated: 0, returns: [] };
      var a = map[s.coin];
      if (s.return_1candle != null) { a.evaluated++; if (s.return_1candle > 0) a.wins++; }
      if (s.outcome_return_pct != null) {
        var r = s.signal === 'SELL' ? -s.outcome_return_pct : s.outcome_return_pct;
        r = Math.max(r, -100);
        a.returns.push(r);
        a.count++;
      }
    });
    return Object.values(map).filter(function(a) { return a.returns.length > 0; }).map(function(a) {
      var avg = a.returns.reduce(function(x,y){return x+y;}, 0) / a.returns.length;
      return { coin: a.coin, count: a.count, winRate: a.evaluated > 0 ? a.wins / a.evaluated : null, avgReturnPct: avg };
    });
  }
  var assets = computeAssets(nonHoldSignals);
  var topAssets = assets.slice().sort(function(a,b) { return (b.avgReturnPct||0) - (a.avgReturnPct||0); }).slice(0, 15);
  var worstAssets = assets.slice().sort(function(a,b) { return (a.avgReturnPct||0) - (b.avgReturnPct||0); }).slice(0, 15);
  function renderAssetTable(id, list) {
    var el = document.getElementById(id);
    if (!list.length) { el.innerHTML = '<tr><td colspan="4" class="empty">Waiting for outcome data...</td></tr>'; return; }
    el.innerHTML = list.map(function(a) {
      return '<tr><td><strong>' + a.coin + '</strong></td>' +
        '<td class="num">' + a.count + '</td>' +
        '<td class="num ' + wrClass(a.winRate) + '">' + pct(a.winRate) + '</td>' +
        '<td class="num ' + retClass(a.avgReturnPct) + '">' + retPct(a.avgReturnPct) + '</td></tr>';
    }).join('');
  }
  renderAssetTable('top-assets', topAssets);
  renderAssetTable('worst-assets', worstAssets);

  // Recent signals (show latest 20)
  var recentEl = document.getElementById('recent');
  var recent = tfSignals.slice(0, 20);
  if (recent.length) {
    recentEl.innerHTML = recent.map(function(s) {
      return '<tr>' +
        '<td class="muted">' + timeAgo(s.created_at) + '</td>' +
        '<td><strong>' + s.coin + '</strong></td>' +
        '<td>' + badge(s.signal) + '</td>' +
        '<td class="num">' + s.confidence + '%</td>' +
        '<td class="num ' + retClass(s.return_1candle) + '">' + (s.return_1candle != null ? retPct(s.return_1candle) : '<span class="muted">\\u2026</span>') + '</td></tr>';
    }).join('');
  } else {
    recentEl.innerHTML = '<tr><td colspan="5" class="empty">No signals' + (activeTfFilter !== 'all' ? ' for ' + activeTfFilter : '') + ' yet.</td></tr>';
  }
}

async function load() {
  try {
    var r = await fetch('/performance?key=' + KEY);
    var d = await r.json();
    cachedData = d;

    // TF tabs (use tfStats which respects asset filter)
    var tabsEl = document.getElementById('tf-tabs');
    var filteredSigs = getFilteredSignals();
    var tfStatsForTabs = (activeAssetFilter === 'top50') ? recomputeTF(filteredSigs) : d.byTimeframe;
    var availTfs = tfStatsForTabs ? Object.keys(tfStatsForTabs).sort(function(a,b) { return TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b); }) : [];
    tabsEl.innerHTML = '<div class="tab' + (activeTfFilter === 'all' ? ' active' : '') + '" data-tf="all" onclick="setTfFilter(\\'all\\')">All</div>' +
      availTfs.map(function(tf) { return '<div class="tab' + (activeTfFilter === tf ? ' active' : '') + '" data-tf="' + tf + '" onclick="setTfFilter(\\'' + tf + '\\')">' + tf + '</div>'; }).join('');

    renderSignalTypes();
    renderAll();

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

// ── Signup Page HTML ──

function getSignupPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlgoVault — Subscribe</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; }
  .container { max-width: 720px; width: 100%; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: #8b949e; margin-bottom: 32px; font-size: 14px; }
  .plans { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 600px) { .plans { grid-template-columns: 1fr; } }
  .plan { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; }
  .plan h2 { font-size: 20px; margin-bottom: 4px; }
  .plan .price { font-size: 36px; font-weight: 700; color: #58a6ff; margin: 12px 0; }
  .plan .price span { font-size: 16px; font-weight: 400; color: #8b949e; }
  .plan ul { list-style: none; margin: 16px 0 24px; }
  .plan ul li { padding: 4px 0; color: #c9d1d9; font-size: 14px; }
  .plan ul li::before { content: '\\2713'; color: #3fb950; margin-right: 8px; }
  .btn { display: inline-block; background: #238636; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 16px; font-weight: 600; transition: background 0.15s; }
  .btn:hover { background: #2ea043; }
  .btn.ent { background: #8957e5; }
  .btn.ent:hover { background: #a371f7; }
</style>
</head>
<body>
<div class="container">
  <h1>AlgoVault Subscriptions</h1>
  <div class="subtitle">Unlock all assets, all timeframes, and higher call limits.</div>
  <div class="plans">
    <div class="plan">
      <h2>Pro</h2>
      <div class="price">$49<span>/mo</span></div>
      <ul>
        <li>15,000 calls/month</li>
        <li>All assets (SOL, ARB, DOGE...)</li>
        <li>All timeframes (1m to 1d)</li>
        <li>Priority support</li>
      </ul>
      <a class="btn" href="/signup?plan=pro">Subscribe to Pro</a>
    </div>
    <div class="plan">
      <h2>Enterprise</h2>
      <div class="price">$299<span>/mo</span></div>
      <ul>
        <li>100,000 calls/month</li>
        <li>All assets &amp; timeframes</li>
        <li>SLA guarantee</li>
        <li>Dedicated support</li>
      </ul>
      <a class="btn ent" href="/signup?plan=enterprise">Subscribe to Enterprise</a>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── Welcome Page HTML ──

function getWelcomePageHtml(apiKey: string | null, tier: string | null, email: string | null): string {
  const keyDisplay = apiKey
    ? `<div class="key-box"><div class="label">Your API Key</div><code id="api-key">${apiKey}</code><button onclick="navigator.clipboard.writeText(document.getElementById('api-key').textContent);this.textContent='Copied!'">Copy</button></div>`
    : `<div class="pending"><p>Your API key is being provisioned. This usually takes a few seconds.</p><p>Refresh this page in a moment, or check your email at <strong>${email || 'your registered address'}</strong>.</p></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to AlgoVault ${tier ? `(${tier})` : ''}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; }
  .container { max-width: 560px; width: 100%; text-align: center; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: #8b949e; margin-bottom: 32px; font-size: 14px; }
  .key-box { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: left; }
  .key-box .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .key-box code { display: block; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 12px 16px; font-size: 16px; color: #3fb950; word-break: break-all; margin-bottom: 12px; }
  .key-box button { background: #238636; color: #fff; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .key-box button:hover { background: #2ea043; }
  .pending { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; margin: 24px 0; color: #d29922; }
  .usage { margin-top: 24px; text-align: left; }
  .usage h2 { font-size: 16px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .usage pre { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; font-size: 13px; overflow-x: auto; color: #c9d1d9; }
</style>
</head>
<body>
<div class="container">
  <h1>Welcome to AlgoVault! &#x1f389;</h1>
  <div class="subtitle">${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) + ' plan activated' : 'Setting up your account...'}</div>
  ${keyDisplay}
  <div class="usage">
    <h2>Quick Start</h2>
    <pre>curl -X POST https://api.algovault.com/mcp \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"jsonrpc":"2.0","method":"tools/call",
       "params":{"name":"get_trade_signal",
                 "arguments":{"coin":"SOL","timeframe":"5m"}},
       "id":1}'</pre>
  </div>
</div>
</body>
</html>`;
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
