// lrw/relabel-sql.ts — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: the relabel's population, as SQL, ONCE. The writer
// (backfill-directional-labels.ts --relabel-v2) lists its groups from here and the read-only completeness probe
// (lrw/completeness.ts: the pull's §1.3 precondition, the CH3 gate's D7) lists what is still missing from here,
// so "what the relabel visits" and "what is checked as visited" cannot drift. Pure: no DB, no venue, no caller
// tag — entrypoints may import it without inheriting the writer's batch-caller names.

import { BARRIER_SPECS_V2 } from '../directional-labeler.js';
import { T_CUT_EPOCH } from './registered.js';

/** The relabel's upper bound on `created_at`: T_CUT, or a lower `--until`. Never above T_CUT. */
export function relabelUntil(until: number | undefined): number {
  const cut = Math.floor(T_CUT_EPOCH);
  if (until !== undefined && until > cut) throw new Error(`--until ${until} is above T_CUT (${cut}) — the relabel's population ends at T_CUT`);
  return until ?? cut;
}

/** The relabel's eligibility, ONCE: a BUY/SELL, non-1m signal with its PFE settled, created in the relabel's
 *  window, lacking one of the run's `-v2` specs (existence of `(signal_id, barrier_spec)` only — label-free). The
 *  group work-list below and the read-only completeness probe (`buildRelabelMissingSql`) both take it from here,
 *  so "what the relabel visits" and "what the gate checks was visited" cannot drift. `lit` inlines the values for
 *  a statement the read session runs by text; otherwise they are parameters. */
function relabelEligibleWhere(
  opts: { v2Specs: readonly string[]; since?: number; until: number; venue?: string; coin?: string; timeframe?: string },
  lit: boolean,
): { where: string[]; params: unknown[] } {
  const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const params: unknown[] = [];
  const bind = (v: unknown, literal: string) => {
    if (lit) return literal;
    params.push(v);
    return `$${params.length}`;
  };
  const specs = bind(opts.v2Specs, `ARRAY[${opts.v2Specs.map(q).join(', ')}]::text[]`);
  const n = bind(opts.v2Specs.length, String(opts.v2Specs.length));
  const where = [
    "s.signal IN ('BUY','SELL')",
    's.pfe_return_pct IS NOT NULL',
    "s.timeframe <> '1m'",
    `(SELECT count(*) FROM directional_labels d WHERE d.signal_id = s.id AND d.barrier_spec = ANY(${specs})) < ${n}`,
  ];
  if (opts.since !== undefined) where.push(`s.created_at > ${Math.floor(opts.since)}`);
  where.push(`s.created_at <= ${Math.floor(opts.until)}`);
  if (opts.venue) where.push(`s.exchange = ${bind(opts.venue, q(opts.venue))}`);
  if (opts.coin) where.push(`s.coin = ${bind(opts.coin, q(opts.coin))}`);
  if (opts.timeframe) where.push(`s.timeframe = ${bind(opts.timeframe, q(opts.timeframe))}`);
  return { where, params };
}

/** Every group with an eligible signal that lacks one of the `-v2` specs of this run — horizon-first inside a
 *  venue (oldest missing first). Label-free: existence of `(signal_id, barrier_spec)` only. Retired venues are
 *  listed so their rows are COUNTED (`unreachable:retired`), never fetched.
 *  `atRiskAfter` (timeframe → epoch s) adds `at_risk_oldest`: the oldest eligible signal still created after its
 *  timeframe's bound — the input of the depth-deadline order (ruling LRW-Q17). The eligibility is untouched, so
 *  the completeness probe below still reads the same WHERE; a timeframe the map lacks counts every signal. */
export function buildRelabelGroupsSql(opts: {
  v2Specs: readonly string[]; since?: number; until: number; venue?: string; coin?: string; timeframe?: string;
  atRiskAfter?: Readonly<Record<string, number>>;
}): { text: string; params: unknown[] } {
  const { where, params } = relabelEligibleWhere(opts, false);
  const atRisk = opts.atRiskAfter
    ? `, MIN(s.created_at) FILTER (WHERE s.created_at > CASE s.timeframe ${Object.entries(opts.atRiskAfter)
        .map(([tf, after]) => `WHEN '${tf.replace(/'/g, "''")}' THEN ${Math.floor(after)}`)
        .join(' ')} ELSE 0 END) AS at_risk_oldest`
    : '';
  return {
    text:
      `SELECT s.exchange, s.coin, s.timeframe, COUNT(*) AS todo, MIN(s.created_at) AS oldest${atRisk} FROM signals s ` +
      `WHERE ${where.join(' AND ')} ` +
      `GROUP BY s.exchange, s.coin, s.timeframe ORDER BY s.exchange, MIN(s.created_at), s.coin, s.timeframe`,
    params,
  };
}

/** The read-only completeness probe (CH3 gate D7, the pull's §1.3 precondition): every signal the FULL relabel
 *  (all three τ, the whole history, up to T_CUT) would still visit — `id,exchange,timeframe`, one per line. After a
 *  converged relabel each of them must carry a manifest class. Label-free; the read session runs it by text. */
export function buildRelabelMissingSql(): string {
  const { where } = relabelEligibleWhere({ v2Specs: BARRIER_SPECS_V2.map((v) => v.spec), until: relabelUntil(undefined) }, true);
  return `SELECT s.id || ',' || s.exchange || ',' || s.timeframe FROM signals s WHERE ${where.join(' AND ')} ORDER BY s.id`;
}
