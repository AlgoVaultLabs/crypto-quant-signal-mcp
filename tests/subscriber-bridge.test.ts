/**
 * CONVERSION-MEASUREMENT-W1 C2 — best-effort pre-conversion bridge.
 *
 * Unit: resolvePreConversionBridge gating/projection via a table-routing query
 * mock (pure; no DB). Integration (SQLite, skipped when DATABASE_URL is set):
 * ensureSubscriberBridgeColumns idempotency + backfillSubscriberBridges end-to-
 * end (seed signup_attribution + request_log + quota_usage → backfill → assert).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resolvePreConversionBridge,
  ensureSubscriberBridgeColumns,
  ensureSignupAttributionSchema,
  backfillSubscriberBridges,
  buildSubscriberProfile,
  _resetBridgeColumnsInitForTest,
  type BridgeDeps,
} from '../src/lib/subscriber-attribution.js';
import { closeDb, dbQuery, dbRun } from '../src/lib/performance-db.js';
import { initAnalytics } from '../src/lib/analytics.js';
import { initQuotaDb } from '../src/lib/license.js';
import { FREE_MONTHLY_CALLS } from '../src/lib/plans.js';

// ── Table-routing query mock for the resolver ──
interface MockData {
  optin?: boolean;
  attrIpHash?: string | null;          // signup_attribution.ip_hash (undefined = no row)
  tokenUsage?: { calls: number; first_call: string | null; ip_hash: string | null };
  ipUsage?: { calls: number; sessions: number; first_call: string | null };
  quotaMaxCalls?: number | null;
}
function mockDeps(data: MockData, freeMonthlyQuota = 100): BridgeDeps {
  return {
    freeMonthlyQuota,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string): Promise<any[]> => {
      if (/FROM signup_emails/i.test(sql)) return data.optin ? [{ one: 1 }] : [];
      if (/FROM signup_attribution/i.test(sql)) return data.attrIpHash === undefined ? [] : [{ ip_hash: data.attrIpHash }];
      if (/session_id = \? AND is_bot_internal/i.test(sql)) {
        return [{ calls: data.tokenUsage?.calls ?? 0, first_call: data.tokenUsage?.first_call ?? null, ip_hash: data.tokenUsage?.ip_hash ?? null }];
      }
      if (/ip_hash = \? AND is_bot_internal/i.test(sql)) {
        return [{ calls: data.ipUsage?.calls ?? 0, sessions: data.ipUsage?.sessions ?? 0, first_call: data.ipUsage?.first_call ?? null }];
      }
      if (/FROM quota_usage/i.test(sql)) return [{ max_calls: data.quotaMaxCalls ?? null }];
      return [];
    },
  };
}

const CONVERTED_EPOCH = 1_700_000_000; // 2023-11-14T22:13:20Z
const FIRST_CALL_ISO = '2023-11-10T00:00:00.000Z';
const FIRST_CALL_EPOCH = Math.floor(Date.parse(FIRST_CALL_ISO) / 1000);

describe('resolvePreConversionBridge — confidence + projection', () => {
  it('none — cold conversion (no token, no opt-in, no attribution row)', async () => {
    const r = await resolvePreConversionBridge(
      { email: 'cold@x.com', clientReferenceId: 'direct:1:abc', trackToken: null, convertedAtEpoch: CONVERTED_EPOCH },
      mockDeps({ optin: false /* attrIpHash undefined → no attribution row */ }),
    );
    expect(r.bridgeConfidence).toBe('none');
    expect(r.preConversionCalls).toBeNull();
    expect(r.preConversionSessions).toBeNull();
    expect(r.timeToFirstCallS).toBeNull();
    expect(r.peakQuotaPct).toBeNull();
  });

  it('deterministic — email opt-in with no usage key (known free user, metrics null)', async () => {
    const r = await resolvePreConversionBridge(
      { email: 'known@x.com', clientReferenceId: null, trackToken: null, convertedAtEpoch: CONVERTED_EPOCH },
      mockDeps({ optin: true }),
    );
    expect(r.bridgeConfidence).toBe('deterministic');
    expect(r.preConversionCalls).toBeNull();
  });

  it('deterministic — email opt-in AND an ip link → uses the ip usage metrics', async () => {
    const r = await resolvePreConversionBridge(
      { email: 'known@x.com', clientReferenceId: 'direct:1:abc', trackToken: null, convertedAtEpoch: CONVERTED_EPOCH },
      mockDeps({ optin: true, attrIpHash: 'iph', ipUsage: { calls: 9, sessions: 3, first_call: FIRST_CALL_ISO }, quotaMaxCalls: 90 }),
    );
    expect(r.bridgeConfidence).toBe('deterministic');
    expect(r.preConversionCalls).toBe(9);
    expect(r.preConversionSessions).toBe(3);
    expect(r.peakQuotaPct).toBe(90);
    expect(r.timeToFirstCallS).toBe(CONVERTED_EPOCH - FIRST_CALL_EPOCH);
  });

  it('probabilistic — ip_hash only (NAT-shared inference) + peak_quota_pct', async () => {
    const r = await resolvePreConversionBridge(
      { email: null, clientReferenceId: 'direct:1:abc', trackToken: null, convertedAtEpoch: CONVERTED_EPOCH },
      mockDeps({ optin: false, attrIpHash: 'iph', ipUsage: { calls: 7, sessions: 2, first_call: FIRST_CALL_ISO }, quotaMaxCalls: 80 }),
    );
    expect(r.bridgeConfidence).toBe('probabilistic');
    expect(r.preConversionCalls).toBe(7);
    expect(r.preConversionSessions).toBe(2);
    expect(r.peakQuotaPct).toBe(80); // 80 / 100 * 100
  });

  it('deterministic — track-token with usage (session_id derives from the token)', async () => {
    const r = await resolvePreConversionBridge(
      { email: null, clientReferenceId: null, trackToken: 'tok-valid-12345', convertedAtEpoch: CONVERTED_EPOCH },
      mockDeps({ tokenUsage: { calls: 5, first_call: FIRST_CALL_ISO, ip_hash: 'tokiph' }, quotaMaxCalls: 50 }),
    );
    expect(r.bridgeConfidence).toBe('deterministic');
    expect(r.preConversionCalls).toBe(5);
    expect(r.preConversionSessions).toBe(1);
    expect(r.peakQuotaPct).toBe(50);
    expect(r.timeToFirstCallS).toBe(CONVERTED_EPOCH - FIRST_CALL_EPOCH);
  });

  it('an invalid (too-short) track-token is ignored → falls through to none', async () => {
    const r = await resolvePreConversionBridge(
      { email: null, clientReferenceId: null, trackToken: 'short', convertedAtEpoch: CONVERTED_EPOCH },
      mockDeps({ tokenUsage: { calls: 99, first_call: FIRST_CALL_ISO, ip_hash: 'x' } }),
    );
    expect(r.bridgeConfidence).toBe('none');
    expect(r.preConversionCalls).toBeNull();
  });

  it('fail-open — a throwing query yields none, never throws', async () => {
    const throwing: BridgeDeps = { freeMonthlyQuota: 100, query: async () => { throw new Error('db down'); } };
    const r = await resolvePreConversionBridge(
      { email: 'x@y.com', clientReferenceId: 'direct:1:abc', trackToken: null, convertedAtEpoch: CONVERTED_EPOCH },
      throwing,
    );
    expect(r.bridgeConfidence).toBe('none');
  });
});

