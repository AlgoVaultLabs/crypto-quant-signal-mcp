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
