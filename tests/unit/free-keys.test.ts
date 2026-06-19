/**
 * REFERRAL-LIGHT-W1 / C2 — free-keys store invariants.
 * av_free_ shape, idempotent-on-email mint, async lookup (cache → DB), and the
 * sync cache-only lookup (stdio path). No Stripe import (gate-asserted separately).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Isolate this file's SQLite DB: set a unique temp HOME BEFORE the store imports
// load (vi.hoisted runs ahead of imports) so performance-db computes DB_DIR
// (~/.crypto-quant-signal/performance.db) against it. Eliminates cross-file DELETE
// collisions on the shared referral tables in the full parallel suite.
vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-freekeys-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
});

import {
  ensureFreeKeysSchema,
  mintFreeKey,
  lookupFreeKey,
  lookupFreeKeyCached,
  FREE_KEY_PREFIX,
  _resetFreeKeyCacheForTest,
} from '../../src/lib/free-keys-store.js';

beforeEach(() => {
  ensureFreeKeysSchema();
  _resetFreeKeyCacheForTest();
});

describe('mintFreeKey', () => {
  it('mints an av_free_ + 24-hex key', async () => {
    const k = await mintFreeKey('a@x.com', 'REFCODE1');
    expect(k.startsWith(FREE_KEY_PREFIX)).toBe(true);
    expect(k).toMatch(/^av_free_[0-9a-f]{24}$/);
  });
  it('is idempotent on email (one free key per human)', async () => {
    const k1 = await mintFreeKey('dup@x.com', 'R1');
    const k2 = await mintFreeKey('dup@x.com', 'R2');
    expect(k1).toBe(k2);
  });
});

describe('lookupFreeKey (async: cache → DB)', () => {
  it('returns the row for a known key', async () => {
    const k = await mintFreeKey('look@x.com', 'RCODE');
    const row = await lookupFreeKey(k);
    expect(row?.email).toBe('look@x.com');
    expect(row?.ref_code).toBe('RCODE');
  });
  it('returns null for an unknown av_free_ key', async () => {
    expect(await lookupFreeKey(`av_free_${'0'.repeat(24)}`)).toBeNull();
  });
  it('returns null (no DB touch) for a non-prefixed key', async () => {
    expect(await lookupFreeKey('av_live_whatever')).toBeNull();
  });
});

describe('lookupFreeKeyCached (sync, cache-only)', () => {
  it('hits the cache after a mint', async () => {
    const k = await mintFreeKey('cache@x.com');
    expect(lookupFreeKeyCached(k)?.email).toBe('cache@x.com');
  });
  it('misses (null) when the cache is cold — sync path cannot reach the DB', async () => {
    const k = await mintFreeKey('cold@x.com');
    _resetFreeKeyCacheForTest();
    expect(lookupFreeKeyCached(k)).toBeNull();
  });
});
