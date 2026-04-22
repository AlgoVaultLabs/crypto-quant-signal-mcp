#!/usr/bin/env node
/**
 * AlgoVault Monitoring Script
 * --mode critical  → checks health, alerts only on failures (every 2 min via cron)
 * --mode digest    → sends daily summary (08:00 UTC via cron)
 */
import os from 'node:os';
import fs from 'node:fs';
import { sendAlert, sendDigest } from '../lib/telegram.js';
import { getPerformanceStatsAsync, dbQuery } from '../lib/performance-db.js';

// ── Config ──

// Admin key: read from env (container inherits from /opt/crypto-quant-signal-mcp/.env).
// NEVER hardcode — this key grants access to /analytics and /dashboard. A hardcoded
// key was committed in 7c7eecb (2026-04-13) and lived in main until this delta audit
// caught it. The leaked value has been rotated; this script now authenticates via
// Authorization: Bearer header (not query string) so the key never lands in access logs.
const ADMIN_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_KEY) {
  console.error('[monitor] ADMIN_API_KEY env var not set — admin analytics call will be skipped');
}
const API_BASE = 'https://api.algovault.com';
const GAS_WALLET = '0x804B82544E0B779c69192Ff5FC64a4c5d1017B80';
// Base RPC endpoints — primary first, then free fallbacks. Both used as
// a chain of best-effort attempts before alerting. mainnet.base.org is
// the official endpoint but throttles aggressively (HTTP 503) under
// load; publicnode.com is a free Allnodes mirror with better uptime
// during peak hours.
const BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
];
const STATE_FILE = '/tmp/algovault-monitor-state.json';
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT = 5_000;

// ── Helpers ──

function parseArgs(): 'critical' | 'digest' {
  const idx = process.argv.indexOf('--mode');
  const mode = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (mode !== 'critical' && mode !== 'digest') {
    console.error('Usage: monitor.ts --mode <critical|digest>');
    process.exit(1);
  }
  return mode;
}

async function fetchJson(url: string, options?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: (err as Error).message };
  }
}

// ── Dedup state ──

interface AlertState {
  lastAlerted: Record<string, number>;
}

function loadState(): AlertState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as AlertState;
  } catch {
    return { lastAlerted: {} };
  }
}

