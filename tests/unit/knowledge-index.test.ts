/**
 * AV-CHAT-MCP-W1 (C4) — vitest canary for src/lib/knowledge-index.ts.
 *
 * Locks the KnowledgeIndex invariants:
 *   - build() reads JSON, validates via formatKnowledgeBundle, populates docs.
 *   - getBM25Index() returns truthy after successful build.
 *   - Every bundle.tools[i] becomes a searchable doc.
 *   - getDoc returns the doc by id.
 *   - Missing bundle file → empty index (graceful, no throw).
 *   - Malformed bundle JSON → throws (caller can decide to retry / log).
 *   - Build is idempotent: calling build() twice with the same file is safe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';

const FIXTURE_BUNDLE = {
  version: '1.99.0',
  generated_at: '2026-05-18T00:00:00.000Z',
  package_name: 'crypto-quant-signal-mcp',
  description: 'AlgoVault test fixture',
  keywords: ['test', 'fixture'],
  whats_new: 'fixture-only',
  tools: [
    {
      name: 'get_trade_call',
      description: 'Composite trade call across 5 exchanges; returns verdict, confidence, regime.',
      parameters: { coin: 'string', timeframe: 'string', exchange: 'string', includeReasoning: 'boolean' },
    },
    {
      name: 'scan_funding_arb',
      description: 'Cross-venue funding arbitrage scanner across Binance/Bybit/HL/OKX/Bitget.',
      parameters: { minSpreadBps: 'number', limit: 'number' },
    },
    {
      name: 'get_market_regime',
      description: 'Market regime classifier returning TRENDING_UP/DOWN/RANGING/VOLATILE label.',
      parameters: { coin: 'string', timeframe: 'string', exchange: 'string' },
    },
    {
      name: 'get_trade_signal',
      description: 'Alias of get_trade_call for backward compatibility.',
      parameters: { coin: 'string' },
    },
  ],
  response_shapes: [
    {
      endpoint: '/api/search',
      snapshot_date: '2026-05-18',
      allowed_keys: ['query', 'results'],
      forbidden_keys: ['outcome_return_pct'],
      error_contract: {},
      cache_contract: {},
      consumers: ['search_knowledge'],
      drift_check_command: 'curl ... && echo DRIFT_CHECK_OK',
    },
  ],
  integrations: [
    {
      framework: 'langchain',
      title: 'AlgoVault × LangChain integration',
      content_markdown: 'Use MultiServerMCPClient to wire up tools.',
      url: 'https://algovault.com/integrations/langchain',
    },
  ],
  examples: [],
  discussions: [],
  pages: [], // BUNDLE-EXPAND-BLOG-W1 made `pages` a required KnowledgeBundle field
  _algovault: {
    bundle_version: 2, // BUNDLE-EXPAND-BLOG-W1 bumped the schema 1 → 2
    generator: 'build-knowledge-json.mjs',
    repo: 'AlgoVaultLabs/crypto-quant-signal-mcp',
  },
};

describe('KnowledgeIndex (AV-CHAT-MCP-W1 C1)', () => {
  const created: KnowledgeIndex[] = [];

  afterEach(() => {
    for (const idx of created) idx.stopWatching();
    created.length = 0;
  });

  function makeFixtureFile(bundle: unknown = FIXTURE_BUNDLE): string {
    const dir = mkdtempSync(join(tmpdir(), 'algovault-knowledge-test-'));
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify(bundle));
    return file;
  }

  it('builds from a valid fixture bundle and exposes the BM25 engine', async () => {
    const file = makeFixtureFile();
    const idx = new KnowledgeIndex(file);
    created.push(idx);
    await idx.build();

    expect(idx.getBM25Index()).toBeTruthy();
    expect(idx.getBundle()?.version).toBe('1.99.0');
  });

  it('flattens every bundle.tools[i] into a searchable doc', async () => {
    const file = makeFixtureFile();
    const idx = new KnowledgeIndex(file);
    created.push(idx);
    await idx.build();

    for (const t of FIXTURE_BUNDLE.tools) {
      const doc = idx.getDoc(`tool:${t.name}`);
      expect(doc).toBeDefined();
      expect(doc!.name).toBe(t.name);
      expect(doc!._source_type).toBe('tool');
      expect(doc!._source_url).toContain('algovault.com');
    }
  });

  // OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1: bundle.tools[i].parameters is the tool's JSON Schema
  // (projected from tools/list). The doc used to index Object.keys(parameters) — `type, properties,
  // required` — so no parameter name or description was ever searchable.
  it('a tool doc names its parameters and their descriptions — never the JSON-Schema keys', async () => {
    const schemaTool = {
      name: 'scan_market_regimes',
      description: 'Screens a whole crypto perpetual futures venue by market regime.',
      parameters: {
        type: 'object',
        properties: {
          regime: { type: 'string', description: 'Only coins in this regime, e.g. TRENDING_UP.' },
          maxRegimeAgeBars: { type: 'integer', description: 'Only coins whose regime changed within this many closed bars.' },
          coins: { type: 'array' },
        },
        required: [],
        additionalProperties: false,
      },
    };
    const file = makeFixtureFile({ ...FIXTURE_BUNDLE, tools: [...FIXTURE_BUNDLE.tools, schemaTool] });
    const idx = new KnowledgeIndex(file);
    created.push(idx);
    await idx.build();

    const doc = idx.getDoc('tool:scan_market_regimes')!;
    expect(doc).toBeDefined();
    expect(doc.content_markdown).toContain('Parameters: regime, maxRegimeAgeBars, coins\n');
    expect(doc.content_markdown).toContain('- regime: Only coins in this regime, e.g. TRENDING_UP.');
    expect(doc.content_markdown).toContain('- maxRegimeAgeBars: Only coins whose regime changed within this many closed bars.');
    expect(doc.content_markdown).toMatch(/^- coins$/m); // an undescribed parameter is still named
    expect(doc.content_markdown).not.toMatch(/Parameters: .*\b(type|properties|required|additionalProperties)\b/);
    // The excerpt source stays the description: parameters are indexed, not quoted.
    expect(doc._excerpt_source).toBe(schemaTool.description);

    // The caller-visible consequence: a parameter name and a usage phrase each reach the tool.
    const engine = idx.getBM25Index()!;
    expect(engine.search('maxRegimeAgeBars')[0]?.[0]).toBe('tool:scan_market_regimes');
    expect(engine.search('changed within closed bars')[0]?.[0]).toBe('tool:scan_market_regimes');
  });

  it('flattens response_shapes + integrations into searchable docs', async () => {
    const file = makeFixtureFile();
    const idx = new KnowledgeIndex(file);
    created.push(idx);
    await idx.build();

    const rs = idx.getDoc('response_shape:/api/search');
    expect(rs).toBeDefined();
    expect(rs!._source_type).toBe('response_shape');

    const integ = idx.getDoc('integration:langchain');
    expect(integ).toBeDefined();
    expect(integ!._source_type).toBe('integration');
    expect(integ!._source_url).toBe('https://algovault.com/integrations/langchain');
  });

  it('handles missing bundle file gracefully (empty index, no throw)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'algovault-knowledge-empty-'));
    const file = join(dir, 'never-written.json');
    const idx = new KnowledgeIndex(file);
    created.push(idx);
    await idx.build();

    expect(idx.getBM25Index()).toBeNull();
    expect(idx.getBundle()).toBeNull();
    expect(idx.getDoc('tool:get_trade_call')).toBeUndefined();
  });

  it('throws on malformed bundle JSON (rejects {} as input)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'algovault-knowledge-bad-'));
    const file = join(dir, 'latest.json');
    writeFileSync(file, '{}');
    const idx = new KnowledgeIndex(file);
    created.push(idx);
    await expect(idx.build()).rejects.toThrow();
  });

  it('build() is idempotent — calling twice yields the same doc set', async () => {
    const file = makeFixtureFile();
    const idx = new KnowledgeIndex(file);
    created.push(idx);
    await idx.build();
    const firstBundle = idx.getBundle();
    await idx.build();
    const secondBundle = idx.getBundle();
    expect(secondBundle?.version).toBe(firstBundle?.version);
    expect(idx.getDoc('tool:get_trade_call')).toBeDefined();
  });
});
