/**
 * OPS-MCP-DEFENSE-IN-DEPTH-W1 R2 — single-derivation client-IP source.
 *
 * Every IP-derivation site (free-tier quota key, signup attribution, x402 HTTP
 * quota) MUST go through this helper instead of parsing `x-forwarded-for` /
 * `x-real-ip` headers manually. `req.ip` is Express's framework-derived client
 * address under `app.set('trust proxy', 1)` (index.ts) — it resolves the
 * nearest-TRUSTED-hop value, where a raw leftmost-XFF parse takes the
 * attacker-writable end of the chain the moment any proxy hop appends instead
 * of replacing.
 *
 * WHAT `req.ip` RESOLVES TO NOW DIFFERS BY VHOST (OPS-AUDIT-REMEDIATION-HIGH-W1, SEC-07):
 *   api.algovault.com — Caddy forwards `CF-Connecting-IP` ⇒ the REAL CLIENT.
 *   algovault.com     — Caddy still forwards `{remote_host}`, which behind CF-orange is the
 *                       CLOUDFLARE EDGE, not the client. Deliberate: the apex block's own
 *                       comment records that flipping it moves the `/api/signup-email` +
 *                       funnel attribution buckets.
 *
 * So a bucket keyed on this helper is PER-CLIENT on api. and PER-POP on the apex; anything that
 * compares or merges hashes across the two must account for that. (The prior version of this
 * comment said both hops were `{remote_host}` and therefore byte-identical — true when written,
 * false since the SEC-07 fix.)
 *
 * Returns '' when `req.ip` is absent (callers keep their own fallback semantics,
 * e.g. `|| 'unknown'` at the quota sites, `null` hash at the attribution site).
 */
export function clientIp(req: { ip?: string | undefined }): string {
  return req.ip || '';
}
