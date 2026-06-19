/**
 * REFERRAL-LIGHT-W1 / C1 — Referral substrate store: typed CRUD over the four
 * referral tables. Pure persistence — NO Stripe / HTTP / email imports (C3 owns
 * the money-path wiring). Every query goes through the shared dbExec/dbRun/dbQuery
 * layer so PG (prod) and better-sqlite3 (tests/local) are one code path; the
 * PG-only DDL (regex CHECK) lives in migrations/015_referral_tables.sql.
 *
 * Tables (see migrations/015):
 *   referral_codes        — auto per-account (kind='user') + admin partner codes
 *   referral_attributions — one grant per human (referee_email UNIQUE)
 *   referral_ledger       — commission accrual, idempotent on stripe_event_id
 *   referral_bonus        — referee bonus-calls meter (consumed by C2 license.ts)
 *
 * dbRun is fire-and-forget (no rowCount), so idempotent inserts use the
 * SELECT-then-INSERT idiom (mirrors stripe-events-store.tryClaimEvent).
 * node-postgres returns BIGSERIAL/BIGINT as STRING → ids are Number()-normalized.
 */
import { createHmac } from 'node:crypto';
import { dbExec, dbRun, dbQuery } from './performance-db.js';
import { isValidCodeFormat } from './referral-constants.js';

const PG = !!process.env.DATABASE_URL;
const TS = PG ? 'TIMESTAMPTZ' : 'TIMESTAMP';
const NOW = PG ? 'now()' : "(datetime('now'))";
const SERIAL_PK = PG ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const BIGINT = PG ? 'BIGINT' : 'INTEGER';

// Single multi-statement DDL (CLAUDE.md "bundle DDL into one dbExec call" — avoids
// the index-before-table race that bit GEO-MEASUREMENT-W1). CHECK IN(...) and the
// >= 0 guard are portable; the regex CHECK is PG-only and lives in migration 015.
const REFERRAL_DDL = `
  CREATE TABLE IF NOT EXISTS referral_codes (
    code TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'partner')),
    owner_key TEXT,
    owner_email TEXT,
    owner_label TEXT,
    created_at ${TS} NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE IF NOT EXISTS referral_attributions (
    id ${SERIAL_PK},
    code TEXT NOT NULL,
    referee_email TEXT UNIQUE,
    referee_key TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('paid_checkout', 'free_signup')),
    stripe_customer_id TEXT,
    window_ends_at ${TS},
    created_at ${TS} NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_referral_attr_code ON referral_attributions (code);
  CREATE INDEX IF NOT EXISTS idx_referral_attr_customer ON referral_attributions (stripe_customer_id);
  CREATE TABLE IF NOT EXISTS referral_ledger (
    id ${SERIAL_PK},
    code TEXT NOT NULL,
    attribution_id ${BIGINT},
    stripe_event_id TEXT UNIQUE,
    invoice_id TEXT,
    gross_usd_e2 INTEGER NOT NULL DEFAULT 0,
    commission_usd_e2 INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('credited', 'usdc_pending', 'usdc_paid', 'clawed_back')),
    tx_ref TEXT,
    created_at ${TS} NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_referral_ledger_code ON referral_ledger (code);
  CREATE INDEX IF NOT EXISTS idx_referral_ledger_status ON referral_ledger (status);
  CREATE TABLE IF NOT EXISTS referral_bonus (
    tracker_key TEXT PRIMARY KEY,
    bonus_remaining INTEGER NOT NULL DEFAULT 0 CHECK (bonus_remaining >= 0),
    granted_at ${TS} NOT NULL DEFAULT ${NOW},
    source_code TEXT
  );
`;

let _initialized = false;
export function ensureReferralSchema(): void {
  if (_initialized) return;
  dbExec(REFERRAL_DDL);
  _initialized = true;
}
/** Test seam: re-arm the init guard (module-level-cache reset idiom). */
export function _resetReferralSchemaInitForTest(): void {
  _initialized = false;
}

// ── Types ──
export type ReferralKind = 'user' | 'partner';
export type ReferralChannel = 'paid_checkout' | 'free_signup';
export type LedgerStatus = 'credited' | 'usdc_pending' | 'usdc_paid' | 'clawed_back';

