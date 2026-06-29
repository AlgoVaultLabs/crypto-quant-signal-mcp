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
  getLLMProvider,
  type LLMProvider,
  type RetrievalEngine,
  type Citation,
} from './llm-provider.js';
import { extractMentions, mapSourceCitations, SAFE_DEFAULTS, type GeoMentions } from './geo-extractor.js';
import { recordGeoRun, recordSourceCitations } from './geo-storage.js';
import { computeGapList, persistGapBriefs } from './geo-gap-list.js';

/** GEO-MEASUREMENT-W2 (C5) — samples per (query, engine), denoised at read time. */
export const DEFAULT_GEO_SAMPLES_PER_QUERY = 3;

/**
 * OPS-GEO-PROBE-MULTI-RUN-W1 — raw `probe:` block from geo-objective.yaml (snake_case).
 * Shape-compatible with Objective.probe in geo-decide.ts (inlined there to keep it a leaf).
 */
export interface GeoProbeRaw {
  runs_per_query?: number;
  runs_per_query_by_engine?: Record<string, number>;
  max_engine_concurrency?: number;
  inter_sample_delay_ms?: number;
  inter_sample_delay_ms_by_engine?: Record<string, number>;
  low_confidence_min_samples?: number;
}

/** Resolved probe config (camelCase) consumed by runWeeklyProbe + (read side) getQueryRates. */
export interface GeoProbeConfig {
  runsPerQuery: number;
  runsPerQueryByEngine: Record<string, number>;
  maxEngineConcurrency: number;
  interSampleDelayMs: number;
  interSampleDelayMsByEngine: Record<string, number>;
  lowConfidenceMinSamples: number;
}

export const DEFAULT_GEO_PROBE: GeoProbeConfig = {
  runsPerQuery: DEFAULT_GEO_SAMPLES_PER_QUERY,
  runsPerQueryByEngine: {},
  maxEngineConcurrency: 4,
  interSampleDelayMs: 15_000,
  interSampleDelayMsByEngine: {},
  lowConfidenceMinSamples: DEFAULT_GEO_SAMPLES_PER_QUERY,
};

function posIntOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Coerce a yaml object into a clean {string: non-negative-int} map (drops invalid entries). */
function numMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) out[k] = Math.floor(val);
  }
  return out;
}

/**
 * Resolve the objective's `probe` block into a config. Default-denies on missing / NaN /
 * negative input (per-field fallback to DEFAULT_GEO_PROBE) and clamps `runsPerQuery`,
 * `maxEngineConcurrency`, and `lowConfidenceMinSamples` to ≥1 (a 0 there would be a silent
 * no-op probe / divide trap). Env `GEO_SAMPLES_PER_QUERY` is a below-yaml fallback for K
 * (an ops override without editing yaml). Mirrors geo-alert-hygiene::resolveAlertHygiene.
 */
export function resolveGeoProbe(raw?: GeoProbeRaw | null): GeoProbeConfig {
  const envK = Number(process.env.GEO_SAMPLES_PER_QUERY);
  const envKFallback = Number.isFinite(envK) && envK > 0 ? Math.floor(envK) : DEFAULT_GEO_PROBE.runsPerQuery;
  return {
    runsPerQuery: Math.max(1, posIntOr(raw?.runs_per_query, envKFallback)),
    runsPerQueryByEngine: numMap(raw?.runs_per_query_by_engine),
    maxEngineConcurrency: Math.max(1, posIntOr(raw?.max_engine_concurrency, DEFAULT_GEO_PROBE.maxEngineConcurrency)),
    interSampleDelayMs: posIntOr(raw?.inter_sample_delay_ms, DEFAULT_GEO_PROBE.interSampleDelayMs),
    interSampleDelayMsByEngine: numMap(raw?.inter_sample_delay_ms_by_engine),
    lowConfidenceMinSamples: Math.max(1, posIntOr(raw?.low_confidence_min_samples, DEFAULT_GEO_PROBE.lowConfidenceMinSamples)),
  };
}

