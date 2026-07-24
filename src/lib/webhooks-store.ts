/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): webhooks store.
 *
 * Typed, dual-backend (PostgreSQL prod / SQLite local+test) CRUD + idempotency
 * helpers for the hosted outbound webhook delivery service. The `CREATE TABLE
 * IF NOT EXISTS` DDL for `webhook_subscriptions` + `webhook_deliveries` lives in
 * src/lib/performance-db.ts getBackend(); this module is storage logic only —
 * NO HTTP, NO event detection, NO delivery/signing logic (those are
 * webhook-events.ts / webhook-delivery.ts respectively).
 *
 * Idempotency mirrors src/lib/signup-emails-store.ts / stripe-events-store.ts:
 * the delivery ledger's UNIQUE(subscription_id, event_id) + an
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING id` claim guarantees
 * at-most-once enqueue per (subscription, event) even under concurrent fan-out.
 *
 * All writes route through `dbQuery` with a `RETURNING` clause (not the
 * fire-and-forget `dbRun`) so they are awaited on the PG backend and return the
 * affected row on both backends (SQLite 3.35+ supports RETURNING).
 */
import crypto from 'crypto';
import { dbQuery } from './performance-db.js';
import type { ScanCallItem } from './trade-call-scanner.js';

const isPg = (): boolean => !!process.env.DATABASE_URL;

// ── Types ──

export type WebhookEventType = 'trade_call' | 'regime_shift' | 'scan_digest';
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

/**
 * OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 (2026-07-24): the per-SUBSCRIPTION
 * failure-classified lifecycle state (distinct from the per-DELIVERY
 * `DeliveryStatus` above). `delivery_state` is the SoT; the legacy `active`
 * boolean is PROJECTED from it (`active := delivery_state IN ('active',
 * 'degraded')`) so the enqueue `WHERE active` hot-path stays byte-unchanged.
 *   active      — healthy, delivering.
 *   degraded    — failing but still delivering (consecutive_failures climbing,
 *                 below the quarantine threshold); still projects active=true.
 *   quarantined — paused; NOT enqueued; probed on a back-off cadence, auto-resumes
 *                 on a 2xx probe (C4). Projects active=false.
 *   disabled    — terminal; re-registration required. Projects active=false.
 */
export type DeliveryState = 'active' | 'degraded' | 'quarantined' | 'disabled';

/**
 * The projected-active rule — the ONE derivation of `active` from `delivery_state`
 * (single-derivation). Every lifecycle write sets `active` from this in the SAME
 * statement so the two can never drift.
 */
export function isActiveState(state: DeliveryState): boolean {
  return state === 'active' || state === 'degraded';
}

/**
 * The ALLOW-LISTED event snapshot captured at enqueue time and stored in
 * webhook_deliveries.event_data (JSON). The delivery worker rebuilds the public
 * payload from this — it NEVER reads `signals`, so no forbidden Phase-E key
 * (outcome_*, pfe_*, mae_*, return_pct_*, price_after_*) can ever leak.
 *
 * Discriminated on `type`:
 *   - SignalWebhookEventData      — per-signal events (trade_call | regime_shift),
 *     produced by the post-insert detection hook (webhook-events.ts).
 *   - ScanDigestWebhookEventData  — the SCHEDULED whole-market scan digest
 *     (scan_digest), produced by the cadence scheduler (FEATURE-PARITY-CHANNELS-W1
 *     CH2). `calls` is the allow-listed ScanCallItem[] (no Phase-E keys by shape).
 */
export interface SignalWebhookEventData {
  type: 'trade_call' | 'regime_shift';
  coin: string;
  timeframe: string;
  exchange: string;
  call?: string | null;          // BUY | SELL | HOLD — verdict for trade_call
  confidence?: number | null;
  regime?: string | null;        // RegimeType: TRENDING_UP|TRENDING_DOWN|RANGING|VOLATILE
  prior_regime?: string | null;  // regime_shift only
  price_at_call?: number | null; // public rename of signals.price_at_signal
  signal_hash?: string | null;
  created_at: number;            // epoch seconds (of the underlying call row)
}

export interface ScanDigestWebhookEventData {
  type: 'scan_digest';
  cadence: string;               // '1h' | '4h' | '1d' — the delivery cadence bucket
  timeframe: string;             // the scan timeframe (drives cadenceForTimeframe)
  exchange: string;              // the scanned venue
  calls: ScanCallItem[];         // allow-listed ranked non-HOLD calls (no Phase-E keys).
                                 // SCAN-DIGEST-MCP-PARITY-W1 CH2: enriched (price+factors+
                                 // reasoning+oi_change_window via enrichScanCall) — additive.
  generated_at: number;          // epoch seconds (when the digest scan ran)
}

export type WebhookEventData = SignalWebhookEventData | ScanDigestWebhookEventData;

export interface WebhookSubscriptionInput {
  url: string;
  events: WebhookEventType[];
  assets?: string[] | null;       // null/empty = all assets
  timeframes?: string[] | null;   // null/empty = all timeframes (trade_call/regime event filter)
  minConfidence?: number | null;
  tier: string;                   // owner tier at registration (quota sizing)
  ownerKey: string;               // quota tracker key (paid=license.key, free=free:<ipHash>)
  // ── scan_digest scheduled-digest params (FEATURE-PARITY-CHANNELS-W1 CH2; null for signal subs) ──
  cadence?: string | null;        // '1h'|'4h'|'1d'; default = cadenceForTimeframe(timeframe)
  timeframe?: string | null;      // the SINGULAR scan timeframe (distinct from the plural `timeframes` filter)
  exchange?: string | null;       // the scanned venue (default BINANCE)
  topN?: number | null;           // scan universe size (default 20)
}

export interface WebhookSubscription {
  id: number;
  url: string;
  secret: string;
  events: WebhookEventType[];
  assets: string[] | null;
  timeframes: string[] | null;
  min_confidence: number | null;
  tier: string;
  owner_key: string;
  active: boolean;                  // PROJECTED from delivery_state (single-derivation)
  consecutive_failures: number;
  created_at: number;
  last_delivered_at: number | null; // last REAL delivery (unchanged semantics — NOT a probe)
  // OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1: failure-classified lifecycle (additive).
  delivery_state: DeliveryState;    // SoT for `active`
  failure_class: string | null;     // http_410|http_5xx|http_4xx|timeout|conn|egress_block|tls|other|legacy
  quarantined_at: number | null;    // epoch s — when it entered quarantine
  next_probe_at: number | null;     // epoch s — due time for the next health-probe (C4)
  last_probe_at: number | null;     // epoch s — last health-probe attempt (C4)
  last_success_at: number | null;   // epoch s — last 2xx (probe OR real delivery); probe stamps this only
  disabled_reason: string | null;   // permanent_http_410 | quarantine_expired
  // scan_digest params (FEATURE-PARITY-CHANNELS-W1 CH2; null for signal subs)
  cadence: string | null;
  timeframe: string | null;       // SINGULAR scan tf (≠ the plural `timeframes` event filter)
  exchange: string | null;
  top_n: number | null;
}

export interface WebhookDelivery {
  id: number;
  subscription_id: number;
  event_id: string;
  event_type: string;
  event_data: string; // JSON (WebhookEventData)
  status: DeliveryStatus;
  attempts: number;
  last_attempt_at: number | null;
  response_code: number | null;
  created_at: number;
}

// ── Row mappers (normalize PG ↔ SQLite type differences) ──

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

function parseArr(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v as string[];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function mapSubscription(r: Record<string, unknown>): WebhookSubscription {
  return {
    id: num(r.id),
    url: String(r.url),
    secret: String(r.secret),
    events: (parseArr(r.events) ?? []) as WebhookEventType[],
    assets: parseArr(r.assets),
    timeframes: parseArr(r.timeframes),
    min_confidence: numOrNull(r.min_confidence),
    tier: String(r.tier),
    owner_key: String(r.owner_key),
    active: toBool(r.active),
    consecutive_failures: num(r.consecutive_failures),
    created_at: num(r.created_at),
    last_delivered_at: numOrNull(r.last_delivered_at),
    // OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 lifecycle columns. delivery_state
    // defaults to 'active' when absent (pre-migration rows / partial fixtures).
    delivery_state: (r.delivery_state == null ? 'active' : String(r.delivery_state)) as DeliveryState,
    failure_class: r.failure_class == null ? null : String(r.failure_class),
    quarantined_at: numOrNull(r.quarantined_at),
    next_probe_at: numOrNull(r.next_probe_at),
    last_probe_at: numOrNull(r.last_probe_at),
    last_success_at: numOrNull(r.last_success_at),
    disabled_reason: r.disabled_reason == null ? null : String(r.disabled_reason),
    cadence: r.cadence == null ? null : String(r.cadence),
    timeframe: r.timeframe == null ? null : String(r.timeframe),
    exchange: r.exchange == null ? null : String(r.exchange),
    top_n: numOrNull(r.top_n),
  };
}

function mapDelivery(r: Record<string, unknown>): WebhookDelivery {
  return {
    id: num(r.id),
    subscription_id: num(r.subscription_id),
    event_id: String(r.event_id),
    event_type: String(r.event_type),
    event_data: String(r.event_data),
    status: String(r.status) as DeliveryStatus,
    attempts: num(r.attempts),
    last_attempt_at: numOrNull(r.last_attempt_at),
    response_code: numOrNull(r.response_code),
    created_at: num(r.created_at),
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Cryptographically-strong per-subscription HMAC signing secret. */
export function generateSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

// ── Subscriptions CRUD ──

export async function createSubscription(input: WebhookSubscriptionInput): Promise<WebhookSubscription> {
  const secret = generateSecret();
  const events = JSON.stringify(input.events);
  const assets = input.assets && input.assets.length > 0 ? JSON.stringify(input.assets) : null;
  const timeframes = input.timeframes && input.timeframes.length > 0 ? JSON.stringify(input.timeframes) : null;
  const minConfidence = input.minConfidence ?? null;
  const activeVal: unknown = isPg() ? true : 1;
  const createdAt = nowSec();
  // scan_digest params (null for signal subs).
  const cadence = input.cadence ?? null;
  const timeframe = input.timeframe ?? null;
  const exchange = input.exchange ?? null;
  const topN = input.topN ?? null;

  const rows = await dbQuery<Record<string, unknown>>(
    `INSERT INTO webhook_subscriptions
       (url, secret, events, assets, timeframes, min_confidence, tier, owner_key, active, consecutive_failures, created_at, cadence, timeframe, exchange, top_n)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
     RETURNING *`,
    [input.url, secret, events, assets, timeframes, minConfidence, input.tier, input.ownerKey, activeVal, createdAt, cadence, timeframe, exchange, topN],
  );
  if (rows.length === 0) {
    throw new Error('createSubscription: INSERT returned no row');
  }
  return mapSubscription(rows[0]);
}

export async function getSubscription(id: number): Promise<WebhookSubscription | null> {
  const rows = await dbQuery<Record<string, unknown>>(
    'SELECT * FROM webhook_subscriptions WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? mapSubscription(rows[0]) : null;
}

/** List subscriptions, optionally scoped to a single owner (for GET /api/webhooks). */
export async function listSubscriptions(ownerKey?: string): Promise<WebhookSubscription[]> {
  const rows = ownerKey
    ? await dbQuery<Record<string, unknown>>(
        'SELECT * FROM webhook_subscriptions WHERE owner_key = ? ORDER BY created_at DESC',
        [ownerKey],
      )
    : await dbQuery<Record<string, unknown>>(
        'SELECT * FROM webhook_subscriptions ORDER BY created_at DESC',
        [],
      );
  return rows.map(mapSubscription);
}

/** Active subscriptions only — the fan-out candidate set for event detection. */
export async function listActiveSubscriptions(): Promise<WebhookSubscription[]> {
  const activeVal: unknown = isPg() ? true : 1;
  const rows = await dbQuery<Record<string, unknown>>(
    'SELECT * FROM webhook_subscriptions WHERE active = ? ORDER BY id ASC',
    [activeVal],
  );
  return rows.map(mapSubscription);
}

/**
 * Delete a subscription. When `ownerKey` is supplied the delete is scoped to
 * that owner (ownership enforcement for DELETE /api/webhooks/:id). Returns true
 * iff a row was actually deleted.
 */
export async function deleteSubscription(id: number, ownerKey?: string): Promise<boolean> {
  const rows = ownerKey
    ? await dbQuery<{ id: number }>(
        'DELETE FROM webhook_subscriptions WHERE id = ? AND owner_key = ? RETURNING id',
        [id, ownerKey],
      )
    : await dbQuery<{ id: number }>(
        'DELETE FROM webhook_subscriptions WHERE id = ? RETURNING id',
        [id],
      );
  return rows.length > 0;
}

// ── Deliveries (idempotent ledger) ──

/**
 * Idempotently enqueue a delivery for (subscription, event). The UNIQUE
 * (subscription_id, event_id) constraint + ON CONFLICT DO NOTHING guarantee
 * at-most-once enqueue; a duplicate returns `{ claimed: false, deliveryId: null }`.
 */
export async function enqueueDelivery(params: {
  subscriptionId: number;
  eventId: string;
  eventType: WebhookEventType;
  eventData: WebhookEventData;
}): Promise<{ claimed: boolean; deliveryId: number | null }> {
  const rows = await dbQuery<{ id: number }>(
    `INSERT INTO webhook_deliveries
       (subscription_id, event_id, event_type, event_data, status, attempts, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?)
     ON CONFLICT (subscription_id, event_id) DO NOTHING
     RETURNING id`,
    [params.subscriptionId, params.eventId, params.eventType, JSON.stringify(params.eventData), nowSec()],
  );
  if (rows.length === 0) return { claimed: false, deliveryId: null };
  return { claimed: true, deliveryId: num(rows[0].id) };
}

/**
 * Dedup predicate: returns true iff (subscription, event) has NOT yet been
 * enqueued (i.e. it is claimable), false if a delivery row already exists for
 * that key. Pure read — `enqueueDelivery` is the atomic claim.
 */
export async function tryClaimDelivery(subscriptionId: number, eventId: string): Promise<boolean> {
  const rows = await dbQuery<{ id: number }>(
    'SELECT id FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ? LIMIT 1',
    [subscriptionId, eventId],
  );
  return rows.length === 0;
}

/** Oldest pending deliveries first, capped at `limit` — the worker's drain query. */
export async function pendingDeliveries(limit: number): Promise<WebhookDelivery[]> {
  const rows = await dbQuery<Record<string, unknown>>(
    "SELECT * FROM webhook_deliveries WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?",
    [Math.max(1, Math.floor(limit))],
  );
  return rows.map(mapDelivery);
}

/** Update a delivery row's status + attempt bookkeeping after a send attempt. */
export async function markDelivery(
  id: number,
  status: DeliveryStatus,
  opts: { attempts?: number; responseCode?: number | null } = {},
): Promise<void> {
  const attempts = opts.attempts ?? null;
  const responseCode = opts.responseCode ?? null;
  if (attempts !== null) {
    await dbQuery<{ id: number }>(
      'UPDATE webhook_deliveries SET status = ?, attempts = ?, last_attempt_at = ?, response_code = ? WHERE id = ? RETURNING id',
      [status, attempts, nowSec(), responseCode, id],
    );
  } else {
    await dbQuery<{ id: number }>(
      'UPDATE webhook_deliveries SET status = ?, last_attempt_at = ?, response_code = ? WHERE id = ? RETURNING id',
      [status, nowSec(), responseCode, id],
    );
  }
}

// ── Subscription health (auto-disable + recovery) ──

/**
 * Increment a subscription's consecutive-failure counter; auto-disable
 * (active=false) once it reaches `disableAfter`. Returns the post-update state.
 * Recovery is silent (forensic log only, no Telegram) per the alert contract.
 */
export async function bumpFailureAndMaybeDisable(
  subscriptionId: number,
  disableAfter: number,
): Promise<{ disabled: boolean; consecutiveFailures: number }> {
  const rows = await dbQuery<{ consecutive_failures: number | string }>(
    'UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1 WHERE id = ? RETURNING consecutive_failures',
    [subscriptionId],
  );
  const consecutiveFailures = rows.length > 0 ? num(rows[0].consecutive_failures) : 0;
  if (consecutiveFailures >= disableAfter) {
    const inactiveVal: unknown = isPg() ? false : 0;
    await dbQuery<{ id: number }>(
      'UPDATE webhook_subscriptions SET active = ? WHERE id = ? RETURNING id',
      [inactiveVal, subscriptionId],
    );
    return { disabled: true, consecutiveFailures };
  }
  return { disabled: false, consecutiveFailures };
}

/**
 * On a successful REAL delivery: full resume to a healthy state. Resets the
 * failure counter, stamps BOTH `last_delivered_at` AND `last_success_at` (Q3 —
 * a real delivery is also a success signal), returns `delivery_state` to
 * `active`, re-projects `active=true`, and clears the lifecycle scratch fields.
 * A degraded sub that succeeds is thereby healed. (A health-PROBE success — not
 * a real delivery — goes through `recordProbeResult`, which stamps
 * `last_success_at` but NOT `last_delivered_at`.)
 */
export async function recordDeliverySuccess(subscriptionId: number): Promise<void> {
  const activeVal: unknown = isPg() ? true : 1;
  const now = nowSec();
  await dbQuery<{ id: number }>(
    `UPDATE webhook_subscriptions
        SET consecutive_failures = 0, last_delivered_at = ?, last_success_at = ?,
            delivery_state = 'active', active = ?,
            failure_class = NULL, quarantined_at = NULL, next_probe_at = NULL, disabled_reason = NULL
      WHERE id = ? RETURNING id`,
    [now, now, activeVal, subscriptionId],
  );
}

// ── OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1: failure-classified lifecycle ──

/** Lifecycle thresholds (env-overridable; defaults are the Mr.1-ratified prod policy). */
export interface WebhookLifecycleConfig {
  quarantineAfterFailures: number; // consecutive transient failures → quarantined
  probeBackoffBaseSec: number;     // first next_probe_at = quarantined_at + base
  probeBackoffMaxSec: number;      // ceiling for min(base·2^n, max)
  quarantineMaxSec: number;        // 7d no-recovery → disabled(quarantine_expired)
}

function lifecycleEnvInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def; // default-deny on garbage
}

export function loadLifecycleConfig(): WebhookLifecycleConfig {
  return {
    quarantineAfterFailures: lifecycleEnvInt('WEBHOOK_QUARANTINE_AFTER_FAILURES', 10),
    probeBackoffBaseSec: lifecycleEnvInt('WEBHOOK_PROBE_BACKOFF_BASE_SEC', 300),
    probeBackoffMaxSec: lifecycleEnvInt('WEBHOOK_PROBE_BACKOFF_MAX_SEC', 86400),
    quarantineMaxSec: lifecycleEnvInt('WEBHOOK_QUARANTINE_MAX_SEC', 604800),
  };
}

/**
 * The ONE lifecycle-state writer. Sets `delivery_state` + the PROJECTED `active`
 * in the SAME statement (single-derivation — they can never drift), plus any
 * scratch fields whose keys are PRESENT in `opts` (present-with-null clears a
 * column; absent leaves it unchanged). Every transition funnels through here.
 */
export async function setDeliveryState(
  id: number,
  state: DeliveryState,
  opts: {
    failure_class?: string | null;
    disabled_reason?: string | null;
    next_probe_at?: number | null;
    quarantined_at?: number | null;
    last_probe_at?: number | null;
  } = {},
): Promise<void> {
  const sets: string[] = ['delivery_state = ?', 'active = ?'];
  const params: unknown[] = [state, isPg() ? isActiveState(state) : (isActiveState(state) ? 1 : 0)];
  if ('failure_class' in opts) { sets.push('failure_class = ?'); params.push(opts.failure_class ?? null); }
  if ('disabled_reason' in opts) { sets.push('disabled_reason = ?'); params.push(opts.disabled_reason ?? null); }
  if ('next_probe_at' in opts) { sets.push('next_probe_at = ?'); params.push(opts.next_probe_at ?? null); }
  if ('quarantined_at' in opts) { sets.push('quarantined_at = ?'); params.push(opts.quarantined_at ?? null); }
  if ('last_probe_at' in opts) { sets.push('last_probe_at = ?'); params.push(opts.last_probe_at ?? null); }
  params.push(id);
  await dbQuery<{ id: number }>(
    `UPDATE webhook_subscriptions SET ${sets.join(', ')} WHERE id = ? RETURNING id`,
    params,
  );
}

/** Quarantined subs whose probe is due (`next_probe_at <= now`) — the C4 sweep's work set. */
export async function getQuarantinedDue(nowEpoch: number, limit: number): Promise<WebhookSubscription[]> {
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT * FROM webhook_subscriptions
       WHERE delivery_state = 'quarantined' AND next_probe_at IS NOT NULL AND next_probe_at <= ?
       ORDER BY next_probe_at ASC, id ASC LIMIT ?`,
    [nowEpoch, Math.max(1, Math.floor(limit))],
  );
  return rows.map(mapSubscription);
}

