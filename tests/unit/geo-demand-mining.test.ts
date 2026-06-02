/**
 * GEO-MEASUREMENT-W2 (C3) — geo-demand-mining unit tests.
 *
 *   - weightQueriesByPlatformDemand: hash-match against chat_analytics_events
 *     (mocked); reads question_hash + count ONLY (PII canary); surfaces
 *     unmatched high-frequency hashes.
 *   - parse HN + StackExchange fixtures -> candidates; cluster + dedup.
 *   - minePublicQuestions orchestration + graceful degradation on a dead source.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'node:path';

vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: vi.fn(async () => []),
  dbExec: vi.fn(),
  dbRun: vi.fn(),
}));

import { dbQuery } from '../../src/lib/performance-db.js';
import {
  weightQueriesByPlatformDemand,
  parseHnResponse,
  parseStackExchangeResponse,
  clusterCandidates,
  minePublicQuestions,
} from '../../src/scripts/geo-demand-mining.js';

const dbQueryMock = vi.mocked(dbQuery);
const YAML = path.resolve(process.cwd(), 'landing/Prompt/geo-queries.yaml');

afterEach(() => {
  dbQueryMock.mockReset();
  vi.unstubAllGlobals();
});

describe('weightQueriesByPlatformDemand', () => {
  it('matches SoT query hashes to frequency and surfaces unmatched high-freq hashes', async () => {
    // best-mcp-trading text hashes to 9cc733e85dfddec5 (locked in question-hash.test).
    dbQueryMock.mockResolvedValueOnce([
      { question_hash: '9cc733e85dfddec5', hits: 5 },
      { question_hash: 'deadbeefdeadbeef', hits: 7 }, // not a SoT query
    ] as never);
    const { weights, unmatched } = await weightQueriesByPlatformDemand({ yamlPath: YAML });

    const bmt = weights.find((w) => w.query_id === 'best-mcp-trading');
    expect(bmt?.demand_weight).toBe(5);
    expect(bmt?.question_hash).toBe('9cc733e85dfddec5');
    expect(bmt?.tier).toBe('head');
    // a query with no matching hash -> weight 0
    expect(weights.find((w) => w.query_id === 'build-crypto-agent')?.demand_weight).toBe(0);
    // unmatched high-freq surfaced (hash only, no text)
    expect(unmatched[0]).toMatchObject({ question_hash: 'deadbeefdeadbeef', hits: 7 });
    expect(unmatched[0].note).toMatch(/not stored|PII/i);
  });

  it('reads question_hash + count ONLY (PII canary) — never selects source text', async () => {
    dbQueryMock.mockResolvedValueOnce([] as never);
    await weightQueriesByPlatformDemand({ yamlPath: YAML });
    const sql = String(dbQueryMock.mock.calls[0][0]);
    expect(sql).toContain('question_hash');
    expect(sql).toContain('count(*)');
    expect(sql).not.toMatch(/question_text|INSERT/i);
  });

  it('degrades gracefully (0 weights) when analytics read throws', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db down') as never);
    const { weights } = await weightQueriesByPlatformDemand({ yamlPath: YAML });
    expect(weights.length).toBeGreaterThanOrEqual(15);
    expect(weights.every((w) => w.demand_weight === 0)).toBe(true);
  });
});

describe('public-forum parsers', () => {
  it('parseHnResponse maps hits -> candidates (title/url/score)', () => {
    const out = parseHnResponse(
      {
        hits: [
          { title: 'Building a crypto agent', url: 'https://example.com/a', points: 42, objectID: '1' },
          { title: 'No-url story', points: 3, objectID: '999' }, // falls back to HN item url
          { points: 5, objectID: '2' }, // no title -> skipped
        ],
      },
      'crypto trading agent',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ source: 'hn', title: 'Building a crypto agent', score: 42 });
    expect(out[1].url).toContain('news.ycombinator.com/item?id=999');
  });

  it('parseStackExchangeResponse maps items -> candidates', () => {
    const out = parseStackExchangeResponse(
      { items: [{ title: 'How to backtest?', link: 'https://stackoverflow.com/q/1', score: 9 }] },
      'crypto backtesting python',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: 'stackoverflow', score: 9, url: 'https://stackoverflow.com/q/1' });
  });

  it('clusterCandidates groups by topic, dedups by url, sorts by score desc', () => {
    const clustered = clusterCandidates([
      { source: 'hn', topic: 't1', title: 'a', url: 'u1', score: 1 },
      { source: 'hn', topic: 't1', title: 'a-dup', url: 'u1', score: 99 }, // dup url -> dropped
      { source: 'stackoverflow', topic: 't1', title: 'b', url: 'u2', score: 5 },
      { source: 'hn', topic: 't2', title: 'c', url: 'u3', score: 2 },
    ]);
    expect(clustered.t1.map((c) => c.url)).toEqual(['u2', 'u1']); // u2 score5 > u1 score1
    expect(clustered.t2).toHaveLength(1);
  });
});

describe('minePublicQuestions', () => {
  it('fetches HN + StackExchange and returns candidates; degrades if a source fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('hn.algolia.com')) {
          return { ok: true, json: async () => ({ hits: [{ title: 'HN hit', url: 'https://h', points: 1 }] }) };
        }
        // StackExchange down -> rejects -> graceful continue
        return { ok: false, status: 503, json: async () => ({}) };
      }),
    );
    const candidates = await minePublicQuestions({ keywords: ['crypto trading agent'], hitsPerKeyword: 5 });
    expect(candidates.some((c) => c.source === 'hn')).toBe(true);
    expect(candidates.some((c) => c.source === 'stackoverflow')).toBe(false); // SO failed, no crash
  });
});
