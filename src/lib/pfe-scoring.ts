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

import { BITGET_YOUNG, BITGET_YOUNG_1D, BITGET_YOUNG_IDS, WHITEBIT_CROSSED, WHITEBIT_PAST_THRESHOLD } from './pfe-defect-window-rows.js';
import { TIMEFRAMES } from './capabilities.js';
import { SNAPSHOT_KLINE_MAX_LAG_MS } from './live-price.js';

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
 * value; `from` is inclusive and `before` exclusive, both epoch SECONDS. `coins` is the same tuple for
 * several coins at once (every other field shared), so a class measured per coin stays one row per
 * (timeframe, from, before) instead of one per coin. `withinAfterBoundaryS` narrows a row to the calls
 * created within that many seconds after their bar boundary (`created_at % step < n`, the step read off
 * `timeframe`; UTC epoch-aligned bars): a class that exists only while a venue's snapshot still lags a
 * boundary (ruling Q12). `ids` (raw `signals.id`) is for a membership no tuple can express, and is used
 * only then (ruling Q9). The TS predicate and its SQL projection are
 * generated from the same rows and pinned row for row in a real SQL engine.
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
  /** Never together with `coin`; non-empty (the generator refuses both). */
  readonly coins?: readonly string[];
  readonly from?: number;
  readonly before: number;
  /** Requires `timeframe` (a minute / hour / day step); an integer in (0, step). */
  readonly withinAfterBoundaryS?: number;
  readonly ids?: readonly number[];
  readonly owner: string;
  readonly reason: string;
}

const OWNER = 'OPS-SERVED-CANDLE-TRUTH-W1';
const INCOMPLETE = 'INCOMPLETE_VENUE_WINDOW' as const;
/** 2026-10-22T14:03:11Z, the CH1 prod container start (deploy run 39791489391). */
const CH1_START = 1792677791;
/** 2026-10-23T09:08:12Z, the CH3a prod container start (deploy run 39928650001): every class below ends here. */
export const CH3A_START = 1792746492;
/** 2026-10-24T09:18:00Z, the CH3a-R1 prod container start (deploy run 40080895541; Cowork Q11): from here an ASTER call
 * is priced from its ticker's last trade. */
export const CH3A_R1_START = 1792833480;

/** The INTERNAL reason of each measured class (never rendered). The tuples are in pfe-defect-window-rows.ts. */
const REASON = {
  BITGET_YOUNG_1D: 'A BITGET 1d serving read whose /market/candles page held fewer than 90 bars (a young listing) was answered from /market/history-candles, which holds closed bars only, from the CH1 container start to the CH3a one: priced at forming - 1 (ruling Q7 = A, row 2; code path + price match).',
  BITGET_YOUNG: 'A BITGET 1h-12h serving read on a young listing (listing later than t - 95 x the requested step) was answered from /market/history-candles, which holds closed bars only, from 3d06e9be to the CH3a container start: priced at forming - 1 (ruling Q9 = A; code path + row-for-row price match).',
  PHEMEX: 'PHEMEX /kline/last serves closed bars only, so every PHEMEX call before the CH3a container start was priced at forming - 1 (ruling Q8/Q9 = A; code path + endpoint census + a 200-row-per-timeframe price match).',
  WHITEBIT: 'A WHITEBIT serving read on a market holding >= 1001 bars of the served step answered the OLDEST 1000 of them and dropped the forming bar, before the CH3a container start: priced at forming - 1 (ruling Q9 = A; code path + row-for-row price match).',
  ASTER: 'ASTER /fapi/v1/klines answers a snapshot refreshed every ~75-90 s for every interval of a symbol at once, so a call created within SNAPSHOT_KLINE_MAX_LAG_MS after its bar boundary, before the CH3a-R1 container start, may have been priced from a snapshot that did not yet hold the forming bar. Every such row leaves scoring: the price-confirmed members and the rows whose window completeness cannot be shown (ruling Q12 = A; mechanism window + price match against ASTER 1m history).',
};
/** The ASTER mechanism window, in seconds after the bar boundary: the measured snapshot bound the canary holds. */
const ASTER_SNAPSHOT_LAG_S = SNAPSHOT_KLINE_MAX_LAG_MS / 1000;
const frozenRow = (w: PfeDefectWindow): PfeDefectWindow => Object.freeze({ ...w, ...(w.coins ? { coins: Object.freeze([...w.coins]) } : {}), ...(w.ids ? { ids: Object.freeze([...w.ids]) } : {}) });