/**
 * Record a health-probe outcome (C4). `ok=true` = AUTO-RESUME: full reset to
 * `active` (stamps `last_success_at` + `last_probe_at`, clears the scratch
 * fields), NOT `last_delivered_at` (a probe is not a real delivery — Q3).
 * `ok=false` stamps `last_probe_at` only; the caller computes the next back-off /
 * expiry via `setDeliveryState`.
 */
export async function recordProbeResult(id: number, ok: boolean, nowEpoch: number): Promise<void> {
  if (ok) {
    const activeVal: unknown = isPg() ? true : 1;
    await dbQuery<{ id: number }>(
      `UPDATE webhook_subscriptions
          SET delivery_state = 'active', active = ?, consecutive_failures = 0,
              last_success_at = ?, last_probe_at = ?,
              quarantined_at = NULL, next_probe_at = NULL, failure_class = NULL, disabled_reason = NULL
        WHERE id = ? RETURNING id`,
      [activeVal, nowEpoch, nowEpoch, id],
    );
    return;
  }
  await dbQuery<{ id: number }>(
    'UPDATE webhook_subscriptions SET last_probe_at = ? WHERE id = ? RETURNING id',
    [nowEpoch, id],
  );
}

export interface LifecycleTransition {
  state: DeliveryState;
  consecutiveFailures: number;
  quarantined: boolean;
  disabled: boolean;
}

