/**
 * Single-SoT data layer for the 3 Integration surfaces.
 *
 * Consumed by:
 *   - src/lib/mcp-usage-docs.ts  (renders docs.html#integration H2 + 3 H3s)
 *   - scripts/render-integrations.mjs  (renders per-slug landing pages)
 *   - landing/integrations.html  (3-section index page; the card grids are
 *     GENERATED — scripts/build_landing.mjs fills each
 *     <!-- BUILD:INTEGRATIONS_INDEX_* --> block from renderIndexGrid(); do not
 *     hand-edit inside a BUILD block, `build_landing --check` will fail)
 *   - src/index.ts  (Express route allow-list reads slugs from hasDedicatedPage:true entries)
 *   - scripts/render-jsx-static.mjs  (landing/index.html quickstart client grid —
 *     renders EVERY entry, deliberately unfiltered by hasDedicatedPage)
 *
 * Introduced via the Fix-at-Generator refactor of the integration surfaces.
 *
 * _(Comment corrected 2026-08-05 LANDING-MCP-CLIENT-REGISTRY-W1 — the prior text
 * called landing/integrations.html "static, manually curated". It has been
 * generator-filled since INTEGRATIONS-FULL-STACK-W1 C3, and that stale line is
 * what led a later spec to propose a second, parallel MCP-client registry.)_
 */

export type SurfaceType = 'mcp-client' | 'ai-agent' | 'exchange-kit';

/**
 * How a caller reaches AlgoVault. Orthogonal to `surfaceType`, which says which
 * page section an entry belongs to.
 *
 *   native     — an app that speaks MCP itself; you add a server to it.
 *   api-level  — no client to install; the model provider's own API dials the
 *                MCP server server-side (e.g. a `tools:[{type:"mcp"}]` block).
 *   byo-model  — not an MCP client at all: a model you point an existing MCP
 *                client at. Rendering one as a peer of a native client is a
 *                factual error, pinned by the `byo-model` assertions in
 *                tests/unit/integrations-data.test.ts.
 */
export type ClientKind = 'native' | 'api-level' | 'byo-model';

export interface IntegrationEntry {
  /**
   * URL slug (kebab-case). IMMUTABLE ANCHOR — it is simultaneously the
   * /integrations/<slug> path segment, the sitemap entry, the src/index.ts
   * allow-list token and the docs/integrations/**\/<slug>.md filename.
   * Renaming one silently 404s a live page; add a new slug instead.
   */
  slug: string;
  /** Human-readable name shown in the table row and walkthrough summary. */
  displayName: string;
  /** Which surface this entry belongs to. */
  surfaceType: SurfaceType;
  /**
   * HTML for the "Setup" table cell. Brief; may contain <code> and <em>.
   * No newlines (renders into a single <td>).
   */
  setupSummary: string;
  /**
   * HTML for the "What you get" table cell. Brief; may contain <code>.
   * No newlines.
   */
  whatYouGet: string;
  /**
   * Override for the <details><summary> text. Default is
   * "<displayName> &mdash; setup walkthrough". Plain HTTP/curl uses
   * "Plain HTTP / curl &mdash; advanced testing" instead.
   */
  walkthroughSummary?: string;
  /**
   * HTML body inside the <details> block's <div class="px-5 pb-5 pt-2 ...">
   * wrapper. May contain multiple <p> + <div class="code-block">...</div>
   * children. 5-25 lines typical.
   */
  walkthroughHtml: string;
  /**
   * Canonical full-tutorial URL. For hasDedicatedPage:true entries this is
   * the per-slug landing page (e.g. https://algovault.com/integrations/binance).
   * For hasDedicatedPage:false entries this is an empty string OR an upstream
   * doc URL — the renderer skips the "Full tutorial" CTA in the walkthrough.
   */
  fullTutorialUrl: string;
  /**
   * Whether scripts/render-integrations.mjs should generate a dedicated
   * landing/integrations/<slug>.html page. Plain HTTP/curl is false (it's
   * a transport, not a client — table-row + inline walkthrough only).
   */
  hasDedicatedPage: boolean;
  // ── Optional trailing fields (LANDING-MCP-CLIENT-REGISTRY-W1) ──
  // Deliberately OPTIONAL and TRAILING: ai-agents.ts and exchange-kits.ts share
  // this interface, so a required field here would force an edit to all three
  // data files plus every renderer that constructs an entry. Populated on the
  // mcp-clients surface today; the other two surfaces may adopt them later
  // without a cascade.
  /**
   * How this entry reaches AlgoVault. See ClientKind. Absent = treat as
   * 'native' (the historical default for every pre-existing entry).
   */
  kind?: ClientKind;
  /**
   * Vendor documentation URL that `setupSummary` was verified against. Required
   * in practice for every mcp-clients row — a connect string with no primary
   * source does not ship.
   */
  source?: string;
  /**
   * ISO date `setupSummary` was last checked against `source`. Vendor UI paths
   * drift; scripts/check-mcp-client-copy.mjs REPORTS any row older than 180
   * days, naming the row and its source.
   */
  verifiedAt?: string;
}

/**
 * Per-surface metadata: anchor IDs, intro copy, footer "verified against"
 * link list, optional CTA paragraph.
 */
export interface SurfaceMeta {
  /** anchor id on docs.html#integration H3 (e.g. 'connect-mcp'). */
  anchorId: string;
  /** H3 heading text (e.g. 'Connect Your MCP Client'). */
  title: string;
  /** Tailwind margin-top class on the H3 ('mt-8' for first H3, 'mt-12' for subsequent). */
  marginTopClass: string;
  /** HTML for the intro paragraph that follows the H3. */
  introHtml: string;
  /** First column header for the table (e.g. 'Surface' / 'Framework' / 'Exchange'). */
  firstColumnHeader: string;
  /** Date the footer 'verified against' line cites (e.g. '2026-04-30'). */
  footerVerifiedDate: string;
  /** Footer preamble before the link list (e.g. 'Config formats verified ... against:'). */
  footerPreamble: string;
  /** Footer drift note after the link list (e.g. 'Config formats can drift ...'). */
  footerDriftNote: string;
  /** Footer link list. Rendered as ' &middot; '-separated <a> tags. */
  footerLinks: Array<{ label: string; href: string }>;
  /**
   * Optional CTA paragraph emitted AFTER the footer. Currently only the AI
   * Agent surface uses this. HTML body, no wrapping <p> (renderer adds wrapper).
   */
  ctaParagraphHtml?: string;
}

/**
 * A complete surface module — what each data file exports as its default.
 */
export interface SurfaceModule {
  meta: SurfaceMeta;
  entries: IntegrationEntry[];
}
