/**
 * tests/unit/backfill-queue-backoff.test.ts — OPS-OUTCOME-BACKFILL-STALL-W1 A1
 *
 * ── What broke, so the assertions below read as consequences rather than taste ────────────────
 * `OUTCOME_BACKFILL_STALLED` paged 2026-09-05T17:13:01Z. The producer was alive and writing the
 * whole time (`matured_total` +245 across an 11m38s read pair, live PIDs, lock held by a live
 * holder). What had failed was REACHABILITY: `getSignalsNeedingUnifiedBackfillAsync` served
 * `WHERE outcome_price IS NULL ORDER BY created_at ASC LIMIT 5000` against an 11,748-11,823-row
 * NULL backlog, so the window's newest row sat at 07:16Z and every fresher signal was invisible
 * to the producer by construction. 3,058 permanently-unfillable rows (barrier closed >24h ago)
 * occupied the head and were re-fetched and re-skipped in EVERY batch, because a "no candles
 * after signal time" result increments `skipped` and never touched the in-process `failCounts`
 * breaker: `Batch 67 done: 11 filled, 2037 skipped, 0 errors`.
 *
 * ── The two properties these tests exist to pin ───────────────────────────────────────────────
 * 1. THE BREAKER IS A BACKOFF, NOT A TOMBSTONE (Data Integrity LAW). A row is held out only while
 *    it is BOTH maxed out AND still cooling. Sparse-market symbols do fill later — CXMT filled
 *    692 of 1,369 — so a permanent exclusion would zero public-facing rows as a side effect.
 * 2. A NEVER-ATTEMPTED ROW IS ALWAYS ADMITTED. SQL three-valued logic makes `NOT (NULL >= 3 AND
 *    ...)` evaluate to NULL, i.e. FALSE for a WHERE, which would exclude every historical row —
 *    the entire backlog — under a predicate that looks correct. That is a total outage wearing a
 *    backoff's clothes, and it is why the NULL arm is asserted explicitly and not just implied.
 *
 * The SQL string is the artifact the unit suite otherwise never executes (the backend is mocked
 * everywhere), so it is built by a pure exported fn and asserted directly — the same seam-blind
 * lesson that shipped a `%`-formatted LIKE clause in a sibling canary.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBackfillQueueSql,
  BACKFILL_QUEUE_LIMIT,
  BACKFILL_MAX_ATTEMPTS,
  BACKFILL_ATTEMPT_COOLDOWN_S,
} from '../../src/lib/performance-db.js';

/** A tiny SQL evaluator for the emitted WHERE clause, with real three-valued logic. */
type Row = {
  outcome_price: number | null;
  outcome_attempts: number | null;
  outcome_last_attempt_at: number | null;
};

/**
 * Evaluate the emitted predicate the way Postgres would, INCLUDING NULL propagation.
 *
 * Written as an interpreter of the real clause rather than a restatement of the intent: a
 * hand-written `admits()` that re-implements the rule would agree with a broken predicate,
 * which is the characterisation-test trap. This parses the actual string the producer runs.
 */
function admits(sql: string, row: Row): boolean {
  const m = sql.match(/WHERE (.+) ORDER BY/);
  if (!m) throw new Error(`no WHERE..ORDER BY in: ${sql}`);
  const expr = m[1];
  // Translate SQL to JS with SQL's NULL semantics preserved by using `null`-aware comparisons.
  const js = expr
    .replace(/(\w+) IS NULL/g, '($1 === null)')
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||')
    .replace(/(\w+) (<|<=|>|>=) (\d+)/g, '($1 !== null && $1 $2 $3)');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function('outcome_price', 'outcome_attempts', 'outcome_last_attempt_at',
    `return Boolean(${js});`) as (a: unknown, b: unknown, c: unknown) => boolean;
  return fn(row.outcome_price, row.outcome_attempts, row.outcome_last_attempt_at);
}

const NOW = 1_788_632_813; // 2026-09-05T18:26:53Z — the wave's own R1 read #2 instant.

