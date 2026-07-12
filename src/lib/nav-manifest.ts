// NAV-PLATFORM-GENERATOR-W1 CH1 — the ONE nav model (single-derivation SoT).
//
// Both the runtime renderer (src/lib/site-nav.ts → /track-record, /account) AND the
// build-time injector (scripts/build_nav.mjs → the 24 static landing pages) project the
// desktop bar + mobile drawer from `buildNavModel()`. There is NO second hand-authored nav
// anywhere — that is the whole point of the wave (Single-Derivation LAW). Add a tool → it
// appears in nav + /tools; add a channel → one map line, else the coverage test fails.
//
// DATA + TYPES ONLY: imports the feature-registry (for membership) — writes no HTML, imports
// no DOM, exposes no internal/alias/equities-internal tool. Rendering lives in the injector +
// site-nav.ts; this module is the model those consumers read.
import { FEATURE_REGISTRY, type FeatureSpec } from './feature-registry.js';
// CHANNEL-HUB-PAGES-GEO-W1: the Channels column now DERIVES from the channel SoT (single source
// across nav + the 3 hub pages + docs) instead of the former inline CHANNEL_NAV map.
import { CHANNELS, channelHref, coveredRegistryChannels } from './channel-registry.js';

// ── Absolute-href hosts (A6: absolute uniformly). One injected region renders on BOTH the
//    apex-served static pages (algovault.com) and the api-served /account (api.algovault.com);
//    a relative href would 404 cross-origin on /account. Landing → apex; auth → api. ──
const APEX = 'https://algovault.com';
const API = 'https://api.algovault.com';
const DOCS = `${APEX}/docs.html`;
const TG_BOT = 'https://t.me/algovaultofficialbot'; // NAV Build-Rule 4: the real, grepped handle — never invented.

/** How many Tools the Platform mega-menu features before the "See all tools →" link. */
export const FEATURED_TOOLS = 5;

/**
 * Registry channel keys that are marketplace/settlement RAILS, not user-facing "how you
 * connect" surfaces — deliberately excluded from the nav Channels column. `a2mcp` = the
 * okx.ai A2MCP paid listing; `acp` = Virtuals ACP seller offerings. A registry channel key
 * that is reached by an enabled feature, NOT excluded here, and NOT mapped in CHANNEL_NAV
 * makes `buildNavModel()` THROW (the drift trap — a new channel needs an explicit decision).
 */
export const NAV_EXCLUDED_CHANNELS: readonly string[] = ['a2mcp', 'acp'];

// ── Model types ──────────────────────────────────────────────────────────────────────────
/** A plain top-bar link. */
export interface NavLink {
  kind: 'link';
  label: string;
  href: string;
}
/** An item inside a dropdown/mega-menu column. */
export interface NavMenuItem {
  label: string;
  href: string;
  /** Optional one-line "how you connect / what it does" caption. Non-numerical (Data-Integrity). */
  blurb?: string;
  /** true for an off-site destination (e.g. t.me) — the renderer adds target=_blank rel=noopener. */
  external?: boolean;
}
/** A labelled column inside the Platform mega-menu. */
export interface NavColumn {
  title: string;
  /** Short column caption (e.g. "what the brain does"). */
  caption?: string;
  items: NavMenuItem[];
  /** Optional footer link (e.g. "See all tools →"). */
  more?: NavMenuItem;
}
/**
 * A top-bar dropdown. `columns` present == a mega-menu (Platform); `items` present == a
 * simple dropdown (Track Record). Exactly one is set.
 */
export interface NavDropdown {
  kind: 'dropdown';
  label: string;
  columns?: NavColumn[];
  items?: NavMenuItem[];
}
export interface NavCta {
  label: string;
  href: string;
}
export interface NavBrand {
  label: string;
  href: string;
  /** Logo src (served at the site root on every surface). */
  logo: string;
}
export interface NavModel {
  brand: NavBrand;
  /** The ordered top-bar entries (links + dropdowns), excluding the CTA pill. */
  groups: Array<NavLink | NavDropdown>;
  /** The Signup pill (rendered separately, keeps the mint-500 pill classes). */
  cta: NavCta;
}

