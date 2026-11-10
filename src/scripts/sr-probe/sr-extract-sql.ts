// sr-probe/sr-extract-sql.ts — EDGE-SR-LEVEL-PROBE-W1: the ONE generator of every statement the probe's read sessions
// run (ADS-1's pattern: `ssh → docker exec -i <postgres> psql -U aoe_readonly`, each part in its own
// `BEGIN READ ONLY`, the token line first). The registration quotes these texts' sha256.
//
// TWO PARTS, and the order between them is the study's proof:
//   labelfree — CH1. The corpus keys, the entry price, the barrier and the low-volatility flag. Reads NO label and
//               no outcome column: `barrier_pct` and `low_vol_history` are functions of the candles BEFORE the call.
//   labels    — CH2. `signal_id, label, ambiguous_candle` on the same predicate. Runs only after the registration
//               is on origin/main (scripts/sr-probe/sr-pull.sh refuses otherwise).
//
// Corpus (ruling 4, Plan-Mode ruling Q1 = A): emitted BUY/SELL on four venues, created after T_FLIP, carrying a
// primary `-v2` row, under the max-form T_CAP bound at T_DIAG_END — imported from ADS-1, never retyped.

import { COARSER_SERVED, PRIMARY_SPEC, PRIMARY_V1_TWIN_SPEC, T_ADAPTER, T_DIAG_END, T_FLIP } from '../ads1/spec.js';
import { tCapPredicateAt, windowJoins } from '../ads1/extract-template.js';
import { TOKEN_SQL } from '../ads1/extract-sql.js';

export const SR_VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;

/** The label-free extract's CSV header, in order. */
export const LABELFREE_HEADER: readonly string[] = [
  'id', 'created_at', 'exchange', 'coin', 'timeframe', 'side', 'entry', 'rule_config_id', 'barrier_pct', 'low_vol_history',
];
/** The label statement's CSV header, in order. */
export const LABELS_HEADER: readonly string[] = ['signal_id', 'label', 'ambiguous_candle', 'barrier_spec'];
/** The coverage chain's CSV header, in order. */
export const COVERAGE_HEADER: readonly string[] = ['exchange', 'timeframe', 'registered', 'v1_present', 'v2_present', 'v2_post_adapter'];

/** Every `directional_labels` column that is, or is derived from, what happened AFTER the call. */
export const OUTCOME_COLUMNS: readonly string[] = [
  'label', 'ambiguous_candle', 't_hit_candles', 'mfe_return_pct', 'mae_return_pct', 'ret_at_expiry_pct', 'race_gap_candles',
];

const venueList = SR_VENUES.map((v) => `'${v}'`).join(', ');

/** The corpus predicate on `s` joined to `tf` and `coarser` — shared by all three statements. */
export function corpusPredicate(): string {
  return `${tCapPredicateAt(String(T_DIAG_END))}
    AND s.created_at > ${T_FLIP}
    AND s.signal IN ('BUY', 'SELL')
    AND s.exchange IN (${venueList})`;
}

