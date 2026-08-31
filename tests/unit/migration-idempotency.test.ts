/**
 * Unit tests for OPS-HOUSEKEEPING-W1 Phase B — `runPgMigrationsAsync` symmetric
 * Postgres migration idempotency check.
 *
 * The original Postgres path ran `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`
 * unconditionally per migration, costing ~250-300ms per round-trip × 13
 * migrations = ~3-4s of Postgres server work on every container start (per
 * POSTGRES-MAINT-W1's pg_stat_statements top-10). The new code introspects
 * `information_schema.columns` ONCE per table, then skips ALTERs for
 * already-present columns. Symmetric to the SQLite path which already does
 * this via `PRAGMA table_info()`.
 *
 * Tests target the pure helper function with a mocked PgBackend (no live
 * database required). The SQLite path is covered indirectly by all prior
 * tests that exercise `getBackend()` at startup.
 *
 *   1. All columns present in information_schema → 0 ALTERs
 *   2. Some columns missing → ALTERs only for missing
 *   3. All columns missing (empty schema) → one ALTER per declared SIGNAL_MIGRATIONS entry
 *   4. ALTER call uses `IF NOT EXISTS` defense-in-depth
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPgMigrationsAsync } from '../../src/lib/performance-db.js';

// SIGNAL_MIGRATIONS canonical column list (mirror from performance-db.ts).
// Test #3 asserts count matches; if SIGNAL_MIGRATIONS is extended, this
// list MUST be updated to keep the test as a drift guard. The mirror stays HAND-WRITTEN on
// purpose — deriving it from the source would make the drift it exists to catch undetectable —
// but the COUNT below now derives from the mirror, because a second bare literal is a duplicated
// fact that goes stale silently, which is exactly how this test broke.
const ALL_SIGNAL_COLS = [
  'outcome_price', 'outcome_return_pct',
  'pfe_return_pct', 'mae_return_pct', 'pfe_price', 'mae_price', 'pfe_candles', 'return_1candle',
  'exchange', 'regime',
  // SIGNAL-TREND-BLINDNESS-FIX-W1 CH2 (consumed from signal-regime-label-rule-fix-w1-v2): the rule
  // generation that produced `regime`, so an audit can partition v1 rows from v3 rows instead of
  // pooling two different engines.
  'regime_rule_version',
  // SIGNAL-TREND-MODE-ENABLE-W1 CH1: which VERDICT rule produced `signal`. Its sibling above
  // records which rule produced the LABEL; this one matters more, because a changed verdict rule
  // changes which rows EXIST (recordSignal writes non-HOLD only), not merely what one field says.
  'verdict_rule_version',
  'signal_hash', 'merkle_batch_id', 'merkle_proof',
  // FUNNEL-FIX-ATTRIBUTION-W1: agent_sessions first/last-touch source (the mock returns these
  // for every table introspect, so "all present" covers both tables).
  'first_touch_source', 'last_touch_source',
  // OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1: webhook_subscriptions lifecycle (3rd table).
  'delivery_state', 'failure_class', 'quarantined_at', 'next_probe_at', 'last_probe_at', 'last_success_at', 'disabled_reason',
  // CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1: contact_leads quarantine lane (4th table).
  //
  // ⚠️ `quarantined_at` APPEARS TWICE IN THIS LIST, AND THAT IS CORRECT. The list mirrors
  // SIGNAL_MIGRATIONS *ENTRIES*, not distinct column names, because test 3 asserts one ALTER per
  // declared entry — and `quarantined_at` is genuinely declared on two different tables
  // (webhook_subscriptions as a BIGINT epoch, contact_leads as a timestamp). De-duplicating it
  // would make test 3 under-count by one, which is exactly the drift this guard exists to catch.
  'spam_score', 'spam_reasons', 'quarantined_at',
  // OPS-SCORER-INPUT-PERSISTENCE-W1 R1a: the scorer's inputs, declared on TWO more tables
  // (5th and 6th) — `hold_decisions` and `band_signals`.
  //
  // ⚠️ ALL THIRTEEN NAMES APPEAR TWICE, AND THAT IS CORRECT, for exactly the reason the
  // `quarantined_at` note above gives: this list mirrors SIGNAL_MIGRATIONS *ENTRIES*, not
  // distinct column names, and each of these thirteen is genuinely declared on two different
  // tables. De-duplicating them would make test 3 under-count by thirteen.
  'rsi_score', 'ema_score', 'funding_score', 'oi_score', 'volume_score', 'raw0', 'funding_delta', 'hurst_delta', 'squeeze_delta', 'raw_final', 'funding_adjust_code', 'hurst_adjust_code', 'squeeze_adjust_code',  // hold_decisions
  'rsi_score', 'ema_score', 'funding_score', 'oi_score', 'volume_score', 'raw0', 'funding_delta', 'hurst_delta', 'squeeze_delta', 'raw_final', 'funding_adjust_code', 'hurst_adjust_code', 'squeeze_adjust_code',  // band_signals
];

interface MockPgBackend {
  query: ReturnType<typeof vi.fn>;
  execAsync: ReturnType<typeof vi.fn>;
}

function mockPg(presentCols: string[]): MockPgBackend {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      // Only used for the information_schema introspect query
      void sql;
      void params;
      return presentCols.map((c) => ({ column_name: c }));
    }),
    execAsync: vi.fn().mockResolvedValue(undefined),
  };
}

describe('OPS-HOUSEKEEPING-W1 Phase B: runPgMigrationsAsync idempotency', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: All columns present → 0 ALTERs ──
  it('all SIGNAL_MIGRATIONS columns already present → returns 0; zero ALTERs fired', async () => {
    const b = mockPg(ALL_SIGNAL_COLS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alterCount = await runPgMigrationsAsync(b as any);
    expect(alterCount).toBe(0);
    // Exactly one introspect query fired (NOT 13 individual ALTERs)
    // 6 distinct tables: signals + agent_sessions + webhook_subscriptions + contact_leads,
    // plus hold_decisions + band_signals (OPS-SCORER-INPUT-PERSISTENCE-W1 R1a).
    expect(b.query).toHaveBeenCalledTimes(6);
    expect(b.execAsync).toHaveBeenCalledTimes(0);
  });

  // ── Test 2: Some columns missing → ALTERs only for missing ──
  it('partial columns present → ALTERs fire only for missing ones', async () => {
    // Pretend 3 columns missing: pfe_return_pct, regime, merkle_proof
    const presentCols = ALL_SIGNAL_COLS.filter(
      (c) => !['pfe_return_pct', 'regime', 'merkle_proof'].includes(c),
    );
    const b = mockPg(presentCols);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alterCount = await runPgMigrationsAsync(b as any);
    expect(alterCount).toBe(3);
    expect(b.query).toHaveBeenCalledTimes(6); // 6 distinct tables — see the note in test 1
    expect(b.execAsync).toHaveBeenCalledTimes(3);

    // Verify the ALTER calls target ONLY the missing columns
    const altered = b.execAsync.mock.calls.map((call) => call[0]);
    expect(altered.some((sql: string) => sql.includes('ADD COLUMN IF NOT EXISTS pfe_return_pct'))).toBe(true);
    expect(altered.some((sql: string) => sql.includes('ADD COLUMN IF NOT EXISTS regime'))).toBe(true);
    expect(altered.some((sql: string) => sql.includes('ADD COLUMN IF NOT EXISTS merkle_proof'))).toBe(true);
    // None of the present columns should appear in altered
    expect(altered.some((sql: string) => sql.includes('ADD COLUMN IF NOT EXISTS outcome_price'))).toBe(false);
    expect(altered.some((sql: string) => sql.includes('ADD COLUMN IF NOT EXISTS exchange'))).toBe(false);
  });

  // ── Test 3: Empty schema → all SIGNAL_MIGRATIONS run ──
  it('empty schema (no migration columns present) → every declared ALTER fires', async () => {
    const b = mockPg([]); // No migration columns in the table
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alterCount = await runPgMigrationsAsync(b as any);
    // The expectation derives from the mirror above; there is deliberately NO literal count in
    // this comment. The previous wording claimed "22 (13 signals + 2 agent_sessions + 7
    // webhook_subscriptions)" and was already wrong before this wave touched it — signals had
    // grown to 15 and the true total was 24. A count quoted in prose is a duplicated fact that
    // goes stale in silence; point at the enumeration instead (CLAUDE.md).
    expect(alterCount).toBe(ALL_SIGNAL_COLS.length);
    expect(b.query).toHaveBeenCalledTimes(6); // 6 distinct tables — see the note in test 1
    expect(b.execAsync).toHaveBeenCalledTimes(ALL_SIGNAL_COLS.length);
  });

  // ── Test 4: ALTER calls use `IF NOT EXISTS` defense-in-depth ──
  it('ALTER calls preserve `IF NOT EXISTS` for race-condition safety', async () => {
    const b = mockPg([]); // All columns missing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPgMigrationsAsync(b as any);
    // Every ALTER call must include `IF NOT EXISTS`
    const allHaveIfNotExists = b.execAsync.mock.calls.every((call) =>
      typeof call[0] === 'string' && call[0].includes('ADD COLUMN IF NOT EXISTS'),
    );
    expect(allHaveIfNotExists).toBe(true);
  });
});
