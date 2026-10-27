/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — the OAuth store (R2.13, endpoint-truth §Proposals (e)).
 *
 * Six tables, created by the lazy ensure below on the first non-`off` boot and declared identically
 * in `migrations/049_oauth.sql` (parity pinned by `tests/unit/oauth-store-ddl.test.ts`). Every
 * timestamp is ISO-8601 TEXT computed in JS (`toISOString()` is fixed-width, so a string compare is
 * a time compare on both dialects) — no `now()` / `datetime()` split, no BIGINT-as-string trap.
 *
 * EVERY WRITE IS AN AWAITED `dbQuery(… RETURNING …)`, never `dbRun`: `dbRun` is fire-and-forget on
 * Postgres, and a claim whose result we cannot read is not a claim. The four atomic claims (code
 * consume, revoke-by-code, refresh rotate, revoke-family) are single `UPDATE … RETURNING`
 * statements, so exactly one concurrent caller wins each.
 *
 * Nothing here stores a token or a code: only their SHA-256. The circuit breaker records the last
 * store error; `oauthHealthy()` reads it (mode ≠ off · schema ensured · no error in 5 min).
 */
import { createHash } from 'node:crypto';
import { dbExec, dbQuery, isPgBackend } from '../performance-db.js';
import { resolveOAuthMode } from './mode.js';

const CREATE_CLIENTS_SQL = `CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id          TEXT NOT NULL,
  client_name        TEXT,
  redirect_uris_json TEXT NOT NULL,
  metadata_json      TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT NOT NULL,
  PRIMARY KEY (client_id)
)`;

const CREATE_CIMD_SQL = `CREATE TABLE IF NOT EXISTS oauth_cimd_cache (
  client_id     TEXT NOT NULL,
  document_json TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL,
  PRIMARY KEY (client_id)
)`;

const CREATE_PENDING_SQL = `CREATE TABLE IF NOT EXISTS oauth_pending (
  id                    TEXT NOT NULL,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  redirect_uri_explicit INTEGER NOT NULL,
  code_challenge        TEXT NOT NULL,
  state                 TEXT,
  scopes                TEXT NOT NULL,
  resource              TEXT NOT NULL,
  csrf_token            TEXT NOT NULL,
  identity_kind         TEXT,
  identity_value        TEXT,
  via                   TEXT,
  plan                  TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  consumed_at           TEXT,
  PRIMARY KEY (id)
)`;

const CREATE_CODES_SQL = `CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash             TEXT NOT NULL,
  pending_id            TEXT NOT NULL,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  redirect_uri_explicit INTEGER NOT NULL,
  code_challenge        TEXT NOT NULL,
  resource              TEXT NOT NULL,
  scopes                TEXT NOT NULL,
  identity_kind         TEXT NOT NULL,
  identity_value        TEXT NOT NULL,
  via                   TEXT NOT NULL,
  plan                  TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  used_at               TEXT,
  PRIMARY KEY (code_hash)
)`;

const CREATE_TOKENS_SQL = `CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  family_id      TEXT NOT NULL,
  code_hash      TEXT,
  client_id      TEXT NOT NULL,
  resource       TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  identity_kind  TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  parent_hash    TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  rotated_at     TEXT,
  revoked_at     TEXT,
  PRIMARY KEY (token_hash)
)`;

const CREATE_OTPS_SQL = `CREATE TABLE IF NOT EXISTS email_otps (
  id          TEXT NOT NULL,
  pending_id  TEXT NOT NULL,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (id)
)`;

const CREATE_INDEXES_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family_id)',
  'CREATE INDEX IF NOT EXISTS idx_oauth_tokens_code ON oauth_tokens (code_hash)',
  'CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps (email, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_email_otps_pending ON email_otps (pending_id)',
];

// ── circuit breaker ────────────────────────────────────────────────────────

const BREAKER_MS = 5 * 60 * 1000;
let lastStoreErrorAt = 0;
let schemaEnsured = false;

