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
import { PKG_VERSION } from './pkg-version.js';
import { checkQuotaByKey, trackCallByKey } from './license.js';
import type { LicenseTier } from '../types.js';
import {
  pendingDeliveries,
  markDelivery,
  bumpFailureAndMaybeDisable,
  recordDeliverySuccess,
  getSubscription,
  type WebhookDelivery,
  type WebhookEventData,
  type WebhookEventType,
  type DeliveryStatus,
} from './webhooks-store.js';

const WEBHOOK_DOCS_URL = 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/WEBHOOKS.md';

// ── Public payload shape (ALLOW-LIST — no forbidden Phase-E keys) ──

export interface WebhookPayloadData {
  type: WebhookEventType;
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

export interface WebhookPayload {
  event: WebhookEventType;
  delivery_id: string;
  created_at: number;
  data: WebhookPayloadData;
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
 */
export function buildPayload(event: WebhookEventData, deliveryId: string | number): WebhookPayload {
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

/** HMAC-SHA256 hex of the raw JSON body under the subscription secret. */
export function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
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

async function postWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
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

  // Quota gate (Mr.1/Cowork-ratified): each delivered event draws down the
  // OWNER's monthly call quota exactly like a pull call. If exhausted, PAUSE —
  // leave the delivery 'pending' (no attempt, no failure) so it resumes on the
  // next monthly reset / tier upgrade. No Telegram (background pause is silent).
  const quota = checkQuotaByKey(sub.owner_key, sub.tier as LicenseTier);
  if (!quota.allowed) {
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

  const payload = buildPayload(eventData, delivery.id);
  const body = JSON.stringify(payload);
  const signature = signPayload(body, sub.secret);

  let attempts = 0;
  let lastCode: number | null = null;

  for (let i = 0; i < cfg.maxAttempts; i++) {
    attempts = i + 1;
    const headers = buildHeaders(payload, signature, Math.floor(Date.now() / 1000));
    try {
      const { ok, status } = await postWithTimeout(fetchImpl, sub.url, headers, body, cfg.timeoutMs);
      lastCode = status;
      if (ok) {
        await markDelivery(delivery.id, 'delivered', { attempts, responseCode: status });
        await recordDeliverySuccess(sub.id);
        // Charge the owner's monthly quota for the delivered event.
        trackCallByKey(sub.owner_key, sub.tier as LicenseTier);
        return { deliveryId: delivery.id, status: 'delivered', attempts, responseCode: status, subscriptionDisabled: false };
      }
    } catch {
      lastCode = null; // network error / timeout / abort
    }
    if (i < cfg.maxAttempts - 1) {
      await sleep(cfg.baseBackoffMs * 2 ** i);
    }
  }

  // Exhausted all attempts → the delivery has permanently failed.
  await markDelivery(delivery.id, 'failed', { attempts, responseCode: lastCode });
  const { disabled, consecutiveFailures } = await bumpFailureAndMaybeDisable(sub.id, cfg.disableAfter);
  if (disabled) {
    // Silent recovery: forensic log only, NO Telegram (alert contract). No URL/secret in the log.
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