function saveState(state: AlertState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function shouldAlert(state: AlertState, key: string): boolean {
  const last = state.lastAlerted[key] ?? 0;
  return Date.now() - last > DEDUP_WINDOW_MS;
}

function markAlerted(state: AlertState, key: string): void {
  state.lastAlerted[key] = Date.now();
}

// ── Critical Checks ──

async function checkServerHealth(): Promise<string | null> {
  // Retry up to 3 times with 5s delay to avoid false-positive CRITICAL
  // alerts on transient network blips (Cloudflare edge hiccup, brief DNS
  // timeout, etc.). A single HTTP 0 is normal noise; 3 consecutive
  // failures over ~15s is a real outage.
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5_000;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { ok, status } = await fetchJson(`${API_BASE}/health`);
    if (ok) return null;
    lastStatus = status;
    if (attempt < MAX_ATTEMPTS) {
      console.log(`[monitor] server health failed (HTTP ${status}), retry ${attempt}/${MAX_ATTEMPTS - 1} in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return `Server health check failed (HTTP ${lastStatus}) after ${MAX_ATTEMPTS} attempts`;
}

async function checkFacilitator(): Promise<string | null> {
  // Inside Docker network the facilitator is reachable as "facilitator"
  const url = process.env.X402_FACILITATOR_URL
    ? `${process.env.X402_FACILITATOR_URL}/health`
    : 'http://facilitator:4022/health';
  // Same retry pattern as checkServerHealth — 3 attempts, 5s delay.
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5_000;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { ok, status } = await fetchJson(url);
    if (ok) return null;
    lastStatus = status;
    if (attempt < MAX_ATTEMPTS) {
      console.log(`[monitor] facilitator health failed (HTTP ${status}), retry ${attempt}/${MAX_ATTEMPTS - 1}...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return `x402 facilitator down (HTTP ${lastStatus}) after ${MAX_ATTEMPTS} attempts`;
}

async function checkGasWallet(): Promise<{ error: string | null; balance: number }> {
  // Public Base RPCs (mainnet.base.org especially) throttle aggressively
  // under load — HTTP 503 is the most common false-positive trigger.
  // Strategy: 3 attempts per endpoint with exponential backoff (1s, 3s),
  // then walk to the next endpoint in BASE_RPCS. Only alert if EVERY
  // endpoint fails all attempts — by that point the issue is almost
  // certainly real and not a transient rate limit on one provider.
  //
  // Critical: only ever report "wallet low" from a VALID balance read.
  // A malformed response (missing `result` field, RPC error body, HTTP
  // 5xx) must never be silently coerced to 0.
  const RPC_TIMEOUT = 10_000;
  const MAX_ATTEMPTS_PER_RPC = 3;
  const BACKOFF_MS = [1_000, 3_000]; // delay before attempt 2, 3

  let lastError = '';
  let lastEndpoint = '';
  for (const rpc of BASE_RPCS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_RPC; attempt++) {
      lastEndpoint = rpc;
      try {
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'eth_getBalance',
            params: [GAS_WALLET, 'latest'],
          }),
          signal: AbortSignal.timeout(RPC_TIMEOUT),
        });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
        } else {
          const data = await res.json().catch(() => null) as
            | { result?: string; error?: { message?: string } }
            | null;
          if (!data) {
            lastError = 'RPC returned non-JSON response';
          } else if (data.error) {
            lastError = `RPC error: ${data.error.message ?? JSON.stringify(data.error)}`;
          } else if (typeof data.result !== 'string' || !data.result.startsWith('0x')) {
            lastError = `Invalid RPC response (no result field): ${JSON.stringify(data).slice(0, 200)}`;
          } else {
            // Valid read — only now is it safe to evaluate the balance threshold.
            const wei = BigInt(data.result);
            const eth = Number(wei) / 1e18;
            if (eth < 0.005) return { error: `Gas wallet low: ${eth.toFixed(6)} ETH (< 0.005)`, balance: eth };
            return { error: null, balance: eth };
          }
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (attempt < MAX_ATTEMPTS_PER_RPC) {
        const delay = BACKOFF_MS[attempt - 1] ?? 3_000;
        console.log(`[monitor] gas wallet RPC ${rpc} failed (${lastError}), retry ${attempt}/${MAX_ATTEMPTS_PER_RPC - 1} in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    // Endpoint exhausted — try next fallback
    console.log(`[monitor] gas wallet RPC ${rpc} exhausted after ${MAX_ATTEMPTS_PER_RPC} attempts (${lastError}), trying next endpoint...`);
  }
  return {
    error: `Gas wallet check failed: all ${BASE_RPCS.length} RPC endpoints exhausted (${MAX_ATTEMPTS_PER_RPC} attempts each). Last endpoint: ${lastEndpoint}, last error: ${lastError}`,
    balance: 0,
  };
}

async function checkDatabase(): Promise<string | null> {
  try {
    await dbQuery('SELECT 1');
    return null;
  } catch (err) {
    return `Database connection failed: ${(err as Error).message}`;
  }
}

// Returns true if the exchange is reachable. Retries once on transient
// failure before declaring it down — public APIs occasionally slow-respond
// under load and a single timeout shouldn't trigger a false alert.
async function checkExchangeHealth(name: string, url: string): Promise<boolean> {
  const opts: RequestInit = name === 'Hyperliquid'
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) }
    : {};
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { ok, status } = await fetchJson(url, opts);
    // 429 = rate limited but alive — not a real failure
    if (ok || status === 429) return true;
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function checkExchanges(): Promise<string | null> {
  const exchanges: [string, string][] = [
    ['Binance', 'https://fapi.binance.com/fapi/v1/ping'],
    ['Bybit', 'https://api.bybit.com/v5/market/time'],
    ['OKX', 'https://www.okx.com/api/v5/public/time'],
    ['Bitget', 'https://api.bitget.com/api/v2/public/time'],
    ['Hyperliquid', 'https://api.hyperliquid.xyz/info'],
  ];

  const failures: string[] = [];
  await Promise.all(
    exchanges.map(async ([name, url]) => {
      const healthy = await checkExchangeHealth(name, url);
      if (!healthy) failures.push(name);
    }),
  );

  if (failures.length > 0) return `Exchange API failures: ${failures.join(', ')}`;
  return null;
}

async function checkBackfillQueue(): Promise<{ error: string | null; count: number }> {
  try {
    const rows = await dbQuery<{ count: string | number }>('SELECT COUNT(*) as count FROM signals WHERE outcome_price IS NULL');
    const count = Number(rows[0]?.count ?? 0);
    if (count > 50_000) return { error: `Backfill queue stuck: ${count.toLocaleString()} pending (> 50,000)`, count };
    return { error: null, count };
  } catch (err) {
    return { error: `Backfill queue check failed: ${(err as Error).message}`, count: 0 };
  }
}

async function checkPfeWinRate(): Promise<{ error: string | null; rate: number | null }> {
  try {
    const stats = await getPerformanceStatsAsync();
    const rate = stats.overall.pfeWinRate;
    if (rate !== null && rate < 0.85) {
      return { error: `PFE win rate dropped to ${(rate * 100).toFixed(1)}% (< 85%)`, rate };
    }
    return { error: null, rate };
  } catch (err) {
    return { error: `PFE check failed: ${(err as Error).message}`, rate: null };
  }
}

async function runCritical(): Promise<void> {
  console.log(`[monitor] critical check at ${new Date().toISOString()}`);
  const state = loadState();

  const checks: [string, () => Promise<string | null>][] = [
    ['server_health', checkServerHealth],
    ['facilitator', checkFacilitator],
    ['gas_wallet', async () => (await checkGasWallet()).error],
    ['database', checkDatabase],
    ['exchanges', checkExchanges],
    ['backfill', async () => (await checkBackfillQueue()).error],
    ['pfe_winrate', async () => (await checkPfeWinRate()).error],
  ];

  let alertCount = 0;
  for (const [key, check] of checks) {
    const error = await check();
    if (error && shouldAlert(state, key)) {
      const level = ['server_health', 'facilitator', 'database'].includes(key) ? 'critical' : 'warning';
      await sendAlert(error, level);
      markAlerted(state, key);
      alertCount++;
      console.log(`[monitor] ALERT (${level}): ${error}`);
    } else if (error) {
      console.log(`[monitor] suppressed (dedup): ${error}`);
    }
  }

  // Clean up old dedup entries (> 2 hours)
  const now = Date.now();
  for (const [key, ts] of Object.entries(state.lastAlerted)) {
    if (now - ts > 2 * 60 * 60 * 1000) delete state.lastAlerted[key];
  }

  saveState(state);
  console.log(`[monitor] critical done — ${alertCount} alert(s) sent`);
}

// ── Digest ──

async function runDigest(): Promise<void> {
  console.log(`[monitor] digest at ${new Date().toISOString()}`);
  const date = new Date().toISOString().split('T')[0];

  // Gather data in parallel
  const [perfStats, gasResult, backfillResult, analyticsResult, npmResult, uptimeInfo] = await Promise.all([
    getPerformanceStatsAsync().catch(() => null),
    checkGasWallet(),
    checkBackfillQueue(),
    ADMIN_KEY
      ? fetchJson(`${API_BASE}/analytics`, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } })
      : Promise.resolve({ ok: false, status: 0, data: 'ADMIN_API_KEY not set' }),
    fetchJson('https://api.npmjs.org/downloads/point/last-day/crypto-quant-signal-mcp'),
    Promise.resolve(getSystemInfo()),
  ]);

  const sections: string[] = [];

  // Header
  sections.push(`📊 *AlgoVault Daily Digest — ${date}*`);

  // Signal Performance
  if (perfStats) {
    const total = perfStats.overall.totalSignals;
    const evaluated = perfStats.overall.totalEvaluated;
    const evalPct = total > 0 ? ((evaluated / total) * 100).toFixed(1) : '0';
    const pfe = perfStats.overall.pfeWinRate !== null
      ? `${(perfStats.overall.pfeWinRate * 100).toFixed(1)}%`
      : 'N/A';
    const pending = total - evaluated;
    sections.push([
      '📈 *Signal Performance*',
      `• Total trade calls: ${total.toLocaleString()}`,
      `• Evaluated: ${evaluated.toLocaleString()} (${evalPct}%)`,
      `• PFE Win Rate: ${pfe}`,
      `• Pending evaluation: ${pending.toLocaleString()}`,
    ].join('\n'));
  }

  // Agent Activity (from analytics endpoint)
  if (analyticsResult.ok && analyticsResult.data) {
    const a = analyticsResult.data as Record<string, unknown>;
    // totalCalls / uniqueSessions may be nested objects like {allTime, last24h, last7d}
    // or plain numbers — handle both shapes.
    const callsRaw = a.totalCalls ?? a.total_calls;
    const calls = typeof callsRaw === 'object' && callsRaw !== null
      ? (callsRaw as Record<string, unknown>).last24h ?? (callsRaw as Record<string, unknown>).allTime ?? '—'
      : callsRaw ?? '—';
    const sessionsRaw = a.uniqueSessions ?? a.unique_sessions;
    const sessions = typeof sessionsRaw === 'object' && sessionsRaw !== null
      ? (sessionsRaw as Record<string, unknown>).last24h ?? (sessionsRaw as Record<string, unknown>).allTime ?? '—'
      : sessionsRaw ?? '—';
    const topAssets = a.topAssets ?? a.top_assets;
    const assetList = Array.isArray(topAssets)
      ? topAssets.slice(0, 5).map((t: Record<string, unknown>) => t.asset ?? t.coin ?? t.symbol).join(', ')
      : '—';
    sections.push([
      '🤖 *Agent Activity*',
      `• Total calls today: ${calls}`,
      `• Unique sessions: ${sessions}`,
      `• Top assets: ${assetList}`,
    ].join('\n'));
  }

  // Infrastructure
  const { uptimeHrs, cpuPct, memUsed, memTotal, diskUsed, diskTotal } = uptimeInfo;
  sections.push([
    '🏗️ *Infrastructure*',
    `• Server uptime: ${uptimeHrs}h`,
    `• CPU: ${cpuPct}% | RAM: ${memUsed}/${memTotal}`,
    `• Gas wallet: ${gasResult.balance.toFixed(6)} ETH`,
    `• Disk: ${diskUsed}/${diskTotal}`,
    `• Backfill queue: ${backfillResult.count.toLocaleString()} pending`,
  ].join('\n'));

  // npm Downloads
  if (npmResult.ok && npmResult.data) {
    const d = npmResult.data as Record<string, unknown>;
    sections.push(`📦 *npm Downloads:* ${d.downloads ?? '—'} (last day)`);
  }

  await sendDigest(sections);
  console.log('[monitor] digest sent');
}

function getSystemInfo(): {
  uptimeHrs: string;
  cpuPct: string;
  memUsed: string;
  memTotal: string;
  diskUsed: string;
  diskTotal: string;
} {
  const uptimeHrs = (os.uptime() / 3600).toFixed(1);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsed = `${(usedMem / 1024 / 1024 / 1024).toFixed(1)}GB`;
  const memTotal = `${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB`;

  // CPU load average (1 min) as percentage of cores
  const cpus = os.cpus().length;
  const load1 = os.loadavg()[0];
  const cpuPct = ((load1 / cpus) * 100).toFixed(0);

  // Disk — we can't use os module for this, so approximate from container
  let diskUsed = '—';
  let diskTotal = '—';
  try {
    const { execSync } = require('node:child_process');
    const df = execSync("df -h / | tail -1 | awk '{print $3, $2}'", { encoding: 'utf-8' }).trim().split(' ');
    diskUsed = df[0] ?? '—';
    diskTotal = df[1] ?? '—';
  } catch { /* ignore */ }

  return { uptimeHrs, cpuPct, memUsed, memTotal, diskUsed, diskTotal };
}

// ── Main ──

async function main(): Promise<void> {
  const mode = parseArgs();
  try {
    if (mode === 'critical') await runCritical();
    else await runDigest();
  } catch (err) {
    console.error(`[monitor] fatal error:`, err);
    await sendAlert(`Monitor script crashed (${mode}): ${(err as Error).message}`, 'critical');
    process.exit(1);
  }
}

main();
