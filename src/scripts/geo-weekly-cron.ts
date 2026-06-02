/**
 * GEO-MEASUREMENT-W1 (C2, 2026-05-19) — weekly probe entry point.
 *
 * Cron: Mon 08:00 UTC (set via Hetzner crontab self-provision, see status.md).
 * Loads canonical query YAML, runs all 15 queries through Claude Haiku 4.5,
 * extracts mentions, persists, sends Telegram digest. WoW mention-rate drop
 * >20% fires an additional sendAlert(warning) on top of the digest.
 *
 * `--dry-run` flag prints a digest body from existing DB state without
 * invoking LLM / DB writes / Telegram.
 */
import { runWeeklyProbe } from '../lib/geo-orchestrator.js';
import { dbQuery } from '../lib/performance-db.js';
import { sendAlert, sendDigest } from '../lib/telegram.js';
import { WOW_DROP_SQL } from '../lib/geo-dashboard.js';

const DASHBOARD_URL = 'https://api.algovault.com/admin/geo-dashboard';

interface SummaryRow {
  model: string;
  query_count: string | number;
  mention_count: string | number;
  mention_rate_pct: string | number | null;
  avg_position: string | number | null;
}

interface WowRow {
  model: string;
  this_week: string | number;
  last_week: string | number;
  drop_pct: string | number;
}

interface GapRow {
  query_id: string;
  mention_rate_pct: string | number | null;
}

interface EngineStatRow {
  model: string;
  mention_rate_pct: string | number | null;
  cited_rate_pct: string | number | null;
  avg_sov: string | number | null;
}

