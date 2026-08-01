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
 *   npx tsx src/scripts/agent-forum-post.ts --self-audit
 *
 * Env vars (all optional — missing = skip that platform):
 *   MOLTBOOK_API_KEY, DEVTO_API_KEY, HASHNODE_PAT, HASHNODE_PUBLICATION_ID
 *   FORUM_POST_KILL_SWITCH=1 — abort without publishing (for emergency halt)
 */

import { stripExternalUrlsForModeration } from '../lib/forum-post-content.js';
import { checkForumPost } from '../lib/forum-post-gate.js';
import { type RenderableScanCall } from '../lib/scan-digest.js';
import { composeMarketInsightPost } from '../lib/market-insight-post.js';
import { FUNDING_VENUE_LIST_TEXT } from '../lib/funding-venues.js';
import {
  verifyHashnodePost,
  verifyHashnodePostMultiStageDeferred,
  verifyMoltbookPost,
  verifyDevtoPost,
  type VerifyResult,
} from '../lib/forum-post-verify.js';
import {
  recordFailure,
  countRecentFailures,
  hasUnrecoveredFailure,
  countUnrecoveredIndeterminate,
  clearIndeterminate,
  INDETERMINATE_REASON_PREFIX,
  recordPublished,
  getRecentPublished,
} from '../lib/forum-post-failures.js';
import {
  classifyProbeFailure,
  shouldEscalateIndeterminate,
  INDETERMINATE_ESCALATE_STREAK,
} from '../lib/probe-failure-class.js';
import { sendAlert } from '../lib/telegram.js';

const API_BASE = 'https://api.algovault.com';
const MCP_ENDPOINT = `${API_BASE}/mcp`;
const COUNTER_FILE = '/opt/crypto-quant-signal-mcp/usage-example-counter.txt';
// Fallback for local dev / dry-run
const COUNTER_FILE_LOCAL = './usage-example-counter.txt';

// Canonical back-link per post type — set on Hashnode via
// `originalArticleURL` (the real name of the canonical field on the
// current Hashnode schema — see
// experiments/crypto-quant-signal/platform-api-schemas-2026-04-15.md)
// and on Dev.to via `canonical_url`. Moltbook has no canonical-URL
// field; its body is stripped and accepts the information loss.
// Canonical back-link per post type. Appends a date suffix so Dev.to
// doesn't reject weekly repeats with "Canonical url has already been taken"
// (422 observed 2026-04-19 on the track-record post — same canonical URL
// from the prior week was already registered). The date suffix makes each
// week's post a unique canonical while still pointing at the real page.
function getCanonical(postType: string): string {
  const dateTag = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const base: Record<string, string> = {
    'track-record': 'https://algovault.com/track-record',
    'usage-example': 'https://algovault.com/docs.html',
    'market-insight': 'https://algovault.com/track-record',
    release: 'https://algovault.com/docs.html',
  };
  return `${base[postType] ?? 'https://algovault.com/'}?d=${dateTag}`;
}

const CANONICAL_DOMAIN = 'algovault.com';

// ── Calls-to-action (FIX-CONVICTION-CALL-POSTS-W1) ──
//
// THE BUG THIS CLOSES: every CTA was authored as a BARE url —
//     Real-time signals: https://api.algovault.com/mcp
// and `publishDevTo` runs the body through `stripExternalUrlsForModeration`,
// whose Pass 2 deletes every bare URL *including* canonical-domain ones (the
// strip is deliberate and test-locked; the docblock says intent must be
// expressed as MARKUP). So the published post ended with two naked labels:
//     Real-time signals:
//     Full track record:
// Live proof: dev.to article 4280654 (2026-07-31) ends exactly that way. This
// affected ALL FOUR post types, not one — so the fix is here, at the single
// authoring site, not per-type.
//
// TWO RULES, both load-bearing:
//   1. Author every CTA as a MARKDOWN LINK. Never "fix" this by weakening the
//      strip — the strip is what keeps these posts out of spam moderation.
//   2. Every CTA target must be reachable BY A HUMAN IN A BROWSER. The old copy
//      pointed at `https://api.algovault.com/mcp`, which is a POST-only MCP
//      endpoint and answers a browser with 405 — a dead CTA even once un-blanked.
//      Human-facing CTAs therefore point at pages, never at the MCP endpoint.
//
// `?src=devto` is a real `ATTRIBUTION_SOURCES` enum member (attribution-sources.ts),
// so a click lands in the `devto` funnel bucket instead of the `unknown` default-deny.
const CTA_SRC = 'devto';
const CTA_TRACK_RECORD = `https://algovault.com/track-record?src=${CTA_SRC}`;
const CTA_DOCS = `https://algovault.com/docs?src=${CTA_SRC}`;
/** Primary CTA per brand. Verified live: profile "AlgoVault Official Bot".
 *  Telegram usernames are case-insensitive, so casing in copy is safe. NOTE the
 *  near-misses `algovaultlabsbot` / `algovaultsignalsbot` are UNREGISTERED and two
 *  other near-misses resolve to unrelated third-party bots — never retype this by hand. */
const CTA_TELEGRAM = 'https://t.me/algovaultofficialbot';
/** Hosts whose markdown links survive moderation stripping. First-party only —
 *  the Telegram bot cannot live on the canonical domain, and without this entry the
 *  primary CTA is reduced to link TEXT with the handle dropped entirely. */
const CTA_KEEP_HOSTS = ['t.me'];

/** The ONE strip configuration every publisher + the dry-run preview share, so a
 *  preview can never disagree with what actually ships. (`stripAllUrls` mode passes
 *  `{}` deliberately — that path strips everything, allowlist included.) */
const STRIP_KEEP_OPTS = { keepCanonicalDomain: CANONICAL_DOMAIN, keepHosts: CTA_KEEP_HOSTS };

/** Render CTA rows as markdown links — the ONE authoring site for every post type. */
function ctaLines(items: Array<{ label: string; url: string }>): string {
  return items.map(({ label, url }) => `${label}: [${url.replace(/^https?:\/\//, '').split('?')[0]}](${url})`).join('\n');
}

// ── CLI argument parsing ──

interface CliArgs {
  type: 'track-record' | 'usage-example' | 'market-insight' | 'release';
  version?: string;
  dryRun: boolean;
  selfAudit: boolean;
  /** Smoke-test probe tag. Prefixes post title with `[testTag] TEST — ` and appends a "safe to delete" footer. Used to verify the hardened publish+verify+audit chain end-to-end. */
  testTag?: string;
  /** A/B test: strip ALL external URLs (incl. canonical-domain) from the Hashnode body before publishing. Used to test the hypothesis that URL density triggers Hashnode anti-spam. */
  hashnodeStripUrls: boolean;
  /** Re-verify recent posts from forum_post_audit_log without publishing. Read-only; ignores --type. */
  verifyOnly: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let type: string | undefined;
  let version: string | undefined;
  let dryRun = false;
  let selfAudit = false;
  let testTag: string | undefined;
  let hashnodeStripUrls = false;
  let verifyOnly = false;

  for (const arg of args) {
    if (arg.startsWith('--type=')) type = arg.split('=')[1];
    if (arg.startsWith('--version=')) version = arg.split('=')[1];
    if (arg === '--dry-run') dryRun = true;
    if (arg === '--self-audit') selfAudit = true;
    if (arg.startsWith('--test-tag=')) testTag = arg.split('=')[1];
    if (arg === '--hashnode-strip-urls') hashnodeStripUrls = true;
    if (arg === '--verify-only') verifyOnly = true;
  }

