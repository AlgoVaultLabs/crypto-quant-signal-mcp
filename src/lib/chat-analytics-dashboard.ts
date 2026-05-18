/**
 * Chat analytics admin dashboard — CHAT-USAGE-ANALYTICS-W1 (R5).
 *
 * Renders `/admin/chat-analytics` HTML. Admin-key-gated upstream; this module
 * just builds the HTML body. Reuses inline CSS minimalism (no external lib,
 * Unicode sparklines for trends, plain tables for the rest).
 *
 * Six sections per spec:
 *   1. Today / 7d / 30d totals per tier
 *   2. p50 / p95 latency trend (Unicode sparkline)
 *   3. Top-10 question hashes by frequency last 7d (PRIVACY: hash + count
 *      + sample length only; never the raw text)
 *   4. Cost breakdown by tier (USD/mo derived from cost_usd_e6)
 *   5. No-answer rate trend
 *   6. LLM-PROVIDER-A/B-W1 trigger status badge (X / 7 consecutive days at
 *      ≥100 queries/day) — flips GREEN when X == 7
 *
 * Path B addition (Cowork Q-4): "Provider mix" widget — banner ALERT if
 * `stub` >0% of last 24h (indicates ANTHROPIC_API_KEY rotation gap).
 */
import { dbQuery } from './performance-db.js';

const TRIGGER_QUERY_THRESHOLD = 100; // queries/day to count as a "high-volume day"
const TRIGGER_CONSECUTIVE_DAYS = 7; // consecutive high-volume days to fire trigger

interface DailyRow {
  day_utc: string;
  api_key_tier: string;
  provider: string;
  queries: string | number;
  no_answer_queries: string | number;
  error_queries: string | number;
  total_prompt_tokens: string | number;
  total_completion_tokens: string | number;
  total_cached_prompt_tokens: string | number;
  total_cost_usd_e6: string | number;
  p50_latency_ms: string | number | null;
  p95_latency_ms: string | number | null;
}

interface TopQuestion {
  question_hash: string;
  count: string | number;
  avg_question_length: string | number;
}

interface ProviderMixRow {
  provider: string;
  queries: string | number;
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

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function n(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export async function getChatAnalyticsHtml(opts: { lookbackDays: number }): Promise<string> {
  const lookback = Math.max(1, Math.min(180, opts.lookbackDays));

  // Section data — sequential SELECTs against chat_analytics_daily + raw events table
  // (raw events used only for top-N question hashes; aggregates via view).
  const dailyAll = await dbQuery<DailyRow>(
    `SELECT day_utc::TEXT AS day_utc, api_key_tier, provider, queries, no_answer_queries, error_queries,
            total_prompt_tokens, total_completion_tokens, total_cached_prompt_tokens, total_cost_usd_e6,
            p50_latency_ms, p95_latency_ms
       FROM chat_analytics_daily
      WHERE day_utc > now() - interval '${lookback} days'
      ORDER BY day_utc ASC`,
  );

  const topQuestions = await dbQuery<TopQuestion>(
    `SELECT question_hash,
            count(*) AS count,
            AVG(question_length)::INT AS avg_question_length
       FROM chat_analytics_events
      WHERE recorded_at > now() - interval '7 days'
      GROUP BY question_hash
      ORDER BY count DESC
      LIMIT 10`,
  );

  const providerMix24h = await dbQuery<ProviderMixRow>(
    `SELECT provider, count(*) AS queries
       FROM chat_analytics_events
      WHERE recorded_at > now() - interval '1 day'
      GROUP BY provider
      ORDER BY queries DESC`,
  );

  // ── Aggregate per-day totals across tiers + providers ──
  const dayMap = new Map<string, { queries: number; cost: number; p50: number; p95: number; noAns: number; errs: number }>();
  for (const r of dailyAll) {
    const d = String(r.day_utc).slice(0, 10);
    const e = dayMap.get(d) ?? { queries: 0, cost: 0, p50: 0, p95: 0, noAns: 0, errs: 0 };
    e.queries += n(r.queries);
    e.cost += n(r.total_cost_usd_e6);
    e.p50 = Math.max(e.p50, n(r.p50_latency_ms));
    e.p95 = Math.max(e.p95, n(r.p95_latency_ms));
    e.noAns += n(r.no_answer_queries);
    e.errs += n(r.error_queries);
    dayMap.set(d, e);
  }
  const sortedDays = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b));