export interface ReferralCodeRow {
  code: string;
  kind: ReferralKind;
  owner_key: string | null;
  owner_email: string | null;
  owner_label: string | null;
  created_at: string;
}
export interface AttributionRow {
  id: number;
  code: string;
  referee_email: string | null;
  referee_key: string | null;
  channel: ReferralChannel;
  stripe_customer_id: string | null;
  window_ends_at: string | null;
  created_at: string;
}
export interface LedgerRow {
  id: number;
  code: string;
  attribution_id: number | null;
  stripe_event_id: string | null;
  invoice_id: string | null;
  gross_usd_e2: number;
  commission_usd_e2: number;
  status: LedgerStatus;
  tx_ref: string | null;
  created_at: string;
}
export interface ReferrerStats {
  code: string;
  signups: number;
  conversions: number;
  accrued_usd_e2: number;
  credited_usd_e2: number;
  usdc_pending_usd_e2: number;
  usdc_paid_usd_e2: number;
  clawed_back_usd_e2: number;
}
export interface PendingPayout {
  code: string;
  owner_key: string | null;
  owner_email: string | null;
  owner_label: string | null;
  pending_usd_e2: number;
  row_count: number;
  ledger_ids: number[];
}

const CODE_COLS = 'code, kind, owner_key, owner_email, owner_label, created_at';
const ATTR_COLS = 'id, code, referee_email, referee_key, channel, stripe_customer_id, window_ends_at, created_at';
const LEDGER_COLS = 'id, code, attribution_id, stripe_event_id, invoice_id, gross_usd_e2, commission_usd_e2, status, tx_ref, created_at';

// ── Code derivation (deterministic, idempotent, storage-free) ──
// 8-char RFC4648 base32 of HMAC-SHA256(salt, apiKey)[:5 bytes]. Same key → same
// code forever. The salt is fixed + public (codes are shareable, not secret).
const CODE_HMAC_SALT = 'algovault-referral-v1';
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC4648; all chars ∈ [A-Z0-9]

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = ((value << 8) | bytes[i]) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    // keep only the leftover low bits so `value` never exceeds 32-bit range
    value = value & ((1 << bits) - 1);
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Deterministic per-account code (8 uppercase alnum chars; matches CODE_RE). */
export function deriveUserCode(apiKey: string): string {
  const digest = createHmac('sha256', CODE_HMAC_SALT).update(apiKey).digest();
  return base32Encode(digest.subarray(0, 5)); // 5 bytes → exactly 8 base32 chars
}

function normalizeAttribution(r: Record<string, unknown>): AttributionRow {
  return {
    id: Number(r.id),
    code: String(r.code),
    referee_email: (r.referee_email as string) ?? null,
    referee_key: (r.referee_key as string) ?? null,
    channel: r.channel as ReferralChannel,
    stripe_customer_id: (r.stripe_customer_id as string) ?? null,
    window_ends_at: r.window_ends_at == null ? null : String(r.window_ends_at),
    created_at: String(r.created_at),
  };
}
function normalizeLedger(r: Record<string, unknown>): LedgerRow {
  return {
    id: Number(r.id),
    code: String(r.code),
    attribution_id: r.attribution_id == null ? null : Number(r.attribution_id),
    stripe_event_id: (r.stripe_event_id as string) ?? null,
    invoice_id: (r.invoice_id as string) ?? null,
    gross_usd_e2: Number(r.gross_usd_e2),
    commission_usd_e2: Number(r.commission_usd_e2),
    status: r.status as LedgerStatus,
    tx_ref: (r.tx_ref as string) ?? null,
    created_at: String(r.created_at),
  };
}

