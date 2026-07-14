/**
 * docs-outline.ts — DOCS-GENERATOR-FROM-NAV-SOT-W1 (CH1)
 *
 * The ONE source of truth for the structure of landing/docs.html. The sidebar,
 * the body section order, and every anchor id all PROJECT from this tree
 * (Single-Derivation LAW). `scripts/build_docs.mjs` renders both surfaces from
 * `buildDocsOutline()`; a missing partial for any `body.kind === 'partial'`
 * node is a CONSCIOUS build failure, never a silent drop.
 *
 * AUTO-FOLLOW (the "docs follows automatically" requirement):
 *   - H1/H2 skeleton + Ecosystem H4s + Quick Start/Pricing/FAQ/Track Record are
 *     CURATED nodes here.
 *   - Tools H3s DERIVE from `publicToolEntries()` (nav-manifest.ts → the SAME ONE
 *     label+anchor source the nav Platform▸Tools column and /tools index use;
 *     A1 ruling — REUSE, do NOT add a 2nd label field). A new public tool
 *     (feature-registry `publicListing !== false`) becomes a new H3 automatically,
 *     in registry order. This is what back-fills `scan_trade_calls`.
 *   - Channels H3s DERIVE from `CHANNELS` (channel-registry.ts). A new channel
 *     becomes a new H3 automatically.
 *   - The 3 Ecosystem "Connect Your …" H4 bodies are filled at build time by
 *     build_landing from the integrations-data surfaces (renderSurfaceSection),
 *     so they auto-follow new integrations (CH2 ruling D). Their label+anchor are
 *     asserted === the surface metas by the CH1 drift test (no forked label).
 *
 * NB: this module derives PRESENTATION (labels via TOOL_LABELS/CHANNELS) and
 * MEMBERSHIP (publicToolNames / CHANNELS) from existing SoTs; it never re-lists
 * tools or channels by hand, and it never re-orders where a registry defines order.
 */

import { FEATURE_REGISTRY, type FeatureSpec } from './feature-registry.js';
import { publicToolEntries } from './nav-manifest.js';
import { CHANNELS, channelHref, type ChannelSpec } from './channel-registry.js';

/** How a node's BODY is sourced by build_docs. */
export type DocsBody =
  /** A hand/migrated partial at docs-src/partials/<id>.html (missing → build fails). */
  | { kind: 'partial' }
  /** A build_landing BUILD:<name> marker slot (build_docs emits it EMPTY; build_landing fills it). */
  | { kind: 'marker'; name: string }
  /** A structural group header with an optional intro partial (docs-src/partials/<id>.html). */
  | { kind: 'group'; intro: boolean };

export interface DocsNode {
  /** Stable node id. Also the partial filename stem for `body.kind === 'partial'|'group'`. */
  id: string;
  /** Heading level → sidebar nesting depth (1=H1 … 4=H4; `intro` for the top Quick Start). */
  level: 1 | 2 | 3 | 4;
  /** Sidebar + heading text. */
  label: string;
  /** Canonical `#anchor` id for this section. */
  anchor: string;
  /** Legacy anchor ids to ALSO emit (empty <span id>) so inbound links never 404. */
  aliases?: string[];
  /** Canonical MCP tool name shown alongside the friendly heading (tool nodes only). */
  codeName?: string;
  /** How build_docs sources the body. */
  body: DocsBody;
  /** Channel nodes only: the hub href (channelHref) — the SoT for the Channels→hub mapping (CH1-tested).
   *  Non-channel sections carry their own contextual CTAs inside their partials. */
  ctaHref?: string;
  /** True → present in the BODY (+ its anchor/aliases) but NOT a sidebar entry (tool subsections). */
  sidebarHidden?: boolean;
  children?: DocsNode[];
}

/** Legacy tool anchors that must survive as aliases when the canonical slug differs. */
const TOOL_ANCHOR_ALIASES: Record<string, string[]> = {
  get_trade_call: ['get-trade-signal'],
  chat_knowledge: ['knowledge-tools-chat'],
  search_knowledge: ['knowledge-tools-search'],
};

/** Legacy channel-section anchors folded into each channel partial (no dead links). */
const CHANNEL_ANCHOR_ALIASES: Record<string, string[]> = {
  // Channels▸MCP Server carries the MCP-over-HTTP handshake (was #testing-with-curl),
  // kept DISTINCT from the MCP_CLIENTS surface table (CH2 ruling D). #connect-mcp
  // stays on the Ecosystem "Connect Your MCP Client" surface (its content home).
  mcp: ['testing-with-curl'],
  // NB: #x402 + #knowledge-tools-api are NOT outline aliases — they live POSITIONED on their
  // <h4>s inside channel-rest-api.html so build_channel_pages' per-anchor extractFirstPre()
  // resolves each to its own code block. Bunching them here as adjacent top-of-section spans
  // broke that extraction (the /rest-api hub code-ref link flipped). Verified present by the CH4 grep.
};

