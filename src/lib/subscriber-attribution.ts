/**
 * SUBSCRIBER-ATTRIBUTION-SPINE-W1 — durable acquisition-attribution spine.
 *
 * The reusable, channel-agnostic artifact: capture (C1), conversion-time
 * profiler (C2), admin read (C3). New producers (TG bot / MCP upgrade / raw
 * API) plug in by emitting a `<channel>:<ts>:<rand>` client_reference_id at
 * click time — no schema change.
 *
 * Privacy: stores ip_hash (sha256→16hex via analytics.hashIp), NEVER a raw IP.
 * PII (name/email/country) lives ONLY in subscriber_profiles (C2) behind the
 * ADMIN_API_KEY-gated route (C3); it never touches the MCP surface or any
 * public/un-gated route.
 *
 * Fail-open is LAW for this wave: capture/profiler are fire-and-forget +
 * try-caught so a DB error can never block, slow, or fail the /signup redirect,
 * the payment, or the entitlement grant.
 */
import { dbExec, dbRun, dbQuery } from './performance-db.js';
import { getMonthlyQuota } from './license.js';
import { PLANS, planMonthlyRateUsd, type PaidPlanId, type BillingInterval } from './plans.js';

const PG = !!process.env.DATABASE_URL;
const TS = PG ? 'TIMESTAMPTZ' : 'TIMESTAMP';
const NOW = PG ? 'now()' : "(datetime('now'))";

// ── C1: signup attribution capture ──────────────────────────────────────────

const CREATE_SIGNUP_ATTRIBUTION_SQL = `
  CREATE TABLE IF NOT EXISTS signup_attribution (
    client_reference_id TEXT PRIMARY KEY,
    created_at ${TS} NOT NULL DEFAULT ${NOW},
    channel TEXT NOT NULL DEFAULT 'unknown',
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    referrer TEXT,
    landing_path TEXT,
    tier_requested TEXT,
    ip_hash TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_signup_attribution_created_at ON signup_attribution (created_at);
`;

let _signupAttributionInit = false;
export function ensureSignupAttributionSchema(): void {
  if (_signupAttributionInit) return;
  dbExec(CREATE_SIGNUP_ATTRIBUTION_SQL);
  _signupAttributionInit = true;
}

/**
 * Channel-agnostic derivation from the synthetic client_reference_id prefix
 * (`<channel>:<ts>:<rand>`), with a utm_source fallback. Pure + unit-tested so
 * future producers (TG / MCP / API) are a one-line prefix, no schema change.
 */
export function deriveChannel(clientRefId: string, utmSource?: string | null): string {
  const id = (clientRefId || '').toLowerCase();
  if (id.startsWith('tg_bot:') || id.startsWith('tg:')) return 'tg_bot';
  if (id.startsWith('mcp:')) return 'mcp';
  if (id.startsWith('api:')) return 'api';
  if (id.startsWith('direct:')) return 'direct';
  const u = (utmSource || '').toLowerCase();
  if (u) {
    if (u.includes('telegram') || u.includes('tg')) return 'tg_bot';
    if (u.includes('mcp')) return 'mcp';
    if (u.includes('api')) return 'api';
  }
  return 'unknown';
}

export interface SignupAttributionInput {
  clientReferenceId: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  tierRequested?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
}

/** DI seam — tests inject a throwing/recording writer to prove fail-open. */
export interface AttributionWriter {
  ensure: () => void;
  run: (sql: string, ...params: unknown[]) => void;
}
const defaultWriter: AttributionWriter = { ensure: ensureSignupAttributionSchema, run: dbRun };

/**
 * Fail-open, fire-and-forget capture of a /signup click. `ON CONFLICT
 * (client_reference_id) DO NOTHING` makes a re-click idempotent. NEVER throws —
 * any capture error is swallowed + logged so the 303 redirect is byte- and
 * latency-unaffected (revenue path is LAW for this wave).
 */
export function recordSignupAttribution(
  input: SignupAttributionInput,
  writer: AttributionWriter = defaultWriter,
): void {
  try {
    writer.ensure();
    const channel = deriveChannel(input.clientReferenceId, input.utmSource ?? null);
    writer.run(
      `INSERT INTO signup_attribution
        (client_reference_id, channel, utm_source, utm_medium, utm_campaign, referrer, landing_path, tier_requested, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (client_reference_id) DO NOTHING`,
      input.clientReferenceId,
      channel,
      input.utmSource ?? null,
      input.utmMedium ?? null,
      input.utmCampaign ?? null,
      input.referrer ?? null,
      input.landingPath ?? null,
      input.tierRequested ?? null,
      input.ipHash ?? null,
      input.userAgent ?? null,
    );
  } catch (err) {
    console.warn('[recordSignupAttribution] capture failed (fail-open):', err instanceof Error ? err.message : err);
  }
}

// ── C2: conversion-time auto-profiler (the productized diagnosis) ────────────

const CREATE_SUBSCRIBER_PROFILES_SQL = `
  CREATE TABLE IF NOT EXISTS subscriber_profiles (
    customer_id TEXT PRIMARY KEY,
    created_at ${TS} DEFAULT ${NOW},
    email TEXT,
    name TEXT,
    subscription_id TEXT,
    tier TEXT,
    status TEXT,
    amount_usd ${PG ? 'NUMERIC(10,2)' : 'REAL'},
    currency TEXT,
    channel TEXT,
    country TEXT,
    country_source TEXT,
    client_reference_id TEXT,
    signup_at ${TS},
    converted_at ${TS},
    latency_seconds INTEGER,
    cold_subscribe BOOLEAN,
    attribution_captured BOOLEAN,
    risk_level TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_subscriber_profiles_converted_at ON subscriber_profiles (converted_at DESC);
`;

let _subscriberProfilesInit = false;
export function ensureSubscriberProfilesSchema(): void {
  if (_subscriberProfilesInit) return;
  dbExec(CREATE_SUBSCRIBER_PROFILES_SQL);
  _subscriberProfilesInit = true;
}

/**
 * The billing cadence AS STORED on a profile row.
 *
 * Widens the plan-SoT `BillingInterval` with `unknown`, which is a property of the RECORD, not
 * of a plan: "we have not established which cadence this row was sold on". Every row that
 * predates OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 is `unknown` until CH4 reads the truth from Stripe.
 *
 * 🛑 `unknown` must NEVER be defaulted to `month`. A guessed cadence makes the composition check
 * pass on a fiction, and — because an annual Starter's monthly rate is $6.58 against a monthly
 * Starter's $9.99 — a wrong guess is a wrong MRR that looks entirely plausible.
 */
export type StoredBillingInterval = BillingInterval | 'unknown';

/**
 * Coerce an untrusted cadence string to the stored vocabulary. Pure; exported for test.
 *
 * Default-DENY: anything not exactly `month`/`year` becomes `unknown`, never a guess. The live
 * input is `session.metadata.billing_interval`, which `createCheckoutSession` stamps on every
 * checkout since PRICING-ANNUAL-AND-HOLD-PROMISE-W1 — so it is present and trustworthy going
 * forward, and simply absent on the pre-annual cohort.
 */
export function normalizeBillingInterval(v: unknown): StoredBillingInterval {
  return v === 'month' || v === 'year' ? v : 'unknown';
}

/** True when `v` is a tier the plan ladder knows how to price. Pure; exported for test. */
export function isPaidPlanId(v: unknown): v is PaidPlanId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANS, v);
}

/**
 * The monthly rate to materialise for a stored (tier, interval) pair, or null when it is not
 * derivable — an `unknown` cadence, or a tier the ladder does not price.
 *
 * Pure; exported for test. Projects `planMonthlyRateUsd` (the ONE derivation) rather than doing
 * arithmetic on `amount_usd`, which cannot tell a $79 annual prepayment from a $79 monthly
 * charge. null is a refusal, never a zero — see `planMonthlyRateUsd`.
 */
export function deriveMonthlyRateUsd(tier: unknown, interval: StoredBillingInterval): number | null {
  if (interval === 'unknown' || !isPaidPlanId(tier)) return null;
  return planMonthlyRateUsd(tier, interval);
}

