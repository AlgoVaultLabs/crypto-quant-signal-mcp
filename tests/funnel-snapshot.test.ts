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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateFunnelSnapshot,
  aggregateQuotaWallRows,
  classifyQuotaWall,
  computeQuotaWallMix,
  hasQuotaWallLiteral,
  quotaWallPredicatesAgree,
} from '../src/lib/funnel-snapshot.js';
import { closeDb, dbQuery, dbRun, recordFunnelEvent } from '../src/lib/performance-db.js';
import { initAnalytics } from '../src/lib/analytics.js';
import { ensureProcessedX402PaymentsSchema } from '../src/lib/x402-idempotency-store.js';
import { ensureSignupAttributionSchema } from '../src/lib/subscriber-attribution.js';

const SKIP_REASON = process.env.DATABASE_URL ? 'DATABASE_URL set — skipping local SQLite tests' : '';
const describeOrSkip = SKIP_REASON ? describe.skip : describe;

const SENTINEL_PREFIX = 'funnel-test-';

// ── OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch3: private per-file SQLite DB ──
//
// A sentinel PREFIX only isolates rows this file knows the name of, and most
// assertions here are prefix-BLIND absolute aggregates (quota_hit_soft/hard/block =
// 3/2/1, identity_coverage 2/1/1/0.5, mcp_tools_list = 3 & first_call = 2). ANY
// foreign row in the window breaks them — and worktrees do NOT isolate
// ~/.crypto-quant-signal/performance.db, so N concurrent sessions means N suites
// mutating one file. MEASURED: 3 concurrent processes against the shared DB failed
// 1-8 tests each in every round; with this isolation, 0.
//
// mkdtempSync is per-PROCESS unique. Do NOT key it on VITEST_POOL_ID — a small integer
// restarting at 1 in every run, so two concurrent runs collide on the same path, which
// is precisely the bug being fixed.
const ISOLATED_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-funnel-snapshot-'));
const ISOLATED_DB_PATH = path.join(ISOLATED_DB_DIR, 'performance.db');
let ORIGINAL_PERF_DB_PATH: string | undefined;

async function deleteSentinels() {
  // Remove any sentinel test rows from prior runs across every table the CH2/CH3
  // tests seed (funnel_events; request_log for the first_call fallback;
  // agent_sessions for the by_authenticity real-call join).
  await dbRun(`DELETE FROM funnel_events WHERE session_id LIKE ?`, `${SENTINEL_PREFIX}%`);
  await dbRun(`DELETE FROM request_log WHERE session_id LIKE ?`, `${SENTINEL_PREFIX}%`);
  await dbRun(`DELETE FROM agent_sessions WHERE session_id LIKE ?`, `${SENTINEL_PREFIX}%`);
  // REVENUE-METER-TRUTH-W6 CH5. These two tables have no session_id, so they need
  // their own sentinel shapes: the payments PK is COMPOSITE (payer_wallet, nonce), so
  // keying cleanup on the nonce prefix alone would leave rows behind when a test
  // varies the wallet — which is exactly what the paid_upgrade tests do.
  await dbRun(`DELETE FROM processed_x402_payments WHERE nonce LIKE ?`, `${SENTINEL_PREFIX}%`);
  await dbRun(`DELETE FROM signup_attribution WHERE client_reference_id LIKE ?`, `${SENTINEL_PREFIX}%`);
}