/**
 * Bounded-concurrency pool: run `worker` over `items` with at most `limit` in flight. JS is
 * single-threaded so the shared `queue.shift()` never races. runWeeklyProbe's worker never
 * throws (per-sample errors are caught in runRetrievalEngineSample), so the pool can't reject.
 */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const runners = Array.from({ length: n }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

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
 * Run the full weekly probe across GEO_ENGINES × K-samples-per-engine. Writes one
 * geo_mentions + geo_source_citations row per SUCCESSFUL (query, engine, sample) — error
 * samples log to geo_query_runs only (recordGeoRun skips geo_mentions on error_code), so the
 * read-time denominator is successful samples (partial-K → low_confidence in getQueryRates).
 *
 * Engines are swept with BOUNDED CONCURRENCY (probe.maxEngineConcurrency, default 4) — one
 * serial worker per engine (concurrency=1 within an engine → no bursts; gemini-safe), engines
 * in parallel. Per-engine K + pacing from the resolved probe config. After the sweep, computes
 * + persists the content-gap list. Engines default to the live-key-resolved set.
 */
export async function runWeeklyProbe(opts?: {
  engines?: RetrievalEngine[];
  /** EXPLICIT K override (tests) — applies to EVERY engine, beats the probe config. */
  samples?: number;
  yamlPath?: string;
  /** EXPLICIT per-sample delay override (tests; set 0). Applies to every engine, beats probe config. */
  interQueryDelayMs?: number;
  /**
   * The extractor's LLM judge — ALWAYS Anthropic (the extractor pins a Claude
   * Haiku model), independent of which retrieval engine produced the answer.
   * Must NOT be the per-engine provider (a PerplexityProvider can't run the
   * Claude judge model). Defaults to `getLLMProvider()` (Anthropic in prod).
   */
  judgeProvider?: LLMProvider;
  /**
   * OPS-GEO-PROBE-MULTI-RUN-W1 — raw `probe:` block from geo-objective.yaml (K, per-engine
   * K overrides, engine concurrency, per-engine pacing). Resolved via `resolveGeoProbe`.
   * `opts.samples` / `opts.interQueryDelayMs` above remain explicit per-engine overrides.
   */
  probe?: GeoProbeRaw;
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
  const judgeProvider = opts?.judgeProvider ?? getLLMProvider();
  const probe = resolveGeoProbe(opts?.probe);
  // opts.samples / opts.interQueryDelayMs are EXPLICIT overrides (tests) applied to EVERY engine
  // (highest precedence); else the per-engine yaml override ?? the global resolved value.
  const explicitSamples = opts?.samples;
  const explicitDelay = opts?.interQueryDelayMs;
  const samplesFor = (engineId: string): number =>
    explicitSamples ?? probe.runsPerQueryByEngine[engineId] ?? probe.runsPerQuery;
  const delayFor = (engineId: string): number =>
    explicitDelay ?? probe.interSampleDelayMsByEngine[engineId] ?? probe.interSampleDelayMs;
  let errorCount = 0;
  let resultCount = 0;

  console.log(
    `[geo-orchestrator] weekly probe run_id=${runId} queries=${queries.length} engines=[${engines
      .map((e) => `${e.engineId}×${samplesFor(e.engineId)}`)
      .join(',')}] maxConcurrency=${probe.maxEngineConcurrency}`,
  );

  if (engines.length === 0) {
    console.warn('[geo-orchestrator] no runnable engines (no API keys present) — nothing to probe');
    return { runId, engineIds: [], resultCount: 0, errorCount: 0, gapsPersisted: 0 };
  }

  // One serial worker PER ENGINE (concurrency=1 within an engine → no bursts, so gemini's
  // free-tier RPM is never tripped), engines swept in PARALLEL up to maxEngineConcurrency.
  // Per-engine K + pacing. A retrieval error is recorded to geo_query_runs (error_code) but NOT
  // to geo_mentions (recordGeoRun skips it on error) → read-time rate denominator = successful
  // samples only, so frequent errors surface as partial-K low_confidence, never a false low rate.
  const sweepEngine = async (engine: RetrievalEngine): Promise<void> => {
    const k = samplesFor(engine.engineId);
    const delay = delayFor(engine.engineId);
    for (const query of queries) {
      const tier = query.tier ?? 'niche';
      for (let sample = 0; sample < k; sample++) {
        const { result, citations } = await runRetrievalEngineSample(engine, query, runId);
        resultCount++;
        if (result.error_code) errorCount++;

        // Judge with Anthropic (judgeProvider), NOT engine.provider — the
        // extractor pins a Claude model; a Perplexity provider would 400.
        const mentions: GeoMentions = result.error_code
          ? { ...SAFE_DEFAULTS }
          : await extractMentions(judgeProvider, query, result, citations);

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
        `[geo-orchestrator] query=${query.id} engine=${engine.engineId} samples=${k} done`,
      );
    }
  };

  await runPool(engines, probe.maxEngineConcurrency, sweepEngine);

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
