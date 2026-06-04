/** Unit tests — EQUITIES-ENGINE-W1 C2 universe ranking. */
import { describe, it, expect } from 'vitest';
import { median, buildUniverse } from '../../src/lib/equities/equity-universe-rank.js';

describe('median', () => {
  it('handles odd, even, single, empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBe(0);
  });
  it('is robust to a single spike (vs mean)', () => {
    expect(median([1, 1, 1, 1, 1000])).toBe(1);
  });
});

describe('buildUniverse', () => {
  const dv = new Map<string, number[]>([
    ['AAA', [100, 100, 100]],  // median 100 (rank 1)
    ['BBB', [50, 50, 50]],     // median 50  (rank 2)
    ['CCC', [10, 10, 10]],     // median 10  (rank 3)
    ['DDD', [1, 1, 1]],        // median 1   (below top-2 cutoff)
  ]);

  it('selects top-N by median dollar volume with 1-based ranks', () => {
    const rows = buildUniverse(dv, 2, []);
    const byRank = rows.filter((r) => r.rank_adv !== null).sort((a, b) => a.rank_adv! - b.rank_adv!);
    expect(byRank.map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
    expect(byRank[0].rank_adv).toBe(1);
    expect(byRank[0].adv_usd).toBe(100);
  });

  it('always includes the ETF whitelist even when below the cutoff', () => {
    const rows = buildUniverse(dv, 2, ['DDD']);
    const ddd = rows.find((r) => r.symbol === 'DDD');
    expect(ddd).toBeDefined();
    expect(ddd!.is_etf).toBe(true);
    expect(ddd!.rank_adv).toBeNull();   // not in top-N, included as ETF
    expect(ddd!.adv_usd).toBe(1);
  });

  it('marks a whitelist symbol that also ranks in top-N as is_etf, once', () => {
    const rows = buildUniverse(dv, 2, ['AAA']);
    const aaa = rows.filter((r) => r.symbol === 'AAA');
    expect(aaa).toHaveLength(1);
    expect(aaa[0].is_etf).toBe(true);
    expect(aaa[0].rank_adv).toBe(1);
  });

  it('ignores symbols with no samples', () => {
    const m = new Map<string, number[]>([['ZZZ', []], ['AAA', [5]]]);
    const rows = buildUniverse(m, 10, []);
    expect(rows.map((r) => r.symbol)).toEqual(['AAA']);
  });
});
