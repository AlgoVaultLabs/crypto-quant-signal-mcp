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
import { runWeeklyProbe, resolveGeoProbe } from '../lib/geo-orchestrator.js';
import { dbQuery } from '../lib/performance-db.js';
import { sendAlert, sendDigest } from '../lib/telegram.js';
import { WOW_DROP_SQL, WEEKLY_CITED_3W_SQL } from '../lib/geo-dashboard.js';
import { isSignificantDecline, resolveAlertHygiene, type SignificanceVerdict } from '../lib/geo-alert-hygiene.js';
// OPS-GEO-PROBE-MULTI-RUN-W1 — the ONE shared per-(query,engine) rate+CI source (single-derivation).
// GEO-TARGET-DIGEST-REDESIGN-W1 — + rollupByQuery (our-action trend) + computeAttributionRates (full-funnel Δ).
import { getQueryRates, rollupByEngine, rollupByQuery, computeAttributionRates, type AttributionAgg } from '../lib/geo-rates.js';
import {
  buildDigest,
  shortEngine,
  computeIndexPresence,
  type GeoDigestData,
  type DecisionHandoff,
  type AttributionGap,
  type EnginePlacement,
  type IndexPresenceRow,
  type BySourceData,
  type BySourceRow,
  type OurActionRow,
  type RankedCandidateBrief,
} from '../lib/geo-digest.js';
// GEO-AUTOPILOT-W1 (C3) — DECIDE wiring: scorer + eligibility + decision ledger.
import { computeGapList } from '../lib/geo-gap-list.js';
import { scoreWeek, renderDecisionBrief, loadObjective, type GapLike, type RankedDecision } from '../lib/geo-decide.js';
import { buildEligibilityReport, type CitationRow } from '../lib/geo-eligibility.js';
import { isOwnHost } from '../lib/geo-extractor.js';
import { recordGeoDecision } from '../lib/geo-storage.js';

const TIER_DISPLAY: Record<string, string> = {
  eligibility: 'ELIGIBILITY',
  third_party: 'THIRD-PARTY',
  owned_content: 'OWNED-CONTENT',
};

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

// ── OPS-WEEKLY-GROWTH-DIGEST-W1: acquisition by source (folded) ────────────────
// Reads the connection-layer `mcp_connect` funnel_events (ATTRIBUTION-CONNECTION-
// SRC-W1) directly (in-container prod PG). WoW from two time-windows (no state
// file — the DB is the SoT). first_call/conversion reuse the agent_sessions
// definitions of the canonical funnel first_call/paid_upgrade stages
// (single-derivation). meta_json is TEXT → `::jsonb` cast (mcp_connect meta is
// always valid JSON; `meta_json IS NOT NULL` guards a malformed row from
// erroring the weekly digest).
const BY_SOURCE_WOW_SQL = `
  SELECT
    fe.meta_json::jsonb->>'source' AS source,
    COUNT(DISTINCT fe.session_id) FILTER (WHERE fe.ts > now() - interval '1 week') AS connects_this,
    COUNT(DISTINCT fe.session_id) FILTER (WHERE fe.ts <= now() - interval '1 week' AND fe.ts > now() - interval '2 weeks') AS connects_last,
    COUNT(DISTINCT fe.session_id) FILTER (WHERE fe.ts > now() - interval '1 week' AND a.session_id IS NOT NULL) AS first_call_this,
    COUNT(DISTINCT fe.session_id) FILTER (WHERE fe.ts > now() - interval '1 week' AND (a.tiers_seen LIKE '%starter%' OR a.tiers_seen LIKE '%pro%' OR a.tiers_seen LIKE '%enterprise%' OR a.tiers_seen LIKE '%x402%')) AS conversion_this
  FROM funnel_events fe
  LEFT JOIN agent_sessions a ON a.session_id = fe.session_id
  WHERE fe.event_type = 'mcp_connect' AND fe.ts > now() - interval '2 weeks' AND fe.meta_json IS NOT NULL
  GROUP BY 1
  ORDER BY connects_this DESC`;

/**
 * Acquisition by source for the digest. Fail-soft: any error returns an empty
 * (collecting) BySourceData so the GEO digest still sends.
 */
