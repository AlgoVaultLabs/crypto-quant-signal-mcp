// ads1/extract-sql.ts — EDGE-ADS1-SCORECARD-W1-V2 CH3 R5 (amended EDGE-ADS1-SCORECARD-W1-V3 CH3-A, registration §10:
// the `-v2` family, the max-form T_CAP, two provenance columns, the per-signal presence statement): the ONE generator of every statement the
// scorecard's read session runs (ruling Q5 = A). The pre-registration quotes these texts; a test pins the
// registration to the generator, so what was registered is what was run.
//
// AOE-ADS1-OBJECTIVE-W1 CH1: the label-bearing extract is built by the leaf `extract-template.ts` (`buildExtractSql`),
// which this module instantiates at T_DIAG_END (the registered statement, byte-identical — pinned) and `spec.ts`
// serialises at `$1` into `ops/ads1-spec.json` as `extract_sql_template` (`extractSqlTemplate()` below is that text).
//
// The session: `ssh → docker exec -i <postgres> psql -U aoe_readonly`, each statement inside its own
// `BEGIN READ ONLY`, the token line first. `aoe_readonly` holds no write privilege, so the channel is
// read-only by construction, not by a session setting it could lift.
//
// THE ALLOW-LIST. The label-bearing extract names every column it reads, and none is a scorer input:
// identity + time, venue / coin / timeframe, the emitted side and conviction, the regime key, the rule
// version, whether the call is anchored, and per barrier spec the label, the ambiguous-candle flag, the
// low-volatility flag, the barrier and the expiry return. Every label-bearing row is under T_CAP (the
// race-end embargo, ruling Q1 = A). Label-FREE counts (census, side mix) are marked as such and may run to
// now; they never read a label or an outcome column.

import {
  COARSER_SERVED,
  PRIMARY_BARRIER_SPEC,
  PRIMARY_SPEC,
  PRIMARY_V1_TWIN_SPEC,
  SENSITIVITY_SPECS,
  T_ADAPTER,
  T_DIAG_END,
  T_FLIP,
  extractContext,
} from './spec.js';
import {
  HORIZON_PARAM,
  buildExtractSql,
  extractHeader,
  specSuffix,
  tCapPredicateAt,
  windowJoins as windowJoinsOf,
} from './extract-template.js';

export { HORIZON_PARAM, instantiateTemplate, specSuffix } from './extract-template.js';

/** The extract's CSV header, in order. The scorecard's parser refuses any other header. */
export const EXTRACT_HEADER: readonly string[] = extractHeader(extractContext());

/** The two joins every T_CAP-bounded statement carries: the label window per timeframe and the served step
 *  (`COARSER_SERVED`, spec.ts, derived from `servedCandleStepMs` — never typed). */
function windowJoins(): string {
  return windowJoinsOf(COARSER_SERVED);
}

/** The T_CAP predicate in the ruled MAX form (registration §10.2; Q11 / LRW-Q8), on `s` joined to `tf` and
 *  `coarser` — `max(requested, served)` is `GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec))`. The registered
 *  instance: bound at T_DIAG_END. */
export function tCapPredicate(): string {
  return tCapPredicateAt(String(T_DIAG_END));
}

/** THE label-bearing extract: one row per emitted call that carries a primary-spec label under T_CAP — the
 *  REGISTERED statement (ADS-1 registration §10.3), i.e. the template instantiated at T_DIAG_END. */
export function extractSql(): string {
  return buildExtractSql(String(T_DIAG_END), extractContext());
}

/** The same statement with `$1` where the registered instance carries T_DIAG_END — what `ops/ads1-spec.json`
 *  carries as `extract_sql_template`, and what the autonomous-optimizer repo instantiates at `label_read_horizon(now)`.
 *  `instantiateTemplate(extractSqlTemplate(), T_DIAG_END) === extractSql()` is pinned by test. */
export function extractSqlTemplate(): string {
  return buildExtractSql(HORIZON_PARAM, extractContext());
}

/** The presence statement's CSV header, in order. */
export const PRESENCE_HEADER: readonly string[] = ['id', 'exchange', 'coin', 'timeframe', 'win', 'v1_present', 'v2_present', 'v2_post_adapter'];

/**
 * LABEL-FREE presence (registration §10.3 / §10.4, the coverage chain): ONE ROW PER registered signal under the
 * max-form T_CAP — its cell keys, its window, and three EXISTS booleans: a `-v1` primary row (presence only — the
 * relabel's input; never a value), a `-v2` primary row (the population), and a `-v2` primary row first written at
 * or after T_ADAPTER. Per signal, not grouped, so the chain is computable per UNIT (the tier comes from the coin),
 * the `no_v1_twin` class is `v2 ∧ ¬v1`, and LRW's manifest (keyed by signal id only) can be placed. Reads no label
 * and no outcome column of either family; its one provenance predicate is the `-v2` primary's `computed_at` inside
 * the `v2_post_adapter` EXISTS — a boolean against T_ADAPTER, never a value.
 */
