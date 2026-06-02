/**
 * GEO-MEASUREMENT-W2 (C5) — multi-engine end-to-end integration.
 *
 * Wires the REAL orchestrator → providers → extractor → mapSourceCitations
 * across 2 engines × 1 sample over the 15-query SoT, with storage + gap-list
 * mocked (captured). Asserts: row count scales by engines×samples; the
 * retrieval ctx (retrieval/query_tier/sample_idx) reaches recordGeoRun; the
 * engine's algovault citation becomes cited=true; and the classified
 * source-citation map (algovault + competitor) reaches recordSourceCitations.
 *
 * No real DB; live persistence is verified post-deploy by the LIVE gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import type {
  LLMProvider,
  LLMCompletion,
  RetrievalResult,
  RetrievalEngine,
} from '../../src/lib/llm-provider.js';
import type { GeoQueryResult } from '../../src/lib/geo-orchestrator.js';
import type { GeoMentions, SourceCitation } from '../../src/lib/geo-extractor.js';

interface GeoRunContext {
  retrieval?: boolean;
  query_tier?: string | null;
  sample_idx?: number;
}
const recordedRuns: Array<{ result: GeoQueryResult; mentions: GeoMentions; ctx: GeoRunContext }> = [];
const recordedCitations: Array<{ meta: Record<string, unknown>; citations: SourceCitation[] }> = [];

vi.mock('../../src/lib/geo-storage.js', () => ({
  recordGeoRun: async (result: GeoQueryResult, mentions: GeoMentions, ctx: GeoRunContext = {}) => {
    recordedRuns.push({ result, mentions, ctx });
  },
  recordSourceCitations: async (meta: Record<string, unknown>, citations: SourceCitation[]) => {
    recordedCitations.push({ meta, citations });
  },
  ensureGeoSchema: () => {
    /* no-op */
  },
}));

vi.mock('../../src/lib/geo-gap-list.js', () => ({
  computeGapList: async () => [],
  persistGapBriefs: async () => [],
}));

import { runWeeklyProbe } from '../../src/lib/geo-orchestrator.js';

const YAML_PATH = path.resolve(process.cwd(), 'landing/Prompt/geo-queries.yaml');

const CANNED_EXTRACTOR_JSON = JSON.stringify({
  mention_found: true,
  mention_count: 1,
  mention_position: 2,
  mention_context: 'AlgoVault is a good option…',
  competitors_mentioned: ['vectorbt'],
  sentiment_score: 0.6,
  share_of_voice: 0.5,
});

/** Engine that returns citations on completeWithCitations + canned extractor JSON on complete. */
class DualBehaviorProvider implements LLMProvider {
  readonly name = 'stub' as const;
  async complete(_messages: unknown, opts: unknown): Promise<LLMCompletion> {
    const o = opts as { systemPromptCacheable?: boolean };
    if (o.systemPromptCacheable === true) {
      return { text: CANNED_EXTRACTOR_JSON, usage: { promptTokens: 1, completionTokens: 1 } };
    }
    return { text: 'Top picks include vectorbt and AlgoVault.', usage: { promptTokens: 10, completionTokens: 30 } };
  }
  async completeWithCitations(_messages: unknown, _opts: unknown): Promise<RetrievalResult> {
    return {
      text: 'Top picks include vectorbt and AlgoVault.',
      citations: [
        { url: 'https://algovault.com/faq', title: 'AlgoVault FAQ' },
        { url: 'https://github.com/polakowo/vectorbt', title: 'vectorbt' },
      ],
      usage: { promptTokens: 10, completionTokens: 30 },
    };
  }
}

beforeEach(() => {
  recordedRuns.length = 0;
  recordedCitations.length = 0;
});

describe('GEO-MEASUREMENT-W2: multi-engine end-to-end flow', () => {
  it('runs 2 engines × 1 sample over 15 queries; ctx + citations flow through', async () => {
    const engines: RetrievalEngine[] = [
      { engineId: 'claude-web', provider: new DualBehaviorProvider(), model: 'claude-haiku-4-5-20251001' },
      { engineId: 'perplexity', provider: new DualBehaviorProvider(), model: 'sonar' },
    ];

    const { runId, resultCount, errorCount, engineIds } = await runWeeklyProbe({
      engines,
      samples: 1,
      yamlPath: YAML_PATH,
      interQueryDelayMs: 0,
    });

    expect(resultCount).toBe(30); // 15 × 2 × 1
    expect(errorCount).toBe(0);
    expect(engineIds).toEqual(['claude-web', 'perplexity']);
    expect(recordedRuns).toHaveLength(30);
    expect(recordedCitations).toHaveLength(30); // one source-map per ok run

    for (const { result, mentions, ctx } of recordedRuns) {
      expect(result.run_id).toBe(runId);
      expect(['claude-haiku-4-5-20251001', 'sonar']).toContain(result.model);
      expect(mentions.mention_found).toBe(true);
      expect(mentions.competitors_mentioned).toContain('vectorbt');
      expect(mentions.share_of_voice).toBe(0.5);
      expect(mentions.cited).toBe(true); // algovault.com citation -> cited
      expect(mentions.cited_url).toBe('https://algovault.com/faq');
      expect(ctx.retrieval).toBe(true);
      expect(ctx.sample_idx).toBe(0);
      expect(typeof ctx.query_tier).toBe('string');
    }

    // Source-citation attribution flowed through mapSourceCitations.
    const allAttr = new Set(recordedCitations.flatMap((r) => r.citations.map((c) => c.attributed_to)));
    expect(allAttr.has('algovault')).toBe(true);
    expect(allAttr.has('competitor')).toBe(true); // queries with 'vectorbt' in competitor_terms
  });
});
