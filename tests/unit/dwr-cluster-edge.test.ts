// tests/unit/dwr-cluster-edge.test.ts — OPS-AOE-MONITORING-DWR-REFOCUS-W1 R1.
//
// Two jobs. (1) PIN the embedded contract to `population-comparison.schema.json`, the same
// discipline `detector-envelope.test.ts` gives its embedded schema — the module cannot read the
// file at runtime (the Dockerfile COPYs no `ops/` path), so a drifting projection would be
// invisible in the container and green everywhere else. (2) PROVE the two corrections are
// different and that each one MATTERS, with fixtures where pooling flips the sign and where the
// comparator alone moves the answer by 28.8 pp. A test that only checked the mean could not tell
// a wrong null from a wrong average, and those are precisely the two things under test.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLUSTER_EDGE_CONTRACT, MIN_ROWS_PER_CLUSTER, clusterEdge, clusterEdgeOf, utcDayOf,
} from '../../src/scripts/dwr-cluster-edge.js';
import type { LabelRow } from '../../src/scripts/dwr-baseline.js';

const SCHEMA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../ops/monitoring/population-comparison.schema.json', import.meta.url)),
  'utf8',
));

/** Seconds-since-epoch for 12:00 UTC on a given day, so a fixture never sits on a boundary. */
const at = (day: string): number => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);

/**
 * `a` BUY-win, `b` BUY-loss, `c` SELL-win, `d` SELL-loss, `t` timeouts.
 * uppers = a + d · lowers = b + c · wins = a + c · q = (a + b) / n.
 */
function rowsFor(day: string, a: number, b: number, c: number, d: number, t = 0): LabelRow[] {
  const mk = (side: 'BUY' | 'SELL', label: number, i: number): LabelRow => ({
    side, label, ambiguous: false, coin: `C${i}`, createdAt: at(day), barrierPct: 1,
  });
  const out: LabelRow[] = [];
  let i = 0;
  for (let k = 0; k < a; k++) out.push(mk('BUY', 1, i++));
  for (let k = 0; k < b; k++) out.push(mk('BUY', -1, i++));
  for (let k = 0; k < c; k++) out.push(mk('SELL', 1, i++));
  for (let k = 0; k < d; k++) out.push(mk('SELL', -1, i++));
  for (let k = 0; k < t; k++) out.push(mk('BUY', 0, i++));
  return out;
}

const day = (n: number): string => `2026-0${n < 10 ? 1 : 2}-${String(n).padStart(2, '0')}`;

describe('the embedded contract is a faithful projection of the JSON schema', () => {
  it('names a basis the schema allows and NOT one it bans', () => {
    expect(SCHEMA.basis_values).toContain(CLUSTER_EDGE_CONTRACT.basis);
    expect(SCHEMA.banned_basis).not.toContain(CLUSTER_EDGE_CONTRACT.basis);
    // The thing this wave did NOT migrate, asserted so the two stay legibly distinct.
    expect(SCHEMA.banned_basis).toContain('MAX_NAIVE');
  });

  it('pins aggregation, cluster unit, denominator and min_clusters field-for-field', () => {
    expect(SCHEMA.aggregation_values).toContain(CLUSTER_EDGE_CONTRACT.aggregation);
    expect(CLUSTER_EDGE_CONTRACT.aggregation).toBe('PER_CLUSTER');
    expect(SCHEMA.cluster_unit).toContain(CLUSTER_EDGE_CONTRACT.clusterUnit);
    expect(CLUSTER_EDGE_CONTRACT.denominatorConvention).toBe(SCHEMA.denominator_convention);
    expect(CLUSTER_EDGE_CONTRACT.minClusters).toBe(SCHEMA.min_clusters);
  });
});

