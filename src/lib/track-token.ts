/**
 * TG-BROADCAST-STACK-W1 CH6 (2026-05-28): track-token capture for
 * /unlock_premium_alerts npm-install verification path β.
 *
 * Architecture (Q-A Path β server-side argv capture, architect-ratified):
 *  - Subscriber's `npx crypto-quant-signal-mcp --track-token=<UUID>` puts
 *    the token on the local MCP server's process.argv.
 *  - When the local stdio server proxies tools/call to the production HTTP
 *    server, it includes `X-AlgoVault-Track-Token: <UUID>` header. (Header
 *    plumbing in the stdio client wrapper is a follow-up; the server-side
 *    capture is shipped here so any client that includes the header
 *    benefits immediately.)
 *  - The production /mcp middleware captures the header, and on the FIRST
 *    tools/call per (session_id, track_token) tuple, emits a row to
 *    `funnel_events` with `event_type='first_tool_call_with_track_token'`
 *    + `meta_json={track_token: <UUID>, source: 'header'|'argv'}`.
 *  - The algovault-bot's every-10-min cron polls funnel_events for rows
 *    matching its subscribers.npm_unlock_session_id token values and
 *    grants 30 days Pro via tg_pro_grants on detection.
 *
 * Idempotency: a Set of (session_id|token) keys dedup the emit so the
 * row is written ONCE per (session, token) tuple. The set is bounded
 * (LRU-like) to prevent unbounded growth in long-running processes.
 *
 * This helper is server-only — does NOT modify MCP tool surface or
 * signal-generation logic (per System Taxonomy scope rules for this wave).
 */

// Module-level state. `argvTrackToken` is captured ONCE at startup via
// `captureArgvTrackToken()` and never mutated. `emittedKeys` is the LRU
// of (session, token) tuples we've already emitted for, capped at MAX_KEYS.
let argvTrackToken: string | null = null;
const emittedKeys = new Set<string>();
const MAX_EMITTED_KEYS = 4096; // bounded — recycles oldest when full

/**
 * Parse `--track-token=<value>` from the supplied argv list (typically
 * `process.argv`). Accepts both `--track-token=VAL` and `--track-token VAL`
 * forms. Returns null when no flag is present.
 *
 * Validation: token must match `/^[A-Za-z0-9_-]{8,64}$/` (UUIDv4 hex is
 * 32 chars; we permit 8-64 to absorb future formats); invalid values are
 * silently ignored (logged at most once at startup).
 */
export function parseTrackTokenFromArgv(argv: readonly string[]): string | null {
  const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--track-token' && i + 1 < argv.length) {
      const v = argv[i + 1];
      return TOKEN_RE.test(v) ? v : null;
    }
    if (arg.startsWith('--track-token=')) {
      const v = arg.slice('--track-token='.length);
      return TOKEN_RE.test(v) ? v : null;
    }
  }
  return null;
}

/**
 * Capture `--track-token=` from `process.argv` once at startup. Subsequent
 * calls are no-ops (idempotent). Safe to call multiple times.
 *
 * Returns the captured token (or null) for diagnostics.
 */
export function captureArgvTrackToken(): string | null {
  if (argvTrackToken !== null) return argvTrackToken;
  const parsed = parseTrackTokenFromArgv(process.argv);
  if (parsed) {
    argvTrackToken = parsed;
    // Diagnostic log (PII-safe: only the first 8 chars).
    try {
      console.log(`[track-token] argv-captured prefix=${parsed.slice(0, 8)}...`);
    } catch {
      // Logging failure is non-fatal.
    }
  }
  return argvTrackToken;
}

/**
 * Reset module state — used by tests only. Production code should never
 * call this.
 */
export function _resetTrackTokenForTest(): void {
  argvTrackToken = null;
  emittedKeys.clear();
}

/**
 * Returns the captured argv track-token (or null).
 */
export function getArgvTrackToken(): string | null {
  return argvTrackToken;
}

/**
 * Extract `X-AlgoVault-Track-Token` from an HTTP request headers object.
 * Returns null when absent or malformed.
 */
export function extractHeaderTrackToken(headers: Record<string, unknown>): string | null {
  const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const raw = headers['x-algovault-track-token'];
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return TOKEN_RE.test(v) ? v : null;
}

/**
 * Resolve the effective track-token for a request: header takes precedence
 * over argv (header is set by the client per-call; argv is process-wide).
 * Returns null when neither is set.
 */
export function resolveTrackTokenForRequest(
  headers: Record<string, unknown>,
): string | null {
  return extractHeaderTrackToken(headers) ?? getArgvTrackToken();
}

/**
 * Mark a (session_id, token) tuple as emitted. Returns true if this is
 * the FIRST emit for the tuple (caller should fire recordFunnelEvent),
 * false if already emitted (no-op).
 *
 * LRU bound: when emittedKeys exceeds MAX_EMITTED_KEYS, the oldest
 * insertions are evicted (Set iteration order in JS is insertion order).
 */
export function shouldEmitForRequest(sessionId: string | null, token: string): boolean {
  const sessionKey = sessionId !== null && sessionId !== undefined ? sessionId : 'no-session';
  const key = sessionKey + '|' + token;
  if (emittedKeys.has(key)) return false;
  if (emittedKeys.size >= MAX_EMITTED_KEYS) {
    // Evict oldest (first inserted).
    const oldest = emittedKeys.values().next().value;
    if (oldest !== undefined) emittedKeys.delete(oldest);
  }
  emittedKeys.add(key);
  return true;
}
