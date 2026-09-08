/**
 * IDENTITY-LIFECYCLE-W3 CH4 R2 — the elicitation census.
 *
 * ONE question: what share of agent sessions run a client that could receive an MCP elicitation?
 * That number is the go/no-go for `MCP-ELICITATION-CLAIM-W{NEXT}` — build it at >= 30 %, drop it
 * below — and today nobody knows it.
 *
 * 🛑 "NO HANDSHAKE" IS NOT "NOT CAPABLE", and the column shape is what enforces that.
 * `elicitation_capable` is BOOLEAN NULL: `true`/`false` mean a client told us, and NULL means it
 * never sent `initialize` at all. The transport is STATELESS and `initialize` is OPTIONAL under
 * Streamable HTTP, so a large share of real traffic legitimately never handshakes — a plain
 * boolean would silently record every one of those as "not capable" and hand the next wave a
 * denominator that answers a question nobody asked. The census reports over HANDSHAKING sessions
 * and says so.
 *
 * THIS TOUCHES NO MCP SEMANTICS. It reads `req.body` at the express layer — the JSON-RPC envelope
 * is already parsed there — and writes two additive nullable columns. It does not implement
 * elicitation, does not answer `initialize`, and does not change what the SDK returns.
 */
import { dbQuery, dbRun } from '../performance-db.js';

const IS_PG = !!process.env.DATABASE_URL;

let ensured = false;

/** Additive, nullable, idempotent. Paired with `migrations/041_agent_sessions_elicitation.sql`. */
export function ensureCensusColumns(): void {
  if (ensured) return;
  try {
    if (IS_PG) {
      dbRun('ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS elicitation_capable BOOLEAN NULL');
      dbRun('ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS client_name TEXT NULL');
      dbRun('ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS client_version TEXT NULL');
    } else {
      // SQLite has no ADD COLUMN IF NOT EXISTS; a duplicate-column error is the success case.
      for (const c of ['elicitation_capable INTEGER NULL', 'client_name TEXT NULL', 'client_version TEXT NULL']) {
        try { dbRun(`ALTER TABLE agent_sessions ADD COLUMN ${c}`); } catch { /* already present */ }
      }
    }
    ensured = true;
  } catch {
    // Never fatal: the census is telemetry, and a serving path must not fail because a
    // measurement could not be set up.
  }
}

export interface ClientCapability {
  elicitationCapable: boolean;
  clientName: string | null;
  clientVersion: string | null;
}

/**
 * Read an `initialize` request's declared capabilities. Returns null when this is not an
 * `initialize` — the caller must not record anything for a plain tool call.
 *
 * Total and defensive: `req.body` is caller-controlled, so every access is guarded and a
 * malformed envelope yields null rather than throwing on a live request path.
 */
export function capabilityFromInitialize(body: unknown): ClientCapability | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.method !== 'initialize') return null;
  const params = (b.params ?? {}) as Record<string, unknown>;
  const caps = (params.capabilities ?? {}) as Record<string, unknown>;
  const info = (params.clientInfo ?? {}) as Record<string, unknown>;
  return {
    // PRESENCE is the signal. The 2025-11-25 spec declares elicitation as an object under
    // `capabilities`; an empty object still means "I support this", so truthiness of the KEY is
    // the test, never a nested flag that clients are not required to send.
    elicitationCapable: Object.prototype.hasOwnProperty.call(caps, 'elicitation'),
    clientName: typeof info.name === 'string' ? info.name.slice(0, 120) : null,
    clientVersion: typeof info.version === 'string' ? info.version.slice(0, 60) : null,
  };
}

/**
 * Record a handshake against a session. Fire-and-forget and never throws — this runs on the
 * serving path, and a census that could break a tool call is not worth having.
 */
export function recordHandshake(sessionId: string | undefined, cap: ClientCapability | null): void {
  if (!sessionId || !cap) return;
  try {
    ensureCensusColumns();
    dbRun(
      `UPDATE agent_sessions SET elicitation_capable = ?, client_name = ?, client_version = ?
        WHERE session_id = ?`,
      IS_PG ? cap.elicitationCapable : (cap.elicitationCapable ? 1 : 0),
      cap.clientName, cap.clientVersion, sessionId,
    );
  } catch { /* telemetry only */ }
}

export interface CensusResult {
  /** Sessions that actually handshook — the ONLY honest denominator. */
  handshaking: number;
  capable: number;
  /** Sessions with no `initialize` at all. Reported, never counted as incapable. */
  noHandshake: number;
  /** `capable / handshaking`, or null when the sample is too small to state. */
  capableShare: number | null;
  /** True when `handshaking < 30` — the flag CH4 R3 requires beside the number. */
  lowSample: boolean;
  byClient: { name: string; capable: number; total: number }[];
}

export const CENSUS_MIN_N = 30;

export async function readCensus(sinceMs?: number): Promise<CensusResult> {
  ensureCensusColumns();
  const where = sinceMs ? 'WHERE first_seen >= ?' : '';
  const params = sinceMs ? [sinceMs] : [];
  let rows: { elicitation_capable: unknown; client_name: string | null }[] = [];
  try {
    rows = await dbQuery<{ elicitation_capable: unknown; client_name: string | null }>(
      `SELECT elicitation_capable, client_name FROM agent_sessions ${where}`, params,
    );
  } catch {
    return { handshaking: 0, capable: 0, noHandshake: 0, capableShare: null, lowSample: true, byClient: [] };
  }
  const isTrue = (v: unknown) => v === true || v === 1 || v === '1' || v === 't';
  const handshook = rows.filter((r) => r.elicitation_capable !== null && r.elicitation_capable !== undefined);
  const capable = handshook.filter((r) => isTrue(r.elicitation_capable)).length;

  const byName = new Map<string, { capable: number; total: number }>();
  for (const r of handshook) {
    const k = r.client_name || 'unnamed';
    const e = byName.get(k) ?? { capable: 0, total: 0 };
    e.total += 1;
    if (isTrue(r.elicitation_capable)) e.capable += 1;
    byName.set(k, e);
  }

  return {
    handshaking: handshook.length,
    capable,
    noHandshake: rows.length - handshook.length,
    // A share over a handful of sessions is noise wearing a percentage's clothes. Null below the
    // floor, and `lowSample` says why, so no consumer can render a confident figure from n=3.
    capableShare: handshook.length >= CENSUS_MIN_N ? capable / handshook.length : null,
    lowSample: handshook.length < CENSUS_MIN_N,
    byClient: [...byName.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.total - a.total),
  };
}
