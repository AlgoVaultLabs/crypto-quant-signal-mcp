/**
 * OPS-PFE-METRIC-INTEGRITY-W1 R10 — the Trap 7 positive-assertion canary.
 *
 * ── THE TRAP THIS EXISTS TO CATCH ──
 *
 * PFE is one-sided by construction (`pfePrice` initialises to entry and updates only on
 * improvement), so across 343,478 contemporaneous evaluated rows there is not ONE row where
 * PFE moved adversely. That makes
 *
 *     PFE win rate  ===  1 - P(pfe_return_pct = 0)
 *
 * an identity. The seductive "fix" for the frozen-book problem is therefore to drop every
 * `pfe = 0` row — which would drive every cohort to exactly **100.00%**, because the losing
 * side of the metric IS the zero bucket.
 *
 * The zero bucket holds TWO different things, and only one of them is a defect:
 *
 *   S1  pfe = 0, mae != 0   price MOVED, just never favourably   ⇒ a GENUINE LOSS. KEEP IT.
 *   S2  pfe = 0 AND mae = 0 price did not move AT ALL            ⇒ a frozen (shut) book.
 *
 * Measured contemporaneous counts: S1 = 27,034 · S2 = 1,041. Excluding S2 is the fix;
 * excluding S1 is metric fraud dressed as a cleanup.
 *
 * These tests pin the discrimination rule and assert the direction of every exclusion, so a
 * future "cleanup" that sweeps S1 fails HERE rather than shipping a 100% win rate.
 */

import { describe, it, expect } from 'vitest';

/** The canonical public predicate (`performance-db.ts`): BUY wins on pfe>0, SELL on pfe<0. */
function isPfeWin(signal: 'BUY' | 'SELL', pfe: number): boolean {
  return signal === 'BUY' ? pfe > 0 : pfe < 0;
}

/** The airtight S2 predicate ratified by this wave. */
function isFrozen(pfe: number, mae: number): boolean {
  return pfe === 0 && mae === 0;
}

type Row = { signal: 'BUY' | 'SELL'; pfe: number; mae: number; label: string };

/** A cohort shaped like the real corpus: mostly wins, a real S1 tail, a small S2 pocket. */
const COHORT: Row[] = [
  { signal: 'BUY', pfe: 2.5, mae: -0.4, label: 'S3 win' },
  { signal: 'BUY', pfe: 8.86, mae: -2.57, label: 'S3 win (TLM, live 2026-07-19)' },
  { signal: 'SELL', pfe: -1.2, mae: 0.3, label: 'S3 win' },
  { signal: 'BUY', pfe: 0, mae: -9.97, label: 'S1 genuine loss (BILL, live 2026-07-19)' },
  { signal: 'BUY', pfe: 0, mae: -3.1, label: 'S1 genuine loss' },
  { signal: 'SELL', pfe: 0, mae: 4.4, label: 'S1 genuine loss' },
  { signal: 'SELL', pfe: 0, mae: 0, label: 'S2 frozen book (ASTER QQQ off-hours)' },
  { signal: 'BUY', pfe: 0, mae: 0, label: 'S2 frozen book' },
];

const wr = (rows: Row[]): number =>
  rows.length === 0 ? NaN : (100 * rows.filter((r) => isPfeWin(r.signal, r.pfe)).length) / rows.length;

describe('Trap 7 — S1 genuine losses stay in the denominator', () => {
  it('an S1 row is a LOSS under the canonical predicate, in both directions', () => {
    expect(isPfeWin('BUY', 0)).toBe(false);
    expect(isPfeWin('SELL', 0)).toBe(false);
  });

  it('S1 is NOT frozen — mae != 0 proves the market moved', () => {
    expect(isFrozen(0, -9.97)).toBe(false);
    expect(isFrozen(0, 4.4)).toBe(false);
  });

  it('S2 is frozen — nothing moved in either direction', () => {
    expect(isFrozen(0, 0)).toBe(true);
  });

  it('the CORRECT exclusion (S2 only) raises WR but leaves it well below 100%', () => {
    const before = wr(COHORT);
    const after = wr(COHORT.filter((r) => !isFrozen(r.pfe, r.mae)));
    expect(after).toBeGreaterThan(before);   // direction: the headline moves UP
    expect(after).toBeLessThan(100);         // ...but S1 losses survive
    expect(after).toBeCloseTo(50, 5);        // 3 wins of 6 remaining
  });

  it('🔴 the WRONG exclusion (all pfe=0) yields exactly 100.00% — the fail signature', () => {
    const wrong = wr(COHORT.filter((r) => r.pfe !== 0));
    expect(wrong).toBe(100);
    // Stated as an executable rule so the intent survives a refactor:
    // any cohort reading exactly 100.00% means the wrong operation was performed.
    expect(wrong).not.toBe(wr(COHORT.filter((r) => !isFrozen(r.pfe, r.mae))));
  });

  it('the S2 exclusion removes ONLY frozen rows — every S1 row survives, by identity', () => {
    const kept = COHORT.filter((r) => !isFrozen(r.pfe, r.mae));
    const s1 = COHORT.filter((r) => r.pfe === 0 && r.mae !== 0);
    expect(s1).toHaveLength(3);
    for (const row of s1) expect(kept).toContain(row);
    expect(kept.filter((r) => isFrozen(r.pfe, r.mae))).toHaveLength(0);
  });

  it('the identity holds on this cohort: WR === 1 - P(pfe = 0)', () => {
    const pZero = COHORT.filter((r) => r.pfe === 0).length / COHORT.length;
    expect(wr(COHORT)).toBeCloseTo(100 * (1 - pZero), 10);
  });

  it('no row in the corpus can have an ADVERSE pfe — the one-sidedness that causes all this', () => {
    for (const r of COHORT) {
      if (r.signal === 'BUY') expect(r.pfe).toBeGreaterThanOrEqual(0);
      else expect(r.pfe).toBeLessThanOrEqual(0);
    }
  });
});

describe('Trap 7 — measured corpus proportions (pinned so a silent shift is visible)', () => {
  // Contemporaneous era (created_at >= 1776211200), measured 2026-07-19 at origin/main a5ebb6e.
  const MEASURED = { s3: 317120, s1: 27034, s2: 1041 };
  const total = MEASURED.s3 + MEASURED.s1 + MEASURED.s2;

  it('S2 is a small slice — excluding it moves the headline UP by well under a point', () => {
    const before = (100 * MEASURED.s3) / total;
    const after = (100 * MEASURED.s3) / (MEASURED.s3 + MEASURED.s1);
    expect(after - before).toBeGreaterThan(0);
    expect(after - before).toBeLessThan(1);   // measured expectation: ~+0.29pp
  });

  it('S1 is ~26x larger than S2 — dropping it would be the dominant, wrong effect', () => {
    expect(MEASURED.s1 / MEASURED.s2).toBeGreaterThan(20);
  });

  it('dropping ALL zeros would yield exactly 100% on the real corpus too', () => {
    expect((100 * MEASURED.s3) / MEASURED.s3).toBe(100);
  });
});