/** A minute / hour / day timeframe's step in seconds, read off the literal; null for anything else (a week is not
 *  epoch-aligned, so no phase row may sit on it). */
export function boundaryStepS(timeframe: string | undefined): number | null {
  const m = /^([1-9][0-9]*)([mhd])$/.exec(timeframe ?? '');
  return m ? Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as 'm' | 'h' | 'd'] : null;
}

export const PFE_DEFECT_WINDOWS: readonly PfeDefectWindow[] = Object.freeze([
  frozenRow({
    class: INCOMPLETE,
    exchange: 'BITGET',
    timeframe: '1d',
    before: CH1_START,
    owner: OWNER,
    reason: 'A BITGET 1d serving read (100 bars) was answered by a page that ended before the venue newest bar: before 3d06e9be the clipped 90-day /market/candles page, from 3d06e9be to the CH1 container start its history fallback (ruling Q7 = A; both paths proven from the code).',
  }),
  ...BITGET_YOUNG_1D.map(([timeframe, coin, from, before]) => frozenRow({ class: INCOMPLETE, exchange: 'BITGET', timeframe, coin, from, before, owner: OWNER, reason: REASON.BITGET_YOUNG_1D })),
  ...BITGET_YOUNG.map(([timeframe, coin, from, before]) => frozenRow({ class: INCOMPLETE, exchange: 'BITGET', timeframe, coin, from, before, owner: OWNER, reason: REASON.BITGET_YOUNG })),
  ...BITGET_YOUNG_IDS.map(([timeframe, coin, ids]) => frozenRow({ class: INCOMPLETE, exchange: 'BITGET', timeframe, coin, before: CH3A_START, ids, owner: OWNER, reason: REASON.BITGET_YOUNG })),
  frozenRow({ class: INCOMPLETE, exchange: 'PHEMEX', before: CH3A_START, owner: OWNER, reason: REASON.PHEMEX }),
  ...WHITEBIT_PAST_THRESHOLD.map(([timeframe, coins, before]) => frozenRow({ class: INCOMPLETE, exchange: 'WHITEBIT', timeframe, coins, before, owner: OWNER, reason: REASON.WHITEBIT })),
  ...WHITEBIT_CROSSED.map(([timeframe, coin, from, before]) => frozenRow({ class: INCOMPLETE, exchange: 'WHITEBIT', timeframe, coin, from, before, owner: OWNER, reason: REASON.WHITEBIT })),
  // One row per timeframe; on a step no longer than the lag (1m) every call is inside it, so that row has no phase.
  ...TIMEFRAMES.map((timeframe) => frozenRow({
    class: INCOMPLETE, exchange: 'ASTER', timeframe, before: CH3A_R1_START, owner: OWNER, reason: REASON.ASTER,
    ...(ASTER_SNAPSHOT_LAG_S < (boundaryStepS(timeframe) ?? 0) ? { withinAfterBoundaryS: ASTER_SNAPSHOT_LAG_S } : {}),
  })),
]);


/** The registry classes `rule` does not name. Empty is the only passing answer (test-pinned, two-way). */
export function uncoveredExclusionClasses(rows: readonly { class: string }[], rule: string = SCORING_EXCLUSIONS_RULE): string[] {
  return [...new Set(rows.map((w) => w.class))].filter((c) => {
    const words = PFE_EXCLUSION_CLASS_NAMED_BY[c];
    return words === undefined || !rule.includes(words);
  });
}

