/**
 * GEO-MEASUREMENT-W1 (C1) — weekly LLM-recommendation probe orchestrator.
 *
 * Loads the canonical 15-query SoT from `landing/Prompt/geo-queries.yaml`,
 * runs each query against an `LLMProvider` (default: Claude Haiku 4.5 via
 * `AnthropicProvider` from AV-CHAT-MCP-W1), then delegates to the extractor
 * + storage primitives. Pure orchestration; no DB calls or HTTP routes here.
 *
 * Fix-at-generator: this is the ONE orchestrator. Adding probe queries =
 * edit YAML. Adding LLM providers (W2) = implement `LLMProvider`, pass into
 * `runWeeklyProbe`. Zero changes to extractor / storage / dashboard / cron.
 */
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getRetrievalEngines,
  type LLMProvider,
  type RetrievalEngine,
  type Citation,
} from './llm-provider.js';
import { extractMentions, mapSourceCitations, SAFE_DEFAULTS, type GeoMentions } from './geo-extractor.js';
import { recordGeoRun, recordSourceCitations } from './geo-storage.js';
import { computeGapList, persistGapBriefs } from './geo-gap-list.js';

/** GEO-MEASUREMENT-W2 (C5) — samples per (query, engine), denoised at read time. */
export const DEFAULT_GEO_SAMPLES_PER_QUERY = 3;

export interface GeoQuery {
  id: string;
  text: string;
  competitor_terms: string[];
  /** GEO-MEASUREMENT-W2 — head|niche|branded; absent => niche. */
  tier?: string;
}

export interface GeoQueryResult {
  run_id: string;
  query_id: string;
  query_text: string;
  model: string;
  response_text: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  error_code?: string;
}

/**
 * Resolve YAML path. Default: `landing/Prompt/geo-queries.yaml` relative to
 * the compiled module's location (`dist/lib/` → repo root). Override via
 * `yamlPath` arg for tests.
 */
export function loadQueries(yamlPath?: string): GeoQuery[] {
  const resolved =
    yamlPath ??
    path.resolve(__dirname, '..', '..', 'landing', 'Prompt', 'geo-queries.yaml');
  const raw = yaml.load(fs.readFileSync(resolved, 'utf-8')) as { queries: GeoQuery[] };
  if (!raw || !Array.isArray(raw.queries)) {
    throw new Error(`geo-queries.yaml at ${resolved} missing 'queries' array`);
  }
  return raw.queries;
}

/**
 * Run one query through the LLM. Returns a GeoQueryResult shape on success
 * OR on failure (with `error_code` populated). Never throws — the weekly
 * probe must continue across query-level errors.
 */
