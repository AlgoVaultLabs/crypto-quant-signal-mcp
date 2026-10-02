// lrw/completeness.ts — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: is the relabel / the annotation DONE — measured on the
// database, read-only, never taken from a runner's own say-so (registration §1.3: the pull runs only after both
// report DONE; the CH3 gate's D6 / D7 legs). A runner's CONVERGED line is a claim about the passes it watched; this
// is the claim checked against the rows.
//
//   --emit MISSING_V2 | NULL_V1_GAP | ADAPTER_V2_BEFORE   the read-only probe statements (label-free: ids, specs,
//                                                          venue, timeframe)
//   --relabel --missing <psql out> --manifest <log>[,<log>…]
//        every signal the full relabel would still visit carries a registered manifest class, none 'deferred'
//        → LRW_RELABEL_COMPLETE=YES | NO | INDETERMINATE  (exit 0 / 1 / 3)
//   --annotation --null-keys <psql out> --worklists <gz>[,<gz>]
//        no `-v1` row with race_gap_candles NULL has a value in the pinned worklists
//        → LRW_ANNOTATION_COMPLETE=YES | NO | INDETERMINATE  (exit 0 / 1 / 3)
//   --adapter-snapshot --session <psql out> --out <csv>
//        the BITGET 2h / 8h `-v2` rows written before T_ADAPTER, as the pinned stratum file
//        → LRW_ADAPTER_SNAPSHOT=PASS sha256=<hex> rows=<n> | INDETERMINATE  (exit 0 / 3)
//
// The psql outputs are the read session's raw text: the read-only token line first, then one row per line. A
// file without the token, an unparseable row or a manifest line with an unregistered class is INDETERMINATE —
// never YES. Totals only on stdout (no label, no value).

import { readFileSync, writeFileSync } from 'node:fs';
import { buildRelabelMissingSql } from './relabel-sql.js';
import { loadAnnotationSources, parseGapWorklists } from './annotation-sources.js';
import { createHash } from 'node:crypto';
import { BARRIER_SPECS, BARRIER_SPECS_V2 } from '../directional-labeler.js';
import { T_ADAPTER } from '../ads1/spec.js';
import { RO_TOKEN_LINE } from './extract-sql.js';
import { ADAPTER_CELL, MANIFEST_CLASSES, type ManifestClass } from './registered.js';

/** `-v1` rows still NULL in `race_gap_candles`, as `signal_id,barrier_spec`. */
export const NULL_V1_GAP_SQL =
  `SELECT signal_id || ',' || barrier_spec FROM directional_labels ` +
  `WHERE barrier_spec IN (${BARRIER_SPECS.map((s) => `'${s.spec}'`).join(', ')}) AND race_gap_candles IS NULL`;

/** The BITGET 2h / 8h `-v2` rows written BEFORE T_ADAPTER, as `signal_id,barrier_spec` (registration amendment
 *  2026-10-01, OAH-Q8: such a row keeps "unreachable pending OPS-ADAPTER-HISTORY-ANCHOR-W1" and is counted, never
 *  compared). Label-free: existence and write time only. A CLOSED set: both writers of the table leave
 *  `computed_at` to its `DEFAULT now()`, so no row stamped before T_ADAPTER can appear after it — the snapshot is
 *  sha-pinned (registered.ts) and the CH3 gate re-reads it. */
export const ADAPTER_V2_BEFORE_SQL =
  `SELECT d.signal_id || ',' || d.barrier_spec FROM directional_labels d JOIN signals s ON s.id = d.signal_id ` +
  `WHERE (s.exchange, s.timeframe) IN (${[...ADAPTER_CELL].sort().map((c) => `('${c.split(':')[0]}', '${c.split(':')[1]}')`).join(', ')}) ` +
  `AND d.barrier_spec IN (${BARRIER_SPECS_V2.map((s) => `'${s.spec}'`).join(', ')}) ` +
  `AND d.computed_at < to_timestamp(${T_ADAPTER}) ORDER BY d.signal_id, d.barrier_spec`;

export const PROBES: Readonly<Record<string, () => string>> = {
  MISSING_V2: buildRelabelMissingSql,
  NULL_V1_GAP: () => NULL_V1_GAP_SQL,
  ADAPTER_V2_BEFORE: () => ADAPTER_V2_BEFORE_SQL,
};

/** Pure: the pinned stratum file from the probe's rows — header `signal_id,barrier_spec`, one `-v2` row per line,
 *  in the probe's order. A row that is not `<id>,<a -v2 spec>` refuses. */
export function adapterSnapshotCsv(rows: readonly string[]): string {
  const v2 = new Set<string>(BARRIER_SPECS_V2.map((s) => s.spec));
  for (const r of rows) {
    const c = r.split(',');
    if (c.length !== 2 || !/^\d+$/.test(c[0]) || !v2.has(c[1])) throw new Error(`adapter snapshot row '${r.slice(0, 80)}' is not signal_id,<-v2 spec>`);
  }
  return ['signal_id,barrier_spec', ...rows].join('\n') + '\n';
}

/** The rows of one read-session output, after asserting its first line is the read-only token. */
export function sessionRows(text: string, name: string): string[] {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines[0] !== RO_TOKEN_LINE) throw new Error(`${name}: first line is not the read-only token`);
  return lines.slice(1);
}