async function fetchBySource(): Promise<BySourceData> {
  try {
    const rows = await dbQuery<{
      source: string | null;
      connects_this: string | number;
      connects_last: string | number;
      first_call_this: string | number;
      conversion_this: string | number;
    }>(BY_SOURCE_WOW_SQL, []);
    const all: BySourceRow[] = rows.map((r) => ({
      source: r.source ?? 'unknown',
      connects: num(r.connects_this),
      connectsLastWeek: num(r.connects_last),
      firstCall: num(r.first_call_this),
      conversion: num(r.conversion_this),
    }));
    const totalConnectsThisWeek = all.reduce((s, r) => s + r.connects, 0);
    const totalConnectsLastWeek = all.reduce((s, r) => s + r.connectsLastWeek, 0);
    if (totalConnectsThisWeek === 0) {
      return { rows: [], totalConnectsThisWeek, totalConnectsLastWeek, topMover: null, topConverter: null };
    }
    // top 5 by connects (this week), deterministic tiebreak.
    const top = [...all].sort((a, b) => b.connects - a.connects || a.source.localeCompare(b.source)).slice(0, 5);
    // A4: best CONVERTER (value, not volume) — most paid, tiebreak by conversion-rate.
    const converters = all
      .filter((r) => r.conversion > 0)
      .sort(
        (a, b) =>
          b.conversion - a.conversion ||
          b.conversion / Math.max(1, b.connects) - a.conversion / Math.max(1, a.connects),
      );
    const topConverter = converters.length
      ? { source: converters[0].source, conversion: converters[0].conversion, connects: converters[0].connects }
      : null;
    // biggest WoW connect mover (absolute delta).
    const movers = all
      .filter((r) => r.connects !== r.connectsLastWeek)
      .sort((a, b) => Math.abs(b.connects - b.connectsLastWeek) - Math.abs(a.connects - a.connectsLastWeek));
    const topMover = movers.length
      ? { source: movers[0].source, from: movers[0].connectsLastWeek, to: movers[0].connects }
      : null;
    return { rows: top, totalConnectsThisWeek, totalConnectsLastWeek, topMover, topConverter };
  } catch (err) {
    console.error('[geo-cron] by_source fetch failed (digest continues):', err instanceof Error ? err.message : err);
    return { rows: [], totalConnectsThisWeek: 0, totalConnectsLastWeek: 0, topMover: null, topConverter: null };
  }
}

/**
 * Fetch every read-only aggregate the digest needs (no writes) and assemble a
 * GeoDigestData. Returns the data + the raw WoW rows (drive the preserved sendAlert)
 * + the full scored decision + rendered brief (the live path persists them).
 */