/** Tools subsections — migrated + generalised from #knowledge-tools-*, body-only (not sidebar H3s). */
const TOOL_SUBSECTIONS: DocsNode[] = [
  { id: 'tools-when-to-use', level: 4, label: 'When to use which', anchor: 'tools-when-to-use', aliases: ['knowledge-tools-when'], body: { kind: 'partial' }, sidebarHidden: true },
  { id: 'tools-worked-examples', level: 4, label: 'Worked examples', anchor: 'tools-worked-examples', aliases: ['knowledge-tools-examples'], body: { kind: 'partial' }, sidebarHidden: true },
  { id: 'tools-rate-limits', level: 4, label: 'Rate limits & cost', anchor: 'tools-rate-limits', aliases: ['knowledge-tools-quota'], body: { kind: 'partial' }, sidebarHidden: true },
];

/**
 * Ecosystem ▸ Integration ▸ Connect H4s. The first 3 are FILLED by build_landing
 * from the integrations-data surfaces (renderSurfaceSection → auto-follow); their
 * {label, anchor} MUST equal the surface metas (asserted by the CH1 drift test —
 * see CONNECT_SURFACE_EXPECTATIONS). The 4th is a CH2-authored partial (no surface
 * yet); extend the marker pattern to a 4th slot if a TRADING_PLATFORMS surface lands.
 */
const CONNECT_H4S: DocsNode[] = [
  { id: 'connect-mcp-client', level: 4, label: 'Connect Your MCP Client', anchor: 'connect-mcp', body: { kind: 'marker', name: 'connect-mcp-client' } },
  { id: 'connect-ai-agent', level: 4, label: 'Connect Your AI Agent', anchor: 'connect-ai-agent', body: { kind: 'marker', name: 'connect-ai-agent' } },
  { id: 'connect-exchange-kit', level: 4, label: 'Connect Your Exchange Kit', anchor: 'connect-exchange-kit', body: { kind: 'marker', name: 'connect-exchange-kit' } },
  { id: 'connect-trading-platform', level: 4, label: 'Connect Your Trading Platform', anchor: 'connect-trading-platform', body: { kind: 'partial' } },
];

/**
 * The drift contract the CH1 test enforces: each marker-filled connect H4's
 * {label, anchor} equals the integrations-data surface it renders. Keeps the docs
 * H4 label single-derived from the surface meta (no forked label) without importing
 * integrations-data into this module at runtime.
 */
export const CONNECT_SURFACE_EXPECTATIONS: Array<{ marker: string; anchorId: string; title: string }> = [
  { marker: 'connect-mcp-client', anchorId: 'connect-mcp', title: 'Connect Your MCP Client' },
  { marker: 'connect-ai-agent', anchorId: 'connect-ai-agent', title: 'Connect Your AI Agent' },
  { marker: 'connect-exchange-kit', anchorId: 'connect-exchange-kit', title: 'Connect Your Exchange Kit' },
];

/** Tools H3s — one per publicly-listed tool, in registry order (REUSE nav publicToolEntries). */
function buildToolNodes(registry: readonly FeatureSpec[]): DocsNode[] {
  return publicToolEntries(registry).map((e) => ({
    id: e.anchor, // slug(name): get-trade-call, get-market-regime, scan-funding-arb, scan-trade-calls, chat-knowledge, search-knowledge
    level: 3 as const,
    label: e.label, // the ONE label source (TOOL_LABELS) — nav + /tools + docs
    anchor: e.anchor,
    aliases: TOOL_ANCHOR_ALIASES[e.name] ?? [],
    codeName: e.name, // the canonical tool name, rendered beside the friendly heading
    body: { kind: 'partial' as const },
  }));
}

/** Channels H3s — one per channel in the SoT, in SoT order; body links its hub. */
function buildChannelNodes(): DocsNode[] {
  return CHANNELS.map((c: ChannelSpec) => {
    const anchor = c.slug ?? c.key; // mcp | rest-api | webhooks | telegram
    return {
      id: `channel-${c.key}`,
      level: 3 as const,
      label: c.label,
      anchor,
      aliases: CHANNEL_ANCHOR_ALIASES[c.key] ?? [],
      body: { kind: 'partial' as const },
      ctaHref: channelHref(c), // /mcp · /rest-api · /webhooks · t.me/…
    };
  });
}

/**
 * Assemble the docs outline from the registries + curated nodes. `registry` is
 * injectable so tests can prove a new public tool adds an H3.
 */