// ── Codes ──
export async function resolveCode(code: string): Promise<ReferralCodeRow | null> {
  if (!isValidCodeFormat(code)) return null;
  ensureReferralSchema();
  const rows = await dbQuery<ReferralCodeRow>(
    `SELECT ${CODE_COLS} FROM referral_codes WHERE code = ?`,
    [code],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Idempotently issue (or return) the caller's deterministic user code. */
export async function ensureUserCode(apiKey: string, ownerEmail?: string | null): Promise<string> {
  ensureReferralSchema();
  const code = deriveUserCode(apiKey);
  const existing = await dbQuery<{ code: string }>(
    'SELECT code FROM referral_codes WHERE code = ?',
    [code],
  );
  if (existing.length === 0) {
    try {
      dbRun(
        'INSERT INTO referral_codes (code, kind, owner_key, owner_email) VALUES (?, ?, ?, ?)',
        code, 'user', apiKey, ownerEmail ?? null,
      );
    } catch {
      // concurrent insert won the PK race — idempotent, ignore
    }
  }
  return code;
}

/** Mint an admin partner code (custom slug). Throws on bad format or duplicate. */
export async function mintPartnerCode(params: {
  code: string;
  owner_label: string;
  owner_email?: string | null;
}): Promise<ReferralCodeRow> {
  ensureReferralSchema();
  const code = params.code.toUpperCase();
  if (!isValidCodeFormat(code)) {
    throw new Error('invalid partner code: expected 6-16 uppercase alphanumerics');
  }
  const existing = await resolveCode(code);
  if (existing) throw new Error(`referral code already exists: ${code}`);
  dbRun(
    'INSERT INTO referral_codes (code, kind, owner_label, owner_email) VALUES (?, ?, ?, ?)',
    code, 'partner', params.owner_label, params.owner_email ?? null,
  );
  return {
    code, kind: 'partner', owner_key: null,
    owner_email: params.owner_email ?? null, owner_label: params.owner_label, created_at: '',
  };
}

// ── Attributions (one grant per human; referee_email UNIQUE) ──
export async function recordAttribution(params: {
  code: string;
  referee_email?: string | null;
  referee_key?: string | null;
  channel: ReferralChannel;
  stripe_customer_id?: string | null;
  window_ends_at?: string | null;
}): Promise<{ recorded: boolean; id: number | null }> {
  ensureReferralSchema();
  if (params.referee_email) {
    const existing = await dbQuery<{ id: number }>(
      'SELECT id FROM referral_attributions WHERE referee_email = ?',
      [params.referee_email],
    );
    if (existing.length > 0) return { recorded: false, id: Number(existing[0].id) };
  }
  try {
    dbRun(
      `INSERT INTO referral_attributions (code, referee_email, referee_key, channel, stripe_customer_id, window_ends_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      params.code, params.referee_email ?? null, params.referee_key ?? null,
      params.channel, params.stripe_customer_id ?? null, params.window_ends_at ?? null,
    );
  } catch {
    if (params.referee_email) {
      const recheck = await dbQuery<{ id: number }>(
        'SELECT id FROM referral_attributions WHERE referee_email = ?',
        [params.referee_email],
      );
      if (recheck.length > 0) return { recorded: false, id: Number(recheck[0].id) };
    }
    throw new Error('recordAttribution insert failed');
  }
  const fetched = params.referee_email
    ? await dbQuery<{ id: number }>('SELECT id FROM referral_attributions WHERE referee_email = ?', [params.referee_email])
    : await dbQuery<{ id: number }>('SELECT id FROM referral_attributions WHERE code = ? ORDER BY id DESC LIMIT 1', [params.code]);
  return { recorded: true, id: fetched.length > 0 ? Number(fetched[0].id) : null };
}

export async function getAttributionByCustomer(stripeCustomerId: string): Promise<AttributionRow | null> {
  ensureReferralSchema();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${ATTR_COLS} FROM referral_attributions WHERE stripe_customer_id = ? ORDER BY id DESC LIMIT 1`,
    [stripeCustomerId],
  );
  return rows.length > 0 ? normalizeAttribution(rows[0]) : null;
}

export async function getAttributionByEmail(email: string): Promise<AttributionRow | null> {
  ensureReferralSchema();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${ATTR_COLS} FROM referral_attributions WHERE referee_email = ?`,
    [email],
  );
  return rows.length > 0 ? normalizeAttribution(rows[0]) : null;
}

// ── Bonus meter (read/grant by store; consume logic lives in C2 license.ts) ──
export async function getBonusRemaining(trackerKey: string): Promise<number> {
  ensureReferralSchema();
  const rows = await dbQuery<{ bonus_remaining: number | string }>(
    'SELECT bonus_remaining FROM referral_bonus WHERE tracker_key = ?',
    [trackerKey],
  );
  return rows.length > 0 ? Number(rows[0].bonus_remaining) : 0;
}

/** Additive grant (free-signup / paid-conversion). Returns the new remaining. */
export async function grantBonus(trackerKey: string, calls: number, sourceCode?: string | null): Promise<number> {
  ensureReferralSchema();
  const add = Math.max(0, Math.floor(calls));
  const rows = await dbQuery<{ bonus_remaining: number | string }>(
    'SELECT bonus_remaining FROM referral_bonus WHERE tracker_key = ?',
    [trackerKey],
  );
  if (rows.length > 0) {
    const next = Math.max(0, Number(rows[0].bonus_remaining) + add);
    dbRun('UPDATE referral_bonus SET bonus_remaining = ? WHERE tracker_key = ?', next, trackerKey);
    return next;
  }
  try {
    dbRun(
      'INSERT INTO referral_bonus (tracker_key, bonus_remaining, source_code) VALUES (?, ?, ?)',
      trackerKey, add, sourceCode ?? null,
    );
    return add;
  } catch {
    const re = await dbQuery<{ bonus_remaining: number | string }>(
      'SELECT bonus_remaining FROM referral_bonus WHERE tracker_key = ?',
      [trackerKey],
    );
    const next = Math.max(0, (re.length > 0 ? Number(re[0].bonus_remaining) : 0) + add);
    dbRun('UPDATE referral_bonus SET bonus_remaining = ? WHERE tracker_key = ?', next, trackerKey);
    return next;
  }
}

/** Warm-set for C2's in-memory map at initQuotaDb. */
export async function loadAllBonuses(): Promise<{ tracker_key: string; bonus_remaining: number }[]> {
  ensureReferralSchema();
  const rows = await dbQuery<{ tracker_key: string; bonus_remaining: number | string }>(
    'SELECT tracker_key, bonus_remaining FROM referral_bonus',
    [],
  );
  return rows.map((r) => ({ tracker_key: r.tracker_key, bonus_remaining: Number(r.bonus_remaining) }));
}

/** Write-through the absolute remaining value (C2 consumption persist). Upsert. */
export function persistBonusRemaining(trackerKey: string, remaining: number): void {
  ensureReferralSchema();
  const n = Math.max(0, Math.floor(remaining));
  dbRun(
    `INSERT INTO referral_bonus (tracker_key, bonus_remaining) VALUES (?, ?)
     ON CONFLICT (tracker_key) DO UPDATE SET bonus_remaining = excluded.bonus_remaining`,
    trackerKey, n,
  );
}

// ── Ledger (idempotent on stripe_event_id) ──
export async function appendLedger(params: {
  code: string;
  attribution_id?: number | null;
  stripe_event_id?: string | null;
  invoice_id?: string | null;
  gross_usd_e2: number;
  commission_usd_e2: number;
  status: LedgerStatus;
  tx_ref?: string | null;
}): Promise<{ appended: boolean; id: number | null }> {
  ensureReferralSchema();
  if (params.stripe_event_id) {
    const existing = await dbQuery<{ id: number }>(
      'SELECT id FROM referral_ledger WHERE stripe_event_id = ?',
      [params.stripe_event_id],
    );
    if (existing.length > 0) return { appended: false, id: Number(existing[0].id) };
  }
  try {
    dbRun(
      `INSERT INTO referral_ledger (code, attribution_id, stripe_event_id, invoice_id, gross_usd_e2, commission_usd_e2, status, tx_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params.code, params.attribution_id ?? null, params.stripe_event_id ?? null, params.invoice_id ?? null,
      Math.round(params.gross_usd_e2), Math.round(params.commission_usd_e2), params.status, params.tx_ref ?? null,
    );
  } catch {
    if (params.stripe_event_id) {
      const recheck = await dbQuery<{ id: number }>(
        'SELECT id FROM referral_ledger WHERE stripe_event_id = ?',
        [params.stripe_event_id],
      );
      if (recheck.length > 0) return { appended: false, id: Number(recheck[0].id) };
    }
    throw new Error('appendLedger insert failed');
  }
  const fetched = params.stripe_event_id
    ? await dbQuery<{ id: number }>('SELECT id FROM referral_ledger WHERE stripe_event_id = ?', [params.stripe_event_id])
    : await dbQuery<{ id: number }>('SELECT id FROM referral_ledger WHERE code = ? ORDER BY id DESC LIMIT 1', [params.code]);
  return { appended: true, id: fetched.length > 0 ? Number(fetched[0].id) : null };
}

export async function getLedgerByEventId(eventId: string): Promise<LedgerRow | null> {
  ensureReferralSchema();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${LEDGER_COLS} FROM referral_ledger WHERE stripe_event_id = ?`,
    [eventId],
  );
  return rows.length > 0 ? normalizeLedger(rows[0]) : null;
}

export async function getLedgerById(id: number): Promise<LedgerRow | null> {
  ensureReferralSchema();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${LEDGER_COLS} FROM referral_ledger WHERE id = ?`,
    [id],
  );
  return rows.length > 0 ? normalizeLedger(rows[0]) : null;
}

export function markLedger(id: number, status: LedgerStatus, txRef?: string | null): void {
  ensureReferralSchema();
  if (txRef !== undefined && txRef !== null) {
    dbRun('UPDATE referral_ledger SET status = ?, tx_ref = ? WHERE id = ?', status, txRef, id);
  } else {
    dbRun('UPDATE referral_ledger SET status = ? WHERE id = ?', status, id);
  }
}

export async function listRecentLedger(limit = 50): Promise<LedgerRow[]> {
  ensureReferralSchema();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${LEDGER_COLS} FROM referral_ledger ORDER BY id DESC LIMIT ?`,
    [Math.max(1, Math.floor(limit))],
  );
  return rows.map(normalizeLedger);
}

// ── Stats + payout queue (admin / portal consumers, C4) ──
export async function referrerStats(code: string): Promise<ReferrerStats> {
  ensureReferralSchema();
  const attr = await dbQuery<Record<string, unknown>>(
    `SELECT COUNT(*) AS signups,
            SUM(CASE WHEN channel = 'paid_checkout' THEN 1 ELSE 0 END) AS conversions
     FROM referral_attributions WHERE code = ?`,
    [code],
  );
  const led = await dbQuery<Record<string, unknown>>(
    `SELECT
       SUM(CASE WHEN status IN ('credited','usdc_pending','usdc_paid') THEN commission_usd_e2 ELSE 0 END) AS accrued,
       SUM(CASE WHEN status = 'credited' THEN commission_usd_e2 ELSE 0 END) AS credited,
       SUM(CASE WHEN status = 'usdc_pending' THEN commission_usd_e2 ELSE 0 END) AS usdc_pending,
       SUM(CASE WHEN status = 'usdc_paid' THEN commission_usd_e2 ELSE 0 END) AS usdc_paid,
       SUM(CASE WHEN status = 'clawed_back' THEN commission_usd_e2 ELSE 0 END) AS clawed_back
     FROM referral_ledger WHERE code = ?`,
    [code],
  );
  const a = attr[0] ?? {};
  const l = led[0] ?? {};
  return {
    code,
    signups: Number(a.signups ?? 0),
    conversions: Number(a.conversions ?? 0),
    accrued_usd_e2: Number(l.accrued ?? 0),
    credited_usd_e2: Number(l.credited ?? 0),
    usdc_pending_usd_e2: Number(l.usdc_pending ?? 0),
    usdc_paid_usd_e2: Number(l.usdc_paid ?? 0),
    clawed_back_usd_e2: Number(l.clawed_back ?? 0),
  };
}

export async function topReferrers(limit = 20): Promise<ReferrerStats[]> {
  ensureReferralSchema();
  const codes = await dbQuery<{ code: string }>(
    `SELECT code FROM referral_attributions GROUP BY code ORDER BY COUNT(*) DESC LIMIT ?`,
    [Math.max(1, Math.floor(limit))],
  );
  const out: ReferrerStats[] = [];
  for (const c of codes) out.push(await referrerStats(c.code));
  return out;
}

/** USDC-pending payout queue, grouped by code, gated on per-code total >= minUsd. */
export async function pendingPayouts(minUsd: number): Promise<PendingPayout[]> {
  ensureReferralSchema();
  const minE2 = Math.round(minUsd * 100);
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT l.id AS id, l.code AS code, l.commission_usd_e2 AS commission_usd_e2,
            c.owner_key AS owner_key, c.owner_email AS owner_email, c.owner_label AS owner_label
     FROM referral_ledger l
     LEFT JOIN referral_codes c ON c.code = l.code
     WHERE l.status = 'usdc_pending'
     ORDER BY l.code, l.id`,
    [],
  );
  const byCode = new Map<string, PendingPayout>();
  for (const r of rows) {
    const code = String(r.code);
    let p = byCode.get(code);
    if (!p) {
      p = {
        code,
        owner_key: (r.owner_key as string) ?? null,
        owner_email: (r.owner_email as string) ?? null,
        owner_label: (r.owner_label as string) ?? null,
        pending_usd_e2: 0,
        row_count: 0,
        ledger_ids: [],
      };
      byCode.set(code, p);
    }
    p.pending_usd_e2 += Number(r.commission_usd_e2);
    p.row_count += 1;
    p.ledger_ids.push(Number(r.id));
  }
  return [...byCode.values()]
    .filter((p) => p.pending_usd_e2 >= minE2)
    .sort((x, y) => y.pending_usd_e2 - x.pending_usd_e2);
}
