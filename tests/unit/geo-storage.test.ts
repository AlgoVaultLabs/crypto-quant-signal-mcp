/**
 * GEO-MEASUREMENT-W2 (C2) — geo-storage unit tests.
 *
 * Mocks performance-db (dbExec/dbRun fire-and-forget) and asserts:
 *   - ensureGeoSchema emits the new ALTER cols + geo_source_citations + 3 views
 *     in a SINGLE dbExec (W1 dbExec-race lesson).
 *   - recordGeoRun writes the 6 new geo_mentions columns (ctx + extractor dims).
 *   - recordSourceCitations inserts one row per citation; no-op on empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/performance-db.js', () => ({
  dbExec: vi.fn(),
  dbRun: vi.fn(),
  dbQuery: vi.fn(async () => []),
}));

import { dbExec, dbRun } from '../../src/lib/performance-db.js';
import { ensureGeoSchema, recordGeoRun, recordSourceCitations } from '../../src/lib/geo-storage.js';
import type { GeoQueryResult } from '../../src/lib/geo-orchestrator.js';
import type { GeoMentions, SourceCitation } from '../../src/lib/geo-extractor.js';

const dbExecMock = vi.mocked(dbExec);
const dbRunMock = vi.mocked(dbRun);

const RESULT: GeoQueryResult = {
  run_id: '11111111-1111-1111-1111-111111111111',
  query_id: 'best-mcp-trading',
  query_text: "What's the best MCP server for crypto signals?",
  model: 'sonar',
  response_text: 'AlgoVault and vectorbt.',
  prompt_tokens: 30,
  completion_tokens: 40,
  latency_ms: 700,
};

const MENTIONS: GeoMentions = {
  mention_found: true,
  mention_count: 1,
  mention_position: 1,
  mention_context: 'AlgoVault',
  competitors_mentioned: ['vectorbt'],
  sentiment_score: 0.4,
  cited: true,
  cited_url: 'https://algovault.com/faq',
  share_of_voice: 0.3,
};

beforeEach(() => {
  dbExecMock.mockClear();
  dbRunMock.mockClear();
});

describe('ensureGeoSchema (W2 DDL)', () => {
  it('emits new columns + geo_source_citations + 3 views in a SINGLE dbExec', () => {
    ensureGeoSchema();
    expect(dbExecMock).toHaveBeenCalledTimes(1);
    const sql = String(dbExecMock.mock.calls[0][0]);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+cited\b/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+share_of_voice/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+query_tier/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+retrieval/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+sample_idx/);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS geo_source_citations');
    expect(sql).toContain('geo_engine_weekly');
    expect(sql).toContain('geo_sov_weekly');
    expect(sql).toContain('geo_source_map_4w');
  });
});

describe('recordGeoRun (new geo_mentions columns)', () => {
  it('writes 15-col geo_mentions insert with ctx + extractor dims', async () => {
    await recordGeoRun(RESULT, MENTIONS, { retrieval: true, query_tier: 'head', sample_idx: 2 });
    expect(dbRunMock).toHaveBeenCalledTimes(2); // geo_query_runs + geo_mentions
    const call = dbRunMock.mock.calls.find((c) => String(c[0]).includes('INTO geo_mentions'));
    expect(call).toBeDefined();
    expect(String(call![0])).toContain('share_of_voice');
    expect(String(call![0])).toContain('sample_idx');
    const params = call!.slice(1);
    // order: ...sentiment_score(idx8), retrieval(9), cited(10), cited_url(11), share_of_voice(12), query_tier(13), sample_idx(14)
    expect(params[9]).toBe(true); // retrieval
    expect(params[10]).toBe(true); // cited
    expect(params[11]).toBe('https://algovault.com/faq'); // cited_url
    expect(params[12]).toBe(0.3); // share_of_voice
    expect(params[13]).toBe('head'); // query_tier
    expect(params[14]).toBe(2); // sample_idx
  });

  it('defaults retrieval=false, query_tier=null, sample_idx=0 when ctx omitted (W1 2-arg call)', async () => {
    await recordGeoRun(RESULT, MENTIONS);
    const call = dbRunMock.mock.calls.find((c) => String(c[0]).includes('INTO geo_mentions'));
    const params = call!.slice(1);
    expect(params[9]).toBe(false);
    expect(params[13]).toBeNull();
    expect(params[14]).toBe(0);
  });

  // OPS-GEO-PROBE-MULTI-RUN-W1 — honest read-time denominator: an errored retrieval logs ONLY
  // geo_query_runs (the raw error for forensics), NOT geo_mentions — so getQueryRates' total_runs
  // counts SUCCESSFUL samples and a failing engine (gemini 429s) reads as partial-K low_confidence,
  // never a precise-but-wrong low rate. The cited-count gate history is unaffected (errors were cited=false).
  it('on the error path writes geo_query_runs ONLY (skips geo_mentions)', async () => {
    const errResult: GeoQueryResult = { ...RESULT, response_text: '', prompt_tokens: 0, completion_tokens: 0, error_code: 'GEMINI_API_ERROR 429' };
    await recordGeoRun(errResult, { ...MENTIONS, mention_found: false, cited: false }, { retrieval: true, sample_idx: 1 });
    expect(dbRunMock).toHaveBeenCalledTimes(1); // geo_query_runs only
    const sql = String(dbRunMock.mock.calls[0][0]);
    expect(sql).toContain('INTO geo_query_runs');
    expect(dbRunMock.mock.calls.some((c) => String(c[0]).includes('INTO geo_mentions'))).toBe(false);
    // the error_code IS persisted to geo_query_runs (forensics / dashboard error_count)
    expect(dbRunMock.mock.calls[0].slice(1)).toContain('GEMINI_API_ERROR 429');
  });
});

describe('recordSourceCitations', () => {
  const CITES: SourceCitation[] = [
    { source_url: 'https://algovault.com/faq', source_domain: 'algovault.com', attributed_to: 'algovault', competitor_name: null, rank: 1 },
    { source_url: 'https://github.com/polakowo/vectorbt', source_domain: 'github.com', attributed_to: 'competitor', competitor_name: 'vectorbt', rank: 2 },
  ];

  it('inserts one geo_source_citations row per citation', async () => {
    await recordSourceCitations({ run_id: 'r1', query_id: 'q1', model: 'sonar', query_tier: 'head' }, CITES);
    expect(dbRunMock).toHaveBeenCalledTimes(2);
    expect(String(dbRunMock.mock.calls[0][0])).toContain('INTO geo_source_citations');
    expect(dbRunMock.mock.calls[1].slice(1)).toContain('vectorbt');
  });

  it('is a no-op on empty citations', async () => {
    await recordSourceCitations({ run_id: 'r1', query_id: 'q1', model: 'sonar' }, []);
    expect(dbRunMock).not.toHaveBeenCalled();
  });
});