export function buildDocsOutline(registry: readonly FeatureSpec[] = FEATURE_REGISTRY): DocsNode[] {
  const toolNodes = buildToolNodes(registry);
  const channelNodes = buildChannelNodes();

  return [
    // Top intro (retained verbatim).
    { id: 'quick-start', level: 2, label: 'Quick Start', anchor: 'quick-start', body: { kind: 'partial' } },

    // H1 Platform ▸ Tools / Channels / Ecosystem
    {
      id: 'platform',
      level: 1,
      label: 'Platform',
      anchor: 'platform',
      body: { kind: 'group', intro: false },
      children: [
        {
          id: 'tools',
          level: 2,
          label: 'Tools',
          anchor: 'tools',
          aliases: ['knowledge-tools-overview', 'knowledge-tools'],
          body: { kind: 'group', intro: true },
          children: [...toolNodes, ...TOOL_SUBSECTIONS],
        },
        {
          id: 'channels',
          level: 2,
          label: 'Channels',
          anchor: 'channels',
          body: { kind: 'group', intro: true },
          children: channelNodes,
        },
        {
          id: 'ecosystem',
          level: 2,
          label: 'Ecosystem',
          anchor: 'ecosystem',
          body: { kind: 'group', intro: true },
          children: [
            {
              id: 'integration',
              level: 3,
              label: 'Integration',
              anchor: 'integration',
              body: { kind: 'group', intro: true },
              children: CONNECT_H4S,
            },
            { id: 'skills-usage-examples', level: 3, label: 'Skills & Usage Examples', anchor: 'usage-examples', body: { kind: 'partial' } },
          ],
        },
      ],
    },

    // H1 Track Record ▸ Live Dashboard / Verify
    {
      id: 'track-record',
      level: 1,
      label: 'Track Record',
      anchor: 'track-record',
      body: { kind: 'group', intro: false },
      children: [
        { id: 'live-dashboard', level: 2, label: 'Live Dashboard', anchor: 'live-dashboard', body: { kind: 'partial' } },
        { id: 'verify', level: 2, label: 'Verify', anchor: 'verify', aliases: ['on-chain-verification'], body: { kind: 'partial' } },
      ],
    },

    // H1 Pricing (carries the BUILD:signup-flow marker) + H1 FAQ
    { id: 'pricing', level: 1, label: 'Pricing', anchor: 'pricing', body: { kind: 'partial' } },
    { id: 'faq', level: 1, label: 'FAQ', anchor: 'faq', body: { kind: 'partial' } },
  ];
}

// ── Projections consumed by build_docs.mjs + the CH5 canary ────────────────────

/** Depth-first flatten (parents before children), preserving order. */
export function flattenOutline(nodes: DocsNode[] = buildDocsOutline()): DocsNode[] {
  const out: DocsNode[] = [];
  const walk = (ns: DocsNode[]) => {
    for (const n of ns) {
      out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Sidebar entries in render order (excludes body-only subsections). */
export function sidebarEntries(nodes: DocsNode[] = buildDocsOutline()): Array<{ anchor: string; label: string; level: number }> {
  return flattenOutline(nodes)
    .filter((n) => !n.sidebarHidden)
    .map((n) => ({ anchor: n.anchor, label: n.label, level: n.level }));
}

/** Every node id whose body is a static partial (docs-src/partials/<id>.html must exist). */
export function partialIds(nodes: DocsNode[] = buildDocsOutline()): string[] {
  return flattenOutline(nodes)
    .filter((n) => n.body.kind === 'partial' || (n.body.kind === 'group' && n.body.intro))
    .map((n) => n.id);
}

/** Every build_landing marker slot build_docs must emit empty (in outline order). */
export function markerNames(nodes: DocsNode[] = buildDocsOutline()): string[] {
  return flattenOutline(nodes)
    .filter((n): n is DocsNode & { body: { kind: 'marker'; name: string } } => n.body.kind === 'marker')
    .map((n) => n.body.name);
}

/** Every anchor id that must appear as `id="…"` in docs.html (canonical + aliases). */
export function allAnchorIds(nodes: DocsNode[] = buildDocsOutline()): string[] {
  const ids: string[] = [];
  for (const n of flattenOutline(nodes)) {
    ids.push(n.anchor);
    if (n.aliases) ids.push(...n.aliases);
  }
  return ids;
}

/** Count of Tools H3s (=== publicToolNames().length). */
export function toolNodeCount(registry: readonly FeatureSpec[] = FEATURE_REGISTRY): number {
  return buildToolNodes(registry).length;
}

/** Count of Channels H3s (=== CHANNELS.length). */
export function channelNodeCount(): number {
  return buildChannelNodes().length;
}
