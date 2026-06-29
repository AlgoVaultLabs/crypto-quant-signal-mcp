/**
 * GEO-MEASUREMENT-W1 (C1) — Postgres storage for geo_query_runs + geo_mentions
 * + geo_weekly_summary view. Mirrors CHAT-USAGE-ANALYTICS-W1 schema-pattern:
 * `ensureGeoSchema()` is idempotent (CREATE IF NOT EXISTS / CREATE OR REPLACE
 * VIEW) and called from `src/index.ts` module-init.
 *
 * `recordGeoRun()` is fire-and-forget — never throws to the caller. Errors
 * land in console.error (per CLAUDE.md default-deny + load-bearing-logging
 * rule); the success path is implicit via the orchestrator's existing
 * per-query log.
 */
import { dbExec, dbRun } from './performance-db.js';
import type { GeoQueryResult } from './geo-orchestrator.js';
import type { GeoMentions, SourceCitation } from './geo-extractor.js';

/**
 * GEO-MEASUREMENT-W2 (C2) — per-run retrieval context that isn't part of the
 * extractor's `GeoMentions` (which is purely "what was in the answer"). Supplied
 * by the C5 orchestrator per (query, engine, sample). Optional + defaulted so
 * the W1 2-arg `recordGeoRun(result, mentions)` call keeps compiling.
 */
export interface GeoRunContext {
  retrieval?: boolean;
  query_tier?: string | null;
  sample_idx?: number;
}

