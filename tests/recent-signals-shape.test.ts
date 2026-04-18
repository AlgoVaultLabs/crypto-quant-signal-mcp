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

describe('recentSignals shape', () => {
  beforeEach(() => {
    seedSignals();
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

  it('includes expected public fields (coin, signal, confidence, timeframe, tier, exchange, created_at)', async () => {
    const stats = await perfDb.getPerformanceStatsAsync();
    for (const s of stats.recentSignals) {
      expect(typeof s.coin).toBe('string');
      expect(typeof s.signal).toBe('string');
      expect(typeof s.confidence).toBe('number');
      expect(typeof s.timeframe).toBe('string');
      expect(typeof s.tier).toBe('number');
      expect(typeof s.exchange).toBe('string');
      expect(typeof s.created_at).toBe('number');
    }
  });
});