  // --verify-only and --self-audit are read-only and ignore --type / --version.
  if (verifyOnly || selfAudit) {
    return {
      type: (type as CliArgs['type']) ?? 'track-record',
      version,
      dryRun,
      selfAudit,
      testTag,
      hashnodeStripUrls,
      verifyOnly,
    };
  }

  if (!type || !['track-record', 'usage-example', 'market-insight', 'release'].includes(type)) {
    console.error('Usage: --type=track-record|usage-example|market-insight|release [--version=X.Y.Z] [--dry-run] [--test-tag=NAME] [--hashnode-strip-urls] | --self-audit | --verify-only');
    process.exit(1);
  }

  if (type === 'release' && !version) {
    console.error('Error: --type=release requires --version=X.Y.Z');
    process.exit(1);
  }

  return {
    type: type as CliArgs['type'],
    version,
    dryRun,
    selfAudit: false,
    testTag,
    hashnodeStripUrls,
    verifyOnly: false,
  };
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
  // OPS-HL-INTERACTIVE-PRIORITY-W1 / FIX-CONVICTION-CALL-POSTS-W1: this ENTIRE script is a
  // cron. Nobody is waiting on it, so every call it makes belongs in the batch lane and
  // must yield the interactive reserve to live callers. `index.ts:700-707` routes on this
  // header; the comment there records the measured cost of getting it wrong — 161 of 171
  // Hyperliquid interactive rate-limit throws in one week, all inside a single minute, from
  // exactly this kind of weekly venue fan-out.
  //
  // It is set GLOBALLY rather than per-call ON PURPOSE. A per-call flag is one a future
  // call site can forget, which is precisely how the original incident happened; a header
  // on the shared client cannot be forgotten by construction.
  'X-AlgoVault-Priority': 'background',
  // ⚠️ THE PRIORITY HEADER ABOVE IS INERT WITHOUT THIS ONE.
  // `resolveBackgroundPriority` (license.ts:146-153) opens with `if (tier !== 'internal')
  // return false`, so an UNAUTHENTICATED caller's priority hint is discarded and the
  // request runs in the interactive lane regardless. Sending the priority header alone was
  // pure ceremony — it looked like the HL-throw incident had been addressed while changing
  // nothing at all.
  //
  // It also closes a second, quieter problem. With no credential, `resolveLicense` falls
  // through to the FREE tier (quota 100/mo, keyed `free:${ipHash}` and PERSISTED to
  // Postgres), so a weekly 15-venue fan-out would consume — and eventually exhaust — the
  // free allowance attached to our own server's IP, on our own server.
  //
  // Read at call time and simply ABSENT when unset: this script also runs locally and in
  // dry runs, where there is no bypass key and free-tier is the correct behaviour.
  // `checkInternalBypass` additionally requires BOT_INTERNAL_BYPASS_ENABLED=true
  // server-side, so a stray key on its own grants nothing.
  ...(process.env.ALGOVAULT_INTERNAL_BYPASS_KEY
    ? { 'X-AlgoVault-Internal-Key': process.env.ALGOVAULT_INTERNAL_BYPASS_KEY }
    : {}),
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
  const json = await parseSseResponse(res) as { result?: McpToolResult & { isError?: boolean } };
  if (!json.result?.content?.[0]?.text) throw new Error(`MCP call ${tool}: no content in response`);
  // FAIL LOUD on a tool-level error. An MCP tool error comes back as a SUCCESSFUL JSON-RPC
  // result carrying `isError: true` — there is no `json.error` to check — so without this
  // guard the error ENVELOPE is returned as if it were data. That is not hypothetical: the
  // editorial pipeline shipped ~18 posts embedding a `-32602` envelope as its "live API
  // response" block before the same guard was added there (fixed 2026-07-24, `5e5df16`).
  if (json.result.isError) {
    throw new Error(`MCP_TOOL_ERROR ${tool}: ${json.result.content[0].text.slice(0, 300)}`);
  }
  return JSON.parse(json.result.content[0].text);
}

// ── Weekly cross-venue scan showcase (FIX-CONVICTION-CALL-POSTS-W1) ──
//
// These mirror `algovault_bot.adoption`'s showcase constants so the dev.to digest and the
// Telegram digest are the same ARTIFACT rendered from the same params. They intentionally
// do NOT mirror the bot's venue LIST: that list is a hardcoded 12 whose own "verified live"
// comment has already drifted (the live enum is 15), so the set is derived at runtime.
const SHOWCASE_TOP_N = 100;        // adoption.py SHOWCASE_TOP_N — also the schema ceiling
const SHOWCASE_TIMEFRAME = '1h';   // adoption.py SHOWCASE_TIMEFRAME
/** Max setups in the post. The spec asks for 3-5; the bot shows 3. Selection may differ
 *  between surfaces (each scans its own day) — only the RENDER is single-derived. */
const SHOWCASE_MAX_SETUPS = 5;
/** USD liquidity floor. Same figure as `scan_funding_arb`'s per-leg gate, and for the same
 *  reason: below it, a "setup" is not executable enough to publish under our own byline. */
const SHOWCASE_MIN_LIQUIDITY_USD = 5_000_000;

/** The wire shape — everything off the MCP is untyped JSON until validated. */
interface RawScanCall {
  coin?: unknown; call?: unknown; confidence?: unknown; regime?: unknown; price?: unknown;
  factors?: unknown; reasoning?: unknown; oi_change_window?: unknown;
}
interface ScanResult {
  scanned: number;
  calls: RawScanCall[];
  errors?: number;
}

/** ALLOW-list, not a deny-list: a setup is a BUY or a SELL, full stop. Skipping only
 *  `HOLD` would silently admit any NEW verdict the engine ever starts emitting. */
const SETUP_VERDICTS = new Set(['BUY', 'SELL']);
/** Same reasoning for the regime label. It is rendered verbatim into a public post, so an
 *  unrecognised value means our reading of the payload has gone stale — and the right
 *  response to "we do not understand this row" is to drop the row and say so, not print it. */
const KNOWN_REGIMES = new Set<string>(['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE']);

/**
 * The venue set, read from the LIVE tool schema rather than a literal.
 *
 * `scan_trade_calls` takes a SINGULAR `exchange` (there is no `venues` param), so a
 * cross-venue scan is an N-call fan-out and something has to supply N. Reading
 * `tools/list` means a newly promoted venue joins the digest automatically — and, more to
 * the point, a DEMOTED one disappears instead of erroring every week. The bot's equivalent
 * hardcoded list is the cautionary case: it carries a comment asserting "verified live:
 * enum == these 12" and the live enum is now 15.
 */
async function fetchScanVenues(): Promise<string[]> {
  await initMcpSession();
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  if (!res.ok) throw new Error(`MCP tools/list returned ${res.status}`);
  const json = await parseSseResponse(res) as {
    result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, { enum?: string[] }> } }> };
  };
  const venues = json.result?.tools?.find((t) => t.name === 'scan_trade_calls')
    ?.inputSchema?.properties?.exchange?.enum;
  if (!venues?.length) throw new Error('MCP tools/list: scan_trade_calls exposes no exchange enum');
  return venues;
}

