#!/usr/bin/env node
/**
 * AlgoVault Monitoring Script
 * --mode critical  → checks health, alerts only on failures (every 2 min via cron)
 * --mode digest    → sends daily summary (08:00 UTC via cron)
 */
import os from 'node:os';
import fs from 'node:fs';
import { sendAlert, sendDigest } from '../lib/telegram.js';
import { formatAgentActivity } from '../lib/agent-activity-format.js';
import { getPerformanceStatsAsync, dbQuery } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { evaluatePfeWinRate, internalPerfPublicUrl } from './monitor-pfe.js';
import { evaluateSeedFreshness, buildSeedFreshnessRows, formatSeedOutagePage } from './monitor-seed-freshness.js';
import { listVenues } from '../lib/venue-store.js';
import { getLatestSeedHeartbeatPerVenue } from '../lib/seed-heartbeats.js';
import { hlInfoPost } from '../lib/adapters/hyperliquid.js';
import { UpstreamRateLimitError } from '../lib/errors.js';
import { WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import {
  evaluateGasQuorum,
  parseGasBalanceResult,
  GAS_WALLET_MIN_ETH,
  GAS_LOW_CONFIRMATIONS,
  type GasRead,
} from '../lib/gas-wallet-quorum.js';

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
// Base RPC endpoints, one per INDEPENDENT operator. A low balance must be
// corroborated by >= GAS_LOW_CONFIRMATIONS of them before it pages, so two
// hosts from the same provider would not count as independent evidence
// (base-rpc.publicnode.com is deliberately omitted — same operator as
// base.publicnode.com). mainnet.base.org is authoritative but throttles
// aggressively (HTTP 503) under load, which is precisely when a degraded
// fallback is most likely to serve a pruned `0x0`. All four verified live
// against the gas wallet on 2026-07-18.
const BASE_RPCS = [
  'https://mainnet.base.org',    // Coinbase / Base official
  'https://base.publicnode.com', // Allnodes
  'https://base.drpc.org',       // dRPC
  'https://1rpc.io/base',        // Automata
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

async function fetchJson(url: string, options?: RequestInit, timeoutMs: number = FETCH_TIMEOUT): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: (err as Error).message };
  }
}

// ── Dedup + auto-recovery state ──
//
// CLAUDE.md "Automation-first recovery" (precedence rule 6) requires
// Detect → Recover → Alert → Escalate. Monitor must NOT alert on
// transient failures that auto-recover. Two layers of suppression:
//
//   Layer 1 — in-process retry inside each `check*` function (e.g.
//             `checkExchangeHealth` does 4 attempts with exp backoff).
//             Catches sub-second to ~10s network blips at Hetzner.
//
//   Layer 2 — cross-cron-cycle consecutive-fail counter (this state
//             struct). A check must fail for ≥ FAIL_THRESHOLDS[key]
//             consecutive cron runs (every 2 min) before any alert
//             fires. On recovery, the counter resets to 0 SILENTLY —
//             no "exchange recovered" follow-up alert (per operator
//             explicit request: don't spam recovery notices).

interface AlertState {
  lastAlerted: Record<string, number>;
  // Number of consecutive cron cycles each check has failed. Resets to
  // 0 the moment the check passes again. Persists across cron runs in
  // STATE_FILE; resets to {} on container restart (deploy) — that's
  // intentional, prevents stale pre-deploy counters from firing
  // spurious post-deploy alerts.
  consecutiveFails: Record<string, number>;
}