/** CH1, LABEL-FREE: one row per corpus call. */
export function labelFreeSql(): string {
  return `COPY (
  SELECT s.id, s.created_at, s.exchange, s.coin, s.timeframe, s.signal AS side, s.price_at_signal AS entry,
         s.rule_config_id, d.barrier_pct, d.low_vol_history
  FROM signals s
  ${windowJoins(COARSER_SERVED)}
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = '${PRIMARY_SPEC.spec}'
  WHERE ${corpusPredicate()}
  ORDER BY s.id
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

/** CH1, LABEL-FREE: ADS-1's coverage chain on this corpus — registered calls, `-v1` presence, `-v2` presence and
 *  `-v2` rows first written at or after T_ADAPTER, per venue x timeframe. EXISTS booleans only, never a value. */
export function coverageSql(): string {
  const exists = (alias: string, spec: string, extra = '') =>
    `EXISTS (SELECT 1 FROM directional_labels ${alias} WHERE ${alias}.signal_id = s.id AND ${alias}.barrier_spec = '${spec}'${extra})`;
  return `COPY (
  SELECT s.exchange, s.timeframe, count(*)::bigint AS registered,
         count(*) FILTER (WHERE ${exists('v1', PRIMARY_V1_TWIN_SPEC)})::bigint AS v1_present,
         count(*) FILTER (WHERE ${exists('v2', PRIMARY_SPEC.spec)})::bigint AS v2_present,
         count(*) FILTER (WHERE ${exists('v2', PRIMARY_SPEC.spec, ` AND v2.computed_at >= to_timestamp(${T_ADAPTER})`)})::bigint AS v2_post_adapter
  FROM signals s
  ${windowJoins(COARSER_SERVED)}
  WHERE ${corpusPredicate()}
  GROUP BY 1, 2
  ORDER BY 1, 2
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

/** CH2, LABEL-BEARING: the label and the ambiguous-candle flag of every corpus call, primary spec only. */
export function labelsSql(): string {
  return `COPY (
  SELECT d.signal_id, d.label, d.ambiguous_candle, d.barrier_spec
  FROM signals s
  ${windowJoins(COARSER_SERVED)}
  JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = '${PRIMARY_SPEC.spec}'
  WHERE ${corpusPredicate()}
  ORDER BY d.signal_id
) TO STDOUT WITH (FORMAT csv, HEADER)`;
}

export type SrSessionPart = 'labelfree' | 'labels';
export const SR_SESSION_PARTS: readonly SrSessionPart[] = ['labelfree', 'labels'];

/** A complete psql script for one part (run with `psql -At -q`): its own READ ONLY transaction, the token line
 *  first, a `===SECTION===` marker before every result, ON_ERROR_STOP so a refusal is never an empty result. */
export function sessionScript(part: SrSessionPart): string {
  const body =
    part === 'labelfree'
      ? ["\\echo '===COVERAGE==='", `${coverageSql()};`, "\\echo '===EXTRACT==='", `${labelFreeSql()};`]
      : ["\\echo '===LABELS==='", `${labelsSql()};`];
  return [
    '\\set ON_ERROR_STOP 1',
    "SET statement_timeout = '900s';",
    "SET TIME ZONE 'UTC';",
    "SET DateStyle = 'ISO, YMD';",
    'BEGIN READ ONLY;',
    `${TOKEN_SQL};`,
    ...body,
    'COMMIT;',
    '',
  ].join('\n');
}

/** The output names of a `COPY (SELECT … FROM …)` statement's select list, parsed from the statement text itself:
 *  top-level commas only, the alias after `AS` when there is one, else the bare column name. */
export function selectedColumns(sql: string): string[] {
  const start = sql.indexOf('SELECT');
  if (start < 0) throw new Error('sr-probe/sr-extract-sql: no SELECT in the statement');
  let depth = 0;
  let end = -1;
  for (let i = start + 6; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /^\sFROM\s/.test(sql.slice(i, i + 6))) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('sr-probe/sr-extract-sql: no top-level FROM in the statement');
  const list = sql.slice(start + 6, end);
  const items: string[] = [];
  let cur = '';
  depth = 0;
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  return items.map((raw) => {
    const item = raw.trim().replace(/\s+/g, ' ');
    const as = /\sAS\s+([a-z_0-9]+)$/i.exec(item);
    if (as) return as[1];
    return item.replace(/^[a-z_0-9]+\./i, '');
  });
}

/** Every `directional_labels` column a script references through one of its aliases (`d`, `v1`, `v2`). */
export function labelTableColumns(script: string): string[] {
  const out = new Set<string>();
  for (const m of script.matchAll(/\b(?:d|v1|v2)\.([a-z_0-9]+)/g)) out.add(m[1]);
  return [...out].sort();
}

interface PartStatement {
  name: string;
  sql: string;
  header: readonly string[];
}

/** The statements one part runs, each with the header it is registered to produce. */
function partStatements(part: SrSessionPart): PartStatement[] {
  return part === 'labelfree'
    ? [
        { name: 'coverage', sql: coverageSql(), header: COVERAGE_HEADER },
        { name: 'extract', sql: labelFreeSql(), header: LABELFREE_HEADER },
      ]
    : [{ name: 'labels', sql: labelsSql(), header: LABELS_HEADER }];
}

/** What is wrong with a part's statements, read from their own text: a select list that is not the registered
 *  header, or — label-free part only — any reference to an outcome column. Empty when nothing is. The entrypoint
 *  refuses to emit a part with a defect, so an edit to a statement cannot carry a label into the label-free session. */
export function partDefects(part: SrSessionPart, statements: readonly PartStatement[] = partStatements(part)): string[] {
  const out: string[] = [];
  for (const s of statements) {
    const cols = selectedColumns(s.sql);
    if (cols.join(',') !== s.header.join(',')) out.push(`${s.name}: selects [${cols.join(', ')}], registered [${s.header.join(', ')}]`);
    if (part !== 'labelfree') continue;
    const outcome = labelTableColumns(s.sql).filter((c) => OUTCOME_COLUMNS.includes(c));
    if (outcome.length > 0) out.push(`${s.name}: reads outcome column(s) ${outcome.join(', ')}`);
  }
  return out;
}

if (require.main === module) {
  const i = process.argv.indexOf('--part');
  const asked = i >= 0 ? process.argv[i + 1] : undefined;
  const part = SR_SESSION_PARTS.find((p) => p === asked);
  if (!part) {
    process.stderr.write(`usage: sr-extract-sql.ts --part ${SR_SESSION_PARTS.join('|')}\n`);
    process.exit(2);
  }
  const defects = partDefects(part);
  if (defects.length > 0) {
    process.stderr.write(`sr-extract-sql: refusing to emit the ${part} session — ${defects.join('; ')}\n`);
    process.exit(1);
  }
  process.stdout.write(sessionScript(part));
}