export function noteStoreError(err: unknown): void {
  lastStoreErrorAt = Date.now();
  console.error(`[oauth] store error: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * mode ≠ off · schema ensured · no store error in the last 5 min. CH3's challenge asks this
 * before it ever points a caller at sign-in: an unhealthy store means today's behaviour.
 */
export function oauthHealthy(now: number = Date.now()): boolean {
  return resolveOAuthMode() !== 'off' && schemaEnsured && now - lastStoreErrorAt > BREAKER_MS;
}

/** Test seam. */
export function _resetOAuthStoreForTest(): void {
  lastStoreErrorAt = 0;
  schemaEnsured = false;
}

/** Every statement goes through here, so every failure trips the breaker before it propagates. */
async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return await dbQuery<T>(sql, params);
  } catch (err) {
    noteStoreError(err);
    throw err;
  }
}

async function ddl(sql: string): Promise<void> {
  // better-sqlite3 refuses `.all()` on a statement that returns no rows, so SQLite takes the
  // synchronous exec; Postgres takes the awaited query (dbExec is fire-and-forget there).
  if (isPgBackend()) await q(sql);
  else dbExec(sql);
}

/** Idempotent ensure of the six tables (identical to migrations/049); awaited at mount. */
export async function ensureOAuthSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    for (const sql of [CREATE_CLIENTS_SQL, CREATE_CIMD_SQL, CREATE_PENDING_SQL, CREATE_CODES_SQL, CREATE_TOKENS_SQL, CREATE_OTPS_SQL, ...CREATE_INDEXES_SQL]) {
      await ddl(sql);
    }
    schemaEnsured = true;
  } catch (err) {
    noteStoreError(err);
    throw err;
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

// ── clients (DCR) + CIMD cache ─────────────────────────────────────────────

export interface DcrClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris_json: string;
  metadata_json: string;
  created_at: string;
  last_used_at: string;
}

export async function insertDcrClient(row: DcrClientRow): Promise<void> {
  await q(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, metadata_json, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING client_id',
    [row.client_id, row.client_name, row.redirect_uris_json, row.metadata_json, row.created_at, row.last_used_at],
  );
}

export async function getDcrClient(clientId: string, now: number = Date.now()): Promise<DcrClientRow | null> {
  const rows = await q<DcrClientRow>(
    'UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ? RETURNING client_id, client_name, redirect_uris_json, metadata_json, created_at, last_used_at',
    [isoAt(now), clientId],
  );
  return rows[0] ?? null;
}

export interface CimdRow {
  client_id: string;
  document_json: string;
  fetched_at: string;
}

export async function getCimd(clientId: string): Promise<CimdRow | null> {
  const rows = await q<CimdRow>('SELECT client_id, document_json, fetched_at FROM oauth_cimd_cache WHERE client_id = ?', [clientId]);
  return rows[0] ?? null;
}

export async function putCimd(clientId: string, documentJson: string, now: number = Date.now()): Promise<void> {
  await q(
    `INSERT INTO oauth_cimd_cache (client_id, document_json, fetched_at, last_used_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (client_id) DO UPDATE SET document_json = excluded.document_json, fetched_at = excluded.fetched_at, last_used_at = excluded.last_used_at
     RETURNING client_id`,
    [clientId, documentJson, isoAt(now), isoAt(now)],
  );
}

// ── pending authorizations ─────────────────────────────────────────────────

export interface PendingRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  redirect_uri_explicit: number;
  code_challenge: string;
  state: string | null;
  scopes: string;
  resource: string;
  csrf_token: string;
  identity_kind: string | null;
  identity_value: string | null;
  via: string | null;
  plan: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const PENDING_COLS = 'id, client_id, redirect_uri, redirect_uri_explicit, code_challenge, state, scopes, resource, csrf_token, identity_kind, identity_value, via, plan, created_at, expires_at, consumed_at';

export async function insertPending(row: Omit<PendingRow, 'identity_kind' | 'identity_value' | 'via' | 'plan' | 'consumed_at'>): Promise<void> {
  await q(
    `INSERT INTO oauth_pending (id, client_id, redirect_uri, redirect_uri_explicit, code_challenge, state, scopes, resource, csrf_token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [row.id, row.client_id, row.redirect_uri, row.redirect_uri_explicit, row.code_challenge, row.state, row.scopes, row.resource, row.csrf_token, row.created_at, row.expires_at],
  );
}

/** A pending row that is unconsumed and unexpired, else null. */
export async function getLivePending(id: string, now: number = Date.now()): Promise<PendingRow | null> {
  const rows = await q<PendingRow>(
    `SELECT ${PENDING_COLS} FROM oauth_pending WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
    [id, isoAt(now)],
  );
  return rows[0] ?? null;
}

export async function bindPendingIdentity(
  id: string,
  identity: { kind: 'email' | 'key'; value: string; via: string; plan: string },
  now: number = Date.now(),
): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `UPDATE oauth_pending SET identity_kind = ?, identity_value = ?, via = ?, plan = ?
     WHERE id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING id`,
    [identity.kind, identity.value, identity.via, identity.plan, id, isoAt(now)],
  );
  return rows.length === 1;
}

/** Atomic: exactly one caller consumes a pending row. */
export async function consumePending(id: string, now: number = Date.now()): Promise<PendingRow | null> {
  const rows = await q<PendingRow>(
    `UPDATE oauth_pending SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING ${PENDING_COLS}`,
    [isoAt(now), id, isoAt(now)],
  );
  return rows[0] ?? null;
}

// ── authorization codes ────────────────────────────────────────────────────

export interface CodeRow {
  code_hash: string;
  pending_id: string;
  client_id: string;
  redirect_uri: string;
  redirect_uri_explicit: number;
  code_challenge: string;
  resource: string;
  scopes: string;
  identity_kind: string;
  identity_value: string;
  via: string;
  plan: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

const CODE_COLS = 'code_hash, pending_id, client_id, redirect_uri, redirect_uri_explicit, code_challenge, resource, scopes, identity_kind, identity_value, via, plan, created_at, expires_at, used_at';

export async function insertCode(row: Omit<CodeRow, 'used_at'>): Promise<void> {
  await q(
    `INSERT INTO oauth_codes (${CODE_COLS.replace(', used_at', '')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING code_hash`,
    [row.code_hash, row.pending_id, row.client_id, row.redirect_uri, row.redirect_uri_explicit, row.code_challenge, row.resource, row.scopes, row.identity_kind, row.identity_value, row.via, row.plan, row.created_at, row.expires_at],
  );
}

export async function getCode(codeHash: string): Promise<CodeRow | null> {
  const rows = await q<CodeRow>(`SELECT ${CODE_COLS} FROM oauth_codes WHERE code_hash = ?`, [codeHash]);
  return rows[0] ?? null;
}

/** The code-consume claim: one concurrent winner. */
export async function claimCode(codeHash: string, now: number = Date.now()): Promise<CodeRow | null> {
  const rows = await q<CodeRow>(
    `UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING ${CODE_COLS}`,
    [isoAt(now), codeHash, isoAt(now)],
  );
  return rows[0] ?? null;
}

/** Replay: revoke every token issued from this code. Returns the families it revoked. */
export async function revokeByCode(codeHash: string, now: number = Date.now()): Promise<string[]> {
  const rows = await q<{ family_id: string }>(
    'UPDATE oauth_tokens SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL RETURNING family_id',
    [isoAt(now), codeHash],
  );
  return [...new Set(rows.map((r) => r.family_id))];
}

// ── tokens ─────────────────────────────────────────────────────────────────

export interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  family_id: string;
  code_hash: string | null;
  client_id: string;
  resource: string;
  scopes: string;
  identity_kind: string;
  identity_value: string;
  parent_hash: string | null;
  created_at: string;
  expires_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

const TOKEN_COLS = 'token_hash, kind, family_id, code_hash, client_id, resource, scopes, identity_kind, identity_value, parent_hash, created_at, expires_at, rotated_at, revoked_at';

export async function insertToken(row: Omit<TokenRow, 'rotated_at' | 'revoked_at'>): Promise<void> {
  await q(
    `INSERT INTO oauth_tokens (${TOKEN_COLS.replace(', rotated_at, revoked_at', '')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING token_hash`,
    [row.token_hash, row.kind, row.family_id, row.code_hash, row.client_id, row.resource, row.scopes, row.identity_kind, row.identity_value, row.parent_hash, row.created_at, row.expires_at],
  );
}

export async function getToken(tokenHash: string): Promise<TokenRow | null> {
  const rows = await q<TokenRow>(`SELECT ${TOKEN_COLS} FROM oauth_tokens WHERE token_hash = ?`, [tokenHash]);
  return rows[0] ?? null;
}

/** The refresh-rotate claim: one concurrent winner. */
export async function rotateRefresh(tokenHash: string, now: number = Date.now()): Promise<TokenRow | null> {
  const rows = await q<TokenRow>(
    `UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ? AND kind = 'refresh'
     AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING ${TOKEN_COLS}`,
    [isoAt(now), tokenHash, isoAt(now)],
  );
  return rows[0] ?? null;
}

export async function revokeFamily(familyId: string, now: number = Date.now()): Promise<number> {
  const rows = await q<{ token_hash: string }>(
    'UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL RETURNING token_hash',
    [isoAt(now), familyId],
  );
  return rows.length;
}

// ── email codes ────────────────────────────────────────────────────────────

export interface OtpRow {
  id: string;
  pending_id: string;
  email: string;
  code_hash: string;
  attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export async function insertOtp(row: Omit<OtpRow, 'consumed_at'>): Promise<void> {
  await q(
    'INSERT INTO email_otps (id, pending_id, email, code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [row.id, row.pending_id, row.email, row.code_hash, row.attempts, row.created_at, row.expires_at],
  );
}

export async function countOtpSendsSince(email: string, sinceMs: number): Promise<number> {
  const rows = await q<{ n: number | string }>('SELECT count(*) AS n FROM email_otps WHERE email = ? AND created_at > ?', [email, isoAt(sinceMs)]);
  return Number(rows[0]?.n ?? 0);
}

/** The newest live code for this pending row. */
export async function getLiveOtp(pendingId: string, now: number = Date.now()): Promise<OtpRow | null> {
  const rows = await q<OtpRow>(
    `SELECT id, pending_id, email, code_hash, attempts, created_at, expires_at, consumed_at FROM email_otps
     WHERE pending_id = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
    [pendingId, isoAt(now)],
  );
  return rows[0] ?? null;
}

/** Spend one attempt atomically; null once the cap is reached. */
export async function spendOtpAttempt(id: string, maxAttempts: number): Promise<number | null> {
  const rows = await q<{ attempts: number | string }>(
    'UPDATE email_otps SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < ? RETURNING attempts',
    [id, maxAttempts],
  );
  return rows.length === 1 ? Number(rows[0].attempts) : null;
}

export async function consumeOtp(id: string, now: number = Date.now()): Promise<boolean> {
  const rows = await q<{ id: string }>('UPDATE email_otps SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id', [isoAt(now), id]);
  return rows.length === 1;
}

// ── retention ──────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
let lastPurgeAt = 0;

/**
 * Pending, codes and OTPs after 24 h; revoked or expired tokens after 30 d; DCR clients unused for
 * 30 d (I-5). At most once an hour, called from the authorize path — no timer of its own.
 */
export async function purgeExpired(now: number = Date.now()): Promise<void> {
  if (now - lastPurgeAt < 60 * 60 * 1000) return;
  lastPurgeAt = now;
  const d1 = isoAt(now - DAY);
  const d30 = isoAt(now - 30 * DAY);
  await q('DELETE FROM oauth_pending WHERE created_at < ? RETURNING id', [d1]);
  await q('DELETE FROM oauth_codes WHERE created_at < ? RETURNING code_hash', [d1]);
  await q('DELETE FROM email_otps WHERE created_at < ? RETURNING id', [d1]);
  await q('DELETE FROM oauth_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ? RETURNING token_hash', [d30, d30]);
  await q('DELETE FROM oauth_clients WHERE last_used_at < ? RETURNING client_id', [d30]);
}

/** Test seam. */
export function _resetPurgeClockForTest(): void {
  lastPurgeAt = 0;
}
