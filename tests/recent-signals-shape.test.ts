/**
 * Tests that recentSignals entries from computeStats contain the restored `id`
 * field AND do NOT contain stripped fields (pfe_return_pct, outcome_return_pct,
 * mae_return_pct, price_at_signal, signal_hash). This is a security regression
 * guard: if someone accidentally re-exposes a stripped field, this test catches it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the exchange adapter + performance-db deps that getTradeSignal might need
vi.mock('../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

// We need the REAL performance-db for computeStats — NOT mocked.
// But we do need to redirect HOME so the SQLite lands in a temp dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'cqs-recent-shape-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.DATABASE_URL; // Force SQLite

const perfDb = await import('../src/lib/performance-db.js');

// Insert a few fake signals so computeStats has data
function seedSignals() {
  for (let i = 0; i < 5; i++) {
    perfDb.recordSignal(
      i % 2 === 0 ? 'BTC' : 'ETH',
      i % 3 === 0 ? 'BUY' : 'SELL',
      60 + i,
      '1h',
      30000 + i * 100,
      `hash-${i}`,
      'HL',
      'TRENDING_UP',
    );
  }
}

// OPS-RECENT-SIGNALS-VENUE-FILTER-W1: `recentSignals` is now venue-scoped, and the scope is
// FAIL-CLOSED — an empty `venues` registry admits nothing. This suite seeds rows on `HL`, so it
// must also register HL as promoted; without that the correct new behaviour is ZERO rows and the
// suite would read as a regression. Seeding the registry keeps the test on the REAL path
// (getPerformanceStatsAsync → resolvePublicPerformanceAllowList → listVenues) instead of mocking
// the resolver away, which would stop exercising the thing this wave changed.
async function seedPromotedVenue() {
  const venueStore = await import('../src/lib/venue-store.js');
  await venueStore.initVenuesTable();
  venueStore._resetRetiredCacheForTest();
  // Written with primitives rather than via `insertVenue`, which binds a `Date` and so cannot
  // run on SQLite ("SQLite3 can only bind numbers, strings, bigints, buffers, and null"). That
  // is a pre-existing dual-backend gap in a helper this wave does not own; the READ path under
  // test (listVenues → getActivePromotedVenueIds) is exercised for real either way.
  perfDb.dbRun(
    `INSERT INTO venues (exchange_id, status, asset_count, min_buy_sell_sample, integrated_at, notes)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (exchange_id) DO NOTHING`,
    'HL', 'promoted', 1, 10, new Date().toISOString(), null,
  );
  perfDb._clearPerformanceStatsCache();
}

describe('recentSignals shape', () => {
  beforeEach(async () => {
    seedSignals();
    await seedPromotedVenue();
  });

  it('includes id: number on every entry', async () => {
    const stats = await perfDb.getPerformanceStatsAsync();
    expect(stats.recentSignals.length).toBeGreaterThan(0);
    for (const s of stats.recentSignals) {
      expect(typeof s.id).toBe('number');
      expect(s.id).toBeGreaterThan(0);
    }
  });

  it('does NOT include stripped fields (L1 security contract)', async () => {
    const stats = await perfDb.getPerformanceStatsAsync();
    const FORBIDDEN_KEYS = ['pfe_return_pct', 'outcome_return_pct', 'mae_return_pct', 'price_at_signal', 'signal_hash', 'merkle_proof'];
    for (const s of stats.recentSignals) {
      const keys = Object.keys(s);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it('includes expected public fields (id, coin, tier, timeframe, exchange, created_at)', async () => {
    const stats = await perfDb.getPerformanceStatsAsync();
    for (const s of stats.recentSignals) {
      expect(typeof s.coin).toBe('string');
      // PERFORMANCE-PUBLIC-SANITIZE-W1 (c27bba0, 2026-05-15): recentSignals[] public
      // allow-list is {id, coin, tier, timeframe, exchange, created_at}; call/confidence
      // were stripped from THIS projection (they live on /api/recent-calls).
      expect(typeof s.timeframe).toBe('string');
      expect(typeof s.tier).toBe('number');
      expect(typeof s.exchange).toBe('string');
      expect(typeof s.created_at).toBe('number');
    }
  });
});

// ── OPS-RECENT-SIGNALS-VENUE-FILTER-W1 — the fail-closed direction, on the REAL async path ──
describe('recentSignals venue scope (fail-closed)', () => {
  it('an EMPTY venue registry yields ZERO rows — never a fall-through to unfiltered', async () => {
    seedSignals();
    const venueStore = await import('../src/lib/venue-store.js');
    await venueStore.initVenuesTable();
    try {
      // Empty the registry for this assertion only. The signal pool stays NON-empty, so zero
      // rows is the predicate HOLDING, not an empty input — the distinction the vacuity rule
      // exists for. This is the SV-02 contract (empty ⇒ nothing, never everything) applied to
      // the row lane.
      perfDb.dbRun('DELETE FROM venues');
      venueStore._resetRetiredCacheForTest();
      perfDb._clearPerformanceStatsCache();
      expect((await venueStore.listVenues('promoted')).length).toBe(0);
      const stats = await perfDb.getPerformanceStatsAsync();
      expect(stats.totalCalls, 'the signal pool must be non-empty or this proves nothing')
        .toBeGreaterThan(0);
      expect(stats.recentSignals).toHaveLength(0);
    } finally {
      // Restore, so this test cannot leak into any sibling regardless of ordering.
      await seedPromotedVenue();
      venueStore._resetRetiredCacheForTest();
      perfDb._clearPerformanceStatsCache();
    }
  });
});

