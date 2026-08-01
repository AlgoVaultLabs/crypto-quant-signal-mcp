/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): webhook delivery worker.
 *
 * Drains pending deliveries, builds the PUBLIC allow-listed payload, HMAC-signs
 * it, POSTs to the subscriber URL with timeout + exponential-backoff retry, and
 * self-heals: marks delivered|failed|dead, and auto-disables an endpoint after
 * WEBHOOK_DISABLE_AFTER_FAILURES consecutive failures. Recovery is SILENT
 * (forensic log only, NO Telegram) per the operator-alert contract.
 *
 * MUST NOT: read raw market data / `signals` (the event snapshot is carried in
 * webhook_deliveries.event_data, so no forbidden Phase-E key can ever leak);
 * touch payments; register routes.
 *
 * Security: never logs the subscriber URL or the per-subscription signing secret
 * (URLs can embed auth tokens — cf. CLAUDE.md token-leak rule). Logs key off
 * delivery.id / subscription_id only.
 */
import crypto from 'crypto';
import { Agent } from 'undici';
import { PKG_VERSION } from './pkg-version.js';
import { checkQuotaByKey, trackCallByKey } from './license.js';
import { resolveAndAssertEgress, EgressBlockedError, type ResolveEgressOpts, type PinnedAddress } from './webhook-ssrf.js';
import type { LicenseTier } from '../types.js';
import type { ScanCallItem } from './trade-call-scanner.js';
import {
  pendingDeliveries,
  markDelivery,
  bumpFailureAndMaybeDisable,
  recordFailureAndTransition,
  recordDeliverySuccess,
  getSubscription,
  getQuarantinedDue,
  recordProbeResult,
  setDeliveryState,
  loadLifecycleConfig,
  type WebhookDelivery,
  type WebhookSubscription,
  type WebhookEventData,
  type WebhookEventType,
  type DeliveryStatus,
  type DeliveryState,
} from './webhooks-store.js';
import { classifyDeliveryFailure, extractErrorCode, type WebhookFailureClass } from './webhook-failure-class.js';
import { quarantineMaxSecFor, quarantineExpiresAt } from './webhook-quarantine-policy.js';
import { notifySubscriberDetached, type NotifyArgs } from './subscriber-notify.js';

/**
 * Call-site guard for every subscriber notification (R4.5).
 *
 * `notifySubscriberDetached` already swallows its own async rejections, so this
 * try/catch is defence in DEPTH, not a duplicate: it also absorbs a SYNCHRONOUS
 * throw — an import-time failure, a future refactor, a bad mock. The invariant this
 * protects is the whole point of the chapter: notifying a subscriber is a side
 * channel, and it must never be able to fail a delivery or abort a sweep. A
 * notification feature that can take the delivery path down is strictly worse than
 * the silence it replaces. Pinned by tests/webhook-notify-isolation.test.ts.
 */
function safeNotify(args: NotifyArgs): void {
  try {
    notifySubscriberDetached(args);
  } catch (err) {
    console.error('[webhook-delivery] notify dispatch failed (swallowed):', err instanceof Error ? err.message : err);
  }
}

/**
 * Billing-month bucket (UTC `YYYYMM` as an int) — the idempotency discriminator for
 * the quota-paused notice. The exhausted branch fires on every drain tick, so
 * without a month bucket a single exhausted owner would be mailed hundreds of times.
 */
function billingMonthBucket(d: Date = new Date()): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

/**
 * Fire the day-1 quarantine warning ONLY on the edge into `quarantined`. A sub that
 * is already quarantined keeps failing probes; notifying on each would be spam, and
 * the idempotency claim would suppress it anyway — but not calling is cheaper and
 * makes the intent explicit at the call site.
 */
function maybeNotifyQuarantined(sub: WebhookSubscription, newState: DeliveryState, nowSec: number): void {
  if (newState !== 'quarantined') return;
  if (sub.delivery_state === 'quarantined') return; // already there — not a new edge
  // `quarantined_at` was just stamped by recordFailureAndTransition; the in-memory
  // `sub` predates it, so anchor the occurrence on now.
  const quarantinedAt = nowSec;
  safeNotify({
    ownerKey: sub.owner_key,
    event: 'webhook_quarantined',
    context: {
      subscriptionId: sub.id,
      stateEpochBucket: quarantinedAt,
      expiresAt: quarantineExpiresAt(quarantinedAt, sub.tier),
      lastSuccessAt: sub.last_success_at,
    },
  });
}

