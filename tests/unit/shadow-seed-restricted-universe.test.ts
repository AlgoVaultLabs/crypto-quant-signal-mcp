/**
 * Unit tests for SHADOW-SEED-W1 restricted-universe resolver in
 * src/scripts/seed-signals.ts.
 *
 * The resolver pulls the top-N coins by historical call-count from
 * `byAsset` aggregation. Used by 1m + 3m shadow-mode crons to bound
 * CPX22 load — instead of seeding the full per-exchange universe, we
 * seed only the assets users actually call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock signal-performance to control byAsset payload deterministically
vi.mock('../../src/resources/signal-performance.js', () => ({
  getSignalPerformance: vi.fn(),
}));

import { getRestrictedUniverse, _resetRestrictedUniverseCache, SHADOW_TIMEFRAMES } from '../../src/scripts/seed-signals.js';
import { getSignalPerformance } from '../../src/resources/signal-performance.js';

describe('SHADOW-SEED-W1: getRestrictedUniverse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRestrictedUniverseCache();
  });

  it('returns top-5 by call-count (1m universe size)', async () => {
    vi.mocked(getSignalPerformance).mockResolvedValue({
      totalCalls: 100,
      period: { from: '2026-04-23', to: '2026-04-30' },
      overall: { totalCalls: 100, totalEvaluated: 100, pfeWinRate: 0.9 },
      byCallType: {},
      byTimeframe: {},
      byExchange: {},
      byAsset: {
        TAO:   { count: 1233, tier: 2, pfeWinRate: 0.9 },
        ETH:   { count: 1134, tier: 1, pfeWinRate: 0.9 },
        BTC:   { count: 970,  tier: 1, pfeWinRate: 0.9 },
        RAVE:  { count: 946,  tier: 4, pfeWinRate: 0.9 },
        SOL:   { count: 915,  tier: 2, pfeWinRate: 0.9 },
        RIVER: { count: 792,  tier: 4, pfeWinRate: 0.9 },
        ASTER: { count: 787,  tier: 4, pfeWinRate: 0.9 },
      },
      byTier: {},
    } as any);

    const top5 = await getRestrictedUniverse(5);
    expect(top5).toEqual(['TAO', 'ETH', 'BTC', 'RAVE', 'SOL']);
    expect(top5.length).toBe(5);
  });

  it('returns top-20 by call-count (3m universe size)', async () => {
    const fixture: Record<string, { count: number }> = {};
    // Synthesize 25 coins with monotonic decreasing counts
    for (let i = 1; i <= 25; i++) {
      fixture[`COIN${i}`] = { count: 100 - i };
    }
    vi.mocked(getSignalPerformance).mockResolvedValue({
      byAsset: fixture,
    } as any);

    const top20 = await getRestrictedUniverse(20);
    expect(top20.length).toBe(20);
    expect(top20[0]).toBe('COIN1');   // highest count
    expect(top20[19]).toBe('COIN20'); // 20th
    expect(top20).not.toContain('COIN21');
    expect(top20).not.toContain('COIN25');
  });

  it('falls back to hardcoded majors when byAsset is empty', async () => {
    vi.mocked(getSignalPerformance).mockResolvedValue({
      byAsset: {},
    } as any);
    const top5 = await getRestrictedUniverse(5);
    expect(top5).toEqual(['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
  });

  it('falls back to hardcoded majors when getSignalPerformance throws', async () => {
    vi.mocked(getSignalPerformance).mockRejectedValue(new Error('DB unavailable'));
    const top5 = await getRestrictedUniverse(5);
    expect(top5).toEqual(['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
  });

  it('caches results within the 5-min TTL window', async () => {
    vi.mocked(getSignalPerformance).mockResolvedValue({
      byAsset: { BTC: { count: 100 }, ETH: { count: 90 }, SOL: { count: 80 } },
    } as any);

    const first = await getRestrictedUniverse(3);
    const second = await getRestrictedUniverse(3);
    expect(first).toEqual(second);
    expect(vi.mocked(getSignalPerformance)).toHaveBeenCalledTimes(1);
  });

  it('refreshes cache when a different topN is requested', async () => {
    vi.mocked(getSignalPerformance).mockResolvedValue({
      byAsset: { BTC: { count: 100 }, ETH: { count: 90 }, SOL: { count: 80 } },
    } as any);

    await getRestrictedUniverse(2);
    await getRestrictedUniverse(3);
    expect(vi.mocked(getSignalPerformance)).toHaveBeenCalledTimes(2);
  });
});

describe('SHADOW-SEED-W1: SHADOW_TIMEFRAMES export', () => {
  it('contains exactly 1m and 3m', () => {
    expect(SHADOW_TIMEFRAMES).toEqual(['1m', '3m']);
  });
});
