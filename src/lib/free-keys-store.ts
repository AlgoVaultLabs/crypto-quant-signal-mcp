/**
 * REFERRAL-LIGHT-W1 / C2 — free-tier API keys (`av_free_`).
 *
 * Minted ONLY through the referred-signup path (C3). Gives the +500 referral
 * bonus a DURABLE identity to attach to — the free tier was keyless ip-hash (the
 * generator gap). `resolveLicense` routes `av_free_` keys here (NEVER Stripe);
 * the quota meter then keys the tracker by the api key so usage + bonus persist
 * per human. Paid keys (`av_live_`, Stripe-metadata) are untouched.
 *
 * 5-min in-process TTL cache mirrors the stripe.ts key-validation cache: the
 * async HTTP resolution path awaits `lookupFreeKey`; the sync stdio path uses the
 * cache-only `lookupFreeKeyCached` (miss → caller falls back to keyless free).
 * Has NO Stripe import (gate-asserted) — av_free_ keys never reach the Stripe
 * customer lookup.
 */
import { randomBytes } from 'node:crypto';
import { dbExec, dbRun, dbQuery } from './performance-db.js';

const PG = !!process.env.DATABASE_URL;
const TS = PG ? 'TIMESTAMPTZ' : 'TIMESTAMP';
const NOW = PG ? 'now()' : "(datetime('now'))";

export const FREE_KEY_PREFIX = 'av_free_';

const FREE_KEYS_DDL = `
  CREATE TABLE IF NOT EXISTS free_keys (
    api_key TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    ref_code TEXT,
    created_at ${TS} NOT NULL DEFAULT ${NOW},
    last_used_at ${TS}
  );
  CREATE INDEX IF NOT EXISTS idx_free_keys_email ON free_keys (email);
`;

let _initialized = false;
export function ensureFreeKeysSchema(): void {
  if (_initialized) return;
  dbExec(FREE_KEYS_DDL);
  _initialized = true;
}
/** Test seam (module-level-cache reset idiom). */
export function _resetFreeKeysSchemaInitForTest(): void {
  _initialized = false;
}

export interface FreeKeyRow {
  api_key: string;
  email: string | null;
  ref_code: string | null;
}

