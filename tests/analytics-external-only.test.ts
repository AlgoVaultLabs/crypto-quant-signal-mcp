/**
 * DASH-EXTERNAL-ONLY-W1 (2026-05-24): regression tests for external-only
 * dashboard filtering. Every getUsageStats() tile + getToolLatencyStats()
 * must EXCLUDE rows where `request_log.is_bot_internal = TRUE` (internal
 * loopback like algovault-bot).
 *
 * Tests run against the local SQLite backend (`~/.crypto-quant-signal/
 * performance.db`). Skipped when DATABASE_URL is set (would touch the
 * operator's Postgres test/prod DB). End-to-end PG behavior is verified at
 * R7 deploy gate via /analytics curl probe against api.algovault.com.
 *
 * Sentinel pattern: every test row carries `tool_name = 'test_dash_ext_w1'`
 * + tier prefix `TESTSENT_W1_*`. beforeEach + afterAll DELETE all sentinel
 * rows so tests are idempotent against the operator's accumulated local DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initAnalytics,
  logRequest,
  logSkillInvocation,
  getUsageStats,
  getToolLatencyStats,
  getSkillInvocationStats,
} from '../src/lib/analytics.js';
import { requestContext } from '../src/lib/license.js';
import { dbQuery, dbRun } from '../src/lib/performance-db.js';

const SENTINEL_TOOL = 'test_dash_ext_w1';
const SENTINEL_TIER_EXT = 'TESTSENT_W1_external';
const SENTINEL_TIER_INT = 'TESTSENT_W1_internal';
const SENTINEL_SKILL_SLUG = 'test-dash-ext-w1-patcha';
// OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: the genuine/automated split tests live in
// THIS file (the single external-row writer) so they never race the shared SQLite DB.
// These rows use REAL license tiers ('free'/'pro'/'internal') — the split keys on the
// literal tier — and a distinct sentinel tool_name for cleanup.
const SPLIT_TOOL = 'test_split_w1';

const SKIP = !!process.env.DATABASE_URL;

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
    initAnalytics();
  });

  beforeEach(async () => {
    await cleanSentinels();
  });

  afterAll(async () => {
    await cleanSentinels();
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
