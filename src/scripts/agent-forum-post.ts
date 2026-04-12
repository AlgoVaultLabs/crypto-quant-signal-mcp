#!/usr/bin/env tsx
/**
 * agent-forum-post.ts — Automated multi-platform forum marketing.
 *
 * Publishes to Moltbook, Dev.to, and Hashnode (3x/week cron + on-demand).
 * Pulls live data from AlgoVault public APIs. Never posts stale/cached data.
 *
 * Usage:
 *   npx tsx src/scripts/agent-forum-post.ts --type=track-record [--dry-run]
 *   npx tsx src/scripts/agent-forum-post.ts --type=usage-example [--dry-run]
 *   npx tsx src/scripts/agent-forum-post.ts --type=market-insight [--dry-run]
 *   npx tsx src/scripts/agent-forum-post.ts --type=release --version=1.8.0 [--dry-run]
 *
 * Env vars (all optional — missing = skip that platform):
 *   MOLTBOOK_API_KEY, DEVTO_API_KEY, HASHNODE_PAT, HASHNODE_PUBLICATION_ID
 */

const API_BASE = 'https://api.algovault.com';
const MCP_ENDPOINT = `${API_BASE}/mcp`;
const COUNTER_FILE = '/opt/crypto-quant-signal-mcp/usage-example-counter.txt';
// Fallback for local dev / dry-run
const COUNTER_FILE_LOCAL = './usage-example-counter.txt';

// ── CLI argument parsing ──

interface CliArgs {
  type: 'track-record' | 'usage-example' | 'market-insight' | 'release';
  version?: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let type: string | undefined;
  let version: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--type=')) type = arg.split('=')[1];
    if (arg.startsWith('--version=')) version = arg.split('=')[1];
    if (arg === '--dry-run') dryRun = true;
  }

  if (!type || !['track-record', 'usage-example', 'market-insight', 'release'].includes(type)) {
    console.error('Usage: --type=track-record|usage-example|market-insight|release [--version=X.Y.Z] [--dry-run]');
    process.exit(1);
  }

  if (type === 'release' && !version) {
    console.error('Error: --type=release requires --version=X.Y.Z');
    process.exit(1);
  }

  return { type: type as CliArgs['type'], version, dryRun };
}

// ── API data fetching ──

interface PerformanceData {
  totalSignals: number;
  overall: { totalSignals: number; totalEvaluated: number; pfeWinRate: number | null };
  byTimeframe: Record<string, { count: number; pfeWinRate: number | null }>;
  byAsset: Record<string, { count: number; tier: number; pfeWinRate: number | null }>;
  period: { from: string; to: string };
}

interface ConfidenceBand {
  band: string;
  count: number;
  evaluated: number;
  pfeWinRate: number | null;
}

async function fetchPerformance(): Promise<PerformanceData> {
  const res = await fetch(`${API_BASE}/api/performance-public`);
  if (!res.ok) throw new Error(`performance-public returned ${res.status}`);
  return res.json() as Promise<PerformanceData>;
}

async function fetchConfidenceBands(): Promise<ConfidenceBand[]> {
  const res = await fetch(`${API_BASE}/api/confidence-bands-public`);
  if (!res.ok) throw new Error(`confidence-bands-public returned ${res.status}`);
  const data = await res.json() as { bands: ConfidenceBand[] } | ConfidenceBand[];
  return Array.isArray(data) ? data : data.bands;
}

async function fetchHealth(): Promise<{ version: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`health returned ${res.status}`);
  return res.json() as Promise<{ version: string }>;
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
}

let mcpSessionId: string | null = null;

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

/** Parse SSE response body to extract JSON-RPC result */
async function parseSseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  // SSE format: "event: message\ndata: {...}\n\n"
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  // Fallback: try parsing whole body as JSON
  return JSON.parse(text);
}