/** Owner-facing hint per post-failure lifecycle state (call-voice, no secrets). */
function transitionSuggestedAction(
  state: DeliveryState,
  failureClass: string,
  attempts: number,
  lastCode: number | null,
  timeoutMs: number,
): string {
  if (state === 'disabled') {
    return `endpoint permanently disabled (${failureClass}) — restore the endpoint, then re-register the subscription`;
  }
  if (state === 'quarantined') {
    return `endpoint quarantined after repeated failures (${failureClass}) — deliveries are paused and auto-resume once a health-probe gets a 2xx; no action needed for a transient outage`;
  }
  return `delivery failed (${failureClass}) after ${attempts} attempts (last status ${lastCode ?? 'network error / timeout'}); ensure your endpoint returns a 2xx within ${timeoutMs}ms`;
}

/**
 * OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1: the auto-recovery firewall. New
 * failure-classified lifecycle behavior (C3 transition + C4 sweep) is gated here.
 * Default ON when the delivery service is on; flip `WEBHOOK_AUTO_RECOVERY_ENABLED`
 * to `0`/`false` for an instant revert to the legacy one-way `bumpFailureAndMaybeDisable`.
 */
export function isAutoRecoveryEnabled(): boolean {
  const v = process.env.WEBHOOK_AUTO_RECOVERY_ENABLED;
  if (v !== undefined) return v !== '0' && v.toLowerCase() !== 'false';
  return process.env.WEBHOOK_DELIVERY_ENABLED === 'true';
}

const WEBHOOK_DOCS_URL = 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/WEBHOOKS.md';

// ── Public payload shape (ALLOW-LIST — no forbidden Phase-E keys) ──

export interface WebhookPayloadData {
  type: 'trade_call' | 'regime_shift';
  coin: string;
  timeframe: string;
  exchange: string;
  call: string | null;
  confidence: number | null;
  regime: string | null;
  prior_regime?: string | null;
  price_at_call: number | null;
  signal_hash: string | null;
  verify_url: string | null;
}

/**
 * FEATURE-PARITY-CHANNELS-W1 CH1 — the public scan_digest payload. ALLOW-LISTED:
 * `calls` is ScanCallItem[] (coin/timeframe/exchange/call/confidence/regime, plus the
 * SCAN-DIGEST-MCP-PARITY-W1 CH2 enrichment — price/factors/reasoning/oi_change_window
 * via enrichScanCall), so no forbidden Phase-E key can leak by shape.
 */
export interface ScanDigestPayloadData {
  type: 'scan_digest';
  cadence: string;
  timeframe: string;
  exchange: string;
  calls: ScanCallItem[];
}

export interface WebhookPayload {
  event: WebhookEventType;
  delivery_id: string;
  created_at: number;
  data: WebhookPayloadData | ScanDigestPayloadData;
  _algovault: {
    service: 'webhook-delivery';
    version: string;
    docs: string;
    disclaimer: string;
  };
}

/**
 * Pure formatter: event snapshot → public webhook payload. The ONLY keys that
 * appear are the allow-listed ones below; the forbidden Phase-E keys
 * (outcome_*, pfe_*, mae_*, return_pct_*, price_after_*) are structurally
 * impossible because the input is itself an allow-listed snapshot.
 *
 * Discriminated on `event.type`: scan_digest renders the digest shape (cadence +
 * ranked ScanCallItem[]); trade_call/regime_shift render the per-signal shape
 * (BYTE-UNCHANGED from CALL-REGIME-WEBHOOK-LAYER-W1 — the firewall).
 */
