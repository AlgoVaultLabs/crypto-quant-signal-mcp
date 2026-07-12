// CHANNEL-HUB-PAGES-GEO-W1 CH1 — the ONE channel SoT.
//
// Three consumers project from this: (a) the nav Platform ▸ Channels column (src/lib/nav-manifest.ts),
// (b) the three generated hub pages /mcp · /rest-api · /webhooks (scripts/build_channel_pages.mjs),
// (c) the docs.html Channels section (CH4). Adding a channel is ONE entry here, not three hand-edits
// (Single-Derivation LAW). Per-channel tool coverage DERIVES from feature-registry `channels{}` via the
// reach-flag bridge (A3) — never hand-listed.
//
// DATA + TYPES ONLY: imports feature-registry (for tool coverage) — writes no HTML, imports no DOM.
import { FEATURE_REGISTRY, publicToolNames, type FeatureSpec } from './feature-registry.js';

const APEX = 'https://algovault.com';
const TG_BOT = 'https://t.me/algovaultofficialbot'; // the real, grepped handle — never invented.

/** feature-registry `channels{}` reach-flag keys (the bridge target for toolCoverage). */
export type RegistryChannelKey = 'mcp' | 'httpX402' | 'webhook' | 'bot';

export interface ChannelSpec {
  /** UX/URL identifier (also the page slug + docs `#<key>` anchor for hosted channels). */
  key: string;
  /** Nav + page label. */
  label: string;
  /** true = a generated hub page at `/<slug>`; false = an external link (no hosted page). */
  hosted: boolean;
  /** hosted only: the page slug → `/<slug>` URL, `landing/<slug>.html`, docs `#<slug>` anchor. */
  slug?: string;
  /** external only: the off-site destination (e.g. t.me). */
  externalUrl?: string;
  /** A3 reach-flag bridge: which feature-registry `channels{}` flag this channel maps to for tool coverage. */
  registryChannel: RegistryChannelKey;
  /** Nav Channels column caption ("how you connect" — canonical trade-call voice, no "signal"). */
  navBlurb: string;
  /** ≤60-word standalone GEO summary passage (page hero + the highest-lifting citation unit). */
  summary: string;
  /** "When to use vs the other channels" — builder-intent disambiguation (page section). */
  whenToUse: string;
  /** docs.html deep-reference anchors this channel's page links + reuses content from (A1 corrected map). */
  docsAnchors: string[];
  /** Self-answering FAQ — the SINGLE source for both the visible <details> FAQ and the FAQPage JSON-LD (GEO Q&A chunks). */
  faq: Array<{ q: string; a: string }>;
}

/**
 * The 4 channels, in the confirmed public-copy order. Copy is descriptive + factual (non-numerical —
 * Data-Integrity: no baked track-record/quota numbers; pages use `data-tr-field`/`/#pricing` for those).
 * `docsAnchors` reflect the A1 correction: `#testing-with-curl` is the MCP Streamable-HTTP handshake
 * (→ /mcp), NOT REST; the REST API is `#x402` (keyless pay-per-call) + `#knowledge-tools-api` (API-key /api/*).
 */