async function initMcpSession(): Promise<void> {
  if (mcpSessionId) return;
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'algovault-forum-bot', version: '1.0.0' },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MCP initialize returned ${res.status}: ${body}`);
  }
  mcpSessionId = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
  await res.text(); // consume body
  // Send initialized notification (fire-and-forget, returns 202 with no body)
  const notifRes = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      ...MCP_HEADERS,
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  await notifRes.text(); // consume
}

async function callMcpTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  await initMcpSession();
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      ...MCP_HEADERS,
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`MCP call ${tool} returned ${res.status}`);
  const json = await parseSseResponse(res) as { result?: McpToolResult };
  if (!json.result?.content?.[0]?.text) throw new Error(`MCP call ${tool}: no content in response`);
  return JSON.parse(json.result.content[0].text);
}

// ── Usage example counter ──

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function getCounterPath(): string {
  if (existsSync(COUNTER_FILE)) return COUNTER_FILE;
  return COUNTER_FILE_LOCAL;
}

function readCounter(): number {
  const path = getCounterPath();
  try {
    const val = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return isNaN(val) ? 1 : val;
  } catch {
    return 1;
  }
}

function incrementCounter(): number {
  const current = readCounter();
  const next = current >= 20 ? 1 : current + 1;
  try {
    writeFileSync(getCounterPath(), String(next), 'utf-8');
  } catch {
    // Non-fatal — counter just won't persist
  }
  return current;
}

// ── Post content generation ──

const USAGE_EXAMPLES = [
  { name: 'Quick BTC Check', level: 'Beginner', prompt: 'Get me a trade call for BTC on the 1h timeframe', tool: 'get_trade_signal', coin: 'BTC', tf: '1h' },
  { name: 'Portfolio Scanner', level: 'Intermediate', prompt: 'Get trade calls for BTC, ETH, SOL, DOGE, XRP, ADA, AVAX, LINK, DOT, and MATIC on the 15m timeframe. Only show me the ones with confidence above 70%.', tool: 'get_trade_signal', coin: 'ETH', tf: '15m' },
  { name: 'Regime-Aware Trading', level: 'Intermediate', prompt: 'First check the market regime for ETH on the 4h timeframe. If it\'s TRENDING_UP or TRENDING_DOWN, get me a trade call on the 15m timeframe. If it\'s RANGING or VOLATILE, skip it.', tool: 'get_market_regime', coin: 'ETH', tf: '4h' },
  { name: 'Funding Arb Monitor', level: 'Intermediate', prompt: 'Scan for funding arbitrage opportunities with a minimum spread of 10 basis points. Show me the top 5 ranked by annualized return.', tool: 'scan_funding_arb', coin: 'BTC', tf: '1h' },
  { name: 'Full 3-Tool Pipeline', level: 'Advanced', prompt: 'For SOL: first get the market regime on 4h, then get a trade call on 15m, then check if there are any funding arb opportunities. Give me a combined recommendation based on all three.', tool: 'get_trade_signal', coin: 'SOL', tf: '15m' },
  { name: 'Multi-Timeframe Confirmation', level: 'Advanced', prompt: 'Get trade calls for ETH on the 5m, 15m, and 1h timeframes. Only tell me to trade if all three agree on the same direction.', tool: 'get_trade_signal', coin: 'ETH', tf: '1h' },
  { name: 'TradFi Rotation', level: 'Advanced', prompt: 'Get the market regime and trade call for TSLA, GOLD, and SP500 on the 4h timeframe. Which one has the strongest trend with the highest confidence trade call?', tool: 'get_trade_signal', coin: 'GOLD', tf: '4h' },
  { name: 'Risk-Gated Entry', level: 'Advanced', prompt: 'Check BTC regime on 4h, then get a trade call on 15m. Only recommend entry if confidence is 75% or higher AND the regime is TRENDING.', tool: 'get_trade_signal', coin: 'BTC', tf: '15m' },
  { name: 'Funding Sentiment Dashboard', level: 'Advanced', prompt: 'Get the market regime for BTC, ETH, and SOL on the 4h timeframe. Summarize the cross-venue funding sentiment for each.', tool: 'get_market_regime', coin: 'BTC', tf: '4h' },
  { name: 'Contrarian Meme Scanner', level: 'Advanced', prompt: 'Get the market regime for DOGE, SHIB, PEPE, WIF, and BONK on 4h. For any TRENDING_UP, get a trade call on 15m. Flag any that return SELL with confidence above 70%.', tool: 'get_trade_signal', coin: 'DOGE', tf: '15m' },
  { name: 'Divergence Detector', level: 'Advanced', prompt: 'For BTC and ETH: get the market regime on 4h and a trade call on 15m. If the trade call says BUY but the regime is TRENDING_DOWN, flag it as a divergence.', tool: 'get_trade_signal', coin: 'BTC', tf: '15m' },
  { name: 'Hourly Digest Bot', level: 'Advanced', prompt: 'Scan BTC, ETH, SOL, AVAX, LINK, DOGE, XRP, ADA for trade calls on 1h. Also get the market regime for BTC and ETH on 4h. Summarize as a brief market digest.', tool: 'get_trade_signal', coin: 'BTC', tf: '1h' },
  { name: 'Hedging Advisor', level: 'Advanced', prompt: 'I\'m currently long ETH. Get the market regime on 4h and a trade call on 1h. If both are bearish, scan funding arb for ETH and tell me which venue has the cheapest short to hedge.', tool: 'get_trade_signal', coin: 'ETH', tf: '1h' },
  { name: 'Volatility Breakout Watch', level: 'Advanced', prompt: 'Check the market regime for BTC, ETH, SOL, AVAX, LINK, and DOGE on 4h. For any in VOLATILE regime with confidence above 70%, get a trade call on 5m.', tool: 'get_market_regime', coin: 'SOL', tf: '4h' },
  { name: 'Cross-Asset Correlation', level: 'Advanced', prompt: 'Get trade calls for BTC, ETH, and SOL on the 1h timeframe. If all three say the same direction, flag it as a market-wide move.', tool: 'get_trade_signal', coin: 'SOL', tf: '1h' },
  { name: 'Funding Cash-and-Carry', level: 'Advanced', prompt: 'Scan funding arb with minimum 10 bps spread. For the top opportunity, get a trade call on 15m. If the trade call agrees with the long side, flag as high-conviction cash-and-carry.', tool: 'scan_funding_arb', coin: 'BTC', tf: '15m' },
  { name: 'Weekend vs Weekday Patterns', level: 'Research', prompt: 'Every 4 hours, get a trade call for BTC on 4h and log the regime, direction, and confidence. After a week, compare weekend vs weekday patterns.', tool: 'get_trade_signal', coin: 'BTC', tf: '4h' },
  { name: 'Agent Portfolio Rebalance', level: 'Advanced', prompt: 'My portfolio holds BTC, ETH, SOL, AVAX, and LINK. Get the market regime for each on the 1d timeframe. Recommend which to overweight (TRENDING) and underweight (VOLATILE/RANGING).', tool: 'get_market_regime', coin: 'AVAX', tf: '1d' },
  { name: 'Smart DCA Bot', level: 'Advanced', prompt: 'I DCA into BTC every day. Before today\'s buy, get a trade call on 4h. If it says SELL with confidence above 70%, skip today\'s buy. Otherwise proceed.', tool: 'get_trade_signal', coin: 'BTC', tf: '4h' },
  { name: 'Multi-Agent War Room', level: 'Expert', prompt: 'Set up three agents: Agent A gets market regime for BTC, ETH, SOL on 4h. Agent B gets trade calls on 15m. Agent C scans funding arb for spreads above 8 bps. Combine into a single dashboard.', tool: 'get_trade_signal', coin: 'BTC', tf: '15m' },
];

const USAGE_TITLES = [
  'How an AI agent analyzes BTC with AlgoVault MCP',
  'Cross-venue funding arb: what AlgoVault sees right now',
  'Market regime detection: is ETH trending or ranging?',
  'Why HOLD calls matter: AlgoVault\'s selective signal engine',
  'TradFi on Hyperliquid: GOLD and TSLA signals via MCP',
];

const INSIGHT_COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'AVAX', 'LINK', 'GOLD', 'TSLA'];

interface Post {
  title: string;
  content: string;
  moltbookSubmolt: string;
  tags: string[];
}

async function generateTrackRecord(): Promise<Post> {
  const [perf, bands] = await Promise.all([fetchPerformance(), fetchConfidenceBands()]);

  const assetCount = Object.keys(perf.byAsset).length;
  // API returns 0-1 ratio; convert to percentage
  const toPercent = (v: number) => v <= 1 ? v * 100 : v;
  const pfeWR = toPercent(perf.overall.pfeWinRate ?? 0);

  // Find top performer by PFE win rate (min 5 evaluated)
  let topAsset = 'BTC'; let topTf = '1h'; let topRate = 0; let topEval = 0;
  for (const [tf, data] of Object.entries(perf.byTimeframe)) {
    const rate = toPercent(data.pfeWinRate ?? 0);
    if (rate > topRate && data.count >= 5) {
      topRate = rate; topTf = tf; topEval = data.count;
    }
  }
  for (const [asset, data] of Object.entries(perf.byAsset)) {
    const rate = toPercent(data.pfeWinRate ?? 0);
    if (rate > topRate && data.count >= 5) {
      topRate = rate; topAsset = asset; topEval = data.count;
    }
  }

  // Best confidence band
  let bestBand = '60-64%'; let bestBandRate = 0;
  for (const band of bands) {
    const rate = toPercent(band.pfeWinRate ?? 0);
    if (rate > bestBandRate && band.evaluated >= 3) {
      bestBandRate = rate; bestBand = band.band;
    }
  }

  const startDate = new Date().toISOString().slice(0, 10);

  const content = `AlgoVault Signal Intelligence — Week of ${startDate}