// Per-check threshold: how many consecutive cron-cycle failures before
// an alert is allowed to fire. Cron runs every 2 min, so threshold N
// means "N × 2 minutes of sustained failure required". Tuned per check:
//
//   2 (= ~4 min) — CRITICAL paths where every minute of confirmed
//                  downtime matters. server_health and facilitator
//                  already have 3-attempt × 5s in-process retries on
//                  top, so threshold-2 means ~4 min from genuine
//                  outage start to alert.
//
//   3 (= ~6 min) — exchange / RPC paths most prone to transient
//                  outbound network blips and per-IP rate-limits.
//                  exchanges had 0 cross-cycle protection before and
//                  caused yesterday's spurious 3-exchange flap; this
//                  is the headline fix.
//
//   1 (= immediate) — slow-moving signals (backfill queue depth, PFE
//                     win-rate drop) that don't flap. The 30-min
//                     dedup window stops repeats; we want first-cycle
//                     visibility on these.
const FAIL_THRESHOLDS: Record<string, number> = {
  server_health: 2,
  facilitator: 2,
  database: 2,
  gas_wallet: 3,
  exchanges: 3,
  backfill: 1,
  pfe_winrate: 1,
  // OPS-SEED-ORCHESTRATOR-W1/CH2: RESERVED for the seed-freshness check, which
  // ships REPORT-ONLY (checkSeedFreshness returns null pending a calibrated /
  // baseline-relative redesign — live data showed a fixed recency threshold
  // false-positives on every venue). When alerting is re-enabled this 3-cycle
  // (~6 min) consecutive gate applies; until then the check never reaches it.
  seed_freshness: 3,
  // OPS-SEED-FRESHNESS-W1: the attempt-heartbeat pager (the SOLE heartbeat paging path).
  // 45-min attempt-staleness = 9 missed 5m fires; market-independent (zero false-positive
  // surface); this 3-cycle (~6 min) consecutive gate ⇒ pages only on a sustained outage.
  seed_attempt_freshness: 3,
};

function loadState(): AlertState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<AlertState>;
    // Backward-compat: existing state files (pre-this-change) only
    // have `lastAlerted`. Default `consecutiveFails` to {} so a fresh
    // deploy doesn't crash on missing field.
    return {
      lastAlerted: raw.lastAlerted ?? {},
      consecutiveFails: raw.consecutiveFails ?? {},
    };
  } catch {
    return { lastAlerted: {}, consecutiveFails: {} };
  }
}

function saveState(state: AlertState): void {
  // Prune zero-valued consecutiveFails entries — keeps the state file
  // tidy when checks toggle in-and-out of failure. lastAlerted is
  // pruned by age (2h) elsewhere in runCritical.
  for (const [k, v] of Object.entries(state.consecutiveFails)) {
    if (v === 0) delete state.consecutiveFails[k];
  }
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
  // then walk to the next endpoint in BASE_RPCS. Only report the check as
  // FAILED if every endpoint fails all attempts — by that point the issue
  // is almost certainly real, not a transient rate limit on one provider.
  //
  // Critical: only ever report "wallet low" from a VALID balance read, and
  // only once >= GAS_LOW_CONFIRMATIONS independent endpoints agree. A
  // malformed response (missing `result` field, RPC error body, HTTP 5xx)
  // must never be silently coerced to 0 — and neither must a well-formed
  // `0x0` from a single pruned/lagging node, which is what produced 28
  // false "Gas wallet low: 0.000000 ETH" readings on 2026-07-17 while the
  // wallet actually held ~0.0471 ETH at every Base block.
  // Verdict logic + rationale: src/lib/gas-wallet-quorum.ts.
  const RPC_TIMEOUT = 10_000;
  const MAX_ATTEMPTS_PER_RPC = 3;
  const BACKOFF_MS = [1_000, 3_000]; // delay before attempt 2, 3

  const reads: GasRead[] = [];
  let lastError = '';
  let lastEndpoint = '';
  let sawLow = false;

  for (const rpc of BASE_RPCS) {
    lastEndpoint = rpc;
    let eth: number | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_RPC; attempt++) {
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
          const parsed = parseGasBalanceResult(await res.json().catch(() => null));
          if (parsed.ok) {
            // `=== null` (not falsy) — a genuine 0 balance is a valid read.
            eth = parsed.eth;
            break;
          }
          lastError = parsed.error;
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

    if (eth === null) {
      reads.push({ endpoint: rpc, ok: false, error: lastError });
      // Endpoint exhausted — try next fallback
      console.log(`[monitor] gas wallet RPC ${rpc} exhausted after ${MAX_ATTEMPTS_PER_RPC} attempts (${lastError}), trying next endpoint...`);
      continue;
    }

    reads.push({ endpoint: rpc, ok: true, eth });

    if (eth < GAS_WALLET_MIN_ETH) {
      // Never page off one node: poll the rest for independent corroboration.
      sawLow = true;
      console.log(`[monitor] gas wallet read ${eth.toFixed(6)} ETH from ${rpc} is below ${GAS_WALLET_MIN_ETH} — polling remaining endpoints for corroboration`);
    } else if (!sawLow) {
      // Fast path: first valid read is healthy, so there is nothing to
      // corroborate and no reason to spend the other endpoints' quota.
      break;
    }
  }

  const quorum = evaluateGasQuorum(reads);

  if (quorum.verdict === 'no-data') {
    return {
      error: `Gas wallet check failed: all ${BASE_RPCS.length} RPC endpoints exhausted (${MAX_ATTEMPTS_PER_RPC} attempts each). Last endpoint: ${lastEndpoint}, last error: ${lastError}`,
      balance: 0,
    };
  }

  if (quorum.verdict === 'unconfirmed') {
    // Forensics only — this is the exact shape of the 2026-07-17 false alert.
    console.log(`[monitor] gas wallet NOT paging (needs ${GAS_LOW_CONFIRMATIONS} independent confirmations): ${quorum.detail}`);
  }

  return { error: quorum.error, balance: quorum.balance };
}

