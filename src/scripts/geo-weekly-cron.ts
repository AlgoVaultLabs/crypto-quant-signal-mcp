/**
 * GEO-MEASUREMENT-W1 (C2) — weekly probe entry point.
 * GEO-MEASUREMENT-W4 (2026-06-02): digest body extracted to the pure, testable
 * `src/lib/geo-digest.ts` (`buildDigest`); this cron is now thin — fetch the
 * read-only aggregates, build a `GeoDigestData`, `sendDigest(buildDigest(data))`.
 *
 * Cron: Mon 08:00 UTC. Sends a results-driving Telegram digest (momentum verdict
 * + attribution loop + one move). The PRESERVED WoW >20% mention-rate drop fires
 * the only additional `sendAlert(warning)` (operator-action). No other TG fire.
 *
 * `--dry-run` builds + prints the digest from existing DB state (no LLM / DB
 * writes / Telegram).
 */
import { runWeeklyProbe } from '../lib/geo-orchestrator.js';
import { dbQuery } from '../lib/performance-db.js';
import { sendAlert, sendDigest } from '../lib/telegram.js';
import { WOW_DROP_SQL } from '../lib/geo-dashboard.js';
import {
  buildDigest,
  shortEngine,
  type GeoDigestData,
  type AttributionGap,
  type EnginePlacement,
} from '../lib/geo-digest.js';

const DASHBOARD_URL = 'https://api.algovault.com/admin/geo-dashboard';