/**
 * Fan out `scan_trade_calls` across every venue and aggregate the fresh (non-HOLD) calls.
 *
 * Mirrors `adoption.fetch_showcase_setups`: dedupe by coin keeping the highest-confidence
 * venue, sum `scanned` for the "N assets" figure, and count venues that answered for the
 * "M venues" figure. Both counts are LIVE-derived; neither is ever a literal.
 *
 * A single venue failing must not abort the digest — but unlike the bot, this also RETURNS
 * the error count, because a 9-of-15 run and a 15-of-15 run print an identical sentence
 * and the difference should not be invisible to the operator.
 */
async function fetchShowcaseSetups(): Promise<{
  setups: RenderableScanCall[]; assetCount: number; venueCount: number; venuesFailed: number; venues: string[];
}> {
  const venues = await fetchScanVenues();
  const bestByCoin = new Map<string, RenderableScanCall>();
  let assetCount = 0;
  let venueCount = 0;
  let venuesFailed = 0;

  for (const exchange of venues) {
    let result: ScanResult;
    try {
      result = await callMcpTool('scan_trade_calls', {
        topN: SHOWCASE_TOP_N,
        timeframe: SHOWCASE_TIMEFRAME,
        exchange,
        includeReasoning: true,
        minLiquidityUsd: SHOWCASE_MIN_LIQUIDITY_USD,
      }) as ScanResult;
    } catch (err) {
      venuesFailed++;
      console.error(`[market-insight] venue ${exchange} failed:`, err instanceof Error ? err.message : err);
      continue;
    }
    venueCount++;
    // Count scans that actually produced a VERDICT, not the universe we set out to scan.
    // `scanned` is the post-filter universe size measured BEFORE any per-coin scoring, and
    // `errors` counts the cells that then failed — a live probe returned Hyperliquid
    // {scanned:100, errors:81}. Publishing the raw universe would have overstated the work
    // roughly 5x on that venue, in the headline figure, which is exactly the kind of
    // unearned number the Numerical-citation rule exists to stop. The subtraction is exact:
    // holds + eligible_non_hold + errors == scanned, verified against live responses.
    const attempted = Number.isFinite(result.scanned) ? result.scanned : 0;
    const failedCells = Number.isFinite(result.errors) ? Number(result.errors) : 0;
    assetCount += Math.max(0, attempted - failedCells);
    for (const c of result.calls ?? []) {
      const verdict = String(c.call ?? '').toUpperCase();
      if (!SETUP_VERDICTS.has(verdict)) continue;
      const coin = String(c.coin ?? '').toUpperCase();
      const confidence = Number(c.confidence);
      const regime = String(c.regime ?? '');
      // A setup we cannot label or score is not publishable — drop it rather than render
      // "undefined% conviction" into a public post.
      if (!coin || !Number.isFinite(confidence)) continue;
      if (!KNOWN_REGIMES.has(regime)) {
        console.warn(`[market-insight] ${exchange}/${coin}: unrecognised regime '${regime}' — dropping from the digest`);
        continue;
      }
      const prev = bestByCoin.get(coin);
      if (prev && prev.confidence >= confidence) continue;
      bestByCoin.set(coin, {
        coin,
        call: verdict as RenderableScanCall['call'],
        confidence,
        regime: regime as RenderableScanCall['regime'],
        ...(Number.isFinite(Number(c.price)) ? { price: Number(c.price) } : {}),
        ...(Array.isArray(c.factors) ? { factors: c.factors as RenderableScanCall['factors'] } : {}),
        ...(typeof c.reasoning === 'string' ? { reasoning: c.reasoning } : {}),
        ...(typeof c.oi_change_window === 'string' ? { oi_change_window: c.oi_change_window } : {}),
      });
    }
  }

  const setups = [...bestByCoin.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, SHOWCASE_MAX_SETUPS);
  return { setups, assetCount, venueCount, venuesFailed, venues };
}

/**
 * The modal regime across a venue's full scan, HOLDs included — for the quiet-week note.
 *
 * Only called when there are no setups, and scoped honestly: it reports what one venue's
 * universe looked like, never "the market". Returns null rather than guessing.
 */
async function fetchModalRegime(venue: string): Promise<string | null> {
  try {
    const r = await callMcpTool('scan_trade_calls', {
      topN: SHOWCASE_TOP_N, timeframe: SHOWCASE_TIMEFRAME, exchange: venue,
      includeHolds: true, limit: 100, minLiquidityUsd: SHOWCASE_MIN_LIQUIDITY_USD,
    }) as ScanResult;
    const tally = new Map<string, number>();
    for (const c of r.calls ?? []) {
      const g = String(c.regime ?? '').trim();
      if (g) tally.set(g, (tally.get(g) ?? 0) + 1);
    }
    if (tally.size === 0) return null;
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  } catch {
    return null;
  }
}

// ── Usage example counter ──

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
// Used by generateRelease() to parse CHANGELOG.md without shelling out to git.
import { parseChangelog } from '../lib/changelog-parser.js';

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
  'Why HOLD calls matter: AlgoVault\'s selective engine',
  'TradFi on Hyperliquid: GOLD and TSLA calls via MCP',
];

// FIX-CONVICTION-CALL-POSTS-W1: `INSIGHT_COINS` is GONE. It was an 8-coin list the
// market-insight fallback picked from at RANDOM to headline a "High-conviction call" —
// the mechanism by which a 35%-confidence HOLD on a coin nobody chose became a published
// claim of high conviction. The fallback now scans every venue and reports what it found.

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

${ctaLines([
  { label: '📊 Live track record', url: CTA_TRACK_RECORD },
  { label: '🔌 Connect an agent', url: CTA_DOCS },
  { label: '🛰 Set a standing scan in Telegram', url: CTA_TELEGRAM },
])}

Built by AlgoVault Labs — call interpretation for AI trading agents.`;

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
      // v1.10.0 dual-emit: response now contains BOTH `call` (canonical) and
      // `signal` (legacy). Read `call ?? signal` for graceful fall-through
      // during the deprecation window. C5 will strip the `signal` field and
      // this fallback becomes a hard `tc.call`.
      const tc = await callMcpTool('get_trade_signal', { coin: example.coin, timeframe: example.tf }) as {
        call?: string; signal?: string; confidence: number; reasoning: string;
      };
      verdict = (tc.call ?? tc.signal) as string;
      confidence = tc.confidence;
      reasoning = tc.reasoning;
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
    reasoning = 'Live call data temporarily unavailable.';
  }

  // Truncate reasoning to 2-3 sentences
  const reasoningSentences = reasoning.split('. ').slice(0, 3).join('. ');
  const reasoningTrimmed = reasoningSentences.endsWith('.') ? reasoningSentences : reasoningSentences + '.';

  const content = `${USAGE_TITLES[titleIdx]}

Here's a real-world workflow showing how agents use AlgoVault:

💡 Workflow #${exIdx + 1}: ${example.name} (${example.level})
"${example.prompt}"

And here's what the live call returned just now:

Tool: ${example.tool}
Asset: ${example.coin} (${tierLabel})
Timeframe: ${example.tf}
Verdict: ${verdict} (${confidence}% confidence)

${reasoningTrimmed}

This is what "call interpretation" means — we don't tell agents what to trade. We give them the analysis so they can decide.

