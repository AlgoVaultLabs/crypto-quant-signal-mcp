/**
 * BUNDLE-EXPAND-BLOG-W1 (C3) — end-to-end bundle.pages[] flow.
 *
 * 1. Build a fresh KnowledgeBundle with empty pages[]
 * 2. Run formatKnowledgeBundle() validator → accepts bundle_version: 2
 * 3. Insert mock pages from each of the 4 source_types
 * 4. KnowledgeIndex picks up pages → BM25 surfaces them via SearchEngine
 *
 * Asserts the wave's compounding-knowledge invariant: dev.to / Medium /
 * YouTube / GitHub Discussions content flows through the BM25 index AND is
 * queryable via SearchEngine end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatKnowledgeBundle,
  type KnowledgeBundle,
  type KnowledgeBundlePage,
} from '../../src/lib/knowledge-formatter.js';
import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { SearchEngine, type SearchResult } from '../../src/lib/search-engine.js';
import { ResultCache } from '../../src/lib/result-cache.js';

const FOUR_PAGES: KnowledgeBundlePage[] = [
  {
    source_type: 'devto',
    source_url: 'https://dev.to/algovaultlabs/the-data-flywheel',
    title: 'The data flywheel',
    published_at: '2026-05-19T08:00:00Z',
    content_markdown:
      'AlgoVault publishes signals every minute; the data flywheel turns each call into a measurement.',
    author: 'algovaultlabs',
    tags: ['crypto', 'flywheel'],
  },
  {
    source_type: 'medium',
    source_url: 'https://medium.com/@algovault/cross-venue-funding',
    title: 'Cross-venue funding arbitrage',
    published_at: '2026-05-18T10:00:00Z',
    content_markdown:
      'Cross-venue funding arbitrage is the simplest cash-and-carry trade an AI agent can run continuously.',
    author: 'AlgoVault Labs',
  },
  {
    source_type: 'youtube',
    source_url: 'https://www.youtube.com/watch?v=abc',
    title: 'How AlgoVault works under the hood',
    published_at: '2026-05-17T12:00:00Z',
    content_markdown:
      'Walkthrough of the signal aggregation pipeline behind the AlgoVault MCP server. We cover cross-venue funding scans and regime classification.',
    author: 'AlgoVault Labs',
    thumbnail_url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
  },
  {
    source_type: 'github_discussion',
    source_url: 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/12',
    title: 'v1.15.0 — new chat_knowledge tool',
    published_at: '2026-05-18T10:00:00Z',
    content_markdown:
      'We just shipped chat_knowledge as a new MCP tool. Agents ask natural-language questions about AlgoVault and get cited answers.',
    author: 'AlgoVaultLabs',
    tags: ['Announcements'],
  },
];

const FIXTURE_BUNDLE = {
  version: '1.99.99',
  generated_at: '2026-05-19T18:00:00Z',
  package_name: 'crypto-quant-signal-mcp',
  description: 'fixture',
  keywords: ['fixture'],
  whats_new: 'fixture-only',
  tools: [],
  response_shapes: [],
  integrations: [],
  examples: [],
  discussions: [],
  pages: FOUR_PAGES,
  pages_refreshed_at: '2026-05-19T06:00:00Z',
  _algovault: {
    bundle_version: 2,
    generator: 'build-knowledge-json.mjs',
    repo: 'AlgoVaultLabs/crypto-quant-signal-mcp',
  },
};

describe('BUNDLE-EXPAND-BLOG-W1: end-to-end pages flow', () => {
  let tmpDir: string;
  let bundlePath: string;
  let index: KnowledgeIndex;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'algovault-bundle-flow-'));
    bundlePath = join(tmpDir, 'latest.json');
    writeFileSync(bundlePath, JSON.stringify(FIXTURE_BUNDLE));
    index = new KnowledgeIndex(bundlePath);
    await index.build();
  });

  afterEach(() => {
    index.stopWatching();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('formatKnowledgeBundle accepts v2 bundle with 4 pages', () => {
    const reshaped: KnowledgeBundle = formatKnowledgeBundle(FIXTURE_BUNDLE);
    expect(reshaped._algovault.bundle_version).toBe(2);
    expect(reshaped.pages).toHaveLength(4);
    expect(reshaped.pages_refreshed_at).toBe('2026-05-19T06:00:00Z');
    const sourceTypes = reshaped.pages.map((p) => p.source_type).sort();
    expect(sourceTypes).toEqual(['devto', 'github_discussion', 'medium', 'youtube']);
  });

  it('SearchEngine surfaces pages via BM25 query', async () => {
    const cache = new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 });
    const engine = new SearchEngine(index, cache);
    const results = await engine.query('cross-venue funding arbitrage flywheel', 10);
    // At least one of top-N is a page (BM25 may also surface internal records,
    // so we use at-least-one-in-top-N inclusion gate per CLAUDE.md verification
    // pattern, not exact-top-N).
    const pageHits = results.filter((r) => r.source_type.startsWith('page_'));
    expect(pageHits.length).toBeGreaterThan(0);
  });

  it('rejects v1 bundle (forward-only schema)', () => {
    const v1Bundle = { ...FIXTURE_BUNDLE, _algovault: { ...FIXTURE_BUNDLE._algovault, bundle_version: 1 } };
    expect(() => formatKnowledgeBundle(v1Bundle)).toThrowError(/bundle_version: expected 2/);
  });

  it('rejects unknown source_type in pages[]', () => {
    const badBundle = {
      ...FIXTURE_BUNDLE,
      pages: [{ ...FOUR_PAGES[0], source_type: 'algovault_blog' }],
    };
    expect(() => formatKnowledgeBundle(badBundle)).toThrowError(/expected one of/);
  });
});