describe('OPS-OUTCOME-BACKFILL-STALL-W1 A1 — backfill queue predicate', () => {
  const sql = buildBackfillQueueSql(NOW);

  it('keeps the cap as DATA, never a second literal', () => {
    // The canary's reachability arm compares an uncapped backlog against this exact constant.
    // A hardcoded 5000 in either place is the duplicated-fact class this estate has paid for.
    expect(sql).toContain(`LIMIT ${BACKFILL_QUEUE_LIMIT}`);
    expect(BACKFILL_QUEUE_LIMIT).toBe(5000); // unchanged — raising it was REJECTED as a countdown
  });

  it('preserves oldest-first ordering and the NULL-outcome subject', () => {
    expect(sql).toContain('outcome_price IS NULL');
    expect(sql).toContain('ORDER BY created_at ASC');
  });

  it('carries an explicit NULL arm for a never-attempted row', () => {
    // Not stylistic: without it, three-valued logic excludes the whole historical backlog.
    expect(sql).toContain('outcome_attempts IS NULL');
    expect(sql).toContain('outcome_last_attempt_at IS NULL');
  });

  it('ADMITS a never-attempted historical row (the entire pre-wave backlog)', () => {
    expect(admits(sql, { outcome_price: null, outcome_attempts: null, outcome_last_attempt_at: null }))
      .toBe(true);
  });

  it('ADMITS a row below the attempt ceiling', () => {
    expect(admits(sql, {
      outcome_price: null,
      outcome_attempts: BACKFILL_MAX_ATTEMPTS - 1,
      outcome_last_attempt_at: NOW - 60,
    })).toBe(true);
  });

  it('EXCLUDES a maxed-out row that is still cooling', () => {
    expect(admits(sql, {
      outcome_price: null,
      outcome_attempts: BACKFILL_MAX_ATTEMPTS,
      outcome_last_attempt_at: NOW - 60,
    })).toBe(false);
  });

  it('RE-ADMITS a maxed-out row once the cooldown has elapsed — backoff, NOT a tombstone', () => {
    // The Data Integrity assertion. A permanent exclusion would zero rows that become fillable
    // when a sparse market reopens (CXMT filled 692 of 1,369), i.e. delete public-facing data as
    // a side effect. If this test ever needs "fixing", the fix is the code, not the test.
    expect(admits(sql, {
      outcome_price: null,
      outcome_attempts: BACKFILL_MAX_ATTEMPTS * 10,
      outcome_last_attempt_at: NOW - BACKFILL_ATTEMPT_COOLDOWN_S - 1,
    })).toBe(true);
  });

  it('EXCLUDES an already-filled row regardless of attempt history', () => {
    expect(admits(sql, { outcome_price: 1.23, outcome_attempts: null, outcome_last_attempt_at: null }))
      .toBe(false);
  });

  it('moves the cooldown boundary with `now`, so the clause is a function of time not of build', () => {
    const later = buildBackfillQueueSql(NOW + 3600);
    expect(later).not.toBe(sql);
    const stale = { outcome_price: null, outcome_attempts: 9, outcome_last_attempt_at: NOW - BACKFILL_ATTEMPT_COOLDOWN_S + 1800 };
    expect(admits(sql, stale)).toBe(false);      // cooling at NOW
    expect(admits(later, stale)).toBe(true);     // released an hour later
  });

  it('the cooldown is bounded and finite — an infinite cooldown IS a tombstone', () => {
    expect(Number.isFinite(BACKFILL_ATTEMPT_COOLDOWN_S)).toBe(true);
    expect(BACKFILL_ATTEMPT_COOLDOWN_S).toBeGreaterThan(0);
    expect(BACKFILL_ATTEMPT_COOLDOWN_S).toBeLessThanOrEqual(7 * 86_400);
  });
});

