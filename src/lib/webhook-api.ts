/**
 * CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): REST API for webhook subscriptions.
 *
 * Registers POST/GET/DELETE /api/webhooks + POST /api/webhooks/:id/test on the
 * provided Express app (called once from src/index.ts so the route surface lives
 * in the HTTP server). Auth reuses the existing license path; ownership +
 * delivery quota are key-addressed (NO bespoke webhook tiering — Mr.1/Cowork
 * ratified: universal access, gated only by the monthly call quota).
 *
 * Security: a subscription's `secret` is returned ONCE (on create) and NEVER on
 * list; `owner_key` (the API key) is never echoed in any response.
 */
import express, { type Express, type Request, type Response } from 'express';
import { resolveLicense, checkQuotaByKey, getUpgradeHint } from './license.js';
import type { LicenseInfo, LicenseTier } from '../types.js';
import {
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  getSubscription,
  enqueueDelivery,
  type WebhookSubscription,
  type WebhookEventType,
  type WebhookEventData,
  type WebhookDelivery,
} from './webhooks-store.js';
import { deliverOne } from './webhook-delivery.js';

const VALID_EVENTS: WebhookEventType[] = ['trade_call', 'regime_shift'];
const MAX_URL_LEN = 2048;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function resolveOwner(req: Request): Promise<{ license: LicenseInfo; ownerKey: string | null }> {
  const headers = req.headers as Record<string, string | undefined>;
  const { license } = await resolveLicense(headers);
  // Ownership requires a stable API key. Keyless-anon (free w/o key), x402
  // (per-request, no persistent identity) and internal cannot own subscriptions.
  return { license, ownerKey: license.key ?? null };
}

function authRequired(res: Response): Response {
  return res.status(401).json({
    ok: false,
    code: 'auth_required',
    error: 'An API key is required to own a webhook subscription.',
    suggested_action: 'Create a free API key at https://api.algovault.com/signup and send it as `Authorization: Bearer <key>`.',
  });
}