📊 ${perf.overall.totalSignals.toLocaleString()} trade calls tracked
🎯 PFE Win Rate: ${pfeWR.toFixed(1)}% across ${assetCount}+ assets (Hyperliquid)
🏆 Top performer: ${topAsset} ${topTf} — ${topRate.toFixed(1)}% PFE Win Rate (${topEval} evaluated)
📈 Confidence band ${bestBand} hitting ${bestBandRate.toFixed(1)}% accuracy

All calls are on-chain verified (Base L2 Merkle root).
Live track record: https://algovault.com/track-record
Try it free: https://api.algovault.com/mcp

Built by AlgoVault Labs — signal interpretation for AI trading agents.`;

  return {
    title: `AlgoVault Weekly Signal Report — Week of ${startDate}`,
    content,
    moltbookSubmolt: 'agents',
    tags: ['mcp', 'crypto', 'ai', 'trading'],
  };
}

async function generateUsageExample(): Promise<Post> {
  const exIdx = incrementCounter() - 1; // 0-based
  const example = USAGE_EXAMPLES[exIdx];
  const titleIdx = exIdx % USAGE_TITLES.length;

  // Fetch a live signal for the example's asset
  let verdict = 'HOLD'; let confidence = 0; let reasoning = '';
  let tierLabel = 'Blue Chip';
  try {
    if (example.tool === 'get_trade_signal') {
      const sig = await callMcpTool('get_trade_signal', { coin: example.coin, timeframe: example.tf }) as {
        signal: string; confidence: number; reasoning: string;
      };
      verdict = sig.signal; confidence = sig.confidence; reasoning = sig.reasoning;
    } else if (example.tool === 'get_market_regime') {
      const reg = await callMcpTool('get_market_regime', { coin: example.coin, timeframe: example.tf }) as {
        regime: string; confidence: number; suggestion: string;
      };
      verdict = reg.regime; confidence = reg.confidence; reasoning = reg.suggestion;
    } else if (example.tool === 'scan_funding_arb') {
      const arb = await callMcpTool('scan_funding_arb', { minSpreadBps: 5, limit: 3 }) as {
        opportunities: Array<{ coin: string; bestArb: { spreadBps: number; annualizedPct: number; direction: string } }>;
      };
      if (arb.opportunities.length > 0) {
        const top = arb.opportunities[0];
        verdict = top.bestArb.direction; confidence = 0;
        reasoning = `Top arb: ${top.coin} — ${top.bestArb.spreadBps} bps spread (${top.bestArb.annualizedPct}% annualized). ${top.bestArb.direction}.`;
      }
    }
  } catch (err) {
    console.error(`[usage-example] MCP call failed:`, err instanceof Error ? err.message : err);
    reasoning = 'Live signal data temporarily unavailable.';
  }

  // Truncate reasoning to 2-3 sentences
  const reasoningSentences = reasoning.split('. ').slice(0, 3).join('. ');
  const reasoningTrimmed = reasoningSentences.endsWith('.') ? reasoningSentences : reasoningSentences + '.';

  const content = `${USAGE_TITLES[titleIdx]}