export function buildPayload(event: WebhookEventData, deliveryId: string | number): WebhookPayload {
  if (event.type === 'scan_digest') {
    return {
      event: 'scan_digest',
      delivery_id: String(deliveryId),
      created_at: event.generated_at,
      data: {
        type: 'scan_digest',
        cadence: event.cadence,
        timeframe: event.timeframe,
        exchange: event.exchange,
        calls: event.calls,
      },
      _algovault: {
        service: 'webhook-delivery',
        version: PKG_VERSION,
        docs: WEBHOOK_DOCS_URL,
        disclaimer: 'Scan digests are informational, not financial advice.',
      },
    };
  }
  const data: WebhookPayloadData = {
    type: event.type,
    coin: event.coin,
    timeframe: event.timeframe,
    exchange: event.exchange,
    call: event.call ?? null,
    confidence: event.confidence ?? null,
    regime: event.regime ?? null,
    ...(event.type === 'regime_shift' ? { prior_regime: event.prior_regime ?? null } : {}),
    price_at_call: event.price_at_call ?? null,
    signal_hash: event.signal_hash ?? null,
    verify_url: event.signal_hash ? `https://algovault.com/verify?hash=${event.signal_hash}` : null,
  };
  return {
    event: event.type,
    delivery_id: String(deliveryId),
    created_at: event.created_at,
    data,
    _algovault: {
      service: 'webhook-delivery',
      version: PKG_VERSION,
      docs: WEBHOOK_DOCS_URL,
      disclaimer: 'Trade calls are informational, not financial advice. Verify on-chain via verify_url.',
    },
  };
}

/**
 * HMAC-SHA256 hex over the signed string `"{timestamp}.{rawBody}"` under the
 * subscription secret (Stripe-style). WH-04 (OPS-WEBHOOK-HMAC-TIMESTAMP-W1):
 * folding the timestamp into the signed bytes binds the delivery to a moment in
 * time so a captured (body, signature) pair cannot be replayed indefinitely — the
 * subscriber rejects deliveries whose `X-AlgoVault-Timestamp` is outside a
 * freshness window. The timestamp is epoch SECONDS (matches the header).
 */
export function signPayload(body: string, secret: string, timestamp: number): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Canonical subscriber-side verifier (the documented WEBHOOKS.md recipe). Returns
 * true iff `signature` is a valid HMAC over `"{timestamp}.{rawBody}"` AND the
 * timestamp is within `toleranceSec` of now (replay-window enforcement). Uses
 * crypto.timingSafeEqual for a constant-time compare; a length mismatch (or any
 * malformed hex) returns false rather than throwing. Exported so the gate / tests
 * exercise the exact recipe subscribers are told to use.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  timestamp: number,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  const toleranceSec = opts.toleranceSec ?? 300; // 5 minutes default
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = signPayload(body, secret, timestamp);
  // timingSafeEqual throws on length mismatch → guard with a length check first.
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function buildHeaders(payload: WebhookPayload, signature: string, timestamp: number): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': `AlgoVault-Webhooks/${PKG_VERSION}`,
    'X-AlgoVault-Signature': signature,
    'X-AlgoVault-Event': payload.event,
    'X-AlgoVault-Delivery': payload.delivery_id,
    'X-AlgoVault-Timestamp': String(timestamp),
  };
}

// ── Config + injectable deps (for tests) ──

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface DeliveryConfig {
  maxAttempts: number;
  timeoutMs: number;
  disableAfter: number;
  baseBackoffMs: number;
}

export function loadDeliveryConfig(): DeliveryConfig {
  return {
    maxAttempts: envInt('WEBHOOK_MAX_ATTEMPTS', 5),
    timeoutMs: envInt('WEBHOOK_DELIVERY_TIMEOUT_MS', 10_000),
    disableAfter: envInt('WEBHOOK_DISABLE_AFTER_FAILURES', 20),
    baseBackoffMs: envInt('WEBHOOK_BACKOFF_BASE_MS', 1_000),
  };
}

export interface DeliveryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable DNS resolver for the SSRF egress guard (default dns.promises.lookup). */
  lookup?: ResolveEgressOpts['lookup'];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DeliveryResult {
  deliveryId: number;
  status: DeliveryStatus;
  attempts: number;
  responseCode: number | null;
  subscriptionDisabled: boolean;
  suggested_action?: string;
}

