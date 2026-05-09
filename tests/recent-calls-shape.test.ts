/**
 * LANDING-LIVE-CALL-TICKER-W1 — formatRecentCallRow + clampRecentCallsLimit tests.
 *
 * The /api/recent-calls endpoint MUST sanitize DB rows so no Phase-E /
 * outcome / Merkle / internal fields leak to the public ticker. These
 * tests target the pure formatter (extracted for testability) so we can
 * assert the exact public shape without ESM-mock gymnastics:
 *   {slug, exchange, timeframe, call, confidence, created_at_iso, seconds_ago}
 *
 * Companion no-data-loss snapshot lives at
 * `audits/recent-calls-public-shape-snapshot-2026-05-09.json` — any future
 * key addition must update both the snapshot AND this test.
 */

import { describe, expect, it } from 'vitest';
import {
  clampRecentCallsLimit,
  formatRecentCallRow,
  type RecentCallDbRow,
} from '../src/lib/performance-db.js';

const FIXED_NOW_SEC = 1_778_400_000;

describe('formatRecentCallRow — public response shape', () => {
  it('renames coin→slug, signal→call; converts created_at→ISO; computes seconds_ago', () => {
    const row: RecentCallDbRow = {
      coin: 'BTC',
      exchange: 'BINANCE',
      timeframe: '15m',
      signal: 'BUY',
      confidence: 67,
      created_at: FIXED_NOW_SEC - 12,
    };
    const out = formatRecentCallRow(row, FIXED_NOW_SEC);
    expect(out.slug).toBe('BTC');
    expect(out.exchange).toBe('BINANCE');
    expect(out.timeframe).toBe('15m');
    expect(out.call).toBe('BUY');
    expect(out.confidence).toBe(67);
    expect(out.created_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(out.seconds_ago).toBe(12);
  });

  it('exposes ONLY the 7 public keys — drops id/tier/outcome_*/pfe_*/mae_*/price_*/merkle_*', () => {
    const row = {
      coin: 'ETH',
      exchange: 'OKX',
      timeframe: '1h',
      signal: 'SELL',
      confidence: 82,
      created_at: FIXED_NOW_SEC - 5,
      // Extra DB fields that MUST be dropped:
      id: 999_999,
      tier: 1,
      outcome_return_pct: 1.23,
      outcome_price: 3000,
      pfe_return_pct: 1.5,
      mae_return_pct: -0.3,
      signal_hash: '0xdeadbeef',
      merkle_batch_id: 42,
      price_at_signal: 2999.5,
    } as unknown as RecentCallDbRow;
    const out = formatRecentCallRow(row, FIXED_NOW_SEC);
    const keys = Object.keys(out).sort();
    expect(keys).toEqual(
      ['call', 'confidence', 'created_at_iso', 'exchange', 'seconds_ago', 'slug', 'timeframe'].sort(),
    );
    const o = out as Record<string, unknown>;
    expect(o.id).toBeUndefined();
    expect(o.tier).toBeUndefined();
    expect(o.outcome_return_pct).toBeUndefined();
    expect(o.outcome_price).toBeUndefined();
    expect(o.pfe_return_pct).toBeUndefined();
    expect(o.mae_return_pct).toBeUndefined();
    expect(o.signal_hash).toBeUndefined();
    expect(o.merkle_batch_id).toBeUndefined();
    expect(o.price_at_signal).toBeUndefined();
  });

  it('falls back to "HL" when exchange is null in DB row', () => {
    const out = formatRecentCallRow(
      { coin: 'XYZ', exchange: null, timeframe: '5m', signal: 'HOLD', confidence: 30, created_at: FIXED_NOW_SEC },
      FIXED_NOW_SEC,
    );
    expect(out.exchange).toBe('HL');
    expect(out.seconds_ago).toBe(0);
  });

  it('never returns negative seconds_ago even when DB clock drifts ahead of server', () => {
    const out = formatRecentCallRow(
      { coin: 'BTC', exchange: 'HL', timeframe: '5m', signal: 'BUY', confidence: 50, created_at: FIXED_NOW_SEC + 30 },
      FIXED_NOW_SEC,
    );
    expect(out.seconds_ago).toBe(0);
  });
});

describe('clampRecentCallsLimit — cap enforcement', () => {
  it('clamps above 10 down to 10', () => {
    expect(clampRecentCallsLimit(50)).toBe(10);
    expect(clampRecentCallsLimit(11)).toBe(10);
  });

  it('clamps below 1 up to 1', () => {
    expect(clampRecentCallsLimit(0)).toBe(1);
    expect(clampRecentCallsLimit(-7)).toBe(1);
  });

  it('truncates non-integer down', () => {
    expect(clampRecentCallsLimit(3.9)).toBe(3);
    expect(clampRecentCallsLimit(1.1)).toBe(1);
  });

  it('passes through valid 1..10 values', () => {
    for (const n of [1, 2, 5, 9, 10]) {
      expect(clampRecentCallsLimit(n)).toBe(n);
    }
  });
});
