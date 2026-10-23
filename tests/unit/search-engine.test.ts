/**
 * AV-CHAT-MCP-W1 (C4) — vitest canary for src/lib/search-engine.ts.
 *
 * Locks SearchEngine invariants:
 *   - query() returns ranked results for tool-name queries.
 *   - query() caches per (q, limit) tuple.
 *   - query() enforces the limit argument.
 *   - query() returns empty array for nonexistent queries (no throw).
 *   - excerpt is markdown-stripped and ≤200 chars — but an underscore INSIDE an identifier
 *     (scan_trade_calls, TRENDING_UP) survives (OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { SearchEngine } from '../../src/lib/search-engine.js';
import { ResultCache, type ResultCacheOpts } from '../../src/lib/result-cache.js';
import type { SearchResult } from '../../src/lib/search-engine.js';

const FIXTURE_BUNDLE = {
  version: '1.99.0',
  generated_at: '2026-05-18T00:00:00.000Z',
  package_name: 'crypto-quant-signal-mcp',
  description: 'AlgoVault test fixture',
  keywords: ['fixture'],
  whats_new: 'fixture-only',
  tools: [
    { name: 'get_trade_call', description: 'Composite trade call across exchanges; returns verdict.', parameters: {} },
    { name: 'scan_funding_arb', description: 'Cross-venue funding arbitrage scanner across exchanges.', parameters: {} },
    { name: 'get_market_regime', description: 'Market regime classifier returning regime label.', parameters: {} },
  ],
  response_shapes: [],
  integrations: [],
  examples: [],
  discussions: [],
  // BUNDLE-EXPAND-BLOG-W1 (2026-05-19): schema bumped 1 → 2 (pages[] added)
  pages: [],
  _algovault: { bundle_version: 2, generator: 'build-knowledge-json.mjs', repo: 'AlgoVaultLabs/crypto-quant-signal-mcp' },
};

async function makeEngine(bundle: unknown = FIXTURE_BUNDLE): Promise<{ engine: SearchEngine; index: KnowledgeIndex; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'algovault-search-test-'));
  const file = join(dir, 'latest.json');
  writeFileSync(file, JSON.stringify(bundle));
  const index = new KnowledgeIndex(file);
  await index.build();
  const cache = new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 });
  const engine = new SearchEngine(index, cache);
  return { engine, index, cleanup: () => index.stopWatching() };
}

describe('SearchEngine (AV-CHAT-MCP-W1 C1)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it('returns ranked results for tool-name queries', async () => {
    const { engine, cleanup } = await makeEngine();
    cleanups.push(cleanup);

    const r = await engine.query('scan funding arb', 5);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].source_type).toBe('tool');
    expect(r[0].title).toBe('scan_funding_arb');
  });

  it('caches results — second call returns same array reference', async () => {
    const { engine, cleanup } = await makeEngine();
    cleanups.push(cleanup);

    const r1 = await engine.query('trade call', 5);
    const r2 = await engine.query('trade call', 5);
    expect(r2).toBe(r1); // strict reference equality proves cache hit
  });

  it('enforces the limit argument', async () => {
    const { engine, cleanup } = await makeEngine();
    cleanups.push(cleanup);

    const r = await engine.query('exchange', 2);
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('clamps limit to [1, 50] — limit=0 falls back to default-10, limit=9999 caps at 50', async () => {
    const { engine, cleanup } = await makeEngine();
    cleanups.push(cleanup);

    // Use a token that's actually in the fixture descriptions ('exchanges'
    // — plural — is in 2 of 3 tool descriptions).
    const rZero = await engine.query('exchanges', 0);
    expect(rZero.length).toBeGreaterThan(0);
    const rHuge = await engine.query('exchanges', 9999);
    expect(rHuge.length).toBeLessThanOrEqual(50);
  });

  it('returns empty array for nonexistent query (no throw)', async () => {
    const { engine, cleanup } = await makeEngine();
    cleanups.push(cleanup);

    const r = await engine.query('zzznonexistent_term_zzz', 5);
    expect(r).toEqual([]);
  });

  it('excerpt is markdown-stripped and ≤200 chars', async () => {
    const { engine, cleanup } = await makeEngine();
    cleanups.push(cleanup);

    const r = await engine.query('trade', 3);
    expect(r.length).toBeGreaterThan(0);
    for (const result of r) {
      expect(result.excerpt.length).toBeLessThanOrEqual(201); // 200 + trailing ellipsis
      expect(result.excerpt).not.toMatch(/[`*~#>]/); // markdown control chars stripped
      // An underscore survives ONLY between two letters/digits (an identifier), never at a word edge.
      expect(result.excerpt).not.toMatch(/(?:^|[^\p{L}\p{N}_])_|_(?:$|[^\p{L}\p{N}_])/u);
    }
  });

  // OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1: every `_` used to be stripped, so the live excerpt for
  // get_market_regime read "TRENDINGUP TRENDINGDOWN" and a cross-reference read
  // "scantradecalls" — invalid enum values and tool names, handed to the agents this tool steers.
  it('excerpt keeps identifiers intact (scan_trade_calls, TRENDING_UP) and still strips _emphasis_', async () => {
    const { engine, cleanup } = await makeEngine({
      ...FIXTURE_BUNDLE,
      tools: [
        ...FIXTURE_BUNDLE.tools.filter((t) => t.name !== 'get_market_regime'), // BM25 needs ≥ 3 docs
        {
          name: 'get_market_regime',
          description:
            'Returns the market regime — TRENDING_UP TRENDING_DOWN RANGING VOLATILE. Whole-market scan: scan_trade_calls. ' +
            'Read the _italic_ note and the __bold__ one; x__y stays.',
          parameters: {},
        },
      ],
    });
    cleanups.push(cleanup);

    const [hit] = await engine.query('market regime', 1);
    expect(hit?.title).toBe('get_market_regime');
    expect(hit.excerpt).toContain('TRENDING_UP TRENDING_DOWN');
    expect(hit.excerpt).toContain('scan: scan_trade_calls.');
    expect(hit.excerpt).toContain('Read the italic note and the bold one; x__y stays.');
    expect(hit.excerpt).not.toContain('TRENDINGUP');
    expect(hit.excerpt).not.toContain('scantradecalls');
  });
});