Here's a real-world workflow showing how agents use AlgoVault:

💡 Workflow #${exIdx + 1}: ${example.name} (${example.level})
"${example.prompt}"

And here's what the live signal returned just now:

Tool: ${example.tool}
Asset: ${example.coin} (${tierLabel})
Timeframe: ${example.tf}
Verdict: ${verdict} (${confidence}% confidence)

${reasoningTrimmed}

This is what "signal interpretation" means — we don't tell agents what to trade. We give them the analysis so they can decide.

20 workflows like this in our docs: https://algovault.com/docs.html
Connect in 30 seconds: https://api.algovault.com/mcp`;

  return {
    title: USAGE_TITLES[titleIdx],
    content,
    moltbookSubmolt: 'aitools',
    tags: ['mcp', 'crypto', 'ai', 'trading'],
  };
}

async function generateMarketInsight(): Promise<Post> {
  // Try funding arb first (most interesting), fall back to trade signal
  let title = ''; let body = '';

  try {
    const arb = await callMcpTool('scan_funding_arb', { minSpreadBps: 5, limit: 5 }) as {
      opportunities: Array<{
        coin: string;
        bestArb: { spreadBps: number; annualizedPct: number; direction: string; urgency: { label: string } };
        conviction: { label: string };
      }>;
      scannedPairs: number;
    };

    if (arb.opportunities.length > 0) {
      const top = arb.opportunities[0];
      title = `Funding arb alert: ${top.coin} showing ${top.bestArb.annualizedPct}% annualized spread`;
      const lines = arb.opportunities.slice(0, 3).map(o =>
        `  ${o.coin}: ${o.bestArb.spreadBps} bps (${o.bestArb.annualizedPct}% ann.) — ${o.bestArb.direction} | Urgency: ${o.bestArb.urgency.label} | Conviction: ${o.conviction.label}`
      ).join('\n');
      body = `Top funding arb opportunities right now:\n\n${lines}\n\nScanned ${arb.scannedPairs} pairs across Hyperliquid, Binance, and Bybit. These spreads reflect cross-venue funding rate differences that delta-neutral strategies can capture.`;
    }
  } catch (err) {
    console.error(`[market-insight] Arb call failed:`, err instanceof Error ? err.message : err);
  }

  if (!title) {
    // Fallback: trade signal for a random asset
    const coin = INSIGHT_COINS[Math.floor(Math.random() * INSIGHT_COINS.length)];
    try {
      const sig = await callMcpTool('get_trade_signal', { coin, timeframe: '1h' }) as {
        signal: string; confidence: number; price: number; regime: string;
        indicators: { rsi: number | null; funding_rate: number; squeeze_active: boolean };
        reasoning: string;
      };
      title = `High-conviction call: ${coin} ${sig.signal} at ${sig.confidence}% confidence`;
      const reasonShort = sig.reasoning.split('. ').slice(0, 2).join('. ') + '.';
      body = `${coin} 1h analysis:\n\n  Verdict: ${sig.signal} (${sig.confidence}% confidence)\n  Price: $${sig.price.toLocaleString()}\n  Regime: ${sig.regime}\n  RSI: ${sig.indicators.rsi?.toFixed(1) ?? 'N/A'}\n  Funding: ${(sig.indicators.funding_rate * 100).toFixed(4)}%\n  Squeeze: ${sig.indicators.squeeze_active ? 'ACTIVE' : 'No'}\n\n${reasonShort}`;
    } catch {
      throw new Error('Both arb and signal APIs failed — skipping this run');
    }
  }

  const content = `${title}

Live from AlgoVault's signal engine:

${body}

⚠️ This is signal interpretation, not financial advice. AlgoVault helps AI agents analyze — execution decisions are theirs.

Real-time signals: https://api.algovault.com/mcp
Full track record: https://algovault.com/track-record`;

  return {
    title,
    content,
    moltbookSubmolt: 'agents',
    tags: ['mcp', 'crypto', 'ai', 'trading'],
  };
}

