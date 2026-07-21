/**
 * pfe-scoring.ts — OPS-PFE-METRIC-INTEGRITY-W1 R5.
 *
 * THE canonical answer to "does this row count toward the published PFE win rate?".
 *
 * Before this module, that question was re-derived at **11 separate sites** in
 * `performance-db.ts` as a bare `s.pfe_return_pct != null` filter — overall, per-signal-type,
 * per-timeframe, per-asset, per-tier, per-exchange, and again inside each per-exchange
 * breakdown. Eleven parallel copies of one rule is exactly the drift the single-derivation LAW
 * exists to prevent: change the eligibility rule and ten of eleven surfaces silently keep the
 * old one, so the headline and its own breakdowns disagree.
 *
 * ── WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT ──
 *
 * EXCLUDED (new): **S2 — a frozen book.** `pfe_return_pct === 0 AND mae_return_pct === 0`
 * means price did not move in EITHER direction across the whole evaluation window. Several
 * venues emit zero-volume synthetic flat candles for a non-trading book rather than omitting
 * the bar, so the window is real, the fetch succeeded, and nothing happened. A market that was
 * SHUT is not a call that was WRONG. Measured contemporaneous: 1,041 rows, BUY 0.108% vs SELL
 * 14.654% — a 135x directional asymmetry that is an artifact of where we emit, not of edge.
 *
 * KEPT (unchanged): **S1 — a genuine loss.** `pfe === 0` with `mae !== 0` means price DID move,
 * just never favourably. That is a real losing call and it stays in the denominator. Measured:
 * 27,034 rows — ~26x larger than S2.
 *
 * ⚠️ **THE TRAP THIS MODULE EXISTS TO NOT FALL INTO.** PFE is one-sided by construction
 * (`pfePrice` initialises to entry and updates only on improvement), so across 343,478
 * contemporaneous evaluated rows there is not ONE row where PFE moved adversely. Therefore
 *
 *     PFE win rate  ===  1 - P(pfe_return_pct = 0)
 *
 * exactly. The losing side of the metric IS the zero bucket. Excluding **all** `pfe = 0` rows
 * would therefore drive every cohort to exactly **100.00%** — which is why any cohort reading
 * 100.00% is the documented FAIL signature, not a result. Only the `mae === 0` half is a
 * defect; `isFrozenEvaluation` is deliberately a conjunction.
 *
 * Rows the evaluator never scored are unaffected: a failed or empty candle fetch leaves
 * `pfe_return_pct` NULL and was already outside every cohort (verified: `outcome_price IS NULL`
 * ⟺ `pfe_candles IS NULL`, zero mixed cells).
 */

/** The subset of a signal row this module needs. Structural, so any row shape satisfies it. */
export interface PfeScorable {
  signal: string;
  pfe_return_pct?: number | null;
  mae_return_pct?: number | null;
}

/**
 * S2 — the frozen-book predicate. Mathematically airtight, not a heuristic: for a BUY,
 * `pfe = 0` ⟹ every high ≤ entry and `mae = 0` ⟹ every low ≥ entry; since `low ≤ high` always,
 * that forces `low = high = entry` on every candle in the window. Validated 12/12 by historical
 * candle refetch, and by the live probe that found ASTER `QQQUSDT` returning five consecutive
 * bars of `694.84 × 4, volume 0.00, trades 0`.
 */
export function isFrozenEvaluation(row: PfeScorable): boolean {
  return row.pfe_return_pct === 0 && row.mae_return_pct === 0;
}

/**
 * Does this row count toward the published PFE win rate?
 *
 * Replaces the bare `pfe_return_pct != null` filter at every site. The `signal !== 'HOLD'`
 * clause is folded in because a HOLD is not a directional call and never had a PFE outcome —
 * several call sites already excluded it separately, one via a `type !== 'HOLD'` conjunction.
 */
export function isPfeEligible(row: PfeScorable): boolean {
  if (row.signal === 'HOLD') return false;
  if (row.pfe_return_pct == null) return false;      // never evaluated (fetch failed / not due)
  if (isFrozenEvaluation(row)) return false;         // S2: the book was shut, not wrong
  return true;
}

/**
 * The canonical win predicate: a BUY wins on a favourable (positive) excursion, a SELL on a
 * negative one. Unchanged by this wave — only the ELIGIBILITY rule moved.
 */
export function isPfeWinRow(row: PfeScorable): boolean {
  const pfe = row.pfe_return_pct ?? 0;
  return row.signal === 'BUY' ? pfe > 0 : pfe < 0;
}

/**
 * The SQL projection of `isFrozenEvaluation`, for the PG GROUP-BY pushdown path.
 *
 * ⚠️ THERE ARE TWO DERIVATIONS OF THIS RULE AND THEY MUST AGREE. `getPerformanceStatsAsync`
 * has a SQL pushdown (`PERF_STATS_SQL_PUSHDOWN`, **ON in prod**) that aggregates in Postgres
 * and never materialises rows, so the TypeScript predicates above are simply not on the live
 * path. A change applied to only one of them is a silent no-op on the published number —
 * which is exactly what happened on the first attempt at this wave, and was caught only
 * because the post-deploy headline moved +0.0004pp instead of the expected +0.29pp.
 *
 * Keep these two in lockstep. `tests/unit/pfe-scoring-eligibility.test.ts` pins them against
 * each other over a fixture matrix, so a change to one that is not mirrored in the other fails
 * the suite rather than the production metric.
 */
export const SQL_NOT_FROZEN = 'NOT (pfe_return_pct = 0 AND mae_return_pct = 0)';

/** The SQL projection of `isPfeEligible` (minus the HOLD clause, which the caller groups on). */
export const SQL_PFE_ELIGIBLE = `pfe_return_pct IS NOT NULL AND ${SQL_NOT_FROZEN}`;

/**
 * Win rate over a row set, applying the canonical eligibility rule. Returns `null` on an empty
 * eligible set rather than `0` — "no data" and "everything lost" must never render alike.
 */
export function pfeWinRateOf(rows: PfeScorable[]): { rate: number | null; evaluated: number; wins: number; excludedFrozen: number } {
  const excludedFrozen = rows.filter((r) => r.signal !== 'HOLD' && r.pfe_return_pct != null && isFrozenEvaluation(r)).length;
  const eligible = rows.filter(isPfeEligible);
  const wins = eligible.filter(isPfeWinRow).length;
  return {
    rate: eligible.length > 0 ? wins / eligible.length : null,
    evaluated: eligible.length,
    wins,
    excludedFrozen,
  };
}
