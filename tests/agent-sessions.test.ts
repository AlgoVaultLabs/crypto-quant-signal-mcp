/**
 * Tests for v1.9.0 L3 agent_sessions cohort table + upsertAgentSession.
 *
 * Strategy: redirect HOME to a mkdtempSync directory BEFORE dynamically
 * importing performance-db.js so the module-level DB_DIR/DB_PATH constants
 * resolve to the temp dir. Each test gets a fresh DB via vi.resetModules()
 * + a new temp dir, ensuring isolation.
 *
 * Note: DATABASE_URL is unset for these tests so the SQLite backend is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let tempHome: string;
// Holder for the dynamically-imported module's exports
let perfDb: typeof import('../src/lib/performance-db.js');

beforeEach(async () => {
  // Force SQLite backend (the helper supports both, but the test runs locally)
  delete process.env.DATABASE_URL;

  // Fresh temp home so DB_DIR/DB_PATH land in an isolated dir per test
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-agent-sessions-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  // Reset the module registry so performance-db re-evaluates DB_DIR/DB_PATH
  // against the new HOME.
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
});

afterEach(() => {
  // Close the DB handle so the temp dir can be removed cleanly
  try {
    perfDb.closeDb();
  } catch {
    /* ignore */
  }
  // Best-effort temp cleanup
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // Restore env
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  if (ORIGINAL_USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

interface AgentSessionRow {
  session_id: string;
  first_seen: number;
  last_seen: number;
  call_count: number;
  tools_used: string;
  tiers_seen: string;
  first_tool: string | null;
  first_tier: string | null;
  ip_hash_first: string | null;
}

describe('upsertAgentSession', () => {
  it('inserts a fresh row on the first call for a sessionId', async () => {
    await perfDb.upsertAgentSession({
      sessionId: 'sess-A',
      tool: 'get_trade_signal',
      tier: 'free',
      ipHash: 'hash-1',
    });

    const rows = await perfDb.dbQuery<AgentSessionRow>(
      'SELECT * FROM agent_sessions WHERE session_id = ?',
      ['sess-A']
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.call_count).toBe(1);
    expect(row.first_seen).toBe(row.last_seen);
    expect(row.tools_used).toBe('get_trade_signal');
    expect(row.tiers_seen).toBe('free');
    expect(row.first_tool).toBe('get_trade_signal');
    expect(row.first_tier).toBe('free');
    expect(row.ip_hash_first).toBe('hash-1');
  });

  it('updates row on a second call: increments call_count, dedups tools/tiers, preserves first_*', async () => {
    await perfDb.upsertAgentSession({
      sessionId: 'sess-A',
      tool: 'get_trade_signal',
      tier: 'free',
      ipHash: 'hash-1',
    });
    // Sleep ~5ms so last_seen is strictly greater than first_seen
    await new Promise((r) => setTimeout(r, 5));
    await perfDb.upsertAgentSession({
      sessionId: 'sess-A',
      tool: 'get_market_regime',
      tier: 'free',
      ipHash: 'hash-2',
    });

    const rows = await perfDb.dbQuery<AgentSessionRow>(
      'SELECT * FROM agent_sessions WHERE session_id = ?',
      ['sess-A']
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.call_count).toBe(2);
    expect(row.last_seen).toBeGreaterThanOrEqual(row.first_seen);
    expect(row.tools_used).toBe('get_trade_signal,get_market_regime');
    // tier 'free' must NOT be duplicated
    expect(row.tiers_seen).toBe('free');
    // first_* fields preserved from the original insert
    expect(row.first_tool).toBe('get_trade_signal');
    expect(row.first_tier).toBe('free');
    expect(row.ip_hash_first).toBe('hash-1');
  });

  it('starts from an empty table; only valid sessionIds produce rows; src/index.ts guards stdio (sessionId === null)', async () => {
    // Empty table on a fresh DB
    const before = await perfDb.dbQuery<{ c: number }>(
      'SELECT COUNT(*) as c FROM agent_sessions',
      []
    );
    expect(Number(before[0].c)).toBe(0);

    // Two distinct sessionIds → exactly two rows
    await perfDb.upsertAgentSession({
      sessionId: 'sess-X',
      tool: 'get_trade_signal',
      tier: 'pro',
      ipHash: null,
    });
    await perfDb.upsertAgentSession({
      sessionId: 'sess-Y',
      tool: 'scan_funding_arb',
      tier: 'free',
      ipHash: null,
    });

    const after = await perfDb.dbQuery<{ c: number }>(
      'SELECT COUNT(*) as c FROM agent_sessions',
      []
    );
    expect(Number(after[0].c)).toBe(2);

    // The stdio-skip guard lives at the call sites in src/index.ts:
    // `if (sessionIdForCohort !== null) { upsertAgentSession({...}) }`.
    // Verify the guard exists in source (not a runtime DB check, but a
    // structural check that the call sites enforce it).
    const indexSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'index.ts'),
      'utf8'
    );
    // Three handlers, three guards. Substring count must be at least 3.
    const guardCount = (indexSrc.match(/sessionIdForCohort !== null/g) ?? []).length;
    expect(guardCount).toBeGreaterThanOrEqual(3);
  });
});
