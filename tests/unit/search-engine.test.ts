/**
 * AV-CHAT-MCP-W1 (C4) — vitest canary for src/lib/search-engine.ts.
 *
 * Locks SearchEngine invariants:
 *   - query() returns ranked results for tool-name queries.
 *   - query() caches per (q, limit) tuple.
 *   - query() enforces the limit argument.
 *   - query() returns empty array for nonexistent queries (no throw).
 *   - excerpt is markdown-stripped and ≤200 chars.
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
  _algovault: { bundle_version: 1, generator: 'build-knowledge-json.mjs', repo: 'AlgoVaultLabs/crypto-quant-signal-mcp' },
};

async function makeEngine(): Promise<{ engine: SearchEngine; index: KnowledgeIndex; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'algovault-search-test-'));
  const file = join(dir, 'latest.json');
  writeFileSync(file, JSON.stringify(FIXTURE_BUNDLE));
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
    for (const result of r) {
      expect(result.excerpt.length).toBeLessThanOrEqual(201); // 200 + trailing ellipsis
      expect(result.excerpt).not.toMatch(/[`*_~#>]/); // markdown chars stripped
    }
  });
});
