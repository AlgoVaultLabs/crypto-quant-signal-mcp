/**
 * ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): regression tests for the
 * 14-stage funnel snapshot library. Validates:
 *   1. Canonical 14-stage ordering → stage_retentions has exactly 13 keys
 *   2. weakest_stage_transition picks the smallest non-null retention
 *   3. Empty-state handling → null transitions; weakest is null
 *   4. Time-window filtering (--days) returns the expected window range
 *   5. funnel_events table schema is created idempotently on getBackend()
 *
 * Tests run against local SQLite backend (skipped when DATABASE_URL set —
 * would touch the operator's Postgres test/prod DB). Synthetic data only;
 * no NPM/bot-SQLite/alerts.log access in test mode (those return null +
 * push warnings, exercised by the empty-state test).
 *
 * Sentinel pattern: every test row carries event_type prefix `_funnel_test_*`
 * + session_id prefix `funnel-test-`. beforeEach + afterAll DELETE all
 * sentinel rows so tests are idempotent against the operator's accumulated
 * local DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateFunnelSnapshot } from '../src/lib/funnel-snapshot.js';
import { dbQuery, dbRun, recordFunnelEvent } from '../src/lib/performance-db.js';
import { initAnalytics } from '../src/lib/analytics.js';

const SKIP_REASON = process.env.DATABASE_URL ? 'DATABASE_URL set — skipping local SQLite tests' : '';
const describeOrSkip = SKIP_REASON ? describe.skip : describe;

const SENTINEL_PREFIX = 'funnel-test-';

async function deleteSentinels() {
  // Remove any sentinel test rows from prior runs across every table the CH2/CH3
  // tests seed (funnel_events; request_log for the first_call fallback;
  // agent_sessions for the by_authenticity real-call join).
  await dbRun(`DELETE FROM funnel_events WHERE session_id LIKE ?`, `${SENTINEL_PREFIX}%`);
  await dbRun(`DELETE FROM request_log WHERE session_id LIKE ?`, `${SENTINEL_PREFIX}%`);
  await dbRun(`DELETE FROM agent_sessions WHERE session_id LIKE ?`, `${SENTINEL_PREFIX}%`);
}

describeOrSkip('funnel-snapshot — 14-stage extension', () => {
  beforeAll(async () => {
    // Touch the DB to trigger getBackend() → ensures funnel_events table exists.
    await dbQuery('SELECT 1');
    // OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1 follow-up: deleteSentinels() below also
    // DELETEs from request_log, whose schema is owned by analytics.ts — NOT by
    // performance-db's getBackend(). On a COLD DB (a fresh CI runner) that table
    // does not exist yet, so the DELETE threw `no such table: request_log` and
    // failed all 11 tests in this file.
    //
    // This file previously got away with it only because deploy.yml's pre-deploy
    // pre-warm ran analytics-external-only.test.ts first, and THAT file calls
    // initAnalytics(). Now that analytics-external-only uses its own private DB
    // (and the pre-warm points here instead), nothing bootstraps request_log on
    // the shared DB — so this file must be self-sufficient, exactly as its sibling
    // request_log writers (analytics-external-only, pql, subscriber-bridge) are.
    // Idempotent: CREATE TABLE IF NOT EXISTS + best-effort ALTERs.
    initAnalytics();
  });

  beforeEach(async () => {
    await deleteSentinels();
  });

  afterAll(async () => {
    await deleteSentinels();
  });

  it('produces snapshot with all 14 funnel stages + 13 stage_retentions + canonical key set', async () => {
    const snap = await generateFunnelSnapshot({ days: 7 });
    // Funnel object has exactly 19 keys (5 legacy + 11 ACTIVATION-FUNNEL-AUDIT-W1
    // + 1 CONVERSION-MEASUREMENT-W1 aha quality signal + 2 LANDING-CONVERSION-TRUST-W1
    // landing CTA quality signals).
    const funnelKeys = Object.keys(snap.funnel).sort();
    expect(funnelKeys.length).toBe(19);
    expect(funnelKeys).toContain('install');
    expect(funnelKeys).toContain('first_call');
    expect(funnelKeys).toContain('paid_upgrade');
    expect(funnelKeys).toContain('mcp_tools_list');
    expect(funnelKeys).toContain('quota_hit_soft');
    expect(funnelKeys).toContain('quota_hit_hard');
    expect(funnelKeys).toContain('quota_hit_block');
    expect(funnelKeys).toContain('upgrade_cta_clicked');
    expect(funnelKeys).toContain('stripe_checkout_started');
    expect(funnelKeys).toContain('tg_bot_start');
    expect(funnelKeys).toContain('tg_bot_first_command');
    expect(funnelKeys).toContain('tg_bot_watchlist_add');
    expect(funnelKeys).toContain('tg_bot_quota_hit');
    expect(funnelKeys).toContain('tg_bot_upgrade_clicked');
    expect(funnelKeys).toContain('first_non_hold_verdict');
    expect(funnelKeys).toContain('track_record_viewed');
    expect(funnelKeys).toContain('landing_cta_clicked');
    // stage_retentions has exactly 13 transitions across 14 stages (the aha + 2
    // landing CTA quality signals are intentionally NOT stages).
    const retentionKeys = Object.keys(snap.stage_retentions);
    expect(retentionKeys.length).toBe(13);
    // weakest_stage_transition has the expected shape.
    if (snap.weakest_stage_transition !== null) {
      expect(snap.weakest_stage_transition).toHaveProperty('from');
      expect(snap.weakest_stage_transition).toHaveProperty('to');
      expect(snap.weakest_stage_transition).toHaveProperty('retention');
    }
  });

  it('weakest_stage_transition picks the smallest non-null retention across 13 transitions', async () => {
    // Seed funnel_events with a known cohort:
    //   3 sessions hit quota_hit_soft, 2 hit quota_hit_hard, 1 hits quota_hit_block.
    //   quota_hit_soft → quota_hit_hard retention = 2/3 ≈ 0.667
    //   quota_hit_hard → quota_hit_block retention = 1/2 = 0.5 (weakest in our subset)
    for (const i of [1, 2, 3]) {
      recordFunnelEvent({
        eventType: 'quota_hit_soft',
        sessionId: `${SENTINEL_PREFIX}${i}`,
        licenseTier: 'free',
        meta: { test: true },
      });
    }
    for (const i of [1, 2]) {
      recordFunnelEvent({
        eventType: 'quota_hit_hard',
        sessionId: `${SENTINEL_PREFIX}${i}`,
        licenseTier: 'free',
        meta: { test: true },
      });
    }
    recordFunnelEvent({
      eventType: 'quota_hit_block',
      sessionId: `${SENTINEL_PREFIX}1`,
      licenseTier: 'free',
      meta: { test: true },
    });
    // Wait for fire-and-forget writes to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snap = await generateFunnelSnapshot({ days: 1 });
    // Verify the seeded distinct-session counts.
    expect(snap.funnel.quota_hit_soft).toBe(3);
    expect(snap.funnel.quota_hit_hard).toBe(2);
    expect(snap.funnel.quota_hit_block).toBe(1);
    // The 3 transitions we seeded have retentions:
    //   quota_hit_soft → quota_hit_hard = 2/3 ≈ 0.6667
    //   quota_hit_hard → quota_hit_block = 1/2 = 0.5
    expect(snap.stage_retentions['quota_hit_soft_to_quota_hit_hard']).toBeCloseTo(2 / 3, 4);
    expect(snap.stage_retentions['quota_hit_hard_to_quota_hit_block']).toBeCloseTo(0.5, 4);
  });

  it('first_non_hold_verdict (aha) — COUNT DISTINCT session_id, NOT a funnel stage', async () => {
    // 2 distinct free sessions reach their first BUY/SELL; session 1 fires a
    // second time (a later SELL) — the snapshot's DISTINCT(session_id) collapses
    // it, so the aha count is 2 (not 3).
    for (const i of [1, 2]) {
      recordFunnelEvent({
        eventType: 'first_non_hold_verdict',
        sessionId: `${SENTINEL_PREFIX}${i}`,
        licenseTier: 'free',
        meta: { verdict: 'BUY', tool: 'get_trade_call' },
      });
    }
    recordFunnelEvent({
      eventType: 'first_non_hold_verdict',
      sessionId: `${SENTINEL_PREFIX}1`,
      licenseTier: 'free',
      meta: { verdict: 'SELL', tool: 'get_trade_signal' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snap = await generateFunnelSnapshot({ days: 1 });
    expect(snap.funnel.first_non_hold_verdict).toBe(2);
    // The aha is a quality signal — it must NOT add a 15th stage / 14th transition.
    expect(Object.keys(snap.stage_retentions).length).toBe(13);
    expect(snap.stage_retentions).not.toHaveProperty('first_non_hold_verdict_to_paid_upgrade');
  });

  it('empty-state handling — fresh window with no events yields null/0 retentions + emits warnings', async () => {
    // Use a 0-day window way in the future (no events possible).
    const futureTo = '2099-12-31T00:00:00.000Z';
    const futureFrom = '2099-12-30T00:00:00.000Z';
    const snap = await generateFunnelSnapshot({ since: futureFrom, until: futureTo });
    // All funnel stages should be 0 or null (no events in window).
    // install may still be non-null if npm fetch succeeded for the past
    // window date string YYYY-MM-DD (the fetch infers dates from window).
    expect(snap.funnel.quota_hit_soft).toBe(0);
    expect(snap.funnel.quota_hit_hard).toBe(0);
    expect(snap.funnel.upgrade_cta_clicked).toBe(0);
    // stage_retentions should have 13 keys, all null OR 0.
    expect(Object.keys(snap.stage_retentions).length).toBe(13);
    // The snapshot's data-quality gate doesn't fire because sessions.total is 0
    // (not null) so the criticalNulls count is < 3.
    expect(snap.warnings).toBeInstanceOf(Array);
  });

  it('time-window selection — --days 1 produces a 1-day window', async () => {
    const snap = await generateFunnelSnapshot({ days: 1 });
    const windowSpanMs = new Date(snap.window.to).getTime() - new Date(snap.window.from).getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    // Allow ±5s of clock skew (computed from now vs default until).
    expect(Math.abs(windowSpanMs - oneDayMs)).toBeLessThan(5000);
  });

  it('time-window selection — --days 14 produces a 14-day window (default)', async () => {
    const snap = await generateFunnelSnapshot({ days: 14 });
    const windowSpanMs = new Date(snap.window.to).getTime() - new Date(snap.window.from).getTime();
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(windowSpanMs - fourteenDaysMs)).toBeLessThan(5000);
  });

  it('snapshot shape — schema-pinned keys + weakest_stage_transition presence rule', async () => {
    const snap = await generateFunnelSnapshot({ days: 7 });
    // Top-level keys (mirrors audits/funnel-snapshot-shape-snapshot-2026-05-28.json).
    expect(snap).toHaveProperty('generated_at');
    expect(snap).toHaveProperty('window');
    expect(snap).toHaveProperty('sessions');
    expect(snap).toHaveProperty('funnel');
    expect(snap).toHaveProperty('conversion');
    expect(snap).toHaveProperty('stage_retentions');
    expect(snap).toHaveProperty('weakest_stage_transition');
    expect(snap).toHaveProperty('stick_rate');
    expect(snap).toHaveProperty('time_to_first_call_ms');
    expect(snap).toHaveProperty('tool_call_distribution');
    expect(snap).toHaveProperty('tier_cohort_sizes');
    expect(snap).toHaveProperty('warnings');
    // Forbidden keys NEVER appear in response per CLAUDE.md Data Integrity LAW.
    expect(snap).not.toHaveProperty('outcome_return_pct');
    expect(snap).not.toHaveProperty('outcome_price');
    expect(snap).not.toHaveProperty('admin_key');
    expect(snap).not.toHaveProperty('database_url');
  });

  // ── OPS-ACTIVATION-LEAK-FIX-W1 CH2 ──

  it('CH2: mcp_tools_list is sourced from funnel_events (the 0.000% artifact is gone)', async () => {
    // Pre-CH2 this read request_log WHERE tool_name='tools/list' (0 rows all-time —
    // tools/list is SDK-handled, never logRequest'd). Now it reads
    // funnel_events('mcp_tools_list'). 3 distinct sessions list tools; session 1
    // lists twice → DISTINCT(session_id) collapses it → 3.
    for (const i of [1, 2, 3]) {
      recordFunnelEvent({ eventType: 'mcp_tools_list', sessionId: `${SENTINEL_PREFIX}${i}`, licenseTier: 'free', meta: { identity_tier: 'fallback' } });
    }
    recordFunnelEvent({ eventType: 'mcp_tools_list', sessionId: `${SENTINEL_PREFIX}1`, licenseTier: 'free', meta: { identity_tier: 'fallback' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snap = await generateFunnelSnapshot({ days: 1 });
    expect(snap.funnel.mcp_tools_list).toBe(3);
  });

  it('CH2: identity_coverage buckets per-session mcp_connect tiers; coverage_pct = identified/total; pre-CH2 rows excluded', async () => {
    // 2 token (identified), 1 fallback (ipHash), 1 anon (uuid) → coverage 2/4 = 0.5.
    const tiered: Array<[string, string]> = [['1', 'token'], ['2', 'token'], ['3', 'fallback'], ['4', 'anon']];
    for (const [i, tier] of tiered) {
      recordFunnelEvent({ eventType: 'mcp_connect', sessionId: `${SENTINEL_PREFIX}${i}`, licenseTier: 'free', meta: { source: 'unknown', source_confidence: 'unknown', identity_tier: tier } });
    }
    // A pre-CH2 connect WITHOUT identity_tier must be EXCLUDED (not bucketed as anon).
    recordFunnelEvent({ eventType: 'mcp_connect', sessionId: `${SENTINEL_PREFIX}5`, licenseTier: 'free', meta: { source: 'unknown', source_confidence: 'unknown' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snap = await generateFunnelSnapshot({ days: 1 });
    expect(snap.identity_coverage.identified).toBe(2);
    expect(snap.identity_coverage.fallback).toBe(1);
    expect(snap.identity_coverage.anonymous).toBe(1);
    expect(snap.identity_coverage.coverage_pct).toBeCloseTo(0.5, 6);
    // Additive / non-stage: the 14-stage funnel + its 13 retentions stay byte-stable.
    expect(Object.keys(snap.stage_retentions).length).toBe(13);
    expect(snap).toHaveProperty('identity_coverage');
  });

  it('CH2: monotonic — mcp_tools_list >= first_call in an isolated window (the inverse of the bug)', async () => {
    // Far-future window → no real data; agent_sessions empty → first_call falls back
    // to COUNT(DISTINCT session_id) in request_log. 3 sessions list tools; 2 of them
    // also make a real call. A healthy funnel has lists (3) >= calls (2) — the inverse
    // of the old mcp_tools_list=0 < first_call=279 artifact.
    const from = '2099-12-30T00:00:00.000Z';
    const to = '2099-12-31T00:00:00.000Z';
    const ts = '2099-12-30T12:00:00.000Z';
    for (const i of [1, 2, 3]) {
      await dbRun(
        `INSERT INTO funnel_events (event_type, ts, session_id, license_tier, meta_json) VALUES (?, ?, ?, ?, ?)`,
        'mcp_tools_list', ts, `${SENTINEL_PREFIX}${i}`, 'free', JSON.stringify({ identity_tier: 'fallback' }),
      );
    }
    for (const i of [1, 2]) {
      await dbRun(
        `INSERT INTO request_log (timestamp, session_id, tool_name, license_tier, response_time_ms) VALUES (?, ?, ?, ?, ?)`,
        ts, `${SENTINEL_PREFIX}${i}`, 'get_trade_call', 'free', 5,
      );
    }
    const snap = await generateFunnelSnapshot({ since: from, until: to });
    expect(snap.funnel.mcp_tools_list).toBe(3);
    expect(snap.funnel.first_call).toBe(2);
    expect((snap.funnel.mcp_tools_list ?? 0) >= (snap.funnel.first_call ?? 0)).toBe(true);
    // The previously-null/zero stage-2→3 transition is now a real ratio in (0,1].
    expect(snap.stage_retentions['mcp_tools_list_to_first_call']).toBeCloseTo(2 / 3, 6);
  });

  it('CH3: by_authenticity cleans the mcp_connect denominator (tagged not dropped; human <= raw; cleaned activation)', async () => {
    // Isolated future window. 4 connect sessions: 2 tagged human, 1 automated, 1
    // pre-CH3 (no is_automated → defaults human). raw=4, automated=1, human=3.
    // Of the 3 humans, 1 made a real tool call (agent_sessions) → cleaned activation 1/3.
    const from = '2099-12-30T00:00:00.000Z';
    const to = '2099-12-31T00:00:00.000Z';
    const ts = '2099-12-30T12:00:00.000Z';
    const tsMs = new Date(ts).getTime();
    const connects: Array<[string, Record<string, unknown>]> = [
      ['1', { source: 'unknown', source_confidence: 'unknown', identity_tier: 'fallback', is_automated: false, automated_reason: null }],
      ['2', { source: 'claude', source_confidence: 'heuristic', identity_tier: 'token', is_automated: false, automated_reason: null }],
      ['3', { source: 'unknown', source_confidence: 'unknown', identity_tier: 'fallback', is_automated: true, automated_reason: 'crawler_bot' }],
      ['4', { source: 'unknown', source_confidence: 'unknown', identity_tier: 'fallback' }], // pre-CH3: no is_automated → human-default
    ];
    for (const [i, meta] of connects) {
      await dbRun(
        `INSERT INTO funnel_events (event_type, ts, session_id, license_tier, meta_json) VALUES (?, ?, ?, ?, ?)`,
        'mcp_connect', ts, `${SENTINEL_PREFIX}${i}`, 'free', JSON.stringify(meta),
      );
    }
    // Human session 1 made a real tool call → in agent_sessions with call_count >= 1.
    await dbRun(
      `INSERT INTO agent_sessions (session_id, first_seen, last_seen, call_count) VALUES (?, ?, ?, ?)`,
      `${SENTINEL_PREFIX}1`, tsMs, tsMs, 3,
    );
    const snap = await generateFunnelSnapshot({ since: from, until: to });
    const ba = snap.by_authenticity!;
    expect(ba.raw_denominator).toBe(4);
    expect(ba.automated_count).toBe(1);
    expect(ba.human_denominator).toBe(3);
    // AC invariant: human <= raw.
    expect((ba.human_denominator ?? 0) <= (ba.raw_denominator ?? 0)).toBe(true);
    // Cleaned activation: of 3 humans, 1 made a real call.
    expect(ba.human_first_call_pct).toBeCloseTo(1 / 3, 6);
    // TAGGED, NOT DROPPED — all 4 connect rows still present (Data Integrity).
    const remaining = await dbQuery<{ c: number | string }>(
      `SELECT COUNT(*) AS c FROM funnel_events WHERE event_type='mcp_connect' AND session_id LIKE ? AND ts >= ? AND ts <= ?`,
      [`${SENTINEL_PREFIX}%`, from, to],
    );
    expect(Number(remaining[0].c)).toBe(4);
  });
});

if (SKIP_REASON) {
  // Vitest's describe.skip is the right way to gate — but log the reason
  // once on suite import so operator knows why it's skipped.
  console.log(`[funnel-snapshot.test] ${SKIP_REASON}`);
}
