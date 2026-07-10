/**
 * FUNNEL-FIX-ATTRIBUTION-W1 — canonical UTM tagger for OWNED outbound links that point INTO
 * AlgoVault (README, X bio, registry "homepage" URLs, dev.to/Discussions CTAs).
 *
 * OPS-UTM-SHORTEN-W1: the canonical emit form is the short **`?src=<channel>`** (drop
 * `utm_medium` — channel-level attribution is all we need at this scale, and the request-path
 * classifier reads `?src` directly). The classifier keeps reading legacy `?utm_source=` as a
 * backward-compat fallback, so already-shared `?utm_source=` links still classify.
 *
 * HARD RULE: only tags absolute https URLs whose host is algovault.com / api.algovault.com.
 * It REFUSES relative/internal links and any non-AlgoVault host — tagging an internal link
 * would OVERWRITE first-touch (attribution laundering), so the guard is structural, not advisory.
 * Idempotent: an existing `src` OR legacy `utm_source` is left as-is.
 */
const ALGOVAULT_HOSTS = new Set(['algovault.com', 'www.algovault.com', 'api.algovault.com']);

/**
 * Canonical lowercase medium taxonomy. OPS-UTM-SHORTEN-W1 dropped `utm_medium` from the emit;
 * the param is accepted-but-ignored so existing callers keep type-checking (channel-level only).
 */
export type UtmMedium = 'listing' | 'launch' | 'post' | 'bio' | 'readme' | 'discussion';

/**
 * Return `url` with `?src=<channel>` appended, IF `url` is an absolute AlgoVault https URL.
 * Otherwise returns `url` UNCHANGED (never tags internal/relative/external links).
 * `channel` is a lowercase owned-channel slug (e.g. 'npm', 'x', 'producthunt'). The `_medium`
 * arg is accepted for signature back-compat but no longer emitted.
 */
export function taggedLink(url: string, channel: string, _medium: UtmMedium = 'listing'): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; } // relative/invalid → NEVER tag
  if (u.protocol !== 'https:') return url;
  if (!ALGOVAULT_HOSTS.has(u.hostname.toLowerCase())) return url; // external host → not ours → NEVER tag
  const chan = channel.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(chan)) return url; // reject junk channel slugs
  // Short canonical emit; idempotent on EITHER the new `src` or a legacy `utm_source`.
  if (!u.searchParams.has('src') && !u.searchParams.has('utm_source')) {
    u.searchParams.set('src', chan);
  }
  return u.toString();
}

/** Canary: true if `url` is an internal/relative link that must NEVER be tagged. */
export function isInternalOrRelative(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol !== 'https:' || !ALGOVAULT_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return true; // relative → internal
  }
}
