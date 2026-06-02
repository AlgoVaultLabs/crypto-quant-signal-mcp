/**
 * GEO-MEASUREMENT-W1 (C2, 2026-05-19) — admin GEO dashboard.
 *
 * Renders `/admin/geo-dashboard` HTML. Admin-key-gated upstream
 * (src/index.ts uses `isAdminAuthorized(req)` inline check inside the
 * `if (adminKeyRaw)` closure block); this module just builds the HTML body.
 *
 * Mirrors chat-analytics-dashboard pattern: inline CSS, no external lib,
 * Unicode sparklines for trends, plain tables for the rest.
 *
 * Sections:
 *   1. Weekly mention-rate trend per model (sparkline + table)
 *   2. Per-query mention rate last 4 weeks — sorted ASC by rate (gap analysis)
 *   3. Top co-mentioned competitors last 4 weeks
 *   4. WoW drop alerts (red banner if any)
 *   5. Run summary (latest run id, queries, errors, last-fired timestamp)
 */
import { dbQuery } from './performance-db.js';

interface WeeklyRow {
  week_utc: string;
  model: string;
  query_count: string | number;
  mention_count: string | number;
  mention_rate_pct: string | number | null;
  avg_position: string | number | null;
  avg_sentiment: string | number | null;
}

interface PerQueryRow {
  query_id: string;
  model: string;
  runs: string | number;
  mention_rate_pct: string | number | null;
  avg_position: string | number | null;
}

interface CompetitorRow {
  competitor: string;
  co_mention_count: string | number;
}

interface WowDropRow {
  model: string;
  this_week: string | number;
  last_week: string | number;
  drop_pct: string | number;
}

interface LatestRunRow {
  run_id: string;
  ran_at: string;
  query_count: string | number;
  error_count: string | number;
}

// GEO-MEASUREMENT-W2 (C5) — retrieval-engine dimensions.
interface EngineRow {
  model: string;
  samples: string | number;
  mention_rate_pct: string | number | null;
  cited_rate_pct: string | number | null;
  avg_sov: string | number | null;
}
interface SourceMapRow {
  source_domain: string;
  attributed_to: string;
  competitor_name: string | null;
  citation_count: string | number;
  query_count: string | number;
}
interface TieredRow {
  query_tier: string | null;
  mention_rate_pct: string | number | null;
  avg_sov: string | number | null;
  samples: string | number;
}
interface GapBriefRow {
  query_id: string;
  query_tier: string | null;
  model: string;
  sov: string | number | null;
  top_competitor: string | null;
  top_competitor_domain: string | null;
  recommended_action: string | null;
  injected_at: string | null;
}

export interface GeoDashboardData {
  weekly: WeeklyRow[];
  perQuery: PerQueryRow[];
  competitors: CompetitorRow[];
  wowDrops: WowDropRow[];
  latestRun: LatestRunRow | null;
  // GEO-MEASUREMENT-W2 (C5) — optional so W1 fixtures/tests stay valid.
  engines?: EngineRow[];
  sourceMap?: SourceMapRow[];
  tiered?: TieredRow[];
  gaps?: GapBriefRow[];
}

function n(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

function fmtInt(x: number): string {
  return x.toLocaleString('en-US');
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values: number[]): string {
  if (values.length === 0) return '–';
  const max = Math.max(...values, 1);
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)))])
    .join('');
}

/**
 * WoW-drop SQL — also reused by `geo-weekly-cron.ts` to drive the Telegram
 * WARNING alert path. Threshold: >20% mention-count drop week-over-week.
 */
export const WOW_DROP_SQL = `
  WITH wk AS (
    SELECT
      model,
      count(*) FILTER (WHERE ran_at > now() - interval '1 week' AND mention_found) AS this_week,
      count(*) FILTER (WHERE ran_at <= now() - interval '1 week' AND ran_at > now() - interval '2 weeks' AND mention_found) AS last_week
    FROM geo_mentions
    GROUP BY model
  )
  SELECT
    model,
    this_week,
    last_week,
    CASE WHEN last_week = 0 THEN 0
         ELSE ROUND(100.0 * (last_week - this_week) / last_week, 1)
    END AS drop_pct
  FROM wk
  WHERE last_week > 0 AND ((last_week - this_week)::REAL / last_week) > 0.20
`;