/** The relabel's manifest across every log it wrote to: the LAST class per signal wins (a signal deferred on one
 *  night and written or refused on a later one). A line that starts the prefix but does not parse, or names an
 *  unregistered class, refuses the whole manifest. */
export function parseManifest(texts: readonly string[]): Map<number, ManifestClass> {
  const known = new Set<string>(MANIFEST_CLASSES);
  const out = new Map<number, ManifestClass>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('LRW_MANIFEST')) continue;
      const m = line.match(/^LRW_MANIFEST (\d+) (\S+)$/);
      if (!m || !known.has(m[2])) throw new Error(`manifest line not in the registered form: '${line.slice(0, 80)}'`);
      out.set(Number(m[1]), m[2] as ManifestClass);
    }
  }
  return out;
}

export interface RelabelCompleteness { missing: number; unmanifested: number; deferred: number; byClass: Record<string, number>; byVenue: Record<string, number> }

/** Pure: the missing rows (`id,exchange,timeframe`) against the manifest. `byVenue` counts the unfinished. */
export function relabelCompleteness(missingRows: readonly string[], manifest: ReadonlyMap<number, ManifestClass>): RelabelCompleteness {
  const r: RelabelCompleteness = { missing: missingRows.length, unmanifested: 0, deferred: 0, byClass: {}, byVenue: {} };
  for (const row of missingRows) {
    const c = row.split(',');
    const id = Number(c[0]);
    if (c.length !== 3 || !Number.isInteger(id) || id <= 0) throw new Error(`missing-v2 row '${row.slice(0, 80)}' is not id,exchange,timeframe`);
    const cls = manifest.get(id);
    if (cls === undefined || cls === 'deferred') {
      if (cls === undefined) r.unmanifested++; else r.deferred++;
      r.byVenue[c[1]] = (r.byVenue[c[1]] ?? 0) + 1;
      continue;
    }
    r.byClass[cls] = (r.byClass[cls] ?? 0) + 1;
  }
  return r;
}

/** Pure: how many NULL `-v1` rows the pinned worklists could still annotate. */
export function annotationCompleteness(nullKeys: readonly string[], gaps: ReadonlyMap<string, number>): { nullRows: number; annotatable: number } {
  let annotatable = 0;
  for (const k of nullKeys) {
    const c = k.split(',');
    if (c.length !== 2 || !/^\d+$/.test(c[0])) throw new Error(`null-key row '${k.slice(0, 80)}' is not signal_id,barrier_spec`);
    if (gaps.has(`${Number(c[0])}|${c[1]}`)) annotatable++;
  }
  return { nullRows: nullKeys.length, annotatable };
}

function arg(argv: string[], f: string): string {
  const i = argv.indexOf(f);
  if (i < 0 || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`missing ${f}`);
  return argv[i + 1];
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes('--emit')) {
    const probe = PROBES[argv[argv.indexOf('--emit') + 1] ?? ''];
    if (!probe) { process.stderr.write(`unknown probe (one of ${Object.keys(PROBES).join(', ')})\n`); return 2; }
    process.stdout.write(probe() + '\n');
    return 0;
  }
  if (argv.includes('--adapter-snapshot')) {
    try {
      const csv = adapterSnapshotCsv(sessionRows(readFileSync(arg(argv, '--session'), 'utf8'), 'adapter-v2-before'));
      const out = arg(argv, '--out');
      writeFileSync(out, csv);
      console.log(`LRW_ADAPTER_SNAPSHOT=PASS sha256=${createHash('sha256').update(csv).digest('hex')} rows=${csv.split('\n').length - 2}`);
      return 0;
    } catch (err) {
      console.log(`LRW_ADAPTER_SNAPSHOT=INDETERMINATE ${(err as Error).message.slice(0, 300)}`);
      return 3;
    }
  }
  const token = argv.includes('--relabel') ? 'LRW_RELABEL_COMPLETE' : argv.includes('--annotation') ? 'LRW_ANNOTATION_COMPLETE' : null;
  if (!token) { console.log('LRW_COMPLETENESS=INDETERMINATE one of --relabel / --annotation / --adapter-snapshot / --emit is required'); return 3; }
  try {
    if (token === 'LRW_RELABEL_COMPLETE') {
      const missing = sessionRows(readFileSync(arg(argv, '--missing'), 'utf8'), 'missing-v2');
      const manifest = parseManifest(arg(argv, '--manifest').split(',').map((p) => readFileSync(p, 'utf8')));
      const r = relabelCompleteness(missing, manifest);
      const done = r.unmanifested === 0 && r.deferred === 0;
      console.log(`${token}=${done ? 'YES' : 'NO'} ${JSON.stringify(r)}`);
      return done ? 0 : 1;
    }
    const nullKeys = sessionRows(readFileSync(arg(argv, '--null-keys'), 'utf8'), 'null-v1-gap');
    const gaps = parseGapWorklists(loadAnnotationSources(arg(argv, '--worklists').split(',')));
    const r = annotationCompleteness(nullKeys, gaps);
    console.log(`${token}=${r.annotatable === 0 ? 'YES' : 'NO'} ${JSON.stringify(r)}`);
    return r.annotatable === 0 ? 0 : 1;
  } catch (err) {
    console.log(`${token}=INDETERMINATE ${(err as Error).message.slice(0, 300)}`);
    return 3;
  }
}

if (process.argv[1] && process.argv[1].includes('lrw/completeness')) process.exit(main());
