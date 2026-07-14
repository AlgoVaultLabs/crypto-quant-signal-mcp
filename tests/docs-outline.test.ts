import { describe, it, expect } from 'vitest';
import {
  buildDocsOutline,
  flattenOutline,
  sidebarEntries,
  partialIds,
  markerNames,
  allAnchorIds,
  toolNodeCount,
  channelNodeCount,
  CONNECT_SURFACE_EXPECTATIONS,
  type DocsNode,
} from '../src/lib/docs-outline.js';
import { FEATURE_REGISTRY, publicToolNames, type FeatureSpec } from '../src/lib/feature-registry.js';
import { CHANNELS } from '../src/lib/channel-registry.js';
import MCP_CLIENTS from '../src/lib/integrations-data/mcp-clients.js';
import AI_AGENTS from '../src/lib/integrations-data/ai-agents.js';
import EXCHANGE_KITS from '../src/lib/integrations-data/exchange-kits.js';

const flat = () => flattenOutline();
const byAnchor = (a: string) => flat().find((n) => n.anchor === a);

describe('docs-outline — Tools derive from the public-tool set (nav publicToolEntries)', () => {
  it('has exactly 6 Tools H3s, in registry order, incl scan_trade_calls (back-fill)', () => {
    const toolAnchors = flat()
      .filter((n) => n.level === 3 && ['get-trade-call', 'get-market-regime', 'scan-funding-arb', 'scan-trade-calls', 'chat-knowledge', 'search-knowledge'].includes(n.anchor))
      .map((n) => n.anchor);
    expect(toolAnchors).toEqual([
      'get-trade-call',
      'get-market-regime',
      'scan-funding-arb',
      'scan-trade-calls', // ← proves the previously-undocumented scanner is back-filled
      'chat-knowledge',
      'search-knowledge',
    ]);
    expect(toolNodeCount()).toBe(publicToolNames().length);
    expect(toolNodeCount()).toBe(6);
  });

  it('carries the dictated friendly labels (single-derived from TOOL_LABELS)', () => {
    expect(byAnchor('get-trade-call')?.label).toBe('Trade Call');
    expect(byAnchor('get-market-regime')?.label).toBe('Market Regime');
    expect(byAnchor('scan-funding-arb')?.label).toBe('Funding Arbitrage');
    expect(byAnchor('scan-trade-calls')?.label).toBe('Trade Call Scanner');
    expect(byAnchor('chat-knowledge')?.label).toBe('Knowledge Chat');
    expect(byAnchor('search-knowledge')?.label).toBe('Knowledge Search');
  });

  it('excludes equities (publicListing:false) from the docs Tools', () => {
    const anchors = allAnchorIds();
    expect(anchors).not.toContain('get-equity-call');
    expect(anchors).not.toContain('get-equity-regime');
    expect(flat().some((n) => n.label.toLowerCase().includes('equit'))).toBe(false);
  });

  it('LIVE-derives the tool set — flipping publicListing:false drops that H3', () => {
    const withoutTradeCall: FeatureSpec[] = FEATURE_REGISTRY.map((f) =>
      f.name === 'get_trade_call' ? { ...f, publicListing: false } : f,
    );
    expect(toolNodeCount(withoutTradeCall)).toBe(publicToolNames().length - 1);
    const outline = buildDocsOutline(withoutTradeCall);
    expect(flattenOutline(outline).some((n) => n.anchor === 'get-trade-call')).toBe(false);
  });

  it('a NEW public tool cannot appear unlabeled — it forces a label decision (throws)', () => {
    const withMock: FeatureSpec[] = [
      ...FEATURE_REGISTRY,
      { ...FEATURE_REGISTRY[0], name: 'mock_new_tool', aliases: [] },
    ];
    expect(() => buildDocsOutline(withMock)).toThrow(/mock_new_tool/);
  });
});