export async function getGeoDashboardData(opts: { lookbackWeeks: number }): Promise<GeoDashboardData> {
  const weekly = await dbQuery<WeeklyRow>(
    `SELECT to_char(week_utc, 'YYYY-MM-DD') AS week_utc, model, query_count, mention_count,
            mention_rate_pct, avg_position, avg_sentiment
     FROM geo_weekly_summary
     WHERE week_utc > now() - $1 * interval '1 week'
     ORDER BY week_utc DESC, model`,
    [opts.lookbackWeeks],
  );

  const perQuery = await dbQuery<PerQueryRow>(
    `SELECT query_id, model, count(*) AS runs,
            ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct,
            AVG(mention_position) FILTER (WHERE mention_found) AS avg_position
     FROM geo_mentions
     WHERE ran_at > now() - interval '4 weeks'
     GROUP BY query_id, model
     ORDER BY mention_rate_pct ASC NULLS FIRST, query_id`,
    [],
  );

  const competitors = await dbQuery<CompetitorRow>(
    `SELECT unnest(competitors_mentioned) AS competitor, count(*) AS co_mention_count
     FROM geo_mentions
     WHERE ran_at > now() - interval '4 weeks'
     GROUP BY competitor
     ORDER BY co_mention_count DESC
     LIMIT 20`,
    [],
  );

  const wowDrops = await dbQuery<WowDropRow>(WOW_DROP_SQL, []);

  const latestRuns = await dbQuery<LatestRunRow>(
    `SELECT run_id::TEXT AS run_id,
            to_char(MIN(ran_at), 'YYYY-MM-DD HH24:MI:SS') AS ran_at,
            count(*) AS query_count,
            count(*) FILTER (WHERE error_code IS NOT NULL) AS error_count
     FROM geo_query_runs
     GROUP BY run_id
     ORDER BY MIN(ran_at) DESC
     LIMIT 1`,
    [],
  );

  // GEO-MEASUREMENT-W2 (C5) — retrieval-engine sections (retrieval rows only,
  // so W1 non-retrieval history doesn't dilute citation/SoV).
  const engines = await dbQuery<EngineRow>(
    `SELECT model, count(*) AS samples,
            ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct,
            ROUND(100.0 * count(*) FILTER (WHERE cited) / NULLIF(count(*), 0), 1) AS cited_rate_pct,
            ROUND(AVG(share_of_voice)::numeric, 3) AS avg_sov
     FROM geo_mentions
     WHERE retrieval = true AND ran_at > now() - $1 * interval '1 week'
     GROUP BY model
     ORDER BY model`,
    [opts.lookbackWeeks],
  );

  const sourceMap = await dbQuery<SourceMapRow>(
    `SELECT source_domain, attributed_to, competitor_name,
            sum(citation_count)::int AS citation_count,
            sum(query_count)::int AS query_count
     FROM geo_source_map_4w
     GROUP BY source_domain, attributed_to, competitor_name
     ORDER BY citation_count DESC
     LIMIT 25`,
    [],
  );

  const tiered = await dbQuery<TieredRow>(
    `SELECT query_tier, count(*) AS samples,
            ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct,
            ROUND(AVG(share_of_voice)::numeric, 3) AS avg_sov
     FROM geo_mentions
     WHERE retrieval = true AND ran_at > now() - $1 * interval '1 week'
     GROUP BY query_tier
     ORDER BY query_tier NULLS LAST`,
    [opts.lookbackWeeks],
  );

  const gaps = await dbQuery<GapBriefRow>(
    `SELECT query_id, query_tier, model, sov, top_competitor, top_competitor_domain,
            recommended_action, to_char(injected_at, 'YYYY-MM-DD HH24:MI') AS injected_at
     FROM geo_content_gaps
     ORDER BY computed_at DESC, rank_score DESC
     LIMIT 10`,
    [],
  );

  return {
    weekly,
    perQuery,
    competitors,
    wowDrops,
    latestRun: latestRuns[0] ?? null,
    engines,
    sourceMap,
    tiered,
    gaps,
  };
}

