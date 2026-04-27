#!/usr/bin/env node

/**
 * crypto-quant-signal-mcp — Dual transport MCP server.
 *
 * Default: Streamable HTTP on port 3000 (remote server mode)
 * Optional: stdio transport via TRANSPORT=stdio env var (local npx use)
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getTradeSignal } from './tools/get-trade-signal.js';
import { scanFundingArb } from './tools/scan-funding-arb.js';
import { getMarketRegime } from './tools/get-market-regime.js';
import { getSignalPerformance, runBackfill } from './resources/signal-performance.js';
import { refreshGridIfStale } from './lib/cross-asset-grid.js';
import { closeDb, getConfidenceBands, getHoldStats, getMerkleBatches, getSignalWithBatch, upsertAgentSession, getSampleSignalsFromLatestBatch } from './lib/performance-db.js';
import { PKG_VERSION } from './lib/pkg-version.js';
import { verifyProof } from './lib/merkle.js';
import { warmTierCaches } from './lib/asset-tiers.js';
import { resolveLicense, resolveLicenseSync, requestContext, getRequestLicense, getRequestSessionId, getRequestIpHash, getRequestVerdict, setRequestVerdict, initQuotaDb } from './lib/license.js';
import { initX402, settleX402Async } from './lib/x402.js';
import { initAnalytics, logRequest, hashIp, getUsageStats, logSkillInvocation } from './lib/analytics.js';
import { getAnalyticsSummary } from './resources/analytics-summary.js';
import { getSkillsAnalytics } from './resources/skills-analytics.js';
import {
  isStripeConfigured,
  constructWebhookEvent,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  createCheckoutSession,
  getCustomerApiKey,
} from './lib/stripe.js';
import { getTopAssetsByOI } from './lib/oi-ranking.js';

/** Timing-safe string comparison to prevent side-channel attacks on admin key. */
function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'crypto-quant-signal-mcp',
    version: PKG_VERSION,
  });

  // ── Tool 1: get_trade_signal ──
  server.tool(
    'get_trade_signal',
    "Returns a composite BUY/SELL/HOLD signal for a Hyperliquid perp. Combines RSI(14), EMA(9/21) crossover, funding rate, OI momentum, and volume into a weighted score with confidence percentage.",
    {
      coin: z.string().max(20).describe("Asset symbol, e.g. 'ETH', 'BTC', 'SOL'"),
      timeframe: z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']).default('15m').describe('Candle timeframe. All Hyperliquid intervals supported. 1m/3m for HFT scalping, 5m/15m for intraday agents (most popular), 30m/1h/2h for swing, 4h/8h/12h/1d for position trading. Free tier: 15m and 1h only.'),
      includeReasoning: z.boolean().default(true).describe('Include human-readable reasoning'),
      exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET']).default('HL').describe("Exchange to analyze. 'HL' = Hyperliquid (default), 'BINANCE' = Binance USDT-M Futures, 'BYBIT' = Bybit Linear, 'OKX' = OKX Swap, 'BITGET' = Bitget USDT-M."),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ coin, timeframe, includeReasoning, exchange }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        const result = await getTradeSignal({ coin, timeframe, includeReasoning, exchange, license });
        // Verdict stored for x402 settlement skip (HOLDs don't settle)
        setRequestVerdict(result.signal);
        // Quota tracking is handled inside getTradeSignal (HOLDs are free)
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
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: 'get_trade_signal',
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
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
      // DoS-prevention bounds (delta audit 2026-04-15): minSpreadBps clamped to
      // [0, 10000] bps (0-100%), limit clamped to [1, 200] integers. Paid tier
      // downstream clamp via getFundingArbLimit() is preserved; these are the
      // hard boundary validation at the handler edge.
      minSpreadBps: z.number().min(0).max(10_000).default(5).describe('Minimum spread in basis points to include (0-10000)'),
      limit: z.number().int().min(1).max(200).default(10).describe('Max results 1-200 (free: max 5)'),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ minSpreadBps, limit }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Quota tracking is handled inside scanFundingArb
        const result = await scanFundingArb({ minSpreadBps, limit, license });
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'scan_funding_arb',
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
        });
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: 'scan_funding_arb',
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
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
      coin: z.string().max(20).describe("Asset symbol, e.g. 'BTC', 'ETH', 'SOL'"),
      timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe('Candle timeframe'),
      exchange: z.enum(['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET']).default('HL').describe("Exchange to analyze. 'HL' = Hyperliquid (default), 'BINANCE' = Binance USDT-M Futures, 'BYBIT' = Bybit Linear, 'OKX' = OKX Swap, 'BITGET' = Bitget USDT-M."),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ coin, timeframe, exchange }) => {
      const startMs = Date.now();
      try {
        const license = getRequestLicense();
        // Quota tracking is handled inside getMarketRegime
        const result = await getMarketRegime({ coin, timeframe, exchange });
        logRequest({
          sessionId: getRequestSessionId(),
          toolName: 'get_market_regime',
          asset: coin,
          timeframe,
          licenseTier: license.tier,
          responseTimeMs: Date.now() - startMs,
          ipHash: getRequestIpHash(),
        });
        const sessionIdForCohort = getRequestSessionId() ?? null;
        if (sessionIdForCohort !== null) {
          upsertAgentSession({
            sessionId: sessionIdForCohort,
            tool: 'get_market_regime',
            tier: license.tier,
            ipHash: getRequestIpHash() ?? null,
          }).catch((e) => console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e));
        }
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

  // signal-performance resource: PFE win rate only.
  // Non-negotiable for every signal-producing tool per AlgoVault build rules.
  // Re-registered after earlier refactor removed the server.resource() call.
  // Import at line 17 (getSignalPerformance, runBackfill) is already present.
  // NOTE: Outcome-based WR (from Phase E, outcome_return_pct) is INTERNAL to
  // AlgoVault's quant engine — never exposed via MCP or any public surface.
  server.resource(
    'signal-performance',
    'performance://signal-performance',
    { description: 'Signal track record — PFE win rates by timeframe, asset, tier, and signal type. Measures whether price moved in the signal direction during the evaluation window.' },
    async () => {
      const stats = await getSignalPerformance();
      return {
        contents: [{
          uri: 'performance://signal-performance',
          text: JSON.stringify(stats, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  // ── Resource: skills-analytics (PUBLIC — slug-level aggregates, no user data) ──
  // C6 (algovault-skills SKILLS-W1) — surfaces per-Skill call counts so any
  // agent can see which Skills drive volume. Public-safe: slugs are public
  // artifacts (visible in github.com/AlgoVaultLabs/algovault-skills/skills/).
  server.resource(
    'skills-analytics',
    'analytics://skills',
    { description: 'Per-Skill invocation counters (calls_24h, calls_7d, calls_all_time, first/last seen) for the algovault-skills plugin. Public — slug-level aggregates only.' },
    async () => {
      const stats = await getSkillsAnalytics();
      return {
        contents: [{
          uri: 'analytics://skills',
          text: JSON.stringify(stats, null, 2),
          mimeType: 'application/json',
        }],
      };
    }
  );

  return server;
}

// ── Stdio Mode ──
async function startStdio() {
  initAnalytics();
  initQuotaDb();
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
  initQuotaDb();

  const { default: express } = await import('express');
  const { default: rateLimit } = await import('express-rate-limit');

  const app = express();
  app.set('trust proxy', 1); // Trust Caddy reverse proxy for req.secure, req.ip
  const port = parseInt(process.env.PORT || '3000', 10);

  // CORS — restrict to same-origin + algovault.com
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'https://api.algovault.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-payment, mcp-session-id, x-algovault-skill-slug');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Rate limiting
  app.use('/mcp', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
  app.use('/analytics', rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));
  app.use('/webhooks', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

  // Store active transports for session management (with last-activity tracking)
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActivity = new Map<string, number>();
  const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  // Periodic cleanup of stale sessions (every 5 minutes)
  const sessionCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, lastActive] of sessionLastActivity) {
      if (now - lastActive > SESSION_TTL_MS) {
        const transport = transports.get(sid);
        if (transport) {
          transport.close?.();
          transports.delete(sid);
        }
        sessionLastActivity.delete(sid);
        console.debug(`Session ${sid.slice(0, 8)}... evicted (idle ${Math.round((now - lastActive) / 60_000)}m)`);
      }
    }
  }, 5 * 60 * 1000);

  // Glama.ai ownership verification
  app.get('/.well-known/glama.json', (_req, res) => {
    res.json({
      $schema: 'https://glama.ai/mcp/schemas/connector.json',
      maintainers: [{ email: 'admin@algovault.com' }],
    });
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'crypto-quant-signal-mcp', version: PKG_VERSION, stripe: isStripeConfigured() });
  });

  // ── Integration tutorial mirrors (INTEGRATIONS-W1 C6) ──
  // Static HTML pre-rendered from algovault-skills/docs/integrations/<x>.md
  // by scripts/render-integrations.mjs. Allowlist-only: anything outside the
  // 4-exchange set 404s (no path traversal risk; no fs lookups for unknown
  // slugs). Caddy routes /docs/integrations/* here ahead of the static
  // catch-all (see Caddyfile algovault.com block).
  //
  // CJS-friendly path resolution (matches src/lib/pkg-version.ts pattern):
  // tsconfig targets CommonJS via Node16, so __dirname is available natively
  // and `import.meta.url` is forbidden. Read each mirror once at startup
  // into INTEGRATION_HTML so per-request overhead is a Map.get(), no fs hit.
  const INTEGRATION_EXCHANGES = ['binance', 'okx', 'bybit', 'bitget'] as const;
  const INTEGRATION_HTML = new Map<string, string>();
  {
    // dist/index.js → ../landing/integrations
    const integrationsDir = path.resolve(__dirname, '..', 'landing', 'integrations');
    for (const ex of INTEGRATION_EXCHANGES) {
      try {
        INTEGRATION_HTML.set(ex, fs.readFileSync(path.join(integrationsDir, `${ex}.html`), 'utf8'));
      } catch (err) {
        console.warn(`integration mirror ${ex}.html not loaded at startup:`, err instanceof Error ? err.message : err);
      }
    }
  }
  app.get('/docs/integrations/:exchange', (req, res) => {
    const exchange = (req.params.exchange || '').toLowerCase().replace(/\.html$/, '');
    const html = INTEGRATION_HTML.get(exchange);
    if (!html) {
      return res.status(404).type('text/plain').send('Integration not found');
    }
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.type('text/html').send(html);
  });

  // ── /skills page (WEBSITE-REFRESH-W1 C4) ──
  // Pre-loaded at startup into a string for zero-fs-hit per-request serving.
  // Same CJS __dirname pattern as the integration mirrors above (see
  // src/lib/pkg-version.ts:10 for the canonical "no import.meta.url under
  // CJS tsconfig" gotcha + fix).
  let SKILLS_HTML: string | null = null;
  try {
    SKILLS_HTML = fs.readFileSync(path.resolve(__dirname, '..', 'landing', 'skills.html'), 'utf8');
  } catch (err) {
    console.warn('skills.html not loaded at startup:', err instanceof Error ? err.message : err);
  }
  app.get('/skills', (_req, res) => {
    if (!SKILLS_HTML) {
      return res.status(500).type('text/plain').send('skills page not available');
    }
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.type('text/html').send(SKILLS_HTML);
  });

  // ── /integrations index page (WEBSITE-REFRESH-CLEANUP-W1 R4) ──
  // Manifest-driven listing of all integrations (mirrors the /skills pattern).
  // Pre-loaded at startup into a string for zero-fs-hit per-request serving.
  // Caddy routes /integrations here ahead of the static catch-all so future
  // edits to landing/integrations.html don't require a Caddy reload.
  let INTEGRATIONS_INDEX_HTML: string | null = null;
  try {
    INTEGRATIONS_INDEX_HTML = fs.readFileSync(path.resolve(__dirname, '..', 'landing', 'integrations.html'), 'utf8');
  } catch (err) {
    console.warn('integrations.html not loaded at startup:', err instanceof Error ? err.message : err);
  }
  app.get('/integrations', (_req, res) => {
    if (!INTEGRATIONS_INDEX_HTML) {
      return res.status(500).type('text/plain').send('integrations page not available');
    }
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.type('text/html').send(INTEGRATIONS_INDEX_HTML);
  });

  // (REMOVED 2026-04-24) Public per-Skill analytics page. Per-Skill funnel data
  // is competitive intel, not public moat-proof. Migrated to admin-gated tab on
  // /dashboard. New endpoint: /dashboard/api/skills-analytics (JSON, admin-only).
  // The X-AlgoVault-Skill-Slug header interceptor in app.all('/mcp', ...) is
  // UNTOUCHED — slug logging continues; only the public surface was removed.

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
    if (plan !== 'starter' && plan !== 'pro' && plan !== 'enterprise') {
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
  let adminCleanupInterval: ReturnType<typeof setInterval> | undefined;
  const adminKeyRaw = process.env.ADMIN_API_KEY;
  if (adminKeyRaw) {
    const adminKey: string = adminKeyRaw;
    // Admin session management — avoids embedding the key in dashboard HTML
    const adminSessions = new Map<string, number>(); // token → expiresAt
    const ADMIN_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
    const ADMIN_COOKIE_NAME = 'av_admin_session';

    // Periodic cleanup of expired admin sessions (every 30 minutes)
    adminCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [token, expiresAt] of adminSessions) {
        if (now > expiresAt) adminSessions.delete(token);
      }
    }, 30 * 60 * 1000);

    function createAdminSession(): string {
      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL);
      return token;
    }

    function isValidAdminSession(cookieHeader?: string): boolean {
      if (!cookieHeader) return false;
      const match = cookieHeader.match(new RegExp(`${ADMIN_COOKIE_NAME}=([a-f0-9]+)`));
      if (!match) return false;
      const token = match[1];
      const expiresAt = adminSessions.get(token);
      if (!expiresAt || Date.now() > expiresAt) {
        adminSessions.delete(token);
        return false;
      }
      return true;
    }

    /** Check admin auth: Bearer token, query key, or session cookie. */
    function isAdminAuthorized(req: import('express').Request): boolean {
      // Bearer token or query key
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
        || (req.query.key as string);
      if (token && safeCompare(token, adminKey)) return true;
      // Session cookie
      return isValidAdminSession(req.headers.cookie);
    }

    // JSON API
    app.get('/analytics', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const stats = await getUsageStats();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch analytics' });
      }
    });

    // Visual dashboard — key in URL sets a session cookie, then redirects to clean URL
    app.get('/dashboard', (req, res) => {
      const key = req.query.key as string;
      if (key && safeCompare(key, adminKey)) {
        // Authenticate: set session cookie, redirect to clean URL
        const sessionToken = createAdminSession();
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL / 1000}${req.secure ? '; Secure' : ''}`);
        return res.redirect(303, '/dashboard');
      }
      if (!isValidAdminSession(req.headers.cookie)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      res.send(getDashboardHtml());
    });

    // Signal performance JSON (admin-only)
    app.get('/performance', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const [stats, holdStats] = await Promise.all([getSignalPerformance(), getHoldStats()]);
        res.json({ ...stats, ...holdStats });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch performance stats' });
      }
    });

    // Skills analytics JSON (admin-only) — backs the Skills section of /dashboard.
    // Same data the previous public /analytics/skills page consumed; that public
    // route is being removed in the same wave (per Data Integrity two-commit
    // pattern: this admin endpoint ships first, public is stripped in commit 2).
    // Auth: shared isAdminAuthorized — Bearer header OR ?key= query OR admin cookie.
    app.get('/dashboard/api/skills-analytics', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const stats = await getSkillsAnalytics();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch skills analytics' });
      }
    });

    // Signal performance dashboard (admin-only)
    app.get('/performance-dashboard', (req, res) => {
      const key = req.query.key as string;
      if (key && safeCompare(key, adminKey)) {
        const sessionToken = createAdminSession();
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL / 1000}${req.secure ? '; Secure' : ''}`);
        return res.redirect(303, '/performance-dashboard');
      }
      if (!isValidAdminSession(req.headers.cookie)) {
        return res.status(401).send('Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL');
      }
      res.send(getPerformanceDashboardHtml());
    });

    // Top assets by OI (admin-only)
    app.get('/api/top-assets', async (req, res) => {
      if (!isAdminAuthorized(req)) {
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

    // Confidence band analysis (admin-only)
    app.get('/api/confidence-bands', async (req, res) => {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const bands = await getConfidenceBands();
        res.json({ bands, generatedAt: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch confidence bands' });
      }
    });
  }

  // ── Public track record (no auth) ──
  // WEBSITE-REFRESH-CLEANUP-W1 R2: also returns `hold_rate` (computed from
  // existing totalHolds + totalSignals — additive only, no consumer breakage).
  // hold_rate = totalHolds / (totalHolds + totalSignals) * 100, rounded to 1
  // decimal place. Powers the live Pricing M3 badge ("XX.X% HOLD rate") via
  // landing/js/track-record-proxy.js, replacing the prior hardcoded "93%".
  app.get('/api/performance-public', async (_req, res) => {
    try {
      const [stats, holdStats] = await Promise.all([getSignalPerformance(), getHoldStats()]);
      const totalHolds = holdStats.totalHolds || 0;
      const totalSignals = stats.totalSignals || 0;
      const denom = totalHolds + totalSignals;
      const hold_rate = denom > 0 ? Math.round((totalHolds / denom) * 1000) / 10 : 0;
      res.json({ ...stats, ...holdStats, hold_rate });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch performance stats' });
    }
  });

  app.get('/api/confidence-bands-public', async (_req, res) => {
    try {
      const bands = await getConfidenceBands();
      res.json({ bands, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch confidence bands' });
    }
  });

  app.get('/track-record', (_req, res) => {
    res.send(getPerformanceDashboardHtml({ isPublic: true }));
  });

  // ── Merkle verification endpoints (public, no auth) ──
  const MERKLE_CONTRACT_ADDR = process.env.MERKLE_CONTRACT_ADDRESS || '';

  app.get('/api/verify-signal', async (req, res) => {
    const signalId = parseInt(req.query.signalId as string);
    if (!signalId || isNaN(signalId)) {
      return res.status(400).json({ error: 'signalId required (integer)' });
    }
    try {
      const s = await getSignalWithBatch(signalId);
      if (!s) return res.status(404).json({ error: 'Signal not found' });

      if (!s.signal_hash || !s.merkle_batch_id) {
        return res.json({
          verified: false,
          reason: 'Signal not yet included in a Merkle batch',
          signal: { id: s.id, coin: s.coin, direction: s.signal, confidence: s.confidence },
        });
      }

      const proof = typeof s.merkle_proof === 'string' ? JSON.parse(s.merkle_proof) : s.merkle_proof;
      const isValid = verifyProof(s.signal_hash as `0x${string}`, proof, s.merkle_root as `0x${string}`);

      res.json({
        verified: isValid,
        signal: {
          id: s.id, coin: s.coin, direction: s.signal, confidence: s.confidence,
          timeframe: s.timeframe, price: s.price_at_signal, timestamp: s.created_at, hash: s.signal_hash,
        },
        batch: {
          id: s.merkle_batch_id, root: s.merkle_root, signalCount: s.signal_count,
          txHash: s.tx_hash, blockNumber: s.block_number, publishedAt: s.published_at,
          basescanUrl: `https://basescan.org/tx/${s.tx_hash}`,
        },
        proof,
        contractAddress: MERKLE_CONTRACT_ADDR,
        howToVerify: 'Check the Merkle root on-chain at the contract address on Base. The signal hash + proof should reconstruct the published root.',
      });
    } catch {
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  app.get('/api/merkle-batches', async (_req, res) => {
    try {
      const batches = await getMerkleBatches();
      res.json({
        batches: batches.map((b: any) => ({
          ...b,
          basescanUrl: `https://basescan.org/tx/${b.tx_hash}`,
        })),
        contractAddress: MERKLE_CONTRACT_ADDR,
        chain: 'Base (8453)',
      });
    } catch {
      res.status(500).json({ error: 'Failed to load batches' });
    }
  });

  // Verify sample IDs — 5 signals from the latest Merkle batch for the /verify Try-It pills
  let verifySampleCache: { batchId: number | null; data: unknown } = { batchId: -1, data: null };
  app.get('/api/verify-sample-ids', async (_req, res) => {
    try {
      const result = await getSampleSignalsFromLatestBatch(5);
      // Cache by batchId — only recompute when a new batch lands
      if (result.batchId !== verifySampleCache.batchId) {
        verifySampleCache = { batchId: result.batchId, data: result };
      }
      res.json(verifySampleCache.data);
    } catch {
      res.status(500).json({ error: 'Failed to load verify samples' });
    }
  });

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

    // C6 (algovault-skills SKILLS-W1): per-Skill attribution.
    // If the request carries X-AlgoVault-Skill-Slug AND is a tools/call,
    // log the invocation fire-and-forget BEFORE dispatching to the transport.
    // Slug values are public (Skill names are open-source); user_agent is
    // truncated to 200 chars in logSkillInvocation.
    const skillSlugHeader = (req.headers['x-algovault-skill-slug'] as string | undefined)?.trim();
    if (skillSlugHeader && req.method === 'POST' && req.body && typeof req.body === 'object') {
      const body = req.body as { method?: string; params?: { name?: string } };
      if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
        // Fire-and-forget; never blocks the request.
        try {
          logSkillInvocation(skillSlugHeader, body.params.name, sessionId, req.headers['user-agent'] as string | undefined);
        } catch { /* best-effort */ }
      }
    }

    // Run the entire request handling inside AsyncLocalStorage context
    // so tool handlers read the correct per-request license
    await requestContext.run({ license, sessionId, ipHash }, async () => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (req.method === 'GET') {
          if (sessionId && transports.has(sessionId)) {
            sessionLastActivity.set(sessionId, Date.now());
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
            sessionLastActivity.delete(sessionId);
          } else {
            res.status(404).json({ error: 'Session not found' });
          }
          return;
        }

        // POST — main request path
        if (sessionId && transports.has(sessionId)) {
          sessionLastActivity.set(sessionId, Date.now());
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res, req.body);
        } else {
          // New session
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
              sessionLastActivity.set(sid, Date.now());
            },
          });

          transport.onclose = () => {
            const sid = (transport as unknown as { sessionId?: string }).sessionId;
            if (sid) {
              transports.delete(sid);
              sessionLastActivity.delete(sid);
            }
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
      // Free HOLDs: skip settlement when get_trade_signal returned HOLD
      if (pendingSettlement && getRequestVerdict() !== 'HOLD') {
        settleX402Async(pendingSettlement);
      }
    });
  });

  const httpServer = app.listen(port, () => {
    console.log(`crypto-quant-signal-mcp running on http://0.0.0.0:${port}/mcp`);
    console.log(`Health check: http://0.0.0.0:${port}/health`);
    // Warm tier caches in background (xyz symbols, OI rankings, liquid memes)
    warmTierCaches().catch(() => {});

    // Auto-backfill: evaluate pending signals every 5 minutes
    console.log('[backfill] Auto-backfill enabled: every 5 minutes');
    setTimeout(() => runBackfill().catch(() => {}), 10_000); // first run after 10s
    setInterval(() => runBackfill().catch(() => {}), 300_000); // then every 5 min

    // LATENCY-W1 C3: background grid warmer.
    //   Pre-empts the 60s GRID_TTL_MS so user-facing get_trade_signal calls
    //   ALWAYS hit warm cache (cuts p95 from ~27s → <2s; cache-miss tail
    //   eliminated entirely). With C2's parallel refresh @ concurrency 6,
    //   each refresh costs ~1-2s wall-time and ~12 HL roundtrips. At 50s
    //   cadence: 12 req / 50 s = 0.24 req/s avg (<0.5% of HL's 50 req/s
    //   budget). RAM impact: bounded by cachedSnapshot (24 cells × ~200B)
    //   ≈ 5KB. Skipped during tests so unit suites don't burn upstream.
    if (process.env.NODE_ENV !== 'test') {
      console.log('[grid-warmer] Background grid pre-warm enabled: 50s interval');
      // Initial warmup ~5s after boot (lets DB init + first-request warmup finish)
      setTimeout(() => {
        refreshGridIfStale().catch((err) =>
          console.debug('[grid-warmer] initial refresh failed:', err instanceof Error ? err.message : err)
        );
      }, 5_000);
      // Periodic refresh — pre-empts the 60s TTL with 10s safety margin
      setInterval(() => {
        refreshGridIfStale().catch((err) =>
          console.debug('[grid-warmer] periodic refresh failed:', err instanceof Error ? err.message : err)
        );
      }, 50_000);
    }
  });

  const shutdown = () => {
    console.log('Shutting down...');
    clearInterval(sessionCleanupInterval);
    if (adminCleanupInterval) clearInterval(adminCleanupInterval);
    for (const transport of transports.values()) {
      transport.close?.();
    }
    transports.clear();
    sessionLastActivity.clear();
    closeDb();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Dashboard HTML ──

function getDashboardHtml(): string {
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
    <div class="section">
      <h2>Response Time (last 7d) &middot; <span style="color:#6e7681;font-size:11px;text-transform:none;letter-spacing:0">p50 = typical · p95 = slow tail · n = sample count</span></h2>
      <table>
        <thead><tr><th>Tool</th><th style="text-align:right">n</th><th style="text-align:right">p50 ms</th><th style="text-align:right">p95 ms</th><th style="text-align:right">min</th><th style="text-align:right">max</th></tr></thead>
        <tbody id="latency-rows"></tbody>
      </table>
    </div>
  </div>
  <div class="section">
    <h2>Skills Analytics (algovault-skills plugin) &middot; <span id="skills-summary" style="color:#8b949e;font-size:12px;text-transform:none;letter-spacing:0">loading...</span></h2>
    <table>
      <thead><tr><th>Slug</th><th style="text-align:right">24h</th><th style="text-align:right">7d</th><th style="text-align:right">All-time</th><th>Last invoked</th></tr></thead>
      <tbody id="skills-rows"></tbody>
    </table>
  </div>
  <div class="refresh">Auto-refreshes every 30s &middot; <span id="updated"></span></div>
</div>
<script>
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
// Canonical 20 Skill slugs — table renders all 20 even with zero invocations.
// Kept in sync with skills/manifest.json in github.com/AlgoVaultLabs/algovault-skills.
const SKILL_SLUGS = ['quick-btc-check','portfolio-scanner','regime-aware-trading','funding-arb-monitor','full-3-tool-pipeline','multi-timeframe-confirmation','tradfi-rotation','risk-gated-entry','funding-sentiment-dashboard','contrarian-meme-scanner','divergence-detector','hourly-digest-bot','hedging-advisor','volatility-breakout-watch','cross-asset-correlation','funding-cash-and-carry','weekend-vs-weekday-patterns','agent-portfolio-rebalance','smart-dca-bot','multi-agent-war-room'];
function escSlug(s) { return String(s).replace(/[<>&]/g,''); }
function fmtTs(s) {
  if (!s) return '<span style="color:#6e7681">never</span>';
  const t = new Date(s);
  return isNaN(t.getTime()) ? s : t.toISOString().slice(0,16).replace('T',' ') + 'Z';
}
async function loadSkills() {
  try {
    const r = await fetch('/dashboard/api/skills-analytics', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const bySlug = new Map((d.perSlug || []).map(x => [x.slug, x]));
    const rows = SKILL_SLUGS.map(slug => {
      const x = bySlug.get(slug) || { calls_24h:0, calls_7d:0, calls_all_time:0, last_seen:null };
      return '<tr>'
        + '<td><a style="color:#58a6ff;text-decoration:none" href="https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/'+escSlug(slug)+'/SKILL.md"><code>'+escSlug(slug)+'</code></a></td>'
        + '<td style="text-align:right;color:#3fb950;font-variant-numeric:tabular-nums">'+x.calls_24h+'</td>'
        + '<td style="text-align:right;color:#bc8cff;font-variant-numeric:tabular-nums">'+x.calls_7d+'</td>'
        + '<td style="text-align:right;color:#58a6ff;font-variant-numeric:tabular-nums">'+x.calls_all_time+'</td>'
        + '<td style="color:#8b949e">'+fmtTs(x.last_seen)+'</td>'
        + '</tr>';
    }).join('');
    document.getElementById('skills-rows').innerHTML = rows;
    document.getElementById('skills-summary').textContent =
      d.totalInvocations + ' total invocations across ' + d.totalSlugs + '/20 active slugs';
  } catch (e) {
    document.getElementById('skills-rows').innerHTML =
      '<tr><td colspan="5" style="color:#f85149">Failed to load skills analytics: ' + e.message + '</td></tr>';
  }
}
async function load() {
  try {
    const r = await fetch('/analytics', { credentials: 'same-origin' });
    const d = await r.json();
    document.getElementById('total-all').textContent = d.totalCalls.allTime;
    document.getElementById('total-24h').textContent = d.totalCalls.last24h;
    document.getElementById('total-7d').textContent = d.totalCalls.last7d;
    document.getElementById('sessions-all').textContent = d.uniqueSessions.allTime;
    document.getElementById('sessions-24h').textContent = d.uniqueSessions.last24h;
    renderRows('by-tool', d.byTool);
    renderRows('by-tier', d.byTier);
    renderAssets(d.topAssets);
    // C1 (LATENCY-W1): truthful per-tool latency table — n / p50 / p95 / min / max.
    // Replaces the misleading single-number avg (a bimodal distribution averaged 7.8s
    // even though typical p50 was ~1s). Sorted by p95 ascending so tail outliers float to bottom.
    const latencyEl = document.getElementById('latency-rows');
    const stats = Array.isArray(d.toolStats) ? d.toolStats : [];
    if (!stats.length) {
      latencyEl.innerHTML = '<tr><td colspan="6" style="color:#8b949e">No data yet</td></tr>';
    } else {
      latencyEl.innerHTML = stats.map(function (s) {
        var dim = s.insufficient_data ? ' style="color:#6e7681"' : '';
        var p50 = s.insufficient_data ? '<span style="color:#6e7681">— <small>(n&lt;5)</small></span>' : (s.p50_ms + 'ms');
        var p95 = s.insufficient_data ? '<span style="color:#6e7681">—</span>' : (s.p95_ms + 'ms');
        var minMs = s.min_ms == null ? '—' : (s.min_ms + 'ms');
        var maxMs = s.max_ms == null ? '—' : (s.max_ms + 'ms');
        return '<tr' + dim + '><td>' + s.tool_name + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + s.n + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#3fb950">' + p50 + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#facc15">' + p95 + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#8b949e">' + minMs + '</td>'
             + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:#8b949e">' + maxMs + '</td>'
             + '</tr>';
      }).join('');
    }
    document.getElementById('updated').textContent = 'Updated: ' + new Date(d.generatedAt).toLocaleString();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
    // Kick off skills section load in parallel — independent endpoint, won't
    // block the main render even on slow DB query.
    loadSkills();
  } catch(e) { document.getElementById('loading').textContent = 'Failed to load: ' + e.message; }
}
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

function getPerformanceDashboardHtml(opts?: { isPublic?: boolean }): string {
  const isPublic = opts?.isPublic ?? false;
  const perfEndpoint = isPublic ? '/api/performance-public' : '/performance';
  const cbEndpoint = isPublic ? '/api/confidence-bands-public' : '/api/confidence-bands';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Track Record — AlgoVault Labs</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 700; }
  .subtitle { color: #6e7681; font-size: 12px; margin-top: 6px; letter-spacing: 0.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
  .call-type-verification-row { display: flex; gap: 1.5rem; align-items: flex-start; }
  .call-type-verification-row .call-type-section { flex: 1; min-width: 0; }
  .call-type-verification-row .tamper-proof-card { flex: 0 0 340px; }
  @media (max-width: 768px) { .call-type-verification-row { flex-direction: column; } .call-type-verification-row .call-type-section, .call-type-verification-row .tamper-proof-card { width: 100%; flex: none; } }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 18px; }
  .card .label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .card .value.hero { font-size: 32px; }
  .card .sub { color: #8b949e; font-size: 11px; margin-top: 4px; }
  .green { color: #3fb950 !important; } .red { color: #f85149 !important; } .gold { color: #d29922 !important; } .muted { color: #8b949e !important; }
  .section { margin-bottom: 28px; }
  .section h2 { font-size: 14px; color: #8b949e; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; max-width: 800px; border-collapse: collapse; background: #161b22; border-radius: 12px; overflow: hidden; border: 1px solid #30363d; }
  th, td { padding: 12px 16px; border-bottom: 1px solid #21262d; font-size: 13px; text-align: center; font-variant-numeric: tabular-nums; }
  td:first-child, th:first-child { text-align: left; }
  th { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; background: #0d1117; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .badge-buy { background: #0d2818; color: #3fb950; } .badge-sell { background: #2d0b0e; color: #f85149; } .badge-hold { background: #1c1c1c; color: #8b949e; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid #30363d; background: #161b22; color: #8b949e; transition: all 0.15s; }
  .tab:hover { border-color: #58a6ff80; } .tab.active { background: #58a6ff20; color: #58a6ff; border-color: #58a6ff; }
  .tier-tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tier-tab { padding: 6px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid #30363d; background: #161b22; color: #8b949e; transition: all 0.15s; }
  .tier-tab:hover { border-color: #58a6ff80; } .tier-tab.active { border-width: 2px; }
  .tier-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; }
  .tradfi-badge { background: linear-gradient(135deg, #bc8cff20, #8957e520); border: 1px solid #bc8cff40; color: #bc8cff; font-size: 11px; padding: 4px 10px; border-radius: 6px; font-weight: 600; }
  .onchain-badge { display: flex; align-items: center; gap: 10px; background: #0d1117; border: 1px solid #238636; border-radius: 10px; padding: 12px 18px; margin-bottom: 20px; }
  .onchain-badge .badge-icon { font-size: 18px; }
  .onchain-badge .badge-text { color: #3fb950; font-weight: 700; font-size: 14px; }
  .onchain-badge .badge-detail { color: #8b949e; font-size: 12px; }
  #merkle-stats { text-align:center; color:#8b949e; font-size:12px; margin-bottom:16px; }
  .tier-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 28px; }
  @media (max-width: 768px) { .tier-grid { grid-template-columns: 1fr; } }
  .tier-card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; }
  .tier-card .tc-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .tier-card .tc-name { font-size: 14px; font-weight: 700; }
  .tier-card .tc-assets { font-size: 11px; color: #8b949e; margin-bottom: 10px; }
  .tier-card .tc-stats { display: flex; flex-direction: column; gap: 4px; }
  .tier-card .tc-stat { display: flex; justify-content: space-between; align-items: baseline; }
  .tier-card .tc-stat .tc-label { font-size: 12px; color: #8b949e; }
  .tier-card .tc-stat .tc-val { font-size: 16px; font-weight: 700; text-align: right; }
  .tier-card .tc-stat .tc-val.pfe-hero { font-size: 20px; font-weight: 800; }
  .refresh { color: #8b949e; font-size: 12px; margin-top: 16px; }
  #loading { color: #8b949e; font-size: 16px; padding: 40px; text-align: center; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .empty { color: #8b949e; padding: 40px; text-align: center; font-size: 14px; }
  .methodology { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; font-size: 13px; line-height: 1.7; color: #c9d1d9; }
  .methodology p { margin-top: 12px; } .methodology p:first-child { margin-top: 0; }
  .methodology table { width: auto; background: transparent; border: none; margin-top: 8px; }
  .methodology table th { border: none; padding: 4px 24px 4px 0; color: #8b949e; font-weight: 600; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; background: transparent; }
  .methodology table td { border: none; padding: 3px 24px 3px 0; color: #c9d1d9; }
  .methodology code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .id-link { color: #d4b255; text-decoration: none; font-family: monospace; font-size: 12px; } .id-link:hover { text-decoration: underline; color: #e8c96a; }
  .recent-table { table-layout: fixed; }
  .recent-table th:nth-child(1), .recent-table td:nth-child(1) { width: 70px; }
  .recent-table th:nth-child(2), .recent-table td:nth-child(2) { width: 80px; }
  .recent-table th:nth-child(3), .recent-table td:nth-child(3) { width: 50px; }
  .recent-table th:nth-child(4), .recent-table td:nth-child(4) { width: 80px; }
  .recent-table th:nth-child(5), .recent-table td:nth-child(5) { width: 60px; }
  .recent-table th:nth-child(6), .recent-table td:nth-child(6) { width: 80px; }
  .recent-table th:nth-child(7), .recent-table td:nth-child(7) { width: 60px; }
  .recent-table th:nth-child(8), .recent-table td:nth-child(8) { width: 80px; }
</style>
</head>
<body>
<div class="logo">
  <a href="https://algovault.com" style="display:flex;align-items:center;text-decoration:none"><img src="/logo.png" width="36" height="36" style="border-radius:8px;cursor:pointer" onerror="this.style.display='none'"></a>
  <div><h1>Live Track Record</h1><div class="subtitle">v${PKG_VERSION} &middot; 5 exchanges &middot; 290+ assets</div></div>
</div>
<div id="loading">Loading performance data...</div>
<div id="content" style="display:none">
  <!-- Exchange Logo Strip -->
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap">
    <span style="color:#6e7681;font-size:12px;text-transform:uppercase;letter-spacing:1px">Analyzing</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#4ade80">Hyperliquid</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#F0B90B">Binance</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#F7A600">Bybit</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#fff">OKX</span>
    <span style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;color:#00C8BC">Bitget</span>
  </div>
  <!-- Cross-Venue Intelligence Callout -->
  <div style="background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.15);border-radius:10px;padding:12px 18px;margin-bottom:16px;font-size:13px;color:#c9d1d9">
    <strong style="color:#58a6ff">Cross-Venue Intelligence</strong> &mdash; Signals are generated per exchange using native order books, funding rates, and OI data. The only MCP server analyzing 5 derivatives venues simultaneously.
  </div>
  <!-- On-Chain Verification Badge -->
  <div class="onchain-badge" id="onchain-badge" style="display:none">
    <span class="badge-icon">&#x1f517;</span>
    <div><span class="badge-text">On-Chain Verified</span><br><span class="badge-detail">Every call hashed on Base L2 — daily Merkle root published on-chain</span></div>
  </div>
  <div id="merkle-stats"></div>

  <!-- Exchange Filter Tabs -->
  <div class="tabs" id="exchange-tabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"></div>

  <!-- Tier Filter Tabs -->
  <div class="tier-tabs" id="tier-tabs"></div>

  <!-- KPI Cards (4) -->
  <div class="grid">
    <div class="card"><div class="label">Total Trade Calls</div><div class="value" id="total"></div><div class="sub" id="period"></div></div>
    <div class="card"><div class="label">PFE Win Rate</div><div class="value hero" id="pfe-wr"></div><div class="sub">Directional Accuracy</div></div>
  </div>
  <div id="eval-indicator" style="text-align:center;color:#8b949e;font-size:13px;margin:-8px 0 12px 0"></div>

  <!-- Tier Performance Cards -->
  <div class="section"><h2>Performance by Tier</h2>
    <div class="tier-grid" id="tier-cards"></div>
    <div style="text-align:center;color:#9ca3af;font-size:12px;margin:12px 0 0;padding:6px 12px;background:rgba(212,178,85,0.06);border:1px solid rgba(212,178,85,0.12);border-radius:8px">&#x1f4a1; HOLD calls are always free &mdash; You only pay for BUY and SELL verdicts</div>
  </div>

  <!-- Signal type + Tamper-Proof row -->
  <div class="call-type-verification-row">
    <div class="call-type-section section"><h2>By Call Type</h2>
      <table><thead><tr><th>Type</th><th>Trade Calls</th><th>Evaluated</th><th>PFE Win Rate</th></tr></thead>
      <tbody id="by-type"></tbody></table>
    </div>
    <div class="tamper-proof-card" style="background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.2);border-radius:12px;padding:20px;margin-top:28px">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <span style="color:#60a5fa;font-size:16px;margin-top:2px">&#x1f517;</span>
        <div>
          <span style="color:#fff;font-size:14px;font-weight:600">Tamper-Proof Track Record</span>
          <p style="color:#9ca3af;font-size:13px;margin:6px 0 0">Every call hashed on-chain (Base L2). Daily Merkle batches. Inspect the contract on Basescan &mdash; we can&rsquo;t edit history.</p>
          <div style="margin-top:12px;display:flex;gap:16px;font-size:12px">
            <a href="/verify" style="color:#d4b255;text-decoration:none">Verify a Call &rarr;</a>
            <a href="https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81" target="_blank" style="color:#d4b255;text-decoration:none">View Contract &rarr;</a>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Timeframe tabs + table -->
  <div class="section">
    <h2>Performance by Timeframe</h2>
    <div class="tabs" id="tf-tabs"></div>
    <table><thead><tr><th>Timeframe</th><th>Trade Calls</th><th>Evaluated</th><th>PFE Win Rate</th><th>Avg PFE %</th><th>BUY / SELL</th></tr></thead>
    <tbody id="by-timeframe"></tbody></table>
  </div>

  <!-- Confidence Band Analysis -->
  <div class="section" id="cb-section" style="display:none">
    <h2>Performance by Confidence Band</h2>
    <table><thead><tr><th>Band</th><th>Trade Calls</th><th>Evaluated</th><th>PFE Win Rate</th><th>Avg PFE %</th><th>BUY / SELL</th></tr></thead>
    <tbody id="cb-body"></tbody></table>
  </div>

  <div class="grid-2">
    <div class="section"><h2>Top Performing Assets</h2>
      <table><thead><tr><th></th><th>Asset</th><th class="num">Trade Calls</th><th class="num">PFE WR</th></tr></thead>
      <tbody id="top-assets"></tbody></table>
    </div>
    <div class="section"><h2>Worst Performing Assets</h2>
      <table><thead><tr><th></th><th>Asset</th><th class="num">Trade Calls</th><th class="num">PFE WR</th></tr></thead>
      <tbody id="worst-assets"></tbody></table>
    </div>
  </div>

  <!-- Recent signals -->
  <div class="section"><h2>Recent Trade Calls</h2>
    <table class="recent-table"><thead><tr><th>ID</th><th>Time</th><th>Tier</th><th>Asset</th><th>Call</th><th class="num">Confidence</th><th class="num">Timeframe</th><th>Exchange</th></tr></thead>
    <tbody id="recent"></tbody></table>
  </div>

  <!-- Methodology -->
  <div class="section"><h2>Methodology</h2>
    <div class="methodology">
      <p><strong>Total Trade Calls</strong> = BUY + SELL only. HOLDs excluded (stored separately).</p>
      <p><strong>PFE Win Rate</strong> = Percentage of trade calls where price moved in the called direction at any point during the evaluation window. Only confidence &ge; 60% signals are recorded and evaluated.</p>
      <p><strong>Note</strong>: AlgoVault provides directional entry calls. Exit timing is determined by your agent or strategy &mdash; PFE Win Rate measures whether the direction was correct, independent of exit.</p>
      <p style="margin-top:16px"><strong>Evaluation Windows</strong></p>
      <table><thead><tr><th>Timeframe</th><th>Candles</th><th>Total Time</th></tr></thead><tbody>
        <tr><td>5m</td><td>12</td><td>1 hour</td></tr><tr><td>15m</td><td>12</td><td>3 hours</td></tr>
        <tr><td>30m</td><td>8</td><td>4 hours</td></tr><tr><td>1h</td><td>8</td><td>8 hours</td></tr>
        <tr><td>2h</td><td>6</td><td>12 hours</td></tr><tr><td>4h</td><td>6</td><td>24 hours</td></tr>
        <tr><td>8h</td><td>4</td><td>32 hours</td></tr><tr><td>12h</td><td>4</td><td>48 hours</td></tr>
        <tr><td>1d</td><td>3</td><td>3 days</td></tr>
      </tbody></table>
      <p style="margin-top:16px"><strong>Asset Tiers</strong></p>
      <table><thead><tr><th>Tier</th><th>Name</th><th>Description</th></tr></thead><tbody>
        <tr><td style="color:#58a6ff">Tier 1</td><td>Blue Chip</td><td>BTC, ETH</td></tr>
        <tr><td style="color:#3fb950">Tier 2</td><td>Major Alts</td><td>Top 20 by notional OI across 5 exchanges (dynamic, hourly)</td></tr>
        <tr><td style="color:#bc8cff">Tier 3</td><td>TradFi</td><td>Stocks, indices, commodities, FX via HL xyz perps</td></tr>
        <tr><td style="color:#d29922">Tier 4</td><td>Meme &amp; Micro</td><td>Meme &amp; micro-caps (liquidity-filtered: top 50 OI or &gt;$10M vol)</td></tr>
      </tbody></table>
      <p><strong>Default view</strong> shows all assets across all tiers. Use tier tabs to filter by quality tier.</p>
      <p style="margin-top:16px;color:#6e7681;font-size:11px"><em>AlgoVault provides directional entry interpretation for AI agents. Exit timing is determined by your agent or strategy. This is not financial advice. Past performance does not guarantee future results.</em></p>
    </div>
  </div>

  <div class="refresh">Auto-refreshes every 30s &middot; <span id="updated"></span></div>
</div>

<script>
var PERF_URL = '${perfEndpoint}';
var CB_URL = '${cbEndpoint}';
var MERKLE_URL = '/api/merkle-batches';
var TF_ORDER = ['1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d'];
var TIER_COLORS = {1:'#58a6ff',2:'#3fb950',3:'#bc8cff',4:'#d29922'};
var TIER_NAMES = {1:'Blue Chip',2:'Major Alts',3:'TradFi',4:'Meme & Micro'};
var activeTfFilter = 'all';
var activeTierFilter = 'all'; // default: All Assets
var activeExchangeFilter = 'all'; // default: show ALL exchanges
var cachedData = null;

function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : '—'; }
function wrClass(v) { return v != null ? (v >= 0.5 ? 'green' : v >= 0.3 ? 'gold' : 'red') : 'muted'; }
function pfeClass(v) { return v != null ? (v >= 0.6 ? 'green' : v >= 0.45 ? 'gold' : 'red') : 'muted'; }
function pfClass(v) { return v != null ? (v >= 1.5 ? 'green' : v >= 1.0 ? 'gold' : 'red') : 'muted'; }
function evClass(v) { return v != null ? (v > 0 ? 'green' : 'red') : 'muted'; }
function badge(sig) { return '<span class="badge badge-' + sig.toLowerCase() + '">' + sig + '</span>'; }
function tierBadge(t) { return '<span class="tier-badge" style="background:' + (TIER_COLORS[t]||'#8b949e') + '20;color:' + (TIER_COLORS[t]||'#8b949e') + '">T' + t + '</span>'; }
function timeAgo(ts) { var s=Math.floor(Date.now()/1000-ts); if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }

function tierMatch(tier) {
  if (activeTierFilter === 'all') return true;
  return tier === parseInt(activeTierFilter);
}

// Get the correct data source based on active exchange + tier filters.
// 2-dimensional: exchange × tier → overall KPIs + sub-aggregates.
var HIDE_TFS = {'1d':1,'1D':1}; // Timeframes hidden from dashboard UI (data preserved in API)
function src() {
  var d = cachedData; if (!d) return null;
  var empty = { totalSignals: 0, totalEvaluated: 0, pfeWinRate: null };

  // Step 1: select exchange-level data
  var exAll, exByTF, exByType, exByAsset, exByTier;
  if (activeExchangeFilter === 'all') {
    exAll = d.overall;
    exByTF = d.byTimeframe || {};
    exByType = d.bySignalType || {};
    exByAsset = d.byAsset || {};
    exByTier = d.byTier || {};
  } else {
    var ex = (d.byExchange || {})[activeExchangeFilter];
    if (!ex) return { overall: empty, byTF: {}, byType: {}, byAsset: {}, byTier: {} };
    exAll = { totalSignals: ex.count, totalEvaluated: ex.evaluated, pfeWinRate: ex.pfeWinRate };
    exByTF = ex.byTimeframe || {};
    exByType = ex.bySignalType || {};
    exByAsset = ex.byAsset || {};
    exByTier = ex.byTier || {};
  }

  // Step 2: apply tier filter to KPIs
  var overall = exAll;
  if (activeTierFilter !== 'all') {
    var tk = 'tier' + activeTierFilter;
    var tier = exByTier[tk];
    if (tier) {
      overall = { totalSignals: tier.count || 0, totalEvaluated: tier.evaluated || 0, pfeWinRate: tier.pfeWinRate };
    } else {
      overall = empty;
    }
  }

  // Filter hidden timeframes from byTF
  var filteredTF = {};
  Object.keys(exByTF).forEach(function(k){ if (!HIDE_TFS[k]) filteredTF[k] = exByTF[k]; });

  return { overall: overall, byTF: filteredTF, byType: exByType, byAsset: exByAsset, byTier: exByTier };
}

function getFilteredRecent() {
  var all = cachedData ? (cachedData.recentSignals || []) : [];
  return all.filter(function(s) {
    if (!tierMatch(s.tier)) return false;
    if (activeExchangeFilter !== 'all' && s.exchange !== activeExchangeFilter) return false;
    return true;
  });
}

function setExchangeFilter(ex) {
  activeExchangeFilter = ex;
  document.querySelectorAll('#exchange-tabs .tab').forEach(function(t){
    var isActive = t.dataset.ex === ex;
    t.classList.toggle('active', isActive);
    t.style.borderColor = isActive ? '#58a6ff' : '#30363d';
    t.style.color = isActive ? '#58a6ff' : '#8b949e';
    t.style.background = isActive ? '#58a6ff20' : '#161b22';
  });
  renderAll();
}

function setTfFilter(tf) {
  activeTfFilter = tf;
  document.querySelectorAll('#tf-tabs .tab').forEach(function(t){t.classList.toggle('active',t.dataset.tf===tf);});
  renderAll();
}

function setTierFilter(mode) {
  activeTierFilter = mode;
  document.querySelectorAll('.tier-tab').forEach(function(t){
    var isActive = t.dataset.tier === mode;
    t.className = 'tier-tab' + (isActive ? ' active' : '');
    if (isActive) { t.style.borderColor = t.dataset.color || '#58a6ff'; t.style.color = t.dataset.color || '#58a6ff'; t.style.background = (t.dataset.color||'#58a6ff') + '20'; }
    else { t.style.borderColor = '#30363d'; t.style.color = '#8b949e'; t.style.background = '#161b22'; }
  });
  renderAll();
}

function renderAll() {
  var d = cachedData; if (!d) return;
  var s = src(); if (!s) return;

  // KPIs — from server-side aggregates (not recomputed from recentSignals)
  if (activeTfFilter === 'all') {
    var pfeEl = document.getElementById('pfe-wr');
    pfeEl.textContent = pct(s.overall.pfeWinRate); pfeEl.className = 'value hero ' + pfeClass(s.overall.pfeWinRate);
    document.getElementById('total').textContent = (s.overall.totalSignals || 0).toLocaleString();
    document.getElementById('period').textContent = d.period ? d.period.from + ' → ' + d.period.to : 'Tracked & Evaluated';
  } else {
    var tfv = (s.byTF || {})[activeTfFilter];
    if (tfv) {
      var pfe2 = document.getElementById('pfe-wr');
      pfe2.textContent = pct(tfv.pfeWinRate); pfe2.className = 'value hero ' + pfeClass(tfv.pfeWinRate);
      document.getElementById('total').textContent = (tfv.count || 0).toLocaleString();
      document.getElementById('period').textContent = activeTfFilter + ' timeframe';
    }
  }

  // Evaluated indicator (with HOLD rate)
  var evalEl = document.getElementById('eval-indicator');
  if (evalEl) {
    var th = d.totalHolds || 0;
    var totalGenerated = (s.overall.totalSignals||0) + th;
    var holdRate = totalGenerated > 0 ? ((th / totalGenerated) * 100).toFixed(0) + '%' : '—';
    evalEl.textContent = 'Trade Calls: ' + (s.overall.totalSignals||0).toLocaleString() + ' · Evaluated: ' + (s.overall.totalEvaluated||0).toLocaleString() + ' · PFE Win Rate: ' + pct(s.overall.pfeWinRate) + ' · HOLD Rate: ' + holdRate;
  }

  // Tier cards — from server-side byTier (or byExchange[ex].byTier)
  var tcEl = document.getElementById('tier-cards');
  var bt = d.byTier || {};
  var exTier = s.byTier || {};
  function tierAssetLabel(tier, assets) {
    if (tier === 1) return (assets||[]).join(', ') || 'BTC, ETH';
    if (tier === 2) {
      var s2 = (assets||[]).slice(0,5).join(', ');
      return '<span style="color:#58a6ff">Top 20 by Open Interest</span><br>' + s2 + (assets && assets.length > 5 ? ' +' + (assets.length-5) + ' more' : '');
    }
    if (tier === 3) {
      var s3 = (assets||[]).slice(0,4).join(', ');
      return '<span style="color:#8b949e">Stocks · Indices · Commodities · FX</span>' + (s3 ? '<br>' + s3 + (assets.length > 4 ? ' +' + (assets.length-4) + ' more' : '') : '');
    }
    if (tier === 4) {
      return '<span style="color:#8b949e">Liquidity Filtered (Top 50 OI)</span><br>' + (assets ? assets.length : 0) + ' assets tracked';
    }
    return (assets||[]).join(', ');
  }
  var hbt = d.holdsByTier || {};
  tcEl.innerHTML = ['tier1','tier2','tier3','tier4'].map(function(k){
    var t = bt[k]; if (!t) return '';
    var tc = exTier[k] || { count: 0, evaluated: 0, pfeWinRate: null };
    var isTF = t.tier === 3;
    var tierHolds = hbt[String(t.tier)] || 0;
    var holdLine = tierHolds > 0 ? '<div style="color:#8b949e;font-size:12px;margin-top:6px">' + tierHolds.toLocaleString() + ' HOLD calls — engine is selective</div>' : '';
    return '<div class="tier-card" style="border-color:'+t.color+'40">' +
      '<div class="tc-header">' + tierBadge(t.tier) + ' <span class="tc-name" style="color:'+t.color+'">' + t.name + '</span>' +
      (isTF ? ' <span class="tradfi-badge">Only on AlgoVault ✦</span>' : '') + '</div>' +
      '<div class="tc-assets">' + tierAssetLabel(t.tier, t.assets) + '</div>' +
      (tc.count > 0 ? '<div class="tc-stats">' +
        '<div class="tc-stat"><span class="tc-label">Trade Calls</span><span class="tc-val muted">' + (tc.count||0).toLocaleString() + '</span></div>' +
        '<div class="tc-stat"><span class="tc-label">Evaluated</span><span class="tc-val muted">' + (tc.evaluated||0).toLocaleString() + '</span></div>' +
        '<div class="tc-stat"><span class="tc-label">PFE Win Rate</span><span class="tc-val pfe-hero ' + pfeClass(tc.pfeWinRate) + '">' + pct(tc.pfeWinRate) + '</span></div>' +
      '</div>' : '<div style="color:#6e7681;font-size:12px">No trade calls yet</div>') +
      holdLine +
    '</div>';
  }).join('');

  // Signal types — from server-side bySignalType
  var typeEl = document.getElementById('by-type');
  var typeSrc = s.byType || {};
  var th2 = d.totalHolds || 0;
  var types = ['BUY','SELL','HOLD'].map(function(type){
    var v = typeSrc[type] || { count: 0, evaluated: 0, pfeWinRate: null };
    if (type === 'HOLD') v = { count: th2, evaluated: 0, pfeWinRate: null };
    return [type, v];
  });
  typeEl.innerHTML = types.map(function(e){var tp=e[0],v=e[1];return '<tr><td>'+badge(tp)+'</td><td>'+(v.count||0)+'</td><td>'+(v.evaluated||0)+'</td><td class="'+pfeClass(v.pfeWinRate)+'">'+pct(v.pfeWinRate)+'</td></tr>';}).join('');

  // TF table — from server-side byTimeframe
  var tfEl = document.getElementById('by-timeframe');
  var tfSrc = s.byTF || {};
  var tfe = Object.entries(tfSrc);
  var filtered = activeTfFilter === 'all' ? tfe : tfe.filter(function(e){return e[0]===activeTfFilter;});
  if (filtered.length) {
    filtered.sort(function(a,b){return TF_ORDER.indexOf(a[0])-TF_ORDER.indexOf(b[0]);});
    tfEl.innerHTML = filtered.map(function(e){var tf=e[0],v=e[1];return '<tr><td><strong>'+tf+'</strong></td><td>'+(v.count||0)+'</td><td>'+(v.evaluated||0)+'</td><td class="'+pfeClass(v.pfeWinRate)+'">'+pct(v.pfeWinRate)+'</td><td>—</td><td>—</td></tr>';}).join('');
  } else { tfEl.innerHTML = '<tr><td colspan="6" class="empty">No data for this timeframe</td></tr>'; }

  // Asset tables — from server-side byAsset
  var assetSrc = s.byAsset || {};
  var assets = Object.entries(assetSrc).filter(function(e){ return e[1].count >= 5 && (activeTierFilter === 'all' || e[1].tier === parseInt(activeTierFilter)); }).map(function(e){ return { coin: e[0], tier: e[1].tier, count: e[1].count, pfeWinRate: e[1].pfeWinRate }; });
  var topA = assets.slice().sort(function(a,b){return (b.pfeWinRate||0)-(a.pfeWinRate||0);}).slice(0,15);
  var worstA = assets.slice().sort(function(a,b){return (a.pfeWinRate||0)-(b.pfeWinRate||0);}).slice(0,15);
  function renderAT(id,list){
    var el=document.getElementById(id);
    if(!list.length){el.innerHTML='<tr><td colspan="4" class="empty">Waiting for outcome data (min 5 trade calls)...</td></tr>';return;}
    el.innerHTML=list.map(function(a){return '<tr><td>'+tierBadge(a.tier)+'</td><td><strong>'+a.coin+'</strong></td><td class="num">'+a.count+'</td><td class="num '+pfeClass(a.pfeWinRate)+'">'+pct(a.pfeWinRate)+'</td></tr>';}).join('');
  }
  renderAT('top-assets',topA); renderAT('worst-assets',worstA);

  // Recent signals — still from recentSignals (the 20-item capped array, correctly stripped)
  var recentEl = document.getElementById('recent');
  var recent = getFilteredRecent().slice(0,20);
  if (recent.length) {
    recentEl.innerHTML = recent.map(function(s){return '<tr><td><a href="/verify?signalId='+s.id+'" class="id-link">#'+s.id+'</a></td><td class="muted">'+timeAgo(s.created_at)+'</td><td>'+tierBadge(s.tier)+'</td><td><strong>'+s.coin+'</strong></td><td>'+badge(s.signal)+'</td><td class="num">'+s.confidence+'%</td><td class="num">'+s.timeframe+'</td><td class="muted">'+(s.exchange||'HL')+'</td></tr>';}).join('');
  } else { recentEl.innerHTML='<tr><td colspan="8" class="empty">No trade calls'+(activeTfFilter!=='all'?' for '+activeTfFilter:'')+' yet.</td></tr>'; }
}

async function load() {
  try {
    var r = await fetch(PERF_URL, { credentials: 'same-origin' });
    var d = await r.json();
    cachedData = d;

    // Tier filter tabs
    var ttEl = document.getElementById('tier-tabs');
    ttEl.innerHTML = [
      {id:'all',label:'All Assets',color:'#8b949e'},
      {id:'1',label:'Tier 1',color:'#58a6ff'},
      {id:'2',label:'Tier 2',color:'#3fb950'},
      {id:'3',label:'Tier 3 ✦',color:'#bc8cff'},
      {id:'4',label:'Tier 4',color:'#d29922'},
    ].map(function(t){
      var isActive = activeTierFilter === t.id;
      var style = isActive ? 'border-color:'+t.color+';color:'+t.color+';background:'+t.color+'20' : '';
      return '<div class="tier-tab'+(isActive?' active':'')+'" data-tier="'+t.id+'" data-color="'+t.color+'" style="'+style+'" onclick="setTierFilter(\\''+t.id+'\\')">'+t.label+'</div>';
    }).join('');

    // Exchange filter tabs
    var exTabs = document.getElementById('exchange-tabs');
    var exchanges = [{id:'all',label:'ALL Exchanges'},{id:'HL',label:'Hyperliquid'},{id:'BINANCE',label:'Binance'},{id:'BYBIT',label:'Bybit'},{id:'OKX',label:'OKX'},{id:'BITGET',label:'Bitget'}];
    exTabs.innerHTML = exchanges.map(function(ex){
      var isActive = activeExchangeFilter === ex.id;
      return '<div class="tab'+(isActive?' active':'')+'" data-ex="'+ex.id+'" style="cursor:pointer;padding:6px 14px;border-radius:8px;font-size:13px;border:1px solid '+(isActive?'#58a6ff':'#30363d')+';color:'+(isActive?'#58a6ff':'#8b949e')+';background:'+(isActive?'#58a6ff20':'#161b22')+'" onclick="setExchangeFilter(\\''+ex.id+'\\')">'+ex.label+'</div>';
    }).join('');

    // TF tabs — from server-side byTimeframe (respects exchange filter via src())
    var tabsEl = document.getElementById('tf-tabs');
    var tfSrc = (src() || {}).byTF || {};
    var availTfs = Object.keys(tfSrc).sort(function(a,b){return TF_ORDER.indexOf(a)-TF_ORDER.indexOf(b);});
    tabsEl.innerHTML = '<div class="tab'+(activeTfFilter==='all'?' active':'')+'" data-tf="all" onclick="setTfFilter(\\'all\\')">All</div>' +
      availTfs.map(function(tf){return '<div class="tab'+(activeTfFilter===tf?' active':'')+'" data-tf="'+tf+'" onclick="setTfFilter(\\''+tf+'\\')">'+tf+'</div>';}).join('');

    renderAll();

    // Confidence bands (separate fetch — Postgres only)
    try {
      var cbRes = await fetch(CB_URL, { credentials: 'same-origin' });
      if (cbRes.ok) {
        var cbData = await cbRes.json();
        var bands = cbData.bands || [];
        if (bands.length > 0) {
          var cbEl = document.getElementById('cb-body');
          cbEl.innerHTML = bands.map(function(b) {
            var wr = b.pfeWinRate != null ? (b.pfeWinRate * 100).toFixed(1) + '%' : '—';
            var wrC = b.pfeWinRate != null ? (b.pfeWinRate >= 0.6 ? 'green' : b.pfeWinRate >= 0.45 ? 'gold' : 'red') : 'muted';
            var avgP = b.avgPfePct != null ? b.avgPfePct.toFixed(2) + '%' : '—';
            return '<tr><td><strong>' + b.band + '%</strong></td><td>' + b.total + '</td><td>' + b.evaluated + '</td><td class="' + wrC + '">' + wr + '</td><td>' + avgP + '</td><td>' + b.buyCount + ' / ' + b.sellCount + '</td></tr>';
          }).join('');
          document.getElementById('cb-section').style.display = 'block';
        }
      }
    } catch(e) { /* confidence bands are best-effort */ }

    // Merkle on-chain badge
    try {
      var mr = await fetch(MERKLE_URL);
      var md = await mr.json();
      if (md.batches && md.batches.length > 0) {
        document.getElementById('onchain-badge').style.display = 'flex';
        var totalVerified = md.batches.reduce(function(a,b){return a+(parseInt(b.signal_count)||0);},0);
        var latest = md.batches[0];
        document.getElementById('merkle-stats').innerHTML = 'On-Chain Proof: ' + md.batches.length + ' batch' + (md.batches.length>1?'es':'') + ' published · ' + totalVerified.toLocaleString() + ' calls verified · <a href="https://basescan.org/address/' + md.contractAddress + '" target="_blank" style="color:#58a6ff">View on Basescan →</a>';
      }
    } catch(e) { /* merkle stats are best-effort */ }

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
  .container { max-width: 960px; width: 100%; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: #8b949e; margin-bottom: 32px; font-size: 14px; }
  .plans { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
  @media (max-width: 768px) { .plans { grid-template-columns: 1fr; } }
  .plan { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; position: relative; }
  .plan.popular { border-color: #d4a017; }
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
  .pop-badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #d4a017; color: #0f1117; font-size: 11px; font-weight: 700; padding: 3px 12px; border-radius: 20px; letter-spacing: 0.5px; }
</style>
</head>
<body>
<div class="container">
  <h1>AlgoVault Subscriptions</h1>
  <div class="subtitle">Unlock all assets across 5 exchanges, all timeframes, and higher call limits.</div>
  <div style="display:flex;justify-content:center;gap:12px;margin-bottom:24px;flex-wrap:wrap">
    <span style="color:#4ade80;font-size:12px;font-weight:600">Hyperliquid</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#F0B90B;font-size:12px;font-weight:600">Binance</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#F7A600;font-size:12px;font-weight:600">Bybit</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#fff;font-size:12px;font-weight:600">OKX</span>
    <span style="color:#6e7681">&middot;</span>
    <span style="color:#00C8BC;font-size:12px;font-weight:600">Bitget</span>
  </div>
  <div class="plans">
    <div class="plan">
      <h2>Starter</h2>
      <div class="price">$9.99<span>/mo</span></div>
      <ul>
        <li>3,000 calls/month</li>
        <li>5 exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets (crypto + TradFi)</li>
        <li>All timeframes (1m to 1d)</li>
        <li>Email support</li>
      </ul>
      <a class="btn" href="/signup?plan=starter">Subscribe to Starter</a>
    </div>
    <div class="plan popular">
      <div class="pop-badge">MOST POPULAR</div>
      <h2>Pro</h2>
      <div class="price">$49<span>/mo</span></div>
      <ul>
        <li>15,000 calls/month</li>
        <li>5 exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets (crypto + TradFi)</li>
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
        <li>5 exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
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
                 "arguments":{"coin":"SOL","timeframe":"5m","exchange":"BINANCE"}},
       "id":1}'</pre>
    <p style="color:#8b949e;font-size:12px;margin-top:8px">Supported exchanges: HL (default), BINANCE, BYBIT, OKX, BITGET</p>
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