${ctaLines([
  { label: '📖 20 workflows like this in our docs', url: CTA_DOCS },
  { label: '📊 Full verified track record', url: CTA_TRACK_RECORD },
])}`;

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
      body = `Top funding arb opportunities right now:\n\n${lines}\n\nScanned ${arb.scannedPairs} pairs across ${FUNDING_VENUE_LIST_TEXT}. These spreads reflect cross-venue funding rate differences that delta-neutral strategies can capture.`;
    }
  } catch (err) {
    console.error(`[market-insight] Arb call failed:`, err instanceof Error ? err.message : err);
  }

  if (!title) {
    // ── Fallback: the WEEKLY CROSS-VENUE SCAN DIGEST (FIX-CONVICTION-CALL-POSTS-W1) ──
    //
    // WHAT THIS REPLACED, and why it had to go. The old fallback picked a coin at RANDOM
    // from an 8-item list, asked for one trade call, and titled the result
    // "High-conviction call: {COIN} {VERDICT} at {N}% confidence" — regardless of the
    // verdict or the number. The engine holds ~98% of the time BY DESIGN, so the usual
    // output was a HOLD: on 2026-07-31 it published "High-conviction call: LINK HOLD at
    // 35% confidence". That is manufactured conviction. It asserts high conviction over a
    // low-confidence non-call, which is precisely the kind of claim the whole
    // verifiable-track-record posture exists to not make.
    //
    // The replacement shows the market as it actually was: a real cross-venue scan, the
    // top setups ranked by conviction with their REAL percentages, and an honest note when
    // there is nothing to show. 49-58% is fine to print — it is labelled "top setups this
    // week", not "high conviction".
    const monthTag = new Date().toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    let scan: Awaited<ReturnType<typeof fetchShowcaseSetups>>;
    try {
      scan = await fetchShowcaseSetups();
    } catch (err) {
      throw new Error(`Both arb and scan APIs failed — skipping this run: ${err instanceof Error ? err.message : err}`);
    }
    if (scan.venueCount === 0 || scan.assetCount === 0) {
      // Publishing "0 assets across N venues" is a false claim about coverage, not a quiet
      // week — and BOTH counts have to be checked. Guarding only `venueCount` left a real
      // hole: every venue can answer successfully with `scanned: 0` (an unreachable
      // liquidity source makes the floor deny the whole universe, by design), which yields
      // venueCount=15, assetCount=0 and the sentence "I scanned 0 assets across 15 venues".
      // A total-coverage failure is an outage; skip the slot and keep the silence.
      throw new Error(
        `Scan fan-out produced no coverage (venues=${scan.venueCount}, assets=${scan.assetCount}) — skipping this run rather than publishing an empty coverage claim`,
      );
    }

    // Composition lives in `lib/market-insight-post.ts` (pure) so it is unit-testable —
    // this file calls `main()` at import, so nothing in it can be. The tests therefore
    // exercise the ACTUAL published copy rather than a transcription of it, which is the
    // distinction that matters: the defect this wave fixes lived in published copy no test
    // ever looked at. The clock and the network stay here; the words live there.
    // The regime probe is only worth a call on a quiet week — it exists solely for that
    // branch's sentence, so a week WITH setups must not pay for it.
    const regime = scan.setups.length === 0 ? await fetchModalRegime(scan.venues[0]) : null;
    const composed = composeMarketInsightPost(
      { setups: scan.setups, assetCount: scan.assetCount, venueCount: scan.venueCount, probeVenue: scan.venues[0] },
      monthTag,
      regime,
    );
    title = composed.title;
    body = composed.body;
    console.log(`[market-insight] scan digest: kind=${composed.kind} setups=${scan.setups.length} assets=${scan.assetCount} venues=${scan.venueCount} failed=${scan.venuesFailed}`);
    if (scan.venuesFailed > 0) {
      console.warn(`[market-insight] ${scan.venuesFailed} venue(s) failed to scan — counts reflect ${scan.venueCount} that answered`);
    }
  }

  const content = `${title}

Live from AlgoVault's engine:

${body}

⚠️ This is call interpretation, not financial advice. AlgoVault helps AI agents analyze — execution decisions are theirs.

${ctaLines([
  { label: '🛰 Want this on your coins automatically? Set a standing scan', url: CTA_TELEGRAM },
  { label: '📊 See the full verified track record', url: CTA_TRACK_RECORD },
])}`;

  return {
    title,
    content,
    moltbookSubmolt: 'agents',
    tags: ['mcp', 'crypto', 'ai', 'trading'],
  };
}

// ── Release post helpers (git-free; read version + changelog from files) ──

/**
 * Resolve a filename that ships alongside the compiled script by trying a
 * short list of plausible locations. Matches the pattern used by
 * `getCounterPath()` above — we check the production Docker path first, then
 * fall back to cwd for local dev. No `node:path` import needed; string
 * concatenation is sufficient because every candidate is absolute or relative
 * to process cwd.
 */
function resolveRepoFile(filename: string): string | null {
  const candidates = [
    `/app/${filename}`, // Docker production (WORKDIR /app, see Dockerfile)
    `/opt/crypto-quant-signal-mcp/${filename}`, // VPS host path (matches COUNTER_FILE convention)
    `./${filename}`, // local dev / tests (cwd = repo root)
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // existsSync swallows most errors but guard anyway
    }
  }
  return null;
}

/**
 * Read the `version` field from package.json without executing any git or
 * shell commands. Returns `null` if the file is missing or malformed — the
 * caller decides what to do with that.
 */
function readPackageVersion(): string | null {
  const path = resolveRepoFile('package.json');
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Read CHANGELOG.md from disk and return its raw text. Returns `null` if the
 * file does not exist. Errors (permission, IO, encoding) are swallowed and
 * reported as `null` so the caller can fall back to the hardcoded template.
 */
function readChangelogMarkdown(): string | null {
  const path = resolveRepoFile('CHANGELOG.md');
  if (!path) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

async function generateRelease(version?: string): Promise<Post> {
  // ── 1. Resolve the authoritative version from package.json ──
  //
  // Per the hardening spec, package.json is the source of truth. If the
  // caller passed a `--version=X.Y.Z` CLI arg and it disagrees, we log a
  // WARNING (cron log will capture it) and prefer the package.json value
  // because that is what actually ships in the Docker image.
  const pkgVersion = readPackageVersion();
  let resolvedVersion: string;
  if (pkgVersion && version && pkgVersion !== version) {
    console.error(
      `[release] WARNING: --version=${version} disagrees with package.json (${pkgVersion}); using package.json as source of truth.`,
    );
    resolvedVersion = pkgVersion;
  } else {
    resolvedVersion = pkgVersion ?? version ?? '0.0.0';
  }
  if (!pkgVersion && !version) {
    console.error(
      '[release] WARNING: could not resolve version from package.json and no --version CLI arg supplied; falling back to 0.0.0.',
    );
  }

  // ── 2. Fetch live public-API data for the post body (unchanged) ──
  const perf = await fetchPerformance();

  // ── 3. Build the changelog bullets from CHANGELOG.md ──
  //
  // On missing file / missing version heading, fall back to a single-line
  // hardcoded release note and log WARNING so the cron stream captures it.
  const changelogMd = readChangelogMarkdown();

  let changelogItems: string[];
  if (!changelogMd) {
    console.error(
      `[release] WARNING: CHANGELOG.md not found; falling back to generic release note for v${resolvedVersion}.`,
    );
    changelogItems = [
      `Released version ${resolvedVersion} — see [the release notes](https://github.com/AlgoVaultFi/crypto-quant-signal-mcp/releases) for details.`,
    ];
  } else {
    const entry = parseChangelog(changelogMd, resolvedVersion);
    if (!entry || entry.sections.length === 0) {
      console.error(
        `[release] WARNING: CHANGELOG.md has no entry for version ${resolvedVersion}; falling back to generic release note.`,
      );
      changelogItems = [
        `Released version ${resolvedVersion} — see [the release notes](https://github.com/AlgoVaultFi/crypto-quant-signal-mcp/releases) for details.`,
      ];
    } else {
      // Flatten all sections into a single bullet list. Keep subsection
      // context via a "Heading: item" prefix when there are multiple sections
      // so Added/Fixed/Changed stay distinguishable in the post body.
      const flattened: string[] = [];
      const multiSection = entry.sections.length > 1;
      for (const section of entry.sections) {
        for (const item of section.items) {
          flattened.push(multiSection ? `${section.heading}: ${item}` : item);
        }
      }
      // Keep the post body focused — cap at 8 bullets to avoid Hashnode's
      // long-body heuristics flagging it as low-quality.
      changelogItems = flattened.slice(0, 8);
      if (changelogItems.length === 0) {
        changelogItems = [
          `Released version ${resolvedVersion} — see [the release notes](https://github.com/AlgoVaultFi/crypto-quant-signal-mcp/releases) for details.`,
        ];
      }
    }
  }

  // ── 4. Render the post (body template preserved from the old version) ──
  const bullets = changelogItems.map(item => `- ${item}`).join('\n');
  const assetCount = Object.keys(perf.byAsset).length;
  const rawWR = perf.overall.pfeWinRate ?? 0;
  const pfeWR = rawWR <= 1 ? rawWR * 100 : rawWR;

  const content = `AlgoVault MCP v${resolvedVersion} is live

What's new:

${bullets}

Now tracking ${assetCount}+ assets with ${pfeWR.toFixed(1)}% PFE Win Rate across ${perf.overall.totalEvaluated.toLocaleString()} evaluated calls.

Upgrade now — remote agents get the new version automatically:

\`\`\`
Remote MCP   https://api.algovault.com/mcp
npm          npx -y crypto-quant-signal-mcp@${resolvedVersion}
\`\`\`

${ctaLines([
  { label: '📖 Docs', url: CTA_DOCS },
  { label: '📊 Track record', url: CTA_TRACK_RECORD },
])}

Built by AlgoVault Labs — call interpretation for AI trading agents.`;

  return {
    title: `AlgoVault MCP v${resolvedVersion} — What's New`,
    content,
    moltbookSubmolt: 'agents',
    tags: ['mcp', 'crypto', 'ai', 'release'],
  };
}

