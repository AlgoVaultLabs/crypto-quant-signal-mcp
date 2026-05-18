#!/usr/bin/env tsx
/**
 * chat-analytics-digest.ts — CHAT-USAGE-ANALYTICS-W1 (R6) weekly Telegram digest.
 *
 * Queries `chat_analytics_daily` for the last 7 days; computes total queries,
 * cost, no-answer rate, p50/p95 latency, provider mix, and the
 * LLM-PROVIDER-A/B-W1 trigger probe (X / 7 consecutive days at
 * ≥100 queries/day). Sends one Telegram message to admin chat ID via
 * existing `sendDigest()`.
 *
 * Cron entry (Hetzner crontab):
 *   0 9 * * 0 docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/chat-analytics-digest.js >> /var/log/chat-analytics-digest.log 2>&1
 *
 * Usage:
 *   npx tsx src/scripts/chat-analytics-digest.ts            (live cron mode — sends to Telegram)
 *   npx tsx src/scripts/chat-analytics-digest.ts --dry-run  (formats + prints to stdout, no Telegram send)
 *
 * Gate: skip Telegram send entirely if last 7d total < 5 queries (avoid
 * noise during ramp-up). Still prints summary to stdout in --dry-run mode
 * even below the threshold.
 */
import { dbQuery, closeDb } from '../lib/performance-db.js';
import { sendDigest, sendAlert } from '../lib/telegram.js';

const SILENT_THRESHOLD_QUERIES_7D = 5;
const TRIGGER_QUERY_THRESHOLD = 100; // queries/day threshold for high-volume day
const TRIGGER_CONSECUTIVE_DAYS = 7; // consecutive days to fire LLM-PROVIDER-A/B-W1 trigger
const STUB_ALERT_PCT_24H = 5; // ≥5% stub usage in last 24h → Telegram WARNING

interface DailyRow {
  day_utc: string;
  api_key_tier: string;
  provider: string;
  queries: string | number;
  no_answer_queries: string | number;
  error_queries: string | number;
  total_cost_usd_e6: string | number;
  p50_latency_ms: string | number | null;
  p95_latency_ms: string | number | null;
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values: number[]): string {
  if (values.length === 0) return '–';
  const max = Math.max(...values, 1);
  return values.map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)))]).join('');
}

function fmtUsd(microDollars: number): string {
  const d = microDollars / 1_000_000;
  if (d === 0) return '$0.00';
  if (d < 0.01) return `$${d.toFixed(6)}`;
  return `$${d.toFixed(4)}`;
}

