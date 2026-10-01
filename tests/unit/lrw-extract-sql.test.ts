import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 — what was registered is what is run. The registration's §3.1 code blocks
// are pinned BYTE-EQUAL to the generator before any pull, and the literal tables inside them are pinned to the
// labeller's own derivations, so neither the read nor the population can drift from the code that wrote it.

import {
  TOKEN_SQL, COUNTERS_SQL, EXTRACT_SQL, COUNTS_APART_SQL, V2_WITHOUT_V1_SQL, V1_DIGEST_SQL, withTCut, EXTRACT_HEADER, emitMain,
} from '../../src/scripts/lrw/extract-sql.js';
import { T_CUT_EPOCH } from '../../src/scripts/lrw/registered.js';
import { EVAL_CANDLES, TF_MS } from '../../src/scripts/directional-labeler.js';
import { coarserV1LagTable } from '../../src/scripts/backfill-directional-labels.js';

const REG = readFileSync('audits/labeler-race-window-v2-preregistration-2026-09-28.md', 'utf8');
const SEC = REG.slice(REG.indexOf('### 3.1 The read session'), REG.indexOf('### 3.2 The off-DB strata'));
const BLOCKS = [...SEC.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((m) => m[1]);

describe('the registered read session is the generator, byte for byte', () => {
  it('§3.1 holds exactly five statements, in this order, each byte-equal to its generator', () => {
    expect(BLOCKS).toHaveLength(5);
    expect(BLOCKS).toEqual([TOKEN_SQL, COUNTERS_SQL, EXTRACT_SQL, COUNTS_APART_SQL, V2_WITHOUT_V1_SQL]);
  });

  it('the literal timeframe and coarser-pair tables are the labeller\'s own (W, requested step, served step)', () => {
    const tfValues = Object.entries(EVAL_CANDLES)
      .filter(([tf]) => tf !== '1m')
      .map(([tf, w]) => `('${tf}', ${TF_MS[tf] / 1000}, ${w})`)
      .join(', ');
    const coarser = coarserV1LagTable().map((r) => `('${r.venue}', '${r.timeframe}', ${r.servedMs / 1000})`).sort();
    for (const sql of [EXTRACT_SQL, COUNTS_APART_SQL, V2_WITHOUT_V1_SQL, V1_DIGEST_SQL]) {
      expect(sql).toContain(`JOIN (VALUES ${tfValues}) AS tf(t, sec, w)`);
      const m = sql.match(/LEFT JOIN \(VALUES (.*?)\) AS coarser/);
      expect(m).not.toBeNull();
      expect(m![1].split(/, (?=\()/).sort()).toEqual(coarser);
      // T_CAP in the ruled form (Q11 / LRW-Q8): the race end on max(requested, served)
      expect(sql).toContain('s.created_at <= 1790402400');
      expect(sql).toContain('s.created_at + (tf.w + 1) * GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec)) <= 1790402400');
    }
  });

  it('the extract reads its allow-list and nothing else: no mfe / mae / expiry / outcome / scorer / hold column', () => {
    for (const sql of [EXTRACT_SQL, COUNTS_APART_SQL, V2_WITHOUT_V1_SQL, V1_DIGEST_SQL]) {
      for (const bad of ['mfe_', 'mae_', 'ret_at_expiry', 'outcome_', 'pfe_return', 'hold_decision', 'confidence']) {
        expect(sql.includes(bad)).toBe(false);
      }
    }
    const aliases = [...EXTRACT_SQL.matchAll(/ AS (\w+),?\n/g)].map((m) => m[1]).filter((a) => !['t', 'exchange', 'v1', 'v2'].includes(a));
    expect(['id', 'created_at', 'exchange', 'coin', 'timeframe', ...aliases]).toEqual(EXTRACT_HEADER);
  });

  it(':T_CUT is the only substitution, and it refuses a non-epoch or a statement without the placeholder', () => {
    const sql = withTCut(EXTRACT_SQL, 1790754894.743475);
    expect(sql).toContain('v1.computed_at < to_timestamp(1790754894.743475)');
    expect(sql.includes(':T_CUT')).toBe(false);
    expect(() => withTCut(EXTRACT_SQL, Number.NaN)).toThrow(/epoch/);
    expect(() => withTCut(EXTRACT_SQL, 0)).toThrow(/epoch/);
    expect(() => withTCut(TOKEN_SQL, 1790754894)).toThrow(/placeholder/);
  });

  it('T_CUT is pinned, not a caller\'s choice: --emit substitutes the recorded cut; --t-cut is refused', () => {
    expect(T_CUT_EPOCH).toBe(1790754894.743475); // 2026-09-30T07:54:54.743475Z, the first container on c553578c
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out.push(String(c)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(emitMain(['--emit', 'EXTRACT'])).toBe(0);
      expect(out.at(-1)).toBe(withTCut(EXTRACT_SQL, T_CUT_EPOCH) + '\n');
      expect(emitMain(['--emit', 'T_CUT'])).toBe(0);
      expect(out.at(-1)).toBe(`${T_CUT_EPOCH}\n`);
      expect(emitMain(['--emit', 'TOKEN'])).toBe(0);
      expect(out.at(-1)).toBe(TOKEN_SQL + '\n');
      expect(emitMain(['--emit', 'EXTRACT', '--t-cut', '1790754894'])).toBe(2);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });

  it('the ADD-ONLY digest (LRW-Q7-C) covers the registered population and the -v1 LABEL columns only', () => {
    const where = (sql: string) => sql.slice(sql.indexOf('WHERE s.created_at <= 1790402400'));
    expect(where(V1_DIGEST_SQL).replace(/\n\) x$/, '')).toBe(where(EXTRACT_SQL).replace(/\n  ORDER BY [\s\S]*$/, ''));
    expect(V1_DIGEST_SQL).toContain(
      "concat_ws('|', v1.signal_id, v1.barrier_spec, v1.label, v1.ambiguous_candle, v1.low_vol_history, v1.t_hit_candles, v1.barrier_pct)",
    );
    expect(V1_DIGEST_SQL).not.toMatch(/race_gap_candles|computed_at\)?,/); // the annotated column is NOT in the digest
  });
});