export interface SubscriberProfile {
  customerId: string;
  email: string | null;
  name: string | null;
  subscriptionId: string | null;
  tier: string | null;
  status: string | null;
  amountUsd: number | null;
  /**
   * Billing cadence (OPS-STRIPE-SUBSCRIPTION-TRUTH-W1). Without it `amountUsd` is unreadable as
   * a rate: a $79 annual prepay and a $79 monthly charge are the same stored number.
   */
  billingInterval: StoredBillingInterval;
  /**
   * MRR contribution, derived from `PLANS` — NOT from `amountUsd`, which records what was
   * charged and is deliberately left untouched (Data Integrity: add before you remove).
   */
  monthlyRateUsd: number | null;
  currency: string | null;
  channel: string;
  country: string | null;
  countrySource: string | null;
  clientReferenceId: string | null;
  signupAt: string | null;
  convertedAt: string;
  latencySeconds: number | null;
  coldSubscribe: boolean | null;
  attributionCaptured: boolean;
  riskLevel: string | null;
}

export interface ProfileSignals {
  attribution?: { channel: string; created_at: string } | null;
  hasOptin?: boolean;
  hasUpgradeCta?: boolean;
  /** Geo tier-1 (card-issuing / Link country) when resolvable; else billing-address is used. */
  cardCountry?: string | null;
  riskLevel?: string | null;
  /** Conversion epoch (sec) — injected so assembleProfile stays pure/testable. */
  convertedAtEpoch: number;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Normalise a timestamp read back OUT of the database into a form Postgres will accept when it is
 * bound straight back IN. Exported for test.
 *
 * 🛑 THIS IS THE 58-DAY OUTAGE. `signup_at` is `timestamptz`, and the value bound into it comes from
 * `SELECT created_at FROM signup_attribution`. **node-pg returns a `timestamptz` column as a JS
 * `Date`**, and the old code did `String(rows[0].created_at)` — which yields
 * `"Sun Jul 26 2026 11:46:33 GMT+0000 (Coordinated Universal Time)"`. Postgres rejects that with
 * **SQLSTATE 22007** (`invalid input syntax for type timestamp with time zone`) — the trailing
 * `(Coordinated Universal Time)` parenthetical is not parseable. Every profile INSERT carrying an
 * attribution row was therefore rejected, and because the PG write path is fire-and-forget the
 * rejection reached no `catch` and the caller logged SUCCESS. Measured: the profiler was 0-for-3 on
 * every conversion that HAD an attribution row, while the one conversion WITHOUT one (so
 * `signup_at = NULL`, a valid bind) is the single row the table contains.
 *
 * ⚠️ **A `Date` is the ONLY broken case, and widening this is how you break SQLite.** better-sqlite3
 * returns `created_at` as the raw TEXT it stored — `datetime('now')` format, `'2026-07-26 11:46:33'`,
 * UTC with no zone marker. `new Date('2026-07-26 11:46:33')` parses that as **LOCAL** time in Node,
 * so "helpfully" re-serialising strings here would silently shift every SQLite timestamp by the host's
 * UTC offset. Strings are already accepted by both backends and are passed through untouched.
 */
export function toIsoTimestamp(v: unknown): string | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  return asString(v);
}

/**
 * Pure assembly of a subscriber profile from the Stripe checkout session +
 * resolved first-party signals. No I/O, no Date.now (convertedAtEpoch injected)
 * — so channel-resolution order / geo source / cold logic / latency are unit-
 * testable. NEVER fabricates an IP or geo: country comes ONLY from the supplied
 * cardCountry (tier-1) or the session's billing-address country (tier-2).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assembleProfile(session: any, signals: ProfileSignals): SubscriberProfile {
  const customerId = typeof session?.customer === 'string'
    ? session.customer
    : asString(session?.customer?.id) ?? '';
  const cd = session?.customer_details ?? {};
  const email = asString(cd.email) ?? asString(session?.customer_email);
  const clientReferenceId = asString(session?.client_reference_id);
  const utmSource = asString(session?.metadata?.utm_source);

  // Channel: (1) the joined signup_attribution channel; (2) deriveChannel
  // fallback; (3) 'unknown'. attribution_captured records whether a click row
  // existed (the pre-spine cohort, e.g. cus_UepU…, has none → false).
  const attributionCaptured = !!signals.attribution;
  const channel = signals.attribution?.channel
    ?? deriveChannel(clientReferenceId ?? '', utmSource);

  // Geo: card-issuing (tier-1, when resolvable) → billing-address country.
  // Never an IP. country_source names the field used.
  const billingCountry = asString(cd.address?.country);
  let country: string | null = null;
  let countrySource: string | null = null;
  if (signals.cardCountry) { country = signals.cardCountry; countrySource = 'card_issuing'; }
  else if (billingCountry) { country = billingCountry; countrySource = 'billing_address'; }

  // Latency: signup→convert from the attribution row when present, else the
  // session create→complete delta. Clamp ≥ 0 (clock-skew safety).
  const signupAt = asString(signals.attribution?.created_at);
  let latencySeconds: number | null = null;
  if (signupAt) {
    const s = Math.floor(new Date(signupAt).getTime() / 1000);
    if (Number.isFinite(s)) latencySeconds = Math.max(0, signals.convertedAtEpoch - s);
  } else if (typeof session?.created === 'number') {
    latencySeconds = Math.max(0, signals.convertedAtEpoch - session.created);
  }

  // cold_subscribe = email present AND no free-tier opt-in AND no upgrade-CTA
  // bridge. Honest NULL when email is absent (indeterminable).
  const coldSubscribe = email ? (!signals.hasOptin && !signals.hasUpgradeCta) : null;

  const amountTotal = typeof session?.amount_total === 'number' ? session.amount_total : null;

  // Billing cadence + the rate it implies (OPS-STRIPE-SUBSCRIPTION-TRUTH-W1).
  // `createCheckoutSession` stamps `metadata.billing_interval` on every checkout since
  // PRICING-ANNUAL-AND-HOLD-PROMISE-W1, so this is the session's own declared cadence rather
  // than anything inferred from the amount. Absent (the pre-annual cohort) ⇒ `unknown`, which
  // CH4 resolves from Stripe — never guessed here.
  const tier = asString(session?.metadata?.tier);
  const billingInterval = normalizeBillingInterval(session?.metadata?.billing_interval);

  return {
    customerId,
    email,
    name: asString(cd.name),
    subscriptionId: typeof session?.subscription === 'string'
      ? session.subscription
      : asString(session?.subscription?.id),
    tier,
    status: 'active', // checkout.session.completed ⇒ the subscription is live
    amountUsd: amountTotal != null ? Math.round(amountTotal) / 100 : null,
    billingInterval,
    monthlyRateUsd: deriveMonthlyRateUsd(tier, billingInterval),
    currency: asString(session?.currency),
    channel,
    country,
    countrySource,
    clientReferenceId,
    signupAt,
    convertedAt: new Date(signals.convertedAtEpoch * 1000).toISOString(),
    latencySeconds,
    coldSubscribe,
    attributionCaptured,
    riskLevel: signals.riskLevel ?? null,
  };
}

// ── CONVERSION-MEASUREMENT-W1 C2: best-effort pre-conversion bridge ──────────
//
// Links a paid conversion back to the customer's PRE-conversion FREE usage, as
// far as is structurally possible, with an HONEST confidence per match path
// (Factuality LAW — never fabricate a bridge):
//   deterministic — track-token (the analytics session_id derives from it under
//                   the stateless transport) OR a known free-tier email opt-in
//                   (signup_emails).
//   probabilistic — ip_hash only (the /signup click IP; NAT-shared → inferred).
//   none          — no link found (e.g. a COLD /signup with no opt-in + no
//                   attribution row — the honest answer for the lone existing
//                   subscriber).
// All metrics are best-effort from the strongest available usage key and null
// when unresolvable. NO PII stored — counts / pct / a confidence label only.

const TRACK_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Bridge columns added to subscriber_profiles (migration 013). PG ADD COLUMN IF
// NOT EXISTS is natively idempotent; SQLite has none, so it needs a
// PRAGMA table_info() pre-check (CLAUDE.md DB/migrations rule).
const SUBSCRIBER_BRIDGE_COLUMNS: { column: string; pgType: string; sqliteType: string }[] = [
  { column: 'pre_conversion_calls', pgType: 'INTEGER', sqliteType: 'INTEGER' },
  { column: 'pre_conversion_sessions', pgType: 'INTEGER', sqliteType: 'INTEGER' },
  { column: 'time_to_first_call_s', pgType: 'INTEGER', sqliteType: 'INTEGER' },
  { column: 'peak_quota_pct', pgType: 'NUMERIC(6,2)', sqliteType: 'REAL' },
  { column: 'bridge_confidence', pgType: 'TEXT', sqliteType: 'TEXT' },
];

// Interval columns added to subscriber_profiles (migration 027,
// OPS-STRIPE-SUBSCRIPTION-TRUTH-W1). Same dual-backend shape as the bridge columns above: PG
// has ADD COLUMN IF NOT EXISTS, SQLite does not.
//
// `billing_interval` carries a DEFAULT of 'unknown' rather than 'month' — an existing row's
// cadence has not been established, and the honest default is the one that says so. See
// `StoredBillingInterval`.
const SUBSCRIBER_INTERVAL_COLUMNS: { column: string; pgType: string; sqliteType: string }[] = [
  { column: 'billing_interval', pgType: "TEXT NOT NULL DEFAULT 'unknown'", sqliteType: "TEXT NOT NULL DEFAULT 'unknown'" },
  { column: 'monthly_rate_usd', pgType: 'NUMERIC(10,4)', sqliteType: 'REAL' },
];

let _intervalColumnsInit = false;
/**
 * Idempotently add the 2 interval columns. PROD pre-applies migration 027 via SSH BEFORE the
 * deploy, so this is a no-op there (the PG pre-check finds them present); tests (SQLite) add
 * them on first call. Safe to call repeatedly. Mirrors `ensureSubscriberBridgeColumns`.
 */