function isValidWebhookUrl(url: string): boolean {
  if (!url || url.length > MAX_URL_LEN) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function parseEvents(raw: unknown): WebhookEventType[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: WebhookEventType[] = [];
  for (const e of raw) {
    if (typeof e !== 'string' || !VALID_EVENTS.includes(e as WebhookEventType)) return null;
    if (!out.includes(e as WebhookEventType)) out.push(e as WebhookEventType);
  }
  return out;
}

function parseStrArray(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : null;
}

/** Public subscription view — never exposes owner_key; secret only on create. */
function serializeSubscription(s: WebhookSubscription, opts: { includeSecret: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: s.id,
    url: s.url,
    events: s.events,
    assets: s.assets,
    timeframes: s.timeframes,
    min_confidence: s.min_confidence,
    tier: s.tier,
    active: s.active,
    consecutive_failures: s.consecutive_failures,
    created_at: s.created_at,
    last_delivered_at: s.last_delivered_at,
  };
  if (opts.includeSecret) out.secret = s.secret;
  return out;
}

export function registerWebhookRoutes(app: Express): void {
  // POST /api/webhooks — create a subscription (returns secret ONCE).
  app.post('/api/webhooks', express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const { license, ownerKey } = await resolveOwner(req);
      if (!ownerKey) return authRequired(res);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!isValidWebhookUrl(url)) {
        return res.status(400).json({ ok: false, code: 'invalid_url', error: 'url must be a valid http(s) URL ≤ 2048 chars', suggested_action: 'Provide an https endpoint that returns a 2xx response.' });
      }
      const events = parseEvents(body.events);
      if (!events) {
        return res.status(400).json({ ok: false, code: 'invalid_events', error: 'events must be a non-empty array drawn from: trade_call, regime_shift', suggested_action: 'e.g. {"events":["trade_call","regime_shift"]}' });
      }
      let minConfidence: number | null = null;
      if (body.min_confidence !== undefined && body.min_confidence !== null) {
        const n = Number(body.min_confidence);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return res.status(400).json({ ok: false, code: 'invalid_min_confidence', error: 'min_confidence must be a number in [0,100]', suggested_action: 'Omit it or send e.g. 60.' });
        }
        minConfidence = n;
      }

      const sub = await createSubscription({
        url,
        events,
        assets: parseStrArray(body.assets),
        timeframes: parseStrArray(body.timeframes),
        minConfidence,
        tier: license.tier,
        ownerKey,
      });

      const quota = checkQuotaByKey(ownerKey, license.tier as LicenseTier);
      const upgradeHint = getUpgradeHint(license, { used: quota.used, total: quota.total });
      return res.status(201).json({
        ok: true,
        subscription: serializeSubscription(sub, { includeSecret: true }),
        quota: { used: quota.used, total: quota.total, remaining: quota.remaining },
        note: 'Store `secret` now — it is shown only once. Each delivered event draws down your monthly call quota.',
        ...(upgradeHint ? { upgrade_hint: upgradeHint } : {}),
      });
    } catch (err) {
      console.error('[/api/webhooks POST] internal error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, code: 'internal_error', error: 'internal error' });
    }
  });

  // GET /api/webhooks — list the caller's subscriptions (no secret).
  app.get('/api/webhooks', async (req: Request, res: Response) => {
    try {
      const { license, ownerKey } = await resolveOwner(req);
      if (!ownerKey) return authRequired(res);
      const subs = await listSubscriptions(ownerKey);
      const quota = checkQuotaByKey(ownerKey, license.tier as LicenseTier);
      return res.json({
        ok: true,
        subscriptions: subs.map((s) => serializeSubscription(s, { includeSecret: false })),
        quota: { used: quota.used, total: quota.total, remaining: quota.remaining },
      });
    } catch (err) {
      console.error('[/api/webhooks GET] internal error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, code: 'internal_error', error: 'internal error' });
    }
  });

  // DELETE /api/webhooks/:id — owner-scoped delete.
  app.delete('/api/webhooks/:id', async (req: Request, res: Response) => {
    try {
      const { ownerKey } = await resolveOwner(req);
      if (!ownerKey) return authRequired(res);
      const id = Number.parseInt(String(req.params.id), 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, code: 'invalid_id', error: 'id must be a positive integer', suggested_action: 'Use the numeric id returned by POST/GET /api/webhooks.' });
      }
      const deleted = await deleteSubscription(id, ownerKey);
      if (!deleted) {
        return res.status(404).json({ ok: false, code: 'not_found', error: 'subscription not found or not owned by you', suggested_action: 'Verify the id via GET /api/webhooks.' });
      }
      return res.json({ ok: true, deleted: true, id });
    } catch (err) {
      console.error('[/api/webhooks DELETE] internal error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, code: 'internal_error', error: 'internal error' });
    }
  });

  // POST /api/webhooks/:id/test — send a sample signed event immediately.
  app.post('/api/webhooks/:id/test', async (req: Request, res: Response) => {
    try {
      const { ownerKey } = await resolveOwner(req);
      if (!ownerKey) return authRequired(res);
      const id = Number.parseInt(String(req.params.id), 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, code: 'invalid_id', error: 'id must be a positive integer', suggested_action: 'Use the numeric id returned by POST/GET /api/webhooks.' });
      }
      const sub = await getSubscription(id);
      if (!sub || sub.owner_key !== ownerKey) {
        return res.status(404).json({ ok: false, code: 'not_found', error: 'subscription not found or not owned by you', suggested_action: 'Verify the id via GET /api/webhooks.' });
      }

      const ts = nowSec();
      const sampleEvent: WebhookEventData = {
        type: 'trade_call',
        coin: 'BTC',
        timeframe: '1h',
        exchange: 'HL',
        call: 'BUY',
        confidence: 72,
        regime: 'TRENDING_UP',
        price_at_call: 50000,
        signal_hash: `0xtest${ts}`,
        created_at: ts,
      };
      const eventId = `test:${id}:${ts}`;
      const enq = await enqueueDelivery({ subscriptionId: id, eventId, eventType: 'trade_call', eventData: sampleEvent });
      const deliveryId = enq.deliveryId ?? -1;

      const deliveryRow: WebhookDelivery = {
        id: deliveryId,
        subscription_id: id,
        event_id: eventId,
        event_type: 'trade_call',
        event_data: JSON.stringify(sampleEvent),
        status: 'pending',
        attempts: 0,
        last_attempt_at: null,
        response_code: null,
        created_at: ts,
      };
      const result = await deliverOne(deliveryRow);
      return res.json({
        ok: result.status === 'delivered',
        delivery_id: deliveryId,
        result: {
          status: result.status,
          response_code: result.responseCode,
          attempts: result.attempts,
          ...(result.suggested_action ? { suggested_action: result.suggested_action } : {}),
        },
      });
    } catch (err) {
      console.error('[/api/webhooks/:id/test] internal error:', err instanceof Error ? err.message : err);
      return res.status(500).json({ ok: false, code: 'internal_error', error: 'internal error' });
    }
  });
}