// A registry class the public rule does not name would exclude calls the methodology never discloses: the registry
// is refused at load, as the SQL generator refuses a malformed row — every test importing this module reds first.
{
  const uncovered = uncoveredExclusionClasses(PFE_DEFECT_WINDOWS);
  if (uncovered.length > 0) throw new Error(`PFE_DEFECT_WINDOWS: SCORING_EXCLUSIONS_RULE names no class ${uncovered.join(', ')}`);
}

function inWindow(w: PfeDefectWindow, row: PfeScorable): boolean {
  const t = row.created_at;
  if (typeof t !== 'number' || !Number.isFinite(t)) return false;
  if ((row.exchange || 'HL') !== w.exchange) return false;
  if (w.timeframe !== undefined && row.timeframe !== w.timeframe) return false;
  if (w.coin !== undefined && row.coin !== w.coin) return false;
  if (w.coins !== undefined && !w.coins.includes(row.coin)) return false;
  if (w.from !== undefined && !(t >= w.from)) return false;
  if (!(t < w.before)) return false;
  if (w.withinAfterBoundaryS !== undefined) {
    const step = boundaryStepS(w.timeframe);
    if (step === null || !(((t % step) + step) % step < w.withinAfterBoundaryS)) return false;
  }
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
  if (isDefectWindowEvaluation(row)) return 'defect_window'; // its entry price is not the venue's at signal time
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

/**
 * Qualify a fragment's columns with `alias`, for a query that aliases `signals`. String literals are
 * left alone: a registry coin such as `xyz:id` would otherwise be rewritten inside its own quotes.
 */
function qualify(sql: string, alias: string | undefined): string {
  if (alias === undefined) return sql;
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`bad SQL alias ${JSON.stringify(alias)}`);
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 === 1 ? part : part.replace(FRAGMENT_COLUMNS, `${alias}.$1`))).join('');
}

const sqlLit = (v: string, re: RegExp, what: string): string => {
  if (!re.test(v)) throw new Error(`PFE_DEFECT_WINDOWS: unsafe ${what} ${JSON.stringify(v)}`);
  return `'${v}'`;
};
const SQL_EXCHANGE = /^[A-Z0-9]+$/;
const SQL_TIMEFRAME = /^[0-9]+[mhdw]$/;

/**
 * One registry row's MEMBERSHIP test as SQL, without its exchange and timeframe: `sqlNotDefectWindowOf` dispatches on
 * those. Every interpolated value is shape-checked here, at the generator.
 */
function windowSql(w: PfeDefectWindow): string {
  const sec = (v: number, what: string) => {
    if (!Number.isSafeInteger(v) || v < 1_600_000_000 || v > 9_999_999_999) throw new Error(`PFE_DEFECT_WINDOWS: ${what} ${v} is not epoch seconds`);
    return String(v);
  };
  sqlLit(w.exchange, SQL_EXCHANGE, 'exchange');
  if (w.timeframe !== undefined) sqlLit(w.timeframe, SQL_TIMEFRAME, 'timeframe');
  const parts: string[] = [];
  const COIN = /^[A-Za-z0-9:._-]+$/;
  if (w.coin !== undefined && w.coins !== undefined) throw new Error('PFE_DEFECT_WINDOWS: coin and coins are exclusive');
  if (w.coin !== undefined) parts.push(`coin = ${sqlLit(w.coin, COIN, 'coin')}`);
  if (w.coins !== undefined) {
    if (w.coins.length === 0) throw new Error('PFE_DEFECT_WINDOWS: coins must name at least one coin');
    parts.push(`coin IN (${w.coins.map((c) => sqlLit(c, COIN, 'coin')).join(', ')})`);
  }
  if (w.from !== undefined) parts.push(`created_at >= ${sec(w.from, 'from')}`);
  parts.push(`created_at < ${sec(w.before, 'before')}`);
  if (w.withinAfterBoundaryS !== undefined) {
    const step = boundaryStepS(w.timeframe);
    if (step === null) throw new Error('PFE_DEFECT_WINDOWS: withinAfterBoundaryS needs a minute, hour or day timeframe');
    const n = w.withinAfterBoundaryS;
    if (!Number.isSafeInteger(n) || n <= 0 || n >= step) throw new Error(`PFE_DEFECT_WINDOWS: withinAfterBoundaryS ${n} is not an integer in (0, ${step})`);
    parts.push(`created_at % ${step} < ${n}`);
  }
  if (w.ids !== undefined) {
    if (w.ids.length === 0 || !w.ids.every((i) => Number.isSafeInteger(i) && i > 0)) throw new Error('PFE_DEFECT_WINDOWS: ids must be positive integers, at least one');
    parts.push(`id IN (${w.ids.join(', ')})`);
  }
  return `(${parts.join(' AND ')})`;
}