interface CacheEntry {
  row: FreeKeyRow | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (mirror stripe.ts)

/** Test seam. */
export function _resetFreeKeyCacheForTest(): void {
  cache.clear();
}

function cacheSet(key: string, row: FreeKeyRow | null): void {
  cache.set(key, { row, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** `av_free_` + 24 hex — mirrors stripe.ts generateApiKey shape, distinct prefix. */
function generateFreeKey(): string {
  return `${FREE_KEY_PREFIX}${randomBytes(12).toString('hex')}`;
}

/**
 * Mint (or return the existing) free key for an email. Idempotent on `email`
 * UNIQUE — a re-mint returns the same key (one free key per human). Returns the
 * api key string.
 */
export async function mintFreeKey(email: string, refCode?: string | null): Promise<string> {
  ensureFreeKeysSchema();
  const existing = await dbQuery<{ api_key: string }>(
    'SELECT api_key FROM free_keys WHERE email = ?',
    [email],
  );
  if (existing.length > 0) {
    cacheSet(existing[0].api_key, { api_key: existing[0].api_key, email, ref_code: refCode ?? null });
    return existing[0].api_key;
  }
  const apiKey = generateFreeKey();
  try {
    dbRun('INSERT INTO free_keys (api_key, email, ref_code) VALUES (?, ?, ?)', apiKey, email, refCode ?? null);
  } catch {
    // race on email UNIQUE — return whoever won
    const re = await dbQuery<{ api_key: string }>('SELECT api_key FROM free_keys WHERE email = ?', [email]);
    if (re.length > 0) {
      cacheSet(re[0].api_key, { api_key: re[0].api_key, email, ref_code: refCode ?? null });
      return re[0].api_key;
    }
    throw new Error('mintFreeKey insert failed');
  }
  cacheSet(apiKey, { api_key: apiKey, email, ref_code: refCode ?? null });
  return apiKey;
}

/**
 * Async lookup: cache → DB (negative-caches unknown keys too). Best-effort
 * last_used_at bump. Returns null for a non-prefixed or unknown key.
 */
export async function lookupFreeKey(key: string): Promise<FreeKeyRow | null> {
  if (!key.startsWith(FREE_KEY_PREFIX)) return null;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  ensureFreeKeysSchema();
  const rows = await dbQuery<FreeKeyRow>(
    'SELECT api_key, email, ref_code FROM free_keys WHERE api_key = ?',
    [key],
  );
  const row = rows.length > 0 ? rows[0] : null;
  cacheSet(key, row);
  if (row) {
    try {
      dbRun(`UPDATE free_keys SET last_used_at = ${NOW} WHERE api_key = ?`, key);
    } catch {
      // best-effort — never block resolution on a usage-stamp write
    }
  }
  return row;
}

/**
 * Sync, cache-only lookup (stdio path can't await). A miss returns null so the
 * caller falls back to keyless free — the durable resolution is the async HTTP
 * path, which warms this cache.
 */
export function lookupFreeKeyCached(key: string): FreeKeyRow | null {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  return null;
}

// ── FUNNEL-FIX-HUMAN-SIGNUP-W1: deferred identity (value BEFORE email) ──────────
//
// An EPHEMERAL key is a real av_free_ key with email = NULL: a human gets a working
// key + real value first, hands over an email only later (quota edge / referral /
// persistence). Same per-key 100/mo quota (resolveLicense keys the tracker by the
// key). Claimed via mergeEphemeralIntoEmail (email = identity; idempotent; no double
// key). Idle unclaimed keys are reaped on a 7d SLIDING window (last_used_at bumps on
// every lookupFreeKey). ENTITLEMENT INVARIANT untouched — resolveFromApiKeyAsync +
// existing keys resolve identically; this only ADDS an issuance path.

/** Mint an ephemeral (email-less) free key. Reaps idle ephemerals lazily first. */
export async function mintEphemeralKey(refCode?: string | null): Promise<string> {
  ensureFreeKeysSchema();
  await expireIdleEphemeralKeys().catch(() => { /* never block issuance on a reap */ });
  const apiKey = generateFreeKey();
  dbRun('INSERT INTO free_keys (api_key, email, ref_code) VALUES (?, ?, ?)', apiKey, null, refCode ?? null);
  cacheSet(apiKey, { api_key: apiKey, email: null, ref_code: refCode ?? null });
  return apiKey;
}

/** True if the key exists and is an UNCLAIMED ephemeral (email still NULL). */
export async function isEphemeralKey(key: string): Promise<boolean> {
  if (!key.startsWith(FREE_KEY_PREFIX)) return false;
  ensureFreeKeysSchema();
  const rows = await dbQuery<{ email: string | null }>('SELECT email FROM free_keys WHERE api_key = ?', [key]);
  return rows.length > 0 && rows[0].email === null;
}

/** Best-effort: fold the ephemeral key's quota usage into the claimed key, then drop it. */
async function carryQuotaUsage(fromKey: string, toKey: string): Promise<void> {
  const from = await dbQuery<{ call_count: number | string }>('SELECT call_count FROM quota_usage WHERE tracker_key = ?', [fromKey]);
  const n = Number(from[0]?.call_count ?? 0);
  if (Number.isFinite(n) && n > 0) {
    const to = await dbQuery<{ call_count: number | string }>('SELECT call_count FROM quota_usage WHERE tracker_key = ?', [toKey]);
    if (to.length > 0) dbRun('UPDATE quota_usage SET call_count = call_count + ? WHERE tracker_key = ?', n, toKey);
    // else: the claimed key has no quota row yet → nothing to add to; its next call creates one.
  }
  dbRun('DELETE FROM quota_usage WHERE tracker_key = ?', fromKey);
}

/**
 * Claim an ephemeral key with an email (email = identity). IDEMPOTENT + no double key:
 *  - not an unclaimed ephemeral (missing / already has an email) → return the email's key
 *    (mint if none) — a re-run lands here and is a safe no-op;
 *  - email already owns a key → carry the ephemeral's quota usage into it, delete the
 *    ephemeral, return the existing key;
 *  - email is new → promote the ephemeral in place (set its email), return the same key.
 */
export async function mergeEphemeralIntoEmail(ephemeralKey: string, email: string, refCode?: string | null): Promise<string> {
  ensureFreeKeysSchema();
  const ephRows = await dbQuery<{ email: string | null }>('SELECT email FROM free_keys WHERE api_key = ?', [ephemeralKey]);
  const eph = ephRows[0];
  if (!eph || eph.email !== null) {
    return mintFreeKey(email, refCode); // idempotent: existing key for the email, or a fresh one
  }
  const existingRows = await dbQuery<{ api_key: string }>('SELECT api_key FROM free_keys WHERE email = ?', [email]);
  if (existingRows.length > 0) {
    const existing = existingRows[0].api_key;
    try { await carryQuotaUsage(ephemeralKey, existing); } catch { /* fail-open — never orphan the claim */ }
    dbRun('DELETE FROM free_keys WHERE api_key = ?', ephemeralKey);
    cache.delete(ephemeralKey);
    cacheSet(existing, { api_key: existing, email, ref_code: refCode ?? null });
    return existing;
  }
  dbRun('UPDATE free_keys SET email = ?, ref_code = COALESCE(ref_code, ?) WHERE api_key = ?', email, refCode ?? null, ephemeralKey);
  cacheSet(ephemeralKey, { api_key: ephemeralKey, email, ref_code: refCode ?? null });
  return ephemeralKey;
}

/** Reap idle UNCLAIMED ephemeral keys (email NULL, idle > idleDays; sliding on last_used_at). */
export async function expireIdleEphemeralKeys(idleDays = 7): Promise<number> {
  ensureFreeKeysSchema();
  const cutoff = new Date(Date.now() - idleDays * 24 * 60 * 60 * 1000).toISOString();
  const stale = await dbQuery<{ api_key: string }>(
    `SELECT api_key FROM free_keys WHERE email IS NULL AND COALESCE(last_used_at, created_at) < ?`,
    [cutoff],
  );
  for (const r of stale) { dbRun('DELETE FROM free_keys WHERE api_key = ?', r.api_key); cache.delete(r.api_key); }
  return stale.length;
}
