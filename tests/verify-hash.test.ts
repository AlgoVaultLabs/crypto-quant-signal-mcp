/**
 * WEBHOOK-HARDENING-W1 C3 — /verify?hash= data layer (getSignalByHash).
 *
 * The HTTP route builds its response straight from getSignalByHash, so the
 * data-layer projection IS the public allow-list. This asserts the public
 * fields are present (incl. regime + exchange added for the verify view) and
 * that NO forbidden Phase-E key can appear. SQLite temp-HOME harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };
const FORBIDDEN = /^(outcome_|pfe_|mae_|return_pct_|price_after_)/;
const KNOWN_HASH = '0x' + 'a'.repeat(64);

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-verify-hash-'));
  process.env.HOME = tempHome; process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
});
afterEach(() => {
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL.HOME!;
  if (ORIGINAL.USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL.USERPROFILE; else delete process.env.USERPROFILE;
  if (ORIGINAL.DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL.DATABASE_URL;
});

async function seedBatchedSignal() {
  // Merkle batch + a signal linked to it with a known hash.
  await perfDb.dbQuery(
    `INSERT INTO merkle_batches (batch_id, merkle_root, signal_count, tx_hash, block_number, published_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING batch_id`,
    [1, '0x' + 'b'.repeat(64), 5, '0x' + 'c'.repeat(64), '12345678', '2026-05-29T00:05:00Z'],
  );
  await perfDb.dbQuery(
    `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, signal_hash, regime, merkle_batch_id, merkle_proof,
                          outcome_return_pct, pfe_return_pct, mae_return_pct, return_pct_1h, price_after_1h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ['BTC', 'BUY', 72, '1h', 'HL', 95000, 1_700_000_000, KNOWN_HASH, 'TRENDING_UP', 1, JSON.stringify(['0x' + 'd'.repeat(64)]),
     // Phase-E columns populated — MUST NOT surface in getSignalByHash:
     4.2, 6.1, -1.3, 0.9, 96000],
  );
}

describe('getSignalByHash', () => {
  it('returns the public verification fields incl regime + exchange', async () => {
    await seedBatchedSignal();
    const s = await perfDb.getSignalByHash(KNOWN_HASH);
    expect(s).not.toBeNull();
    expect(s.coin).toBe('BTC');
    expect(s.signal).toBe('BUY');
    expect(s.confidence).toBe(72);
    expect(s.timeframe).toBe('1h');
    expect(s.exchange).toBe('HL');         // added for verify view
    expect(s.regime).toBe('TRENDING_UP');  // added for verify view
    expect(Number(s.price_at_signal)).toBe(95000);
    expect(s.signal_hash).toBe(KNOWN_HASH);
    expect(Number(s.merkle_batch_id)).toBe(1);
    expect(s.merkle_root).toBe('0x' + 'b'.repeat(64));
  });

  it('exposes ZERO forbidden Phase-E keys (data-layer allow-list canary)', async () => {
    await seedBatchedSignal();
    const s = await perfDb.getSignalByHash(KNOWN_HASH);
    const offending = Object.keys(s).filter((k) => FORBIDDEN.test(k));
    expect(offending).toEqual([]);
    // belt-and-suspenders: serialized form carries none either
    const serialized = JSON.stringify(s);
    for (const k of ['outcome_return_pct', 'pfe_', 'mae_', 'return_pct_', 'price_after_']) {
      expect(serialized.includes(k), k).toBe(false);
    }
  });

  it('returns null for an unknown hash', async () => {
    await seedBatchedSignal();
    expect(await perfDb.getSignalByHash('0x' + 'f'.repeat(64))).toBeNull();
  });
});
