/**
 * ATTRIBUTION-CONNECTION-SRC-W1 — by_source breakdown (funnel-snapshot.ts).
 *
 * Validates the connection-layer `mcp_connect` rows aggregate into
 * `snapshot.by_source` with connects → deterministic → first_call → conversion,
 * deduped by session_id, joining agent_sessions for first_call/conversion using
 * the SAME definitions as the canonical first_call/paid_upgrade stages. Also
 * asserts `mcp_connect` is a NON-stage (the 14-stage funnel + 13 retentions stay
 * byte-stable — the cache-safe, history-stable guarantee).
 *
 * SQLite-only (skipped when DATABASE_URL set). Synthetic source strings
 * (`_attrtest_*`) + sentinel session_ids (`attrconn-w1-`) isolate the rows from
 * the operator's accumulated local DB; beforeEach/afterAll delete them.
 *
 * IMPORTANT — the sentinel prefix is DELIBERATELY disjoint from
 * funnel-snapshot.test.ts's `funnel-test-` and pql.test.ts's `pqltest`: those
 * suites run CONCURRENTLY against the shared local SQLite, and a sub-prefix
 * (e.g. `funnel-test-attr-`) would be deleted by `funnel-snapshot`'s
 * `DELETE … LIKE 'funnel-test-%'` mid-test — green in isolation, flaky in the
 * full suite. Keep this prefix collision-free.
 *
 * ── OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch3: a disjoint prefix is NOT sufficient ──
 *
 * The note above solves collisions BETWEEN SUITES within one run. It cannot solve
 * collisions between concurrent RUNS: worktrees isolate the git index, not
 * ~/.crypto-quant-signal/performance.db, and CLAUDE.md makes one-session-per-worktree
 * LAW, so N sessions pushing at once means N suites mutating ONE database. Measured at
 * 5 concurrent gates: 2 of 5 runners failed here with a genuine ASSERTION mismatch
 * (not a timeout), with lsof confirming concurrent holders of that file.
 *
 * Unique-per-run sentinels were considered and REJECTED — they cannot work here:
 *   - `by_source is an empty array` below asserts over a WHOLE WINDOW, keyed on
 *     neither source nor session, so ANY foreign mcp_connect row in that window
 *     breaks it. That window is already collided IN THE SAME RUN by
 *     funnel-snapshot.test.ts, which writes mcp_connect rows stamped inside it.
 *   - every prefix-blind aggregate in funnel-snapshot.ts counts DISTINCT session_id,
 *     so identical literals across runs currently COLLAPSE to one; making them unique
 *     would multiply them and make the neighbouring suites worse.
 *   - a crashed run's rows would become unreclaimable, turning a flake into permanent
 *     pollution of the operator's real DB.
 *
 * So this file owns its own database, exactly as tests/analytics-external-only.test.ts
 * does. mkdtempSync is per-PROCESS unique; do NOT key it on VITEST_POOL_ID, which is a
 * small integer restarting at 1 in every run and therefore collides across runs — the
 * precise bug this is fixing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateFunnelSnapshot } from '../src/lib/funnel-snapshot.js';
import {
  closeDb,
  dbQuery,
  dbRun,
  recordFunnelEvent,
  upsertAgentSession,
} from '../src/lib/performance-db.js';
import { initAnalytics } from '../src/lib/analytics.js';

const SKIP_REASON = process.env.DATABASE_URL ? 'DATABASE_URL set — skipping local SQLite tests' : '';
const describeOrSkip = SKIP_REASON ? describe.skip : describe;

const SENTINEL = 'attrconn-w1-';
const SRC_ALPHA = '_attrtest_alpha';
const SRC_BETA = '_attrtest_beta';

const ISOLATED_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-attrconn-'));
const ISOLATED_DB_PATH = path.join(ISOLATED_DB_DIR, 'performance.db');
let ORIGINAL_PERF_DB_PATH: string | undefined;

async function cleanup() {
  await dbRun(`DELETE FROM funnel_events WHERE session_id LIKE ?`, `${SENTINEL}%`);
  await dbRun(`DELETE FROM agent_sessions WHERE session_id LIKE ?`, `${SENTINEL}%`);
}

describeOrSkip('attribution by_source — connection-layer source breakdown', () => {
  beforeAll(async () => {
    // MUST precede the first DB touch: resolveSqliteDbPath() is read per backend-open,
    // so the redirect only takes effect while no handle is open. closeDb() drops any
    // handle a prior import opened at the default path.
    ORIGINAL_PERF_DB_PATH = process.env.PERFORMANCE_DB_PATH;
    process.env.PERFORMANCE_DB_PATH = ISOLATED_DB_PATH;
    closeDb();
    initAnalytics(); // request_log is owned by analytics.ts, not getBackend()
    await dbQuery('SELECT 1'); // ensure tables exist
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    // process.env is process-global: leaving PERFORMANCE_DB_PATH set would redirect
    // the next test file scheduled on this same worker to our deleted temp DB.
    closeDb();
    try {
      fs.rmSync(ISOLATED_DB_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (ORIGINAL_PERF_DB_PATH === undefined) delete process.env.PERFORMANCE_DB_PATH;
    else process.env.PERFORMANCE_DB_PATH = ORIGINAL_PERF_DB_PATH;
  });

  it('aggregates connects/deterministic/first_call/conversion per source, deduped by session', async () => {
    // s1: alpha, deterministic, made a tool call, PRO (paid) — emitted TWICE (dedup → 1 connect)
    recordFunnelEvent({
      eventType: 'mcp_connect',
      sessionId: `${SENTINEL}1`,
      licenseTier: 'pro',
      meta: { source: SRC_ALPHA, source_confidence: 'deterministic' },
    });
    recordFunnelEvent({
      eventType: 'mcp_connect',
      sessionId: `${SENTINEL}1`,
      licenseTier: 'pro',
      meta: { source: SRC_ALPHA, source_confidence: 'deterministic' },
    });
    // s2: alpha, heuristic, made a tool call, FREE
    recordFunnelEvent({
      eventType: 'mcp_connect',
      sessionId: `${SENTINEL}2`,
      licenseTier: 'free',
      meta: { source: SRC_ALPHA, source_confidence: 'heuristic' },
    });
    // s3: beta, deterministic, NO tool call (connect only)
    recordFunnelEvent({
      eventType: 'mcp_connect',
      sessionId: `${SENTINEL}3`,
      licenseTier: 'free',
      meta: { source: SRC_BETA, source_confidence: 'deterministic' },
    });

    await upsertAgentSession({ sessionId: `${SENTINEL}1`, tool: 'get_trade_signal', tier: 'pro', ipHash: null });
    await upsertAgentSession({ sessionId: `${SENTINEL}2`, tool: 'get_market_regime', tier: 'free', ipHash: null });

    await new Promise((r) => setTimeout(r, 50)); // flush fire-and-forget writes

    const snap = await generateFunnelSnapshot({ days: 1 });
    expect(Array.isArray(snap.by_source)).toBe(true);

    const alpha = snap.by_source!.find((r) => r.source === SRC_ALPHA);
    const beta = snap.by_source!.find((r) => r.source === SRC_BETA);

    expect(alpha).toEqual({
      source: SRC_ALPHA,
      connects: 2, // s1 (deduped from 2 rows) + s2
      deterministic: 1, // only s1 carried deterministic confidence
      first_call: 2, // s1 + s2 both have agent_sessions rows
      conversion: 1, // only s1 is paid (pro)
    });
    expect(beta).toEqual({
      source: SRC_BETA,
      connects: 1,
      deterministic: 1,
      first_call: 0, // s3 made no tool call
      conversion: 0,
    });
  });

  it('sorts by connects desc and is byte-stable w.r.t. the 14-stage funnel (mcp_connect is NON-stage)', async () => {
    // alpha gets 2 connects, beta gets 1 → alpha must sort first.
    for (const i of [10, 11]) {
      recordFunnelEvent({
        eventType: 'mcp_connect',
        sessionId: `${SENTINEL}${i}`,
        licenseTier: 'free',
        meta: { source: SRC_ALPHA, source_confidence: 'deterministic' },
      });
    }
    recordFunnelEvent({
      eventType: 'mcp_connect',
      sessionId: `${SENTINEL}12`,
      licenseTier: 'free',
      meta: { source: SRC_BETA, source_confidence: 'heuristic' },
    });
    await new Promise((r) => setTimeout(r, 50));

    const snap = await generateFunnelSnapshot({ days: 1 });
    const ours = snap.by_source!.filter((r) => r.source === SRC_ALPHA || r.source === SRC_BETA);
    expect(ours.map((r) => r.source)).toEqual([SRC_ALPHA, SRC_BETA]); // connects desc

    // mcp_connect must NOT become a 15th stage: funnel still 19 keys, retentions still 13.
    expect(Object.keys(snap.funnel).length).toBe(19);
    expect(Object.keys(snap.stage_retentions).length).toBe(13);
    expect(snap.funnel).not.toHaveProperty('mcp_connect');
    expect(snap.stage_retentions).not.toHaveProperty('mcp_connect_to_first_call');
    // by_source is a top-level field, not inside funnel.
    expect(snap).toHaveProperty('by_source');
    expect(snap.funnel).not.toHaveProperty('by_source');
  });

  it('empty window → by_source is an empty array (not null), no crash', async () => {
    const snap = await generateFunnelSnapshot({
      since: '2099-12-30T00:00:00.000Z',
      until: '2099-12-31T00:00:00.000Z',
    });
    expect(snap.by_source).toEqual([]);
  });
});

if (SKIP_REASON) {
  console.log(`[attribution-connect.test] ${SKIP_REASON}`);
}