export const CHANNELS: ChannelSpec[] = [
  {
    key: 'mcp',
    label: 'MCP Server',
    hosted: true,
    slug: 'mcp',
    registryChannel: 'mcp',
    navBlurb: 'Native Model Context Protocol endpoint',
    summary:
      "AlgoVault's Model Context Protocol server exposes every trade-call, market-regime, and cross-venue scan tool to AI agents over one endpoint. Point Claude, Cursor, Cline, or any MCP client at https://api.algovault.com/mcp — the free tier needs no API key. Streamable HTTP or stdio transport, with typed tool schemas out of the box.",
    whenToUse:
      'Reach for MCP when your agent framework speaks the Model Context Protocol — Claude Desktop, Cursor, Cline, or an MCP-aware LangChain / LlamaIndex stack. It gives typed tool discovery and the full tool set. If you just want raw HTTP without an MCP client, use the REST API; if you want AlgoVault to push to you, use Webhooks.',
    docsAnchors: ['#connect-mcp', '#testing-with-curl'],
    faq: [
      {
        q: 'Do I need an API key to use the MCP server?',
        a: 'No — the free tier is keyless. Point your MCP client at https://api.algovault.com/mcp and start calling tools. An API key raises your limits but is not required to connect.',
      },
      {
        q: 'What transports does the MCP server support?',
        a: 'Streamable HTTP is the default remote transport; stdio is available for local process integration (set TRANSPORT=stdio). Both expose the same tool set.',
      },
      {
        q: 'Which MCP clients work with AlgoVault?',
        a: 'Any MCP-compliant client — Claude Desktop, Cursor, Cline, and MCP-aware agent frameworks. See the Integrations page for per-client setup recipes.',
      },
      {
        q: 'How is MCP different from the REST API?',
        a: 'MCP gives typed tool discovery and schemas over a protocol; the REST API is plain HTTP request/response. Use MCP when your framework speaks it, and the REST API when it does not.',
      },
    ],
  },
  {
    key: 'rest-api',
    label: 'REST API',
    hosted: true,
    slug: 'rest-api',
    registryChannel: 'httpX402',
    navBlurb: 'Call over HTTP — keyless x402 or API key',
    summary:
      'Call AlgoVault over plain HTTP, two ways. Keyless x402 pay-per-call settles USDC on Base per request — no signup, no API key. Or authenticate with an API key against the /api/* endpoints. Same composite BUY / SELL / HOLD verdicts, callable from any language, cron job, or serverless function.',
    whenToUse:
      'Use the REST API for HTTP access without an MCP client — a serverless function, a cron job, a non-MCP agent runtime. Keyless x402 needs no account and settles per call; API-key access suits steady volume. It is a plain request/response API, not the MCP protocol — if your framework speaks MCP, prefer the MCP server for typed tool discovery.',
    docsAnchors: ['#x402', '#knowledge-tools-api'],
    faq: [
      {
        q: 'Is there a free way to call the REST API?',
        a: 'Yes — keyless x402 pay-per-call needs no signup or API key; your agent settles USDC on Base per request. API-key access is the alternative for steady volume.',
      },
      {
        q: "What's the difference between the x402 and /api endpoints?",
        a: 'x402 is keyless pay-per-call (USDC on Base) for the signal tools; the /api/* endpoints (for example /api/search and /api/chat) use an API key. Both are plain HTTP.',
      },
      {
        q: 'Do I need the MCP handshake for the REST API?',
        a: 'No. The REST API is a plain request/response HTTP call — no initialize or session handshake. That handshake belongs to the MCP-over-HTTP transport, not to this channel.',
      },
      {
        q: 'What format are responses in?',
        a: 'JSON. Every response carries the composite verdict plus an _algovault metadata block.',
      },
    ],
  },
  {
    key: 'webhooks',
    label: 'Webhooks',
    hosted: true,
    slug: 'webhooks',
    registryChannel: 'webhook',
    navBlurb: 'Push trade calls + regime shifts to your endpoint',
    summary:
      'Push AlgoVault trade calls and regime shifts to your endpoint the instant they fire — no polling. Register a URL and receive HMAC-signed POST deliveries with automatic retry and backoff. Subscribe to trade_call and regime_shift events across the monitored venues.',
    whenToUse:
      'Use Webhooks when you want AlgoVault to push to you — a trading bot that acts on new calls, an alerting or logging pipeline. It is the only outbound channel; MCP and the REST API are pull / request-response. Pair Webhooks with MCP or REST for on-demand queries alongside real-time push.',
    docsAnchors: ['#webhooks'],
    faq: [
      {
        q: 'What events can I subscribe to?',
        a: 'trade_call (new BUY/SELL calls) and regime_shift (market-regime changes), across the monitored venues.',
      },
      {
        q: 'How are webhook deliveries secured?',
        a: 'Each POST is HMAC-SHA256 signed with your subscription secret, so you can verify the payload came from AlgoVault.',
      },
      {
        q: 'What happens if my endpoint is down?',
        a: 'Deliveries retry with backoff; persistent failures auto-disable the subscription and are surfaced for review, so a dead endpoint never blocks the queue.',
      },
      {
        q: 'Do webhooks replace MCP or the REST API?',
        a: 'No — they complement them. Webhooks push events to you; MCP and REST are pull. Use webhooks for real-time reaction and MCP/REST for on-demand queries.',
      },
    ],
  },
  {
    key: 'telegram',
    label: 'Telegram Bot',
    hosted: false,
    externalUrl: TG_BOT,
    registryChannel: 'bot',
    navBlurb: 'Trade calls delivered in Telegram',
    summary: 'Trade calls delivered straight to Telegram — start the bot and get composite verdicts in chat.',
    whenToUse: 'Use the Telegram bot for a zero-setup, human-in-the-loop feed of trade calls in chat.',
    docsAnchors: [],
    faq: [],
  },
];

/** Hosted channels (the ones with a generated `/<slug>` hub page). */
export function hostedChannels(): ChannelSpec[] {
  return CHANNELS.filter((c) => c.hosted);
}

export function channelByKey(key: string): ChannelSpec | undefined {
  return CHANNELS.find((c) => c.key === key);
}

/** The nav/page destination: `/<slug>` for a hosted channel (absolute apex), else the external URL. */
export function channelHref(c: ChannelSpec): string {
  return c.hosted ? `${APEX}/${c.slug}` : c.externalUrl!;
}

/**
 * Canonical public tool NAMES reaching this channel — ENABLED, publicly-listed (equities held via
 * publicListing), and with the channel's reach-flag on. DERIVES from feature-registry (A3 bridge);
 * never hand-listed. `registry` injectable for tests.
 */
export function channelToolCoverage(c: ChannelSpec, registry: readonly FeatureSpec[] = FEATURE_REGISTRY): string[] {
  const pub = new Set(publicToolNames());
  return registry
    .filter((f) => f.enabled && pub.has(f.name) && (f.channels as Record<string, boolean>)[c.registryChannel])
    .map((f) => f.name);
}

/** The set of feature-registry reach-flag keys the CHANNELS SoT covers — the nav drift trap checks against this. */
export function coveredRegistryChannels(): Set<string> {
  return new Set(CHANNELS.map((c) => c.registryChannel));
}