export function ensureGeoSchema(): void {
  // SINGLE multi-statement dbExec — PgBackend.exec is fire-and-forget per
  // statement, so issuing N separate dbExec calls races (CREATE INDEX
  // referencing a not-yet-committed CREATE TABLE fails). Pg's pool.query()
  // processes a single multi-statement SQL string in order within ONE
  // backend session. Witnessed live in GEO-MEASUREMENT-W1 deploy:
  // 5 indexes + view all failed because they raced their CREATE TABLEs.
  dbExec(`
    CREATE TABLE IF NOT EXISTS geo_query_runs (
      id                BIGSERIAL PRIMARY KEY,
      run_id            UUID NOT NULL,
      ran_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      model             TEXT NOT NULL,
      query_id          TEXT NOT NULL,
      query_text        TEXT NOT NULL,
      response_text     TEXT NOT NULL,
      prompt_tokens     INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      latency_ms        INT NOT NULL DEFAULT 0,
      error_code        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_geo_query_runs_ran_at ON geo_query_runs (ran_at);
    CREATE INDEX IF NOT EXISTS idx_geo_query_runs_run_id ON geo_query_runs (run_id);
    CREATE INDEX IF NOT EXISTS idx_geo_query_runs_query_id ON geo_query_runs (query_id, ran_at);

    CREATE TABLE IF NOT EXISTS geo_mentions (
      id                     BIGSERIAL PRIMARY KEY,
      run_id                 UUID NOT NULL,
      ran_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
      query_id               TEXT NOT NULL,
      model                  TEXT NOT NULL,
      mention_found          BOOLEAN NOT NULL,
      mention_count          INT NOT NULL DEFAULT 0,
      mention_position       INT,
      mention_context        TEXT,
      competitors_mentioned  TEXT[],
      sentiment_score        REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_geo_mentions_ran_at ON geo_mentions (ran_at);
    CREATE INDEX IF NOT EXISTS idx_geo_mentions_query_id ON geo_mentions (query_id, ran_at);

    -- GEO-MEASUREMENT-W2 (C2) — retrieval dimensions on geo_mentions. PG16
    -- supports ADD COLUMN IF NOT EXISTS natively; idempotent, ordered AFTER the
    -- CREATE TABLE in this single multi-statement dbExec (W1 dbExec-race lesson).
    ALTER TABLE geo_mentions ADD COLUMN IF NOT EXISTS retrieval      BOOLEAN DEFAULT false;
    ALTER TABLE geo_mentions ADD COLUMN IF NOT EXISTS cited          BOOLEAN DEFAULT false;
    ALTER TABLE geo_mentions ADD COLUMN IF NOT EXISTS cited_url      TEXT;
    ALTER TABLE geo_mentions ADD COLUMN IF NOT EXISTS share_of_voice NUMERIC;
    ALTER TABLE geo_mentions ADD COLUMN IF NOT EXISTS query_tier     TEXT;
    ALTER TABLE geo_mentions ADD COLUMN IF NOT EXISTS sample_idx     INT DEFAULT 0;

    -- GEO-MEASUREMENT-W2 (C2) — source-citation map (one row per cited URL per run).
    CREATE TABLE IF NOT EXISTS geo_source_citations (
      id              BIGSERIAL PRIMARY KEY,
      run_id          UUID,
      ran_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      query_id        TEXT,
      model           TEXT,
      query_tier      TEXT,
      source_url      TEXT,
      source_domain   TEXT,
      attributed_to   TEXT,
      competitor_name TEXT,
      rank            INT
    );
    CREATE INDEX IF NOT EXISTS idx_geo_source_citations_ran_at ON geo_source_citations (ran_at);
    CREATE INDEX IF NOT EXISTS idx_geo_source_citations_domain ON geo_source_citations (source_domain, ran_at);
    CREATE INDEX IF NOT EXISTS idx_geo_source_citations_query  ON geo_source_citations (query_id, ran_at);

    -- GEO-AUTOPILOT-W1 (C3) — append-only weekly DECIDE ledger. One row per weekly
    -- run: the priority-gated scored decision + the rendered brief Cowork materializes
    -- into Prompt/geo-decision-<date>.md (the cross-host Postgres boundary). status
    -- flips proposed -> approved -> executed -> measured across the loop (TEXT + CHECK,
    -- not a PG enum — avoids ALTER TYPE). gap_ref loosely links a geo_content_gaps row.
    -- Created at boot here (single multi-statement dbExec) so the Monday cron's
    -- fire-and-forget INSERT never races a lazy CREATE.
    CREATE TABLE IF NOT EXISTS geo_decisions (
      id                BIGSERIAL PRIMARY KEY,
      run_id            UUID,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      priority_tier     TEXT,
      ranked_candidates JSONB,
      rendered_brief    TEXT,
      chosen_move       TEXT,
      status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','executed','measured')),
      gap_ref           BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_geo_decisions_created_at ON geo_decisions (created_at DESC);

    CREATE OR REPLACE VIEW geo_weekly_summary AS
    SELECT
      date_trunc('week', ran_at AT TIME ZONE 'UTC') AS week_utc,
      model,
      count(*) AS query_count,
      count(*) FILTER (WHERE mention_found) AS mention_count,
      ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct,
      AVG(mention_position) FILTER (WHERE mention_found) AS avg_position,
      AVG(sentiment_score) FILTER (WHERE mention_found) AS avg_sentiment
    FROM geo_mentions
    WHERE ran_at > now() - interval '1 year'
    GROUP BY week_utc, model
    ORDER BY week_utc DESC, model;

    -- GEO-MEASUREMENT-W2 (C2) — per-engine weekly mention + citation + SoV rates.
    -- "engine" = the model string written per (query, engine, sample).
    CREATE OR REPLACE VIEW geo_engine_weekly AS
    SELECT
      date_trunc('week', ran_at AT TIME ZONE 'UTC') AS week_utc,
      model,
      count(*) AS sample_count,
      count(*) FILTER (WHERE mention_found) AS mention_count,
      ROUND(100.0 * count(*) FILTER (WHERE mention_found) / NULLIF(count(*), 0), 1) AS mention_rate_pct,
      count(*) FILTER (WHERE cited) AS cited_count,
      ROUND(100.0 * count(*) FILTER (WHERE cited) / NULLIF(count(*), 0), 1) AS cited_rate_pct,
      AVG(share_of_voice) AS avg_sov
    FROM geo_mentions
    WHERE ran_at > now() - interval '1 year'
    GROUP BY week_utc, model
    ORDER BY week_utc DESC, model;

    -- GEO-MEASUREMENT-W2 (C2) — weekly share-of-voice trend per model.
    CREATE OR REPLACE VIEW geo_sov_weekly AS
    SELECT
      date_trunc('week', ran_at AT TIME ZONE 'UTC') AS week_utc,
      model,
      AVG(share_of_voice) AS avg_sov,
      count(*) FILTER (WHERE cited) AS cited_count,
      count(*) AS sample_count
    FROM geo_mentions
    WHERE ran_at > now() - interval '1 year'
    GROUP BY week_utc, model
    ORDER BY week_utc DESC, model;

    -- GEO-MEASUREMENT-W2 (C2) — 4-week trusted-source map: which domains the
    -- engines cite, attributed to algovault / competitor / neutral. C4 gap-list
    -- ranks on competitor-cited high-frequency source_domains from here.
    CREATE OR REPLACE VIEW geo_source_map_4w AS
    SELECT
      source_domain,
      attributed_to,
      competitor_name,
      model,
      count(*) AS citation_count,
      count(DISTINCT query_id) AS query_count,
      max(ran_at) AS last_seen
    FROM geo_source_citations
    WHERE ran_at > now() - interval '4 weeks'
    GROUP BY source_domain, attributed_to, competitor_name, model
    ORDER BY citation_count DESC;
  `);
}