export function presenceSql(): string {
  const exists = (alias: string, spec: string, extra = '') =>
    `EXISTS (SELECT 1 FROM directional_labels ${alias} WHERE ${alias}.signal_id = s.id AND ${alias}.barrier_spec = '${spec}'${extra})`;
  return `COPY (
  SELECT s.id, s.exchange, s.coin, s.timeframe, CASE WHEN s.created_at > ${T_FLIP} THEN 'POST' ELSE 'PRE' END AS win,
         ${exists('v1', PRIMARY_V1_TWIN_SPEC)} AS v1_present,
         ${exists('v2', PRIMARY_SPEC.spec)} AS v2_present,
         ${exists('v2', PRIMARY_SPEC.spec, ` AND v2.computed_at >= to_timestamp(${T_ADAPTER})`)} AS v2_post_adapter
  FROM signals s
  ${windowJoins()}
  WHERE ${tCapPredicate()}
    AND s.signal IN ('BUY', 'SELL')
  ORDER BY s.id
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

/** UTC date of an epoch second, YYYY-MM-DD. */
function utcDate(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 10);
}

/** LABEL-FREE census cardinalities per (source, window, timeframe, coin), bounded at T_DIAG_END so they
 *  describe the scored windows (ruling Q3 = A). Date-keyed stores are date-granular: POST = the flip's
 *  UTC date through T_DIAG_END's UTC date, both whole. Never a label, never an outcome column; the
 *  below-gate store is COUNTED, never selected. */
export function censusSql(): string {
  const flipDate = utcDate(T_FLIP);
  const endDate = utcDate(T_DIAG_END);
  const byTime = (table: string) =>
    `SELECT '${table}' AS source, CASE WHEN created_at > ${T_FLIP} THEN 'POST' ELSE 'PRE' END AS win, timeframe, coin, count(*)::bigint AS n
     FROM ${table} WHERE created_at <= ${T_DIAG_END} GROUP BY 1, 2, 3, 4`;
  const byDate = (table: string, col: string) =>
    `SELECT '${table}' AS source, CASE WHEN date >= DATE '${flipDate}' THEN 'POST' ELSE 'PRE' END AS win, timeframe, coin, sum(${col})::bigint AS n
     FROM ${table} WHERE date <= DATE '${endDate}' GROUP BY 1, 2, 3, 4`;
  return `COPY (
  ${byTime('signals')}
  UNION ALL
  ${byTime('band_signals')}
  UNION ALL
  ${byDate('hold_counts', 'hold_count')}
  UNION ALL
  ${byDate('emit_suppressions', 'suppress_count')}
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

/** LABEL-FREE emitted side mix after the flip, to now (ruling Q1: label-free counts may run to now). */
export function sideMixSql(): string {
  return `COPY (
  SELECT exchange, timeframe, regime_rule_version, regime, signal AS side, count(*)::bigint AS n
  FROM signals WHERE created_at > ${T_FLIP}
  GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

/** LABEL-FREE integrity counts: the rule-version assert (D2, to now) and the rows the primary-spec join
 *  leaves out because only a sensitivity spec labelled them (disclosed, never scored). */
export function integritySql(): string {
  const others = SENSITIVITY_SPECS.map((b) => `'${b.spec}'`).join(', ');
  return `COPY (
  SELECT 'v1_after_flip' AS item, count(*)::bigint AS n FROM signals WHERE verdict_rule_version = 1 AND created_at > ${T_FLIP}
  UNION ALL
  SELECT 'sensitivity_only_under_tcap', count(DISTINCT s.id)::bigint
  FROM signals s
  ${windowJoins()}
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec IN (${others})
  WHERE ${tCapPredicate()}
    AND NOT EXISTS (SELECT 1 FROM directional_labels p WHERE p.signal_id = s.id AND p.barrier_spec = '${PRIMARY_SPEC.spec}')
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

/** The label table's write counters — read in their own transaction before and after the extract (the
 *  stats snapshot is per transaction, so one transaction would read the same value twice). */
export function countersSql(): string {
  return `SELECT 'COUNTERS relname=' || relname || ' ins=' || n_tup_ins || ' upd=' || n_tup_upd || ' del=' || n_tup_del
  FROM pg_stat_user_tables WHERE relname = 'directional_labels'`;
}

export const TOKEN_SQL = `SELECT 'TOKEN current_user=' || current_user || ' transaction_read_only=' || current_setting('transaction_read_only')`;

export type SessionPart = 'counters' | 'extract' | 'labelfree';

/** A complete psql script for one part of the session (run with `psql -At -q`): its own READ ONLY
 *  transaction, the token line first, a `===SECTION===` marker before every result, ON_ERROR_STOP so a
 *  refused statement can never be read as an empty result. */
export function sessionScript(part: SessionPart): string {
  const body =
    part === 'counters'
      ? ["\\echo '===COUNTERS==='", `${countersSql()};`]
      : part === 'extract'
        ? ["\\echo '===FAMILY==='", `\\echo '${PRIMARY_BARRIER_SPEC}'`, "\\echo '===EXTRACT==='", `${extractSql()};`]
        : [
            "\\echo '===CENSUS==='", `${censusSql()};`, "\\echo '===SIDEMIX==='", `${sideMixSql()};`,
            "\\echo '===INTEGRITY==='", `${integritySql()};`, "\\echo '===PRESENCE==='", `${presenceSql()};`,
          ];
  return [
    '\\set ON_ERROR_STOP 1',
    "SET statement_timeout = '900s';",
    // `computed_t10` is a raw timestamptz: fix its text form so the parser's strict UTC pattern is the only one
    // it can meet (a session default could otherwise print a local offset).
    "SET TIME ZONE 'UTC';",
    "SET DateStyle = 'ISO, YMD';",
    'BEGIN READ ONLY;',
    `${TOKEN_SQL};`,
    ...body,
    'COMMIT;',
    '',
  ].join('\n');
}