/**
 * Build an undici Agent that PINS every connection for this delivery to the
 * already-validated egress address (WH-01). The dispatcher's connect.lookup
 * ignores the hostname and returns ONLY the pinned address, so undici cannot
 * re-resolve at connect time and rebind to an internal target. The request URL
 * keeps the ORIGINAL hostname (so TLS SNI + certificate hostname verification stay
 * correct) — only the IP the socket dials is frozen.
 */
function pinnedDispatcher(pin: PinnedAddress): Agent {
  const pinnedLookup = (
    _hostname: string,
    opts: { all?: boolean } | undefined,
    cb: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
  ): void => {
    if (opts?.all) {
      cb(null, [{ address: pin.address, family: pin.family }]);
    } else {
      cb(null, pin.address, pin.family);
    }
  };
  return new Agent({ connect: { lookup: pinnedLookup as never } });
}

async function postWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  dispatcher?: Agent,
): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // WH-01: `dispatcher` pins the validated egress IP so undici cannot re-resolve
    // the hostname at connect and rebind to an internal target. The URL keeps the
    // hostname (TLS SNI / cert verification correct); only the dialed IP is frozen.
    // redirect:'error' — a 3xx to an internal target must NOT bypass the egress
    // guard via fetch's default redirect-follow (WEBHOOK-HARDENING-W1 C2). No
    // redirect-follow → no post-check rebind either.
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error', ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver a single queued delivery: sign + POST with in-call exponential-backoff
 * retry up to maxAttempts. Marks the row delivered|failed|dead and updates
 * subscription health. Never throws.
 */