export async function ensureSubscriberIntervalColumns(): Promise<void> {
  if (_intervalColumnsInit) return;
  ensureSubscriberProfilesSchema();
  if (PG) {
    dbExec(
      SUBSCRIBER_INTERVAL_COLUMNS
        .map((c) => `ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS ${c.column} ${c.pgType};`)
        .join('\n'),
    );
  } else {
    const rows = await dbQuery<{ name: string }>(`PRAGMA table_info(subscriber_profiles)`, []);
    const existing = new Set(rows.map((r) => r.name));
    const missing = SUBSCRIBER_INTERVAL_COLUMNS.filter((c) => !existing.has(c.column));
    if (missing.length > 0) {
      dbExec(missing.map((c) => `ALTER TABLE subscriber_profiles ADD COLUMN ${c.column} ${c.sqliteType};`).join('\n'));
    }
  }
  _intervalColumnsInit = true;
}

/** Reset the interval-column-init latch — tests only. */
export function _resetIntervalColumnsInitForTest(): void {
  _intervalColumnsInit = false;
}

let _bridgeColumnsInit = false;
/**
 * Idempotently add the 5 bridge columns. PROD pre-applies migration 013 via SSH
 * BEFORE the deploy, so this is a no-op there (pre-check finds them present);
 * tests (SQLite) add them on first call. Safe to call repeatedly.
 */
export async function ensureSubscriberBridgeColumns(): Promise<void> {
  if (_bridgeColumnsInit) return;
  ensureSubscriberProfilesSchema();
  if (PG) {
    // PG: ADD COLUMN IF NOT EXISTS is natively idempotent — bundle one call.
    dbExec(
      SUBSCRIBER_BRIDGE_COLUMNS
        .map((c) => `ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS ${c.column} ${c.pgType};`)
        .join('\n'),
    );
  } else {
    // SQLite: no IF NOT EXISTS — PRAGMA pre-check, add only missing columns.
    const rows = await dbQuery<{ name: string }>(`PRAGMA table_info(subscriber_profiles)`, []);
    const existing = new Set(rows.map((r) => r.name));
    const missing = SUBSCRIBER_BRIDGE_COLUMNS.filter((c) => !existing.has(c.column));
    if (missing.length > 0) {
      dbExec(missing.map((c) => `ALTER TABLE subscriber_profiles ADD COLUMN ${c.column} ${c.sqliteType};`).join('\n'));
    }
  }
  _bridgeColumnsInit = true;
}

/** Reset the column-init latch — tests only. */
export function _resetBridgeColumnsInitForTest(): void {
  _bridgeColumnsInit = false;
}

export type BridgeConfidence = 'deterministic' | 'probabilistic' | 'none';

export interface BridgeResult {
  preConversionCalls: number | null;
  preConversionSessions: number | null;
  /** Seconds from the first pre-conversion call to conversion (free tenure). */
  timeToFirstCallS: number | null;
  /** max(call_count)/free_monthly_quota*100 over the linked ip_hash(es). */
  peakQuotaPct: number | null;
  bridgeConfidence: BridgeConfidence;
}

export interface BridgeInput {
  email: string | null;
  clientReferenceId: string | null;
  trackToken: string | null;
  convertedAtEpoch: number;
}

export interface BridgeDeps {
  query: <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;
  freeMonthlyQuota: number;
}

const makeDefaultBridgeDeps = (): BridgeDeps => ({ query: dbQuery, freeMonthlyQuota: getMonthlyQuota('free') });

function bridgeSafeInt(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; }
  return 0;
}

