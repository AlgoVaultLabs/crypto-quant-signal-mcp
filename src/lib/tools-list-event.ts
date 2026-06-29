/**
 * OPS-ACTIVATION-LEAK-FIX-W1 CH2 (2026-06-29): the `mcp_tools_list` funnel event.
 *
 * Records `mcp_tools_list` to `funnel_events` the FIRST time a session issues a
 * JSON-RPC `tools/list` (discovery) on the remote HTTP transport. This is the
 * funnel's stage-2 capture.
 *
 * Why this exists (root cause, see audits/OPS-ACTIVATION-LEAK-FIX-W1-endpoint-
 * truth.md P1): the high-level `McpServer` SDK answers `tools/list` INTERNALLY —
 * it never reaches a per-tool handler, so it is never `logRequest`'d, so
 * `request_log` has 0 rows with `tool_name='tools/list'` ALL-TIME. The prior
 * wave derived `mcp_tools_list` from that empty request_log query → a structural
 * `0.000%` artifact (every conforming MCP client lists tools at connect, so ≥
 * first_call tools-lists physically happened). Q1-A fix: peek the already-parsed
 * JSON-RPC envelope at the `/mcp` POST layer and emit here, then read this from
 * `funnel_events` in the snapshot (request_log kept as a 0-fallback).
 *
 * Dedup: bounded-LRU per session_id (mirrors `aha-event.ts` / `track-token.ts`)
 * so a session that lists tools several times writes ONE row; the snapshot's
 * COUNT(DISTINCT session_id) is the authoritative read-side dedup, so a duplicate
 * emitted after a process restart is harmless. Internal-tier (bot loopback)
 * excluded by the caller. Fail-open per the `recordFunnelEvent` contract — never
 * throws on the hot response path; the `tools/list` RESPONSE is byte-identical
 * (this is a side-effect emit only).
 */
import { recordFunnelEvent } from './performance-db.js';
import type { IdentityTier } from './track-token.js';

// Module-level best-effort dedup. Bounded LRU (JS Set keeps insertion order) so a
// long-running server process can't grow this unbounded. The snapshot's
// DISTINCT(session_id) is the source of truth; this only trims write volume.
const emittedToolsListSessions = new Set<string>();
const MAX_EMITTED_SESSIONS = 8192;

/**
 * Returns `true` the FIRST time a session_id is seen (caller should emit),
 * `false` on every subsequent call. Evicts the oldest insertion when full.
 */
export function shouldEmitToolsList(sessionId: string): boolean {
  if (emittedToolsListSessions.has(sessionId)) return false;
  if (emittedToolsListSessions.size >= MAX_EMITTED_SESSIONS) {
    const oldest = emittedToolsListSessions.values().next().value;
    if (oldest !== undefined) emittedToolsListSessions.delete(oldest);
  }
  emittedToolsListSessions.add(sessionId);
  return true;
}

/** Reset module state — tests only; production code never calls this. */
export function _resetToolsListForTest(): void {
  emittedToolsListSessions.clear();
}

export interface McpToolsListInput {
  /** Shared correlation id (resolveSessionIdentity().id) — the dedup + DISTINCT key. */
  sessionId: string | null | undefined;
  /** Caller's license tier — stamped for parity with other funnel emits. */
  licenseTier: string | null | undefined;
  /** Identity tier of `sessionId` (token|fallback|anon) — projected into meta for coverage. */
  identityTier: IdentityTier;
}

type FunnelEventRecorder = typeof recordFunnelEvent;

/**
 * Emit `mcp_tools_list` iff a session id is present AND it is the first
 * tools/list for that session. `recorder` is injectable for unit tests.
 * Fail-open — any error is swallowed so the tools/list response path is never
 * affected. RETURNS `true` exactly when the event was recorded (first list for
 * the session), else `false`.
 *
 * The caller is responsible for the `tier!=='internal'` and `method==='tools/list'`
 * gating (it has the parsed JSON-RPC envelope + license in scope at the POST layer).
 */
export function recordMcpToolsListEvent(
  input: McpToolsListInput,
  recorder: FunnelEventRecorder = recordFunnelEvent,
): boolean {
  try {
    const sessionId = input.sessionId;
    if (!sessionId) return false; // need a session to attribute + dedup
    if (!shouldEmitToolsList(sessionId)) return false; // first list per session only
    recorder({
      eventType: 'mcp_tools_list',
      sessionId,
      licenseTier: input.licenseTier ?? null,
      // identity_tier projects from the SHARED resolveSessionIdentity tier so the
      // snapshot's identity_coverage never re-derives stitchability (single-derivation).
      meta: { identity_tier: input.identityTier },
    });
    return true;
  } catch {
    // Fail-open per CLAUDE.md Automation-first recovery — never break the response.
    return false;
  }
}
