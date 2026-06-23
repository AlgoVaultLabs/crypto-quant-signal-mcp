/**
 * GEO-MEASUREMENT-W2 (C4) — content-gap emitter.
 *
 * Closes the loop's MEASUREMENT half: turns the source-map + share-of-voice +
 * tiers into a ranked content-gap brief and persists the top item(s) to the
 * `geo_content_gaps` Postgres table — the cross-repo/cross-host HAND-OFF
 * boundary (architect Q-1-A). It does NOT write the editorial calendar and does
 * NOT send Telegram: the geo cron runs inside the MCP container, which cannot
 * reach /opt/algovault-editorial-content/. The host-side C6 reader
 * (algovault-editorial) reads this table, appends `Source: geo-gap` calendar
 * rows, and reuses the existing 12h-veto DM. Postgres is the boundary.
 *
 * Ranking: gap severity (1 - share_of_voice) × intent tier × competitor-cited-
 * on-a-trusted-domain. Idempotent + fail-open; ISO-week dedup + cap in the table.
 */
import { dbExec, dbRun, dbQuery } from './performance-db.js';
// Single product_fit SoT (OPS-GEO-GAP-INJECTOR-PRODUCT-FIT-W1): the write-side resolves product_fit
// via the SAME helper the scorer uses, so the persisted value is byte-identical to the scorer's.
import { loadObjective, productFitOf } from './geo-decide.js';

/**
 * The calendar "Source" column value the C6 host-side injector stamps on rows it
 * appends — i.e. the calendar row reads `Source: geo-gap`. Lives here (C4) as the
 * single source; C6 imports the concept. NOT written from this module.
 */
export const GAP_SOURCE_COLUMN_VALUE = 'geo-gap';

/** Default weekly injection cap (overridable via GEO_GAP_MAX_PER_WEEK). */
export const DEFAULT_GAP_MAX_PER_WEEK = 1;

/**
 * Intent-tier ranking weight — head (high-volume discovery) gaps rank highest.
 * This is the editorial-pipeline COVERAGE weight. It INTENTIONALLY diverges from
 * the autopilot expected-VALUE weight in landing/Prompt/geo-objective.yaml
 * (`revenue_proximity` = {head:1.0, branded:0.8, niche:0.6}, read by geo-decide.ts).
 * Two different jobs, two weights — not drift (GEO-AUTOPILOT-W1, architect 2026-06-16).
 */
export const TIER_WEIGHT: Record<string, number> = { head: 1.0, niche: 0.6, branded: 0.4 };

export interface GapBrief {
  query_id: string;
  query_tier: string;
  model: string;
  sov: number;
  top_competitor: string | null;
  top_competitor_domain: string | null;
  recommended_action: string;
  rank_score: number;
}

