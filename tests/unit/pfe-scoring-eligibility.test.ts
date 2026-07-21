/**
 * OPS-PFE-METRIC-INTEGRITY-W1 R5/R10 — the canonical PFE eligibility rule.
 *
 * These tests are the guard on the operator's ruling:
 *   "score as loss. It needs to have at least 1 candle on the call's direction in the
 *    evaluation timeframe."
 *
 * That ruling is CORRECT for S1 (price moved, never favourably — a real loss) and must NOT be
 * applied to S2 (price did not move at all — a shut book). Getting that split wrong in either
 * direction is the wave's central failure mode, so both directions are pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
  isFrozenEvaluation,
  isPfeEligible,
  isPfeWinRow,
  pfeWinRateOf,
  type PfeScorable,
} from '../../src/lib/pfe-scoring.js';

const row = (signal: string, pfe: number | null, mae: number | null): PfeScorable =>
  ({ signal, pfe_return_pct: pfe, mae_return_pct: mae });

// Real shapes, taken from live rows measured 2026-07-19/21.
const S3_BUY_WIN = row('BUY', 8.86, -2.57);      // TLM BUY 5m
const S3_SELL_WIN = row('SELL', -1.2, 0.3);
const S1_BUY_LOSS = row('BUY', 0, -9.97);        // BILL BUY 2h — moved hard against
const S1_SELL_LOSS = row('SELL', 0, 4.4);
const S2_FROZEN_SELL = row('SELL', 0, 0);        // ASTER QQQ off-hours
const S2_FROZEN_BUY = row('BUY', 0, 0);
const NEVER_EVALUATED = row('BUY', null, null);
const HOLD_ROW = row('HOLD', null, null);

describe('isFrozenEvaluation — S2 is a CONJUNCTION, deliberately', () => {
  it('true only when BOTH pfe and mae are zero', () => {
    expect(isFrozenEvaluation(S2_FROZEN_SELL)).toBe(true);
    expect(isFrozenEvaluation(S2_FROZEN_BUY)).toBe(true);
  });

  it('FALSE for an S1 genuine loss — mae != 0 proves the market moved', () => {
    expect(isFrozenEvaluation(S1_BUY_LOSS)).toBe(false);
    expect(isFrozenEvaluation(S1_SELL_LOSS)).toBe(false);
  });

  it('false for a winner', () => {
    expect(isFrozenEvaluation(S3_BUY_WIN)).toBe(false);
  });

  it('is not fooled by a tiny non-zero mae — any movement disqualifies it', () => {
    expect(isFrozenEvaluation(row('BUY', 0, -0.0001))).toBe(false);
  });
});

describe('isPfeEligible — what counts toward the published number', () => {
  it('counts winners and S1 genuine losses', () => {
    expect(isPfeEligible(S3_BUY_WIN)).toBe(true);
    expect(isPfeEligible(S3_SELL_WIN)).toBe(true);
    expect(isPfeEligible(S1_BUY_LOSS)).toBe(true);     // ← the operator's ruling, in code
    expect(isPfeEligible(S1_SELL_LOSS)).toBe(true);
  });

  it('excludes S2 frozen books', () => {
    expect(isPfeEligible(S2_FROZEN_SELL)).toBe(false);
    expect(isPfeEligible(S2_FROZEN_BUY)).toBe(false);
  });

  it('excludes never-evaluated rows (already outside every cohort)', () => {
    expect(isPfeEligible(NEVER_EVALUATED)).toBe(false);
    expect(isPfeEligible(row('SELL', undefined, undefined))).toBe(false);
  });

  it('excludes HOLD — not a directional call, never had an outcome', () => {
    expect(isPfeEligible(HOLD_ROW)).toBe(false);
    expect(isPfeEligible(row('HOLD', 1.5, -1))).toBe(false);
  });
});

describe('the S1 rows stay LOSSES (Trap 7 — the fail signature is 100.00%)', () => {
  const COHORT = [S3_BUY_WIN, S3_SELL_WIN, S1_BUY_LOSS, S1_SELL_LOSS, S2_FROZEN_SELL, S2_FROZEN_BUY];

  it('an eligible S1 row scores as a LOSS, in both directions', () => {
    expect(isPfeEligible(S1_BUY_LOSS) && isPfeWinRow(S1_BUY_LOSS)).toBe(false);
    expect(isPfeEligible(S1_SELL_LOSS) && isPfeWinRow(S1_SELL_LOSS)).toBe(false);
  });

  it('the correct exclusion raises the rate but keeps it below 100%', () => {
    const r = pfeWinRateOf(COHORT);
    expect(r.excludedFrozen).toBe(2);
    expect(r.evaluated).toBe(4);         // 2 wins + 2 S1 losses
    expect(r.wins).toBe(2);
    expect(r.rate).toBe(0.5);
    expect(r.rate).toBeLessThan(1);      // ← S1 survived
  });

  it('🔴 dropping ALL pfe=0 rows would yield exactly 100% — never do this', () => {
    const wrong = COHORT.filter((x) => x.signal !== 'HOLD' && x.pfe_return_pct !== 0 && x.pfe_return_pct != null);
    const wrongRate = wrong.filter(isPfeWinRow).length / wrong.length;
    expect(wrongRate).toBe(1);
    expect(pfeWinRateOf(COHORT).rate).not.toBe(1);
  });

  it('reports how many frozen rows were excluded — a silent drop is not disclosure', () => {
    expect(pfeWinRateOf(COHORT).excludedFrozen).toBe(2);
    expect(pfeWinRateOf([S3_BUY_WIN]).excludedFrozen).toBe(0);
  });

  it('returns null, not 0, on an empty eligible set', () => {
    expect(pfeWinRateOf([]).rate).toBeNull();
    expect(pfeWinRateOf([HOLD_ROW, S2_FROZEN_BUY]).rate).toBeNull();
  });
});

describe('direction of the change on a realistic mix (measured proportions)', () => {
  // Contemporaneous era, measured 2026-07-21: S3 317,120 · S1 27,034 · S2 1,041.
  const mk = (n: number, r: PfeScorable) => Array.from({ length: n }, () => r);
  const CORPUS = [...mk(3171, S3_BUY_WIN), ...mk(270, S1_BUY_LOSS), ...mk(10, S2_FROZEN_BUY)];

  it('excluding S2 moves the published rate UP, by well under a point', () => {
    const before = CORPUS.filter((x) => x.pfe_return_pct != null).filter(isPfeWinRow).length /
                   CORPUS.filter((x) => x.pfe_return_pct != null).length;
    const after = pfeWinRateOf(CORPUS).rate!;
    expect(after).toBeGreaterThan(before);
    expect((after - before) * 100).toBeLessThan(1);   // measured expectation ~+0.29pp
  });

  it('S1 dwarfs S2 — so dropping S1 would be the dominant, wrong effect', () => {
    const s1 = CORPUS.filter((x) => x.pfe_return_pct === 0 && x.mae_return_pct !== 0).length;
    const s2 = CORPUS.filter(isFrozenEvaluation).length;
    expect(s1 / s2).toBeGreaterThan(20);
  });
});

describe('single-derivation: every surface projects from ONE rule', () => {
  it('pfeWinRateOf agrees with a hand-applied isPfeEligible + isPfeWinRow', () => {
    const rows = [S3_BUY_WIN, S1_BUY_LOSS, S2_FROZEN_BUY, HOLD_ROW, NEVER_EVALUATED, S3_SELL_WIN];
    const manual = rows.filter(isPfeEligible);
    const r = pfeWinRateOf(rows);
    expect(r.evaluated).toBe(manual.length);
    expect(r.wins).toBe(manual.filter(isPfeWinRow).length);
    expect(r.rate).toBeCloseTo(manual.filter(isPfeWinRow).length / manual.length, 12);
  });

  it('the SQL pushdown path applies the SAME rule as the TS predicate', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../src/lib/performance-db.ts'), 'utf8');

    // ⚠️ THE DEFECT THIS PINS. getPerformanceStatsAsync has a PG GROUP-BY pushdown
    // (PERF_STATS_SQL_PUSHDOWN, ON in prod) that aggregates in Postgres and never
    // materialises rows — so the TS predicates are simply NOT on the live path. The first
    // attempt at this wave changed only the TS side and was a silent no-op on the published
    // number; it surfaced only because the post-deploy headline moved +0.0004pp instead of
    // the expected +0.29pp. Both the numerator filter AND the denominator must carry it.
    const sqlFn = src.slice(src.indexOf('export function buildStatsAggregateSql'));
    const body = sqlFn.slice(0, sqlFn.indexOf('\n}'));
    expect(body).toMatch(/SQL_PFE_ELIGIBLE/);
    // the DENOMINATOR (pfe_eval) is the half that is easy to forget
    expect(body).toMatch(/pfe_eval/);
    expect(body).not.toMatch(/FILTER \(WHERE pfe_return_pct IS NOT NULL\) AS pfe_eval/);
  });

  it('the shared SQL fragment expresses exactly isFrozenEvaluation', async () => {
    const { SQL_NOT_FROZEN, SQL_PFE_ELIGIBLE } = await import('../../src/lib/pfe-scoring.js');
    expect(SQL_NOT_FROZEN).toBe('NOT (pfe_return_pct = 0 AND mae_return_pct = 0)');
    expect(SQL_PFE_ELIGIBLE).toContain('pfe_return_pct IS NOT NULL');
    expect(SQL_PFE_ELIGIBLE).toContain(SQL_NOT_FROZEN);

    // Evaluate the SQL semantics in JS over the fixture matrix and require the two
    // derivations to agree row-for-row. A change to one that is not mirrored fails HERE.
    const sqlEligible = (r: PfeScorable) =>
      r.pfe_return_pct != null && !(r.pfe_return_pct === 0 && r.mae_return_pct === 0);
    for (const r of [S3_BUY_WIN, S3_SELL_WIN, S1_BUY_LOSS, S1_SELL_LOSS, S2_FROZEN_BUY, S2_FROZEN_SELL, NEVER_EVALUATED]) {
      expect(sqlEligible(r), `divergence on ${JSON.stringify(r)}`).toBe(isPfeEligible(r));
    }
  });

  it('mae_return_pct is PROJECTED — without it the predicate silently excludes nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../src/lib/performance-db.ts'), 'utf8');
    const proj = src.slice(src.indexOf('const STATS_COL_PROJECTION'));
    expect(proj.slice(0, proj.indexOf('\n'))).toContain('mae_return_pct');

    // Prove WHY: a row missing mae_return_pct is NOT detected as frozen.
    const projectionless = { signal: 'BUY', pfe_return_pct: 0 } as PfeScorable;
    expect(isFrozenEvaluation(projectionless)).toBe(false);
    expect(isPfeEligible(projectionless)).toBe(true);   // ← silently counted, as a loss
  });

  it('performance-db.ts has NO bare `pfe_return_pct != null` eligibility filter left', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../src/lib/performance-db.ts'), 'utf8');
    // Eleven parallel copies of the eligibility rule is exactly the drift this replaced.
    expect(src).not.toMatch(/\.filter\([^)]*pfe_return_pct\s*!=\s*null/);
    expect(src).toMatch(/import \{[^}]*isPfeEligible[^}]*\} from '\.\/pfe-scoring\.js'/);
  });
});
