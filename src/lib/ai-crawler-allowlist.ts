/**
 * AI_CRAWLER_ALLOWLIST — the ONE list of crawler product tokens whose access to
 * algovault.com is load-bearing for AI-Discovery Visibility.
 *
 * Single-derivation SoT. Consumed by:
 *   - scripts/check-robots-ai-allowlist.mjs  (live-edge gate; reads THIS file's array
 *     literal at runtime, because the gate must run on a host with no build step and
 *     no TypeScript loader — see readAllowlistFromSource there)
 *   - tests/unit/robots-ai-allowlist.test.ts (imports this constant AND the gate's
 *     reader, and asserts they are equal — so the two can never drift apart)
 *
 * Every entry must appear as a `User-agent:` group in landing/robots.txt. Matching is
 * case-INSENSITIVE per RFC 9309 §2.2.1: Cloudflare's managed robots.txt emits
 * `meta-externalagent` lowercase where our file carries `Meta-ExternalAgent`, and a
 * case-sensitive comparison would read that injection as "no rule for this agent".
 *
 * Ordering below is deliberate and must be preserved: the first eight are exactly the
 * user-agents Cloudflare's managed robots.txt feature would `Disallow: /`, i.e. the
 * precise regression surface an edge injection creates.
 */
/**
 * CONTENT_SIGNAL_VALUE — the ONE content-signal declaration, per contentsignals.org.
 *
 * It has to appear on three artifacts no TypeScript module can reach: `landing/robots.txt`,
 * `landing/api-robots.txt` and the `Caddyfile` response header. So "single derivation" here is
 * a constant plus TWO gates, and NEITHER ONE CLOSES IT ALONE:
 *
 *   - build time — `tests/unit/robots-ai-allowlist.test.ts` asserts the three COMMITTED
 *     artifacts carry this exact literal;
 *   - run time  — `scripts/check-robots-ai-allowlist.mjs` asserts the LIVE surfaces do.
 *
 * The split is load-bearing, not redundancy: `Caddyfile` is in `deploy.yml`'s `paths-ignore`, so
 * the committed copy is applied to the host by SSH and can legitimately differ from the running
 * one between a commit and its install. The build-time test proves the committed copy; the live
 * gate proves the running one. Deleting either because "the other covers it" reopens exactly the
 * window in which they disagree.
 *
 * `use=` / `content-use` is deliberately ABSENT — Cloudflare documents it as "testing", and an
 * unratified directive has no place on the surface governing all crawler access.
 */
export const CONTENT_SIGNAL_VALUE = 'search=yes, ai-input=yes, ai-train=yes';

export const AI_CRAWLER_ALLOWLIST: readonly string[] = [
  // --- The eight Cloudflare's managed robots.txt block prepend would Disallow: / ---
  'Amazonbot',
  'Applebot-Extended',
  'Bytespider',
  'CCBot',
  'ClaudeBot',
  'Google-Extended',
  'GPTBot',
  'Meta-ExternalAgent',
  // --- High-value citation fetchers (grounding + search surfaces we are cited through) ---
  'OAI-SearchBot',
  'Claude-SearchBot',
  'PerplexityBot',
  'Googlebot',
  'Bingbot',
];

/**
 * API_CATALOG_ENDPOINTS — the ONE endpoint set behind `/.well-known/api-catalog` (RFC 9727).
 *
 * Single derivation, two consumers, and the split is deliberate:
 *   - `scripts/generate-wellknown.mjs` EMITS the catalog document from this list;
 *   - `scripts/check-robots-ai-allowlist.mjs` PROBES every href in it for liveness.
 * So the published document and the thing the gate verifies cannot describe different sets.
 *
 * WHY `probe` LIVES HERE AND NOT IN THE DOCUMENT. RFC 9727 §4.2 makes the catalog an RFC 9264
 * linkset, whose object members are link RELATION TYPES. `probe-method` is not a registered
 * relation, so putting it in the served body would make a document whose entire value is
 * conformance carry our gate's private config. It is our config, so it lives in our repo.
 *
 * WHY `probe` EXISTS AT ALL. `https://api.algovault.com/mcp` answers **405 to GET and to HEAD**
 * (measured 2026-08-30; `allow: GET, POST, DELETE` is a stale advertisement — the stateless
 * transport refuses GET). It is nonetheless the product's primary API and a catalog omitting it
 * would be misleading, so liveness for that one item is proven the way the endpoint is actually
 * used: a JSON-RPC POST. RFC 9727 §4.1 requires hyperlinks to API endpoints and says nothing
 * about their being GET-able.
 *
 * GUARDRAIL — the gate may call `initialize` or `tools/list` and NOTHING ELSE. It runs daily,
 * unattended, against production: calling a billable tool (`get_trade_call`, `scan_trade_calls`,
 * `get_market_regime`, `scan_funding_arb`) would consume quota and write a signal, making the
 * canary a producer of the data it exists to watch. `probe: 'mcp-initialize'` is the only
 * non-GET probe kind, and it is handshake-only by construction.
 *
 * ONE ENTRY PER LINE is load-bearing: the gate and the generator both run on a host with no
 * TypeScript loader, so they read this literal as TEXT (same constraint as
 * AI_CRAWLER_ALLOWLIST above). Reformatting an entry across lines makes it invisible to both.
 *
 * `service-desc` is deliberately absent: no OpenAPI document exists
 * (`https://algovault.com/openapi.json` → 404, re-probed 2026-08-30). RFC 9727 makes it
 * RECOMMENDED, not required, and fabricating an href to a file that does not exist is the exact
 * defect this arc's gate was built to catch.
 */
export interface ApiCatalogEndpoint {
  /** Absolute URL published in the linkset. */
  readonly href: string;
  /** Registered link relation type. `item` = RFC 6573; `service-doc` = RFC 8631. */
  readonly rel: 'item' | 'service-doc';
  /** How the GATE proves this href is alive. Never emitted into the document. */
  readonly probe: 'GET' | 'mcp-initialize';
  /** Optional RFC 9264 `type` hint, emitted into the document when present. */
  readonly type?: string;
}

export const API_CATALOG_ENDPOINTS: readonly ApiCatalogEndpoint[] = [
  { href: 'https://api.algovault.com/mcp', rel: 'item', probe: 'mcp-initialize' },
  { href: 'https://api.algovault.com/api/plans/public', rel: 'item', probe: 'GET' },
  { href: 'https://algovault.com/api/performance-public', rel: 'item', probe: 'GET' },
  { href: 'https://algovault.com/api/merkle-batches', rel: 'item', probe: 'GET' },
  { href: 'https://algovault.com/docs', rel: 'service-doc', probe: 'GET', type: 'text/html' },
];

/** The canonical RFC 9727 catalog URI. Every other API domain 301s here. */
export const API_CATALOG_URL = 'https://algovault.com/.well-known/api-catalog';

/** RFC 9727 §4.2 — the media type the catalog MUST be served as, with its SHOULD profile param. */
export const API_CATALOG_CONTENT_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

/** RFC 8288 typed link the apex advertises on every response. Registered relation only. */
export const API_CATALOG_LINK_HEADER = '</.well-known/api-catalog>; rel="api-catalog"';

/** RFC 9116 §2.5 — `Expires` is generated as now + this many days. Under a year, per the RFC. */
export const SECURITY_TXT_EXPIRY_DAYS = 180;