interface MentionAgg {
  query_id: string;
  query_tier: string | null;
  model: string;
  sov: string | number | null;
  samples: string | number;
}
interface CompetitorAgg {
  query_id: string;
  source_domain: string;
  competitor_name: string | null;
  cites: string | number;
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

/** ISO-8601 week label, e.g. '2026-W23' (UTC, Thursday-anchored). */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Idempotent DDL for the gap table — created lazily on first use (no index.ts wiring). */
export function ensureGeoGapSchema(): void {
  dbExec(`
    CREATE TABLE IF NOT EXISTS geo_content_gaps (
      id                    BIGSERIAL PRIMARY KEY,
      computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      iso_week              TEXT NOT NULL,
      query_id              TEXT NOT NULL,
      query_tier            TEXT,
      model                 TEXT,
      sov                   NUMERIC,
      top_competitor        TEXT,
      top_competitor_domain TEXT,
      recommended_action    TEXT,
      rank_score            NUMERIC,
      injected_at           TIMESTAMPTZ,
      product_fit           REAL,
      injectable            BOOLEAN,
      UNIQUE (iso_week, query_id)
    );
    CREATE INDEX IF NOT EXISTS idx_geo_content_gaps_uninjected
      ON geo_content_gaps (rank_score DESC) WHERE injected_at IS NULL;
  `);
  // Idempotent column add for pre-existing tables (CREATE TABLE IF NOT EXISTS won't alter them).
  // Mirrors the OPS-GEO-GAP-INJECTOR-PRODUCT-FIT-W1 SSH migration so a fresh deploy self-heals.
  dbExec(`ALTER TABLE geo_content_gaps ADD COLUMN IF NOT EXISTS product_fit REAL;`);
  dbExec(`ALTER TABLE geo_content_gaps ADD COLUMN IF NOT EXISTS injectable BOOLEAN;`);
}

/**
 * Rank every recently-probed query by gap severity × tier × competitor-on-
 * trusted-domain. Pure read; never throws (fail-open -> []).
 */
export async function computeGapList(windowWeeks = 4): Promise<GapBrief[]> {
  try {
    const mentions = await dbQuery<MentionAgg>(
      `SELECT query_id, max(query_tier) AS query_tier, model,
              AVG(share_of_voice) AS sov, count(*) AS samples
         FROM geo_mentions
        WHERE ran_at > now() - make_interval(weeks => $1) AND retrieval = true
          AND query_tier IS DISTINCT FROM 'presence'
        GROUP BY query_id, model`,
      [windowWeeks],
    );

    const competitors = await dbQuery<CompetitorAgg>(
      `SELECT query_id, source_domain, competitor_name, count(*) AS cites
         FROM geo_source_citations
        WHERE ran_at > now() - make_interval(weeks => $1) AND attributed_to = 'competitor'
        GROUP BY query_id, source_domain, competitor_name
        ORDER BY cites DESC`,
      [windowWeeks],
    );

    // First-seen per query_id == its highest-cited competitor (rows are cites-desc).
    const topComp = new Map<string, CompetitorAgg>();
    for (const c of competitors) if (!topComp.has(c.query_id)) topComp.set(c.query_id, c);

    const briefs: GapBrief[] = mentions.map((m) => {
      const tier = m.query_tier ?? 'niche';
      const sov = num(m.sov);
      const comp = topComp.get(m.query_id);
      const compCites = comp ? num(comp.cites) : 0;
      const tierWeight = TIER_WEIGHT[tier] ?? TIER_WEIGHT.niche;
      const competitorSignal = 1 + Math.min(1, compCites / 5);
      const rank_score = (1 - sov) * tierWeight * competitorSignal;

      const recommended_action = comp
        ? `${m.model} cites ${comp.competitor_name ?? 'a competitor'} via ${comp.source_domain} for "${m.query_id}" (SoV ${sov.toFixed(2)}) — target a placement/answer on ${comp.source_domain}`
        : `Low share-of-voice (${sov.toFixed(2)}) for "${m.query_id}" on ${m.model} — publish targeted ${tier}-tier content`;

      return {
        query_id: m.query_id,
        query_tier: tier,
        model: m.model,
        sov,
        top_competitor: comp?.competitor_name ?? null,
        top_competitor_domain: comp?.source_domain ?? null,
        recommended_action,
        rank_score,
      };
    });

    briefs.sort((a, b) => b.rank_score - a.rank_score);
    return briefs;
  } catch (err) {
    console.error(
      `[geo-gap-list] computeGapList failed (fail-open []): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Persist the top gap brief(s) for the current ISO week to geo_content_gaps —
 * the hand-off table C6 reads. Hard cap of `max` rows per ISO week + UNIQUE
 * (iso_week, query_id) dedup => a second call the same week is a no-op.
 * Fire-and-forget; never throws. Returns the briefs it persisted.
 */
export async function persistGapBriefs(
  briefs: GapBrief[],
  max: number = Number(process.env.GEO_GAP_MAX_PER_WEEK) || DEFAULT_GAP_MAX_PER_WEEK,
  now: Date = new Date(),
): Promise<GapBrief[]> {
  if (!briefs || briefs.length === 0) return [];
  const week = isoWeek(now);
  try {
    ensureGeoGapSchema();
    const existingRows = await dbQuery<{ n: string | number }>(
      `SELECT count(*) AS n FROM geo_content_gaps WHERE iso_week = $1`,
      [week],
    );
    const existing = num(existingRows[0]?.n);
    const remaining = Math.max(0, max - existing);
    if (remaining === 0) return []; // weekly cap reached -> no-op

    const toPersist = [...briefs].sort((a, b) => b.rank_score - a.rank_score).slice(0, remaining);
    // Resolve product_fit from the ONE objective SoT (same helper the scorer uses) + derive
    // injectable = product_fit >= inject_threshold. Misfit gaps are still WRITTEN (Data Integrity:
    // preserved for analytics) — just injectable=false so geo_gap_injector won't auto-publish them.
    const objective = loadObjective();
    const injectThreshold = objective.inject_threshold ?? 0.5;
    const persisted: GapBrief[] = [];
    for (const b of toPersist) {
      const productFit = productFitOf(objective, b.query_id);
      const injectable = productFit >= injectThreshold;
      dbRun(
        `INSERT INTO geo_content_gaps
           (iso_week, query_id, query_tier, model, sov, top_competitor, top_competitor_domain, recommended_action, rank_score, product_fit, injectable)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (iso_week, query_id) DO NOTHING`,
        week,
        b.query_id,
        b.query_tier,
        b.model,
        b.sov,
        b.top_competitor,
        b.top_competitor_domain,
        b.recommended_action,
        b.rank_score,
        productFit,
        injectable,
      );
      persisted.push(b);
    }
    console.log(`[geo-gap-list] persisted ${persisted.length} gap brief(s) for ${week} (cap ${max}, existing ${existing})`);
    return persisted;
  } catch (err) {
    console.error(
      `[geo-gap-list] persistGapBriefs failed (silent recovery): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