/**
 * Persist one (result, mentions) pair. Fire-and-forget — catches and logs;
 * never throws to the orchestrator. Mirrors `recordChatEvent` precedent.
 *
 * OPS-GEO-PROBE-MULTI-RUN-W1 — on the ERROR path (`result.error_code` set) ONLY the
 * geo_query_runs row is written (the raw error is preserved for forensics + the dashboard
 * error_count); the geo_mentions row is SKIPPED. Rationale: an errored retrieval is a FAILED
 * observation, not "the engine didn't cite us". Writing it as a SAFE_DEFAULTS cited=false row
 * is indistinguishable from a genuine miss and silently DEFLATES the read-time citation rate
 * (e.g. gemini's ~59% 429s). Excluding it makes `total_runs` in geo_mentions = SUCCESSFUL
 * samples, so getQueryRates' rate denominator is honest and partial-K → low_confidence (a wide
 * Wilson CI), never a precise-but-wrong low rate. The cited-count gate history is unaffected
 * (error rows were cited=false, never counted). No schema change.
 */
export async function recordGeoRun(
  result: GeoQueryResult,
  mentions: GeoMentions,
  ctx: GeoRunContext = {},
): Promise<void> {
  try {
    dbRun(
      `INSERT INTO geo_query_runs
         (run_id, model, query_id, query_text, response_text, prompt_tokens, completion_tokens, latency_ms, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      result.run_id,
      result.model,
      result.query_id,
      result.query_text,
      result.response_text,
      result.prompt_tokens,
      result.completion_tokens,
      result.latency_ms,
      result.error_code ?? null,
    );
    // Skip the geo_mentions row on the error path — see the JSDoc (honest read-time denominator).
    if (!result.error_code) {
      dbRun(
        `INSERT INTO geo_mentions
           (run_id, query_id, model, mention_found, mention_count, mention_position, mention_context, competitors_mentioned, sentiment_score,
            retrieval, cited, cited_url, share_of_voice, query_tier, sample_idx)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        result.run_id,
        result.query_id,
        result.model,
        mentions.mention_found,
        mentions.mention_count,
        mentions.mention_position,
        mentions.mention_context,
        mentions.competitors_mentioned,
        mentions.sentiment_score,
        ctx.retrieval ?? false,
        mentions.cited,
        mentions.cited_url,
        mentions.share_of_voice,
        ctx.query_tier ?? null,
        ctx.sample_idx ?? 0,
      );
    }
  } catch (err) {
    console.error(
      `[geo-storage] insert failed (silent recovery) run_id=${result.run_id} query_id=${result.query_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * GEO-MEASUREMENT-W2 (C2) — persist the classified source-citation map for one
 * run (from `mapSourceCitations`). Fire-and-forget; never throws (W1 pattern).
 * No-op on empty citations.
 */
export async function recordSourceCitations(
  meta: { run_id: string; query_id: string; model: string; query_tier?: string | null },
  citations: SourceCitation[],
): Promise<void> {
  if (!citations || citations.length === 0) return;
  try {
    for (const c of citations) {
      dbRun(
        `INSERT INTO geo_source_citations
           (run_id, query_id, model, query_tier, source_url, source_domain, attributed_to, competitor_name, rank)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        meta.run_id,
        meta.query_id,
        meta.model,
        meta.query_tier ?? null,
        c.source_url,
        c.source_domain,
        c.attributed_to,
        c.competitor_name,
        c.rank,
      );
    }
  } catch (err) {
    console.error(
      `[geo-storage] source-citation insert failed (silent recovery) run_id=${meta.run_id} query_id=${meta.query_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * GEO-AUTOPILOT-W1 (C3) — persist one weekly DECIDE row to the append-only
 * geo_decisions ledger (status defaults to 'proposed'). Fire-and-forget; never
 * throws to the cron (W1 pattern). The table is created at server boot via
 * ensureGeoSchema, so this INSERT never races a lazy CREATE.
 */
export interface GeoDecisionRecord {
  run_id: string | null;
  priority_tier: string | null;
  ranked_candidates: unknown; // serialized to JSONB
  rendered_brief: string;
  chosen_move: string | null;
  gap_ref?: number | null;
}

export async function recordGeoDecision(rec: GeoDecisionRecord): Promise<void> {
  try {
    dbRun(
      `INSERT INTO geo_decisions
         (run_id, priority_tier, ranked_candidates, rendered_brief, chosen_move, gap_ref)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      rec.run_id,
      rec.priority_tier,
      JSON.stringify(rec.ranked_candidates ?? null),
      rec.rendered_brief,
      rec.chosen_move,
      rec.gap_ref ?? null,
    );
  } catch (err) {
    console.error(
      `[geo-storage] geo_decisions insert failed (silent recovery): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
