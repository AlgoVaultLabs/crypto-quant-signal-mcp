/**
 * Public-shape regression guard for `getPerformanceStatsAsync()`.
 *
 * Asserts:
 *  - every recentSignals[*].id is a number (re-exposed post-L1)
 *  - none of the L1-stripped sensitive fields have leaked back in
 *    (pfe_return_pct, outcome_return_pct, mae_return_pct,
 *     price_at_signal, signal_hash).
 *
 * Isolation pattern mirrors tests/agent-sessions.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-recent-shape-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
});

afterEach(() => {
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  if (ORIGINAL_USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

describe('getPerformanceStatsAsync().recentSignals shape', () => {
  it('every entry has id:number and none of the L1-stripped fields', async () => {
    // Seed 10 fully-populated signals (with outcome + PFE/MAE fields set to
    // known non-null values so we can positively assert they are NOT leaking).
    const now = Math.floor(Date.now() / 1000);
    const coins = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK'];
    for (let i = 0; i < 10; i++) {
      const coin = coins[i % coins.length];
      perfDb.dbRun(
        `INSERT INTO signals
           (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at,
            outcome_price, outcome_return_pct,
            pfe_return_pct, mae_return_pct, pfe_price, mae_price, pfe_candles,
            signal_hash, merkle_batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        coin,
        i % 2 === 0 ? 'BUY' : 'SELL',
        70 + (i % 20),
        '15m',
        'HL',
        100 + i,
        now - i * 60,
        105 + i,
        2.5,
        3.1,
        -0.8,
        107,
        97,
        3,
        '0x' + i.toString(16).padStart(64, '0'),
        1
      );
    }

    const stats = await perfDb.getPerformanceStatsAsync();
    expect(stats.recentSignals.length).toBe(10);

    const forbidden = [
      'pfe_return_pct',
      'outcome_return_pct',
      'mae_return_pct',
      'price_at_signal',
      'signal_hash',
      'merkle_proof',
      'pfe_price',
      'mae_price',
      'pfe_candles',
      'return_1candle',
      'price_after_15m',
      'price_after_1h',
      'price_after_4h',
      'price_after_24h',
    ];

    for (const s of stats.recentSignals) {
      expect(typeof s.id).toBe('number');
      expect(Number.isFinite(s.id)).toBe(true);
      const keys = Object.keys(s);
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
      // Positive-assert the documented public shape exactly
      expect(keys.sort()).toEqual([
        'coin',
        'confidence',
        'created_at',
        'exchange',
        'id',
        'signal',
        'tier',
        'timeframe',
      ]);
    }
  });
});