export async function runGeoQuery(
  provider: LLMProvider,
  query: GeoQuery,
  model: string,
  runId: string,
): Promise<GeoQueryResult> {
  const start = Date.now();
  try {
    const result = await provider.complete(
      [{ role: 'user', content: query.text }],
      {
        model,
        maxTokens: 800,
        temperature: 0.3, // moderate temp — match a real user's asking experience
        systemPrompt: '', // no system prompt: we measure the LLM's default recommendation behavior
      },
    );
    return {
      run_id: runId,
      query_id: query.id,
      query_text: query.text,
      model,
      response_text: result.text,
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      run_id: runId,
      query_id: query.id,
      query_text: query.text,
      model,
      response_text: '',
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: Date.now() - start,
      error_code: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

/**
 * GEO-MEASUREMENT-W2 (C5) — one (query, engine, sample) retrieval call. Uses
 * `completeWithCitations` when the engine implements it (claude-web, perplexity),
 * else falls back to plain `complete()` with empty citations. Never throws.
 */
export async function runRetrievalEngineSample(
  engine: RetrievalEngine,
  query: GeoQuery,
  runId: string,
): Promise<{ result: GeoQueryResult; citations: Citation[] }> {
  const start = Date.now();
  const opts = {
    model: engine.model,
    maxTokens: 800,
    temperature: 0.3, // moderate temp — match a real user's asking experience
    systemPrompt: '', // no system prompt: measure the engine's default recommendation behavior
  };
  try {
    let text: string;
    let citations: Citation[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    if (engine.provider.completeWithCitations) {
      const r = await engine.provider.completeWithCitations([{ role: 'user', content: query.text }], opts);
      text = r.text;
      citations = r.citations;
      promptTokens = r.usage?.promptTokens ?? 0;
      completionTokens = r.usage?.completionTokens ?? 0;
    } else {
      const r = await engine.provider.complete([{ role: 'user', content: query.text }], opts);
      text = r.text;
      promptTokens = r.usage.promptTokens;
      completionTokens = r.usage.completionTokens;
    }
    return {
      result: {
        run_id: runId,
        query_id: query.id,
        query_text: query.text,
        model: engine.model,
        response_text: text,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        latency_ms: Date.now() - start,
      },
      citations,
    };
  } catch (err) {
    return {
      result: {
        run_id: runId,
        query_id: query.id,
        query_text: query.text,
        model: engine.model,
        response_text: '',
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: Date.now() - start,
        error_code: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      },
      citations: [],
    };
  }
}

/**
 * Run the full weekly probe across GEO_ENGINES × GEO_SAMPLES_PER_QUERY. Writes
 * one geo_mentions + geo_source_citations row per (query, engine, sample) — the
 * N samples are denoised at READ time by the SQL views (mean SoV / majority
 * mention). After the sweep, computes + persists the content-gap list. Returns
 * a summary for the cron digest. Engines default to the live-key-resolved set
 * (getRetrievalEngines: key-less engines stubbed in test, skipped in prod).
 */
export async function runWeeklyProbe(opts?: {
  engines?: RetrievalEngine[];
  samples?: number;
  yamlPath?: string;
  /** Delay between engine calls in ms. Default 15s. Set to 0 in tests. */
  interQueryDelayMs?: number;
}): Promise<{
  runId: string;
  engineIds: string[];
  resultCount: number;
  errorCount: number;
  gapsPersisted: number;
}> {
  const runId = randomUUID();
  const queries = loadQueries(opts?.yamlPath);
  const engines = opts?.engines ?? getRetrievalEngines();
  const samples =
    opts?.samples ?? (Number(process.env.GEO_SAMPLES_PER_QUERY) || DEFAULT_GEO_SAMPLES_PER_QUERY);
  const delay = opts?.interQueryDelayMs ?? 15_000;
  let errorCount = 0;
  let resultCount = 0;

  console.log(
    `[geo-orchestrator] weekly probe run_id=${runId} queries=${queries.length} engines=[${engines
      .map((e) => e.engineId)
      .join(',')}] samples=${samples}`,
  );

  if (engines.length === 0) {
    console.warn('[geo-orchestrator] no runnable engines (no API keys present) — nothing to probe');
    return { runId, engineIds: [], resultCount: 0, errorCount: 0, gapsPersisted: 0 };
  }

  for (const query of queries) {
    const tier = query.tier ?? 'niche';
    for (const engine of engines) {
      for (let sample = 0; sample < samples; sample++) {
        const { result, citations } = await runRetrievalEngineSample(engine, query, runId);
        resultCount++;
        if (result.error_code) errorCount++;

        const mentions: GeoMentions = result.error_code
          ? { ...SAFE_DEFAULTS }
          : await extractMentions(engine.provider, query, result, citations);

        await recordGeoRun(result, mentions, { retrieval: true, query_tier: tier, sample_idx: sample });
        if (!result.error_code) {
          await recordSourceCitations(
            { run_id: result.run_id, query_id: query.id, model: result.model, query_tier: tier },
            mapSourceCitations(query, citations),
          );
        }
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      console.log(
        `[geo-orchestrator] query=${query.id} engine=${engine.engineId} samples=${samples} done`,
      );
    }
  }

  // Closed loop: compute + persist the ranked content-gap brief(s) for the week.
  let gapsPersisted = 0;
  try {
    const briefs = await computeGapList(4);
    const persisted = await persistGapBriefs(briefs);
    gapsPersisted = persisted.length;
  } catch (err) {
    console.error(`[geo-orchestrator] gap-list step failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `[geo-orchestrator] run ${runId} complete: ${resultCount} rows, ${errorCount} errors, ${gapsPersisted} gap(s) persisted`,
  );
  return { runId, engineIds: engines.map((e) => e.engineId), resultCount, errorCount, gapsPersisted };
}