// ── Platform publishers ──

/**
 * Result of a single publishX() call. `verified` is tri-state:
 *  - true  → re-query confirmed the post is live
 *  - false → publish succeeded but re-query failed (silent drop)
 *  - null  → not yet attempted (auth missing, HTTP error pre-publish, etc.)
 */
interface PublishResult {
  url: string | null;
  postId: string | null;
  verified: boolean | null;
  reason?: string;
}

async function publishMoltbook(post: Post, postType: string): Promise<PublishResult> {
  const key = process.env.MOLTBOOK_API_KEY;
  if (!key) { console.log('[moltbook] MOLTBOOK_API_KEY not set — skipping'); return { url: null, postId: null, verified: null }; }

  // Strip external URLs from the body — Moltbook has no canonical-URL
  // field, and embedded links trigger the `is_spam: true` auto-flag per
  // audit 2026-04-15.
  const strippedContent = stripExternalUrlsForModeration(post.content, STRIP_KEEP_OPTS);

  const body = JSON.stringify({ submolt: post.moltbookSubmolt, title: post.title, content: strippedContent });
  const opts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body,
  };

  let res = await fetch('https://www.moltbook.com/api/v1/posts', opts);

  if (res.status === 429) {
    console.log('[moltbook] Rate limited — retrying in 30s');
    await new Promise(r => setTimeout(r, 30_000));
    res = await fetch('https://www.moltbook.com/api/v1/posts', opts);
  }

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[moltbook] Failed: ${res.status} — ${errBody}`);
    await recordFailure('moltbook', postType, `moltbook-http-${res.status}`);
    return { url: null, postId: null, verified: null, reason: `http-${res.status}` };
  }

  const data = await res.json() as Record<string, unknown>;
  const postData = data.post as Record<string, unknown> | undefined;
  const postId = (postData?.id as string) || (data.id as string) || null;
  const postUrl = (data.url as string)
    || (postData?.slug ? `https://www.moltbook.com/post/${postData.slug}` : null)
    || (postData?.id ? `https://www.moltbook.com/post/${postData.id}` : null)
    || (data.slug ? `https://www.moltbook.com/post/${data.slug}` : null);
  console.log(`[moltbook] Published: ${postUrl || 'ok'}`);

  if (!postId) {
    console.error('[moltbook] No post ID in response — cannot verify');
    await recordFailure('moltbook', postType, 'moltbook-no-post-id-in-response', null, postUrl ?? undefined);
    return { url: postUrl, postId: null, verified: false, reason: 'no-post-id' };
  }

  // Verify: re-query 5s later to confirm the post is not auto-spammed.
  const verify = await verifyMoltbookPost(postId, key);
  await logPublishResult('moltbook', postType, postId, postUrl, verify);
  return { url: postUrl, postId, verified: verify.verified, reason: verify.verified ? undefined : verify.reason };
}