async function checkDatabase(): Promise<string | null> {
  try {
    await dbQuery('SELECT 1');
    return null;
  } catch (err) {
    return `Database connection failed: ${(err as Error).message}`;
  }
}

// Returns true if the exchange is reachable. Retries with exponential
// backoff before declaring it down — public APIs occasionally slow-
// respond under load and Hetzner's outbound has sub-second blips. A
// single timeout, or even three within a few seconds, shouldn't trip
// a false alert. Total in-process retry budget = ~7s before declaring
// the exchange unreachable for THIS cron cycle; the cross-cycle layer
// in runCritical then requires N consecutive cycles to confirm.
//
// Pre-fix history: 2 attempts × 500ms = ~1s window. A single 8:10pm
// 2026-05-05 outbound network blip simultaneously tripped Binance +
// Bybit + Hyperliquid (parallel-checked) → false-positive alert. Fix
// expands per-call budget to 4 attempts so blips that long get caught.
async function checkExchangeHealth(name: string, url: string): Promise<boolean> {
  const MAX_ATTEMPTS = 4;
  const BACKOFF_MS = [500, 1500, 4000]; // delays before attempt 2, 3, 4

  // OPS-HL-RATELIMITER-W2: route HL's liveness probe through the shared HL weight
  // budget so the monitor can't itself contribute to a 429 storm. A budget refusal
  // (interactive rate-limit throw OR batch skip) means WE throttled locally — HL is
  // NOT down — so report alive. A real HTTP 429 surfaces as UpstreamRateLimitError
  // ("alive but busy" → alive). Only a genuine network/HTTP failure trips the down path.
  if (name === 'Hyperliquid') {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await hlInfoPost({ type: 'meta' }, { cls: 'interactive' });
        return true;
      } catch (err) {
        if (err instanceof UpstreamRateLimitError || err instanceof WeightBudgetSkipError) {
          return true; // budget-managed locally / alive-but-busy — never a false outage
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 4000));
        }
      }
    }
    return false;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { ok, status } = await fetchJson(url, {});
    // 429 = rate-limited but alive — never a real outage signal
    if (ok || status === 429) return true;
    if (attempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_MS[attempt - 1] ?? 4000;
      await new Promise(r => setTimeout(r, delay));
    }
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
  // Read the server-side-cached stats instead of recomputing the ~6 s / 152k-row
  // query in this cold cron process. Hit the co-located server on 127.0.0.1:$PORT
  // (NOT the public Cloudflare hairpin — it intermittently returned HTTP 0) with
  // a 15 s timeout, since /api/performance-public takes ~4.7 s on a cold 60 s-cache
  // miss and brushed the generic 5 s FETCH_TIMEOUT. Verdict logic in the pure,
  // unit-tested evaluatePfeWinRate(); an outage is caught by server_health/database.
  //
  // OPS-COALESCED-CACHE-LOAD-TIMEOUT-W1 R4: retry the FETCH (transient loopback abort / HTTP 0)
  // like checkServerHealth — 3 attempts, 5s delay. ONLY the HTTP-error path retries; once `ok`,
  // a real WR-value breach (evaluatePfeWinRate) still pages FIRST-cycle (NOT masked). The 15s
  // per-fetch timeout and FAIL_THRESHOLDS.pfe_winrate=1 are UNCHANGED. With the coalesced-cache
  // loadTimeoutMs fix (R1/R2) the endpoint no longer blocks ~84s on a cold HL fill, so a fetch
  // abort is now genuinely transient — this closes the consecutive=1 no-retry gap the loopback
  // hotfix flagged, without masking a sustained slowness or a real WR drop.
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5_000;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { ok, status, data } = await fetchJson(internalPerfPublicUrl(), {}, 15_000);
    if (ok) return evaluatePfeWinRate(data);
    lastStatus = status;
    if (attempt < MAX_ATTEMPTS) {
      console.log(`[monitor] PFE check fetch failed (HTTP ${status}), retry ${attempt}/${MAX_ATTEMPTS - 1} in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return { error: `PFE check failed: performance-public HTTP ${lastStatus} after ${MAX_ATTEMPTS} attempts`, rate: null };
}

async function checkSeedFreshness(): Promise<string | null> {
  // OPS-SEED-ORCHESTRATOR-W1/CH2 — venue seed-freshness DETECTION, REPORT-ONLY.
  //
  // Live calibration (2026-06-05) on a HEALTHY system showed recorded-signal
  // recency is too noisy for a fixed page threshold: over 48h the normal
  // per-venue inter-signal gap reached HL 505min (HL is sparse — ~26 sig/24h),
  // BINANCE 97min, BITGET 90min, OKX 54min, BYBIT 49min, because `signals` holds
  // only BUY/SELL (the HOLD/confidence filter at get-trade-call.ts:547) so a
  // quiet market legitimately lags MAX(created_at). A fixed 45-min threshold
  // false-positives on EVERY venue. Until a calibrated / baseline-relative design
  // is ratified, this check is REPORT-ONLY: it logs the per-venue verdict each
  // cycle (forensics + a calibration corpus) and NEVER returns an error → never
  // pages. The robust count-based coverage gate is the CH4 48h gate.
  // PG-targeted SQL (the monitor's production backend; mirrors checkBackfillQueue).
  try {
    const venues = await listVenues('promoted');
    const promoted = venues.filter((v) => v.status !== 'retired').map((v) => v.exchange_id);
    if (promoted.length === 0) return null;
    const rows = await dbQuery<{ exchange: string; last: number | string | null }>(
      'SELECT exchange, MAX(created_at) AS last FROM signals WHERE exchange = ANY($1) GROUP BY exchange',
      [promoted],
    );
    // created_at is epoch SECONDS (recordSignal: Math.floor(Date.now()/1000)) →
    // ×1000 for the ms-based pure evaluator.
    const freshnessRows = rows.map((r) => ({
      exchange: r.exchange,
      lastCreatedAtMs: r.last != null ? Number(r.last) * 1000 : null,
    }));
    const verdicts = evaluateSeedFreshness(freshnessRows, Date.now());
    const summary = verdicts.map((v) => `${v.venue}=${v.staleMin}m`).join(' ');
    console.log(`[monitor] seed-freshness (report-only, no page): ${summary}`);
  } catch (err) {
    console.log(`[monitor] seed-freshness check error (report-only): ${(err as Error).message}`);
  }
  return null; // REPORT-ONLY — never pages (alerting deferred to a calibrated redesign).
}

async function checkSeedAttemptFreshness(): Promise<string | null> {
  // OPS-SEED-FRESHNESS-W1 — attempt-heartbeat seed-OUTAGE pager (the SOLE heartbeat
  // paging path; the signal-based checkSeedFreshness above stays report-only forensic).
  // ATTEMPTS are market-independent: every promoted venue is hit by the 5m line, so a
  // healthy venue's freshest attempt across all TFs is ≤5 min by construction. 45-min
  // attempt-staleness = 9 missed 5m fires = a real outage (cron stopped / container down
  // / DB-write unreachable) — the silent EAI_AGAIN data-flywheel class the report-only
  // signal check cannot page on. + the consecutive-3 (~6 min) gate ⇒ pages only on a
  // ≥45-min outage sustained ~6 min. Zero false-positive surface (attempts don't depend
  // on market activity). Logic is the unit-tested pure helpers; this is thin glue.
  try {
    const venues = await listVenues('promoted');
    const promoted = venues.filter((v) => v.status !== 'retired').map((v) => v.exchange_id);
    if (promoted.length === 0) return null;
    const heartbeats = await getLatestSeedHeartbeatPerVenue();
    const rows = buildSeedFreshnessRows(promoted, heartbeats);
    const verdicts = evaluateSeedFreshness(rows, Date.now(), 45);
    console.log(`[monitor] seed-attempt-freshness: ${verdicts.map((v) => `${v.venue}=${v.staleMin}m`).join(' ')}`);
    return formatSeedOutagePage(verdicts);
  } catch (err) {
    // fail-open: the check's OWN error (DB unreachable, missing table on a fresh box) →
    // log + null. The `database` check owns DB-down paging — never double-page on a
    // monitor-infra blip (mirrors checkSeedFreshness's report-only catch).
    console.log(`[monitor] seed-attempt-freshness check error (fail-open, no page): ${(err as Error).message}`);
    return null;
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
    ['seed_freshness', checkSeedFreshness],
    ['seed_attempt_freshness', checkSeedAttemptFreshness],
  ];

  let alertCount = 0;
  let recoveredCount = 0;
  let suppressedCount = 0;

  for (const [key, check] of checks) {
    const error = await check();
    const threshold = FAIL_THRESHOLDS[key] ?? 1;

    if (error) {
      // Increment consecutive-fail counter and decide whether to alert.
      const consecutive = (state.consecutiveFails[key] ?? 0) + 1;
      state.consecutiveFails[key] = consecutive;

      if (consecutive < threshold) {
        // Auto-recovery window — silently log and wait for next cycle.
        // Per CLAUDE.md "Detect → Recover → Alert → Escalate": we have
        // not yet exhausted autonomous recovery, so no Telegram fire.
        suppressedCount++;
        console.log(
          `[monitor] auto-recovery window (${consecutive}/${threshold}): ${key}: ${error}`,
        );
      } else if (shouldAlert(state, key)) {
        // Threshold met AND outside dedup window — fire.
        const level = ['server_health', 'facilitator', 'database'].includes(key)
          ? 'critical'
          : 'warning';
        // Annotate sustained-failure messages so the operator can tell
        // first-fire from a re-fire after dedup window expiry.
        const sustainedMin = consecutive * 2; // cron runs every 2 min
        const msg = consecutive === threshold
          ? error
          : `${error} (sustained ≥${sustainedMin}min, ${consecutive} consecutive cycles)`;
        await sendAlert(msg, level);
        markAlerted(state, key);
        alertCount++;
        console.log(
          `[monitor] ALERT (${level}, consecutive=${consecutive}): ${error}`,
        );
      } else {
        // Threshold met but inside the 30-min dedup window — log only.
        suppressedCount++;
        console.log(
          `[monitor] suppressed (dedup, consecutive=${consecutive}): ${key}: ${error}`,
        );
      }
    } else {
      // Check passed. If it had been failing, log the auto-recovery
      // (no Telegram fire — operator explicitly opted out of recovery
      // notices: "no need to send the alert for those that can be
      // auto recovery"). The console line still goes to the cron log
      // so we have a forensic trail.
      const wasFailing = state.consecutiveFails[key] ?? 0;
      if (wasFailing > 0) {
        recoveredCount++;
        console.log(
          `[monitor] auto-recovered: ${key} (was ${wasFailing} consecutive cycle(s) failing)`,
        );
      }
      state.consecutiveFails[key] = 0;
    }
  }

  // Clean up old dedup entries (> 2 hours).
  const now = Date.now();
  for (const [key, ts] of Object.entries(state.lastAlerted)) {
    if (now - ts > 2 * 60 * 60 * 1000) delete state.lastAlerted[key];
  }

  saveState(state);
  console.log(
    `[monitor] critical done — ${alertCount} alert(s), ${suppressedCount} suppressed, ${recoveredCount} auto-recovered`,
  );
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
    const total = perfStats.overall.totalCalls;
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
  // Split external (organic MCP clients) vs internal (algovault-bot self-traffic
  // via X-AlgoVault-Internal-Key bypass header). The previous single "Total calls
  // today" line was ~99% bot self-traffic and read as external agent adoption.
  if (analyticsResult.ok && analyticsResult.data) {
    const a = analyticsResult.data as Record<string, unknown>;
    // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: render via the pure, golden-tested
    // formatter (genuine-vs-automated split; top-assets over the genuine slice).
    sections.push(formatAgentActivity(a));
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

// OPS-SCRIPT-EXIT-LIFECYCLE-W1: was a bare `main()` — no guard, no cleanup, no
// exit on success, running 720x/day. The guard also makes this module
// test-importable (see agent-activity-format.ts, which only exists because
// importing monitor.ts used to fire main() on load).
if (require.main === module) {
  void runScript('monitor', main);
}