  // ── Window aggregates ──
  function window(daysBack: number): {
    queries: number;
    cost: number;
    noAns: number;
    errs: number;
    avgP50: number;
    avgP95: number;
  } {
    const cutoff = Date.now() - daysBack * 24 * 3600 * 1000;
    let queries = 0, cost = 0, noAns = 0, errs = 0;
    let p50Sum = 0, p95Sum = 0, days = 0;
    for (const [d, e] of sortedDays) {
      const ts = new Date(d + 'T00:00:00Z').getTime();
      if (ts < cutoff) continue;
      queries += e.queries;
      cost += e.cost;
      noAns += e.noAns;
      errs += e.errs;
      if (e.p50 > 0) { p50Sum += e.p50; days++; }
      p95Sum += e.p95;
    }
    return {
      queries,
      cost,
      noAns,
      errs,
      avgP50: days > 0 ? p50Sum / days : 0,
      avgP95: days > 0 ? p95Sum / days : 0,
    };
  }
  const w1 = window(1);
  const w7 = window(7);
  const w30 = window(30);

  // ── Per-tier breakdown (last 30d) ──
  const tierBreakdown = new Map<string, { queries: number; cost: number }>();
  const cutoff30 = Date.now() - 30 * 24 * 3600 * 1000;
  for (const r of dailyAll) {
    const ts = new Date(String(r.day_utc).slice(0, 10) + 'T00:00:00Z').getTime();
    if (ts < cutoff30) continue;
    const t = String(r.api_key_tier);
    const e = tierBreakdown.get(t) ?? { queries: 0, cost: 0 };
    e.queries += n(r.queries);
    e.cost += n(r.total_cost_usd_e6);
    tierBreakdown.set(t, e);
  }

  // ── LLM-PROVIDER-A/B-W1 trigger status ──
  // Count consecutive most-recent days where queries >= TRIGGER_QUERY_THRESHOLD
  let consecutiveHighDays = 0;
  for (let i = sortedDays.length - 1; i >= 0; i--) {
    const dayQueries = sortedDays[i][1].queries;
    if (dayQueries >= TRIGGER_QUERY_THRESHOLD) consecutiveHighDays++;
    else break;
  }
  const triggerFired = consecutiveHighDays >= TRIGGER_CONSECUTIVE_DAYS;
  const triggerColor = triggerFired ? '#22c55e' : consecutiveHighDays > 0 ? '#eab308' : '#94a3b8';
  const triggerLabel = triggerFired
    ? `🟢 TRIGGER FIRED (${consecutiveHighDays}/${TRIGGER_CONSECUTIVE_DAYS}) — dispatch Prompt/llm-provider-ab-w1.md`
    : `${consecutiveHighDays > 0 ? '🟡' : '⚪'} ${consecutiveHighDays} / ${TRIGGER_CONSECUTIVE_DAYS} consecutive days at ≥${TRIGGER_QUERY_THRESHOLD} queries/day`;

  // ── Provider mix 24h + stub alert (Cowork Q-4 Path B) ──
  const total24h = providerMix24h.reduce((acc, p) => acc + n(p.queries), 0);
  const stubRow = providerMix24h.find((p) => p.provider === 'stub');
  const stubPct24h = total24h > 0 && stubRow ? (n(stubRow.queries) / total24h) * 100 : 0;
  const showStubBanner = stubPct24h > 0;
  const providerMixHtml = providerMix24h
    .map((p) => `<span style="color:${p.provider === 'stub' ? '#dc2626' : '#10b981'};">${htmlEscape(p.provider)}=${fmtInt(n(p.queries))}</span>`)
    .join(' · ');

  // ── Sparklines ──
  const querySpark = sparkline(sortedDays.slice(-14).map(([, e]) => e.queries));
  const costSpark = sparkline(sortedDays.slice(-14).map(([, e]) => e.cost));
  const p95Spark = sparkline(sortedDays.slice(-14).map(([, e]) => e.p95));
  const noAnsRatesSpark = sparkline(
    sortedDays.slice(-14).map(([, e]) => (e.queries > 0 ? (e.noAns / e.queries) * 100 : 0)),
  );

