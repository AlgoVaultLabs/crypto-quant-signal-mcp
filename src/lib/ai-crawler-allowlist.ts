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