function bridgeToEpochSeconds(ts: unknown): number | null {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Resolve the best-effort pre-conversion usage bridge for a conversion. I/O is
 * injected via `deps.query` (unit-testable with a table-routing mock). NEVER
 * throws — any error yields an all-null / 'none' result (fail-open; the webhook
 * must still ACK and the entitlement grant is unaffected).
 */
export async function resolvePreConversionBridge(
  input: BridgeInput,
  deps: BridgeDeps = makeDefaultBridgeDeps(),
): Promise<BridgeResult> {
  const EMPTY: BridgeResult = {
    preConversionCalls: null, preConversionSessions: null, timeToFirstCallS: null,
    peakQuotaPct: null, bridgeConfidence: 'none',
  };
  try {
    const convIso = new Date(input.convertedAtEpoch * 1000).toISOString();
    const token = typeof input.trackToken === 'string' && TRACK_TOKEN_RE.test(input.trackToken) ? input.trackToken : null;

    // (1) email opt-in → deterministic identity.
    let emailOptin = false;
    if (input.email) {
      const r = await deps.query<{ one: number }>(
        `SELECT 1 AS one FROM signup_emails WHERE lower(email) = lower(?) LIMIT 1`, [input.email]);
      emailOptin = r.length > 0;
    }

    // (2) ip_hash from the /signup click → probabilistic linkage.
    let attrIpHash: string | null = null;
    if (input.clientReferenceId) {
      const r = await deps.query<{ ip_hash: string | null }>(
        `SELECT ip_hash FROM signup_attribution WHERE client_reference_id = ? LIMIT 1`, [input.clientReferenceId]);
      attrIpHash = (r[0]?.ip_hash as string | null) ?? null;
    }

    // (3) usage via the track-token session (session_id derives from the token).
    let tokenCalls = 0; let tokenFirstCall: string | null = null; let tokenIpHash: string | null = null;
    if (token) {
      const r = await deps.query<{ calls: number | string; first_call: string | null; ip_hash: string | null }>(
        `SELECT COUNT(*) AS calls, MIN(timestamp) AS first_call, MIN(ip_hash) AS ip_hash
           FROM request_log
          WHERE session_id = ? AND is_bot_internal = false AND timestamp < ?`,
        [token, convIso]);
      tokenCalls = bridgeSafeInt(r[0]?.calls);
      tokenFirstCall = (r[0]?.first_call as string | null) ?? null;
      tokenIpHash = (r[0]?.ip_hash as string | null) ?? null;
    }

    // (4) usage via the click ip_hash.
    let ipCalls = 0; let ipSessions = 0; let ipFirstCall: string | null = null;
    if (attrIpHash) {
      const r = await deps.query<{ calls: number | string; sessions: number | string; first_call: string | null }>(
        `SELECT COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions, MIN(timestamp) AS first_call
           FROM request_log
          WHERE ip_hash = ? AND is_bot_internal = false AND timestamp < ?`,
        [attrIpHash, convIso]);
      ipCalls = bridgeSafeInt(r[0]?.calls);
      ipSessions = bridgeSafeInt(r[0]?.sessions);
      ipFirstCall = (r[0]?.first_call as string | null) ?? null;
    }

    // (5) peak_quota_pct from quota_usage (keyed free:<ipHash>) over any candidate ip.
    const ipCandidates = Array.from(new Set([attrIpHash, tokenIpHash].filter((h): h is string => !!h)));
    let peakQuotaPct: number | null = null;
    if (ipCandidates.length > 0 && deps.freeMonthlyQuota > 0) {
      const keys = ipCandidates.map((h) => `free:${h}`);
      const placeholders = keys.map(() => '?').join(',');
      const r = await deps.query<{ max_calls: number | string | null }>(
        `SELECT MAX(call_count) AS max_calls FROM quota_usage WHERE tracker_key IN (${placeholders})`, keys);
      const maxCalls = r[0]?.max_calls;
      if (maxCalls != null) peakQuotaPct = Math.round((bridgeSafeInt(maxCalls) / deps.freeMonthlyQuota) * 10000) / 100;
    }

    // (6) decide confidence + project metrics from the strongest available link.
    let confidence: BridgeConfidence;
    let calls: number | null = null; let sessions: number | null = null; let firstCall: string | null = null;
    if (token && tokenCalls > 0) {
      confidence = 'deterministic'; calls = tokenCalls; sessions = 1; firstCall = tokenFirstCall;
    } else if (emailOptin) {
      confidence = 'deterministic';
      if (attrIpHash && ipCalls > 0) { calls = ipCalls; sessions = ipSessions; firstCall = ipFirstCall; }
    } else if (attrIpHash && (ipCalls > 0 || peakQuotaPct != null)) {
      confidence = 'probabilistic'; calls = ipCalls; sessions = ipSessions; firstCall = ipFirstCall;
    } else {
      return { ...EMPTY, peakQuotaPct };
    }

    const firstCallEpoch = bridgeToEpochSeconds(firstCall);
    const timeToFirstCallS = firstCallEpoch == null ? null : Math.max(0, Math.floor(input.convertedAtEpoch - firstCallEpoch));

    return {
      preConversionCalls: calls,
      preConversionSessions: sessions,
      timeToFirstCallS,
      peakQuotaPct,
      bridgeConfidence: confidence,
    };
  } catch (err) {
    console.warn('[resolvePreConversionBridge] failed (fail-open):', err instanceof Error ? err.message : err);
    return EMPTY;
  }
}

export interface ProfileDeps {
  ensure: () => void;
  query: <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;
  run: (sql: string, ...params: unknown[]) => void;
  /** Optional best-effort tier-1 geo + risk (card-issuing / Link country). */
  resolveCardGeo?: (customerId: string) => Promise<{ country: string | null; riskLevel: string | null } | null>;
  /** Conversion epoch override (sec) — for deterministic tests/backfill. */
  nowEpoch?: number;
  /**
   * Optional async hook that idempotently ensures the C2 bridge columns exist.
   * Present on the default deps (prod); tests that inject a full deps object
   * omit it (the columns are pre-applied or irrelevant to the assertion).
   */
  ensureBridge?: () => Promise<void>;
  /**
   * Optional async hook that idempotently ensures the migration-027 interval columns exist.
   * Same contract as `ensureBridge`: present on the default deps (prod), omitted by tests that
   * inject a full deps object.
   */
  ensureInterval?: () => Promise<void>;
}
const defaultProfileDeps: ProfileDeps = {
  ensure: () => { ensureSubscriberProfilesSchema(); ensureSignupAttributionSchema(); },
  query: dbQuery,
  run: dbRun,
  ensureBridge: ensureSubscriberBridgeColumns,
  ensureInterval: ensureSubscriberIntervalColumns,
};

/**
 * Conversion-time auto-profiler — the productized SUBSCRIBER-ATTRIBUTION-
 * DIAGNOSIS-W1. Called from the checkout.session.completed case AFTER
 * tryClaimEvent (so a webhook replay never re-profiles), and ALSO idempotent on
 * subscriber_profiles.customer_id (ON CONFLICT DO UPDATE). Fail-open: any error
 * is swallowed + logged so the webhook still 200s and the entitlement grant is
 * never affected.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildSubscriberProfile(session: any, deps: ProfileDeps = defaultProfileDeps): Promise<void> {
  try {
    const customerId = typeof session?.customer === 'string'
      ? session.customer
      : asString(session?.customer?.id);
    if (!customerId) {
      console.warn('[buildSubscriberProfile] no customer id on session — skipping (fail-open)');
      return;
    }
    deps.ensure();
    if (deps.ensureBridge) await deps.ensureBridge();
    if (deps.ensureInterval) await deps.ensureInterval();

    const clientReferenceId = asString(session?.client_reference_id);
    const email = asString(session?.customer_details?.email) ?? asString(session?.customer_email);

    // (1) channel via JOIN signup_attribution by client_reference_id
    let attribution: { channel: string; created_at: string } | null = null;
    if (clientReferenceId) {
      const rows = await deps.query<{ channel: string; created_at: unknown }>(
        'SELECT channel, created_at FROM signup_attribution WHERE client_reference_id = ?',
        [clientReferenceId],
      );
      // `created_at` is read from a `timestamptz` column and bound straight back into `signup_at`.
      // `String(aDate)` produces a form Postgres cannot parse (22007) — see toIsoTimestamp.
      // `?? ''` preserves the previous shape for the `string` type while a null/invalid timestamp
      // degrades to the empty string, which `asString` in assembleProfile maps back to `signupAt: null`
      // (the same outcome as before) rather than to a bind Postgres would reject.
      if (rows.length > 0) attribution = { channel: String(rows[0].channel), created_at: toIsoTimestamp(rows[0].created_at) ?? '' };
    }
    // (2) cold-subscribe signals: free-tier opt-in + upgrade-CTA bridge
    let hasOptin = false;
    let hasUpgradeCta = false;
    if (email) {
      const optin = await deps.query('SELECT 1 AS one FROM signup_emails WHERE lower(email) = lower(?) LIMIT 1', [email]);
      hasOptin = optin.length > 0;
    }
    if (clientReferenceId) {
      const cta = await deps.query(
        "SELECT 1 AS one FROM funnel_events WHERE event_type = 'upgrade_cta_clicked' AND session_id = ? LIMIT 1",
        [clientReferenceId],
      );
      hasUpgradeCta = cta.length > 0;
    }
    // (3) optional tier-1 geo + risk (best-effort; never blocks/throws)
    let cardCountry: string | null = null;
    let riskLevel: string | null = null;
    if (deps.resolveCardGeo) {
      try {
        const g = await deps.resolveCardGeo(customerId);
        cardCountry = g?.country ?? null;
        riskLevel = g?.riskLevel ?? null;
      } catch (e) {
        console.warn('[buildSubscriberProfile] card-geo enrich failed (fall back to billing):', e instanceof Error ? e.message : e);
      }
    }

    const nowEpoch = deps.nowEpoch ?? Math.floor(Date.now() / 1000);
    const p = assembleProfile(session, { attribution, hasOptin, hasUpgradeCta, cardCountry, riskLevel, convertedAtEpoch: nowEpoch });

    // CONVERSION-MEASUREMENT-W1 C2: best-effort pre-conversion usage bridge via
    // the SAME injected query seam. The track-token (when present) rides Stripe
    // session metadata. Honest confidence; resolver is fail-open (never throws).
    const trackToken = asString(session?.metadata?.track_token);
    const bridge = await resolvePreConversionBridge(
      { email, clientReferenceId, trackToken, convertedAtEpoch: nowEpoch },
      { query: deps.query, freeMonthlyQuota: getMonthlyQuota('free') },
    );

    deps.run(
      `INSERT INTO subscriber_profiles
        (customer_id, email, name, subscription_id, tier, status, amount_usd, currency, channel, country, country_source,
         client_reference_id, signup_at, converted_at, latency_seconds, cold_subscribe, attribution_captured, risk_level,
         pre_conversion_calls, pre_conversion_sessions, time_to_first_call_s, peak_quota_pct, bridge_confidence,
         billing_interval, monthly_rate_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (customer_id) DO UPDATE SET
         email = EXCLUDED.email, name = EXCLUDED.name, subscription_id = EXCLUDED.subscription_id,
         tier = EXCLUDED.tier, status = EXCLUDED.status, amount_usd = EXCLUDED.amount_usd, currency = EXCLUDED.currency,
         channel = EXCLUDED.channel, country = EXCLUDED.country, country_source = EXCLUDED.country_source,
         client_reference_id = EXCLUDED.client_reference_id, signup_at = EXCLUDED.signup_at,
         converted_at = EXCLUDED.converted_at, latency_seconds = EXCLUDED.latency_seconds,
         cold_subscribe = EXCLUDED.cold_subscribe, attribution_captured = EXCLUDED.attribution_captured,
         risk_level = EXCLUDED.risk_level,
         pre_conversion_calls = EXCLUDED.pre_conversion_calls,
         pre_conversion_sessions = EXCLUDED.pre_conversion_sessions,
         time_to_first_call_s = EXCLUDED.time_to_first_call_s,
         peak_quota_pct = EXCLUDED.peak_quota_pct,
         bridge_confidence = EXCLUDED.bridge_confidence,
         billing_interval = EXCLUDED.billing_interval,
         monthly_rate_usd = EXCLUDED.monthly_rate_usd`,
      p.customerId, p.email, p.name, p.subscriptionId, p.tier, p.status, p.amountUsd, p.currency, p.channel,
      p.country, p.countrySource, p.clientReferenceId, p.signupAt, p.convertedAt, p.latencySeconds,
      p.coldSubscribe, p.attributionCaptured, p.riskLevel,
      bridge.preConversionCalls, bridge.preConversionSessions, bridge.timeToFirstCallS, bridge.peakQuotaPct, bridge.bridgeConfidence,
      p.billingInterval, p.monthlyRateUsd,
    );
    console.log(`[buildSubscriberProfile] profiled ${p.customerId} channel=${p.channel} country=${p.country ?? '?'}/${p.countrySource ?? '-'} cold=${p.coldSubscribe} captured=${p.attributionCaptured} bridge=${bridge.bridgeConfidence} calls=${bridge.preConversionCalls ?? '-'}`);
  } catch (err) {
    console.error('[buildSubscriberProfile] failed (fail-open):', err instanceof Error ? err.message : err);
  }
}

/** What `applySubscriptionRecordUpdate` did. `absent` is a fact, not a failure. */
export type RecordUpdateOutcome = 'updated' | 'noop' | 'absent';

/** The subscription facts a lifecycle event carries. Every field optional — absent = "unchanged". */
export interface SubscriptionRecordUpdate {
  customerId: string;
  /** Resolved from the Stripe PRICE ID via the registry — never from event prose. */
  tier?: string | null;
  billingInterval?: StoredBillingInterval;
  /** Read from the event's own `status`, never a literal we invent. */
  status?: string | null;
  subscriptionId?: string | null;
}

/**
 * Bring an EXISTING subscriber profile in line with a subscription lifecycle event.
 * OPS-STRIPE-SUBSCRIPTION-TRUTH-W2 CH2.
 *
 * WHY THIS EXISTS. `subscriber_profiles` was written once, at `checkout.session.completed`, and
 * never again. A customer who upgraded starter→pro on 2026-07-17 still read `starter`/$9.99 while
 * Stripe billed $49 — **$39.01/mo, 49.4% of true MRR, invisible** — and a cancellation would have
 * left `status` reading `'active'` forever, which makes MRR OVER-count. Both are reporting
 * defects only: `validateApiKey` resolves tier live from the price id, so entitlement and billing
 * were always correct.
 *
 * 🛑 **UPDATE-ONLY. It never INSERTs.** A profile is created by the checkout path, which is the
 * only place the attribution signals (channel, country, cold/warm, latency, the bridge) exist. A
 * lifecycle event carries none of them, so inventing a row here would manufacture a profile whose
 * every attribution column is a fabrication. `absent` is returned and the caller logs it.
 *
 * 🛑 **NO-OPS when nothing that matters changed.** `customer.subscription.updated` fires for trial
 * changes, payment-method updates, metadata edits and cancel-at-period-end — none of which move
 * money. Rewriting the row on those would churn it on noise and make the reconciliation canary
 * alarm on our own writes. Both dimensions are compared, so a monthly→annual switch (real money,
 * newly possible since 2026-08-05) is NOT a silent no-op.
 *
 * 🛑 **Verified by RESULT, not by a success log.** `dbRun` is fire-and-forget on Postgres — that
 * is exactly how `buildSubscriberProfile` lost 100% of production writes with every assertion
 * green (SEC-14). The write goes through the awaited `query` seam and the row is READ BACK before
 * `updated` is returned; a write that did not land reports `noop`, never a false success.
 */
export async function applySubscriptionRecordUpdate(
  u: SubscriptionRecordUpdate,
  deps: ProfileDeps = defaultProfileDeps,
): Promise<RecordUpdateOutcome> {
  deps.ensure();
  if (deps.ensureInterval) await deps.ensureInterval();

  const rows = await deps.query<{ tier: string | null; status: string | null; billing_interval: string | null }>(
    `SELECT tier, status, billing_interval FROM subscriber_profiles WHERE customer_id = ?`,
    [u.customerId],
  );
  if (rows.length === 0) return 'absent';
  const cur = rows[0];

  // An absent field means "this event says nothing about that dimension" — keep what is stored.
  const tier = u.tier ?? cur.tier;
  const interval: StoredBillingInterval = u.billingInterval ?? normalizeBillingInterval(cur.billing_interval);
  const status = u.status ?? cur.status;

  const unchanged =
    tier === cur.tier &&
    interval === normalizeBillingInterval(cur.billing_interval) &&
    status === cur.status;
  if (unchanged) return 'noop';

  // The rate is DERIVED from the (tier, interval) pair, never carried by the event and never
  // arithmetic on amount_usd. amount_usd itself is NOT touched: it records what was charged on a
  // date, which stays true regardless of what the subscription later became.
  const monthlyRateUsd = deriveMonthlyRateUsd(tier, interval);

  await deps.query(
    `UPDATE subscriber_profiles
        SET tier = ?, status = ?, billing_interval = ?, monthly_rate_usd = ?
      WHERE customer_id = ?`,
    [tier, status, interval, monthlyRateUsd, u.customerId],
  );

  // Verify by RESULT — re-read before claiming success.
  const after = await deps.query<{ tier: string | null; status: string | null; billing_interval: string | null }>(
    `SELECT tier, status, billing_interval FROM subscriber_profiles WHERE customer_id = ?`,
    [u.customerId],
  );
  const a = after[0];
  const landed = !!a && a.tier === tier && a.status === status
    && normalizeBillingInterval(a.billing_interval) === interval;
  if (!landed) {
    console.error(`[applySubscriptionRecordUpdate] write did NOT land for ${u.customerId} — read-back mismatch (fire-and-forget hazard)`);
    return 'noop';
  }
  console.log(`[applySubscriptionRecordUpdate] ${u.customerId} tier=${cur.tier}→${tier} interval=${normalizeBillingInterval(cur.billing_interval)}→${interval} status=${cur.status}→${status}`);
  return 'updated';
}

/**
 * CONVERSION-MEASUREMENT-W1 C2: one-shot backfill of the bridge columns for
 * existing subscribers (those with a NULL bridge_confidence). Re-resolves the
 * pre-conversion bridge from each row's stored email / client_reference_id /
 * converted_at and UPDATEs the 5 columns. Idempotent (only touches still-NULL
 * rows); fail-open per row. Returns the count of rows updated.
 *
 * Host post-deploy:
 *   docker exec <ctr> node -e "import('./dist/lib/subscriber-attribution.js') \
 *     .then(m => m.backfillSubscriberBridges()) \
 *     .then(n => { console.log('backfilled', n); process.exit(0); }) \
 *     .catch(e => { console.error(e); process.exit(1); })"
 *
 * _(Corrected 2026-08-05 REVENUE-METER-TRUTH-W5 CH4 — this prescribed
 * `node dist/scripts/backfill-subscriber-bridges.js`, a path that CANNOT exist: `tsconfig.json` is
 * `rootDir: "src"` / `include: ["src/**​/*"]`, so the repo-root `scripts/` wrapper is never compiled,
 * and the container holds zero such file (probed live). The wrapper's OWN header already carried the
 * correct form above — it says "scripts/ is outside tsc rootDir" and "the container prunes tsx" — so
 * this docblock has contradicted its own sibling since CONVERSION-MEASUREMENT-W1. The backfill itself
 * was always runnable; only this instruction was dead.)_
 */
export async function backfillSubscriberBridges(deps: ProfileDeps = defaultProfileDeps): Promise<number> {
  if (deps.ensureBridge) await deps.ensureBridge();
  const rows = await deps.query<{ customer_id: string; email: string | null; client_reference_id: string | null; converted_at: string | null }>(
    `SELECT customer_id, email, client_reference_id, converted_at
       FROM subscriber_profiles
      WHERE bridge_confidence IS NULL`, []);
  let updated = 0;
  for (const row of rows) {
    try {
      const raw = row.converted_at ? Math.floor(new Date(row.converted_at).getTime() / 1000) : NaN;
      const convertedEpoch = Number.isFinite(raw) ? raw : Math.floor(Date.now() / 1000);
      const bridge = await resolvePreConversionBridge(
        { email: row.email, clientReferenceId: row.client_reference_id, trackToken: null, convertedAtEpoch: convertedEpoch },
        { query: deps.query, freeMonthlyQuota: getMonthlyQuota('free') },
      );
      const updateSql =
        `UPDATE subscriber_profiles
            SET pre_conversion_calls = ?, pre_conversion_sessions = ?, time_to_first_call_s = ?,
                peak_quota_pct = ?, bridge_confidence = ?
          WHERE customer_id = ?`;
      const updateParams = [
        bridge.preConversionCalls, bridge.preConversionSessions, bridge.timeToFirstCallS,
        bridge.peakQuotaPct, bridge.bridgeConfidence, row.customer_id,
      ];
      // PG `dbRun` is FIRE-AND-FORGET; this one-shot backfill runs in a
      // SHORT-LIVED process that exits before such a write flushes (the live
      // webhook path is fine — its server process is long-lived). So on PG AWAIT
      // a durable write (dbQuery → awaited pool.query). SQLite dbRun is sync +
      // durable; tests inject deps.run and exercise this branch.
      if (PG) {
        await deps.query(updateSql, updateParams);
      } else {
        deps.run(updateSql, ...updateParams);
      }
      updated += 1;
      console.log(`[backfillSubscriberBridges] ${row.customer_id} → bridge=${bridge.bridgeConfidence} calls=${bridge.preConversionCalls ?? '-'} peak=${bridge.peakQuotaPct ?? '-'}`);
    } catch (err) {
      console.warn(`[backfillSubscriberBridges] ${row.customer_id} failed (fail-open):`, err instanceof Error ? err.message : err);
    }
  }
  return updated;
}

// ── C3: operator admin tracker (read + aggregate + PII-free shell) ───────────

export interface SubscriberProfileRow {
  customer_id: string;
  email: string | null;
  name: string | null;
  subscription_id: string | null;
  tier: string | null;
  status: string | null;
  amount_usd: number | null;
  currency: string | null;
  channel: string | null;
  country: string | null;
  country_source: string | null;
  client_reference_id: string | null;
  signup_at: string | null;
  converted_at: string | null;
  latency_seconds: number | null;
  cold_subscribe: boolean | null;
  attribution_captured: boolean | null;
  risk_level: string | null;
  // CONVERSION-MEASUREMENT-W1 C2 bridge columns (additive; non-PII).
  pre_conversion_calls: number | null;
  pre_conversion_sessions: number | null;
  time_to_first_call_s: number | null;
  peak_quota_pct: number | null;
  bridge_confidence: string | null;
  // OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 migration-027 columns (additive; non-PII).
  // `billing_interval` is NOT NULL DEFAULT 'unknown' in the schema, but is typed nullable here
  // because a row read back through a backend that predates the column would carry undefined —
  // and a reader must handle "no cadence recorded" identically to 'unknown' either way.
  billing_interval: StoredBillingInterval | null;
  monthly_rate_usd: number | null;
  created_at?: string | null;
}

/** Admin read — newest conversions first. Clamped limit/offset (integers only). */
export async function listSubscriberProfiles(opts: { limit?: number; offset?: number } = {}): Promise<SubscriberProfileRow[]> {
  ensureSubscriberProfilesSchema();
  await ensureSubscriberBridgeColumns();
  await ensureSubscriberIntervalColumns();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  return dbQuery<SubscriberProfileRow>(
    `SELECT customer_id, email, name, subscription_id, tier, status, amount_usd, currency, channel,
            country, country_source, client_reference_id, signup_at, converted_at, latency_seconds,
            cold_subscribe, attribution_captured, risk_level,
            pre_conversion_calls, pre_conversion_sessions, time_to_first_call_s, peak_quota_pct, bridge_confidence,
            billing_interval, monthly_rate_usd,
            created_at
     FROM subscriber_profiles
     ORDER BY converted_at DESC NULLS LAST, created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [],
  );
}

export interface ProfileAggregates {
  total: number;
  byChannel: Record<string, number>;
  byCountry: Record<string, number>;
  cold: number;
  warm: number;
  coldUnknown: number;
}

/** Pure aggregate for the admin header cards (counts by channel / country / cold-warm). */
export function aggregateProfiles(
  rows: Array<{ channel?: string | null; country?: string | null; cold_subscribe?: boolean | null }>,
): ProfileAggregates {
  const byChannel: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  let cold = 0, warm = 0, coldUnknown = 0;
  for (const r of rows) {
    const ch = r.channel || 'unknown';
    byChannel[ch] = (byChannel[ch] ?? 0) + 1;
    const co = r.country || 'unknown';
    byCountry[co] = (byCountry[co] ?? 0) + 1;
    if (r.cold_subscribe === true) cold++;
    else if (r.cold_subscribe === false) warm++;
    else coldUnknown++;
  }
  return { total: rows.length, byChannel, byCountry, cold, warm, coldUnknown };
}

/**
 * Static operator shell for GET /admin/subscribers. Carries ZERO PII: the admin
 * key is prompted client-side, kept in sessionStorage (NEVER the URL or a server
 * log), and sent ONLY as a Bearer header on the XHR to the gated
 * /api/admin/subscribers. PII flows exclusively through that authed XHR, never
 * the server-rendered HTML. (No backticks / ${} inside the embedded JS — avoids
 * template-literal collision per CLAUDE.md.)
 */
export function renderSubscribersAdminHtml(): string {
  const css = [
    ':root{color-scheme:dark}*{box-sizing:border-box}',
    'body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f14;color:#e6edf3}',
    'header{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid #1c2430;background:#0e141b}',
    'h1{font-size:18px;margin:0}.sub{color:#7d8590;font-size:12px}',
    'header button{margin-left:auto;background:#1c2430;color:#e6edf3;border:1px solid #2d3748;border-radius:6px;padding:6px 12px;cursor:pointer}',
    'header button+button{margin-left:8px}',
    '#auth{max-width:520px;margin:48px auto;padding:24px;background:#0e141b;border:1px solid #1c2430;border-radius:10px}',
    '#auth p{color:#9aa5b1}#key{width:100%;padding:10px;margin:8px 0;background:#0b0f14;border:1px solid #2d3748;border-radius:6px;color:#e6edf3}',
    '#load,#auth button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:10px 18px;cursor:pointer;font-weight:600}',
    '.err{color:#f87171;min-height:18px}',
    '.cards{display:flex;flex-wrap:wrap;gap:12px;padding:20px 24px}',
    '.card{background:#0e141b;border:1px solid #1c2430;border-radius:10px;padding:14px 18px;min-width:150px}',
    '.card .n{font-size:24px;font-weight:700}.card .l{color:#7d8590;font-size:12px;text-transform:uppercase;letter-spacing:.04em}',
    '.card .b{color:#9aa5b1;font-size:12px;margin-top:4px}',
    'table{width:calc(100% - 48px);margin:0 24px 40px;border-collapse:collapse;background:#0e141b;border:1px solid #1c2430;border-radius:10px;overflow:hidden}',
    'th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #161d27;font-variant-numeric:tabular-nums}',
    'th{background:#111823;color:#7d8590;font-size:12px;text-transform:uppercase;letter-spacing:.04em}',
    'tbody tr:hover{background:#111823}.cold{color:#60a5fa}.warm{color:#fbbf24}.muted{color:#7d8590}',
  ].join('');

  // Embedded client JS — string-concat only (no backticks, no ${}).
  const js = [
    "(function(){",
    "var KN='av_admin_key';",
    "function $(id){return document.getElementById(id);}",
    "function esc(s){if(s==null)return '';return String(s).replace(/[&<>\"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c];});}",
    "function gk(){try{return sessionStorage.getItem(KN)||'';}catch(e){return '';}}",
    "function sk(k){try{sessionStorage.setItem(KN,k);}catch(e){}}",
    "function ck(){try{sessionStorage.removeItem(KN);}catch(e){}}",
    "function showAuth(msg){$('auth').style.display='block';$('tbl').hidden=true;$('cards').innerHTML='';$('refresh').hidden=true;$('logout').hidden=true;$('err').textContent=msg||'';}",
    "function dur(s){if(s==null)return '-';s=Number(s);if(s<60)return s+'s';if(s<3600)return Math.round(s/60)+'m';return Math.round(s/3600)+'h';}",
    "function money(a,c){if(a==null)return '-';return '$'+Number(a).toFixed(2)+(c&&c!=='usd'?(' '+String(c).toUpperCase()):'');}",
    "function coldCell(v){if(v===true)return '<span class=cold>cold</span>';if(v===false)return '<span class=warm>warm</span>';return '<span class=muted>?</span>';}",
    "function kv(o){var out='';for(var k in o){out+=esc(k)+' '+o[k]+'  ';}return out||'-';}",
    "function render(d){",
    "  var a=d.aggregates||{};",
    "  $('cards').innerHTML=",
    "    card(d.count||0,'Subscribers','')+",
    "    card(a.cold||0,'Cold',(a.warm||0)+' warm / '+(a.coldUnknown||0)+' n-a')+",
    "    card(Object.keys(a.byChannel||{}).length,'Channels',kv(a.byChannel||{}))+",
    "    card(Object.keys(a.byCountry||{}).length,'Countries',kv(a.byCountry||{}));",
    "  var tb=$('tbl').querySelector('tbody');tb.innerHTML='';",
    "  (d.subscribers||[]).forEach(function(s){",
    "    var tr=document.createElement('tr');",
    "    tr.innerHTML='<td>'+esc(s.name)+'</td><td>'+esc(s.email)+'</td><td>'+esc(s.channel)+'</td>'+",
    "      '<td>'+esc(s.country)+'</td><td>'+esc(s.tier)+'</td><td>'+esc(s.status)+'</td>'+",
    "      '<td>'+money(s.amount_usd,s.currency)+'</td><td>'+dur(s.latency_seconds)+'</td>'+",
    "      '<td>'+coldCell(s.cold_subscribe)+'</td><td class=muted>'+esc(s.converted_at)+'</td>';",
    "    tb.appendChild(tr);",
    "  });",
    "  $('auth').style.display='none';$('tbl').hidden=false;$('refresh').hidden=false;$('logout').hidden=false;",
    "}",
    "function card(n,l,b){return '<div class=card><div class=n>'+esc(n)+'</div><div class=l>'+esc(l)+'</div><div class=b>'+esc(b)+'</div></div>';}",
    "function load(){",
    "  var key=gk();if(!key){showAuth();return;}",
    "  fetch('/api/admin/subscribers',{headers:{'Authorization':'Bearer '+key},cache:'no-store'})",
    "   .then(function(r){if(r.status===401){ck();showAuth('Invalid or missing key.');throw new Error('401');}return r.json();})",
    "   .then(render).catch(function(e){if(String(e.message)!=='401')showAuth('Load failed: '+esc(e.message));});",
    "}",
    "$('load').addEventListener('click',function(){var k=$('key').value.trim();if(!k){$('err').textContent='Enter a key.';return;}sk(k);$('key').value='';load();});",
    "$('refresh').addEventListener('click',load);",
    "$('logout').addEventListener('click',function(){ck();showAuth('Key forgotten.');});",
    "if(gk())load();else showAuth();",
    "})();",
  ].join('\n');

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>AlgoVault — Subscriber Tracker (admin)</title>'
    + '<style>' + css + '</style></head><body>'
    + '<header><h1>Subscriber Tracker</h1><span class="sub">attribution spine · operator-only</span>'
    + '<button id="refresh" hidden>Refresh</button><button id="logout" hidden>Forget key</button></header>'
    + '<div id="auth"><p>Paste the admin API key to load subscribers. The key is kept in this tab only '
    + '(sessionStorage) and sent as a Bearer header — never placed in the URL or a server log.</p>'
    + '<input id="key" type="password" placeholder="ADMIN_API_KEY" autocomplete="off">'
    + '<button id="load">Load</button><p id="err" class="err"></p></div>'
    + '<div id="cards" class="cards"></div>'
    + '<table id="tbl" hidden><thead><tr>'
    + '<th>Name</th><th>Email</th><th>Channel</th><th>Country</th><th>Tier</th><th>Status</th>'
    + '<th>$</th><th>Latency</th><th>Cold/Warm</th><th>Converted</th>'
    + '</tr></thead><tbody></tbody></table>'
    + '<script>' + js + '</script></body></html>';
}

/**
 * REVENUE-METER-TRUTH-W5 CH4 — recover the customers the broken producer lost.
 *
 * `buildSubscriberProfile` silently dropped every write carrying an attribution row from 2026-06-08
 * until the 22007 bind fix (see `toIsoTimestamp`). Those conversions are not recoverable from the
 * profile table — it never held them — but they ARE recoverable from `processed_stripe_events`,
 * which recorded each `checkout.session.completed` faithfully, including its `session_id`.
 *
 * This re-runs the REPAIRED producer over each recorded session, so the backfill is a genuine replay
 * of the real path rather than a second, divergent write. `buildSubscriberProfile`'s upsert is
 * `ON CONFLICT (customer_id) DO UPDATE`, so it is idempotent and safe to re-run.
 *
 * ⚠️ **`backfillSubscriberBridges` cannot serve this.** It only `UPDATE`s rows
 * `WHERE bridge_confidence IS NULL` — it can enrich a row that exists, never create one that never
 * landed. Hence a sibling rather than a reuse.
 *
 * The Stripe fetch is INJECTED so this module keeps zero dependency on `stripe.ts` (no import cycle,
 * and the whole thing stays unit-testable). Fail-open per session: one unretrievable session must not
 * abort the rest of the recovery.
 *
 * @returns the number of sessions successfully replayed.
 */
export async function backfillMissingSubscriberProfiles(
  opts: { retrieveSession: (sessionId: string) => Promise<unknown> },
  deps: ProfileDeps = defaultProfileDeps,
): Promise<number> {
  deps.ensure();
  const rows = await deps.query<{ session_id: string; event_id: string; processed_at: unknown }>(
    `SELECT session_id, event_id, processed_at FROM processed_stripe_events
      WHERE event_type = 'checkout.session.completed' AND session_id IS NOT NULL
      ORDER BY processed_at`,
    [],
  );
  console.log(`[backfillMissingSubscriberProfiles] ${rows.length} recorded checkout session(s) to replay`);
  let replayed = 0;
  for (const row of rows) {
    try {
      const session = await opts.retrieveSession(row.session_id);
      if (!session) { console.warn(`  ${row.event_id} — session ${row.session_id} not retrievable, skipping`); continue; }
      // Replay the HISTORICAL conversion moment, not "now". `buildSubscriberProfile` defaults
      // `convertedAt` to `Date.now()`, which on a recovery run would stamp every recovered customer
      // with today's date and compute `latency_seconds` as (today - signup) — measured on the first
      // run as 1,579,888s (~18 days) for a conversion that actually took minutes. The webhook
      // ledger's `processed_at` IS the conversion instant, so inject it.
      const at = toIsoTimestamp(row.processed_at);
      const atEpoch = at ? Math.floor(new Date(at).getTime() / 1000) : undefined;
      await buildSubscriberProfile(session, atEpoch ? { ...deps, nowEpoch: atEpoch } : deps);
      replayed++;
      console.log(`  ${row.event_id} — replayed ${row.session_id}`);
    } catch (err) {
      // Fail-open per session: a single unretrievable session must not abort the recovery.
      console.error(`  ${row.event_id} — replay failed (continuing):`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[backfillMissingSubscriberProfiles] replayed=${replayed}/${rows.length}`);
  // 🛑 The caller MUST drain before exiting. `deps.run` is `dbRun`, which is FIRE-AND-FORGET on the
  // PG backend — it returns void and the actual write is a floating promise. Measured on the first
  // run of this very function: 3 sessions logged "profiled", `process.exit(0)` fired immediately,
  // and the LAST write was killed in flight — 2 of 3 landed, with no error anywhere. That is the
  // same fail-open-and-report-success class this whole arc exists to retire, reproduced here.
  // `closeDbAsync()` (performance-db.ts:994) resolves only once in-flight writes have drained;
  // `runScript` does it for you. Never `process.exit` straight after calling this.
  return replayed;
}

/** One row's before/after, for the operator-facing backfill report. */
export interface IntervalBackfillRow {
  customerId: string;
  before: { tier: string | null; interval: string | null; rate: number | null };
  after: { tier: string | null; interval: StoredBillingInterval; rate: number | null };
  changed: boolean;
}

export interface IntervalBackfillReport {
  execute: boolean;
  stripeSubscriptions: number;
  profileRows: number;
  rows: IntervalBackfillRow[];
  written: number;
  /** Post-write re-read. `null` in dry-run. The write is not believed until this matches. */
  verifiedConverged: number | null;
  mrrFromRecord: number | null;
}

/**
 * One-shot convergence of the EXISTING `subscriber_profiles` rows against Stripe.
 * OPS-STRIPE-SUBSCRIPTION-TRUTH-W3 CH2.
 *
 * WHY A BACKFILL AT ALL. W2 fixed the FORWARD path — a tier change, interval change or
 * cancellation now reaches the record — but it could not touch the rows already there, because
 * `applySubscriptionRecordUpdate` is deliberately UPDATE-only and no lifecycle event was ever
 * going to fire for a subscription that simply sits unchanged. Four rows read `starter`/`unknown`
 * against Stripe's 3 starter + 1 pro, all monthly: **−$39.01/mo, 49.4% of MRR, invisible.**
 *
 * Reporting-only, as everywhere in this arc: `validateApiKey` resolves tier live from the Stripe
 * price id, so the mis-recorded customer has always been billed $49 and given pro quota.
 *
 * 🛑 **DRY-RUN BY DEFAULT.** Nothing is written without `execute: true`.
 *
 * 🛑 **VERIFIED BY RE-READ, NOT BY A SUCCESS LOG.** `dbRun` is fire-and-forget on Postgres, and
 * a short-lived process exits before such a write flushes — that is exactly how W5's own backfill
 * logged `profiled` for 3 sessions and landed 2 rows. Every write goes through the AWAITED
 * `query` seam, and the table is re-read and counted before this function returns.
 *
 * 🛑 **NO `Date.now()` ON HISTORICAL FIELDS.** The same W5 run defaulted `convertedAt` to now and
 * stamped every customer with that day's date. `converted_at`, `created_at` and `amount_usd` are
 * NOT in the UPDATE — `amount_usd` in particular records what was charged and stays true.
 *
 * Composes `getStripeClient` + `resolveSubscription` (already exported) rather than adding a
 * per-customer lister to `stripe.ts`; the import is DYNAMIC because
 * `subscriber-attribution` → `license.ts` → `stripe.ts` is a require cycle.
 */
export async function backfillSubscriberIntervals(
  opts: { execute?: boolean } = {},
  deps: ProfileDeps = defaultProfileDeps,
): Promise<IntervalBackfillReport> {
  const execute = opts.execute === true;
  deps.ensure();
  if (deps.ensureInterval) await deps.ensureInterval();

  const { getStripeClient, resolveSubscription } = await import('./stripe.js');
  const stripe = getStripeClient();
  if (!stripe) throw new Error('Stripe is not configured — refusing to backfill against nothing');

  // customerId → what Stripe says they actually bought.
  const truth = new Map<string, { tier: string; interval: StoredBillingInterval }>();
  for await (const sub of stripe.subscriptions.list({ status: 'active', limit: 100 })) {
    const cid = typeof sub.customer === 'string' ? sub.customer : (sub.customer as { id?: string })?.id;
    const r = resolveSubscription(sub as never);
    // An unrecognised price is NOT a tier. Skipping leaves the row untouched and visible to the
    // reconciliation, which is strictly better than writing a guess over it.
    if (cid && r) truth.set(cid, { tier: r.tier, interval: r.interval });
  }

  const existing = await deps.query<{ customer_id: string; tier: string | null; status: string | null; billing_interval: string | null; monthly_rate_usd: number | null }>(
    `SELECT customer_id, tier, status, billing_interval, monthly_rate_usd FROM subscriber_profiles`,
    [],
  );

  const rows: IntervalBackfillRow[] = [];
  for (const row of existing) {
    const t = truth.get(row.customer_id);
    if (!t) continue; // no active Stripe subscription — a cancelled or unknown row; leave it be.
    const rate = deriveMonthlyRateUsd(t.tier, t.interval);
    const changed = row.tier !== t.tier
      || normalizeBillingInterval(row.billing_interval) !== t.interval
      || Number(row.monthly_rate_usd ?? NaN) !== Number(rate ?? NaN);
    rows.push({
      customerId: row.customer_id,
      before: { tier: row.tier, interval: row.billing_interval, rate: row.monthly_rate_usd },
      after: { tier: t.tier, interval: t.interval, rate },
      changed,
    });
  }

  let written = 0;
  if (execute) {
    for (const r of rows) {
      if (!r.changed) continue; // idempotent: a second run finds nothing to do.
      await deps.query(
        `UPDATE subscriber_profiles
            SET tier = ?, billing_interval = ?, monthly_rate_usd = ?
          WHERE customer_id = ?`,
        [r.after.tier, r.after.interval, r.after.rate, r.customerId],
      );
      written++;
    }
  }

  // Verify by RESULT. Re-read and count how many rows now match Stripe.
  let verifiedConverged: number | null = null;
  let mrrFromRecord: number | null = null;
  if (execute) {
    const after = await deps.query<{ customer_id: string; tier: string | null; billing_interval: string | null; monthly_rate_usd: number | null }>(
      `SELECT customer_id, tier, billing_interval, monthly_rate_usd FROM subscriber_profiles`,
      [],
    );
    verifiedConverged = after.filter((a) => {
      const t = truth.get(a.customer_id);
      return !!t && a.tier === t.tier && normalizeBillingInterval(a.billing_interval) === t.interval;
    }).length;
    mrrFromRecord = after.reduce((sum, a) => truth.has(a.customer_id) && a.monthly_rate_usd != null
      ? sum + Number(a.monthly_rate_usd) : sum, 0);
  }

  return {
    execute,
    stripeSubscriptions: truth.size,
    profileRows: existing.length,
    rows,
    written,
    verifiedConverged,
    mrrFromRecord,
  };
}