async function publishDevTo(post: Post, postType: string): Promise<PublishResult> {
  const key = process.env.DEVTO_API_KEY;
  if (!key) { console.log('[devto] DEVTO_API_KEY not set — skipping'); return { url: null, postId: null, verified: null }; }

  // Strip external URLs. Dev.to has been 100% healthy in audit, but the
  // spec calls for uniform stripping across platforms to reduce
  // moderation risk. The canonical back-link is preserved on Dev.to via
  // the `canonical_url` field rather than in-body.
  const strippedContent = stripExternalUrlsForModeration(post.content, STRIP_KEEP_OPTS);
  const canonical = getCanonical(postType);

  const body = JSON.stringify({
    article: {
      title: post.title,
      body_markdown: strippedContent,
      published: true,
      tags: post.tags,
      canonical_url: canonical,
    },
  });
  const opts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body,
  };

  let res = await fetch('https://dev.to/api/articles', opts);

  if (res.status === 429) {
    console.log('[devto] Rate limited — retrying in 30s');
    await new Promise(r => setTimeout(r, 30_000));
    res = await fetch('https://dev.to/api/articles', opts);
  }

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[devto] Failed: ${res.status} — ${errBody}`);
    await recordFailure('devto', postType, `devto-http-${res.status}`);
    return { url: null, postId: null, verified: null, reason: `http-${res.status}` };
  }

  const data = await res.json() as { url?: string; id?: number };
  const postUrl = data.url ?? null;
  const postId = data.id != null ? String(data.id) : null;
  console.log(`[devto] Published: ${postUrl}`);

  if (data.id == null) {
    console.error('[devto] No article id in response — cannot verify');
    await recordFailure('devto', postType, 'devto-no-id-in-response', null, postUrl ?? undefined);
    return { url: postUrl, postId: null, verified: false, reason: 'no-article-id' };
  }

  const verify = await verifyDevtoPost(data.id, key);
  await logPublishResult('devto', postType, postId!, postUrl, verify);
  return { url: postUrl, postId, verified: verify.verified, reason: verify.verified ? undefined : verify.reason };
}

async function publishHashnode(post: Post, postType: string, publishOpts: { stripAllUrls?: boolean } = {}): Promise<PublishResult> {
  // R3 kill switch: HASHNODE_ENABLED=false skips Hashnode entirely.
  if (process.env.HASHNODE_ENABLED === 'false') {
    console.log('[hashnode] Publishing disabled via HASHNODE_ENABLED=false — skipping');
    return { url: null, postId: null, verified: null };
  }

  const pat = process.env.HASHNODE_PAT;
  const pubId = process.env.HASHNODE_PUBLICATION_ID;
  if (!pat || !pubId) { console.log('[hashnode] HASHNODE_PAT or HASHNODE_PUBLICATION_ID not set — skipping'); return { url: null, postId: null, verified: null }; }

  // Strip external URLs from the body — Hashnode's anti-spam filter on
  // low-follower publications silently removes posts with multiple
  // external URLs. The canonical back-link survives via the
  // `originalArticleURL` input field (Hashnode's real name for the
  // canonical-URL field — see the schemas report).
  //
  // R4 A/B test: when --hashnode-strip-urls is set, also strip the
  // canonical-domain back-links from the body. This isolates whether URL
  // density (regardless of domain) is what triggers anti-spam.
  const strippedContent = publishOpts.stripAllUrls
    ? stripExternalUrlsForModeration(post.content, {})
    : stripExternalUrlsForModeration(post.content, STRIP_KEEP_OPTS);
  const canonical = getCanonical(postType);

  const mutation = `mutation PublishPost($input: PublishPostInput!) {
    publishPost(input: $input) { post { id slug url } }
  }`;

  const variables = {
    input: {
      title: post.title,
      contentMarkdown: strippedContent,
      publicationId: pubId,
      tags: post.tags.map(t => ({ slug: t, name: t })),
      originalArticleURL: canonical,
    },
  };

  const opts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': pat },
    body: JSON.stringify({ query: mutation, variables }),
  };
  let res = await fetch('https://gql.hashnode.com', opts);

  if (res.status === 429) {
    console.log('[hashnode] Rate limited — retrying in 30s');
    await new Promise(r => setTimeout(r, 30_000));
    res = await fetch('https://gql.hashnode.com', opts);
  }

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[hashnode] Failed: ${res.status} — ${errBody}`);
    await recordFailure('hashnode', postType, `hashnode-http-${res.status}`);
    return { url: null, postId: null, verified: null, reason: `http-${res.status}` };
  }

  const data = await res.json() as {
    data?: { publishPost?: { post?: { id?: string; slug?: string; url?: string } } };
    errors?: Array<{ message?: string }>;
  };
  if (data.errors && data.errors.length > 0) {
    const msg = data.errors.map(e => e.message ?? 'unknown').join('; ');
    console.error(`[hashnode] GraphQL errors: ${msg}`);
    await recordFailure('hashnode', postType, `hashnode-graphql-errors: ${msg}`);
    return { url: null, postId: null, verified: null, reason: `graphql-errors: ${msg}` };
  }
  const postObj = data?.data?.publishPost?.post;
  const postUrl = postObj?.url ?? null;
  const postId = postObj?.id ?? null;
  console.log(`[hashnode] Published: ${postUrl}`);

  if (!postId) {
    console.error('[hashnode] No post id in response — cannot verify');
    await recordFailure('hashnode', postType, 'hashnode-no-post-id-in-response', null, postUrl ?? undefined);
    return { url: postUrl, postId: null, verified: false, reason: 'no-post-id' };
  }

  // R2 multi-stage verify: 5s sync (records initial publish-time result),
  // then 60s + 5min run in the background. On late deletion, fire a
  // CRITICAL Telegram alert + record a drift failure.
  const verify = await verifyHashnodePostMultiStageDeferred(
    postId,
    pat,
    pubId,
    async (lateResult) => {
      const tag = publishOpts.stripAllUrls ? '[hashnode A/B URL-stripped]' : '[hashnode]';
      if (lateResult.verified) {
        console.log(
          `${tag} Late verify OK at stage=${lateResult.stage} postId=${postId}`
        );
        return;
      }
      console.error(
        `${tag} Late verify FAILED at stage=${lateResult.stage} postId=${postId} reason=${lateResult.reason}`
      );
      try {
        await recordFailure(
          'hashnode',
          postType,
          `late-verify-${lateResult.stage}: ${lateResult.reason}`,
          postId,
          postUrl ?? undefined
        );
      } catch (err) {
        console.error('[hashnode] recordFailure error:', (err as Error).message);
      }
      try {
        await sendAlert(
          `Hashnode anti-spam deleted post ${postId} after ${lateResult.stage}.\n${tag}\nURL: ${postUrl ?? 'n/a'}\nReason: ${lateResult.reason}`,
          'critical'
        );
      } catch { /* Telegram optional */ }
    }
  );
  await logPublishResult('hashnode', postType, postId, postUrl, verify);
  return { url: postUrl, postId, verified: verify.verified, reason: verify.verified ? undefined : verify.reason };
}

/**
 * Shared post-verify bookkeeping: write to the audit log (always), write
 * to the failures table when verify failed, and emit the structured log
 * line the self-audit cron consumes.
 */
async function logPublishResult(
  platform: string,
  postType: string,
  postId: string,
  postUrl: string | null,
  verify: VerifyResult,
): Promise<void> {
  const reason = verify.verified ? undefined : verify.reason;
  await recordPublished(platform, postType, postId, postUrl ?? '', verify.verified, reason);

  if (verify.verified) {
    console.log(`FORUM_POST_PUBLISHED platform=${platform} post_id=${postId} post_url=${postUrl ?? ''} verified=true`);
    return;
  }

  console.error(`[${platform}] DROPPED_POST_VERIFY_FAILED id=${postId} reason=${reason}`);
  console.log(`FORUM_POST_PUBLISHED platform=${platform} post_id=${postId} post_url=${postUrl ?? ''} verified=false reason=${reason}`);
  await recordFailure(platform, postType, reason ?? 'unknown', postId, postUrl ?? undefined);
}

// ── Main ──

/** Test whether an env value (string) means "enabled". */
function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on';
}

