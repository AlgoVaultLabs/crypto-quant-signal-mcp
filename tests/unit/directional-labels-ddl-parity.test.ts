// EDGE-ADS1-SCORECARD-W1-V2 CH2 R3 — `directional_labels` is declared twice (the migrations and the
// labeler's applied DDL). This pins the two column sets equal, two-way, and proves the check can fail.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DIRECTIONAL_LABELS_DDL_PG } from '../../src/scripts/directional-labeler.js';
import { columnsOfAlterAdd, columnsOfCreate, ddlParity } from '../../src/scripts/ads1/ddl-parity.js';
import { runDdlParityCheck } from '../../src/scripts/ads1/ddl-parity-check.js';

const MIG = path.resolve(__dirname, '../../migrations');
const forward = () =>
  readdirSync(MIG).filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql')).sort().map((f) => readFileSync(path.join(MIG, f), 'utf8'));

describe('directional_labels DDL parity', () => {
  it('the labeler DDL and the migrations name the same eleven columns', () => {
    const r = ddlParity(DIRECTIONAL_LABELS_DDL_PG, forward());
    expect(r).toEqual({ verdict: 'PASS', columns: 11, onlyInApplied: [], onlyInMigrations: [] });
  });

  it('the expiry column is additive: migration 043 adds exactly ret_at_expiry_pct', () => {
    const m043 = readFileSync(path.join(MIG, '043_directional_labels_expiry.sql'), 'utf8');
    expect(columnsOfAlterAdd(m043, 'directional_labels')).toEqual(['ret_at_expiry_pct']);
    expect(m043).toMatch(/ADD COLUMN IF NOT EXISTS ret_at_expiry_pct DOUBLE PRECISION;/);
    expect(m043).not.toMatch(/NOT NULL|DEFAULT/); // nullable, no default: NULL = not resolved
  });

  it('comments never leak into the column set', () => {
    const cols = columnsOfCreate(readFileSync(path.join(MIG, '019_directional_labels.sql'), 'utf8'), 'directional_labels');
    expect(cols).toEqual([
      'signal_id', 'barrier_spec', 'label', 'ambiguous_candle', 'low_vol_history', 't_hit_candles',
      'mfe_return_pct', 'mae_return_pct', 'barrier_pct', 'computed_at',
    ]);
  });

  it('FAILS when a migration adds a column the labeler does not declare', () => {
    const r = ddlParity(DIRECTIONAL_LABELS_DDL_PG, [...forward(), 'ALTER TABLE directional_labels ADD COLUMN IF NOT EXISTS extra_col INT;']);
    expect(r.verdict).toBe('FAIL');
    expect(r.onlyInMigrations).toEqual(['extra_col']);
  });

  it('FAILS when the labeler declares a column no migration creates', () => {
    const r = ddlParity(DIRECTIONAL_LABELS_DDL_PG + '\nALTER TABLE directional_labels ADD COLUMN IF NOT EXISTS ghost DOUBLE PRECISION;', forward());
    expect(r.verdict).toBe('FAIL');
    expect(r.onlyInApplied).toEqual(['ghost']);
  });

  it('the gate leg prints one token: PASS on the repo, INDETERMINATE on an unreadable directory', () => {
    const lines: string[] = [];
    expect(runDdlParityCheck(MIG, (l) => lines.push(l))).toBe(0);
    expect(runDdlParityCheck(path.join(MIG, 'does-not-exist'), (l) => lines.push(l))).toBe(3);
    expect(lines[0]).toMatch(/^DDL_PARITY: PASS \(11 columns/);
    expect(lines[1]).toMatch(/^DDL_PARITY: INDETERMINATE/);
  });
});