describe('OPS-OUTCOME-BACKFILL-STALL-W1 A1 — the write stamp is ATOMIC with the outcome', () => {
  it('updateSignalOutcomes issues ONE statement setting both the outcome and the stamp', async () => {
    // Read the source rather than the mocked runtime: the property is about the SQL text, and a
    // crash between two statements would mint an outcome with no stamp — permanently invisible to
    // a canary keyed on max(outcome_filled_at), and indistinguishable from a dead producer.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/lib/performance-db.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function updateSignalOutcomes'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('outcome_filled_at = ?');
    expect(body).toContain('pfe_return_pct = ?');
    // Exactly one UPDATE in the function — a second statement is the defect this pins.
    expect(body.match(/UPDATE signals SET/g) ?? []).toHaveLength(1);
  });

  it('recordBackfillAttempt increments from NULL via COALESCE, never leaving it NULL forever', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/lib/performance-db.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function recordBackfillAttempt'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('COALESCE(outcome_attempts, 0) + 1');
    expect(body).toContain('outcome_last_attempt_at = ?');
  });
});

describe('OPS-OUTCOME-BACKFILL-STALL-W1 A1 — the durable breaker sees BOTH failure classes', () => {
  it('backfill-outcomes records an attempt on the no-candle path AND on the error path', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/scripts/backfill-outcomes.ts', import.meta.url), 'utf8');
    // The dominant sediment class. Its absence from the old breaker is the generator bug.
    const noCandle = src.slice(src.indexOf('no candles after signal time'));
    expect(noCandle.slice(0, 400)).toContain('recordBackfillAttempt');
    // The thrown-error class, previously only counted in a per-process Map.
    const errPath = src.slice(src.indexOf('const msg = err instanceof Error'));
    expect(errPath.slice(0, 500)).toContain('recordBackfillAttempt');
  });

  it('does NOT record an attempt for an immature row or for our own rate limiting', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/scripts/backfill-outcomes.ts', import.meta.url), 'utf8');
    // `now < endTimeNeeded` — the barrier has not closed. Backing these off would penalise the
    // FRESHEST rows in the queue, which is the exact population whose absence caused the outage.
    const notReady = src.slice(src.indexOf('if (now < endTimeNeeded)'));
    expect(notReady.slice(0, 160)).not.toContain('recordBackfillAttempt');
    // WeightBudgetSkipError — transient budget saturation is our fault, not the row's.
    const budget = src.slice(src.indexOf('if (err instanceof WeightBudgetSkipError)'));
    expect(budget.slice(0, 400)).not.toContain('recordBackfillAttempt');
  });

  it('the lazy resource path feeds the SAME breaker (one queue, two consumers)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/resources/signal-performance.ts', import.meta.url), 'utf8');
    expect(src).toContain('recordBackfillAttempt');
    expect(src.match(/recordBackfillAttempt\(sig\.id!\)/g) ?? []).toHaveLength(2);
  });
});

describe('OPS-OUTCOME-BACKFILL-STALL-W1 A1 — the columns are additive and non-public', () => {
  it('all three new columns are nullable with no DEFAULT (catalog-only ALTER on PG)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/lib/performance-db.ts', import.meta.url), 'utf8');
    for (const col of ['outcome_filled_at', 'outcome_attempts', 'outcome_last_attempt_at']) {
      const row = src.match(new RegExp(`\\{ table: 'signals', column: '${col}', type: '([^']+)' \\}`));
      expect(row, `${col} must be declared in SIGNAL_MIGRATIONS`).toBeTruthy();
      expect(row![1]).toBe('INTEGER');           // epoch, matching created_at on this same table
      expect(row![1]).not.toContain('NOT NULL');  // a NOT NULL add would rewrite a ~598k-row table
      expect(row![1]).not.toContain('DEFAULT');
    }
  });

  it('none of the three can reach a public performance payload', async () => {
    const { PUBLIC_PERF_FORBIDDEN_KEYS } = await import('../../src/lib/public-performance-formatter.js');
    for (const col of ['outcome_filled_at', 'outcome_attempts', 'outcome_last_attempt_at']) {
      expect(PUBLIC_PERF_FORBIDDEN_KEYS as readonly string[]).toContain(col);
    }
  });
});