  // ── Build HTML ──
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AlgoVault — Chat Analytics (admin)</title>
  <meta name="robots" content="noindex,nofollow">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 24px; background: #0f172a; color: #e2e8f0; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 24px 0 8px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .card { background: #1e293b; padding: 16px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #334155; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .metric-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .metric-value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    .metric-trend { font-family: monospace; font-size: 18px; letter-spacing: 1px; color: #64748b; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #334155; font-size: 13px; }
    th { color: #94a3b8; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; font-weight: 600; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .banner { background: #7f1d1d; color: #fecaca; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; border-left: 4px solid #dc2626; }
    .trigger-badge { display: inline-block; padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 13px; }
  </style>
</head>
<body>
  <h1>AlgoVault — Chat Analytics</h1>
  <div class="subtitle">CHAT-USAGE-ANALYTICS-W1 · admin-only · last ${lookback}d window · PII-safe (SHA256 hash, no raw text)</div>

  ${showStubBanner ? `<div class="banner">⚠️ <strong>Stub provider detected:</strong> ${stubPct24h.toFixed(1)}% of last-24h chat calls used the StubLLMProvider (not real LLM). Most likely cause: <code>ANTHROPIC_API_KEY</code> rotation gap or unset env. Investigate via <code>docker exec ... env | grep ANTHROPIC_API_KEY</code> on the mcp-server container.</div>` : ''}

  <h2>LLM-PROVIDER-A/B-W1 trigger</h2>
  <div class="card">
    <div class="trigger-badge" style="background:${triggerColor}; color:#0f172a;">${triggerLabel}</div>
    <div class="metric-trend" style="margin-top: 12px;">Threshold: ≥${TRIGGER_QUERY_THRESHOLD} queries/day × ${TRIGGER_CONSECUTIVE_DAYS} consecutive days.</div>
  </div>

  <h2>Window totals</h2>
  <div class="grid">
    <div class="card">
      <div class="metric-label">Last 24h</div>
      <div class="metric-value">${fmtInt(w1.queries)}</div>
      <div class="metric-trend">${fmtUsd(w1.cost)} · ${w1.noAns} no-ans · ${w1.errs} err</div>
    </div>
    <div class="card">
      <div class="metric-label">Last 7d</div>
      <div class="metric-value">${fmtInt(w7.queries)}</div>
      <div class="metric-trend">${fmtUsd(w7.cost)} · ${w7.noAns} no-ans · ${w7.errs} err</div>
    </div>
    <div class="card">
      <div class="metric-label">Last 30d</div>
      <div class="metric-value">${fmtInt(w30.queries)}</div>
      <div class="metric-trend">${fmtUsd(w30.cost)} · ${w30.noAns} no-ans · ${w30.errs} err</div>
    </div>
    <div class="card">
      <div class="metric-label">Latency p50 / p95 (7d avg)</div>
      <div class="metric-value">${fmtInt(Math.round(w7.avgP50))}ms / ${fmtInt(Math.round(w7.avgP95))}ms</div>
      <div class="metric-trend">p95 trend 14d: ${p95Spark}</div>
    </div>
  </div>

  <h2>Provider mix (last 24h)</h2>
  <div class="card">
    ${providerMixHtml || '<span style="color:#64748b;">No chat events in last 24h.</span>'}
  </div>

  <h2>Daily trends (14d)</h2>
  <div class="card">
    <div style="font-family: monospace; font-size: 14px; line-height: 1.8;">
      Queries:        <span style="color:#10b981;">${querySpark}</span>
      <br>Cost (USD):     <span style="color:#3b82f6;">${costSpark}</span>
      <br>No-ans rate:    <span style="color:#eab308;">${noAnsRatesSpark}</span>
      <br>p95 latency:    <span style="color:#a855f7;">${p95Spark}</span>
    </div>
  </div>

  <h2>Tier breakdown (last 30d)</h2>
  <div class="card">
    <table>
      <thead><tr><th>Tier</th><th>Queries</th><th>Cost</th><th>Cost/query</th></tr></thead>
      <tbody>
        ${
          [...tierBreakdown.entries()]
            .sort(([, a], [, b]) => b.queries - a.queries)
            .map(([t, e]) => `<tr><td><code>${htmlEscape(t)}</code></td><td>${fmtInt(e.queries)}</td><td>${fmtUsd(e.cost)}</td><td>${fmtUsd(e.queries > 0 ? Math.round(e.cost / e.queries) : 0)}</td></tr>`)
            .join('') || '<tr><td colspan="4" style="color:#64748b;">No events in window.</td></tr>'
        }
      </tbody>
    </table>
  </div>

  <h2>Top-10 question hashes (last 7d, PII-safe)</h2>
  <div class="card">
    <table>
      <thead><tr><th>Hash (sha256-16)</th><th>Count</th><th>Avg length</th></tr></thead>
      <tbody>
        ${
          topQuestions.map((q) => `<tr><td><code>${htmlEscape(String(q.question_hash))}</code></td><td>${fmtInt(n(q.count))}</td><td>${fmtInt(n(q.avg_question_length))} chars</td></tr>`).join('')
          || '<tr><td colspan="3" style="color:#64748b;">No questions in last 7d.</td></tr>'
        }
      </tbody>
    </table>
    <div style="color:#64748b; font-size: 12px; margin-top: 8px;">Hashes intentionally cluster semantically-equivalent rephrasings into one bucket. Raw question text is NEVER stored.</div>
  </div>
</body>
</html>`;
}
