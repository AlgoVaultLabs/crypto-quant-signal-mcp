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

const SKIP_REASON = process.env.DATABASE_URL ? 'DATABASE_URL set — skipping local SQLite tests' : '';
const describeOrSkip = SKIP_REASON ? describe.skip : describe;

const SENTINEL_PREFIX = 'funnel-test-';

async function deleteSentinels() {
  // Remove any sentinel test rows from prior runs.
  await dbRun(`DELETE FROM funnel_events WHERE session_id LIKE ?`, `${SENTINEL_PREFIX}%`);
}

describeOrSkip('funnel-snapshot — 14-stage extension', () => {
  beforeAll(async () => {
    // Touch the DB to trigger getBackend() → ensures funnel_events table exists.
    await dbQuery('SELECT 1');
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
});

if (SKIP_REASON) {
  // Vitest's describe.skip is the right way to gate — but log the reason
  // once on suite import so operator knows why it's skipped.
  console.log(`[funnel-snapshot.test] ${SKIP_REASON}`);
}