export async function deliverOne(
  delivery: WebhookDelivery,
  deps: DeliveryDeps = {},
  cfg: DeliveryConfig = loadDeliveryConfig(),
): Promise<DeliveryResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const sleep = deps.sleep ?? defaultSleep;

  const sub = await getSubscription(delivery.subscription_id);
  if (!sub || !sub.active) {
    await markDelivery(delivery.id, 'dead', { attempts: delivery.attempts, responseCode: null });
    return {
      deliveryId: delivery.id,
      status: 'dead',
      attempts: delivery.attempts,
      responseCode: null,
      subscriptionDisabled: !!sub && !sub.active,
      suggested_action: sub ? 'subscription is disabled; re-enable or recreate it' : 'subscription no longer exists',
    };
  }

  // SSRF egress guard (WEBHOOK-HARDENING-W1 C2 + WH-01 IP-pin): resolve sub.url,
  // block any disallowed/internal target (DNS-rebind defense), and CAPTURE the
  // validated address to PIN to the connection BEFORE the retry loop. On block:
  // mark the delivery dead — do NOT charge quota, do NOT burn retries.
  let pin: PinnedAddress;
  try {
    pin = await resolveAndAssertEgress(sub.url, { lookup: deps.lookup });
  } catch (err) {
    if (err instanceof EgressBlockedError) {
      await markDelivery(delivery.id, 'dead', { attempts: delivery.attempts, responseCode: null });
      // C3: per-delivery row stays 'dead' (0 quota, 0 retries — unchanged). The
      // SUBSCRIPTION advances on the block, TRANSIENT per Q1 (a rebind/NXDOMAIN blip
      // must not permanently kill a paying sub) → degraded→quarantine; C4's probe
      // re-runs the SAME guard, so a genuine internal/rebind target rides back-off to
      // quarantine_expired. Forensic log only, NO Telegram.
      let subscriptionDisabled = false;
      if (isAutoRecoveryEnabled()) {
        const t = await recordFailureAndTransition(sub.id, classifyDeliveryFailure({ egressBlocked: true }), Math.floor(Date.now() / 1000));
        console.log(`[webhook-delivery] sub ${sub.id} egress-block(${err.reason}) → ${t.state} (consecutive=${t.consecutiveFailures})`);
        subscriptionDisabled = t.disabled;
      }
      return {
        deliveryId: delivery.id,
        status: 'dead',
        attempts: delivery.attempts,
        responseCode: null,
        subscriptionDisabled,
        suggested_action: `url resolves to a disallowed/internal address (${err.reason}); use a public https endpoint`,
      };
    }
    throw err;
  }

  // Quota gate (Mr.1/Cowork-ratified): each delivered event draws down the
  // OWNER's monthly call quota exactly like a pull call. If exhausted, PAUSE —
  // leave the delivery 'pending' (no attempt, no failure) so it resumes on the
  // next monthly reset / tier upgrade. No Telegram (background pause is silent).
  const quota = checkQuotaByKey(sub.owner_key, sub.tier as LicenseTier);
  if (!quota.allowed) {
    // OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH4 (D4): the pause used to be SILENT — the
    // suggested_action below was returned to nobody. Tell the owner, once per
    // billing month. This branch fires on EVERY drain tick while exhausted, so the
    // idempotency key is bucketed by month; a per-delivery notice would mail
    // hundreds of times. Fire-and-forget: a notify failure must never change this
    // DeliveryResult (pinned by the forced-throw test).
    safeNotify({
      ownerKey: sub.owner_key,
      event: 'webhook_quota_paused',
      context: {
        subscriptionId: sub.id,
        stateEpochBucket: billingMonthBucket(),
        quotaUsed: quota.used,
        quotaTotal: quota.total,
      },
    });
    return {
      deliveryId: delivery.id,
      status: 'pending',
      attempts: delivery.attempts,
      responseCode: null,
      subscriptionDisabled: false,
      suggested_action: `owner monthly quota exhausted (${quota.used}/${quota.total}); deliveries paused until reset or upgrade`,
    };
  }

  let eventData: WebhookEventData;
  try {
    eventData = JSON.parse(delivery.event_data) as WebhookEventData;
  } catch {
    await markDelivery(delivery.id, 'dead', { attempts: delivery.attempts, responseCode: null });
    return {
      deliveryId: delivery.id, status: 'dead', attempts: delivery.attempts, responseCode: null,
      subscriptionDisabled: false, suggested_action: 'corrupt event_data; cannot build payload',
    };
  }

  // FEATURE-PARITY-CHANNELS-W1 CH2: a scan_digest delivery charges the scanner rule
  // — max(1, non-HOLD calls in the digest), exactly like the pull scanner. Signal
  // events stay 1 (byte-identical to CALL-REGIME-WEBHOOK-LAYER-W1). The quota gate
  // above pauses on exhaustion; this only scales the charge AMOUNT.
  const quotaUnits = eventData.type === 'scan_digest'
    ? Math.max(1, eventData.calls.filter((c) => c.call !== 'HOLD').length)
    : 1;

  const payload = buildPayload(eventData, delivery.id);
  const body = JSON.stringify(payload);

  // WH-01: a single dispatcher pins every attempt's connection to the validated
  // egress IP captured above (defeats DNS-rebind at connect). Built once per
  // delivery; reused across retries.
  const dispatcher = pinnedDispatcher(pin);

  let attempts = 0;
  let lastCode: number | null = null;
  let lastErrorCode: string | undefined; // captured from the caught network error (C3)

  for (let i = 0; i < cfg.maxAttempts; i++) {
    attempts = i + 1;
    // WH-04: sign per-attempt with the SAME timestamp emitted in the header, so the
    // signature covers `"{timestamp}.{body}"` and the subscriber can enforce a
    // freshness window. A retry gets a fresh timestamp+signature (still fresh).
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(body, sub.secret, timestamp);
    const headers = buildHeaders(payload, signature, timestamp);
    try {
      const { ok, status } = await postWithTimeout(fetchImpl, sub.url, headers, body, cfg.timeoutMs, dispatcher);
      lastCode = status;
      if (ok) {
        await markDelivery(delivery.id, 'delivered', { attempts, responseCode: status });
        await recordDeliverySuccess(sub.id);
        // Charge the owner's monthly quota for the delivered event (scan_digest = N).
        trackCallByKey(sub.owner_key, sub.tier as LicenseTier, quotaUnits);
        return { deliveryId: delivery.id, status: 'delivered', attempts, responseCode: status, subscriptionDisabled: false };
      }
    } catch (err) {
      lastCode = null; // network error / timeout / abort
      lastErrorCode = extractErrorCode(err); // C3: preserve the code for classification
    }
    if (i < cfg.maxAttempts - 1) {
      await sleep(cfg.baseBackoffMs * 2 ** i);
    }
  }

  // Exhausted all attempts → the per-delivery row is permanently failed.
  await markDelivery(delivery.id, 'failed', { attempts, responseCode: lastCode });

  if (isAutoRecoveryEnabled()) {
    // NEW (C3): classify + transition the SUBSCRIPTION lifecycle. Transient (every
    // class but http_410) → degraded→quarantine (C4 probes it back); http_410 →
    // disabled immediately. Forensic log only, NO Telegram (recovery is silent).
    const failureClass = classifyDeliveryFailure({ httpStatus: lastCode ?? undefined, errorCode: lastErrorCode });
    const nowSec = Math.floor(Date.now() / 1000);
    const t = await recordFailureAndTransition(sub.id, failureClass, nowSec);
    console.log(`[webhook-delivery] sub ${sub.id} failure(${failureClass}) → ${t.state} (consecutive=${t.consecutiveFailures})`);
    // D1 day-1 warning: fire ONLY on the active|degraded → quarantined edge, not on
    // every failure while already quarantined. The idempotency key is bucketed by
    // the quarantine occurrence, so a re-quarantine after a recovery notifies again.
    maybeNotifyQuarantined(sub, t.state, nowSec);
    return {
      deliveryId: delivery.id,
      status: 'failed',
      attempts,
      responseCode: lastCode,
      subscriptionDisabled: t.disabled,
      suggested_action: transitionSuggestedAction(t.state, failureClass, attempts, lastCode, cfg.timeoutMs),
    };
  }

  // LEGACY (WEBHOOK_AUTO_RECOVERY_ENABLED=0 → instant rollback): one-way disable.
  const { disabled, consecutiveFailures } = await bumpFailureAndMaybeDisable(sub.id, cfg.disableAfter);
  if (disabled) {
    console.warn(`[webhook-delivery] subscription ${sub.id} auto-disabled after ${consecutiveFailures} consecutive failures`);
  }
  return {
    deliveryId: delivery.id,
    status: 'failed',
    attempts,
    responseCode: lastCode,
    subscriptionDisabled: disabled,
    suggested_action: disabled
      ? `endpoint auto-disabled after ${consecutiveFailures} consecutive failures — fix the endpoint (must return 2xx) then recreate the subscription`
      : `delivery failed after ${attempts} attempts (last status ${lastCode ?? 'network error / timeout'}); ensure your endpoint returns a 2xx within ${cfg.timeoutMs}ms`,
  };
}

