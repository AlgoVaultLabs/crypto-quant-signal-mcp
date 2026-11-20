// OPS-PERFSTATS-SWR-W1 — rollupStats must read each group's grouping keys O(1) times, not O(keys) times.
//
// The bug class: a per-key `groups.filter(g => g.coin === coin)` inside a loop over the distinct coins
// is O(coins × groups). At production shape (2,836 coins × 85,036 groups) that was ≈ 241M predicate
// calls — a 4–8 s synchronous block of the serving event loop on EVERY perf-stats refresh, holding every
// request that arrived during it (measured on signal-1 2026-11-20; the triggering perf-public reader was
// released by stale-while-revalidate, the next one was not). The gate counts reads of `coin`/`exchange`
// through a Proxy, so it is deterministic: no timing, no machine dependence.
import { describe, it, expect } from 'vitest';
import { rollupStats, type StatGroupRow } from '../../src/lib/performance-db.js';
import { productionShapedGroups } from '../fixtures/perf-stats-groups.js';

/** Wrap each row so reads of the grouping keys are counted; values pass through untouched. */
function countKeyReads(groups: StatGroupRow[]): { rows: StatGroupRow[]; reads: () => number } {
  let n = 0;
  const rows = groups.map((g) => new Proxy(g, {
    get(t, p, r) {
      if (p === 'coin' || p === 'exchange') n++;
      return Reflect.get(t, p, r);
    },
  }));
  return { rows, reads: () => n };
}

const TOP20 = new Set(['BTC', 'ETH', 'SOL']);
// Measured with the bucketed rollup 2026-11-20: 15.74 / 15.73 / 15.67 reads per row at 100 / 400 / 2,836
// coins (the last at the full 85,036-group shape). 24 is that plus 1.5× headroom for a new breakdown;
// the per-key-filter shape reads ≥ the coin count per row (≥ 100 here), so the two cannot be confused.
const MAX_READS_PER_ROW = 24;

function readsPerRow(coins: number, target: number): number {
  const { groups, period } = productionShapedGroups({ coins, target });
  const { rows, reads } = countKeyReads(groups);
  rollupStats(rows, period, TOP20, [], null);
  return reads() / groups.length;
}

describe('OPS-PERFSTATS-SWR-W1 — rollupStats is linear in the groups', () => {
  it('per-row key reads stay flat as the distinct-coin count quadruples', () => {
    const few = readsPerRow(100, 8000);
    const many = readsPerRow(400, 8000);
    // The O(coins × groups) shape reads ≥ coins per row (≥ 100, then ≥ 400). Linear stays a small constant.
    expect(few).toBeLessThan(MAX_READS_PER_ROW);
    expect(many).toBeLessThan(MAX_READS_PER_ROW);
    expect(many / few).toBeLessThan(1.25);
  });

  it('the counting harness does not perturb the rollup (proxied rows ≡ plain rows)', () => {
    const { groups, period } = productionShapedGroups({ coins: 300, target: 6000 });
    const plain = rollupStats(groups, period, TOP20, [], null);
    const proxied = rollupStats(countKeyReads(groups).rows, period, TOP20, [], null);
    expect(JSON.stringify(proxied)).toBe(JSON.stringify(plain));
  });
});
