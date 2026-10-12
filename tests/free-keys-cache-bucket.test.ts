/**
 * GROWTH-AGENT-SIGNIN-STEPUP-W1-V2 R2.3 — every free-key cache write carries `bucket_key`.
 *
 * `mintFreeKey` and `mergeEphemeralIntoEmail` cached `{api_key, email, ref_code}` and dropped the
 * row's `bucket_key`, so for up to the 5-minute TTL after a claim or a re-mint the sync lookup — and
 * every async lookup that hit the cache — saw a PROMOTED key with no bucket, and the meter charged
 * the key itself: a fresh allowance for the one caller the claim path exists to keep on its bucket.
 * Real SQLite store, like tests/free-keys-ephemeral.test.ts; skipped on the Postgres lane.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mintEphemeralKey, mergeEphemeralIntoEmail, mintFreeKey, lookupFreeKeyCached,
  ensureFreeKeysSchema, _resetFreeKeyCacheForTest,
} from '../src/lib/free-keys-store.js';
import { dbRun } from '../src/lib/performance-db.js';

const SKIP = process.env.DATABASE_URL ? 'DATABASE_URL set — skip local SQLite test' : '';
const d = SKIP ? describe.skip : describe;
const DOM = '@cache-bucket-test.local';
const created: string[] = [];

d('free-keys cache carries bucket_key on every write', () => {
  beforeAll(async () => {
    ensureFreeKeysSchema();
    _resetFreeKeyCacheForTest();
    await new Promise((r) => setTimeout(r, 0)); // the bucket_key column add is fire-and-forget
  });
  afterAll(() => {
    for (const k of created) { try { dbRun('DELETE FROM free_keys WHERE api_key = ?', k); } catch { /* ignore */ } }
    try { dbRun('DELETE FROM free_keys WHERE email LIKE ?', `%${DOM}`); } catch { /* ignore */ }
  });

  it('a claim that PROMOTES the ephemeral in place keeps its adopted bucket in the cache', async () => {
    const eph = await mintEphemeralKey(null, 'v2:cache-bucket-1'); created.push(eph);
    expect(lookupFreeKeyCached(eph)?.bucket_key).toBe('free:v2:cache-bucket-1');
    const key = await mergeEphemeralIntoEmail(eph, `promote${DOM}`);
    expect(key).toBe(eph);
    const row = lookupFreeKeyCached(eph);
    expect(row?.email).toBe(`promote${DOM}`);
    expect(row?.bucket_key).toBe('free:v2:cache-bucket-1');
  });

  it('a later sign-in that RE-MINTS the promoted key returns it with its bucket, not a bucket-less row', async () => {
    const eph = await mintEphemeralKey(null, 'v2:cache-bucket-2'); created.push(eph);
    await mergeEphemeralIntoEmail(eph, `remint${DOM}`);
    _resetFreeKeyCacheForTest();
    const again = await mintFreeKey(`remint${DOM}`);
    expect(again).toBe(eph);
    expect(lookupFreeKeyCached(eph)?.bucket_key).toBe('free:v2:cache-bucket-2');
  });

  it('merging into an EXISTING email caches that key with ITS bucket (none) — no adoption is invented', async () => {
    const existing = await mintFreeKey(`existing${DOM}`); created.push(existing);
    const eph = await mintEphemeralKey(null, 'v2:cache-bucket-3'); created.push(eph);
    const key = await mergeEphemeralIntoEmail(eph, `existing${DOM}`);
    expect(key).toBe(existing);
    const row = lookupFreeKeyCached(existing);
    expect(row).not.toBeNull();
    expect(row?.bucket_key ?? null).toBeNull();
  });

  it('a brand-new email key is cached with an explicit null bucket', async () => {
    const key = await mintFreeKey(`fresh${DOM}`); created.push(key);
    const row = lookupFreeKeyCached(key);
    expect(row).not.toBeNull();
    expect(row && 'bucket_key' in row).toBe(true);
    expect(row?.bucket_key).toBeNull();
  });
});