async function generateRelease(version: string): Promise<Post> {
  const health = await fetchHealth();
  const perf = await fetchPerformance();

  // Parse changelog from git log
  let changelogItems: string[] = [];
  try {
    const { execSync } = await import('node:child_process');
    // Find previous tag
    const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    const prevTag = tags.find(t => t !== `v${version}`) || tags[0];
    if (prevTag) {
      const log = execSync(`git log ${prevTag}..HEAD --oneline --no-merges`, { encoding: 'utf-8' });
      const SKIP_PATTERNS = /refactor|chore|internal|scoring|weight|threshold|calibrat/i;
      changelogItems = log.trim().split('\n')
        .map(line => line.replace(/^[a-f0-9]+ /, '')) // strip hash
        .filter(line => line && !SKIP_PATTERNS.test(line))
        .slice(0, 7);
    }
  } catch { /* no git available or no tags */ }

  if (changelogItems.length === 0) {
    changelogItems = [`Version ${version} with performance and stability improvements`];
  }

  const bullets = changelogItems.map(item => `- ${item}`).join('\n');
  const assetCount = Object.keys(perf.byAsset).length;
  const rawWR = perf.overall.pfeWinRate ?? 0;
  const pfeWR = rawWR <= 1 ? rawWR * 100 : rawWR;

  const content = `AlgoVault MCP v${version} is live

What's new:

${bullets}

Now tracking ${assetCount}+ assets with ${pfeWR.toFixed(1)}% PFE Win Rate across ${perf.overall.totalEvaluated.toLocaleString()} evaluated calls.

Upgrade now — remote agents get the new version automatically:
🔗 Remote: https://api.algovault.com/mcp
📦 npm: npx -y crypto-quant-signal-mcp@${version}
📖 Docs: https://algovault.com/docs.html
📊 Track record: https://algovault.com/track-record

Built by AlgoVault Labs — signal interpretation for AI trading agents.`;

  return {
    title: `AlgoVault MCP v${version} — What's New`,
    content,
    moltbookSubmolt: 'agents',
    tags: ['mcp', 'crypto', 'ai', 'release'],
  };
}

