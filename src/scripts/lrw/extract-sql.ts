// lrw/extract-sql.ts — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: the ONE generator of every statement the
// registered disagreement read runs (registration §3.1, `audits/labeler-race-window-v2-preregistration-2026-09-28.md`).
// The registration quotes these texts; `tests/unit/lrw-extract-sql.test.ts` pins them BYTE-EQUAL to its code blocks
// before the pull runs (the ADS-1 precedent), so what was registered is what is run.
//
// The session: `ssh → docker exec -i <postgres> psql -U aoe_readonly -At -q`, each part in its own
// `BEGIN READ ONLY` with the token printed first. `aoe_readonly` holds no write privilege, so the channel is
// read-only by construction. `:T_CUT` is the ONLY literal substituted at pull time — the StartedAt epoch of the
// first container on the CH2 generator commit, recorded in the vault audit and pinned ONCE in `./registered.ts`
// (no caller passes it, so no two readers can run on two different cuts).

import { T_CUT_EPOCH } from './registered.js';

export const TOKEN_SQL = `SELECT 'TOKEN current_user=' || current_user || ' transaction_read_only=' || current_setting('transaction_read_only')`;
/** What TOKEN_SQL prints in a session that is `aoe_readonly` AND read-only — every reader asserts it as line 1. */
export const RO_TOKEN_LINE = 'TOKEN current_user=aoe_readonly transaction_read_only=on';

export const COUNTERS_SQL = `SELECT 'COUNTERS relname=' || relname || ' ins=' || n_tup_ins || ' upd=' || n_tup_upd || ' del=' || n_tup_del
  FROM pg_stat_user_tables WHERE relname = 'directional_labels'`;

export const EXTRACT_SQL = `COPY (
  SELECT s.id, s.created_at, s.exchange, s.coin, s.timeframe, s.signal AS side,
         v1.barrier_spec AS spec_v1,
         v1.label AS label_v1,
         v1.ambiguous_candle AS amb_v1,
         v1.low_vol_history AS lowvol_v1,
         v1.barrier_pct AS barrier_v1,
         v1.race_gap_candles AS gap_v1,
         extract(epoch FROM v1.computed_at)::bigint AS computed_v1,
         (v2.signal_id IS NOT NULL) AS has_v2,
         v2.label AS label_v2,
         v2.ambiguous_candle AS amb_v2,
         v2.barrier_pct AS barrier_v2
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('HTX', '3m', 300), ('PHEMEX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900), ('PHEMEX', '12h', 86400)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN (VALUES ('tau1.0-floor0.30-v1', 'tau1.0-floor0.30-v2'), ('tau0.5-floor0.30-v1', 'tau0.5-floor0.30-v2'), ('tau2.0-floor0.30-v1', 'tau2.0-floor0.30-v2')) AS sp(v1, v2) ON TRUE
  JOIN directional_labels v1 ON v1.signal_id = s.id AND v1.barrier_spec = sp.v1
  LEFT JOIN directional_labels v2 ON v2.signal_id = s.id AND v2.barrier_spec = sp.v2
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
    AND v1.computed_at < to_timestamp(:T_CUT)
  ORDER BY s.id, v1.barrier_spec
) TO STDOUT WITH (FORMAT csv, HEADER)`;

export const COUNTS_APART_SQL = `COPY (
  SELECT sp.v1 AS spec_v1, s.exchange, s.timeframe,
         (v1.computed_at >= to_timestamp(:T_CUT)) AS after_cut,
         count(*)::bigint AS n
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('HTX', '3m', 300), ('PHEMEX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900), ('PHEMEX', '12h', 86400)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN (VALUES ('tau1.0-floor0.30-v1'), ('tau0.5-floor0.30-v1'), ('tau2.0-floor0.30-v1')) AS sp(v1) ON TRUE
  JOIN directional_labels v1 ON v1.signal_id = s.id AND v1.barrier_spec = sp.v1
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
) TO STDOUT WITH (FORMAT csv, HEADER)`;

export const V2_WITHOUT_V1_SQL = `COPY (
  SELECT sp.v2 AS spec_v2, s.exchange, s.timeframe, count(*)::bigint AS n_v2_without_v1
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('HTX', '3m', 300), ('PHEMEX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900), ('PHEMEX', '12h', 86400)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN (VALUES ('tau1.0-floor0.30-v1', 'tau1.0-floor0.30-v2'), ('tau0.5-floor0.30-v1', 'tau0.5-floor0.30-v2'), ('tau2.0-floor0.30-v1', 'tau2.0-floor0.30-v2')) AS sp(v1, v2) ON TRUE
  JOIN directional_labels v2 ON v2.signal_id = s.id AND v2.barrier_spec = sp.v2
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
    AND NOT EXISTS (SELECT 1 FROM directional_labels v1 WHERE v1.signal_id = s.id AND v1.barrier_spec = sp.v1)
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
) TO STDOUT WITH (FORMAT csv, HEADER)`;