describe('docs-outline — Channels derive from the channel SoT', () => {
  it('has exactly 4 Channels H3s, in SoT order', () => {
    expect(channelNodeCount()).toBe(CHANNELS.length);
    expect(channelNodeCount()).toBe(4);
    const channelNodes = flat().filter((n) => n.id.startsWith('channel-'));
    expect(channelNodes.map((n) => n.anchor)).toEqual(['mcp', 'rest-api', 'webhooks', 'telegram']);
    expect(channelNodes.map((n) => n.label)).toEqual(['MCP Server', 'REST API', 'Webhooks', 'Telegram Bot']);
  });

  it('each channel section carries its hub CTA href (absolute apex — reuses channelHref, cross-host-safe)', () => {
    expect(byAnchor('mcp')?.ctaHref).toBe('https://algovault.com/mcp');
    expect(byAnchor('rest-api')?.ctaHref).toBe('https://algovault.com/rest-api');
    expect(byAnchor('webhooks')?.ctaHref).toBe('https://algovault.com/webhooks');
    expect(byAnchor('telegram')?.ctaHref).toBe('https://t.me/algovaultofficialbot');
  });
});

describe('docs-outline — Ecosystem connect H4s stay single-derived from integrations-data surfaces', () => {
  it('the 3 marker-filled connect H4 {label,anchor} equal the surface metas (no forked label)', () => {
    const surfaces = { 'connect-mcp-client': MCP_CLIENTS, 'connect-ai-agent': AI_AGENTS, 'connect-exchange-kit': EXCHANGE_KITS } as const;
    for (const exp of CONNECT_SURFACE_EXPECTATIONS) {
      const surface = surfaces[exp.marker as keyof typeof surfaces];
      expect(exp.anchorId).toBe(surface.meta.anchorId);
      expect(exp.title).toBe(surface.meta.title);
      const node = flat().find((n) => n.body.kind === 'marker' && n.body.name === exp.marker) as DocsNode | undefined;
      expect(node).toBeDefined();
      expect(node!.anchor).toBe(surface.meta.anchorId);
      expect(node!.label).toBe(surface.meta.title);
    }
  });

  it('emits exactly the 3 connect surface markers (build_landing fill slots)', () => {
    expect(markerNames()).toEqual(['connect-mcp-client', 'connect-ai-agent', 'connect-exchange-kit']);
  });

  it('Connect Your Trading Platform is a CH2-authored partial (no surface yet)', () => {
    const tp = byAnchor('connect-trading-platform');
    expect(tp?.body.kind).toBe('partial');
    expect(tp?.label).toBe('Connect Your Trading Platform');
  });
});

describe('docs-outline — Single-Derivation invariants (sidebar === body === outline)', () => {
  it('every node has a non-empty, slug-shaped anchor', () => {
    for (const n of flat()) {
      expect(n.anchor).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('no duplicate anchor id across canonical + aliases (no id collision)', () => {
    const ids = allAnchorIds();
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it('tool subsections are body-only (not sidebar entries)', () => {
    const sidebar = sidebarEntries().map((e) => e.anchor);
    expect(sidebar).not.toContain('tools-when-to-use');
    expect(sidebar).not.toContain('tools-worked-examples');
    expect(sidebar).not.toContain('tools-rate-limits');
    // …but their bodies + alias anchors still exist
    expect(allAnchorIds()).toEqual(expect.arrayContaining(['tools-when-to-use', 'knowledge-tools-when']));
  });

  it('partial ids and marker names are disjoint (each node body has ONE source)', () => {
    const p = new Set(partialIds());
    for (const m of markerNames()) expect(p.has(m)).toBe(false);
  });

  it('every positioning-insensitive legacy anchor survives as canonical or outline alias', () => {
    const ids = new Set(allAnchorIds());
    for (const legacy of [
      'get-trade-signal',
      'knowledge-tools-chat',
      'knowledge-tools-search',
      'knowledge-tools-when',
      'knowledge-tools-examples',
      'knowledge-tools-quota',
      'knowledge-tools-overview',
      'testing-with-curl',
      'rest-api',
      'on-chain-verification',
      'usage-examples',
    ]) {
      expect(ids.has(legacy)).toBe(true);
    }
    // #x402 + #knowledge-tools-api are POSITIONED inside channel-rest-api.html (not outline aliases,
    // so build_channel_pages can extract each code block by anchor) — verified by the CH4 docs.html grep.
    expect(ids.has('x402')).toBe(false);
    expect(ids.has('knowledge-tools-api')).toBe(false);
  });

  it('top-level IA matches the dictated tree (Quick Start · Platform · Track Record · Pricing · FAQ)', () => {
    expect(buildDocsOutline().map((n) => n.anchor)).toEqual(['quick-start', 'platform', 'track-record', 'pricing', 'faq']);
  });
});