/**
 * The delivery-failure-side transition — REPLACES `bumpFailureAndMaybeDisable`
 * (C3 wires the single call site). Takes an ALREADY-classified `failureClass`
 * (the C3 `classifyDeliveryFailure` leaf owns the HTTP→class mapping) and applies
 * the ratified lifecycle policy:
 *   - `http_410` (RFC 410 Gone) → `disabled` IMMEDIATELY (`permanent_http_410`) —
 *     the ONLY instant hard-disable (Mr.1 Q4).
 *   - every other class (5xx/4xx/timeout/conn/egress_block/tls/other) is TRANSIENT
 *     → `degraded` until `consecutive_failures` crosses
 *     `WEBHOOK_QUARANTINE_AFTER_FAILURES`, then → `quarantined` (probe-driven
 *     recovery; 7d no-heal → `quarantine_expired` in C4). Quarantine ≠ death.
 */
export async function recordFailureAndTransition(
  id: number,
  failureClass: string,
  nowEpoch: number,
): Promise<LifecycleTransition> {
  const cfg = loadLifecycleConfig();
  // 1) bump the counter + stamp the granular cause (preserved by the setDeliveryState calls below).
  const rows = await dbQuery<{ consecutive_failures: number | string }>(
    'UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1, failure_class = ? WHERE id = ? RETURNING consecutive_failures',
    [failureClass, id],
  );
  const consecutiveFailures = rows.length > 0 ? num(rows[0].consecutive_failures) : 0;

  // 2) PERMANENT — HTTP 410 Gone only.
  if (failureClass === 'http_410') {
    await setDeliveryState(id, 'disabled', { disabled_reason: 'permanent_http_410', next_probe_at: null });
    return { state: 'disabled', consecutiveFailures, quarantined: false, disabled: true };
  }

  // 3) TRANSIENT — quarantine at/after threshold, else degrade (still delivering).
  if (consecutiveFailures >= cfg.quarantineAfterFailures) {
    await setDeliveryState(id, 'quarantined', {
      quarantined_at: nowEpoch,
      next_probe_at: nowEpoch + cfg.probeBackoffBaseSec,
    });
    return { state: 'quarantined', consecutiveFailures, quarantined: true, disabled: false };
  }
  await setDeliveryState(id, 'degraded', {});
  return { state: 'degraded', consecutiveFailures, quarantined: false, disabled: false };
}

