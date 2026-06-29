/**
 * GEO-MEASUREMENT-W1 (C3) — geo-orchestrator unit tests.
 *
 * Locks the C1 contracts: 15 queries verbatim from canonical YAML, GeoQueryResult
 * shape on success + error paths, runWeeklyProbe iterates every query + writes
 * one (result, mentions) pair per query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import type { LLMProvider, LLMCompletion, RetrievalEngine } from '../../src/lib/llm-provider.js';

// Hoisted mock state — mutated per test
const mockRecord = vi.fn();
const mockRecordCites = vi.fn();
const mockExtract = vi.fn();
const mockEnsure = vi.fn();
const mockComputeGap = vi.fn();
const mockPersistGap = vi.fn();

vi.mock('../../src/lib/geo-storage.js', () => ({
  recordGeoRun: (...args: unknown[]) => mockRecord(...args),
  recordSourceCitations: (...args: unknown[]) => mockRecordCites(...args),
  ensureGeoSchema: (...args: unknown[]) => mockEnsure(...args),
}));

vi.mock('../../src/lib/geo-gap-list.js', () => ({
  computeGapList: (...args: unknown[]) => mockComputeGap(...args),
  persistGapBriefs: (...args: unknown[]) => mockPersistGap(...args),
}));

// Keep real SAFE_DEFAULTS (the orchestrator error-path spreads it as of W2 C2);
// override only extractMentions.
vi.mock('../../src/lib/geo-extractor.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/geo-extractor.js')>();
  return {
    ...actual,
    extractMentions: (...args: unknown[]) => mockExtract(...args),
  };
});

// Import AFTER vi.mock declarations
import {
  loadQueries,
  runGeoQuery,
  runWeeklyProbe,
  type GeoQuery,
} from '../../src/lib/geo-orchestrator.js';

const YAML_PATH = path.resolve(__dirname, '..', '..', 'landing', 'Prompt', 'geo-queries.yaml');
// Derived so adding a query to the SoT yaml (e.g. the R5 presence-tier query) doesn't
// brittle-break every runWeeklyProbe iteration assertion — only the explicit count
// lock in the loadQueries describe is hardcoded.
const QUERY_COUNT = loadQueries(YAML_PATH).length;

class StubProvider implements LLMProvider {
  readonly name = 'stub' as const;
  constructor(private readonly fn?: (msgs: unknown, opts: unknown) => LLMCompletion) {}
  async complete(messages: unknown, opts: unknown): Promise<LLMCompletion> {
    if (this.fn) return this.fn(messages, opts);
    return {
      text: 'AlgoVault is one option you could use.',
      usage: { promptTokens: 10, completionTokens: 20 },
    };
  }
}

beforeEach(() => {
  mockRecord.mockReset().mockResolvedValue(undefined);
  mockRecordCites.mockReset().mockResolvedValue(undefined);
  mockExtract.mockReset().mockResolvedValue({
    mention_found: true,
    mention_count: 1,
    mention_position: 1,
    mention_context: '…AlgoVault…',
    competitors_mentioned: [],
    sentiment_score: 0.5,
    cited: false,
    cited_url: null,
    share_of_voice: 0.25,
  });
  mockEnsure.mockReset();
  mockComputeGap.mockReset().mockResolvedValue([]);
  mockPersistGap.mockReset().mockResolvedValue([]);
});

/** A single stub retrieval engine for runWeeklyProbe tests. */
function stubEngine(fn?: (msgs: unknown, opts: unknown) => LLMCompletion): RetrievalEngine {
  return { engineId: 'stub', provider: new StubProvider(fn), model: 'stub-model' };
}

describe('geo-orchestrator: loadQueries', () => {
  it('returns all canonical GeoQuery objects from YAML (15 authority + 1 presence)', () => {
    const queries = loadQueries(YAML_PATH);
    expect(queries).toHaveLength(16);
    expect(queries[0].id).toBe('build-crypto-agent');
    expect(queries[14].id).toBe('python-quant-for-ai');
    expect(queries[15].id).toBe('algovault-exists'); // R5 presence-tier query
  });

  it('each query has required fields {id, text, competitor_terms[]}', () => {
    const queries = loadQueries(YAML_PATH);
    for (const q of queries) {
      expect(typeof q.id).toBe('string');
      expect(q.id.length).toBeGreaterThan(0);
      expect(typeof q.text).toBe('string');
      expect(q.text.length).toBeGreaterThan(0);
      expect(Array.isArray(q.competitor_terms)).toBe(true);
    }
  });

  it('default path resolves to landing/Prompt/geo-queries.yaml', () => {
    // No arg = use default __dirname-relative resolution
    const queries = loadQueries();
    expect(queries).toHaveLength(16);
  });
});

describe('geo-orchestrator: runGeoQuery', () => {
  const query: GeoQuery = {
    id: 'test-q',
    text: 'test text',
    competitor_terms: ['x', 'y'],
  };

  it('returns valid GeoQueryResult shape on success', async () => {
    const provider = new StubProvider();
    const result = await runGeoQuery(provider, query, 'claude-haiku-4-5-20251001', 'run-abc');
    expect(result.run_id).toBe('run-abc');
    expect(result.query_id).toBe('test-q');
    expect(result.query_text).toBe('test text');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.response_text).toContain('AlgoVault');
    expect(result.prompt_tokens).toBe(10);
    expect(result.completion_tokens).toBe(20);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error_code).toBeUndefined();
  });

  it('returns error_code shape when provider throws', async () => {
    const provider = new StubProvider(() => {
      throw new Error('boom');
    });
    const result = await runGeoQuery(provider, query, 'm', 'r');
    expect(result.error_code).toContain('boom');
    expect(result.response_text).toBe('');
    expect(result.prompt_tokens).toBe(0);
    expect(result.completion_tokens).toBe(0);
  });

  it('passes systemPrompt:"" to opts (LLMCompletionOpts requires it)', async () => {
    const spy = vi.fn().mockReturnValue({
      text: 'ok',
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    const provider = new StubProvider(spy);
    await runGeoQuery(provider, query, 'm', 'r');
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][1] as { systemPrompt: string };
    expect(opts.systemPrompt).toBe('');
  });
});

