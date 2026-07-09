/**
 * FUNNEL-FIX-HUMAN-SIGNUP-W1 — ephemeral key + idempotent merge (DB-backed, local SQLite).
 * Proves: value-before-email key issuance, the three merge cases, IDEMPOTENT + NO double key
 * (AC1), the 7d-sliding reaper, and the ENTITLEMENT INVARIANT (an existing keyed row is
 * untouched by mint/merge of others — AC3). Skipped when DATABASE_URL is set (won't touch PG).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mintEphemeralKey, isEphemeralKey, mergeEphemeralIntoEmail, expireIdleEphemeralKeys,
  mintFreeKey, ensureFreeKeysSchema, _resetFreeKeyCacheForTest,
} from '../src/lib/free-keys-store.js';
import { dbQuery, dbRun } from '../src/lib/performance-db.js';

const SKIP = process.env.DATABASE_URL ? 'DATABASE_URL set — skip local SQLite test' : '';
const d = SKIP ? describe.skip : describe;

const created: string[] = [];
const TEST_EMAIL_DOM = '@ephemeral-test.local';

async function emailOf(key: string): Promise<string | null> {
  const r = await dbQuery<{ email: string | null }>('SELECT email FROM free_keys WHERE api_key = ?', [key]);
  return r.length ? r[0].email : null;
}
async function keyForEmail(email: string): Promise<string | null> {
  const r = await dbQuery<{ api_key: string }>('SELECT api_key FROM free_keys WHERE email = ?', [email]);
  return r.length ? r[0].api_key : null;
}

d('free-keys ephemeral + merge', () => {
  beforeAll(() => { ensureFreeKeysSchema(); _resetFreeKeyCacheForTest(); });
  afterAll(async () => {
    for (const k of created) { try { dbRun('DELETE FROM free_keys WHERE api_key = ?', k); } catch { /* ignore */ } }
    try { dbRun(`DELETE FROM free_keys WHERE email LIKE ?`, `%${TEST_EMAIL_DOM}`); } catch { /* ignore */ }
  });

  it('mintEphemeralKey issues an av_free_ key with NO email (value before email)', async () => {
    const key = await mintEphemeralKey('REF1'); created.push(key);
    expect(key.startsWith('av_free_')).toBe(true);
    expect(await emailOf(key)).toBeNull();
    expect(await isEphemeralKey(key)).toBe(true);
  });

  it('merge with a NEW email PROMOTES the ephemeral in place (same key, now claimed)', async () => {
    const eph = await mintEphemeralKey(); created.push(eph);
    const email = `promote${TEST_EMAIL_DOM}`;
    const key = await mergeEphemeralIntoEmail(eph, email);
    expect(key).toBe(eph); // promoted in place
    expect(await emailOf(eph)).toBe(email);
    expect(await isEphemeralKey(eph)).toBe(false);
  });

  it('merge into an EXISTING email keeps the existing key + deletes the ephemeral (NO double key)', async () => {
    const email = `existing${TEST_EMAIL_DOM}`;
    const existing = await mintFreeKey(email); created.push(existing);
    const eph = await mintEphemeralKey(); created.push(eph);
    const key = await mergeEphemeralIntoEmail(eph, email);
    expect(key).toBe(existing); // returns the existing key
    // the ephemeral row is gone → no double key for this identity
    expect(await emailOf(eph)).toBeNull();
    const rows = await dbQuery<{ api_key: string }>('SELECT api_key FROM free_keys WHERE email = ?', [email]);
    expect(rows.length).toBe(1);
    expect(rows[0].api_key).toBe(existing);
  });

  it('merge is IDEMPOTENT — re-running yields the same key, still one row', async () => {
    const email = `idem${TEST_EMAIL_DOM}`;
    const eph = await mintEphemeralKey(); created.push(eph);
    const k1 = await mergeEphemeralIntoEmail(eph, email);
    const k2 = await mergeEphemeralIntoEmail(eph, email); // re-run (eph already claimed/promoted)
    expect(k2).toBe(k1);
    expect(await keyForEmail(email)).toBe(k1);
  });

  it('reaper deletes an IDLE unclaimed ephemeral but spares a fresh one + any claimed key', async () => {
    // Backdate an unclaimed ephemeral to 10 days idle.
    const stale = `av_free_stale${Date.now().toString(16)}`; created.push(stale);
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    dbRun('INSERT INTO free_keys (api_key, email, created_at, last_used_at) VALUES (?, ?, ?, ?)', stale, null, old, old);
    const fresh = await mintEphemeralKey(); created.push(fresh); // last_used_at NULL, created now
    const claimed = await mintFreeKey(`claimed${TEST_EMAIL_DOM}`); created.push(claimed);
    await expireIdleEphemeralKeys(7);
    expect(await dbQuery('SELECT 1 FROM free_keys WHERE api_key = ?', [stale])).toHaveLength(0); // reaped
    expect(await emailOf(fresh)).toBeNull(); // fresh survives (not idle)
    expect(await isEphemeralKey(fresh)).toBe(true);
    expect(await keyForEmail(`claimed${TEST_EMAIL_DOM}`)).toBe(claimed); // claimed untouched (INVARIANT)
  });
});
