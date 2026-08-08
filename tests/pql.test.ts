/**
 * CONVERSION-MEASUREMENT-W1 C3 — PQL scoring + cohort view.
 *
 * Unit: threshold parsing (defaults / env override / default-deny on NaN) + the
 * view DDL smoke. Integration (SQLite, skipped when DATABASE_URL is set): seed
 * free request_log + quota_usage + an aha funnel_event, (re)create the view, and
 * assert getPqlCandidates flags each of the 3 OR criteria, excludes a non-PQL,
 * and NEVER leaks the raw ip_hash (only an 8-char candidate_ref).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resolvePqlThresholds,
  pqlViewDdl,
  ensurePqlView,
  getPqlCandidates,
  _resetPqlViewInitForTest,
} from '../src/lib/pql.js';
import { closeDb, dbQuery, dbRun } from '../src/lib/performance-db.js';
import { initAnalytics } from '../src/lib/analytics.js';
import { initQuotaDb } from '../src/lib/license.js';
import { FREE_MONTHLY_CALLS } from '../src/lib/plans.js';

describe('resolvePqlThresholds — defaults / override / default-deny', () => {
  it('defaults to 80 / 20 / 7 when unset', () => {
    expect(resolvePqlThresholds({})).toEqual({ quotaPct: 80, callFreq: 20, windowDays: 7 });
  });
  it('honours valid env overrides', () => {
    expect(resolvePqlThresholds({ PQL_QUOTA_PCT: '90', PQL_CALL_FREQ: '5', PQL_WINDOW_DAYS: '14' }))
      .toEqual({ quotaPct: 90, callFreq: 5, windowDays: 14 });
  });
  it('default-denies (Infinity) on a NaN / non-decimal / hex gate threshold', () => {
    expect(resolvePqlThresholds({ PQL_QUOTA_PCT: 'abc' }).quotaPct).toBe(Infinity);
    expect(resolvePqlThresholds({ PQL_CALL_FREQ: '0x10' }).callFreq).toBe(Infinity);
    expect(resolvePqlThresholds({ PQL_QUOTA_PCT: '-5' }).quotaPct).toBe(Infinity); // negative → deny
  });
  it('falls back to the default window on an invalid / out-of-range PQL_WINDOW_DAYS', () => {
    expect(resolvePqlThresholds({ PQL_WINDOW_DAYS: 'abc' }).windowDays).toBe(7);
    expect(resolvePqlThresholds({ PQL_WINDOW_DAYS: '0' }).windowDays).toBe(7);
    expect(resolvePqlThresholds({ PQL_WINDOW_DAYS: '500' }).windowDays).toBe(7);
  });
});

describe('pqlViewDdl — structure smoke', () => {
  it('contains the CTEs + aha join + score (SQLite strftime form when DATABASE_URL unset)', () => {
    const ddl = pqlViewDdl(7, false);
    expect(ddl).toMatch(/CREATE VIEW pql_candidates/);
    expect(ddl).toMatch(/free_calls/);
    expect(ddl).toMatch(/first_non_hold_verdict/);
    expect(ddl).toMatch(/recent_calls/);
    expect(ddl).toMatch(/score/);
    if (!process.env.DATABASE_URL) expect(ddl).toMatch(/strftime/);
  });
});

const SKIP = process.env.DATABASE_URL ? 'DATABASE_URL set — skip local SQLite' : '';
const describeOrSkip = SKIP ? describe.skip : describe;
const SENT = 'pqltest';

async function cleanup(): Promise<void> {
  await dbRun(`DELETE FROM request_log WHERE ip_hash LIKE ?`, `%${SENT}%`);
  await dbRun(`DELETE FROM quota_usage WHERE tracker_key LIKE ?`, `free:%${SENT}%`);
  await dbRun(`DELETE FROM funnel_events WHERE session_id LIKE ?`, `%${SENT}%`);
}


// ── OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch3: private per-file SQLite DB ──
//
// Worktrees do NOT isolate ~/.crypto-quant-signal/performance.db, so N concurrent
// sessions means N suites mutating one file. This suite asserts prefix-BLIND absolute
// aggregates, which ANY foreign row breaks. MEASURED: 3 concurrent processes against
// the shared DB failed 1-8 tests each in every round; with this isolation, 0.
//
// mkdtempSync is per-PROCESS unique. Do NOT key it on VITEST_POOL_ID — a small integer
// restarting at 1 every run, so concurrent runs collide on one path: the exact bug.
const ISOLATED_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-pql-'));
const ISOLATED_DB_PATH = path.join(ISOLATED_DB_DIR, 'performance.db');
let ORIGINAL_PERF_DB_PATH: string | undefined;

describeOrSkip('C3 SQLite integration — pql_candidates view + getPqlCandidates', () => {
  const NOW_ISO = new Date().toISOString(); // within the 7-day window

  async function seedFreeCall(ip: string, session: string): Promise<void> {
    await dbRun(
      `INSERT INTO request_log (timestamp, session_id, tool_name, license_tier, response_time_ms, ip_hash, is_bot_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      NOW_ISO, session, 'get_trade_call', 'free', 10, ip, 0,
    );
  }

  beforeEach(async () => {
    // Redirect BEFORE the first backend open: resolveSqliteDbPath() is read per open.
    if (ORIGINAL_PERF_DB_PATH === undefined && process.env.PERFORMANCE_DB_PATH !== ISOLATED_DB_PATH) {
      ORIGINAL_PERF_DB_PATH = process.env.PERFORMANCE_DB_PATH ?? '';
      process.env.PERFORMANCE_DB_PATH = ISOLATED_DB_PATH;
      closeDb();
    }
    await dbQuery('SELECT 1');   // getBackend → funnel_events
    initAnalytics();             // request_log
    initQuotaDb();               // quota_usage
    _resetPqlViewInitForTest();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    // process.env is process-global: leaving PERFORMANCE_DB_PATH set would redirect the
    // next file scheduled on this same vitest worker to our deleted temp DB.
    closeDb();
    try {
      fs.rmSync(ISOLATED_DB_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (!ORIGINAL_PERF_DB_PATH) delete process.env.PERFORMANCE_DB_PATH;
    else process.env.PERFORMANCE_DB_PATH = ORIGINAL_PERF_DB_PATH;
  });

  it('flags each of the 3 OR criteria, excludes a non-PQL, and never leaks ip_hash', async () => {
    const ipQuota = `aaaa${SENT}1`;  // PQL via peak_quota_pct >= 80
    const ipFreq  = `bbbb${SENT}2`;  // PQL via recent_calls >= 3
    const ipAha   = `cccc${SENT}3`;  // PQL via reached_aha
    const ipNone  = `dddd${SENT}4`;  // NOT a PQL

    // ipQuota: 1 call + a quota footprint at 85% of the free limit, DERIVED from the SoT.
    // The literal 85 meant 85% only while the free allowance was 100; R-B moved it to 500,
    // where 85 is 17% — under the 80% threshold, so the row silently stopped qualifying.
    await seedFreeCall(ipQuota, `sess${SENT}Q`);
    await dbRun(`INSERT INTO quota_usage (tracker_key, call_count, period_start) VALUES (?, ?, ?)`, `free:${ipQuota}`, Math.round(0.85 * FREE_MONTHLY_CALLS), '2026-06-01');
    // ipFreq: 4 recent calls (>= the callFreq=3 threshold), no quota row.
    for (let i = 0; i < 4; i++) await seedFreeCall(ipFreq, `sess${SENT}F${i}`);
    // ipAha: 1 call whose session reached the aha (first_non_hold_verdict).
    await seedFreeCall(ipAha, `sess${SENT}A`);
    await dbRun(`INSERT INTO funnel_events (event_type, session_id, license_tier, meta_json) VALUES (?, ?, ?, ?)`,
      'first_non_hold_verdict', `sess${SENT}A`, 'free', null);
    // ipNone: 1 call, no quota, no aha → excluded at callFreq=3.
    await seedFreeCall(ipNone, `sess${SENT}N`);

    const cohort = await getPqlCandidates({ thresholds: { quotaPct: 80, callFreq: 3, windowDays: 7 } });

    const refs = new Map(cohort.candidates.map((c) => [c.candidate_ref, c]));
    expect(refs.has(ipQuota.slice(0, 8))).toBe(true);
    expect(refs.has(ipFreq.slice(0, 8))).toBe(true);
    expect(refs.has(ipAha.slice(0, 8))).toBe(true);
    expect(refs.has(ipNone.slice(0, 8))).toBe(false);   // excluded
    expect(cohort.count).toBe(3);

    // Correct per-criterion projection.
    expect(refs.get(ipQuota.slice(0, 8))!.peak_quota_pct).toBe(85);
    expect(refs.get(ipFreq.slice(0, 8))!.recent_calls).toBe(4);
    expect(refs.get(ipAha.slice(0, 8))!.reached_aha).toBe(true);

    // PII: NO candidate carries a raw ip_hash field; candidate_ref is the 8-char prefix.
    for (const c of cohort.candidates) {
      expect(Object.keys(c)).not.toContain('ip_hash');
      expect(c.candidate_ref.length).toBeLessThanOrEqual(8);
    }
    // thresholds echoed; ordered by score desc.
    expect(cohort.thresholds).toEqual({ quota_pct: 80, call_freq: 3 });
    const scores = cohort.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('default-deny — a denied (Infinity) quota threshold disables ONLY the quota criterion', async () => {
    const ipQuota = `eeee${SENT}5`; // quota 85 but NO recent-call/aha signal beyond 1 call
    await seedFreeCall(ipQuota, `sess${SENT}E`);
    await dbRun(`INSERT INTO quota_usage (tracker_key, call_count, period_start) VALUES (?, ?, ?)`, `free:${ipQuota}`, Math.round(0.85 * FREE_MONTHLY_CALLS), '2026-06-01');

    // quota gate denied (Infinity), callFreq high → ipQuota should NOT qualify.
    const denied = await getPqlCandidates({ thresholds: { quotaPct: Infinity, callFreq: 999, windowDays: 7 } });
    expect(denied.candidates.some((c) => c.candidate_ref === ipQuota.slice(0, 8))).toBe(false);
    expect(denied.thresholds.quota_pct).toBeNull(); // Infinity → surfaced as null
  });

  it('ensurePqlView is idempotent (re-create twice, no throw)', async () => {
    _resetPqlViewInitForTest();
    await expect(ensurePqlView(7)).resolves.toBeUndefined();
    _resetPqlViewInitForTest();
    await expect(ensurePqlView(7)).resolves.toBeUndefined();
  });
});