async function fetchDigestData(): Promise<{
  data: GeoDigestData;
  wowAlerts: WowRow[];
  ranked: RankedDecision;
  brief: string;
  decline: SignificanceVerdict;
}> {
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
     FROM geo_mentions
     WHERE retrieval = true AND ran_at > now() - interval '2 weeks'
       AND query_tier IS DISTINCT FROM 'presence'`,
    [],
  );
  const dr = deltaRows[0] ?? {};

  // OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — 3-week cited-answer history, MOST-RECENT-FIRST,
  // feeding the significance gate (shared SQL with the dashboard so both derive from the
  // same history). w0 == cit_this above by construction (identical window predicate).
  const citedHistRows = await dbQuery<{ w0: string | number; w1: string | number; w2: string | number }>(WEEKLY_CITED_3W_SQL, []);
  const chr = citedHistRows[0] ?? {};
  const weeklyCitations = [num(chr.w0), num(chr.w1), num(chr.w2)];

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

  // OPS-GEO-PROBE-MULTI-RUN-W1 — per-engine mention/cited RATE + 95% Wilson CI + low_confidence
  // from the ONE shared getQueryRates (rollupByEngine over this week's K samples). REPLACES the
  // old inline per-model `FILTER (WHERE cited)/count(*)` rate re-derivation — single-derivation:
  // the digest's per-engine "cited X/K = R% [CI]" line AND the scorer's SoV (computeGapList) both
  // project from getQueryRates, so they can never drift.
  // GEO-TARGET-DIGEST-REDESIGN-W1 — load the objective ONCE (probe cfg + target_set classification).
  const objective = loadObjective();
  const targetSet = objective.target_set ?? {};
  // Target queries = Tier A/B/contested (exclude the measure_only presence probe + any unclassified).
  const targetIds = Object.keys(targetSet).filter((id) => targetSet[id].tier !== 'measure_only');
  const targetIdSet = new Set(targetIds);
  const probeCfg = resolveGeoProbe(objective.probe);
  // ONE this-week read → per-ENGINE (the digest "cited X/K" line) AND per-QUERY (our-action trend)
  // rollups both project from it — single-derivation, no inline per-query rate.
  const weekRates = await getQueryRates(1, probeCfg.lowConfidenceMinSamples);
  const engineRates = rollupByEngine(weekRates, probeCfg.lowConfidenceMinSamples);
  const queryRateById = new Map(
    rollupByQuery(weekRates, probeCfg.lowConfidenceMinSamples).map((q) => [q.query_id, q]),
  );

  // GEO-TARGET-DIGEST-REDESIGN-W1 (a) — full-funnel attribution: per acted-on TARGET query ≥7d old,
  // the before/after aggregates (runs/cited/mention/sov, retrieval + non-presence only) → rate Δ+CI via
  // the shared computeAttributionRates. LEFT JOIN keeps a zero-post-data gap visible (renders too-early).
  const attrRows = await dbQuery<{
    query_id: string;
    recommended_action: string | null;
    injected_at: string;
    days_since_injected: string | number;
    post_data_days: string | number;
    runs_before: string | number;
    cited_before: string | number;
    mention_before: string | number;
    sov_before: string | number | null;
    runs_after: string | number;
    cited_after: string | number;
    mention_after: string | number;
    sov_after: string | number | null;
  }>(
    `SELECT g.query_id, g.recommended_action,
            to_char(g.injected_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS injected_at,
            EXTRACT(EPOCH FROM (now() - g.injected_at)) / 86400 AS days_since_injected,
            COALESCE(EXTRACT(EPOCH FROM (max(m.ran_at) FILTER (WHERE m.ran_at >= g.injected_at) - g.injected_at)) / 86400, 0) AS post_data_days,
            count(*) FILTER (WHERE m.ran_at < g.injected_at) AS runs_before,
            count(*) FILTER (WHERE m.ran_at < g.injected_at AND m.cited) AS cited_before,
            count(*) FILTER (WHERE m.ran_at < g.injected_at AND m.mention_found) AS mention_before,
            AVG(m.share_of_voice) FILTER (WHERE m.ran_at < g.injected_at) AS sov_before,
            count(*) FILTER (WHERE m.ran_at >= g.injected_at) AS runs_after,
            count(*) FILTER (WHERE m.ran_at >= g.injected_at AND m.cited) AS cited_after,
            count(*) FILTER (WHERE m.ran_at >= g.injected_at AND m.mention_found) AS mention_after,
            AVG(m.share_of_voice) FILTER (WHERE m.ran_at >= g.injected_at) AS sov_after
     FROM geo_content_gaps g
     LEFT JOIN geo_mentions m
       ON m.query_id = g.query_id AND m.retrieval = true AND m.query_tier IS DISTINCT FROM 'presence'
     WHERE g.injected_at IS NOT NULL AND g.injected_at < now() - interval '7 days'
       AND g.query_id = ANY($1::text[])
     GROUP BY g.query_id, g.recommended_action, g.injected_at
     ORDER BY g.injected_at DESC LIMIT 5`,
    [targetIds],
  );
  // Rate Δ + Wilson CI via the SHARED computeAttributionRates (reuses the wilsonInterval behind getQueryRates).
  const attrRateById = new Map(
    computeAttributionRates(
      attrRows.map(
        (r): AttributionAgg => ({
          query_id: r.query_id,
          runs_before: r.runs_before,
          cited_before: r.cited_before,
          mention_before: r.mention_before,
          sov_before: r.sov_before,
          runs_after: r.runs_after,
          cited_after: r.cited_after,
          mention_after: r.mention_after,
          sov_after: r.sov_after,
        }),
      ),
      probeCfg.lowConfidenceMinSamples,
    ).map((a) => [a.query_id, a]),
  );
  const attributionGaps: AttributionGap[] = attrRows.map((r) => ({
    query_id: r.query_id,
    tier: targetSet[r.query_id]?.tier,
    recommended_action: r.recommended_action,
    injected_at: r.injected_at,
    days_since_injected: num(r.days_since_injected),
    post_data_days: num(r.post_data_days),
    rate: attrRateById.get(r.query_id)!,
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
    // (b) target-only: drop dropped-misfit + non-target historical rows (no more vectorbt every week).
    if (!targetIdSet.has(r.query_id)) continue;
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
        AND query_tier IS DISTINCT FROM 'presence'
        AND query_id = ANY($1::text[])
        AND query_id NOT IN (
          SELECT query_id FROM geo_source_citations
           WHERE attributed_to IN ('algovault', 'competitor') AND ran_at > now() - interval '4 weeks')
      ORDER BY query_id LIMIT 1`,
    [targetIds],
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

  // R5 — index presence: per-engine "did the substrate retrieve algovault.com?" for
  // the presence-tier query this week (majority of samples). EXCLUDED from every
  // authority aggregate above (it self-mentions the domain). Empty until first probe.
  const presenceRows = await dbQuery<{ model: string; present: boolean | string | null }>(
    `SELECT model,
            (count(*) FILTER (WHERE mention_found) * 2 >= count(*)) AS present
     FROM geo_mentions
     WHERE retrieval = true AND query_tier = 'presence'
       AND ran_at > now() - interval '1 week'
     GROUP BY model ORDER BY model`,
    [],
  );
  const indexPresence = computeIndexPresence(
    presenceRows.map((r): IndexPresenceRow => ({
      model: r.model,
      present: r.present === true || r.present === 't' || r.present === 'true',
    })),
  );

  const wowDropSummary = wowAlerts
    .map((a) => `${shortEngine(a.model)} -${num(a.drop_pct).toFixed(0)}%`)
    .join(', ');

  // ── GEO-AUTOPILOT-W1 (C3): the scored DECIDE handoff (read-only; replaces ONE MOVE) ──
  // computeGapList + citations + index-presence → priority-gated scoreWeek → brief.
  // (`objective`/`targetSet`/`targetIds` were loaded ONCE at the top — GEO-TARGET-DIGEST-REDESIGN-W1.)
  // OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — the ONE gate verdict; drives the digest SLIPPING
  // verdict (via momentumDeltas below), the dashboard banner, and the TG WARNING in main().
  const alertHygiene = resolveAlertHygiene(objective.alert_hygiene);
  const decline = isSignificantDecline(weeklyCitations, alertHygiene);
  const gapBriefs = await computeGapList(4);
  const seenQ = new Set<string>();
  const gaps: GapLike[] = [];
  for (const b of gapBriefs) {
    if (seenQ.has(b.query_id)) continue; // rank_score desc → first per query_id is its worst gap
    seenQ.add(b.query_id);
    gaps.push({
      query_id: b.query_id,
      query_tier: b.query_tier,
      sov: b.sov,
      top_competitor: b.top_competitor,
      top_competitor_domain: b.top_competitor_domain,
    });
  }
  const citeRows = await dbQuery<{ source_domain: string; attributed_to: string | null; cites: string | number }>(
    `SELECT source_domain, attributed_to, count(*) AS cites
       FROM geo_source_citations WHERE ran_at > now() - interval '4 weeks'
      GROUP BY source_domain, attributed_to`,
    [],
  );
  const citations: CitationRow[] = citeRows.map((r) => ({
    source_domain: r.source_domain,
    attributed_to: r.attributed_to,
    cites: num(r.cites),
  }));
  const eligibilityReport = buildEligibilityReport(indexPresence, citations);
  // GSC-AUTHORITATIVE index status (objective.eligibility), NOT the LLM presence probe.
  // notIndexed = engines whose substrate is absent from indexed_substrates (a REAL re-crawl
  // block). The presence-probe misses are CITATION gaps (indexed ✓ but un-retrieved) — an
  // authority/content problem routed to third_party/owned, never an eligibility block.
  // (Corrected 2026-06-16: GSC confirms algovault.com indexed on all substrates; the
  // "gemini not indexed" signal was a stale site:-cache of the old parking snapshot.)
  const indexedSubstrates = objective.eligibility?.indexed_substrates ?? ['Bing', 'Brave', 'Google', 'own'];
  const notIndexed = eligibilityReport.engines
    .filter((e) => e.substrate && !indexedSubstrates.includes(e.substrate))
    .map((e) => e.engine);
  const citationGapEngines = indexPresence.missing; // indexed ✓ but un-retrieved → authority gap
  const ranked = scoreWeek({ eligibility: { notIndexed }, gaps }, objective);
  const brief = renderDecisionBrief(ranked, gaps, dateLabel());
  let handoff: DecisionHandoff | null = null;
  if (ranked.chosen && ranked.priority_tier) {
    const tier = ranked.priority_tier;
    const idx = objective.priority_gate.indexOf(tier) + 1;
    handoff = {
      priorityTier: tier,
      gateLabel: `${TIER_DISPLAY[tier] ?? tier} (gate ${idx}/${objective.priority_gate.length})`,
      move: ranked.chosen.label,
      knownActionSpec: ranked.chosen.known_action_spec,
      candidateCount: ranked.ranked.length,
      briefName: `geo-decision-${new Date().toISOString().slice(0, 10)}`,
      suspects: eligibilityReport.suspects.map((s) => s.domain),
      // GEO-TARGET-DIGEST-REDESIGN-W1 (d) — decision BASIS: top-5 ranked candidates (the SAME array
      // persisted below to geo_decisions.ranked_candidates) so the chosen move is auditable.
      rankedCandidates: ranked.ranked.slice(0, 5).map(
        (c): RankedCandidateBrief => ({
          query_id: c.query_id ?? c.engine ?? null,
          query_tier: c.query_tier ?? null,
          target_tier: c.query_id ? targetSet[c.query_id]?.tier : undefined,
          move: c.move ?? (c.engine ? `unblock ${c.engine}` : '—'),
          expected_lift: c.expected_lift,
          product_fit: c.product_fit,
          score: c.score,
        }),
      ),
    };
  }

  // GEO-TARGET-DIGEST-REDESIGN-W1 (c) — per-target-query OUR ACTION rows. posted = latest injected_at;
  // in-flight = a gap computed this cycle but not yet injected; none = neither. Trend = the per-query
  // pooled rate (single-derivation with the digest's rate line).
  const postedRows = await dbQuery<{ query_id: string; posted_date: string | null }>(
    `SELECT query_id, to_char(max(injected_at) FILTER (WHERE injected_at IS NOT NULL), 'YYYY-MM-DD') AS posted_date
       FROM geo_content_gaps WHERE query_id = ANY($1::text[]) GROUP BY query_id`,
    [targetIds],
  );
  const postedById = new Map(postedRows.map((r) => [r.query_id, r.posted_date]));
  const gapQueryIds = new Set(gaps.map((g) => g.query_id));
  const ourAction: OurActionRow[] = targetIds.map((qid) => {
    const posted = postedById.get(qid) ?? null;
    const status: OurActionRow['status'] = posted ? 'posted' : gapQueryIds.has(qid) ? 'in_flight' : 'none';
    const qr = queryRateById.get(qid);
    return {
      query_id: qid,
      tier: targetSet[qid]?.tier,
      status,
      posted_date: posted,
      mention_rate_pct: qr ? qr.mention_rate * 100 : 0,
      cited_rate_pct: qr ? qr.cited_rate * 100 : 0,
      low_confidence: qr ? qr.low_confidence : true,
    };
  });

  const bySource = await fetchBySource();

  const data: GeoDigestData = {
    dateLabel: dateLabel(),
    dashboardUrl: DASHBOARD_URL,
    momentumDeltas: {
      citationsThisWeek: num(dr.cit_this),
      citationsLastWeek: num(dr.cit_last),
      // Single-derivation with the look-alike watch: only genuinely-OWN hosts count as
      // "trusted", never the (frozen pre-fix-polluted) attributed_to='algovault' column —
      // so look-alikes flagged SUSPECT in the handoff can't also show as "trusted ✅" here.
      newTrustedDomains: newDomainRows.map((r) => r.source_domain).filter(isOwnHost),
      sovThisWeek: num(dr.sov_this),
      sovLastWeek: num(dr.sov_last),
      mentionRateThisWeek: num(dr.mention_this),
      mentionRateLastWeek: num(dr.mention_last),
      wowDropCount: wowAlerts.length,
      wowDropSummary,
      // OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — significance-gate inputs (single shared gate).
      weeklyCitations,
      alertHygiene,
    },
    perEngineMention: engineRates.map((e) => ({
      model: e.model,
      mention_rate_pct: e.mention_rate * 100,
      cited_rate_pct: e.cited_rate * 100,
      cited_count: e.cited_count,
      total_runs: e.total_runs,
      cited_rate_lo_pct: e.cited_rate_lo * 100,
      cited_rate_hi_pct: e.cited_rate_hi * 100,
      low_confidence: e.low_confidence,
    })),
    attributionGaps,
    contested,
    topGap: topGapRows[0] ?? null,
    indexPresence,
    eligibilityNotIndexed: notIndexed,
    citationGapEngines,
    decision: handoff,
    bySource,
    // GEO-TARGET-DIGEST-REDESIGN-W1 — (e) Tier-A/B badges + (c) per-query our-action section.
    targetSet,
    ourAction,
  };

  return { data, wowAlerts, ranked, brief, decline };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // OPS-WEEKLY-GROWTH-DIGEST-W1 — operator preview: build from existing DB state
  // (NO LLM probe, NO geo_decisions write) and send ONE labelled preview to the
  // operator chat via the SAME sendDigest path the live cron uses, so Mr.1 sees
  // the real TG-rendered Monday message (incl. the folded ACQUISITION section)
  // before the Mon 08:00 cron fires.
  const previewSend = process.argv.includes('--preview-send');

  if (dryRun || previewSend) {
    const mode = previewSend ? 'PREVIEW-SEND' : 'DRY RUN';
    console.log(
      `[geo-cron] ${mode} — building digest from existing DB state; no LLM probe, no DB writes` +
        (previewSend ? '; sending ONE labelled preview to the operator chat' : ', no Telegram'),
    );
    const { data, wowAlerts, decline } = await fetchDigestData();
    const lines = buildDigest(data);
    if (previewSend) {
      const ok = await sendDigest([
        '🧪 *PREVIEW — Growth digest (OPS-WEEKLY-GROWTH-DIGEST-W1)*',
        '_dry-run preview; the live cron sends this every Mon 08:00 UTC_',
        ...lines,
      ]);
      console.log(`[geo-cron] PREVIEW-SEND ${ok ? 'delivered to operator chat' : 'FAILED (telegram unconfigured?)'}`);
    } else {
      console.log('---DIGEST BODY---');
      console.log(lines.join('\n'));
      console.log('---END---');
    }
    console.log(
      `[geo-cron] ${mode} complete · raw_wow_dips=${wowAlerts.length} · gate=${decline.slipping ? '🔴 SLIPPING' : '🟡 HOLDING'} (${decline.reason}) · TG_WARNING=${decline.slipping ? 'WOULD FIRE' : 'suppressed'}`,
    );
    return;
  }

  console.log('[geo-cron] starting weekly multi-engine probe');
  // OPS-GEO-PROBE-MULTI-RUN-W1 — K (per-engine), engine concurrency, and per-engine pacing
  // come from the objective SoT `probe:` block (resolved in the orchestrator). Tuning = edit yaml.
  const { probe } = loadObjective();
  const { runId, resultCount, errorCount, engineIds } = await runWeeklyProbe({ probe });
  console.log(
    `[geo-cron] run ${runId} complete: engines=[${engineIds.join(',')}] rows=${resultCount} errors=${errorCount}`,
  );

  const { data, wowAlerts, ranked, brief, decline } = await fetchDigestData();
  const lines = buildDigest(data);

  await sendDigest(lines);
  console.log(`[geo-cron] digest sent · sections=${lines.length}`);

  // GEO-AUTOPILOT-W1 (C3) — persist the weekly DECIDE row (status='proposed'); the
  // dashboard renders it + Cowork materializes the brief from it. NO completion TG.
  await recordGeoDecision({
    run_id: runId,
    priority_tier: ranked.priority_tier,
    ranked_candidates: ranked.ranked,
    rendered_brief: brief,
    chosen_move: ranked.chosen?.label ?? null,
  });
  console.log(`[geo-cron] decision persisted · tier=${ranked.priority_tier ?? 'none'} · candidates=${ranked.ranked.length}`);

  // OPS-GEO-PROBE-SIGNIFICANCE-GATE-W1 — the WoW WARNING (operator-action) fires ONLY on a
  // sustained, significant citation decline (the single shared gate — same verdict as the
  // digest header + dashboard banner), never on a single noisy week. Raw per-engine dips are
  // supporting detail, not the trigger; honors the "fire on sustained drift" alert contract.
  if (decline.slipping) {
    const summary = wowAlerts.map((a) => `${a.model} -${num(a.drop_pct).toFixed(1)}%`).join(', ');
    await sendAlert(
      `GEO weekly probe — ${decline.reason}${summary ? `; per-engine dips: ${summary}` : ''} (see digest above for details)`,
      'warning',
    );
    console.log(`[geo-cron] WoW WARNING alert sent · ${decline.reason}`);
  } else {
    console.log(`[geo-cron] no WoW WARNING (gate HOLDING: ${decline.reason}) · raw_wow_dips=${wowAlerts.length}`);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[geo-cron] fatal:', msg);
  sendAlert(`GEO weekly cron failed: ${msg}`, 'critical').catch(() => {});
  process.exit(1);
});