interface WowRow {
  model: string;
  this_week: string | number;
  last_week: string | number;
  drop_pct: string | number;
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

/** "Mon 9 Jun" from now() (UTC) — supplied to the pure builder so it stays Date-free. */
function dateLabel(): string {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Fetch every read-only aggregate the digest needs (no writes) and assemble a
 * GeoDigestData. Returns the data + the raw WoW rows (drive the preserved sendAlert).
 */
async function fetchDigestData(): Promise<{ data: GeoDigestData; wowAlerts: WowRow[] }> {
  const wowAlerts = await dbQuery<WowRow>(WOW_DROP_SQL, []);

  // WoW deltas (retrieval rows, this week vs last) in one pass.
  const deltaRows = await dbQuery<{
    cit_this: string | number;
    cit_last: string | number;
    sov_this: string | number | null;
    sov_last: string | number | null;
    mention_this: string | number | null;
    mention_last: string | number | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE cited AND ran_at > now() - interval '1 week') AS cit_this,
       count(*) FILTER (WHERE cited AND ran_at <= now() - interval '1 week' AND ran_at > now() - interval '2 weeks') AS cit_last,
       ROUND(AVG(share_of_voice) FILTER (WHERE ran_at > now() - interval '1 week')::numeric, 4) AS sov_this,
       ROUND(AVG(share_of_voice) FILTER (WHERE ran_at <= now() - interval '1 week' AND ran_at > now() - interval '2 weeks')::numeric, 4) AS sov_last,
       ROUND(100.0 * count(*) FILTER (WHERE mention_found AND ran_at > now() - interval '1 week')
             / NULLIF(count(*) FILTER (WHERE ran_at > now() - interval '1 week'), 0), 1) AS mention_this,
       ROUND(100.0 * count(*) FILTER (WHERE mention_found AND ran_at <= now() - interval '1 week' AND ran_at > now() - interval '2 weeks')
             / NULLIF(count(*) FILTER (WHERE ran_at <= now() - interval '1 week' AND ran_at > now() - interval '2 weeks'), 0), 1) AS mention_last
     FROM geo_mentions WHERE retrieval = true AND ran_at > now() - interval '2 weeks'`,
    [],
  );
  const dr = deltaRows[0] ?? {};

  // New trusted (algovault) domains this week not seen in the prior 4w.
  const newDomainRows = await dbQuery<{ source_domain: string }>(
    `SELECT DISTINCT source_domain FROM geo_source_citations
      WHERE attributed_to = 'algovault' AND ran_at > now() - interval '1 week'
        AND source_domain NOT IN (
          SELECT source_domain FROM geo_source_citations
           WHERE attributed_to = 'algovault'
             AND ran_at <= now() - interval '1 week' AND ran_at > now() - interval '5 weeks')`,
    [],
  );

  const perEngine = await dbQuery<{
    model: string;
    mention_rate_pct: string | number | null;
    cited_rate_pct: string | number | null;
  }>(
    `SELECT model,
            ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct,
            ROUND(100.0 * count(*) FILTER (WHERE cited) / NULLIF(count(*), 0), 1) AS cited_rate_pct
     FROM geo_mentions WHERE retrieval = true AND ran_at > now() - interval '1 week'
     GROUP BY model ORDER BY model`,
    [],
  );

  // Attribution: each injected gap >=7d old, before/after injected_at.
  const attrRows = await dbQuery<{
    query_id: string;
    recommended_action: string | null;
    injected_at: string;
    days_since_injected: string | number;
    post_data_days: string | number;
    cited_before: string | number;
    cited_after: string | number;
    mention_before: string | number;
    mention_after: string | number;
  }>(
    `SELECT g.query_id, g.recommended_action,
            to_char(g.injected_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS injected_at,
            EXTRACT(EPOCH FROM (now() - g.injected_at)) / 86400 AS days_since_injected,
            COALESCE(EXTRACT(EPOCH FROM (mx.max_ran - g.injected_at)) / 86400, 0) AS post_data_days,
            (SELECT count(*) FROM geo_mentions m WHERE m.query_id = g.query_id AND m.cited AND m.ran_at < g.injected_at) AS cited_before,
            (SELECT count(*) FROM geo_mentions m WHERE m.query_id = g.query_id AND m.cited AND m.ran_at >= g.injected_at) AS cited_after,
            (SELECT count(*) FROM geo_mentions m WHERE m.query_id = g.query_id AND m.mention_found AND m.ran_at < g.injected_at) AS mention_before,
            (SELECT count(*) FROM geo_mentions m WHERE m.query_id = g.query_id AND m.mention_found AND m.ran_at >= g.injected_at) AS mention_after
     FROM geo_content_gaps g
     LEFT JOIN LATERAL (SELECT max(ran_at) AS max_ran FROM geo_mentions m WHERE m.query_id = g.query_id AND m.ran_at >= g.injected_at) mx ON true
     WHERE g.injected_at IS NOT NULL AND g.injected_at < now() - interval '7 days'
     ORDER BY g.injected_at DESC LIMIT 5`,
    [],
  );
  const attributionGaps: AttributionGap[] = attrRows.map((r) => ({
    query_id: r.query_id,
    recommended_action: r.recommended_action,
    injected_at: r.injected_at,
    days_since_injected: num(r.days_since_injected),
    post_data_days: num(r.post_data_days),
    cited_before: num(r.cited_before),
    cited_after: num(r.cited_after),
    mention_before: num(r.mention_before),
    mention_after: num(r.mention_after),
  }));

  // WHO'S WINNING — competitor placements + OPEN queries.
  const compRows = await dbQuery<{ query_id: string; competitor_name: string | null; source_domain: string; cites: string | number }>(
    `SELECT query_id, competitor_name, source_domain, count(*) AS cites
     FROM geo_source_citations
     WHERE attributed_to = 'competitor' AND ran_at > now() - interval '4 weeks'
     GROUP BY query_id, competitor_name, source_domain
     ORDER BY count(*) DESC`,
    [],
  );
  const byQuery = new Map<string, { leaderCounts: Map<string, number>; domains: Map<string, number>; total: number }>();
  for (const r of compRows) {
    const q = byQuery.get(r.query_id) ?? { leaderCounts: new Map(), domains: new Map(), total: 0 };
    const comp = r.competitor_name ?? 'a competitor';
    q.leaderCounts.set(comp, (q.leaderCounts.get(comp) ?? 0) + num(r.cites));
    q.domains.set(r.source_domain, (q.domains.get(r.source_domain) ?? 0) + num(r.cites));
    q.total += num(r.cites);
    byQuery.set(r.query_id, q);
  }
  const withLeader: EnginePlacement[] = [...byQuery.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 2)
    .map(([query_id, q]) => ({
      query_id,
      leader: [...q.leaderCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      domains: [...q.domains.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d),
      citations: q.total,
    }));
  const openRows = await dbQuery<{ query_id: string }>(
    `SELECT DISTINCT query_id FROM geo_mentions
      WHERE retrieval = true AND ran_at > now() - interval '4 weeks'
        AND query_id NOT IN (
          SELECT query_id FROM geo_source_citations
           WHERE attributed_to IN ('algovault', 'competitor') AND ran_at > now() - interval '4 weeks')
      ORDER BY query_id LIMIT 1`,
    [],
  );
  const contested: EnginePlacement[] = [
    ...withLeader,
    ...openRows.map((r) => ({ query_id: r.query_id, leader: null, domains: [], citations: 0 })),
  ].slice(0, 3);

  // ONE MOVE — the single latest queued gap brief.
  const topGapRows = await dbQuery<{
    query_id: string;
    query_tier: string | null;
    recommended_action: string | null;
    top_competitor: string | null;
    top_competitor_domain: string | null;
  }>(
    `SELECT query_id, query_tier, recommended_action, top_competitor, top_competitor_domain
     FROM geo_content_gaps ORDER BY computed_at DESC, rank_score DESC LIMIT 1`,
    [],
  );

  const wowDropSummary = wowAlerts
    .map((a) => `${shortEngine(a.model)} -${num(a.drop_pct).toFixed(0)}%`)
    .join(', ');

  const data: GeoDigestData = {
    dateLabel: dateLabel(),
    dashboardUrl: DASHBOARD_URL,
    momentumDeltas: {
      citationsThisWeek: num(dr.cit_this),
      citationsLastWeek: num(dr.cit_last),
      newTrustedDomains: newDomainRows.map((r) => r.source_domain),
      sovThisWeek: num(dr.sov_this),
      sovLastWeek: num(dr.sov_last),
      mentionRateThisWeek: num(dr.mention_this),
      mentionRateLastWeek: num(dr.mention_last),
      wowDropCount: wowAlerts.length,
      wowDropSummary,
    },
    perEngineMention: perEngine.map((e) => ({
      model: e.model,
      mention_rate_pct: num(e.mention_rate_pct),
      cited_rate_pct: num(e.cited_rate_pct),
    })),
    attributionGaps,
    contested,
    topGap: topGapRows[0] ?? null,
  };

  return { data, wowAlerts };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('[geo-cron] DRY RUN — building digest from existing DB state; no LLM, no DB writes, no Telegram');
    const { data, wowAlerts } = await fetchDigestData();
    console.log('---DIGEST BODY---');
    console.log(buildDigest(data).join('\n'));
    console.log('---END---');
    console.log(`[geo-cron] DRY RUN complete · wow_alerts=${wowAlerts.length}`);
    return;
  }

  console.log('[geo-cron] starting weekly multi-engine probe');
  const { runId, resultCount, errorCount, engineIds } = await runWeeklyProbe();
  console.log(
    `[geo-cron] run ${runId} complete: engines=[${engineIds.join(',')}] rows=${resultCount} errors=${errorCount}`,
  );

  const { data, wowAlerts } = await fetchDigestData();
  const lines = buildDigest(data);

  await sendDigest(lines);
  console.log(`[geo-cron] digest sent · sections=${lines.length}`);

  // PRESERVED WoW operator-action alert (the only additional TG fire).
  if (wowAlerts.length > 0) {
    const summary = wowAlerts.map((a) => `${a.model} -${num(a.drop_pct).toFixed(1)}%`).join(', ');
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
  sendAlert(`GEO weekly cron failed: ${msg}`, 'critical').catch(() => {});
  process.exit(1);
});