export function renderGeoDashboardHtml(data: GeoDashboardData): string {
  const { weekly, perQuery, competitors, wowDrops, latestRun } = data;

  // Weekly rate trend per model (latest 12 weeks ASC for sparkline orientation)
  const byModel = new Map<string, WeeklyRow[]>();
  for (const row of weekly) {
    const arr = byModel.get(row.model) ?? [];
    arr.push(row);
    byModel.set(row.model, arr);
  }

  const trendRows: string[] = [];
  for (const [model, rows] of byModel) {
    const asc = [...rows].reverse(); // sparkline ASC time order
    const rates = asc.map((r) => n(r.mention_rate_pct));
    const latest = asc[asc.length - 1];
    trendRows.push(
      `<tr><td><code>${htmlEscape(model)}</code></td>` +
        `<td class="spark">${sparkline(rates)}</td>` +
        `<td>${latest ? n(latest.mention_rate_pct).toFixed(1) : '0.0'}%</td>` +
        `<td>${latest ? `${fmtInt(n(latest.mention_count))}/${fmtInt(n(latest.query_count))}` : '0/0'}</td>` +
        `<td>${latest && latest.avg_position != null ? n(latest.avg_position).toFixed(1) : 'n/a'}</td>` +
        `<td>${latest && latest.avg_sentiment != null ? n(latest.avg_sentiment).toFixed(2) : 'n/a'}</td></tr>`,
    );
  }
  const weeklySection =
    byModel.size === 0
      ? '<p class="empty">No weekly data yet — first probe runs next Monday 08:00 UTC.</p>'
      : `<table>
          <thead><tr><th>Model</th><th>Trend (oldest→newest)</th><th>Latest rate</th><th>Latest mentions</th><th>Avg pos</th><th>Avg sentiment</th></tr></thead>
          <tbody>${trendRows.join('')}</tbody>
        </table>`;

  // Per-query gap analysis
  const perQueryRows = perQuery
    .map(
      (r) =>
        `<tr><td><code>${htmlEscape(r.query_id)}</code></td>` +
        `<td><code>${htmlEscape(r.model)}</code></td>` +
        `<td>${fmtInt(n(r.runs))}</td>` +
        `<td class="${n(r.mention_rate_pct) < 30 ? 'warn' : ''}">${
          r.mention_rate_pct == null ? '0.0' : n(r.mention_rate_pct).toFixed(1)
        }%</td>` +
        `<td>${r.avg_position == null ? 'n/a' : n(r.avg_position).toFixed(1)}</td></tr>`,
    )
    .join('');
  const perQuerySection =
    perQuery.length === 0
      ? '<p class="empty">No query data yet.</p>'
      : `<table>
          <thead><tr><th>Query ID</th><th>Model</th><th>Runs (4w)</th><th>Mention rate</th><th>Avg pos</th></tr></thead>
          <tbody>${perQueryRows}</tbody>
        </table>`;

  // Competitor density
  const competitorRows = competitors
    .map((r) => `<tr><td><code>${htmlEscape(r.competitor)}</code></td><td>${fmtInt(n(r.co_mention_count))}</td></tr>`)
    .join('');
  const competitorSection =
    competitors.length === 0
      ? '<p class="empty">No competitor mentions yet.</p>'
      : `<table>
          <thead><tr><th>Competitor</th><th>Co-mention count (4w)</th></tr></thead>
          <tbody>${competitorRows}</tbody>
        </table>`;

  // WoW drop banner
  const wowBanner =
    wowDrops.length === 0
      ? ''
      : `<div class="banner">⚠️ <strong>WoW mention-rate drop &gt;20% detected:</strong> ${wowDrops
          .map((r) => `<code>${htmlEscape(r.model)}</code> -${n(r.drop_pct).toFixed(1)}% (this: ${fmtInt(n(r.this_week))} / last: ${fmtInt(n(r.last_week))})`)
          .join(', ')}</div>`;

  // Latest run summary
  const runSection = latestRun
    ? `<table>
        <tr><th>Run ID</th><td><code>${htmlEscape(latestRun.run_id.slice(0, 8))}…</code></td></tr>
        <tr><th>Ran at</th><td>${htmlEscape(latestRun.ran_at)} UTC</td></tr>
        <tr><th>Queries</th><td>${fmtInt(n(latestRun.query_count))}</td></tr>
        <tr><th>Errors</th><td class="${n(latestRun.error_count) > 0 ? 'warn' : ''}">${fmtInt(n(latestRun.error_count))}</td></tr>
      </table>`
    : '<p class="empty">No runs yet — first probe runs next Monday 08:00 UTC.</p>';

  // GEO-MEASUREMENT-W2 (C5) — retrieval-engine sections.
  const engineRows = (data.engines ?? [])
    .map(
      (e) =>
        `<tr><td><code>${htmlEscape(e.model)}</code></td><td>${fmtInt(n(e.samples))}</td>` +
        `<td>${e.mention_rate_pct == null ? '0.0' : n(e.mention_rate_pct).toFixed(1)}%</td>` +
        `<td>${e.cited_rate_pct == null ? '0.0' : n(e.cited_rate_pct).toFixed(1)}%</td>` +
        `<td>${e.avg_sov == null ? '0.000' : n(e.avg_sov).toFixed(3)}</td></tr>`,
    )
    .join('');
  const enginesSection =
    (data.engines ?? []).length === 0
      ? '<p class="empty">No retrieval-engine data yet — first multi-engine probe runs next Monday 08:00 UTC.</p>'
      : `<table><thead><tr><th>Engine (model)</th><th>Samples</th><th>Mention rate</th><th>Citation rate</th><th>Avg SoV</th></tr></thead><tbody>${engineRows}</tbody></table>`;

  const tierRows = (data.tiered ?? [])
    .map(
      (t) =>
        `<tr><td><code>${htmlEscape(t.query_tier ?? 'niche')}</code></td><td>${fmtInt(n(t.samples))}</td>` +
        `<td>${t.mention_rate_pct == null ? '0.0' : n(t.mention_rate_pct).toFixed(1)}%</td>` +
        `<td>${t.avg_sov == null ? '0.000' : n(t.avg_sov).toFixed(3)}</td></tr>`,
    )
    .join('');
  const tieredSection =
    (data.tiered ?? []).length === 0
      ? '<p class="empty">No tiered data yet.</p>'
      : `<table><thead><tr><th>Tier</th><th>Samples</th><th>Mention rate</th><th>Avg SoV</th></tr></thead><tbody>${tierRows}</tbody></table>`;

  const sourceRows = (data.sourceMap ?? [])
    .map(
      (s) =>
        `<tr class="${s.attributed_to === 'competitor' ? 'warn' : ''}"><td><code>${htmlEscape(s.source_domain)}</code></td>` +
        `<td>${htmlEscape(s.attributed_to)}</td><td>${s.competitor_name ? htmlEscape(s.competitor_name) : '–'}</td>` +
        `<td>${fmtInt(n(s.citation_count))}</td><td>${fmtInt(n(s.query_count))}</td></tr>`,
    )
    .join('');
  const sourceMapSection =
    (data.sourceMap ?? []).length === 0
      ? '<p class="empty">No cited sources yet.</p>'
      : `<table><thead><tr><th>Source domain</th><th>Attribution</th><th>Competitor</th><th>Citations (4w)</th><th>Queries</th></tr></thead><tbody>${sourceRows}</tbody></table>`;

  const gapRows = (data.gaps ?? [])
    .map(
      (g) =>
        `<tr><td><code>${htmlEscape(g.query_id)}</code></td><td>${htmlEscape(g.query_tier ?? 'niche')}</td>` +
        `<td>${g.sov == null ? '0.000' : n(g.sov).toFixed(3)}</td>` +
        `<td>${g.top_competitor ? htmlEscape(g.top_competitor) : '–'}${g.top_competitor_domain ? ` @ <code>${htmlEscape(g.top_competitor_domain)}</code>` : ''}</td>` +
        `<td>${g.injected_at ? `✅ ${htmlEscape(g.injected_at)}` : 'pending'}</td>` +
        `<td>${g.recommended_action ? htmlEscape(g.recommended_action) : ''}</td></tr>`,
    )
    .join('');
  const gapsSection =
    (data.gaps ?? []).length === 0
      ? '<p class="empty">No content gaps computed yet.</p>'
      : `<table><thead><tr><th>Query</th><th>Tier</th><th>SoV</th><th>Top competitor</th><th>Injected</th><th>Recommended action</th></tr></thead><tbody>${gapRows}</tbody></table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GEO Weekly Probe — AlgoVault Admin</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1f2937; background: #f9fafb; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.9rem; background: #fff; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e5e7eb; }
  th { background: #f3f4f6; font-weight: 600; }
  code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
  .spark { font-family: monospace; font-size: 1.1rem; letter-spacing: 1px; color: #2563eb; }
  .empty { color: #6b7280; font-style: italic; }
  .warn { color: #b45309; font-weight: 600; }
  .banner { background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; padding: 0.75rem 1rem; border-radius: 6px; margin: 1rem 0; }
  .meta { color: #6b7280; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>GEO Weekly Probe — AlgoVault Admin</h1>
<p class="meta">Measures whether LLMs recommend AlgoVault when asked about crypto trading agents, signal APIs, and AI-native quant tooling. Probes fire every Monday 08:00 UTC across retrieval engines (Claude web_search + Perplexity Sonar), N≥3 samples/query, denoised at read time. ChatGPT-search (W3) + Gemini-grounding (W4) drop in as adapters.</p>

${wowBanner}

<h2>1. Weekly mention-rate trend (per model)</h2>
${weeklySection}

<h2>2. Per-query mention rate (last 4 weeks, sorted ASC — gap analysis)</h2>
${perQuerySection}

<h2>3. Top co-mentioned competitors (last 4 weeks)</h2>
${competitorSection}

<h2>4. Latest run</h2>
${runSection}

<h2>5. Per-engine mention + citation rate + SoV (retrieval engines)</h2>
${enginesSection}

<h2>6. Tiered breakdown (head / niche / branded)</h2>
${tieredSection}

<h2>7. Source-citation map — top cited domains (4w; competitor rows highlighted)</h2>
${sourceMapSection}

<h2>8. Content-gap list (→ editorial-calendar via geo-gap injector, veto-gated)</h2>
${gapsSection}

<p class="meta">Edit the canonical 15-query SoT at <code>landing/Prompt/geo-queries.yaml</code> — orchestrator loads at runtime. Add queries (with a <code>tier</code>) without code change. Engines via <code>GEO_ENGINES</code> (claude-web,perplexity); samples via <code>GEO_SAMPLES_PER_QUERY</code>.</p>
</body>
</html>`;
}