// ── Platform publishers ──

async function publishMoltbook(post: Post): Promise<string | null> {
  const key = process.env.MOLTBOOK_API_KEY;
  if (!key) { console.log('[moltbook] MOLTBOOK_API_KEY not set — skipping'); return null; }

  const res = await fetch('https://www.moltbook.com/api/v1/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ submolt: post.moltbookSubmolt, title: post.title, content: post.content }),
  });

  if (res.status === 429) {
    console.log('[moltbook] Rate limited — retrying in 30s');
    await new Promise(r => setTimeout(r, 30_000));
    const retry = await fetch('https://www.moltbook.com/api/v1/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ submolt: post.moltbookSubmolt, title: post.title, content: post.content }),
    });
    if (!retry.ok) {
      const body = await retry.text();
      console.error(`[moltbook] Retry failed: ${retry.status} — ${body}`);
      return null;
    }
    const data = await retry.json() as Record<string, unknown>;
    const postUrl = (data.url as string) || (data.slug ? `https://www.moltbook.com/post/${data.slug}` : null) || (data.id ? `https://www.moltbook.com/post/${data.id}` : null);
    console.log(`[moltbook] Published (retry): ${postUrl || 'ok (no URL in response)'}`);
    return postUrl || 'published';
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[moltbook] Failed: ${res.status} — ${body}`);
    return null;
  }

  const data = await res.json() as Record<string, unknown>;
  const postUrl = (data.url as string) || (data.slug ? `https://www.moltbook.com/post/${data.slug}` : null) || (data.id ? `https://www.moltbook.com/post/${data.id}` : null);
  console.log(`[moltbook] Published: ${postUrl || 'ok (no URL in response)'}`);
  console.log(`[moltbook] Response keys: ${Object.keys(data).join(', ')}`);
  return postUrl || 'published';
}