describe('geo-orchestrator: runWeeklyProbe (multi-engine × samples)', () => {
  it('writes ≥samples rows per (query, engine) and computes the gap list', async () => {
    const { runId, engineIds, resultCount, errorCount } = await runWeeklyProbe({
      engines: [stubEngine()],
      samples: 1,
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
    });
    expect(runId.length).toBeGreaterThan(0);
    expect(engineIds).toEqual(['stub']);
    expect(resultCount).toBe(QUERY_COUNT); // every query × 1 engine × 1 sample
    expect(errorCount).toBe(0);
    expect(mockRecord).toHaveBeenCalledTimes(QUERY_COUNT);
    expect(mockExtract).toHaveBeenCalledTimes(QUERY_COUNT);
    expect(mockRecordCites).toHaveBeenCalledTimes(QUERY_COUNT); // source-citation map per ok row
    // closed loop: gap-list computed + persisted once at end
    expect(mockComputeGap).toHaveBeenCalledTimes(1);
    expect(mockPersistGap).toHaveBeenCalledTimes(1);
  });

  it('scales rows by engines × samples', async () => {
    const { resultCount } = await runWeeklyProbe({
      engines: [stubEngine(), stubEngine()],
      samples: 3,
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
    });
    expect(resultCount).toBe(QUERY_COUNT * 2 * 3);
    expect(mockRecord).toHaveBeenCalledTimes(QUERY_COUNT * 2 * 3);
  });

  it('records via storage with safe defaults on the error path; skips extractor + citations', async () => {
    const { resultCount, errorCount } = await runWeeklyProbe({
      engines: [
        stubEngine(() => {
          throw new Error('always fail');
        }),
      ],
      samples: 1,
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
    });
    expect(resultCount).toBe(QUERY_COUNT);
    expect(errorCount).toBe(QUERY_COUNT);
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockRecordCites).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledTimes(QUERY_COUNT); // still recorded with SAFE_DEFAULTS
  });

  it('no-ops cleanly when there are no runnable engines', async () => {
    const { resultCount, engineIds } = await runWeeklyProbe({
      engines: [],
      samples: 3,
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
    });
    expect(resultCount).toBe(0);
    expect(engineIds).toEqual([]);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('extracts with the judgeProvider (Anthropic), NEVER the engine provider', async () => {
    // Regression: a Perplexity engine provider can't run the Claude-pinned
    // extractor model — the judge must be a separate Anthropic-shaped provider.
    const judge = new StubProvider();
    const engine = stubEngine();
    await runWeeklyProbe({
      engines: [engine],
      samples: 1,
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
      judgeProvider: judge,
    });
    expect(mockExtract).toHaveBeenCalledTimes(QUERY_COUNT);
    for (const call of mockExtract.mock.calls) {
      expect(call[0]).toBe(judge); // judge provider
      expect(call[0]).not.toBe(engine.provider); // never the engine's provider
    }
  });

  // OPS-GEO-PROBE-MULTI-RUN-W1 — K is config-driven (probe block) with a per-engine override.
  it('per-engine K override (probe.runs_per_query_by_engine) beats the global runs_per_query', async () => {
    const alpha: RetrievalEngine = { engineId: 'alpha', provider: new StubProvider(), model: 'm-alpha' };
    const beta: RetrievalEngine = { engineId: 'beta', provider: new StubProvider(), model: 'm-beta' };
    const { resultCount } = await runWeeklyProbe({
      engines: [alpha, beta],
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
      probe: { runs_per_query: 2, runs_per_query_by_engine: { beta: 5 } },
    });
    // alpha → global K=2, beta → override K=5
    expect(resultCount).toBe(QUERY_COUNT * 2 + QUERY_COUNT * 5);
    expect(mockRecord).toHaveBeenCalledTimes(QUERY_COUNT * 7);
  });

  // OPS-GEO-PROBE-MULTI-RUN-W1 — engines sweep with BOUNDED concurrency; each engine is serial
  // internally (concurrency=1 per engine → no bursts, gemini-safe), engines in parallel ≤ cap.
  it('caps parallel engine workers at probe.max_engine_concurrency (and is genuinely parallel)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const makeEngine = (id: string): RetrievalEngine => ({
      engineId: id,
      model: `m-${id}`,
      provider: new StubProvider(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { text: 'AlgoVault is one option.', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    });
    const { resultCount } = await runWeeklyProbe({
      engines: ['a', 'b', 'c', 'd'].map(makeEngine),
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
      probe: { runs_per_query: 1, max_engine_concurrency: 2 },
    });
    expect(resultCount).toBe(QUERY_COUNT * 4); // all 4 engines fully processed
    expect(maxInFlight).toBeLessThanOrEqual(2); // never exceeds the cap
    expect(maxInFlight).toBe(2); // genuinely parallel (not serialised to 1)
  });
});
