/**
 * Unit tests for DASH-W1-FIX-2: getTop20ByOI fallback behavior.
 *
 * Bug context: container restart during a HL 429-rate-limit window left
 * `cachedTop20` empty + every fetch attempt blocked by HL. The catch block
 * pre-fix returned `new Set()` (empty), which silently misclassified ALL
 * non-BTC/ETH non-TradFi non-meme alts as Tier 4 — hiding the Major Alts
 * panel from the dashboard.
 *
 * Fix: stale-cache fallback first, then static FALLBACK_TOP20 as last
 * resort.
 *
 * Test matrix:
 *   1. Healthy fetch → returns live top-20 (filtered for tier-eligibility)
 *   2. Stale cache + fetch fails → returns stale cache (NOT empty Set)
 *   3. No cache + fetch fails (cold-start during HL 429) → returns
 *      FALLBACK_TOP20 (NOT empty Set) so dashboard Tier 2 stays populated
 *   4. FALLBACK_TOP20 contains canonical major alts (regression guard
 *      against accidentally emptying the static list)
 *
 * Tests use `vi.mock('./oi-ranking')` to control the underlying HL fetch
 * outcome; the in-memory `cachedTop20` is cleared via the `_clearTop20Cache`
 * test seam between tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock oi-ranking so we can control the inner fetch outcome
vi.mock('../../src/lib/oi-ranking.js', () => ({
  getTopAssetsByOI: vi.fn(),
}));

import { getTopAssetsByOI } from '../../src/lib/oi-ranking.js';
import {
  getTop20ByOI,
  _clearTop20Cache,
  _getFallbackTop20,
} from '../../src/lib/asset-tiers.js';

describe('DASH-W1-FIX-2: getTop20ByOI fallback behavior', () => {
  beforeEach(() => {
    _clearTop20Cache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: Healthy fetch → returns live top-20 (filtered) ──
  it('healthy fetch: returns live top-20 with TIER_1/MEME_KNOWN/TradFi filtered out', async () => {
    vi.mocked(getTopAssetsByOI).mockResolvedValueOnce([
      { coin: 'BTC',  notionalOI: 1e10, markPx: 1, openInterest: 1 }, // TIER_1 — filtered
      { coin: 'ETH',  notionalOI: 5e9,  markPx: 1, openInterest: 1 }, // TIER_1 — filtered
      { coin: 'SOL',  notionalOI: 1e9,  markPx: 1, openInterest: 1 }, // ✓ Tier 2
      { coin: 'DOGE', notionalOI: 5e8,  markPx: 1, openInterest: 1 }, // MEME_KNOWN — filtered
      { coin: 'BNB',  notionalOI: 4e8,  markPx: 1, openInterest: 1 }, // ✓ Tier 2
      { coin: 'XRP',  notionalOI: 3e8,  markPx: 1, openInterest: 1 }, // ✓ Tier 2
      { coin: 'TSLA', notionalOI: 2e8,  markPx: 1, openInterest: 1 }, // TradFi — filtered
    ]);

    const top20 = await getTop20ByOI();
    expect(top20.has('SOL')).toBe(true);
    expect(top20.has('BNB')).toBe(true);
    expect(top20.has('XRP')).toBe(true);
    // TIER_1 / MEME_KNOWN / TradFi must be filtered
    expect(top20.has('BTC')).toBe(false);
    expect(top20.has('ETH')).toBe(false);
    expect(top20.has('DOGE')).toBe(false);
    expect(top20.has('TSLA')).toBe(false);

    // Subsequent call within TTL is served from cache
    expect(getTopAssetsByOI).toHaveBeenCalledTimes(1);
    await getTop20ByOI();
    expect(getTopAssetsByOI).toHaveBeenCalledTimes(1); // still 1 — cache hit
  });

  // ── Test 2: Stale cache + fetch fails → returns stale cache (NOT empty) ──
  it('stale cache + fetch fails: returns stale cache rather than empty Set', async () => {
    // First call: healthy fetch populates cache
    vi.mocked(getTopAssetsByOI).mockResolvedValueOnce([
      { coin: 'SOL', notionalOI: 1e9, markPx: 1, openInterest: 1 },
      { coin: 'BNB', notionalOI: 5e8, markPx: 1, openInterest: 1 },
    ]);
    const fresh = await getTop20ByOI();
    expect(fresh.has('SOL')).toBe(true);
    expect(fresh.has('BNB')).toBe(true);

    // Force cache "stale" by advancing Date.now past the 1h TTL
    const realNow = Date.now;
    const fakeNow = realNow() + 2 * 3_600_000; // +2 hours
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    // Make fetch fail — should fall back to STALE cache (not empty)
    vi.mocked(getTopAssetsByOI).mockRejectedValueOnce(new Error('HL 429'));

    const stale = await getTop20ByOI();
    // CRITICAL: must be the stale cache content, NOT empty Set, NOT FALLBACK_TOP20
    expect(stale.has('SOL')).toBe(true);
    expect(stale.has('BNB')).toBe(true);
    expect(stale.size).toBe(2); // exactly what we cached, not the larger FALLBACK
  });

  // ── Test 3: No cache + fetch fails (cold-start during 429) → FALLBACK_TOP20 ──
  it('cold-start during HL 429: returns FALLBACK_TOP20 rather than empty Set', async () => {
    // No prior successful fetch — cache is empty (cleared in beforeEach)
    vi.mocked(getTopAssetsByOI).mockRejectedValueOnce(new Error('HL 429'));

    // Suppress the warn log for clean test output
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fallback = await getTop20ByOI();
    // CRITICAL: must NOT be empty Set
    expect(fallback.size).toBeGreaterThan(0);
    // Must equal FALLBACK_TOP20 (the static last-resort list)
    const expectedFallback = _getFallbackTop20();
    expect(fallback).toBe(expectedFallback);
    // Spot-check: canonical major alts MUST be in fallback
    expect(fallback.has('SOL')).toBe(true);
    expect(fallback.has('BNB')).toBe(true);
    expect(fallback.has('XRP')).toBe(true);
    expect(fallback.has('AVAX')).toBe(true);
  });

  // ── Test 4: FALLBACK_TOP20 regression guard — canonical alts must stay listed ──
  it('FALLBACK_TOP20 contains canonical major alts (regression guard)', () => {
    const fallback = _getFallbackTop20();
    // The 10 most liquid HL alts that have ALWAYS been in top-20 by OI
    // since the multi-exchange expansion. Removing any of these from the
    // fallback list would silently degrade Tier 2 coverage during outages.
    const mustHave = ['SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'AAVE', 'NEAR', 'SUI', 'APT'];
    for (const coin of mustHave) {
      expect(fallback.has(coin), `FALLBACK_TOP20 missing ${coin}`).toBe(true);
    }
    // Sanity bound
    expect(fallback.size).toBeGreaterThanOrEqual(15);
    expect(fallback.size).toBeLessThanOrEqual(50);
  });
});