/**
 * ONE-TIME idempotent backfill (Mr.1 Q2): legacy one-way-disabled subs (the old
 * `bumpFailureAndMaybeDisable` set `active=false` but never a lifecycle state, so
 * they sit at the column DEFAULT `delivery_state='active'`) are RE-SEEDED as
 * `quarantined` with `next_probe_at=now` so C4's first sweep re-adjudicates them
 * LIVE — recovered endpoints auto-resume (rescues the paying Sub 6), still-dead
 * ones ride the back-off to `quarantine_expired`. NEVER assume legacy-disabled ==
 * permanently gone. Guarded WHERE ⇒ at most once per row; a healthy (active=true)
 * row is never touched, and a row already given a real lifecycle state
 * (disabled/quarantined/degraded by C3/C4) is skipped. Returns rows converted.
 */
export async function backfillLegacyWebhookLifecycle(nowEpoch: number = nowSec()): Promise<number> {
  const falseVal: unknown = isPg() ? false : 0;
  const rows = await dbQuery<{ id: number }>(
    `UPDATE webhook_subscriptions
        SET delivery_state = 'quarantined', failure_class = 'legacy',
            quarantined_at = ?, next_probe_at = ?
      WHERE active = ? AND delivery_state = 'active'
      RETURNING id`,
    [nowEpoch, nowEpoch, falseVal],
  );
  return rows.length;
}
