/**
 * IDENTITY-LIFECYCLE-W3 CH1 — the two public HTTP surfaces.
 *
 *   GET/POST /email/unsubscribe/:token   RFC 8058 one-click + a human confirmation page
 *   POST     /webhooks/resend            Svix-signed bounce / complaint consumer
 *
 * Both are exported as plain handlers so `tests/unit/lifecycle-routes.test.ts` can drive the
 * REAL handlers over a live http.Server rather than a re-implementation — the shape
 * `handleMcpStateless` already uses in this repo.
 */
import type { Request, Response } from 'express';
import { verifyUnsubscribeToken, hashEmail } from './identity.js';
import { addSuppression } from './suppression.js';
import { dbQuery } from '../performance-db.js';
import { ensureLifecycleSchema } from './schema.js';
import { getResendClient } from '../email.js';
import {
  UNSUB_CONFIRMED_LINE, UNSUB_CONFIRM_BUTTON, UNSUB_PROMPT_LINE, UNSUB_INVALID_LINE,
  API_BASE, FOOTER_BRAND,
} from '../lifecycle-copy.js';

function page(title: string, bodyHtml: string, status: number, res: Response): void {
  res.status(status).type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${title}</title></head>` +
    `<body style="margin:0;padding:48px 24px;background:#0d1117;color:#e6edf3;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
    `<div style="max-width:460px;margin:0 auto">${bodyHtml}` +
    `<p style="font-size:12px;color:#8b949e;margin-top:32px">${FOOTER_BRAND} · ` +
    `<a href="${API_BASE}/account" style="color:#8b949e">Manage email preferences</a></p>` +
    `</div></body></html>`,
  );
}

/**
 * Resolve a recipient id to the email hash we suppress on.
 *
 * The ledger is the lookup, not an identity table: it is the only place that records which
 * address a given recipient id was actually mailed at, and it is exactly the set we must be able
 * to stop mailing. A recipient id with no ledger row has never been sent anything, so there is
 * nothing to suppress — that is a 404-class outcome, not an error.
 */
async function emailHashForRecipient(recipientId: string): Promise<string | null> {
  ensureLifecycleSchema();
  const rows = await dbQuery<{ email_hash: string }>(
    'SELECT email_hash FROM lifecycle_sends WHERE recipient_id = ? ORDER BY id DESC LIMIT 1',
    [recipientId],
  );
  return rows[0]?.email_hash ?? null;
}

/**
 * POST — RFC 8058 one-click. The mail client sends this with no human present, so it must
 * suppress immediately and answer 200 with a body no one will read.
 *
 * Honoured "within 48 h" is met by construction: the write happens before the response.
 */
export async function unsubscribePostHandler(req: Request, res: Response): Promise<void> {
  const recipientId = verifyUnsubscribeToken(String(req.params.token ?? ''));
  if (!recipientId) {
    page('Unsubscribe', `<p style="font-size:15px">${UNSUB_INVALID_LINE}</p>`, 400, res);
    return;
  }
  try {
    const emailHash = await emailHashForRecipient(recipientId);
    if (!emailHash) {
      // A validly-signed token for someone we have never mailed. Nothing to suppress, and
      // saying so is honest — but it is still a 200, because the mail client asked us to stop
      // and the outcome it wants (no further mail) is true.
      page('Unsubscribe', `<p style="font-size:15px">${UNSUB_CONFIRMED_LINE}</p>`, 200, res);
      return;
    }
    await addSuppression({ emailHash, reason: 'unsubscribe', scope: 'all', source: 'one-click' });
    page('Unsubscribe', `<p style="font-size:15px">${UNSUB_CONFIRMED_LINE}</p>`, 200, res);
  } catch (err) {
    console.error('[lifecycle] unsubscribe POST failed:', err instanceof Error ? err.message : err);
    // 500 so the mail client retries — a swallowed error here is a person who clicked
    // unsubscribe and keeps receiving mail.
    page('Unsubscribe', '<p style="font-size:15px">Something went wrong. Please try again.</p>', 500, res);
  }
}

