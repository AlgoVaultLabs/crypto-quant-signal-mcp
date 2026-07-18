/**
 * DASH-EXTERNAL-ONLY-W1 (2026-05-24): regression tests for external-only
 * dashboard filtering. Every getUsageStats() tile + getToolLatencyStats()
 * must EXCLUDE rows where `request_log.is_bot_internal = TRUE` (internal
 * loopback like algovault-bot).
 *
 * Tests run against the local SQLite backend. Skipped when DATABASE_URL is set
 * (would touch the operator's Postgres test/prod DB). End-to-end PG behavior is
 * verified at R7 deploy gate via /analytics curl probe against api.algovault.com.
 *
 * PARALLEL ISOLATION (OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1, 2026-07-16): this
 * file asserts pre/post DELTAS on WHOLE-TABLE aggregates — getUsageStats()
 * .totalCalls.allTime and the genuine/automated split — which are only stable
 * if NO OTHER test file writes request_log between the snapshots. But vitest
 * runs test files in parallel and pql / subscriber-bridge / funnel-snapshot all
 * INSERT external request_log rows, so on the shared ~/.crypto-quant-signal/
 * performance.db those deltas intermittently over-counted (green alone, flaky in
 * the full suite). Fix: beforeAll points performance-db at this file's OWN temp
 * DB via PERFORMANCE_DB_PATH, so the whole-table counts see only THIS file's
 * writes and the deltas are exact. Restored + removed in afterAll.
 *
 * Sentinel pattern (defense-in-depth, still used): every test row carries
 * `tool_name = 'test_dash_ext_w1'` / `test_split_w1` + tier prefix
 * `TESTSENT_W1_*`; beforeEach + afterAll DELETE them so the file is idempotent
 * across re-runs of the same worker's persistent temp DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  initAnalytics,
  logRequest,
  logSkillInvocation,
  getUsageStats,
  getToolLatencyStats,
  getSkillInvocationStats,
} from '../src/lib/analytics.js';
import { requestContext } from '../src/lib/license.js';
import { dbQuery, dbRun, closeDb } from '../src/lib/performance-db.js';

const SENTINEL_TOOL = 'test_dash_ext_w1';
const SENTINEL_TIER_EXT = 'TESTSENT_W1_external';
const SENTINEL_TIER_INT = 'TESTSENT_W1_internal';
const SENTINEL_SKILL_SLUG = 'test-dash-ext-w1-patcha';
// OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: the genuine/automated split tests live in
// THIS file. Their rows use REAL license tiers ('free'/'pro'/'internal') — the split keys
// on the literal tier — and a distinct sentinel tool_name for cleanup. Their whole-table
// delta assertions are kept race-free by the private-DB isolation below (see header), NOT
// by any "single external-row writer" assumption (pql/subscriber-bridge/funnel-snapshot
// also write request_log).
const SPLIT_TOOL = 'test_split_w1';

const SKIP = !!process.env.DATABASE_URL;

// ── OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1: private per-file SQLite DB ──
// Pointing performance-db here via PERFORMANCE_DB_PATH means the whole-table COUNT
// deltas asserted below see ONLY this file's own request_log writes.
//
// mkdtempSync gives an OS-guaranteed-unique directory PER PROCESS. Do NOT key this
// on VITEST_POOL_ID/VITEST_WORKER_ID (the first cut did): vitest assigns
// `process.env.VITEST_POOL_ID = String(workerId)` (vitest/dist/worker.js:74) — a
// small integer restarting at 1 in EVERY run — so two concurrent vitest processes
// both resolve to `<tmp>/cqs-analytics-ext-only-1.db` and clobber each other. That
// is not hypothetical here: CLAUDE.md makes one-worktree-per-session LAW and every
// push runs the full suite through the pre-push gate, so simultaneous runs are
// routine (the 2026-07-18 incident happened while a parallel session's suite ran).
//
// Measured: with a second process INSERTing external request_log rows, the unfixed
// file failed 5/5 runs (`expected 6 to be 2`); with this isolation, 0/5.
const ISOLATED_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-analytics-ext-only-'));
const ISOLATED_DB_PATH = path.join(ISOLATED_DB_DIR, 'performance.db');
let ORIGINAL_PERF_DB_PATH: string | undefined;

// Remove the private DB dir (incl. WAL/SHM sidecars) so no temp cruft is left
// behind. mkdtemp already guarantees the dir starts empty, so this is afterAll
// cleanup rather than a precondition.
function rmIsolatedDb(): void {
  try {
    fs.rmSync(ISOLATED_DB_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

async function cleanSentinels(): Promise<void> {
  // Hit both `is_bot_internal` flavors and both sentinel tiers; idempotent.
  try {
    dbRun('DELETE FROM request_log WHERE tool_name = ?', SENTINEL_TOOL);
  } catch {
    // Table may not exist yet; initAnalytics will create it
  }
  try {
    dbRun('DELETE FROM request_log WHERE tool_name = ?', SPLIT_TOOL);
  } catch {
    // Table may not exist yet; initAnalytics will create it
  }
  try {
    dbRun('DELETE FROM skill_invocations WHERE slug = ?', SENTINEL_SKILL_SLUG);
  } catch {
    // Table may not exist yet; initAnalytics will create it
  }
}

describe.skipIf(SKIP)('DASH-EXTERNAL-ONLY-W1 — dashboard filter excludes is_bot_internal rows', () => {
  beforeAll(() => {
    // Redirect the SQLite backend to this file's private temp DB BEFORE the
    // first getBackend() (initAnalytics opens it). closeDb() drops any handle a
    // prior import/test opened at the default path. The mkdtemp dir is already
    // empty, so the pre/post whole-table deltas start from zero with no pre-clean.
    ORIGINAL_PERF_DB_PATH = process.env.PERFORMANCE_DB_PATH;
    process.env.PERFORMANCE_DB_PATH = ISOLATED_DB_PATH;
    closeDb();
    initAnalytics();
  });

  beforeEach(async () => {
    await cleanSentinels();
  });

  afterAll(async () => {
    await cleanSentinels();
    // Close + delete the private DB, then RESTORE the env — process.env is
    // process-global, so leaving PERFORMANCE_DB_PATH set would redirect the next
    // test file scheduled on this same vitest worker to our (deleted) temp DB.
    closeDb();
    rmIsolatedDb();
    if (ORIGINAL_PERF_DB_PATH === undefined) delete process.env.PERFORMANCE_DB_PATH;
    else process.env.PERFORMANCE_DB_PATH = ORIGINAL_PERF_DB_PATH;
  });

  it('logRequest({isBotInternal:true}) writes is_bot_internal=1 (sqlite) / true (pg)', async () => {
    logRequest({
      toolName: SENTINEL_TOOL,
      licenseTier: SENTINEL_TIER_INT,
      responseTimeMs: 42,
      isBotInternal: true,
    });
    // Small delay to let the fire-and-forget write settle on async backends
    await new Promise((r) => setTimeout(r, 50));
    const rows = await dbQuery<{ is_bot_internal: number | boolean }>(
      'SELECT is_bot_internal FROM request_log WHERE tool_name = ? AND license_tier = ?',
      [SENTINEL_TOOL, SENTINEL_TIER_INT],
    );
    expect(rows.length).toBe(1);
    // SQLite returns 1; PG returns true. Both are truthy.
    expect(Boolean(rows[0].is_bot_internal)).toBe(true);
  });

  it('logRequest({}) without isBotInternal writes is_bot_internal=0/false', async () => {
    logRequest({
      toolName: SENTINEL_TOOL,
      licenseTier: SENTINEL_TIER_EXT,
      responseTimeMs: 100,
      // isBotInternal intentionally omitted — should default to false
    });
    await new Promise((r) => setTimeout(r, 50));
    const rows = await dbQuery<{ is_bot_internal: number | boolean }>(
      'SELECT is_bot_internal FROM request_log WHERE tool_name = ? AND license_tier = ?',
      [SENTINEL_TOOL, SENTINEL_TIER_EXT],
    );
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].is_bot_internal)).toBe(false);
  });

  it('getUsageStats().totalCalls.allTime excludes is_bot_internal rows', async () => {
    // Snapshot pre-insert
    const pre = (await getUsageStats()) as ReturnType<typeof Object.fromEntries> & {
      totalCalls: { allTime: number; last24h: number; last7d: number };
    };
    const preTotal = pre.totalCalls.allTime;

    // Insert 2 external + 1 internal under sentinel tool
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 50 });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 75 });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_INT, responseTimeMs: 90, isBotInternal: true });
    await new Promise((r) => setTimeout(r, 80));

    const post = (await getUsageStats()) as ReturnType<typeof Object.fromEntries> & {
      totalCalls: { allTime: number; last24h: number; last7d: number };
    };
    // Delta MUST equal 2 (the 2 external rows), NOT 3 (which would include the internal)
    expect(post.totalCalls.allTime - preTotal).toBe(2);
  });

  it('getUsageStats().byTool excludes internal rows for the sentinel tool', async () => {
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 50 });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 75 });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_INT, responseTimeMs: 90, isBotInternal: true });
    await new Promise((r) => setTimeout(r, 80));

    const stats = (await getUsageStats()) as { byTool: Record<string, number> };
    // Sentinel tool count = 2 (external only), not 3
    expect(stats.byTool[SENTINEL_TOOL]).toBe(2);
  });

  it('getUsageStats().byTier never contains the internal sentinel tier when only internal rows use it', async () => {
    // Only an internal row uses SENTINEL_TIER_INT — should be ABSENT from byTier
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_INT, responseTimeMs: 50, isBotInternal: true });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 75 });
    await new Promise((r) => setTimeout(r, 80));

    const stats = (await getUsageStats()) as { byTier: Record<string, number> };
    expect(stats.byTier[SENTINEL_TIER_INT]).toBeUndefined();
    expect(stats.byTier[SENTINEL_TIER_EXT]).toBe(1);
  });

  it('getToolLatencyStats() default (externalOnly:true) excludes internal rows', async () => {
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 100 });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 200 });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_INT, responseTimeMs: 999, isBotInternal: true });
    await new Promise((r) => setTimeout(r, 80));

    const stats = await getToolLatencyStats();
    const sentinelStats = stats.find((s) => s.tool_name === SENTINEL_TOOL);
    expect(sentinelStats).toBeDefined();
    // n = 2 external rows; the 999ms internal row is excluded
    expect(sentinelStats!.n).toBe(2);
    expect(sentinelStats!.max_ms).toBe(200);  // would be 999 if internal leaked
  });

  it('getToolLatencyStats({externalOnly:false}) backward-compat seam includes internal rows', async () => {
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_EXT, responseTimeMs: 100 });
    logRequest({ toolName: SENTINEL_TOOL, licenseTier: SENTINEL_TIER_INT, responseTimeMs: 999, isBotInternal: true });
    await new Promise((r) => setTimeout(r, 80));

    const stats = await getToolLatencyStats(7 * 86_400_000, { externalOnly: false });
    const sentinelStats = stats.find((s) => s.tool_name === SENTINEL_TOOL);
    expect(sentinelStats).toBeDefined();
    expect(sentinelStats!.n).toBe(2);  // includes both
    expect(sentinelStats!.max_ms).toBe(999);
  });

  // ── DASH-EXTERNAL-ONLY-W1-PATCH-A: skill_invocations harden ──

  it('logSkillInvocation(...isBotInternal:true) writes is_bot_internal=1/true', async () => {
    logSkillInvocation(SENTINEL_SKILL_SLUG, 'get_trade_call', 'sess-int', 'node', true);
    await new Promise((r) => setTimeout(r, 50));
    const rows = await dbQuery<{ is_bot_internal: number | boolean }>(
      'SELECT is_bot_internal FROM skill_invocations WHERE slug = ?',
      [SENTINEL_SKILL_SLUG],
    );
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].is_bot_internal)).toBe(true);
  });

  it('logSkillInvocation default isBotInternal omitted writes is_bot_internal=0/false', async () => {
    logSkillInvocation(SENTINEL_SKILL_SLUG, 'get_trade_call', 'sess-ext', 'node');
    await new Promise((r) => setTimeout(r, 50));
    const rows = await dbQuery<{ is_bot_internal: number | boolean }>(
      'SELECT is_bot_internal FROM skill_invocations WHERE slug = ?',
      [SENTINEL_SKILL_SLUG],
    );
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].is_bot_internal)).toBe(false);
  });

  it('getSkillInvocationStats() excludes internal rows for sentinel slug', async () => {
    // 2 external + 1 internal → slug should report calls_all_time=2 (NOT 3)
    logSkillInvocation(SENTINEL_SKILL_SLUG, 'get_trade_call', 'sess-ext-1', 'node', false);
    logSkillInvocation(SENTINEL_SKILL_SLUG, 'get_trade_call', 'sess-ext-2', 'node', false);
    logSkillInvocation(SENTINEL_SKILL_SLUG, 'get_trade_call', 'sess-int', 'node', true);
    await new Promise((r) => setTimeout(r, 80));

    const stats = await getSkillInvocationStats();
    const sentinelEntry = stats.find((s) => s.slug === SENTINEL_SKILL_SLUG);
    expect(sentinelEntry).toBeDefined();
    expect(sentinelEntry!.calls_all_time).toBe(2);
    expect(sentinelEntry!.calls_7d).toBe(2);
    expect(sentinelEntry!.calls_24h).toBe(2);
  });

  it('getSkillInvocationStats() returns no entry when only internal rows exist', async () => {
    logSkillInvocation(SENTINEL_SKILL_SLUG, 'get_trade_call', 'sess-int-1', 'node', true);
    logSkillInvocation(SENTINEL_SKILL_SLUG, 'get_trade_call', 'sess-int-2', 'node', true);
    await new Promise((r) => setTimeout(r, 80));

    const stats = await getSkillInvocationStats();
    const sentinelEntry = stats.find((s) => s.slug === SENTINEL_SKILL_SLUG);
    expect(sentinelEntry).toBeUndefined();
  });

  // ── OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: is_automated stamp + split math ──

  it('logRequest stamps is_automated=TRUE from the requestContext ALS (single-derivation)', async () => {
    await requestContext.run(
      { license: { tier: 'free' }, isAutomated: true } as never,
      async () => {
        logRequest({ toolName: SPLIT_TOOL, licenseTier: 'free', responseTimeMs: 10 });
      },
    );
    await new Promise((r) => setTimeout(r, 60));
    const rows = await dbQuery<{ is_automated: number | boolean }>(
      'SELECT is_automated FROM request_log WHERE tool_name = ?',
      [SPLIT_TOOL],
    );
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].is_automated)).toBe(true);
  });

  it('logRequest defaults is_automated=FALSE with no ALS + no explicit value (fail-open)', async () => {
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'free', responseTimeMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
    const rows = await dbQuery<{ is_automated: number | boolean }>(
      'SELECT is_automated FROM request_log WHERE tool_name = ?',
      [SPLIT_TOOL],
    );
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].is_automated)).toBe(false);
  });

  it('explicit entry.isAutomated overrides the ALS (the x402/a2mcp path pattern)', async () => {
    await requestContext.run(
      { license: { tier: 'free' }, isAutomated: false } as never,
      async () => {
        logRequest({ toolName: SPLIT_TOOL, licenseTier: 'pro', responseTimeMs: 10, isAutomated: true });
      },
    );
    await new Promise((r) => setTimeout(r, 60));
    const rows = await dbQuery<{ is_automated: number | boolean }>(
      'SELECT is_automated FROM request_log WHERE tool_name = ?',
      [SPLIT_TOOL],
    );
    expect(rows.length).toBe(1);
    expect(Boolean(rows[0].is_automated)).toBe(true);
  });

  it('getUsageStats split reconciles: paid always genuine, automated = free-bots only, no double-count', async () => {
    type Split = {
      totalCallsExternal: { last24h: number };
      externalGenuine: { total: number; free: number; paid: number };
      externalAutomated: { total: number };
    };
    const pre = (await getUsageStats()) as unknown as Split;

    // 2 free non-bot (genuine free) · 3 free bot (automated) · 1 paid non-bot (genuine
    // paid) · 1 paid BOT (STILL genuine paid — payment=legitimacy) · 1 internal (excluded).
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'free', responseTimeMs: 10, isAutomated: false });
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'free', responseTimeMs: 10, isAutomated: false });
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'free', responseTimeMs: 10, isAutomated: true });
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'free', responseTimeMs: 10, isAutomated: true });
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'free', responseTimeMs: 10, isAutomated: true });
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'pro', responseTimeMs: 10, isAutomated: false });
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'pro', responseTimeMs: 10, isAutomated: true });
    logRequest({ toolName: SPLIT_TOOL, licenseTier: 'internal', responseTimeMs: 10, isBotInternal: true, isAutomated: true });
    await new Promise((r) => setTimeout(r, 120));

    const post = (await getUsageStats()) as unknown as Split;
    const d = (f: (s: Split) => number) => f(post) - f(pre);

    expect(d((s) => s.externalGenuine.free)).toBe(2); // free non-bot
    expect(d((s) => s.externalGenuine.paid)).toBe(2); // BOTH paid rows (incl. the bot one)
    expect(d((s) => s.externalGenuine.total)).toBe(4);
    expect(d((s) => s.externalAutomated.total)).toBe(3); // free bots only
    expect(d((s) => s.totalCallsExternal.last24h)).toBe(7); // 7 external (internal excluded)
    // Reconcile invariant — no double-count, no gap.
    expect(d((s) => s.externalGenuine.total) + d((s) => s.externalAutomated.total)).toBe(
      d((s) => s.totalCallsExternal.last24h),
    );
  });
});
