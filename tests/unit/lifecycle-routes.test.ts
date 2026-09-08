/**
 * IDENTITY-LIFECYCLE-W3 CH1 — the two public surfaces, driven as REAL Express handlers over a
 * live http.Server. Not a re-implementation: the handlers under test are the same functions
 * `src/index.ts` mounts, so a routing or body-parser mistake is visible here.
 *
 * The Svix signature is constructed BY HAND rather than with the SDK's own signer. That is
 * deliberate — a hermetic self-test is structurally blind to exactly what its own seam replaces,
 * and signing with the same library that verifies proves only that the library agrees with
 * itself. Building the signature from the Standard Webhooks spec (base64 HMAC-SHA256 over
 * `<id>.<timestamp>.<payload>`, header `v1,<sig>`, key = the base64 after `whsec_`) tests the
 * WIRE FORMAT, which is what Resend actually sends.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const KEY = 'a'.repeat(48);
const WEBHOOK_SECRET_B64 = Buffer.from('lifecycle-test-secret-key-32bytes').toString('base64');
const WEBHOOK_SECRET = `whsec_${WEBHOOK_SECRET_B64}`;

process.env.PERFORMANCE_DB_PATH = ':memory:';
process.env.ALGOVAULT_IP_HASH_KEY = KEY;
delete process.env.DATABASE_URL;

let server: http.Server;
let base: string;

async function start(): Promise<void> {
  const { unsubscribeGetHandler, unsubscribePostHandler, resendWebhookHandler } =
    await import('../../src/lib/lifecycle/routes.js');
  const app = express();
  // Byte-identical to the mounting in src/index.ts — raw for the webhook, urlencoded for the
  // one-click POST. A test that used express.json() everywhere would silently "fix" the exact
  // body-parser mistake this file exists to catch.
  app.post('/webhooks/resend', express.raw({ type: () => true }), resendWebhookHandler);
  app.get('/email/unsubscribe/:token', unsubscribeGetHandler);
  app.post('/email/unsubscribe/:token', express.urlencoded({ extended: false }), unsubscribePostHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function svixHeaders(id: string, ts: string, payload: string, secret = WEBHOOK_SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': ts,
    'svix-signature': `v1,${sig}`,
  };
}

beforeEach(async () => {
  if (!server) await start();
  process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RESEND_API_KEY = 're_test_key_for_verifier_construction';
});

afterAll(() => { server?.close(); });

describe('unsubscribe token', () => {
  it('round-trips, and a tampered signature is rejected', async () => {
    const { unsubscribeToken, verifyUnsubscribeToken } = await import('../../src/lib/lifecycle/identity.js');
    const t = unsubscribeToken('fk_abc123');
    expect(verifyUnsubscribeToken(t)).toBe('fk_abc123');
    // Flip one hex character of the signature.
    const bad = t.slice(0, -1) + (t.endsWith('0') ? '1' : '0');
    expect(verifyUnsubscribeToken(bad)).toBeNull();
  });

  it('carries no PII — the recipient id is opaque and no address appears in the URL', async () => {
    const { unsubscribeUrl } = await import('../../src/lib/lifecycle/identity.js');
    const url = unsubscribeUrl('fk_abc123', 'https://api.algovault.com');
    expect(url).not.toContain('@');
    expect(url).toContain('/email/unsubscribe/');
  });

  it('refuses every malformed shape rather than throwing', async () => {
    const { verifyUnsubscribeToken } = await import('../../src/lib/lifecycle/identity.js');
    for (const bad of ['', '.', 'nodot', 'a.', '.b', 'a.zz', 'a.' + 'f'.repeat(63), '../../etc/passwd']) {
      expect(verifyUnsubscribeToken(bad)).toBeNull();
    }
  });
});

describe('POST /email/unsubscribe/:token', () => {
  it('an invalid token is 4xx — the CH1 gate asserts exactly this', async () => {
    const res = await fetch(`${base}/email/unsubscribe/INVALIDTOKEN`, { method: 'POST' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('a valid token suppresses, is idempotent, and returns 200', async () => {
    const { unsubscribeToken, hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { claimSlot } = await import('../../src/lib/lifecycle/ledger.js');
    const { listSuppressions } = await import('../../src/lib/lifecycle/suppression.js');
    const email = 'unsub-me@example.com';
    await claimSlot({
      recipientId: 'fk_unsub1', emailHash: hashEmail(email), recipientEmail: email,
      step: 'quota_80', periodKey: 'p1', status: 'would_send',
    });
    const t = unsubscribeToken('fk_unsub1');
    const first = await fetch(`${base}/email/unsubscribe/${t}`, { method: 'POST' });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/email/unsubscribe/${t}`, { method: 'POST' });
    expect(second.status).toBe(200);
    const rows = await listSuppressions(hashEmail(email));
    expect(rows.filter((r) => r.reason === 'unsubscribe').length).toBe(1);
  });

  it('GET renders the confirm form and MUTATES NOTHING', async () => {
    const { unsubscribeToken, hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { claimSlot } = await import('../../src/lib/lifecycle/ledger.js');
    const { listSuppressions } = await import('../../src/lib/lifecycle/suppression.js');
    const email = 'scanner-followed-the-link@example.com';
    await claimSlot({
      recipientId: 'fk_getonly', emailHash: hashEmail(email), recipientEmail: email,
      step: 'quota_80', periodKey: 'p1', status: 'would_send',
    });
    const res = await fetch(`${base}/email/unsubscribe/${unsubscribeToken('fk_getonly')}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<form method="post"');
    // A mail scanner following every link must not unsubscribe anybody.
    expect(await listSuppressions(hashEmail(email))).toHaveLength(0);
  });
});

describe('POST /webhooks/resend', () => {
  const payload = JSON.stringify({ type: 'email.bounced', data: { to: ['bounced@example.com'] } });

  it('an unsigned delivery is 400', async () => {
    const res = await fetch(`${base}/webhooks/resend`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('a BAD signature is 400 and writes nothing', async () => {
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { listSuppressions } = await import('../../src/lib/lifecycle/suppression.js');
    const h = svixHeaders('msg_1', String(Math.floor(Date.now() / 1000)), payload, 'whsec_' + Buffer.from('wrong-secret-value-here-32bytes!').toString('base64'));
    const res = await fetch(`${base}/webhooks/resend`, { method: 'POST', headers: h, body: payload });
    expect(res.status).toBe(400);
    expect(await listSuppressions(hashEmail('bounced@example.com'))).toHaveLength(0);
  });

  it('a correctly signed bounce is 200 and writes the suppression', async () => {
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { listSuppressions } = await import('../../src/lib/lifecycle/suppression.js');
    const h = svixHeaders('msg_2', String(Math.floor(Date.now() / 1000)), payload);
    const res = await fetch(`${base}/webhooks/resend`, { method: 'POST', headers: h, body: payload });
    expect(res.status).toBe(200);
    const rows = await listSuppressions(hashEmail('bounced@example.com'));
    expect(rows.map((r) => r.reason)).toContain('bounce');
  });

  it('a complaint suppresses with its own reason', async () => {
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    const { listSuppressions } = await import('../../src/lib/lifecycle/suppression.js');
    const body = JSON.stringify({ type: 'email.complained', data: { to: 'angry@example.com' } });
    const h = svixHeaders('msg_3', String(Math.floor(Date.now() / 1000)), body);
    const res = await fetch(`${base}/webhooks/resend`, { method: 'POST', headers: h, body });
    expect(res.status).toBe(200);
    expect((await listSuppressions(hashEmail('angry@example.com'))).map((r) => r.reason)).toContain('complaint');
  });

  it('every other event type is 2xx-ignored — Resend must not retry what we do not consume', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { to: ['fine@example.com'] } });
    const h = svixHeaders('msg_4', String(Math.floor(Date.now() / 1000)), body);
    const res = await fetch(`${base}/webhooks/resend`, { method: 'POST', headers: h, body });
    expect(res.status).toBe(200);
    expect((await res.json() as { ignored?: string }).ignored).toBe('email.delivered');
  });

  /**
   * ASSERT THE REASON, NOT ONLY THE STATUS — and that distinction is not pedantry, it was
   * MEASURED. The first version of this test asserted `status === 400` alone and a deliberate
   * mutation deleting the entire `if (!secret)` fail-closed branch went UNDETECTED: with the
   * guard gone, verification simply ran against an empty secret, threw, and produced the same
   * 400. The test was green over a removed guard, which is the dark-guard shape exactly.
   *
   * The handler emits a distinguishable body per refusal, so the reason is assertable. If a
   * future SDK ever accepted an empty secret, THIS is the assertion that would notice.
   */
  it('FAIL-CLOSED: with no signing secret configured, the refusal names the missing secret', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const h = svixHeaders('msg_5', String(Math.floor(Date.now() / 1000)), payload);
    const res = await fetch(`${base}/webhooks/resend`, { method: 'POST', headers: h, body: payload });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('webhook signing secret not configured');
  });
});