/** The extract's CSV header, in order (registration §3.1's allow-list SELECT). The parser refuses any other. */
export const EXTRACT_HEADER: readonly string[] = [
  'id', 'created_at', 'exchange', 'coin', 'timeframe', 'side', 'spec_v1', 'label_v1', 'amb_v1', 'lowvol_v1',
  'barrier_v1', 'gap_v1', 'computed_v1', 'has_v2', 'label_v2', 'amb_v2', 'barrier_v2',
];
export const COUNTS_APART_HEADER: readonly string[] = ['spec_v1', 'exchange', 'timeframe', 'after_cut', 'n'];
export const V2_WITHOUT_V1_HEADER: readonly string[] = ['spec_v2', 'exchange', 'timeframe', 'n_v2_without_v1'];

/** The ONE substitution: `:T_CUT` → the recorded StartedAt epoch (seconds, fractional allowed; default the pinned
 *  T_CUT). Refuses a value that is not a finite positive number, and a text with no placeholder (a drifted
 *  statement). */
export function withTCut(sql: string, tCutEpoch: number = T_CUT_EPOCH): string {
  if (!Number.isFinite(tCutEpoch) || tCutEpoch <= 0) throw new Error(`T_CUT '${tCutEpoch}' is not a positive epoch`);
  if (!sql.includes(':T_CUT')) throw new Error('statement carries no :T_CUT placeholder');
  return sql.split(':T_CUT').join(String(tCutEpoch));
}

/**
 * The ADD-ONLY proof's instrument (ruling LRW-Q7-C) — NOT a registered read: a server-side digest of the `-v1`
 * LABEL columns of every row in the registered population (T_CAP in the Q11 form, computed before T_CUT), taken
 * before the relabel / annotation writes and again after them; the two must be equal. Two independent 64-bit
 * XOR folds of the row text, order-free. It returns a hash and a count — never a value.
 */
export const V1_DIGEST_SQL = `SELECT 'DIGEST n=' || count(*) || ' x0=' || coalesce(bit_xor(hashtextextended(r, 0)), 0) || ' x1=' || coalesce(bit_xor(hashtextextended(r, 1)), 0)
FROM (
  SELECT concat_ws('|', v1.signal_id, v1.barrier_spec, v1.label, v1.ambiguous_candle, v1.low_vol_history, v1.t_hit_candles, v1.barrier_pct) AS r
  FROM signals s
  JOIN (VALUES ('3m', 180, 12), ('5m', 300, 12), ('15m', 900, 12), ('30m', 1800, 8), ('1h', 3600, 8), ('2h', 7200, 6), ('4h', 14400, 6), ('8h', 28800, 4), ('12h', 43200, 4), ('1d', 86400, 3)) AS tf(t, sec, w) ON tf.t = s.timeframe
  LEFT JOIN (VALUES ('GATE', '3m', 300), ('MEXC', '3m', 300), ('HTX', '3m', 300), ('PHEMEX', '3m', 300), ('WEEX', '3m', 300), ('XT', '3m', 300), ('WHITEBIT', '3m', 900), ('WHITEBIT', '5m', 900), ('PHEMEX', '12h', 86400)) AS coarser(exchange, t, sec) ON coarser.exchange = s.exchange AND coarser.t = s.timeframe
  JOIN directional_labels v1 ON v1.signal_id = s.id AND v1.barrier_spec IN ('tau1.0-floor0.30-v1', 'tau0.5-floor0.30-v1', 'tau2.0-floor0.30-v1')
  WHERE s.created_at <= 1790402400
    AND s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400
    AND s.signal IN ('BUY', 'SELL')
    AND v1.computed_at < to_timestamp(:T_CUT)
) x`;

/** The read session's statements by name — what `--emit` prints (scripts/lrw/lrw-pull.sh reads them from here,
 *  so the shell never holds a second copy of a registered statement). */
export const STATEMENTS: Readonly<Record<string, string>> = {
  TOKEN: TOKEN_SQL, COUNTERS: COUNTERS_SQL, EXTRACT: EXTRACT_SQL, COUNTS_APART: COUNTS_APART_SQL,
  V2_WITHOUT_V1: V2_WITHOUT_V1_SQL, V1_DIGEST: V1_DIGEST_SQL,
};

/** `node dist/scripts/lrw/extract-sql.js --emit <NAME>` → the statement on stdout, `:T_CUT` already the pinned
 *  value. `--t-cut` is refused: the cut is not a caller's choice. `--emit T_CUT` prints the pinned epoch itself. */
export function emitMain(argv: string[]): number {
  if (argv.includes('--t-cut')) { process.stderr.write('--t-cut is refused: T_CUT is pinned in src/scripts/lrw/registered.ts\n'); return 2; }
  const name = argv[argv.indexOf('--emit') + 1];
  if (name === 'T_CUT') { process.stdout.write(`${T_CUT_EPOCH}\n`); return 0; }
  const sql = STATEMENTS[name ?? ''];
  if (!sql) { process.stderr.write(`unknown statement '${name}' (one of T_CUT, ${Object.keys(STATEMENTS).join(', ')})\n`); return 2; }
  process.stdout.write((sql.includes(':T_CUT') ? withTCut(sql) : sql) + '\n');
  return 0;
}

if (process.argv[1] && process.argv[1].includes('lrw/extract-sql') && process.argv.includes('--emit')) process.exit(emitMain(process.argv.slice(2)));
