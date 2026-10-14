/**
 * EDGE-LABELER-RACE-WINDOW-V2-W1 CH4 (ruling Q-A = A) — THE SEAL AS A GATE. Every row the nightly writes lies inside
 * the B-DIR v3 FULL sealed holdout, where only cardinalities may be read. So the race-integrity canary's SQL may name
 * four columns of `directional_labels` — signal_id, barrier_spec, computed_at, race_gap_candles — and no other column
 * of any table. This test reads the statements the canary actually builds (`--print-sql`) and checks them against the
 * table's real column list (derived from the DDL the labeler applies, never retyped). It also runs the canary's own
 * hermetic self-test, so a regression in its verdict logic fails here, in CI, before any install.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DIRECTIONAL_LABELS_DDL_PG } from '../../src/scripts/directional-labeler.js';

const CANARY = 'ops/monitoring/directional-labels-race-integrity.py';
const ALLOWED = ['signal_id', 'barrier_spec', 'computed_at', 'race_gap_candles'];
const NAMED_FORBIDDEN = ['label', 'ret_at_expiry_pct', 'barrier_pct', 'ambiguous_candle', 'low_vol_history'];

/** PURE. The column names of `CREATE TABLE … directional_labels (…)` plus every `ADD COLUMN` after it. */
function ddlColumns(ddl: string): string[] {
  const body = (ddl.match(/CREATE TABLE IF NOT EXISTS directional_labels \(([\s\S]*?)\n\s*\);/) ?? ['', ''])[1];
  const cols = body.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+\s/.test(l) && !/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0]);
  for (const m of ddl.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)) cols.push(m[1]);
  return [...new Set(cols)];
}
/** PURE. The tables a statement reads (FROM / JOIN targets; a `FROM fn(` is a function, not a table). */
function tablesOf(sql: string): string[] {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b(?!\s*\()/gi)].map((m) => m[1].toLowerCase());
}
function canary(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('python3', ['-B', CANARY, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('the race-integrity canary reads cardinalities only — the seal (EDGE-LABELER-RACE-WINDOW-V2-W1 CH4)', () => {
  const cols = ddlColumns(DIRECTIONAL_LABELS_DDL_PG);

  it('the instrument sees the whole table: the DDL yields the four allowed columns AND the label columns', () => {
    for (const c of [...ALLOWED, ...NAMED_FORBIDDEN]) expect({ c, present: cols.includes(c) }).toEqual({ c, present: true });
  });

  it('every statement the canary builds names only the four columns, of one table, and no SELECT *', () => {
    const r = canary(['--print-sql']);
    expect(r.status).toBe(0);
    const texts = JSON.parse(r.stdout) as Record<string, string>;
    expect(Object.keys(texts).sort()).toEqual(['m_signals', 'v1_gap_sample', 'v1_rows', 'v2_freshness', 'v2_gap_nonzero', 'v2_rows_by_spec']);
    for (const [name, sql] of Object.entries(texts)) {
      const named = cols.filter((c) => new RegExp(`\\b${c}\\b`).test(sql));
      expect({ name, outside: named.filter((c) => !ALLOWED.includes(c)) }).toEqual({ name, outside: [] });
      expect({ name, forbidden: NAMED_FORBIDDEN.filter((c) => new RegExp(`\\b${c}\\b`).test(sql)) }).toEqual({ name, forbidden: [] });
      expect({ name, tables: [...new Set(tablesOf(sql))] }).toEqual({ name, tables: ['directional_labels'] });
      expect(sql).not.toMatch(/\bSELECT\s+\*/i);
    }
  });

  it('the allow-list check itself can fail (a label column and a second table are caught)', () => {
    const sql = 'SELECT signal_id, label FROM directional_labels d JOIN signals s ON s.id = d.signal_id';
    expect(cols.filter((c) => new RegExp(`\\b${c}\\b`).test(sql)).filter((c) => !ALLOWED.includes(c))).toEqual(['label']);
    expect(tablesOf(sql)).toEqual(['directional_labels', 'signals']);
    expect(tablesOf('SELECT extract(epoch FROM max(computed_at)) FROM directional_labels')).toEqual(['directional_labels']);
  });

  it("the canary's own self-test passes: every verdict proven both ways, its SQL and parsers asserted directly", () => {
    const r = canary(['--self-test']);
    expect(r.stdout).toMatch(/^RACE_INTEGRITY_SELFTEST: PASS \(\d+ checks\)$/m);
    expect(r.stdout).not.toMatch(/SELF-TEST: FAIL/);
    expect(r.status).toBe(0);
  });
});