// ── Tools column: MEMBERSHIP from the registry, PRESENTATION (label) local ────────────────
// The registry (publicToolNames) owns WHICH tools are public; the nav owns each tool's LABEL
// (a UX decision). A public-listed tool with no label entry FAILS the coverage test below —
// "forgot to label the new tool" becomes a build failure, structurally.
const TOOL_LABELS: Record<string, string> = {
  get_trade_call: 'Trade Call',
  get_market_regime: 'Market Regime',
  scan_trade_calls: 'Trade Call Scanner',
  scan_funding_arb: 'Funding Arbitrage',
  chat_knowledge: 'Knowledge Chat',
  search_knowledge: 'Knowledge Search',
};

// ── Channels column: MEMBERSHIP (reach) from the registry, PRESENTATION from the channel SoT ──
// The per-channel label/href/blurb now live in src/lib/channel-registry.ts (CHANNELS), so the nav
// Channels column, the 3 hub pages, and the docs Channels section are one source (Single-Derivation
// LAW). Destinations are the dedicated hub pages (/mcp · /rest-api · /webhooks) + the external
// Telegram link — repointed from the former /docs.html#… anchors (CHANNEL-HUB-PAGES-GEO-W1).

/** URL-fragment slug for a tool anchor (`/tools#<slug>`). ONE definition — the /tools page reuses it. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Canonical, publicly-listed tool names for an (injectable) registry — equities excluded via publicListing. */
function publicToolsOf(registry: readonly FeatureSpec[]): string[] {
  return registry.filter((f) => f.enabled && f.publicListing !== false).map((f) => f.name);
}

/** Union of channel keys reached by ≥1 ENABLED feature in the registry (dynamic key discovery). */
function reachedChannelKeys(registry: readonly FeatureSpec[]): string[] {
  const keys = new Set<string>();
  for (const f of registry) {
    if (!f.enabled) continue;
    for (const [k, on] of Object.entries(f.channels as Record<string, boolean>)) {
      if (on) keys.add(k);
    }
  }
  return [...keys];
}

/** One public tool's nav/tools presentation — the SINGLE source both the nav Tools column and the /tools index derive from. */
export interface PublicToolEntry {
  name: string;
  label: string;
  anchor: string;
  href: string;
}

/**
 * Every publicly-listed tool as a presentation entry (label + `/tools#<anchor>`), in registry
 * order. The nav Tools column features the first `FEATURED_TOOLS` of these; the /tools index
 * (scripts/build_tools_page.mjs) renders ALL of them — so their labels + anchors are identical
 * by construction (single-derivation). A public tool with no TOOL_LABELS entry THROWS (coverage
 * trap): add a label, or hold it via publicListing:false in feature-registry.ts.
 */
export function publicToolEntries(registry: readonly FeatureSpec[] = FEATURE_REGISTRY): PublicToolEntry[] {
  return publicToolsOf(registry).map((n) => {
    if (!(n in TOOL_LABELS)) {
      throw new Error(
        `nav-manifest: public tool '${n}' has no TOOL_LABELS entry. ` +
          `Add a label, or set publicListing:false in feature-registry.ts to hold it.`,
      );
    }
    return { name: n, label: TOOL_LABELS[n], anchor: slug(n), href: `${APEX}/tools#${slug(n)}` };
  });
}

/**
 * Build the Platform ▸ Tools column: featured `FEATURED_TOOLS` public tools (each →
 * `/tools#<slug>`) + a "See all tools →" footer link to the full /tools index.
 */
function buildToolsColumn(registry: readonly FeatureSpec[]): NavColumn {
  const items: NavMenuItem[] = publicToolEntries(registry)
    .slice(0, FEATURED_TOOLS)
    .map((e) => ({ label: e.label, href: e.href }));
  return {
    title: 'Tools',
    caption: 'What the brain does',
    items,
    more: { label: 'See all tools', href: `${APEX}/tools` },
  };
}