describe('buildSubscriberProfile — INSERT carries the 5 bridge columns (29 params)', () => {
  it('appends bridge columns; empty deps → bridge_confidence none', async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    await buildSubscriberProfile(
      { id: 'cs', customer: 'cus_Z', client_reference_id: 'direct:1:abc',
        customer_details: { email: 'a@b.com' }, metadata: { tier: 'starter' }, created: 1000 },
      { ensure: () => {}, query: async () => [], run: (sql: string, ...params: unknown[]) => { runs.push({ sql, params }); } },
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toMatch(/pre_conversion_calls/);
    expect(runs[0].sql).toMatch(/bridge_confidence = EXCLUDED\.bridge_confidence/);
    // 18 base + 5 bridge + 2 interval (OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 CH2, migration 027)
    // + 4 payment-method (PAY-UNIONPAY-ATTRIBUTION-W1 R2).
    // This arity assertion is the contract between the column list, the VALUES placeholders and
    // the bind order — it is what caught CH2's widening, and it caught this wave's too, which is
    // exactly its job. Keep it pinned to a literal: a count derived from the SQL would agree
    // with itself and prove nothing.
    expect(runs[0].params).toHaveLength(29);
    expect(runs[0].params[0]).toBe('cus_Z');            // customer_id still first
    expect(runs[0].params[22]).toBe('none');            // bridge_confidence — position UNCHANGED
    // Every new bind is APPENDED, so no pre-existing position ever shifts. This session carries
    // no billing_interval metadata, so the honest answer is `unknown` and the rate is a REFUSAL.
    expect(runs[0].params[23]).toBe('unknown');         // billing_interval
    expect(runs[0].params[24]).toBeNull();              // monthly_rate_usd — null, never 0
    // The 4 payment-method binds. These deps inject no `resolvePaymentMethod`, so the dimension
    // is unresolved — and unresolved must be NULL, never a fabricated default. A guessed brand
    // is a wrong brand that looks plausible and would poison the decline rate.
    expect(runs[0].params.slice(25)).toEqual([null, null, null, null]);
  });
});

const SKIP = process.env.DATABASE_URL ? 'DATABASE_URL set — skip local SQLite' : '';
const describeOrSkip = SKIP ? describe.skip : describe;
const SENT = 'bridge-test-';


// ── OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch3: private per-file SQLite DB ──
//
// Worktrees do NOT isolate ~/.crypto-quant-signal/performance.db, so N concurrent
// sessions means N suites mutating one file. This suite asserts prefix-BLIND absolute
// aggregates, which ANY foreign row breaks. MEASURED: 3 concurrent processes against
// the shared DB failed 1-8 tests each in every round; with this isolation, 0.
//
// mkdtempSync is per-PROCESS unique. Do NOT key it on VITEST_POOL_ID — a small integer
// restarting at 1 every run, so concurrent runs collide on one path: the exact bug.
const ISOLATED_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-subscriber-bridge-'));
const ISOLATED_DB_PATH = path.join(ISOLATED_DB_DIR, 'performance.db');
let ORIGINAL_PERF_DB_PATH: string | undefined;

describeOrSkip('C2 SQLite integration — column ensure + backfill', () => {
  beforeEach(async () => {
    // Ensure all touched tables exist in the local SQLite test DB.
    initAnalytics();           // request_log
    initQuotaDb();             // quota_usage
    ensureSignupAttributionSchema(); // signup_attribution
    _resetBridgeColumnsInitForTest();
    await ensureSubscriberBridgeColumns();
    await dbRun(`DELETE FROM subscriber_profiles WHERE customer_id LIKE ?`, `${SENT}%`);
    await dbRun(`DELETE FROM signup_attribution WHERE client_reference_id LIKE ?`, `${SENT}%`);
    await dbRun(`DELETE FROM request_log WHERE session_id LIKE ?`, `${SENT}%`);
    await dbRun(`DELETE FROM quota_usage WHERE tracker_key LIKE ?`, `free:${SENT}%`);
  });
  afterAll(async () => {
    await dbRun(`DELETE FROM subscriber_profiles WHERE customer_id LIKE ?`, `${SENT}%`);
    await dbRun(`DELETE FROM signup_attribution WHERE client_reference_id LIKE ?`, `${SENT}%`);
    await dbRun(`DELETE FROM request_log WHERE session_id LIKE ?`, `${SENT}%`);
    await dbRun(`DELETE FROM quota_usage WHERE tracker_key LIKE ?`, `free:${SENT}%`);
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

  it('ensureSubscriberBridgeColumns adds all 5 columns and is idempotent', async () => {
    const rows = await dbQuery<{ name: string }>(`PRAGMA table_info(subscriber_profiles)`, []);
    const cols = new Set(rows.map((r) => r.name));
    for (const c of ['pre_conversion_calls', 'pre_conversion_sessions', 'time_to_first_call_s', 'peak_quota_pct', 'bridge_confidence']) {
      expect(cols.has(c)).toBe(true);
    }
    _resetBridgeColumnsInitForTest();
    await expect(ensureSubscriberBridgeColumns()).resolves.toBeUndefined(); // no throw on re-run
  });

  it('backfillSubscriberBridges resolves a probabilistic ip bridge for a NULL-bridge row', async () => {
    const cref = `${SENT}cref`;
    const iph = `${SENT}iph`;
    await dbRun(`INSERT INTO signup_attribution (client_reference_id, channel, ip_hash) VALUES (?, ?, ?)`, cref, 'direct', iph);
    await dbRun(
      `INSERT INTO request_log (timestamp, session_id, tool_name, license_tier, response_time_ms, ip_hash, is_bot_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      '2026-06-01T00:00:00.000Z', `${SENT}sess`, 'get_trade_call', 'free', 12, iph, 0,
    );
    await dbRun(`INSERT INTO quota_usage (tracker_key, call_count, period_start) VALUES (?, ?, ?)`, `free:${iph}`, Math.round(0.42 * FREE_MONTHLY_CALLS), '2026-06-01');
    await dbRun(
      `INSERT INTO subscriber_profiles (customer_id, client_reference_id, converted_at) VALUES (?, ?, ?)`,
      `${SENT}1`, cref, '2026-06-07T00:00:00.000Z',
    );

    const n = await backfillSubscriberBridges();
    expect(n).toBeGreaterThanOrEqual(1);

    const out = await dbQuery<{ bridge_confidence: string | null; pre_conversion_calls: number | null; peak_quota_pct: number | null; pre_conversion_sessions: number | null }>(
      `SELECT bridge_confidence, pre_conversion_calls, peak_quota_pct, pre_conversion_sessions FROM subscriber_profiles WHERE customer_id = ?`,
      [`${SENT}1`],
    );
    expect(out[0].bridge_confidence).toBe('probabilistic');
    expect(out[0].pre_conversion_calls).toBe(1);
    expect(out[0].pre_conversion_sessions).toBe(1);
    expect(Number(out[0].peak_quota_pct)).toBe(42); // 42% of the free limit, whatever the limit is
  });
});