describe('one cluster', () => {
  it('computes the mix-matched null from the SAME rows', () => {
    // 90 BUY (30 win / 60 loss) + 10 SELL (6 win / 4 loss).
    const c = clusterEdgeOf('2026-09-01', rowsFor('2026-09-01', 30, 60, 6, 4))!;
    expect(c.n).toBe(100);
    expect(c.dwr).toBeCloseTo(0.36, 10);
    expect(c.pLong).toBeCloseTo(0.34, 10);   // uppers 30 + 4
    expect(c.pShort).toBeCloseTo(0.66, 10);  // lowers 60 + 6
    expect(c.q).toBeCloseTo(0.9, 10);
    expect(c.pStar).toBeCloseTo(0.9 * 0.34 + 0.1 * 0.66, 10);
    expect(c.excessPp).toBeCloseTo(-1.2, 8);
  });

  it('DIVERGES 28.8 pp from max(alwaysBUY, alwaysSELL) on that same cluster', () => {
    // THE COMPARATOR DEFECT, in one number. On a down day a 90%-BUY engine is charged the
    // always-SELL rate it never had the option of earning: max-naive says -30.0 pp, the
    // mix-matched null says -1.2 pp. `max()` is also SELECTION-COUPLED — it silently changes
    // WHICH quantity it names as the up-rate crosses 0.5, so the same code reports a different
    // statistic on an up day.
    const c = clusterEdgeOf('2026-09-01', rowsFor('2026-09-01', 30, 60, 6, 4))!;
    const maxNaivePp = 100 * (c.dwr - Math.max(c.pLong, c.pShort));
    expect(maxNaivePp).toBeCloseTo(-30, 8);
    expect(c.excessPp - maxNaivePp).toBeCloseTo(28.8, 8);
  });

  it('excludes timeouts from BOTH sides of the subtraction', () => {
    const withT = clusterEdgeOf('2026-09-01', rowsFor('2026-09-01', 30, 60, 6, 4, 250))!;
    const without = clusterEdgeOf('2026-09-01', rowsFor('2026-09-01', 30, 60, 6, 4))!;
    expect(withT.n).toBe(without.n);
    expect(withT.excessPp).toBeCloseTo(without.excessPp, 12);
  });

  it('gives a one-sided cluster an excess of EXACTLY zero — the marginal bound, not a bug', () => {
    // At q = 1 the null IS always-BUY, so the engine cannot deviate from it by any amount. This
    // is the same capacity ceiling the identifiability refusal exists for, at its extreme, and
    // it is why a 94%-BUY corpus can only ever show a small excess.
    const c = clusterEdgeOf('2026-09-01', rowsFor('2026-09-01', 30, 70, 0, 0))!;
    expect(c.q).toBe(1);
    expect(c.excessPp).toBeCloseTo(0, 12);
  });

  it('returns null for a cluster with no scored rows rather than a plausible zero', () => {
    expect(clusterEdgeOf('2026-09-01', rowsFor('2026-09-01', 0, 0, 0, 0, 40))).toBeNull();
  });
});

describe('across clusters', () => {
  /** 20 good days of 40 rows (+25 pp each) plus one huge bad day of 2,000 rows (-30 pp). */
  const skewed = (): LabelRow[] => {
    const rows: LabelRow[] = [];
    for (let i = 1; i <= 20; i++) rows.push(...rowsFor(day(i), 15, 5, 15, 5));
    rows.push(...rowsFor(day(21), 200, 800, 200, 800));
    return rows;
  };

  it('POOLING FLIPS THE SIGN — the finding this module exists for', () => {
    const s = clusterEdge(skewed());
    expect(s.verdict).toBe('PER_CLUSTER');
    expect(s.clusters).toBe(21);
    expect(s.meanPp).toBeCloseTo((20 * 25 - 30) / 21, 8); // +22.38 pp
    expect(s.meanPp!).toBeGreaterThan(0);

    // The same rows in ONE cluster — i.e. what pooling does — go the other way.
    const pooled = clusterEdgeOf('pooled', skewed().map((r) => ({ ...r, createdAt: at(day(1)) })))!;
    expect(pooled.excessPp).toBeCloseTo(-14.2857, 3);
    expect(pooled.excessPp).toBeLessThan(0);
  });

  it('reports the spread beside the mean', () => {
    const s = clusterEdge(skewed());
    // 20 clusters at +25 and one at -30: the sd is large, and publishing the mean without it
    // would read as a conclusion. Measured on the live corpus the sd is 19x the mean.
    expect(s.sdPp!).toBeGreaterThan(10);
  });

  it('drops under-sized clusters, COUNTS them, and never hides them in the mean', () => {
    const rows = [...skewed(), ...rowsFor(day(22), 5, 5, 5, 5)]; // n = 20 < 30
    const s = clusterEdge(rows);
    expect(s.clusters).toBe(21);
    expect(s.clustersDropped).toBe(1);
    expect(s.rowsInClusters).toBe(20 * 40 + 2000);
    expect(MIN_ROWS_PER_CLUSTER).toBe(30);
  });

  it('is INDETERMINATE below min_clusters, with a null mean and a stated reason', () => {
    const rows: LabelRow[] = [];
    for (let i = 1; i <= 19; i++) rows.push(...rowsFor(day(i), 15, 5, 15, 5));
    const s = clusterEdge(rows);
    expect(s.verdict).toBe('INDETERMINATE');
    expect(s.meanPp).toBeNull();
    expect(s.sdPp).toBeNull();
    expect(s.clusters).toBe(19);
    expect(s.reason).toContain('under-clustered');
  });

  it('clusters on the UTC day, not the local one', () => {
    // 23:30Z on the 1st and 00:30Z on the 2nd are DIFFERENT clusters, whatever the reader's TZ.
    expect(utcDayOf(Math.floor(Date.parse('2026-09-01T23:30:00Z') / 1000))).toBe('2026-09-01');
    expect(utcDayOf(Math.floor(Date.parse('2026-09-02T00:30:00Z') / 1000))).toBe('2026-09-02');
  });
});
