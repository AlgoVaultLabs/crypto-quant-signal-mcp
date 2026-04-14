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

const ADMIN_KEY = 'd5bea8823d3c96432e786a58bf7f96022e5fa61fc6aecee4a674d8a3e2031d98';
const API_BASE = 'https://api.algovault.com';
const GAS_WALLET = '0x804B82544E0B779c69192Ff5FC64a4c5d1017B80';
const BASE_RPC = 'https://mainnet.base.org';
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
  const { ok, status } = await fetchJson(`${API_BASE}/health`);
  if (!ok) return `Server health check failed (HTTP ${status})`;
  return null;
}

async function checkFacilitator(): Promise<string | null> {
  // Inside Docker network the facilitator is reachable as "facilitator"
  const url = process.env.X402_FACILITATOR_URL
    ? `${process.env.X402_FACILITATOR_URL}/health`
    : 'http://facilitator:4022/health';
  const { ok, status } = await fetchJson(url);
  if (!ok) return `x402 facilitator down (HTTP ${status})`;
  return null;
}

async function checkGasWallet(): Promise<{ error: string | null; balance: number }> {
  // Base public RPC (mainnet.base.org) is flaky under load — use a longer timeout
  // and retry once before alerting to avoid false positives on transient slowdowns.
  const RPC_TIMEOUT = 10_000;
  const MAX_ATTEMPTS = 2;

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(BASE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getBalance',
          params: [GAS_WALLET, 'latest'],
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT),
      });
      const data = await res.json() as { result?: string };
      const wei = BigInt(data.result ?? '0');
      const eth = Number(wei) / 1e18;
      if (eth < 0.005) return { error: `Gas wallet low: ${eth.toFixed(6)} ETH (< 0.005)`, balance: eth };
      return { error: null, balance: eth };
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  return { error: `Gas wallet check failed after ${MAX_ATTEMPTS} attempts: ${lastError}`, balance: 0 };
}

async function checkDatabase(): Promise<string | null> {
  try {
    await dbQuery('SELECT 1');
    return null;
  } catch (err) {
    return `Database connection failed: ${(err as Error).message}`;
  }
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
  const results = await Promise.allSettled(
    exchanges.map(async ([name, url]) => {
      const opts: RequestInit = name === 'Hyperliquid'
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) }
        : {};
      const { ok, status } = await fetchJson(url, opts);
      // 429 = rate limited but alive — not a real failure
      if (!ok && status !== 429) failures.push(name);
    }),
  );
  // Check for rejected promises too
  results.forEach((r, i) => {
    if (r.status === 'rejected' && !failures.includes(exchanges[i][0])) {
      failures.push(exchanges[i][0]);
    }
  });

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
    fetchJson(`${API_BASE}/analytics?key=${ADMIN_KEY}`),
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
    const calls = a.totalCalls ?? a.total_calls ?? '—';
    const sessions = a.uniqueSessions ?? a.unique_sessions ?? '—';
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