function n(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

export interface ChatAnalyticsDigest {
  weekEnding: string;
  total7dQueries: number;
  total7dCost: number;
  noAnswerRate7d: number;
  avgP50: number;
  avgP95: number;
  consecutiveHighDays: number;
  triggerFired: boolean;
  stubPct24h: number;
  providerMix24h: Array<{ provider: string; queries: number }>;
  sections: string[];
}

export async function buildChatAnalyticsDigest(): Promise<ChatAnalyticsDigest> {
  const weekEnding = new Date().toISOString().slice(0, 10);

  const daily = await dbQuery<DailyRow>(
    `SELECT day_utc::TEXT AS day_utc, api_key_tier, provider, queries, no_answer_queries,
            error_queries, total_cost_usd_e6, p50_latency_ms, p95_latency_ms
       FROM chat_analytics_daily
      WHERE day_utc > now() - interval '7 days'
      ORDER BY day_utc ASC`,
  );

  const provider24h = await dbQuery<{ provider: string; queries: string | number }>(
    `SELECT provider, count(*) AS queries
       FROM chat_analytics_events
      WHERE recorded_at > now() - interval '1 day'
      GROUP BY provider
      ORDER BY queries DESC`,
  );

  // Per-day rollups (sum across tiers + providers)
  const dayMap = new Map<string, { queries: number; cost: number; noAns: number; errs: number; p50: number; p95: number }>();
  for (const r of daily) {
    const d = String(r.day_utc).slice(0, 10);
    const e = dayMap.get(d) ?? { queries: 0, cost: 0, noAns: 0, errs: 0, p50: 0, p95: 0 };
    e.queries += n(r.queries);
    e.cost += n(r.total_cost_usd_e6);
    e.noAns += n(r.no_answer_queries);
    e.errs += n(r.error_queries);
    e.p50 = Math.max(e.p50, n(r.p50_latency_ms));
    e.p95 = Math.max(e.p95, n(r.p95_latency_ms));
    dayMap.set(d, e);
  }
  const sortedDays = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b));

  const total7dQueries = sortedDays.reduce((acc, [, e]) => acc + e.queries, 0);
  const total7dCost = sortedDays.reduce((acc, [, e]) => acc + e.cost, 0);
  const total7dNoAns = sortedDays.reduce((acc, [, e]) => acc + e.noAns, 0);
  const noAnswerRate7d = total7dQueries > 0 ? (total7dNoAns / total7dQueries) * 100 : 0;

  const p50Days = sortedDays.filter(([, e]) => e.p50 > 0);
  const p95Days = sortedDays.filter(([, e]) => e.p95 > 0);
  const avgP50 = p50Days.length > 0 ? p50Days.reduce((a, [, e]) => a + e.p50, 0) / p50Days.length : 0;
  const avgP95 = p95Days.length > 0 ? p95Days.reduce((a, [, e]) => a + e.p95, 0) / p95Days.length : 0;

  // Consecutive high-volume days (LLM-PROVIDER-A/B-W1 trigger)
  let consecutiveHighDays = 0;
  for (let i = sortedDays.length - 1; i >= 0; i--) {
    const dayQueries = sortedDays[i][1].queries;
    if (dayQueries >= TRIGGER_QUERY_THRESHOLD) consecutiveHighDays++;
    else break;
  }
  const triggerFired = consecutiveHighDays >= TRIGGER_CONSECUTIVE_DAYS;

  // Provider mix 24h
  const providerMix24h = provider24h.map((p) => ({ provider: String(p.provider), queries: n(p.queries) }));
  const total24h = providerMix24h.reduce((acc, p) => acc + p.queries, 0);
  const stubQueries24h = providerMix24h.find((p) => p.provider === 'stub')?.queries ?? 0;
  const stubPct24h = total24h > 0 ? (stubQueries24h / total24h) * 100 : 0;

  const sections: string[] = [];

  sections.push(`📊 *AlgoVault chat analytics — week ending ${weekEnding}*`);

  if (total7dQueries < SILENT_THRESHOLD_QUERIES_7D) {
    sections.push(`Ramp-up week — ${total7dQueries} chat queries in last 7d (silent threshold = ${SILENT_THRESHOLD_QUERIES_7D}).`);
    return { weekEnding, total7dQueries, total7dCost, noAnswerRate7d, avgP50, avgP95, consecutiveHighDays, triggerFired, stubPct24h, providerMix24h, sections };
  }

  const querySpark = sparkline(sortedDays.map(([, e]) => e.queries));
  const costSpark = sparkline(sortedDays.map(([, e]) => e.cost));
  sections.push('');
  sections.push(`*Queries 7d*: ${total7dQueries.toLocaleString()}  ${querySpark}`);
  sections.push(`*Cost 7d*: ${fmtUsd(total7dCost)}  ${costSpark} (budget: $20/mo Anthropic-side cap)`);
  sections.push(`*No-answer rate*: ${noAnswerRate7d.toFixed(1)}%`);
  sections.push(`*Latency*: p50 ${Math.round(avgP50)}ms · p95 ${Math.round(avgP95)}ms (7d avg)`);

  // Provider mix line
  const providerMixLine = providerMix24h.length > 0
    ? providerMix24h.map((p) => `${p.provider} ${((p.queries / Math.max(1, total24h)) * 100).toFixed(1)}%`).join(' · ')
    : '(no 24h events)';
  sections.push(`*Provider mix 24h*: ${providerMixLine}`);

  // LLM-PROVIDER-A/B-W1 trigger
  if (triggerFired) {
    sections.push('');
    sections.push(`🟢 *LLM-PROVIDER-A/B-W1 trigger FIRED* — ${consecutiveHighDays}/${TRIGGER_CONSECUTIVE_DAYS} consecutive days at ≥${TRIGGER_QUERY_THRESHOLD} queries/day.`);
    sections.push(`→ dispatch \`Prompt/llm-provider-ab-w1.md\``);
  } else {
    sections.push(`*LLM-PROVIDER-A/B-W1 trigger*: ${consecutiveHighDays} / ${TRIGGER_CONSECUTIVE_DAYS} consecutive days at ≥${TRIGGER_QUERY_THRESHOLD} q/day`);
  }

  // Stub alert (Cowork Q-4 Path B)
  if (stubPct24h >= STUB_ALERT_PCT_24H) {
    sections.push('');
    sections.push(`⚠️ *STUB PROVIDER ALERT*: ${stubPct24h.toFixed(1)}% of last-24h queries used StubLLMProvider (likely ANTHROPIC_API_KEY rotation gap). Verify env on mcp-server container.`);
  }

  return { weekEnding, total7dQueries, total7dCost, noAnswerRate7d, avgP50, avgP95, consecutiveHighDays, triggerFired, stubPct24h, providerMix24h, sections };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const digest = await buildChatAnalyticsDigest();

  if (dryRun) {
    console.log('--- chat-analytics-digest dry-run output ---');
    console.log(digest.sections.join('\n'));
    console.log('--- end dry-run ---');
    console.log(`\n[meta] total7dQueries=${digest.total7dQueries} consecutiveHighDays=${digest.consecutiveHighDays} triggerFired=${digest.triggerFired} stubPct24h=${digest.stubPct24h.toFixed(2)}%`);
    closeDb();
    return;
  }

  // Below silent threshold → skip Telegram send entirely (avoid noise during ramp-up)
  if (digest.total7dQueries < SILENT_THRESHOLD_QUERIES_7D) {
    console.log(`[chat-analytics-digest] ${new Date().toISOString()}: skipped (only ${digest.total7dQueries} queries in last 7d, threshold ${SILENT_THRESHOLD_QUERIES_7D})`);
    closeDb();
    return;
  }

  const ok = await sendDigest(digest.sections);
  if (ok) {
    console.log(`[chat-analytics-digest] ${new Date().toISOString()}: digest sent to Telegram`);
  } else {
    console.error(`[chat-analytics-digest] ${new Date().toISOString()}: digest send failed (check TELEGRAM_BOT_TOKEN/CHAT_ID env)`);
    process.exitCode = 1;
  }

  // Path B stub-alert: emit WARNING-level Telegram alert IN ADDITION to digest if stub usage >5% of 24h.
  if (digest.stubPct24h >= STUB_ALERT_PCT_24H) {
    await sendAlert(
      `Stub provider alert: ${digest.stubPct24h.toFixed(1)}% of last-24h chat queries used StubLLMProvider (likely ANTHROPIC_API_KEY rotation gap). Verify ANTHROPIC_API_KEY on /opt/algovault/crypto-quant-signal-mcp/.env + docker compose up -d mcp-server.`,
      'warning',
    );
  }

  closeDb();
}

const argv1 = process.argv[1] ?? '';
const isMain = argv1.endsWith('chat-analytics-digest.js') || argv1.endsWith('chat-analytics-digest.ts');
if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err);
    closeDb();
    process.exit(1);
  });
}