async function runSelfAudit(ts: string): Promise<number> {
  console.log(`[${ts}] agent-forum-post: self-audit`);
  const platforms: Array<{
    name: 'hashnode' | 'moltbook' | 'devto';
    verify: (postId: string) => Promise<VerifyResult>;
    credsOk: boolean;
  }> = [];

  const hnPat = process.env.HASHNODE_PAT;
  const hnPubId = process.env.HASHNODE_PUBLICATION_ID;
  platforms.push({
    name: 'hashnode',
    credsOk: Boolean(hnPat && hnPubId),
    verify: (postId) => verifyHashnodePost(postId, hnPat ?? '', hnPubId ?? '', { delayMs: 0 }),
  });
  const mbKey = process.env.MOLTBOOK_API_KEY;
  platforms.push({
    name: 'moltbook',
    credsOk: Boolean(mbKey),
    verify: (postId) => verifyMoltbookPost(postId, mbKey ?? '', { delayMs: 0 }),
  });
  const devKey = process.env.DEVTO_API_KEY;
  platforms.push({
    name: 'devto',
    credsOk: Boolean(devKey),
    verify: (postId) => verifyDevtoPost(Number(postId), devKey ?? '', { delayMs: 0 }),
  });

  const SELF_AUDIT_DAYS = 7;
  const SELF_AUDIT_LIMIT = 5;
  let totalDrift = 0;
  // OPS-MONITOR-TRANSIENT-CLASSIFY-W1: posts unverifiable for a sustained streak
  // (a platform rate-limiting our probe for days) — escalated with honest framing,
  // separate from the "silently dropped" confirmed-drift alert.
  const sustainedIndeterminate: Array<{ platform: string; postId: string; reason: string; days: number }> = [];

  for (const p of platforms) {
    const recent = await getRecentPublished(p.name, SELF_AUDIT_DAYS, SELF_AUDIT_LIMIT);
    const failures7d = await countRecentFailures(p.name, SELF_AUDIT_DAYS * 24);

    if (!p.credsOk) {
      console.log(`SELF-AUDIT: platform=${p.name} verified=0/0 failures_7d=${failures7d} status=creds-missing`);
      continue;
    }

    if (recent.length === 0) {
      console.log(`SELF-AUDIT: platform=${p.name} verified=0/0 failures_7d=${failures7d} status=no-recent-posts`);
      continue;
    }

    let verifiedCount = 0;
    let skippedKnownBroken = 0;
    let indeterminateCount = 0;
    const driftReasons: string[] = [];
    const indeterminateReasons: string[] = [];
    for (const row of recent) {
      try {
        // Skip posts that already have an unrecovered failure recorded —
        // re-checking them just re-records the same drift every day,
        // inflating the alert count and drowning real new-drift signals.
        const alreadyFailed = await hasUnrecoveredFailure(p.name, row.post_id);
        if (alreadyFailed) {
          skippedKnownBroken += 1;
          continue;
        }

        const v = await p.verify(row.post_id);
        if (v.verified) {
          verifiedCount += 1;
          // A prior transient reading cleared — reset the sustained-indeterminate streak.
          await clearIndeterminate(p.name, row.post_id);
        } else if (classifyProbeFailure(v.reason) === 'transient') {
          // OPS-MONITOR-TRANSIENT-CLASSIFY-W1: a rate-limited / unreachable verify
          // probe (HTTP 429, 5xx, network) does NOT mean the post was dropped — it
          // means we could not confirm it. Record an INDETERMINATE marker (re-tried
          // next audit, NEVER counted as drift); escalate only on a sustained streak.
          indeterminateCount += 1;
          indeterminateReasons.push(`${row.post_id}:${v.reason}`);
          await recordFailure(
            p.name,
            row.post_type,
            `${INDETERMINATE_REASON_PREFIX}${v.reason}`,
            row.post_id,
            row.post_url ?? undefined,
          );
          const streak = await countUnrecoveredIndeterminate(p.name, row.post_id);
          if (shouldEscalateIndeterminate(streak)) {
            sustainedIndeterminate.push({ platform: p.name, postId: row.post_id, reason: v.reason, days: streak });
          }
        } else {
          // Confirmed absence (404 / not-published / is_spam / is_deleted) = real drift.
          totalDrift += 1;
          driftReasons.push(`${row.post_id}:${v.reason}`);
          await recordFailure(p.name, row.post_type, `drift-detected-on-self-audit: ${v.reason}`, row.post_id, row.post_url ?? undefined);
        }
      } catch (err) {
        console.error(`SELF-AUDIT: platform=${p.name} post=${row.post_id} verify error:`, (err as Error).message);
        // Network/code errors are NOT drift — don't record failure, don't count.
      }
    }

    console.log(
      `SELF-AUDIT: platform=${p.name} verified=${verifiedCount}/${recent.length} ` +
      `skipped_known_broken=${skippedKnownBroken} indeterminate=${indeterminateCount} ` +
      `failures_7d=${failures7d}` +
      `${driftReasons.length ? ' drift=' + driftReasons.join(',') : ''}` +
      `${indeterminateReasons.length ? ' indeterminate_reasons=' + indeterminateReasons.join(',') : ''}`,
    );
  }

  if (totalDrift > 0) {
    try {
      await sendAlert(`Forum post self-audit drift: ${totalDrift} post(s) silently dropped across platforms.`, 'warning');
    } catch { /* Telegram optional */ }
  }

  // Honest sustained-indeterminate escalation — distinct from a "silently dropped"
  // drop. Fires only when a post stayed unverifiable for >= the streak, i.e. the
  // platform has been rate-limiting / blocking our verification probe for days.
  if (sustainedIndeterminate.length > 0) {
    const detail = sustainedIndeterminate
      .map((s) => `${s.platform} ${s.postId} (${s.days}d, last ${s.reason})`)
      .join('; ');
    try {
      await sendAlert(
        `Forum self-audit could NOT verify ${sustainedIndeterminate.length} post(s) for ≥${INDETERMINATE_ESCALATE_STREAK} consecutive daily audits — likely the platform rate-limiting our verification probe, NOT a drop. Manual check advised: ${detail}`,
        'warning',
      );
    } catch { /* Telegram optional */ }
  }

  return totalDrift;
}

/**
 * R5 verify-only mode: re-verify the most recent posts from each platform's
 * audit-log without publishing anything new. Outputs a verification matrix
 * so the operator can spot-check post survival.
 *
 * Differs from --self-audit: verify-only is an interactive read-only probe
 * (writes nothing to the failures table, exits 0 regardless of result).
 * --self-audit is the cron-driven drift detector that records failures and
 * exits non-zero on drift.
 */
async function runVerifyOnly(ts: string): Promise<void> {
  console.log(`[${ts}] agent-forum-post: --verify-only`);

  const platforms: Array<{
    name: 'hashnode' | 'moltbook' | 'devto';
    verify: (postId: string) => Promise<VerifyResult>;
    credsOk: boolean;
  }> = [];

  const hnPat = process.env.HASHNODE_PAT;
  const hnPubId = process.env.HASHNODE_PUBLICATION_ID;
  platforms.push({
    name: 'hashnode',
    credsOk: Boolean(hnPat && hnPubId),
    verify: (postId) => verifyHashnodePost(postId, hnPat ?? '', hnPubId ?? '', { delayMs: 0 }),
  });
  const mbKey = process.env.MOLTBOOK_API_KEY;
  platforms.push({
    name: 'moltbook',
    credsOk: Boolean(mbKey),
    verify: (postId) => verifyMoltbookPost(postId, mbKey ?? '', { delayMs: 0 }),
  });
  const devKey = process.env.DEVTO_API_KEY;
  platforms.push({
    name: 'devto',
    credsOk: Boolean(devKey),
    verify: (postId) => verifyDevtoPost(Number(postId), devKey ?? '', { delayMs: 0 }),
  });

  const VERIFY_DAYS = 14;
  const VERIFY_LIMIT = 10;

  console.log('\nplatform | post_id | verified | reason');
  console.log('---------|---------|----------|-------');

  for (const p of platforms) {
    if (!p.credsOk) {
      console.log(`${p.name} | (none) | skip | creds-missing`);
      continue;
    }
    const recent = await getRecentPublished(p.name, VERIFY_DAYS, VERIFY_LIMIT);
    if (recent.length === 0) {
      console.log(`${p.name} | (none) | skip | no-recent-posts`);
      continue;
    }
    for (const row of recent) {
      try {
        const v = await p.verify(row.post_id);
        const reason = v.verified ? '-' : v.reason;
        console.log(`${p.name} | ${row.post_id} | ${v.verified} | ${reason}`);
      } catch (err) {
        console.log(`${p.name} | ${row.post_id} | error | ${(err as Error).message}`);
      }
    }
  }

  console.log(`\n[${ts}] --verify-only complete (read-only, no records written).`);
}

