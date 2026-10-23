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
  *
  * OPS-SERVED-CANDLE-TRUTH-W1 CH3 adds a second exclusion of the same kind: a declared scoring
  * exclusion (`PFE_DEFECT_WINDOWS`), every row of a class the public methodology rule names
  * (`SCORING_EXCLUSIONS_RULE`). Like S2, it changes win-rate ELIGIBILITY only; the published
  * population, every total, the Merkle anchors and `/verify` are untouched.
 */

/**
 * The subset of a signal row this module needs. Structural, so any row shape satisfies it.
 * `coin`, `timeframe`, `created_at` and `exchange` are what the scoring-exclusion predicate reads:
 * a row that lacks them is never excluded, so a caller that stopped projecting them would silently
 * exclude nothing (the `mae_return_pct` precedent). Required here so that caller does not compile.
 */
export interface PfeScorable {
  signal: string;
  pfe_return_pct?: number | null;
  mae_return_pct?: number | null;
  /** `signals.id`; read only by an `ids` row (STATS_COL_PROJECTION carries it, test-pinned). A row without it is in no `ids` row. */
  id?: number | null;
  coin: string;
  timeframe: string;
  /** INTEGER epoch SECONDS, as `signals.created_at` stores it. */
  created_at: number;
  /** Absent / NULL is Hyperliquid: `exchange || 'HL'`, the SQL `coalesce(exchange, 'HL')`. */
  exchange?: string | null;
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
 * The public methodology rule (Mr.1, ruling Q6, 2026-10-23), verbatim. It is a STANDING rule, not an
 * incident note: it names the classes of call win rate cannot score, and every `PFE_DEFECT_WINDOWS`
 * row must belong to a class it names (`uncoveredExclusionClasses`, test-pinned). S2 (a frozen book)
 * is its first clause; `INCOMPLETE_VENUE_WINDOW` is its second.
 */
export const SCORING_EXCLUSIONS_RULE =
  'Win rate counts only calls that can be scored from complete venue data: calls on a market that did not trade during the evaluation window, or priced from an incomplete venue candle window, are excluded. Every call stays counted, Merkle-anchored and verifiable.';

/** Each registry class, and the words of `SCORING_EXCLUSIONS_RULE` that name it. */
export const PFE_EXCLUSION_CLASS_NAMED_BY: Readonly<Record<string, string>> = Object.freeze({
  INCOMPLETE_VENUE_WINDOW: 'priced from an incomplete venue candle window',
});

export type PfeExclusionClass = 'INCOMPLETE_VENUE_WINDOW';

/**
 * A declared scoring exclusion: the calls whose entry price came from a venue candle window that
 * did not hold the venue's newest bar.
 *
 * Membership is a TUPLE (exchange, timeframe?, coin?, from?, before): an absent field matches every
 * value; `from` is inclusive and `before` exclusive, both epoch SECONDS. `ids` (raw `signals.id`) is
 * for a membership no tuple can express, and is used only then (ruling Q9). The TS predicate and its
 * SQL projection are generated from the same rows and pinned row for row in a real SQL engine.
 *
 * Like S2, a row here leaves WIN-RATE ELIGIBILITY only. It stays in the published population
 * (`published-population.ts`), in every total and call count, in its Merkle batch and on
 * `/api/verify-signal`: it was issued and anchored, and dropping it would rewrite a public record.
 * It cannot be evidence that a call's direction was right or wrong, because its entry price is not
 * one the venue printed at signal time.
 *
 * `reason` is INTERNAL: never rendered. The public surfaces carry `SCORING_EXCLUSIONS_RULE` only.
 */
export interface PfeDefectWindow {
  readonly class: PfeExclusionClass;
  readonly exchange: string;
  readonly timeframe?: string;
  readonly coin?: string;
  readonly from?: number;
  readonly before: number;
  readonly ids?: readonly number[];
  readonly owner: string;
  readonly reason: string;
}

export const PFE_DEFECT_WINDOWS: readonly PfeDefectWindow[] = Object.freeze([
  Object.freeze({
    class: 'INCOMPLETE_VENUE_WINDOW' as const,
    exchange: 'BITGET',
    timeframe: '1d',
    // 2026-10-22T14:03:11Z, the CH1 prod container start (deploy run 39791489391).
    before: 1792677791,
    owner: 'OPS-SERVED-CANDLE-TRUTH-W1',
    reason: 'A BITGET 1d serving read (100 bars) was answered by a page that ended before the venue newest bar: before 3d06e9be the clipped 90-day /market/candles page, from 3d06e9be to the CH1 container start its history fallback (ruling Q7 = A; both paths proven from the code).',
  }),
]);

/** The registry classes `rule` does not name. Empty is the only passing answer (test-pinned, two-way). */
export function uncoveredExclusionClasses(rows: readonly { class: string }[], rule: string = SCORING_EXCLUSIONS_RULE): string[] {
  return [...new Set(rows.map((w) => w.class))].filter((c) => {
    const words = PFE_EXCLUSION_CLASS_NAMED_BY[c];
    return words === undefined || !rule.includes(words);
  });
}

function inWindow(w: PfeDefectWindow, row: PfeScorable): boolean {
  const t = row.created_at;
  if (typeof t !== 'number' || !Number.isFinite(t)) return false;
  if ((row.exchange || 'HL') !== w.exchange) return false;
  if (w.timeframe !== undefined && row.timeframe !== w.timeframe) return false;
  if (w.coin !== undefined && row.coin !== w.coin) return false;
  if (w.from !== undefined && !(t >= w.from)) return false;
  if (!(t < w.before)) return false;
  if (w.ids !== undefined && (row.id == null || !w.ids.includes(row.id))) return false;
  return true;
}

/** Is this row inside one of `windows`? The registry form is `isDefectWindowEvaluation`. */
export function isDefectWindowEvaluationOf(windows: readonly PfeDefectWindow[], row: PfeScorable): boolean {
  return windows.some((w) => inWindow(w, row));
}

/** Is this row inside a declared scoring exclusion? */
export function isDefectWindowEvaluation(row: PfeScorable): boolean {
  return isDefectWindowEvaluationOf(PFE_DEFECT_WINDOWS, row);
}

/** Why a row is outside the win-rate population; `null` when it counts. */
export type PfeExclusion = 'hold' | 'unevaluated' | 'frozen' | 'defect_window';

/**
 * THE eligibility derivation. `isPfeEligible` and `pfeWinRateOf`'s exclusion counts both project
 * from it, so a reason can never be counted one way and applied another. The order is the
 * precedence: a frozen row inside a declared exclusion counts as frozen.
 */
export function pfeExclusionOf(row: PfeScorable): PfeExclusion | null {
  if (row.signal === 'HOLD') return 'hold';
  if (row.pfe_return_pct == null) return 'unevaluated';   // never evaluated (fetch failed / not due)
  if (isFrozenEvaluation(row)) return 'frozen';            // S2: the book was shut, not wrong
  return null;
}

/**
 * Does this row count toward the published PFE win rate?
 *
 * Replaces the bare `pfe_return_pct != null` filter at every site. The `signal !== 'HOLD'`
 * clause is folded in because a HOLD is not a directional call and never had a PFE outcome —
 * several call sites already excluded it separately, one via a `type !== 'HOLD'` conjunction.
 */
export function isPfeEligible(row: PfeScorable): boolean {
  return pfeExclusionOf(row) === null;
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

/** The evaluator ran. Also the explicit IS NULL arm `SQL_NOT_FROZEN` needs (sql-null-safe-predicate.test.ts). */
const SQL_EVALUATED = 'pfe_return_pct IS NOT NULL';

/** The `signals` columns the fragments here name; `qualify` prefixes exactly these. */
const FRAGMENT_COLUMNS = /(?<![\w.'])(pfe_return_pct|mae_return_pct|exchange|timeframe|created_at|coin|id)\b/g;

/** Qualify a fragment's columns with `alias`, for a query that aliases `signals`. */
function qualify(sql: string, alias: string | undefined): string {
  if (alias === undefined) return sql;
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`bad SQL alias ${JSON.stringify(alias)}`);
  return sql.replace(FRAGMENT_COLUMNS, `${alias}.$1`);
}

/** One registry row as SQL. Every interpolated value is shape-checked here, at the generator. */
function windowSql(w: PfeDefectWindow): string {
  const lit = (v: string, re: RegExp, what: string) => {
    if (!re.test(v)) throw new Error(`PFE_DEFECT_WINDOWS: unsafe ${what} ${JSON.stringify(v)}`);
    return `'${v}'`;
  };
  const sec = (v: number, what: string) => {
    if (!Number.isSafeInteger(v) || v < 1_600_000_000 || v > 9_999_999_999) throw new Error(`PFE_DEFECT_WINDOWS: ${what} ${v} is not epoch seconds`);
    return String(v);
  };
  const parts = [`coalesce(exchange, 'HL') = ${lit(w.exchange, /^[A-Z0-9]+$/, 'exchange')}`];
  if (w.timeframe !== undefined) parts.push(`timeframe = ${lit(w.timeframe, /^[0-9]+[mhdw]$/, 'timeframe')}`);
  if (w.coin !== undefined) parts.push(`coin = ${lit(w.coin, /^[A-Za-z0-9:._-]+$/, 'coin')}`);
  if (w.from !== undefined) parts.push(`created_at >= ${sec(w.from, 'from')}`);
  parts.push(`created_at < ${sec(w.before, 'before')}`);
  if (w.ids !== undefined) {
    if (w.ids.length === 0 || !w.ids.every((i) => Number.isSafeInteger(i) && i > 0)) throw new Error('PFE_DEFECT_WINDOWS: ids must be positive integers, at least one');
    parts.push(`id IN (${w.ids.join(', ')})`);
  }
  return `NOT coalesce(${parts.join(' AND ')}, false)`;
}

/**
 * The SQL projection of NOT `isDefectWindowEvaluation`, generated from `PFE_DEFECT_WINDOWS`.
 * NULL-safe: each window test sits inside `coalesce(…, false)`, so a row with a NULL timeframe,
 * coin or created_at is "not in the window", the TypeScript answer, instead of NULL, which a FILTER
 * reads as false and drops. With no window declared it is `TRUE`.
 */
export function sqlNotDefectWindow(alias?: string): string {
  return sqlNotDefectWindowOf(PFE_DEFECT_WINDOWS, alias);
}

/** `sqlNotDefectWindow` over any window list (the tests' tuple fixtures; the registry form above). */
export function sqlNotDefectWindowOf(windows: readonly PfeDefectWindow[], alias?: string): string {
  if (windows.length === 0) return 'TRUE';
  return qualify(windows.map(windowSql).join(' AND '), alias);
}

/** The SQL projection of `isPfeEligible` (minus the HOLD clause, which the caller groups on). */
export function sqlPfeEligible(alias?: string): string {
  return qualify(`${SQL_EVALUATED} AND ${SQL_NOT_FROZEN}`, alias);
}

/** `sqlPfeEligible()` over the unaliased `signals` table, the form every current reader uses. */
export const SQL_PFE_ELIGIBLE = sqlPfeEligible();

/**
 * Win rate over a row set, applying the canonical eligibility rule. Returns `null` on an empty
 * eligible set rather than `0` — "no data" and "everything lost" must never render alike.
 */
export function pfeWinRateOf(rows: PfeScorable[]): {
  rate: number | null; evaluated: number; wins: number; excludedFrozen: number; excludedDefectWindow: number;
} {
  const why = rows.map(pfeExclusionOf);
  const eligible = rows.filter((_, i) => why[i] === null);
  const wins = eligible.filter(isPfeWinRow).length;
  return {
    rate: eligible.length > 0 ? wins / eligible.length : null,
    evaluated: eligible.length,
    wins,
    excludedFrozen: why.filter((w) => w === 'frozen').length,
    excludedDefectWindow: why.filter((w) => w === 'defect_window').length,
  };
}