interface TopGapRow {
  query_id: string;
  query_tier: string | null;
  model: string;
  sov: string | number | null;
  top_competitor: string | null;
  top_competitor_domain: string | null;
  recommended_action: string | null;
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

async function buildDigestLines(runId: string, resultCount: number, errorCount: number): Promise<{ lines: string[]; wowAlerts: WowRow[] }> {
  const summary = await dbQuery<SummaryRow>(
    `SELECT model, query_count, mention_count, mention_rate_pct, avg_position
     FROM geo_weekly_summary
     WHERE week_utc = date_trunc('week', now() AT TIME ZONE 'UTC')
     ORDER BY model`,
    [],
  );

  const wowAlerts = await dbQuery<WowRow>(WOW_DROP_SQL, []);

  const topGapQueries = await dbQuery<GapRow>(
    `SELECT query_id,
            ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct
     FROM geo_mentions
     WHERE ran_at > now() - interval '4 weeks'
     GROUP BY query_id
     ORDER BY mention_rate_pct ASC NULLS FIRST, query_id
     LIMIT 5`,
    [],
  );

  // GEO-MEASUREMENT-W2: per-engine citation + share-of-voice (retrieval rows, this week).
  const engineStats = await dbQuery<EngineStatRow>(
    `SELECT model,
            ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct,
            ROUND(100.0 * count(*) FILTER (WHERE cited) / NULLIF(count(*), 0), 1) AS cited_rate_pct,
            ROUND(AVG(share_of_voice)::numeric, 3) AS avg_sov
     FROM geo_mentions
     WHERE retrieval = true AND ran_at > now() - interval '1 week'
     GROUP BY model
     ORDER BY model`,
    [],
  );

  // GEO-MEASUREMENT-W2: the single top content-gap brief (latest computed).
  const topGap = await dbQuery<TopGapRow>(
    `SELECT query_id, query_tier, model, sov, top_competitor, top_competitor_domain, recommended_action
     FROM geo_content_gaps
     ORDER BY computed_at DESC, rank_score DESC
     LIMIT 1`,
    [],
  );

  const lines: string[] = [];
  lines.push(`📊 *GEO Weekly Probe — Run ${runId.slice(0, 8)}*`);
  lines.push(`Queries: ${resultCount} · Errors: ${errorCount}`);
  lines.push('');
  lines.push('*This week mention rate (per model):*');
  if (summary.length === 0) {
    lines.push('· (no data this week)');
  } else {
    for (const r of summary) {
      lines.push(
        `· ${r.model}: ${num(r.mention_rate_pct).toFixed(1)}% (${num(r.mention_count)}/${num(r.query_count)}) · avg pos ${
          r.avg_position == null ? 'n/a' : num(r.avg_position).toFixed(1)
        }`,
      );
    }
  }

  if (wowAlerts.length > 0) {
    lines.push('');
    lines.push('⚠️ *WoW drop >20% detected:*');
    for (const a of wowAlerts) {
      lines.push(`· ${a.model}: -${num(a.drop_pct).toFixed(1)}% (this: ${num(a.this_week)} / last: ${num(a.last_week)})`);
    }
  }

  if (topGapQueries.length > 0) {
    lines.push('');
    lines.push('*Top 5 queries WITHOUT AlgoVault mention (last 4w):*');
    for (const q of topGapQueries) {
      lines.push(`· ${q.query_id} → ${q.mention_rate_pct == null ? '0.0' : num(q.mention_rate_pct).toFixed(1)}%`);
    }
  }

  if (engineStats.length > 0) {
    lines.push('');
    lines.push('*Per-engine citations + share-of-voice (retrieval, this week):*');
    for (const e of engineStats) {
      lines.push(
        `· ${e.model}: cited ${e.cited_rate_pct == null ? '0.0' : num(e.cited_rate_pct).toFixed(1)}% · SoV ${
          e.avg_sov == null ? '0.000' : num(e.avg_sov).toFixed(3)
        } · mention ${e.mention_rate_pct == null ? '0.0' : num(e.mention_rate_pct).toFixed(1)}%`,
      );
    }
  }

  if (topGap.length > 0) {
    const g = topGap[0];
    lines.push('');
    lines.push('*Top content gap (→ editorial-calendar via geo-gap injector):*');
    lines.push(`· ${g.recommended_action ?? `${g.query_id} (${g.query_tier ?? 'niche'})`}`);
  }

  lines.push('');
  lines.push(`👉 Dashboard: ${DASHBOARD_URL}?key=<admin-key>`);

  return { lines, wowAlerts };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('[geo-cron] DRY RUN — building digest body from existing DB state; no LLM calls, no DB writes, no Telegram');
    const { lines, wowAlerts } = await buildDigestLines('dry-run-fake-uuid', 0, 0);
    console.log('---DIGEST BODY---');
    console.log(lines.join('\n'));
    console.log('---END---');
    console.log(`[geo-cron] DRY RUN complete · wow_alerts=${wowAlerts.length}`);
    return;
  }

  console.log('[geo-cron] starting weekly multi-engine probe');
  const { runId, resultCount, errorCount, engineIds } = await runWeeklyProbe();
  console.log(
    `[geo-cron] run ${runId} complete: engines=[${engineIds.join(',')}] rows=${resultCount} errors=${errorCount}`,
  );

  const { lines, wowAlerts } = await buildDigestLines(runId, resultCount, errorCount);

  await sendDigest(lines);
  console.log(`[geo-cron] digest sent · sections=${lines.length}`);

  if (wowAlerts.length > 0) {
    const summary = wowAlerts
      .map((a) => `${a.model} -${num(a.drop_pct).toFixed(1)}%`)
      .join(', ');
    await sendAlert(
      `GEO weekly probe — WoW mention-rate drop >20% detected: ${summary} (see digest above for details)`,
      'warning',
    );
    console.log(`[geo-cron] WoW WARNING alert sent · models=${wowAlerts.length}`);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[geo-cron] fatal:', msg);
  // Fire-and-forget Telegram CRITICAL; ignore if Telegram itself fails
  sendAlert(`GEO weekly cron failed: ${msg}`, 'critical').catch(() => {});
  process.exit(1);
});
