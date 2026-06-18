/**
 * CONVERSION-MEASUREMENT-W1 C1 (2026-06-18): the activation "aha" event.
 *
 * Records `first_non_hold_verdict` to `funnel_events` the FIRST time a FREE
 * session receives a BUY/SELL (non-HOLD) trade verdict from get_trade_call /
 * get_trade_signal — the moment a free agent gets an actionable signal (the
 * leading indicator of activation against the HOLD-dominated baseline).
 *
 * Scope (architect-ratified A1/A2): this wave only EMITS a new `event_type`.
 * It does NOT touch the already-deployed quota/CTA captures (ACTIVATION-FUNNEL-
 * AUDIT-W1) or recreate the `/api/admin/funnel-snapshot` endpoint. The count is
 * surfaced as a retention-QUALITY signal (`funnel.first_non_hold_verdict` =
 * COUNT DISTINCT session_id), NOT a 15th funnel stage — the 14-stage
 * CANONICAL_STAGE_ORDER and historical snapshot shape are unchanged.
 *
 * Dedup: bounded-LRU per session_id (mirrors `track-token.ts`
 * `shouldEmitForRequest`) so a session that gets several BUY/SELLs writes ONE
 * row; the snapshot's COUNT(DISTINCT session_id) is the authoritative read-side
 * dedup, so a duplicate emitted after a process restart is harmless. Free-only
 * (the activation cohort; this naturally excludes bot-internal traffic, which
 * runs as tier `internal`). Fail-open per the `recordFunnelEvent` contract —
 * never throws on the hot response path.
 */
import { recordFunnelEvent } from './performance-db.js';

// Module-level best-effort dedup. Bounded LRU (JS Set keeps insertion order) so
// a long-running server process can't grow this unbounded. The snapshot's
// DISTINCT(session_id) is the source of truth; this only trims write volume.
const emittedSessions = new Set<string>();
const MAX_EMITTED_SESSIONS = 8192;

/**
 * Returns `true` the FIRST time a session_id is seen (caller should emit),
 * `false` on every subsequent call. Evicts the oldest insertion when full.
 */
export function shouldEmitFirstNonHold(sessionId: string): boolean {
  if (emittedSessions.has(sessionId)) return false;
  if (emittedSessions.size >= MAX_EMITTED_SESSIONS) {
    const oldest = emittedSessions.values().next().value;
    if (oldest !== undefined) emittedSessions.delete(oldest);
  }
  emittedSessions.add(sessionId);
  return true;
}

/** Reset module state — tests only; production code never calls this. */
export function _resetFirstNonHoldForTest(): void {
  emittedSessions.clear();
}

export interface FirstNonHoldInput {
  /** The trade verdict from `result.call` — 'BUY' | 'SELL' | 'HOLD' | undefined. */
  verdict: string | null | undefined;
  /** Caller's license tier — only `free` sessions count toward activation. */
  tier: string | null | undefined;
  /** MCP/derived session id (the dedup + DISTINCT key). */
  sessionId: string | null | undefined;
  /** Originating tool (`get_trade_call` | `get_trade_signal`) — for meta. */
  tool: string;
  /** Asset (coin) — optional, for meta. */
  asset?: string | null;
}

type FunnelEventRecorder = typeof recordFunnelEvent;

/**
 * Emit `first_non_hold_verdict` iff: verdict is BUY/SELL, tier is `free`, a
 * session id is present, AND it is the first non-HOLD for that session.
 * `recorder` is injectable for unit tests. Fail-open — any error is swallowed
 * so the trade-call response path is never affected.
 */
export function recordFirstNonHoldVerdict(
  input: FirstNonHoldInput,
  recorder: FunnelEventRecorder = recordFunnelEvent,
): void {
  try {
    const verdict = typeof input.verdict === 'string' ? input.verdict.toUpperCase() : '';
    if (verdict !== 'BUY' && verdict !== 'SELL') return; // HOLD / error / null → not the aha
    if ((input.tier ?? '') !== 'free') return;           // activation cohort = free only
    const sessionId = input.sessionId;
    if (!sessionId) return;                              // need a session to attribute + dedup
    if (!shouldEmitFirstNonHold(sessionId)) return;      // first non-HOLD per session only
    recorder({
      eventType: 'first_non_hold_verdict',
      sessionId,
      licenseTier: 'free',
      meta: { verdict, tool: input.tool, asset: input.asset ?? null },
    });
  } catch {
    // Fail-open per CLAUDE.md Automation-first recovery — never break the response.
  }
}