/**
 * The SQL projection of NOT `isDefectWindowEvaluation`, generated from `PFE_DEFECT_WINDOWS`.
 * NULL-safe: the whole membership test sits inside `coalesce(…, false)`, so a row with a NULL timeframe,
 * coin or created_at is "not in the window", the TypeScript answer, instead of NULL, which a FILTER
 * reads as false and drops. With no window declared it is `TRUE`.
 */
export function sqlNotDefectWindow(alias?: string): string {
  return sqlNotDefectWindowOf(PFE_DEFECT_WINDOWS, alias);
}

/**
 * `sqlNotDefectWindow` over any window list (the tests' tuple fixtures; the registry form above).
 *
 * Shape: `NOT coalesce(CASE coalesce(exchange, 'HL') WHEN 'X' THEN (<X's timeframe-free rows> OR CASE timeframe
 * WHEN 't' THEN (<X t rows, OR'ed>) … ELSE false END) … ELSE false END, false)`. Measured per-coin classes put hundreds
 * of rows in the registry, and this fragment runs on every row of the live stats pushdown: a flat AND of one test per
 * registry row would cost every signal one comparison per row, while the dispatch costs it one exchange compare and,
 * on a registry venue, one timeframe compare plus that pair's rows only. It is the same predicate (NOT of an OR is
 * the AND of the NOTs), pinned row for row against the TypeScript one in a real SQL engine.
 */
export function sqlNotDefectWindowOf(windows: readonly PfeDefectWindow[], alias?: string): string {
  if (windows.length === 0) return 'TRUE';
  const byExchange = new Map<string, { any: string[]; byTf: Map<string, string[]> }>();
  for (const w of windows) {
    const m = windowSql(w);
    const e = byExchange.get(w.exchange) ?? byExchange.set(w.exchange, { any: [], byTf: new Map() }).get(w.exchange)!;
    if (w.timeframe === undefined) e.any.push(m);
    else (e.byTf.get(w.timeframe) ?? e.byTf.set(w.timeframe, []).get(w.timeframe)!).push(m);
  }
  const or = (xs: string[]) => (xs.length === 1 ? xs[0] : `(${xs.join(' OR ')})`);
  const arms = [...byExchange].map(([ex, { any, byTf }]) => {
    const tfCase = byTf.size
      ? `CASE timeframe ${[...byTf].map(([tf, ms]) => `WHEN ${sqlLit(tf, SQL_TIMEFRAME, 'timeframe')} THEN ${or(ms)}`).join(' ')} ELSE false END`
      : '';
    const body = [...any, ...(tfCase ? [tfCase] : [])];
    return `WHEN ${sqlLit(ex, SQL_EXCHANGE, 'exchange')} THEN ${or(body)}`;
  });
  return qualify(`NOT coalesce(CASE coalesce(exchange, 'HL') ${arms.join(' ')} ELSE false END, false)`, alias);
}

/** The SQL projection of `isPfeEligible` (minus the HOLD clause, which the caller groups on). */
export function sqlPfeEligible(alias?: string): string {
  return qualify(`${SQL_EVALUATED} AND ${SQL_NOT_FROZEN} AND ${sqlNotDefectWindow()}`, alias);
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