async function main() {
  const args = parseArgs();
  const ts = new Date().toISOString();

  // Kill switch — an emergency halt controlled by an env var. Cron jobs
  // can be flipped off without touching the crontab by setting this in
  // /etc/algovault/forum.env (sourced by the wrapper).
  if (isTruthyEnv(process.env.FORUM_POST_KILL_SWITCH)) {
    console.warn(`[${ts}] FORUM_POST_KILL_SWITCH is set — aborting without publishing.`);
    try {
      await sendAlert('Forum post kill switch is active — scheduled run aborted.', 'warning');
    } catch { /* Telegram optional — log and exit anyway */ }
    process.exit(0);
  }

  // R5 verify-only mode: re-verify recent posts, output matrix, return.
  // Read-only — does NOT record failures or exit non-zero on missing posts.
  if (args.verifyOnly) {
    await runVerifyOnly(ts);
    process.exit(0);
  }

  // Self-audit mode: re-verify recent posts, record drift, return.
  if (args.selfAudit) {
    const drift = await runSelfAudit(ts);
    process.exit(drift > 0 ? 1 : 0);
  }

  console.log(`[${ts}] agent-forum-post: type=${args.type} dryRun=${args.dryRun}${args.hashnodeStripUrls ? ' hashnodeStripUrls=true' : ''}`);

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

  // Smoke-test probe tagging: prefix title + append safe-to-delete footer so
  // the probe is trivially findable on each platform for cleanup. This does
  // not change any publish/verify logic — it exercises the full chain with a
  // distinguishable payload.
  if (args.testTag) {
    post.title = `[${args.testTag}] TEST — ${post.title}`;
    post.content = `${post.content}\n\n> Test probe: ${args.testTag}. Safe to delete.`;
  }

  // ── Publish gate (FIX-CONVICTION-CALL-POSTS-W1) ──
  // This used to be a bare `console.log` of the word count that nothing branched on,
  // which is how a 61-word post with two blank CTA labels published green for weeks.
  // It is now a real gate, evaluated against the STRIPPED body (what actually ships)
  // and enforced on the live path — a dry run reports the verdict but never blocks,
  // so an operator can always inspect a failing draft.
  const gateBody = stripExternalUrlsForModeration(post.content, STRIP_KEEP_OPTS);
  const gate = checkForumPost({
    title: post.title,
    rawContent: post.content,
    strippedContent: gateBody,
    // The SAME list the strip was given, so the gate judges "was this link supposed to
    // survive?" by the identical rule rather than forming a second, drifting opinion.
    keepHosts: [STRIP_KEEP_OPTS.keepCanonicalDomain, ...STRIP_KEEP_OPTS.keepHosts],
  });
  const gateWords = gateBody.split(/\s+/).filter(Boolean).length;
  console.log(`[${ts}] Post generated: "${post.title}" (${gateWords} words shipped)`);
  for (const line of gate.checks) console.log(`[${ts}]   ${line}`);
  for (const line of gate.failures) console.error(`[${ts}]   ${line}`);
  console.log(`[${ts}] FORUM_POST_GATE_VERDICT=${gate.ok ? 'PASS' : 'FAIL'}`);
  if (!gate.ok && !args.dryRun) {
    await recordFailure('gate', args.type, `gate-red: ${gate.failures[0]}`);
    try {
      await sendAlert(`Forum post gate RED (${args.type}) — not published: ${gate.failures.join('; ')}`, 'warning');
    } catch { /* Telegram optional */ }
    throw new Error(`FORUM_POST_GATE_FAIL: ${gate.failures.join('; ')}`);
  }

  if (args.dryRun) {
    const strippedPreview = stripExternalUrlsForModeration(post.content, STRIP_KEEP_OPTS);
    const canonical = getCanonical(args.type);
    console.log('\n=== DRY RUN — Moltbook (m/' + post.moltbookSubmolt + ') ===');
    console.log(`Title: ${post.title}`);
    console.log(strippedPreview);
    console.log('\n=== DRY RUN — Dev.to ===');
    console.log(`Title: ${post.title}`);
    console.log(`Tags: ${post.tags.join(', ')}`);
    console.log(`canonical_url: ${canonical}`);
    console.log(strippedPreview);
    // No Hashnode preview: the publish was removed (deprecated 2026-05-26). A preview
    // for a channel we do not publish to would misreport what actually ships — and a
    // dry run is the artifact this pipeline is verified against, so it must not lie.
    console.log(`\n[${ts}] Dry run complete — no posts published.`);
    return;
  }

  // Publish to all platforms.
  //
  // FIX-CONVICTION-CALL-POSTS-W1: the Hashnode publish is GONE. Two independent
  // reasons, either sufficient:
  //   1. Hashnode was DEPRECATED 2026-05-26 (dev.to is the canonical channel).
  //   2. It was not merely dead, it was DESTRUCTIVE. Hashnode answers with an HTML
  //      error page, `publishHashnode` JSON.parses it, and the resulting
  //      `SyntaxError: Unexpected token '<', "<!DOCTYPE "…` propagated out of
  //      `main()` UNCAUGHT — on 2026-07-29 and 2026-07-31 alike. So every run
  //      aborted here, AFTER dev.to had already published, and every statement
  //      below this line never executed in production: the Done summary, the
  //      dropped-platform alert, the publish ledger. A future wave adding a
  //      verification step at the end of main() would have found it silently
  //      skipped and read that as "it didn't happen" rather than "it never ran".
  const results: Record<string, PublishResult> = {};
  results.moltbook = await publishMoltbook(post, args.type);
  results.devto = await publishDevTo(post, args.type);

  const published = Object.entries(results).filter(([, v]) => v.url).map(([k]) => k);
  const skipped = Object.entries(results).filter(([, v]) => !v.url).map(([k]) => k);
  const verified = Object.entries(results).filter(([, v]) => v.verified === true).map(([k]) => k);
  const dropped = Object.entries(results).filter(([, v]) => v.verified === false).map(([k]) => k);

  console.log(
    `[${ts}] Done. Published: ${published.join(', ') || 'none'}. Verified: ${verified.join(', ') || 'none'}. Dropped: ${dropped.join(', ') || 'none'}. Skipped: ${skipped.join(', ') || 'none'}.`
  );

  if (dropped.length > 0) {
    try {
      await sendAlert(
        `Forum post verify failed on ${dropped.length} platform(s): ${dropped.map(p => `${p} (${results[p].reason ?? 'unknown'})`).join('; ')}`,
        'warning'
      );
    } catch { /* Telegram optional */ }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
