/**
 * published-population.ts — OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R1.
 *
 * THE canonical answer to "is this row part of the population behind a published number?".
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────────────────────
 *
 * Before this module the answer was **nowhere**. Every public consumer of `signals` inherited its
 * confidence population from the WRITE gate in `src/tools/get-trade-call.ts` and stated nothing
 * itself — `buildStatsAggregateSql`'s own docstring said, in as many words, *"NO confidence
 * filter (enforced at write)"*. Measured 2026-08-30 on prod: 10 of 12 readers that reach a public
 * surface carried no confidence predicate of any kind.
 *
 * That is an inversion, and it is the defect this module retires: **a public aggregate must state
 * its own population, never inherit it from what a writer happened to insert.** Under the old
 * shape a single INSERT below the gate — from a future wave, a backfill, a migration, a
 * counterfactual capture — silently moves a published win rate, a published call count, and the
 * on-chain Merkle anchor, with nothing failing anywhere.
 *
 * ── THE DISCLOSURE THIS MAKES TRUE ───────────────────────────────────────────────────────────
 *
 * `METHODOLOGY.signalFilter` (performance-db.ts) is served on `/api/performance-public`,
 * `performance://signal-performance` and `get_track_record`, and reads:
 *
 *     "Recording gate: non-HOLD calls with confidence >= 52% at signal time.
 *      Aggregation excludes HOLD and applies no further confidence filter."
 *
 * The predicate below is set to EXACTLY that disclosed recording gate, so it removes zero rows
 * and adds no FURTHER restriction — the disclosure stays byte-true and byte-unchanged. That is
 * not a wording convenience: the string already CLAIMS the population is `confidence >= 52` while
 * nothing in the read path enforced it, so this module makes the code conform to a disclosure
 * that already existed. `tests/unit/published-population.test.ts` pins the predicate value
 * against the value parsed out of the disclosure, so the two can never drift apart.
 *
 * ── TWO PROJECTIONS, ONE RULE — KEEP THEM IN LOCKSTEP ────────────────────────────────────────
 *
 * Modelled on `pfe-scoring.ts` (`isPfeEligible` / `SQL_PFE_ELIGIBLE`), and for the same measured
 * reason: `getPerformanceStatsAsync` has a SQL GROUP-BY pushdown (`PERF_STATS_SQL_PUSHDOWN`, **ON
 * in prod**) that aggregates in Postgres and never materialises rows, so a rule applied only to
 * the TypeScript predicate is a silent no-op on the published number. Both projections are
 * derived from the ONE constant below and pinned against each other by that same test file.
 *
 * ── THIS MODULE IS A LEAF. KEEP IT ONE ───────────────────────────────────────────────────────
 *
 * It imports nothing. `get-trade-call.ts` imports `performance-db.ts`, so `performance-db.ts`
 * cannot import `get-trade-call.ts` to reach the constant — a leaf both of them import is what
 * makes ONE literal `52` possible without a cycle. Adding an import here reintroduces the cycle
 * this shape exists to break.
 */

/**
 * The recording gate: the minimum confidence at which a non-HOLD call is persisted to `signals`
 * and therefore admitted to the published track record.
 *
 * RELOCATED VERBATIM from `src/tools/get-trade-call.ts` (value unchanged, 52 since 2026-04-15 —
 * R6 lowered it 60 → 52 after the `MAX_RAW_SCORE` fix to preserve the pre-R1 effective rawScore
 * floor of ~44.4; see `experiments/quant-trading-server/phase-c-results.md`). This is now the ONE
 * definition in the codebase; there is no second literal to drift from.
 *
 * ⚠ CHANGING THIS VALUE IS A PUBLIC-NUMBER CHANGE, not a tuning knob. It is the disclosed
 * population boundary on three public channels, it decides which rows the on-chain Merkle anchor
 * covers, and lowering it would admit an unmeasured confidence band into a record that is
 * Merkle-anchored and can never be restated.
 */
export const MIN_TRACKABLE_CONFIDENCE = 52;

/** The subset of a signal row this module needs. Structural, so any row shape satisfies it. */
export interface PublishedPopulationScorable {
  confidence?: number | null;
}

/**
 * Does this row belong to the population behind a published number?
 *
 * A NULL/absent confidence is NOT admitted. `signals.confidence` has been NOT NULL in practice on
 * every row ever written (measured 2026-08-30: min 52 over n=523,771), so this branch is
 * unreachable today — and it default-DENIES rather than defaulting open, because the direction of
 * an unreachable branch is exactly what decides the blast radius when it stops being unreachable.
 */
export function isPublishedPopulation(row: PublishedPopulationScorable): boolean {
  const c = row.confidence;
  if (c == null) return false;
  return c >= MIN_TRACKABLE_CONFIDENCE;
}

/**
 * The SQL projection of `isPublishedPopulation`, for the PG pushdown and every other query that
 * reaches a public surface.
 *
 * `alias` qualifies the column for queries that name the table (`FROM signals s`); omit it for the
 * bare `FROM signals` form. The comparison is built from `MIN_TRACKABLE_CONFIDENCE` so there is
 * never a second literal to update.
 *
 * NULL SEMANTICS DIFFER FROM THE TS PREDICATE **AND THAT IS CORRECT**: `NULL >= 52` is NULL, which
 * SQL treats as not-matching, so a NULL-confidence row is excluded on both sides. Stating it here
 * because "SQL three-valued logic happens to agree with us" is the kind of agreement that is worth
 * writing down rather than rediscovering.
 */
export function sqlPublishedPopulation(alias?: string): string {
  const col = alias ? `${alias}.confidence` : 'confidence';
  return `${col} >= ${MIN_TRACKABLE_CONFIDENCE}`;
}

/** The unaliased form, for the common `FROM signals` case. One derivation — see above. */
export const SQL_PUBLISHED_POPULATION = sqlPublishedPopulation();
