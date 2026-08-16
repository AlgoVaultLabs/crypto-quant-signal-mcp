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

/**
 * OPS-QUOTA-CLAIM-ALIAS-W1 CH1 — the ADOPTED bucket.
 *
 * `bucket_key` is the `free:v2:<hex>` row this key ADOPTS. It is the whole wave in one column:
 * a key carrying one charges that row instead of minting its own, so claiming a key changes WHO
 * the caller is and never HOW MUCH they get.
 *
 * NULLABLE, and that is load-bearing rather than convenient — every key issued before this wave,
 * and every paid key, has no `bucket_key` and therefore resolves byte-identically to today.
 *
 * Added out-of-band rather than in FREE_KEYS_DDL because `CREATE TABLE IF NOT EXISTS` is a NO-OP
 * on an existing table: shipping the column inside the DDL would create it on fresh databases
 * and silently skip every deployed one. PG takes native `ADD COLUMN IF NOT EXISTS`; SQLite has
 * none (a syntax error, verified 3.37), so it takes the `PRAGMA table_info` pre-check — the exact
 * idiom `ensureQuotaDailyColumns` already uses in license.ts.
 */
async function ensureBucketKeyColumn(): Promise<void> {
  try {
    if (PG) {
      dbExec('ALTER TABLE free_keys ADD COLUMN IF NOT EXISTS bucket_key TEXT;');
    } else {
      const rows = await dbQuery<{ name: string }>('PRAGMA table_info(free_keys)', []);
      if (!new Set(rows.map((r) => r.name)).has('bucket_key')) {
        dbExec('ALTER TABLE free_keys ADD COLUMN bucket_key TEXT;');
      }
    }
  } catch {
    // A key store we cannot extend must not take issuance down. Without the column a mint simply
    // records no bucket, which is the pre-wave behaviour — degraded, never wrong.
  }
}

let _initialized = false;
export function ensureFreeKeysSchema(): void {
  if (_initialized) return;
  dbExec(FREE_KEYS_DDL);
  // Fire-and-forget: `dbExec` is already fire-and-forget on PG, and every read of `bucket_key`
  // tolerates its absence (the column is optional on FreeKeyRow).
  void ensureBucketKeyColumn();
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
  /**
   * OPS-QUOTA-CLAIM-ALIAS-W1 CH1 — the `free:v2:<hex>` bucket this key ADOPTS, or null/absent for
   * every key issued before this wave. Optional so an older cached row, or a store whose column
   * add failed, degrades to the pre-wave path rather than throwing on a live metering read.
   */
  bucket_key?: string | null;
}

/**
 * The ONLY shape a bucket key may take: a keyless free bucket, `free:<ip_hash>`.
 *
 * This is what makes key→key adoption impossible BY CONSTRUCTION rather than merely refused.
 * With 5 mints per ipHash per hour, chained claims are reachable, and adopting a previously
 * claimed key would let a caller launder an allowance through generations of keys.
 */
const BUCKET_KEY_RE = /^free:[A-Za-z0-9:_-]{1,128}$/;

