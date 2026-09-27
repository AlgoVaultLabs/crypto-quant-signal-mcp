// ads1/extract-sql.ts — EDGE-ADS1-SCORECARD-W1-V2 CH3 R5: the ONE generator of every statement the
// scorecard's read session runs (ruling Q5 = A). The pre-registration quotes these texts; a test pins the
// registration to the generator, so what was registered is what was run.
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

import { BARRIER_SPECS, EVAL_CANDLES, TF_MS } from '../directional-labeler.js';
import { T_DIAG_END, T_FLIP } from './spec.js';

/** Column suffix per barrier spec: tau 1.0 → t10, 0.5 → t05, 2.0 → t20. */
export function specSuffix(tau: number): string {
  return `t${String(Math.round(tau * 10)).padStart(2, '0')}`;
}

const PER_SPEC_COLUMNS = [
  ['label', 'label'],
  ['ambiguous_candle', 'amb'],
  ['low_vol_history', 'lowvol'],
  ['barrier_pct', 'barrier'],
  ['ret_at_expiry_pct', 'expiry'],
] as const;

/** The extract's CSV header, in order. The scorecard's parser refuses any other header. */
export const EXTRACT_HEADER: readonly string[] = [
  'id', 'created_at', 'exchange', 'coin', 'timeframe', 'side', 'confidence',
  'regime_rule_version', 'regime', 'verdict_rule_version', 'anchored',
  ...BARRIER_SPECS.flatMap((b) => PER_SPEC_COLUMNS.map(([, alias]) => `${alias}_${specSuffix(b.tau)}`)),
];

/** `(VALUES ('3m', 180, 20), …)` — the label window per timeframe, from the labeler's own tables. */
function tfValues(): string {
  return Object.keys(EVAL_CANDLES)
    .map((t) => `('${t}', ${TF_MS[t] / 1000}, ${EVAL_CANDLES[t]})`)
    .join(', ');
}

/** The T_CAP predicate on `s` joined to the `tf` window table. */
export function tCapPredicate(): string {
  return `s.created_at <= ${T_DIAG_END} AND s.created_at + (tf.w + 1) * tf.sec <= ${T_DIAG_END}`;
}

/** THE label-bearing extract: one row per emitted call that carries a primary-spec label under T_CAP. The
 *  primary spec is an inner join (it defines the population); the two sensitivity specs are left joins on
 *  the same rows, so every spec is scored on one population. */
export function extractSql(): string {
  const [primary, ...sensitivity] = BARRIER_SPECS;
  const alias = (tau: number) => `d${specSuffix(tau).slice(1)}`;
  const specCols = BARRIER_SPECS.flatMap((b) =>
    PER_SPEC_COLUMNS.map(([col, a]) => `${alias(b.tau)}.${col} AS ${a}_${specSuffix(b.tau)}`),
  ).join(',\n         ');
  const joins = [
    `JOIN directional_labels ${alias(primary.tau)} ON ${alias(primary.tau)}.signal_id = s.id AND ${alias(primary.tau)}.barrier_spec = '${primary.spec}'`,
    ...sensitivity.map(
      (b) => `LEFT JOIN directional_labels ${alias(b.tau)} ON ${alias(b.tau)}.signal_id = s.id AND ${alias(b.tau)}.barrier_spec = '${b.spec}'`,
    ),
  ].join('\n  ');
  return `COPY (
  SELECT s.id, s.created_at, s.exchange, s.coin, s.timeframe, s.signal AS side, s.confidence,
         s.regime_rule_version, s.regime, s.verdict_rule_version,
         (s.merkle_batch_id IS NOT NULL) AS anchored,
         ${specCols}
  FROM signals s
  JOIN (VALUES ${tfValues()}) AS tf(t, sec, w) ON tf.t = s.timeframe
  ${joins}
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
  const [primary, ...sensitivity] = BARRIER_SPECS;
  const others = sensitivity.map((b) => `'${b.spec}'`).join(', ');
  return `COPY (
  SELECT 'v1_after_flip' AS item, count(*)::bigint AS n FROM signals WHERE verdict_rule_version = 1 AND created_at > ${T_FLIP}
  UNION ALL
  SELECT 'sensitivity_only_under_tcap', count(DISTINCT s.id)::bigint
  FROM signals s
  JOIN (VALUES ${tfValues()}) AS tf(t, sec, w) ON tf.t = s.timeframe
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec IN (${others})
  WHERE ${tCapPredicate()}
    AND NOT EXISTS (SELECT 1 FROM directional_labels p WHERE p.signal_id = s.id AND p.barrier_spec = '${primary.spec}')
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
        ? ["\\echo '===EXTRACT==='", `${extractSql()};`]
        : ["\\echo '===CENSUS==='", `${censusSql()};`, "\\echo '===SIDEMIX==='", `${sideMixSql()};`, "\\echo '===INTEGRITY==='", `${integritySql()};`];
  return [
    '\\set ON_ERROR_STOP 1',
    "SET statement_timeout = '900s';",
    'BEGIN READ ONLY;',
    `${TOKEN_SQL};`,
    ...body,
    'COMMIT;',
    '',
  ].join('\n');
}