async function publishDevTo(post: Post): Promise<string | null> {
  const key = process.env.DEVTO_API_KEY;
  if (!key) { console.log('[devto] DEVTO_API_KEY not set — skipping'); return null; }

  const res = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify({ article: { title: post.title, body_markdown: post.content, published: true, tags: post.tags } }),
  });

  if (res.status === 429) {
    console.log('[devto] Rate limited — retrying in 30s');
    await new Promise(r => setTimeout(r, 30_000));
    const retry = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': key },
      body: JSON.stringify({ article: { title: post.title, body_markdown: post.content, published: true, tags: post.tags } }),
    });
    if (!retry.ok) {
      const body = await retry.text();
      console.error(`[devto] Retry failed: ${retry.status} — ${body}`);
      return null;
    }
    const data = await retry.json() as { url?: string };
    console.log(`[devto] Published (retry): ${data.url}`);
    return data.url || 'published';
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[devto] Failed: ${res.status} — ${body}`);
    return null;
  }

  const data = await res.json() as { url?: string };
  console.log(`[devto] Published: ${data.url}`);
  return data.url || 'published';
}

async function publishHashnode(post: Post): Promise<string | null> {
  const pat = process.env.HASHNODE_PAT;
  const pubId = process.env.HASHNODE_PUBLICATION_ID;
  if (!pat || !pubId) { console.log('[hashnode] HASHNODE_PAT or HASHNODE_PUBLICATION_ID not set — skipping'); return null; }

  const mutation = `mutation PublishPost($input: PublishPostInput!) {
    publishPost(input: $input) { post { url } }
  }`;

  const variables = {
    input: {
      title: post.title,
      contentMarkdown: post.content,
      publicationId: pubId,
      tags: post.tags.map(t => ({ slug: t, name: t })),
    },
  };

  const res = await fetch('https://gql.hashnode.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': pat },
    body: JSON.stringify({ query: mutation, variables }),
  });

  if (res.status === 429) {
    console.log('[hashnode] Rate limited — retrying in 30s');
    await new Promise(r => setTimeout(r, 30_000));
    const retry = await fetch('https://gql.hashnode.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': pat },
      body: JSON.stringify({ query: mutation, variables }),
    });
    if (!retry.ok) {
      const body = await retry.text();
      console.error(`[hashnode] Retry failed: ${retry.status} — ${body}`);
      return null;
    }
    const data = await retry.json() as { data?: { publishPost?: { post?: { url?: string } } } };
    const url = data?.data?.publishPost?.post?.url;
    console.log(`[hashnode] Published (retry): ${url}`);
    return url || 'published';
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`[hashnode] Failed: ${res.status} — ${body}`);
    return null;
  }

  const data = await res.json() as { data?: { publishPost?: { post?: { url?: string } } } };
  const url = data?.data?.publishPost?.post?.url;
  console.log(`[hashnode] Published: ${url}`);
  return url || 'published';
}

// ── Main ──

async function main() {
  const args = parseArgs();
  const ts = new Date().toISOString();
  console.log(`[${ts}] agent-forum-post: type=${args.type} dryRun=${args.dryRun}`);

  let post: Post;
  try {
    switch (args.type) {
      case 'track-record': post = await generateTrackRecord(); break;
      case 'usage-example': post = await generateUsageExample(); break;
      case 'market-insight': post = await generateMarketInsight(); break;
      case 'release': post = await generateRelease(args.version!); break;
    }
  } catch (err) {
    console.error(`[${ts}] API error — skipping this run:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Word count check
  const wordCount = post.content.split(/\s+/).length;
  console.log(`[${ts}] Post generated: "${post.title}" (${wordCount} words)`);

  if (args.dryRun) {
    console.log('\n=== DRY RUN — Moltbook (m/' + post.moltbookSubmolt + ') ===');
    console.log(`Title: ${post.title}`);
    console.log(post.content);
    console.log('\n=== DRY RUN — Dev.to ===');
    console.log(`Title: ${post.title}`);
    console.log(`Tags: ${post.tags.join(', ')}`);
    console.log(post.content);
    console.log('\n=== DRY RUN — Hashnode ===');
    console.log(`Title: ${post.title}`);
    console.log(post.content);
    console.log(`\n[${ts}] Dry run complete — no posts published.`);
    return;
  }

  // Publish to all platforms
  const results: Record<string, string | null> = {};
  results.moltbook = await publishMoltbook(post);
  results.devto = await publishDevTo(post);
  results.hashnode = await publishHashnode(post);

  const published = Object.entries(results).filter(([, v]) => v).map(([k]) => k);
  const skipped = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);

  console.log(`[${ts}] Done. Published: ${published.join(', ') || 'none'}. Skipped: ${skipped.join(', ') || 'none'}.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