/**
 * Build the Platform ▸ Channels column from the channel SoT (src/lib/channel-registry.ts). The
 * drift trap is PRESERVED: every registry reach-flag reached by an enabled feature and NOT in
 * NAV_EXCLUDED_CHANNELS MUST be covered by a CHANNELS entry (via its `registryChannel` bridge),
 * else THROW — a new registry channel with neither a channel-registry entry nor an exclusion fails
 * the build (A3, by design; a2mcp/acp stay excluded as marketplace rails).
 */
function buildChannelsColumn(registry: readonly FeatureSpec[]): NavColumn {
  const reached = reachedChannelKeys(registry).filter((k) => !NAV_EXCLUDED_CHANNELS.includes(k));
  const covered = coveredRegistryChannels();
  const unmapped = reached.filter((k) => !covered.has(k));
  if (unmapped.length > 0) {
    throw new Error(
      `nav-manifest: registry channel key(s) reached but not covered by channel-registry and not excluded: ` +
        `${unmapped.join(', ')}. Add a CHANNELS entry (channel-registry.ts) or NAV_EXCLUDED_CHANNELS (rail).`,
    );
  }
  // Render every channel in the SoT (hosted → /<slug>, external → its URL), in SoT order.
  const items: NavMenuItem[] = CHANNELS.map((c) => ({
    label: c.label,
    href: channelHref(c),
    blurb: c.navBlurb,
    ...(c.hosted ? {} : { external: true }),
  }));
  return { title: 'Channels', caption: 'How you connect', items };
}

/** Build the Platform ▸ Ecosystem column (static — not registry-derived). */
function buildEcosystemColumn(): NavColumn {
  return {
    title: 'Ecosystem',
    caption: 'Extend & explore',
    items: [
      { label: 'Integrations', href: `${APEX}/integrations`, blurb: 'Exchanges + AI clients' },
      { label: 'Skills', href: `${APEX}/skills`, blurb: 'Prebuilt agent skills' },
    ],
  };
}

/**
 * The single nav model. Every surface (desktop bar + mobile drawer, static + function-rendered)
 * derives from THIS — see src/lib/site-nav.ts (runtime) and scripts/build_nav.mjs (build-time).
 *
 * `registry` is injectable purely for testing the channel-coverage drift trap; production always
 * uses the module-level FEATURE_REGISTRY.
 */
export function buildNavModel(registry: readonly FeatureSpec[] = FEATURE_REGISTRY): NavModel {
  return {
    brand: { label: 'AlgoVault Labs', href: `${APEX}/`, logo: '/logo.png' },
    groups: [
      {
        kind: 'dropdown',
        label: 'Platform',
        columns: [buildToolsColumn(registry), buildChannelsColumn(registry), buildEcosystemColumn()],
      },
      {
        kind: 'dropdown',
        label: 'Track Record',
        items: [
          { label: 'Live Dashboard', href: `${APEX}/track-record`, blurb: 'Real-time PFE win rate' },
          { label: 'Verify', href: `${APEX}/verify`, blurb: 'On-chain Merkle proofs' },
        ],
      },
      { kind: 'link', label: 'How it works', href: `${APEX}/how-it-works` },
      { kind: 'link', label: 'Pricing', href: `${APEX}/#pricing` },
      { kind: 'link', label: 'Docs', href: DOCS },
      { kind: 'link', label: 'Account', href: `${API}/account` },
    ],
    cta: { label: 'Signup', href: `${API}/welcome` },
  };
}

/**
 * Flatten every destination href the model emits — used by tests + the /tools cross-check
 * (model anchors ⊆ page ids) + the CH4 curl gate. Order: brand, each group (link href, or
 * dropdown items + column items + more), then the CTA.
 */
export function navModelHrefs(model: NavModel = buildNavModel()): string[] {
  const out: string[] = [model.brand.href];
  for (const g of model.groups) {
    if (g.kind === 'link') {
      out.push(g.href);
    } else {
      for (const it of g.items ?? []) out.push(it.href);
      for (const col of g.columns ?? []) {
        for (const it of col.items) out.push(it.href);
        if (col.more) out.push(col.more.href);
      }
    }
  }
  out.push(model.cta.href);
  return out;
}