/** GET — the human page. Renders a one-button POST; it does NOT suppress on its own. */
export function unsubscribeGetHandler(req: Request, res: Response): void {
  const token = String(req.params.token ?? '');
  const recipientId = verifyUnsubscribeToken(token);
  if (!recipientId) {
    page('Unsubscribe', `<p style="font-size:15px">${UNSUB_INVALID_LINE}</p>`, 400, res);
    return;
  }
  // A GET must not mutate: mail scanners and link-preview fetchers follow every URL in a
  // message, and a suppressing GET would unsubscribe people who never clicked anything.
  page('Unsubscribe',
    `<p style="font-size:15px;line-height:1.5">${UNSUB_PROMPT_LINE}</p>` +
    `<form method="post" action="/email/unsubscribe/${encodeURIComponent(token)}">` +
    `<button type="submit" style="background:#da3633;color:#fff;border:0;border-radius:6px;` +
    `padding:10px 18px;font-size:15px;cursor:pointer">${UNSUB_CONFIRM_BUTTON}</button></form>`,
    200, res);
}

/**
 * POST /webhooks/resend — bounce + complaint consumer.
 *
 * Verified with `resend.webhooks.verify()` on the RAW body. The SDK (6.18.1) implements
 * Standard Webhooks over `standardwebhooks@1.0.0` — LOCAL crypto, no network, no extra
 * dependency, and crucially no extra API permission: the production key is send-only
 * (`restricted_api_key`, measured 2026-09-08), which blocks webhook CREATION but not signature
 * verification.
 *
 * FAIL-CLOSED ON A MISSING SECRET. Until `RESEND_WEBHOOK_SECRET` is set, every delivery is
 * refused with 400. That is deliberate and is what CH1's gate asserts: a route that accepted
 * unsigned deliveries "until the secret arrives" would let anyone POST a complaint for any
 * address and permanently suppress a paying customer's mail.
 */
export async function resendWebhookHandler(req: Request, res: Response): Promise<void> {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? '').trim();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  if (!secret) {
    res.status(400).json({ error: 'webhook signing secret not configured' });
    return;
  }
  const id = req.get('svix-id') ?? req.get('webhook-id') ?? '';
  const timestamp = req.get('svix-timestamp') ?? req.get('webhook-timestamp') ?? '';
  const signature = req.get('svix-signature') ?? req.get('webhook-signature') ?? '';
  if (!raw || !id || !timestamp || !signature) {
    res.status(400).json({ error: 'missing signature headers' });
    return;
  }

  const client = getResendClient();
  if (!client) {
    // We cannot verify without the SDK client. Refuse rather than accept — a guard on a live
    // serving path refuses, it does not throw and it does not wave things through.
    res.status(400).json({ error: 'verifier unavailable' });
    return;
  }

  let event: { type?: string; data?: { to?: unknown; email?: unknown } };
  try {
    event = client.webhooks.verify({
      payload: raw,
      headers: { id, timestamp, signature },
      webhookSecret: secret,
    }) as typeof event;
  } catch {
    res.status(400).json({ error: 'invalid signature' });
    return;
  }

  const type = String(event?.type ?? '');
  if (type !== 'email.bounced' && type !== 'email.complained') {
    // Every other event is 2xx-ignored: Resend retries a non-2xx, and retrying an event we
    // deliberately do not consume is pure noise on both sides.
    res.status(200).json({ ok: true, ignored: type || 'unknown' });
    return;
  }

  const to = event?.data?.to;
  const addresses = Array.isArray(to) ? to.map(String) : typeof to === 'string' ? [to] : [];
  const reason = type === 'email.bounced' ? 'bounce' : 'complaint';
  let suppressed = 0;
  for (const addr of addresses) {
    if (!addr.includes('@')) continue;
    try {
      await addSuppression({ emailHash: hashEmail(addr), reason, scope: 'all', source: type });
      suppressed += 1;
    } catch (err) {
      console.error('[lifecycle] suppression write failed:', err instanceof Error ? err.message : err);
      // 500 so Resend retries — losing a complaint is a deliverability liability, not a
      // cosmetic miss.
      res.status(500).json({ error: 'suppression write failed' });
      return;
    }
  }
  res.status(200).json({ ok: true, type, suppressed });
}