/** Drain up to `limit` pending deliveries (one in-call retry budget each). */
export async function deliverPending(
  limit = 50,
  deps: DeliveryDeps = {},
  cfg: DeliveryConfig = loadDeliveryConfig(),
): Promise<DeliveryResult[]> {
  const pending = await pendingDeliveries(limit);
  const results: DeliveryResult[] = [];
  for (const d of pending) {
    try {
      results.push(await deliverOne(d, deps, cfg));
    } catch (err) {
      console.error(`[webhook-delivery] deliverOne failed for delivery ${d.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}

// ── In-process worker (started behind WEBHOOK_DELIVERY_ENABLED in C6) ──

let workerHandle: ReturnType<typeof setInterval> | null = null;

export function isWorkerRunning(): boolean {
  return workerHandle !== null;
}

/** Start the drain loop. Idempotent. Mirrors the backfill setInterval in index.ts. */
export function startDeliveryWorker(intervalMs = envInt('WEBHOOK_WORKER_INTERVAL_MS', 15_000)): void {
  if (workerHandle) return;
  console.log(`[webhook-delivery] worker started — draining every ${intervalMs}ms`);
  workerHandle = setInterval(() => {
    deliverPending().catch((err) => console.error('[webhook-delivery] worker tick error:', err instanceof Error ? err.message : err));
  }, intervalMs);
  if (typeof workerHandle.unref === 'function') workerHandle.unref();
}

export function stopDeliveryWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
}

// ── C4: health-probe sweep + auto-resume (the automation-first core) ──

/**
 * The canonical sample event — the SINGLE source reused by the `/test` route
 * (webhook-api) and the health-probe sweep (Mr.1 Q5, single-derivation; kept here
 * because webhook-api already imports from webhook-delivery, so exporting it the
 * other way would form an init cycle). A benign trade_call snapshot; the recipient
 * distinguishes a probe from a real delivery via the `X-AlgoVault-Event` header.
 */
export function buildSampleEvent(nowEpoch = Math.floor(Date.now() / 1000)): WebhookEventData {
  return {
    type: 'trade_call',
    coin: 'BTC',
    timeframe: '1h',
    exchange: 'HL',
    call: 'BUY',
    confidence: 72,
    regime: 'TRENDING_UP',
    price_at_call: 50000,
    signal_hash: `0xtest${nowEpoch}`,
    created_at: nowEpoch,
  };
}

export interface ProbeSweepResult { probed: number; resumed: number; disabled: number; backedOff: number; }

/**
 * Probe ONE quarantined subscription: an SSRF-guarded, HMAC-signed POST of the
 * sample event tagged `X-AlgoVault-Event: health_probe`, pinned to the validated
 * egress IP (same guard as a real delivery, so a now-internal/rebind target is
 * still blocked). Returns ok=true on 2xx, else the classified failure. Draws NO
 * owner quota (a probe is synthetic, not a delivered event).
 */
async function probeOne(sub: WebhookSubscription, deps: DeliveryDeps, cfg: DeliveryConfig): Promise<{ ok: boolean; failureClass?: WebhookFailureClass }> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  let pin: PinnedAddress;
  try {
    pin = await resolveAndAssertEgress(sub.url, { lookup: deps.lookup });
  } catch (err) {
    if (err instanceof EgressBlockedError) return { ok: false, failureClass: 'egress_block' };
    return { ok: false, failureClass: classifyDeliveryFailure({ errorCode: extractErrorCode(err) }) };
  }
  const payload = buildPayload(buildSampleEvent(), `probe-${sub.id}`);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(body, sub.secret, timestamp);
  const headers = { ...buildHeaders(payload, signature, timestamp), 'X-AlgoVault-Event': 'health_probe' };
  const dispatcher = pinnedDispatcher(pin);
  try {
    const { ok, status } = await postWithTimeout(fetchImpl, sub.url, headers, body, cfg.timeoutMs, dispatcher);
    if (ok) return { ok: true };
    return { ok: false, failureClass: classifyDeliveryFailure({ httpStatus: status }) };
  } catch (err) {
    return { ok: false, failureClass: classifyDeliveryFailure({ errorCode: extractErrorCode(err) }) };
  }
}

/**
 * One health-probe sweep tick. For every quarantined sub whose `next_probe_at` is
 * due: (1) expire to `disabled(quarantine_expired)` if quarantined longer than the
 * sub's TIER-DIFFERENTIATED window — `quarantineMaxSecFor(sub.tier)`, paid 30d /
 * free 7d (OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH3); else probe — 2xx → AUTO-RESUME `active`; `http_410`
 * → `disabled(permanent_http_410)`; any other (transient) → exponential back-off
 * of `next_probe_at`. All transitions forensic-logged; NO Telegram (silent per the
 * alert contract). Quarantined subs are never enqueued for real events — recovery
 * is probe-driven only, so no stale-signal delivery and no hammering.
 */
export async function runHealthProbeSweep(deps: DeliveryDeps = {}, cfg: DeliveryConfig = loadDeliveryConfig(), limit = 25): Promise<ProbeSweepResult> {
  const lc = loadLifecycleConfig();
  const now = Math.floor(Date.now() / 1000);
  const due = await getQuarantinedDue(now, limit);
  const out: ProbeSweepResult = { probed: due.length, resumed: 0, disabled: 0, backedOff: 0 };
  for (const sub of due) {
    // Tier-differentiated expiry — the ONE derivation lives in the policy leaf.
    const quarantineMaxSec = quarantineMaxSecFor(sub.tier);
    if (sub.quarantined_at != null && now - sub.quarantined_at > quarantineMaxSec) {
      await setDeliveryState(sub.id, 'disabled', { disabled_reason: 'quarantine_expired', next_probe_at: null, last_probe_at: now });
      console.log(`[webhook-probe] sub ${sub.id} quarantine_expired (>${quarantineMaxSec}s no recovery, tier=${sub.tier}) → disabled`);
      // D1: terminal. Tell the owner — this is the case a paying customer hit on
      // 2026-08-01 and was never told about.
      safeNotify({
        ownerKey: sub.owner_key,
        event: 'webhook_disabled',
        context: { subscriptionId: sub.id, stateEpochBucket: sub.quarantined_at, retriedForSec: quarantineMaxSec },
      });
      out.disabled += 1;
      continue;
    }
    const r = await probeOne(sub, deps, cfg);
    if (r.ok) {
      await recordProbeResult(sub.id, true, now);
      console.log(`[webhook-probe] sub ${sub.id} probe 2xx → resumed active`);
      // Registered-and-silent: recovery alerts are noise. Routed through the same
      // registry so the silence is an explicit decision, not an omission.
      safeNotify({
        ownerKey: sub.owner_key,
        event: 'webhook_resumed',
        context: { subscriptionId: sub.id, stateEpochBucket: sub.quarantined_at },
      });
      out.resumed += 1;
    } else if (r.failureClass === 'http_410') {
      await setDeliveryState(sub.id, 'disabled', { disabled_reason: 'permanent_http_410', next_probe_at: null, last_probe_at: now });
      console.log(`[webhook-probe] sub ${sub.id} probe http_410 → disabled`);
      safeNotify({
        ownerKey: sub.owner_key,
        event: 'webhook_disabled',
        context: { subscriptionId: sub.id, stateEpochBucket: sub.quarantined_at, retriedForSec: quarantineMaxSec },
      });
      out.disabled += 1;
    } else {
      // Exponential back-off, seeded at base, doubling each failed probe, capped at max.
      const prevInterval = sub.last_probe_at != null ? Math.max(lc.probeBackoffBaseSec, now - sub.last_probe_at) : lc.probeBackoffBaseSec;
      const nextInterval = Math.min(prevInterval * 2, lc.probeBackoffMaxSec);
      await setDeliveryState(sub.id, 'quarantined', { next_probe_at: now + nextInterval, last_probe_at: now });
      console.log(`[webhook-probe] sub ${sub.id} probe ${r.failureClass} → back-off ${nextInterval}s`);
      out.backedOff += 1;
    }
  }
  return out;
}

let sweepHandle: ReturnType<typeof setInterval> | null = null;

export function isSweepRunning(): boolean {
  return sweepHandle !== null;
}

/**
 * Start the health-probe sweep. Idempotent. No-op (and logs) when auto-recovery is
 * disabled, so booting it unconditionally under WEBHOOK_DELIVERY_ENABLED is safe —
 * flipping WEBHOOK_AUTO_RECOVERY_ENABLED=0 means no sweep, no resume (legacy).
 */
export function startHealthProbeSweep(intervalMs = envInt('WEBHOOK_PROBE_SWEEP_INTERVAL_MS', 60_000)): void {
  if (sweepHandle) return;
  if (!isAutoRecoveryEnabled()) {
    console.log('[webhook-probe] WEBHOOK_AUTO_RECOVERY_ENABLED off — health-probe sweep NOT started (legacy terminal-disable)');
    return;
  }
  console.log(`[webhook-probe] health-probe sweep started — scanning every ${intervalMs}ms`);
  sweepHandle = setInterval(() => {
    runHealthProbeSweep().catch((err) => console.error('[webhook-probe] sweep tick error:', err instanceof Error ? err.message : err));
  }, intervalMs);
  if (typeof sweepHandle.unref === 'function') sweepHandle.unref();
}

export function stopHealthProbeSweep(): void {
  if (sweepHandle) {
    clearInterval(sweepHandle);
    sweepHandle = null;
  }
}