/** True iff `v` is a well-formed keyless-bucket key. Exported for the CH1 assertions. */
export function isAdoptableBucketKey(v: unknown): v is string {
  return typeof v === 'string' && BUCKET_KEY_RE.test(v) && !v.startsWith(`free:${FREE_KEY_PREFIX}`);
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
  // `bucket_key` is selected here and NOWHERE else on the read path: the sync cache-only lookup
  // serves whatever this query cached, so one SELECT feeds both paths and they cannot disagree.
  const rows = await dbQuery<FreeKeyRow>(
    'SELECT api_key, email, ref_code, bucket_key FROM free_keys WHERE api_key = ?',
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

// ── OPS-AUDIT-REMEDIATION-HIGH-W1 (SEC-05): bounded issuance ────────────────────
//
// A credential-issuing helper MUST bound on a caller identity. `mintEphemeralKey` took only a
// ref code, so POST /api/start-free (unauthenticated, unrate-limited) minted unlimited av_free_
// keys — each carrying its own 100-call/month quota, i.e. unbounded free quota by loop. Every
// mint also drives a full free_keys scan+delete via expireIdleEphemeralKeys(), so the same loop
// was a DB amplification vector.
//
// The per-window cap mirrors the equity-misses idiom (bounded map, evict-expired, hard size cap)
// rather than adding an ip_hash column + migration. It is process-local, which is the correct
// layering: this is the ISSUANCE bound, and the per-IP HTTP limiter on the route is the separate
// burst bound. Together they are defense-in-depth; alone, either leaves a hole.
const EPHEMERAL_WINDOW_SEC = 3600;
const EPHEMERAL_PER_IP_CAP = 5;      // ephemeral keys per ipHash per hour
const EPHEMERAL_MAP_MAX = 5000;      // hard bound on the tracking map itself
const ephemeralMints = new Map<string, { count: number; windowStart: number }>();

/** Test seam — reset the per-ipHash issuance window. */
export function _resetEphemeralMintBoundForTest(): void {
  ephemeralMints.clear();
}

/** Thrown when a caller exceeds the per-identity ephemeral-key issuance cap. */
export class EphemeralMintQuotaError extends Error {
  readonly code = 'EPHEMERAL_MINT_CAP';
  constructor(public readonly ipHash: string) {
    super(`ephemeral key issuance cap reached (${EPHEMERAL_PER_IP_CAP}/${EPHEMERAL_WINDOW_SEC}s)`);
    this.name = 'EphemeralMintQuotaError';
  }
}

/** True when this identity may mint another ephemeral key; records the mint when it may. */
function claimEphemeralMintSlot(ipHash: string): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [k, v] of ephemeralMints) {
    if (nowSec - v.windowStart >= EPHEMERAL_WINDOW_SEC) ephemeralMints.delete(k);
  }
  if (ephemeralMints.size >= EPHEMERAL_MAP_MAX && !ephemeralMints.has(ipHash)) {
    const oldest = ephemeralMints.keys().next().value;
    if (oldest !== undefined) ephemeralMints.delete(oldest);
  }
  const entry = ephemeralMints.get(ipHash);
  if (!entry || nowSec - entry.windowStart >= EPHEMERAL_WINDOW_SEC) {
    ephemeralMints.set(ipHash, { count: 1, windowStart: nowSec });
    return true;
  }
  if (entry.count >= EPHEMERAL_PER_IP_CAP) return false;
  entry.count += 1;
  return true;
}

/**
 * Mint an ephemeral (email-less) free key. Reaps idle ephemerals lazily first.
 *
 * `ipHash` is the CALLER IDENTITY this helper bounds on (SEC-05). It is required — an
 * unidentifiable caller cannot be bounded, so it is refused rather than granted an unbounded
 * mint. Throws `EphemeralMintQuotaError` past the cap; the caller maps that to HTTP 429.
 */
export async function mintEphemeralKey(refCode?: string | null, ipHash?: string | null): Promise<string> {
  ensureFreeKeysSchema();
  const identity = ipHash && ipHash.trim() ? ipHash : null;
  if (!identity) throw new EphemeralMintQuotaError('unidentified');
  if (!claimEphemeralMintSlot(identity)) throw new EphemeralMintQuotaError(identity);
  await expireIdleEphemeralKeys().catch(() => { /* never block issuance on a reap */ });
  const apiKey = generateFreeKey();

  // OPS-QUOTA-CLAIM-ALIAS-W1 CH1 — ADOPT the caller's bucket rather than minting a fresh one.
  //
  // Before this, the mint wrote only `free_keys`, so the new key's tracker started at zero on BOTH
  // meters and a walled caller who followed our own exhaustion-notice CTA received a brand-new
  // 200/mo + 100/day allowance, five times an hour. The wall advertised its own bypass.
  //
  // `identity` is the SAME `hashIp(clientIp(req))` the request context is seeded from, so
  // `free:${identity}` names the exact row the caller has been charging — no join, no lookup, no
  // second derivation to drift. It is shape-checked rather than trusted: only a `free:` bucket is
  // adoptable, which is what makes key→key laundering impossible by construction.
  const bucketKey = isAdoptableBucketKey(`free:${identity}`) ? `free:${identity}` : null;
  dbRun('INSERT INTO free_keys (api_key, email, ref_code, bucket_key) VALUES (?, ?, ?, ?)',
        apiKey, null, refCode ?? null, bucketKey);
  cacheSet(apiKey, { api_key: apiKey, email: null, ref_code: refCode ?? null, bucket_key: bucketKey });
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
