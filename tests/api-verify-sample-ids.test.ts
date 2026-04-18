/**
 * Integration test for GET /api/verify-sample-ids.
 *
 * Strategy: since src/index.ts has no exported `createHttpApp`, we mount the
 * exact handler logic (kept in lockstep with the implementation in
 * src/index.ts near the /api/merkle-batches handler) on a test-only express
 * instance, hit it with native fetch, and verify:
 *  - 200 response
 *  - correct shape
 *  - cache hit on the second call (the DB helper is NOT re-invoked —
 *    only the cheap getLatestBatchId path runs).
 *
 * Isolation mirrors tests/agent-sessions.test.ts: redirect HOME to a temp dir
 * before dynamic-importing performance-db so the SQLite file lands in the
 * temp dir and each test gets a fresh DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-api-verify-samples-'));
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

function seedBatch(batchId: number, coinCount = 7, signalsPerBatch = 20): void {
  perfDb.dbRun(
    `INSERT INTO merkle_batches (batch_id, merkle_root, signal_count, tx_hash, block_number)
     VALUES (?, ?, ?, ?, ?)`,
    batchId,
    '0x' + 'a'.repeat(64),
    signalsPerBatch,
    '0x' + 'b'.repeat(64),
    '12345'
  );
  const coins = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'DOGE', 'ARB'].slice(0, coinCount);
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < signalsPerBatch; i++) {
    const coin = coins[i % coins.length];
    perfDb.dbRun(
      `INSERT INTO signals
         (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at,
          signal_hash, merkle_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      coin,
      i % 2 === 0 ? 'BUY' : 'SELL',
      70 + (i % 20),
      '15m',
      'HL',
      100 + i,
      now - i * 60,
      '0x' + (batchId * 1000 + i).toString(16).padStart(64, '0'),
      batchId
    );
  }
}

interface StartedApp {
  url: string;
  stop: () => Promise<void>;
  sampleSpy: ReturnType<typeof vi.fn>;
  latestSpy: ReturnType<typeof vi.fn>;
}

/**
 * Spins up the real handler logic from src/index.ts on an ephemeral port.
 * Wraps the two DB helpers in vi.fn spies so the test can assert cache
 * behaviour.
 */
async function startTestApp(): Promise<StartedApp> {
  const { default: express } = await import('express');

  // Spies wrap the real implementations so the test can observe call counts.
  const latestSpy = vi.fn(async () => perfDb.getLatestBatchId());
  const sampleSpy = vi.fn(async (n: number) => perfDb.getSampleSignalsFromLatestBatch(n));

  const app = express();

  // Mirror of the handler in src/index.ts — keep in lockstep.
  let sampleCache: {
    batchId: number;
    publishedAt: number | null;
    signals: Array<{ id: number; coin: string; signal: string; timeframe: string; confidence: number }>;
  } | null = null;

  app.get('/api/verify-sample-ids', async (_req, res) => {
    try {
      const latestBatchId = await latestSpy();
      if (latestBatchId === null) {
        sampleCache = null;
        return res.json({ batchId: null, publishedAt: null, signals: [] });
      }
      if (sampleCache && sampleCache.batchId === latestBatchId) {
        return res.json(sampleCache);
      }
      const fresh = await sampleSpy(5);
      if (fresh.batchId === null) {
        sampleCache = null;
        return res.json({ batchId: null, publishedAt: null, signals: [] });
      }
      sampleCache = {
        batchId: fresh.batchId,
        publishedAt: fresh.publishedAt,
        signals: fresh.signals,
      };
      res.json(sampleCache);
    } catch {
      res.status(500).json({ error: 'Failed to load sample signal IDs' });
    }
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  const stop = () => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  return { url, stop, sampleSpy, latestSpy };
}

describe('GET /api/verify-sample-ids', () => {
  it('returns 200 with empty shape when DB has no batches', async () => {
    const app = await startTestApp();
    try {
      const res = await fetch(app.url + '/api/verify-sample-ids');
      expect(res.status).toBe(200);
      const body = await res.json() as { batchId: number | null; publishedAt: number | null; signals: unknown[] };
      expect(body).toEqual({ batchId: null, publishedAt: null, signals: [] });
    } finally {
      await app.stop();
    }
  });

  it('returns 200 with correct shape on a seeded DB, and serves cache on second call (no re-query)', async () => {
    const app = await startTestApp();
    try {
      seedBatch(8);

      // Call 1 — cache miss, materializes
      const res1 = await fetch(app.url + '/api/verify-sample-ids');
      expect(res1.status).toBe(200);
      const body1 = await res1.json() as {
        batchId: number;
        publishedAt: number | null;
        signals: Array<{ id: number; coin: string; signal: string; timeframe: string; confidence: number }>;
      };
      expect(body1.batchId).toBe(8);
      expect(body1.signals.length).toBe(5);
      for (const s of body1.signals) {
        expect(typeof s.id).toBe('number');
        expect(typeof s.coin).toBe('string');
        expect(typeof s.signal).toBe('string');
        expect(typeof s.timeframe).toBe('string');
        expect(typeof s.confidence).toBe('number');
        // Security regression guard
        const keys = Object.keys(s).sort();
        expect(keys).toEqual(['coin', 'confidence', 'id', 'signal', 'timeframe']);
      }
      expect(new Set(body1.signals.map(s => s.coin)).size).toBe(5);

      expect(app.latestSpy).toHaveBeenCalledTimes(1);
      expect(app.sampleSpy).toHaveBeenCalledTimes(1);

      // Call 2 — cache hit, sample helper NOT re-invoked
      const res2 = await fetch(app.url + '/api/verify-sample-ids');
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2).toEqual(body1);
      expect(app.latestSpy).toHaveBeenCalledTimes(2); // cheap lookup runs every call
      expect(app.sampleSpy).toHaveBeenCalledTimes(1); // ← key assertion: no re-query
    } finally {
      await app.stop();
    }
  });
});