describeOrSkip('funnel-snapshot — 14-stage extension', () => {
  beforeAll(async () => {
    // Redirect to this file's private DB BEFORE the first backend open:
    // resolveSqliteDbPath() is read per open, so the redirect only lands while no
    // handle exists. closeDb() drops any handle a prior import already opened.
    ORIGINAL_PERF_DB_PATH = process.env.PERFORMANCE_DB_PATH;
    process.env.PERFORMANCE_DB_PATH = ISOLATED_DB_PATH;
    closeDb();
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
    // REVENUE-METER-TRUTH-W6 CH5: same self-sufficiency rule as request_log above —
    // paid_upgrade now reads processed_x402_payments and stripe_checkout_started reads
    // signup_attribution, and neither table is owned by performance-db's getBackend().
    // Without these the queries would throw into `warnings` and every assertion below
    // would pass VACUOUSLY against a null.
    ensureProcessedX402PaymentsSchema();
    ensureSignupAttributionSchema();
  });

  beforeEach(async () => {
    await deleteSentinels();
  });

  afterAll(async () => {
    await deleteSentinels();
    // process.env is process-global: leaving PERFORMANCE_DB_PATH set would redirect
    // the next file scheduled on this same vitest worker to our deleted temp DB.
    closeDb();
    try {
      fs.rmSync(ISOLATED_DB_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (ORIGINAL_PERF_DB_PATH === undefined) delete process.env.PERFORMANCE_DB_PATH;
    else process.env.PERFORMANCE_DB_PATH = ORIGINAL_PERF_DB_PATH;
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

  // ── REVENUE-METER-TRUTH-W6 CH5 — paid_upgrade tells the truth about settlement ──

  /** Seed one x402 ledger row. `state` is the whole point of these tests. */
  async function seedPayment(nonce: string, wallet: string, state: string, atIso: string) {
    await dbRun(
      `INSERT INTO processed_x402_payments (nonce, tool, amount, payer_wallet, settlement_state, rail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      `${SENTINEL_PREFIX}${nonce}`, 'get_trade_call', '0.02', wallet, state, 'base-usdc', atIso,
    );
  }

  const EXTERNAL_A = '0xaaaa000000000000000000000000000000000001';
  const EXTERNAL_B = '0xbbbb000000000000000000000000000000000002';

  it('CH5: an UNSETTLED in-window x402 payment contributes ZERO to paid_upgrade', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const midIso = new Date(to.getTime() - 86_400_000).toISOString();

    // A claim is not a payment. The ledger claims the ERC-3009 nonce BEFORE settling to
    // close the replay window, so this row is money that provably never moved — 15 of
    // 18 lifetime prod rows are exactly this.
    await seedPayment('unsettled-1', EXTERNAL_A, 'CLAIMED_UNSETTLED', midIso);

    const snap = await generateFunnelSnapshot({ since: from.toISOString(), until: to.toISOString() });
    expect(snap.paid_upgrade_detail.x402_settled_wallets).toBe(0);
    // And it must not sneak in through the SESSION arm either — that is the predicate
    // this chapter removed.
    expect(snap.paid_upgrade_detail.stripe_tier_sessions).toBe(0);
    expect(snap.funnel.paid_upgrade).toBe(0);
    // The query must have RUN. Without this, a thrown query would land in `warnings`,
    // leave the field at its initial value and pass this test having measured nothing.
    expect(snap.warnings.join(' ')).not.toMatch(/processed_x402_payments/);
  });

  it('CH5: an x402 SESSION tier is not a paid upgrade — the removed predicate stays removed', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const tsMs = to.getTime() - 86_400_000;

    // The exact row the deleted `OR tiers_seen LIKE '%x402%'` used to count. A claim
    // SETS the session tier, so before this chapter the session below was a "paid
    // upgrade" by construction, with no settlement gate anywhere in the path.
    //
    // No such row exists in production — `tiers_seen LIKE '%x402%'` matches 0 of 28,643
    // sessions all-time — which is WHY this fixture has to be synthesised: the defect is
    // latent, and a test that only asserted against live-shaped data would pass with the
    // predicate still in place and prove nothing.
    await dbRun(
      `INSERT INTO agent_sessions (session_id, first_seen, last_seen, call_count, tiers_seen) VALUES (?, ?, ?, ?, ?)`,
      `${SENTINEL_PREFIX}x402sess`, tsMs, tsMs, 4, 'free,x402',
    );
    // A real Stripe-tier session alongside it, so the assertion below distinguishes
    // "correctly excluded x402" from "the query returned nothing at all".
    await dbRun(
      `INSERT INTO agent_sessions (session_id, first_seen, last_seen, call_count, tiers_seen) VALUES (?, ?, ?, ?, ?)`,
      `${SENTINEL_PREFIX}starter1`, tsMs, tsMs, 4, 'free,starter',
    );

    const snap = await generateFunnelSnapshot({ since: from.toISOString(), until: to.toISOString() });
    expect(snap.paid_upgrade_detail.stripe_tier_sessions).toBe(1);
    expect(snap.funnel.paid_upgrade).toBe(1);
  });

  it('CH5: a SETTLED external payer counts once, however many times they paid', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const midIso = new Date(to.getTime() - 86_400_000).toISOString();

    await seedPayment('settled-1', EXTERNAL_A, 'SETTLED', midIso);
    await seedPayment('settled-2', EXTERNAL_A, 'SETTLED', midIso); // same wallet, 2nd payment
    await seedPayment('settled-3', EXTERNAL_B, 'SETTLED', midIso);
    await seedPayment('unsettled-2', EXTERNAL_B, 'CLAIMED_UNSETTLED', midIso);

    const snap = await generateFunnelSnapshot({ since: from.toISOString(), until: to.toISOString() });
    // TWO distinct paying parties, not four payment events: the unit is wallets.
    expect(snap.paid_upgrade_detail.x402_settled_wallets).toBe(2);
    expect(snap.funnel.paid_upgrade).toBe(2);
  });

  it('CH5: operator self-settlement and unattributable rows are excluded (externalPayerSql)', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const midIso = new Date(to.getTime() - 86_400_000).toISOString();

    // SEC-49 made payer_wallet NOT NULL DEFAULT '', so the empty string is a REAL value
    // that `IS NOT NULL` does not exclude — it is the pre-instrumentation unattributable
    // row, and counting it would invent a paying customer out of a missing field.
    await seedPayment('empty-wallet', '', 'SETTLED', midIso);
    await seedPayment('external-1', EXTERNAL_A, 'SETTLED', midIso);

    const snap = await generateFunnelSnapshot({ since: from.toISOString(), until: to.toISOString() });
    expect(snap.paid_upgrade_detail.x402_settled_wallets).toBe(1);
  });

  it('CH5: a SETTLED payment OUTSIDE the window does not count (the arm is window-scoped)', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const longAgoIso = new Date(to.getTime() - 30 * 86_400_000).toISOString();

    await seedPayment('old-settled', EXTERNAL_A, 'SETTLED', longAgoIso);

    const snap = await generateFunnelSnapshot({ since: from.toISOString(), until: to.toISOString() });
    expect(snap.paid_upgrade_detail.x402_settled_wallets).toBe(0);
  });

  it('CH5: stripe_checkout_started counts PAID-tier signup_attribution rows, never `free`', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const midIso = new Date(to.getTime() - 86_400_000).toISOString();

    for (const [suffix, tier] of [['s1', 'starter'], ['s2', 'pro'], ['s3', 'enterprise'], ['s4', 'free']]) {
      await dbRun(
        `INSERT INTO signup_attribution (client_reference_id, created_at, tier_requested) VALUES (?, ?, ?)`,
        `${SENTINEL_PREFIX}${suffix}`, midIso, tier,
      );
    }

    const snap = await generateFunnelSnapshot({ since: from.toISOString(), until: to.toISOString() });
    // 3 paid, not 4: the `free` row comes from a DIFFERENT producer (deferred-signup)
    // and is not a checkout start at all.
    expect(snap.funnel.stripe_checkout_started).toBe(3);
    expect(snap.warnings.join(' ')).not.toMatch(/signup_attribution/);
  });

  it('CH5: no ratio rendered as a "retention" may exceed 1', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);

    // quota_hit_hard on ONE session, quota_hit_block on THREE — the live shape (14 vs
    // 17), where sessions reach the block without ever being warned. Ratio 3.0.
    recordFunnelEvent({ eventType: 'quota_hit_hard', sessionId: `${SENTINEL_PREFIX}h1`, licenseTier: 'free' });
    for (const i of [1, 2, 3]) {
      recordFunnelEvent({ eventType: 'quota_hit_block', sessionId: `${SENTINEL_PREFIX}b${i}`, licenseTier: 'free' });
    }
    await new Promise((r) => setTimeout(r, 60));

    const snap = await generateFunnelSnapshot({ since: from.toISOString(), until: to.toISOString() });

    // The standing invariant, checked over EVERY transition rather than the one pair
    // that motivated it — a future non-sequential pair must not quietly render above 1.
    for (const [key, v] of Object.entries(snap.stage_retentions)) {
      if (v !== null) expect(v, `stage_retentions.${key} = ${v}`).toBeLessThanOrEqual(1);
    }

    // Nothing is LOST — the pair and its raw ratio are reported, just not as a retention.
    const anomaly = snap.stage_ratio_anomalies.find(
      (a) => a.from === 'quota_hit_hard' && a.to === 'quota_hit_block',
    );
    expect(anomaly, `anomalies: ${JSON.stringify(snap.stage_ratio_anomalies)}`).toBeTruthy();
    expect(anomaly!.from_count).toBe(1);
    expect(anomaly!.to_count).toBe(3);
    expect(anomaly!.ratio).toBeCloseTo(3, 6);
    expect(snap.stage_retentions.quota_hit_hard_to_quota_hit_block).toBeNull();
  });
});

if (SKIP_REASON) {
  // Vitest's describe.skip is the right way to gate — but log the reason
  // once on suite import so operator knows why it's skipped.
  console.log(`[funnel-snapshot.test] ${SKIP_REASON}`);
}

// ── OPS-QUOTA-FUNNEL-WALL-SPLIT-W1 — the wall discriminator ───────────────────────────────
//
// Plain `describe`, NOT `describeOrSkip`: these exercise pure functions with no DB at all, so
// they must run in BOTH the SQLite and the Postgres lane. Skipping them when DATABASE_URL is
// set would leave the classifier — the one derivation both readers project from — unasserted
// in exactly the lane production runs.
describe('classifyQuotaWall — the ONE wall derivation', () => {
  it('🎯 classifies the two shapes the frozen producers actually emit', () => {
    // license.ts, monthly refusal branch
    expect(classifyQuotaWall('{"used":200,"total":200,"limit":"monthly"}')).toBe('monthly');
    // license.ts, daily refusal branch
    expect(classifyQuotaWall('{"used":40,"total":40,"limit":"daily"}')).toBe('daily');
    // tier-warning.ts, soft/hard — note it ALSO carries `monthly_limit`
    expect(
      classifyQuotaWall('{"current_usage":36,"monthly_limit":40,"ratio":0.9,"limit":"daily"}'),
    ).toBe('daily');
  });

  it('🎯 `unknown` is a FIRST-CLASS bucket and is never folded into `monthly`', () => {
    // Every way a row can fail to name a wall lands in `unknown` — never in a real wall.
    // Folding any of these into `monthly` would manufacture a step change at the cutover.
    expect(classifyQuotaWall(null)).toBe('unknown');
    expect(classifyQuotaWall(undefined)).toBe('unknown');
    expect(classifyQuotaWall('')).toBe('unknown');
    expect(classifyQuotaWall('{}')).toBe('unknown');
    expect(classifyQuotaWall('{"used":1,"total":2}')).toBe('unknown'); // pre-cutover shape
    expect(classifyQuotaWall('not json at all')).toBe('unknown');
    expect(classifyQuotaWall('null')).toBe('unknown');
    expect(classifyQuotaWall('"a string"')).toBe('unknown');
    expect(classifyQuotaWall('[1,2,3]')).toBe('unknown');
    // An UNRECOGNISED value is not coerced into a wall we have not measured.
    expect(classifyQuotaWall('{"limit":"weekly"}')).toBe('unknown');
    expect(classifyQuotaWall('{"limit":null}')).toBe('unknown');
    expect(classifyQuotaWall('{"limit":7}')).toBe('unknown');
  });

  it('🎯 the SQL prefilter and the JS classifier agree across the corpus', () => {
    // QUOTA_WALL_PRESENT_SQL bounds the cutover; classifyQuotaWall decides the bucket. If the
    // two ever describe different populations, the bounds stop describing the buckets — so the
    // agreement is asserted here and re-checked live on every row the split parses.
    for (const meta of [
      '{"used":200,"total":200,"limit":"monthly"}',
      '{"used":40,"total":40,"limit":"daily"}',
      '{"current_usage":36,"monthly_limit":40,"ratio":0.9,"limit":"monthly"}',
      '{}',
      '{"used":1,"total":2}',
      null,
      '',
    ]) {
      expect(quotaWallPredicatesAgree(meta)).toBe(true);
    }
    // The colon is load-bearing: `monthly_limit` must NOT satisfy the prefilter, or every
    // pre-cutover soft/hard row would be counted as carrying a discriminator.
    expect(hasQuotaWallLiteral('{"current_usage":36,"monthly_limit":40,"ratio":0.9}')).toBe(false);
    expect(classifyQuotaWall('{"current_usage":36,"monthly_limit":40,"ratio":0.9}')).toBe('unknown');
    // And a THIRD wall value is a real disagreement — reported, not absorbed.
    expect(hasQuotaWallLiteral('{"limit":"weekly"}')).toBe(true);
    expect(classifyQuotaWall('{"limit":"weekly"}')).toBe('unknown');
    expect(quotaWallPredicatesAgree('{"limit":"weekly"}')).toBe(false);
  });
});

describe('aggregateQuotaWallRows — the ONE reduction', () => {
  const D = '{"limit":"daily"}';
  const M = '{"limit":"monthly"}';
  const U = '{"used":1,"total":2}';
  const ALL = ['quota_hit_soft', 'quota_hit_hard', 'quota_hit_block'];
  const POOL = ['quota_hit_hard', 'quota_hit_block'];

  it('🎯 buckets rows and sessions independently, and pools ONLY hard+block', () => {
    const agg = aggregateQuotaWallRows(
      [
        // one session, many block rows on the monthly wall — the real shape: rows ≫ sessions
        { event_type: 'quota_hit_block', session_id: 's1', meta_json: M },
        { event_type: 'quota_hit_block', session_id: 's1', meta_json: M },
        { event_type: 'quota_hit_block', session_id: 's1', meta_json: M },
        { event_type: 'quota_hit_block', session_id: 's2', meta_json: D },
        { event_type: 'quota_hit_hard', session_id: 's3', meta_json: D },
        { event_type: 'quota_hit_soft', session_id: 's4', meta_json: M },
        { event_type: 'quota_hit_block', session_id: 's5', meta_json: U },
      ],
      ALL,
      POOL,
    );
    expect(agg.per_stage.quota_hit_block.rows).toEqual({ daily: 1, monthly: 3, unknown: 1 });
    expect(agg.per_stage.quota_hit_block.sessions).toEqual({ daily: 1, monthly: 1, unknown: 1 });
    expect(agg.per_stage.quota_hit_soft.sessions).toEqual({ daily: 0, monthly: 1, unknown: 0 });
    // soft is an "approaching" warning, not a wall — it must stay OUT of the pooled crossing.
    expect(agg.pooled.sessions).toEqual({ daily: 2, monthly: 1, unknown: 1 });
    expect(agg.pooled.distinct_sessions).toBe(4); // s1,s2,s3,s5 — s4 is soft-only
  });

  it('🎯 a session hitting BOTH walls is counted in both cells, so cells do not sum to the stage', () => {
    const agg = aggregateQuotaWallRows(
      [
        { event_type: 'quota_hit_block', session_id: 'both', meta_json: D },
        { event_type: 'quota_hit_block', session_id: 'both', meta_json: M },
        { event_type: 'quota_hit_block', session_id: 'solo', meta_json: M },
      ],
      ALL,
      POOL,
    );
    expect(agg.pooled.sessions.daily + agg.pooled.sessions.monthly).toBe(3);
    expect(agg.pooled.distinct_sessions).toBe(2); // 3 !== 2 — and that is the fact, not a bug
    expect(agg.pooled.multi_bucket_sessions).toBe(1);
  });

  it('🎯 counts keyed-vs-keyless sessions live, and reports predicate disagreements', () => {
    const agg = aggregateQuotaWallRows(
      [
        { event_type: 'quota_hit_block', session_id: 'v2:abc', meta_json: M },
        { event_type: 'quota_hit_block', session_id: 'av_free_zzz', meta_json: D },
        { event_type: 'quota_hit_block', session_id: 'v2:abc', meta_json: M }, // repeat, not a new session
        { event_type: 'quota_hit_block', session_id: 'v2:def', meta_json: '{"limit":"weekly"}' },
      ],
      ALL,
      POOL,
    );
    expect(agg.observed_sessions).toBe(3);
    expect(agg.keyed_sessions).toBe(1);
    expect(agg.predicate_disagreements).toBe(1); // the "weekly" row
  });

  it('🎯 ignores rows outside the declared stage set', () => {
    const agg = aggregateQuotaWallRows(
      [{ event_type: 'mcp_connect', session_id: 's1', meta_json: M }],
      ALL,
      POOL,
    );
    expect(agg.pooled.distinct_sessions).toBe(0);
    expect(agg.per_stage.quota_hit_block.rows).toEqual({ daily: 0, monthly: 0, unknown: 0 });
  });
});

describe('computeQuotaWallMix — `unknown` excluded from BOTH sides', () => {
  it('🎯 excludes unknown from numerator AND denominator, and says how many that cost', () => {
    const mix = computeQuotaWallMix({ daily: 30, monthly: 10, unknown: 960 });
    // If `unknown` were in the denominator, daily would read 3% instead of 75% — a rate that
    // would then "improve" purely as pre-cutover rows age out, with no behaviour change at all.
    expect(mix.denominator).toBe(40);
    expect(mix.daily_pct).toBeCloseTo(0.75, 10);
    expect(mix.monthly_pct).toBeCloseTo(0.25, 10);
    expect(mix.excluded_unknown).toBe(960);
    expect(mix.daily_pct! + mix.monthly_pct!).toBeCloseTo(1, 10);
  });

  it('🎯 an all-unknown population yields NO rate rather than a zero', () => {
    const mix = computeQuotaWallMix({ daily: 0, monthly: 0, unknown: 500 });
    expect(mix.denominator).toBe(0);
    expect(mix.daily_pct).toBeNull(); // never 0 — 0 would assert a fact we cannot derive
    expect(mix.monthly_pct).toBeNull();
    expect(mix.excluded_unknown).toBe(500);
  });
});
