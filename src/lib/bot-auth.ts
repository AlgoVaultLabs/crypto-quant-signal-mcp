/**
 * BOT-W2 / D1-C — auth helper for server-internal `/api/bot/*` endpoints.
 *
 * Two-flag firewall (per CLAUDE.md `## Build rules > Cross-repo wire-up`):
 *   outer: BOT_INTERNAL_BYPASS_ENABLED=true
 *   inner: header `X-AlgoVault-Internal-Key` matches env ALGOVAULT_INTERNAL_BYPASS_KEY
 *
 * Reuses the W1 internal-bypass env vars — no new shared secret added in W2.
 */

export type BotAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

export function checkBotInternalAuth(
  headers: Record<string, string | string[] | undefined>,
): BotAuthResult {
  if (process.env.BOT_INTERNAL_BYPASS_ENABLED !== 'true') {
    return { ok: false, status: 403, error: 'bot_internal_bypass_disabled' };
  }
  const expected = process.env.ALGOVAULT_INTERNAL_BYPASS_KEY || '';
  if (expected.length < 16) {
    return { ok: false, status: 403, error: 'bot_internal_bypass_misconfigured' };
  }
  const raw = headers['x-algovault-internal-key'] || headers['X-AlgoVault-Internal-Key'];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  if (!supplied || supplied !== expected) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}
