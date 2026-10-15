// ads1/extract-template.ts — AOE-ADS1-OBJECTIVE-W1 CH1: the ONE builder of the label-bearing extract, parametrised by
// the horizon it is bound at. Two instances exist and are pinned to each other by test:
//
//   * `extract-sql.ts` instantiates it at T_DIAG_END — the registered statement (ADS-1 registration §10.3), which
//     stays byte-identical to what the registered pull ran (pinned verbatim by tests/unit/ads1-scorecard.test.ts);
//   * `spec.ts` serialises it at `$1` into `ops/ads1-spec.json` as `extract_sql_template` — the one SQL the
//     autonomous-optimizer repo runs under `label_read_horizon(now)` (its `src/feedback/label_horizon.py`), so
//     `T_DIAG_END` while the seal holds and `now` after it lifts, by construction and never by a second copy.
//
// A LEAF on purpose: it imports nothing from `spec.ts` or `extract-sql.ts`, so `spec.ts` can serialise the template
// without a module cycle (`extract-sql.ts` → `spec.ts` → this file). Every ADS-1 constant arrives as a parameter.
//
// PURE: no env, no DB, no I/O. NON-PROMOTABLE: nothing here feeds a gate, a threshold, a weight or a public figure.

import { EVAL_CANDLES, TF_MS } from '../directional-labeler.js';

export interface ExtractSpecLike {
  readonly spec: string;
  readonly tau: number;
}

export interface CoarserServedLike {
  readonly exchange: string;
  readonly timeframe: string;
  readonly servedSeconds: number;
}

/** Everything the builder needs from `spec.ts`, handed in so this file stays a leaf. */
export interface ExtractContext {
  /** The barrier family, PRIMARY FIRST (it defines the population; the rest are left joins on its rows). */
  readonly specs: readonly ExtractSpecLike[];
  readonly primaryBarrierSpec: string;
  /** The coarser-served pairs, in the derivation's order (`COARSER_SERVED` in spec.ts). */
  readonly coarser: readonly CoarserServedLike[];
}

/** The placeholder the template carries where the registered instance carries `T_DIAG_END`. It is a TEXTUAL
 *  parameter (the statement is a `COPY … TO STDOUT`, which psql binds nothing into); the consumer substitutes
 *  an integer epoch and nothing else — see `instantiateTemplate`. */
export const HORIZON_PARAM = '$1';

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

/** PROVENANCE columns, primary spec only (ADS-1 registration §10.3): the first-write stamp and the generator's own
 *  contiguity count. Neither is a label. */
const PRIMARY_PROVENANCE_COLUMNS = [
  ['computed_at', 'computed'],
  ['race_gap_candles', 'gap'],
] as const;

/** One spec's selected columns, as `[column, alias]` — the primary carries the provenance pair after its five. */
function specColumns(spec: string, primaryBarrierSpec: string): ReadonlyArray<readonly [string, string]> {
  return spec === primaryBarrierSpec ? [...PER_SPEC_COLUMNS, ...PRIMARY_PROVENANCE_COLUMNS] : PER_SPEC_COLUMNS;
}

/** The extract's CSV header, in order. The scorecard's parser refuses any other header. */
export function extractHeader(ctx: ExtractContext): readonly string[] {
  return [
    'id', 'created_at', 'exchange', 'coin', 'timeframe', 'side', 'confidence',
    'regime_rule_version', 'regime', 'verdict_rule_version', 'anchored',
    ...ctx.specs.flatMap((b) => specColumns(b.spec, ctx.primaryBarrierSpec).map(([, alias]) => `${alias}_${specSuffix(b.tau)}`)),
  ];
}

/** `(VALUES ('3m', 180, 20), …)` — the label window per timeframe, from the labeler's own tables. */
function tfValues(): string {
  return Object.keys(EVAL_CANDLES)
    .map((t) => `('${t}', ${TF_MS[t] / 1000}, ${EVAL_CANDLES[t]})`)
    .join(', ');
}

/** `(VALUES ('GATE', '3m', 300), …)` — the coarser-served pairs, generated from the derived set, never typed. */
function coarserValues(coarser: readonly CoarserServedLike[]): string {
  return coarser.map((c) => `('${c.exchange}', '${c.timeframe}', ${c.servedSeconds})`).join(', ');
}

/** The two joins every horizon-bounded statement carries: the label window per timeframe and the served step. */
export function windowJoins(coarser: readonly CoarserServedLike[]): string {
  return `JOIN (VALUES ${tfValues()}) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ${coarserValues(coarser)}) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe`;
}

/** The race-end embargo in the ruled MAX form (ADS-1 registration §10.2), bound at `bound` — `T_DIAG_END` for the
 *  registered instance, `$1` for the template: `created_at ≤ bound ∧ created_at + (W+1)·max(requested, served) ≤ bound`,
 *  with `max(requested, served)` = `GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec))`. */
export function tCapPredicateAt(bound: string): string {
  return `s.created_at <= ${bound}
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= ${bound}`;
}

/** THE label-bearing extract: one row per emitted call that carries a primary-spec label under the bound. The
 *  primary spec is an inner join (it defines the population); the sensitivity specs are left joins on the same rows. */
export function buildExtractSql(bound: string, ctx: ExtractContext): string {
  const [primary, ...sensitivity] = ctx.specs;
  if (!primary) throw new Error('ads1/extract-template: an extract needs a primary barrier spec');
  const alias = (tau: number) => `d${specSuffix(tau).slice(1)}`;
  const specCols = ctx.specs.flatMap((b) =>
    specColumns(b.spec, ctx.primaryBarrierSpec).map(([col, a]) => `${alias(b.tau)}.${col} AS ${a}_${specSuffix(b.tau)}`),
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
  ${windowJoins(ctx.coarser)}
  ${joins}
  WHERE ${tCapPredicateAt(bound)}
    AND s.signal IN ('BUY', 'SELL')
  ORDER BY s.id
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

/** The template at an integer horizon: every `$1` becomes the epoch, and nothing else changes. Refuses a template
 *  that carries no placeholder (nothing to bind — a copy of an instance, not a template), a non-integer or a
 *  negative bound (the horizon is an epoch second), and a result that still carries a placeholder. */
export function instantiateTemplate(template: string, horizonEpochS: number): string {
  if (!Number.isInteger(horizonEpochS) || horizonEpochS < 0) {
    throw new Error(`ads1/extract-template: the horizon must be a non-negative integer epoch, got ${String(horizonEpochS)}`);
  }
  if (!template.includes(HORIZON_PARAM)) throw new Error(`ads1/extract-template: the template carries no ${HORIZON_PARAM} placeholder`);
  const out = template.split(HORIZON_PARAM).join(String(horizonEpochS));
  if (out.includes(HORIZON_PARAM)) throw new Error('ads1/extract-template: a placeholder survived instantiation');
  return out;
}
