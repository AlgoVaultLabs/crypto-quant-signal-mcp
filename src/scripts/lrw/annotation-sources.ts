// lrw/annotation-sources.ts — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: the `race_gap_candles` annotation's sources —
// the two sha-pinned replay worklists (ruling LRW-Q3), read and keyed ONCE for the annotation writer and the
// read-only completeness check. Pure: no DB, no caller tag.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ANNOTATION_SOURCE_SHA256 } from './registered.js';

/** Read `signal_id,barrier_spec,…,gap_served_L,…` worklists (gzip CSV, header first) into one map keyed
 *  `(signal_id, barrier_spec)` — never by signal_id alone (the §7 inline resolution). A key in two files must
 *  agree; a disagreement refuses the whole annotation. Pure on its inputs. */
export function parseGapWorklists(files: ReadonlyArray<{ name: string; csv: string }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) {
    const lines = f.csv.split('\n');
    const header = (lines[0] ?? '').split(',');
    const iId = header.indexOf('signal_id');
    const iSpec = header.indexOf('barrier_spec');
    const iGap = header.indexOf('gap_served_L');
    if (iId < 0 || iSpec < 0 || iGap < 0) throw new Error(`${f.name}: header lacks signal_id / barrier_spec / gap_served_L`);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const c = line.split(',');
      const key = `${Number(c[iId])}|${c[iSpec]}`;
      const gap = Number(c[iGap]);
      if (!c[iSpec].endsWith('-v1')) throw new Error(`${f.name}:${i + 1}: a worklist row for a non -v1 spec (${c[iSpec]})`);
      if (!Number.isInteger(gap) || gap < 0 || gap > 32767) throw new Error(`${f.name}:${i + 1}: gap '${c[iGap]}' is not a SMALLINT >= 0`);
      const prev = out.get(key);
      if (prev !== undefined && prev !== gap) throw new Error(`${f.name}:${i + 1}: ${key} disagrees with an earlier worklist (${prev} vs ${gap})`);
      out.set(key, gap);
    }
  }
  return out;
}

/** Read the annotation's worklists, refusing any file whose sha256 is not one of the two pinned sources (the
 *  canonical replay, the delta replay — lrw/registered.ts). The UPDATE writes NULL only, so a wrong file's values
 *  would be permanent: the pinned file could never replace them. */
export function loadAnnotationSources(paths: readonly string[]): Array<{ name: string; csv: string; sha256: string }> {
  if (paths.length === 0) throw new Error('--annotate-gaps names no file');
  return paths.map((name) => {
    const raw = readFileSync(name);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (!ANNOTATION_SOURCE_SHA256.has(sha256)) throw new Error(`${name}: sha256 ${sha256} is not a pinned annotation source (registration §3.2)`);
    return { name, csv: gunzipSync(raw).toString('utf8'), sha256 };
  });
}
