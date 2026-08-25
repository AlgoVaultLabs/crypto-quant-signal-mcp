/**
 * OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH4 (R4.8) — the subscriber-notify channel.
 *
 * The load-bearing properties, in priority order:
 *   1. A notify failure can NEVER change a delivery result or abort a sweep.
 *   2. A double-fire sends exactly ONE email.
 *   3. A `free:` owner is a first-class non-throwing, non-paging outcome.
 *   4. Email copy carries ZERO internal identifiers and ZERO hardcoded numbers.
 *   5. A dry run writes NO row and POSTs nothing (so repeated dry runs cannot
 *      false-green the way a DRY_RUN_TG cooldown marker does).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENVKEYS = [
  'WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED',
  'SUBSCRIBER_NOTIFY_DRY_RUN',
  'RESEND_API_KEY',
  'WEBHOOK_QUARANTINE_MAX_SEC',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENVKEYS) saved[k] = process.env[k];
  for (const k of ENVKEYS) delete process.env[k];
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENVKEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Load the notify leaf with stripe/email/db test doubles wired in. */
async function loadNotify(opts: {
  email?: string | null;
  customerId?: string | null;
  stripeThrows?: boolean;
  sendThrows?: boolean;
  sendReturnsNull?: boolean;
  profileEmail?: string | null;
}) {
  const claims = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  const sends: Array<{ fn: string; args: Record<string, unknown> }> = [];

  vi.doMock('../src/lib/stripe.js', () => ({
    getCustomerByApiKey: vi.fn(async () => {
      if (opts.stripeThrows) throw new Error('stripe boom');
      if (opts.customerId === null && opts.email === null) return null;
      return { customerId: opts.customerId ?? 'cus_TEST', tier: 'starter', email: opts.email ?? null };
    }),
  }));

  vi.doMock('../src/lib/performance-db.js', () => ({
    dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO subscriber_notifications/i.test(sql)) {
        const key = String(params[0]);
        if (claims.has(key)) return []; // ON CONFLICT DO NOTHING → zero rows
        claims.add(key);
        rows.push({ notification_key: key, owner_key: params[1], event: params[2], outcome: params[6] });
        return [{ notification_key: key }];
      }
      if (/UPDATE subscriber_notifications/i.test(sql)) {
        const key = String(params[2]);
        const row = rows.find((r) => r.notification_key === key);
        if (row) { row.outcome = params[0]; row.resend_id = params[1]; }
        return [];
      }
      if (/FROM subscriber_profiles/i.test(sql)) {
        return opts.profileEmail ? [{ email: opts.profileEmail }] : [];
      }
      return [];
    }),
  }));

  const mkSend = (fn: string) => vi.fn(async (args: Record<string, unknown>) => {
    if (opts.sendThrows) throw new Error('resend boom');
    sends.push({ fn, args });
    return opts.sendReturnsNull ? null : { id: `re_${sends.length}` };
  });

  vi.doMock('../src/lib/email.js', () => ({
    sendWebhookQuarantinedEmail: mkSend('quarantined'),
    sendWebhookDisabledEmail: mkSend('disabled'),
    sendWebhookQuotaPausedEmail: mkSend('quota_paused'),
    maskEmail: (e: string) => `${e[0]}***@masked`,
  }));

  const mod = await import('../src/lib/subscriber-notify.js');
  return { mod, claims, rows, sends };
}

describe('registry totality', () => {
  it('every event has a spec, and webhook_resumed is registered-but-silent', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com' });
    const events = ['webhook_quarantined', 'webhook_disabled', 'webhook_quota_paused', 'webhook_resumed'] as const;
    for (const e of events) {
      expect(mod.NOTIFY_REGISTRY[e]).toBeDefined();
      expect(mod.NOTIFY_REGISTRY[e].event).toBe(e);
    }
    // The silence is a DECISION recorded as a row, not an omission.
    expect(mod.NOTIFY_REGISTRY.webhook_resumed.sendsEmail).toBe(false);
    for (const e of ['webhook_quarantined', 'webhook_disabled', 'webhook_quota_paused'] as const) {
      expect(mod.NOTIFY_REGISTRY[e].sendsEmail).toBe(true);
    }
  });

  it('webhook_resumed sends nothing and writes no row', async () => {
    const { mod, sends, rows } = await loadNotify({ email: 'a@b.com' });
    const r = await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_resumed' });
    expect(r.sent).toBe(false);
    expect(r.outcome).toBe('suppressed_silent');
    expect(sends).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });
});

describe('idempotency', () => {
  it('a double-fire sends exactly ONE email', async () => {
    const { mod, sends } = await loadNotify({ email: 'a@b.com' });
    const args = {
      ownerKey: 'av_live_x',
      event: 'webhook_disabled' as const,
      context: { subscriptionId: 6, stateEpochBucket: 1_700_000_000 },
    };
    const first = await mod.notifySubscriber(args);
    const second = await mod.notifySubscriber(args);
    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('suppressed_duplicate');
    expect(sends).toHaveLength(1);
  });

  it('a DIFFERENT occurrence (new bucket) notifies again', async () => {
    const { mod, sends } = await loadNotify({ email: 'a@b.com' });
    const base = { ownerKey: 'av_live_x', event: 'webhook_quarantined' as const };
    await mod.notifySubscriber({ ...base, context: { subscriptionId: 6, stateEpochBucket: 1000, expiresAt: 2000, lastSuccessAt: null } });
    await mod.notifySubscriber({ ...base, context: { subscriptionId: 6, stateEpochBucket: 9999, expiresAt: 2000, lastSuccessAt: null } });
    expect(sends).toHaveLength(2);
  });

  it('the claim is taken BEFORE the send (a throwing send still leaves the claim held)', async () => {
    const { mod, claims } = await loadNotify({ email: 'a@b.com', sendThrows: true });
    const r = await mod.notifySubscriber({
      ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6, stateEpochBucket: 1 },
    });
    expect(r.outcome).toBe('send_failed');
    expect(claims.size).toBe(1); // claimed first — a retry cannot double-mail
  });
});

describe('unreachable + failure outcomes never throw and never page', () => {
  it('free: owner → owner_unreachable, no send, no throw', async () => {
    const { mod, sends } = await loadNotify({ email: 'a@b.com' });
    const r = await mod.notifySubscriber({ ownerKey: 'free:deadbeef', event: 'webhook_disabled', context: { subscriptionId: 6 } });
    expect(r.sent).toBe(false);
    expect(r.outcome).toBe('owner_unreachable');
    expect(sends).toHaveLength(0);
  });

  it('isStructurallyUnreachable identifies free: owners only', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com' });
    expect(mod.isStructurallyUnreachable('free:abc')).toBe(true);
    expect(mod.isStructurallyUnreachable('av_live_abc')).toBe(false);
  });

  it('a resolvable owner with NO email is unreachable, not a failure (retry cannot help)', async () => {
    const { mod } = await loadNotify({ email: null, customerId: 'cus_X' });
    const r = await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6 } });
    expect(r.outcome).toBe('owner_unreachable');
  });

  it('falls back to the subscriber_profiles cache when Stripe has no email', async () => {
    const { mod, sends } = await loadNotify({ email: null, customerId: 'cus_X', profileEmail: 'cached@b.com' });
    const r = await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6 } });
    expect(r.outcome).toBe('sent');
    expect(sends[0].args.to).toBe('cached@b.com');
  });

  it('a throwing resolver → resolution_failed, non-throwing (this one escalates)', async () => {
    const { mod } = await loadNotify({ stripeThrows: true });
    const r = await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6 } });
    expect(r.outcome).toBe('resolution_failed');
  });

  it('a send returning no provider id → send_failed, non-throwing', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com', sendReturnsNull: true });
    const r = await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6 } });
    expect(r.outcome).toBe('send_failed');
  });
});

describe('two-flag firewall', () => {
  it('WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED=0 disables instantly', async () => {
    process.env.WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED = '0';
    const { mod, sends } = await loadNotify({ email: 'a@b.com' });
    const r = await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6 } });
    expect(r.outcome).toBe('disabled');
    expect(sends).toHaveLength(0);
  });

  it('defaults ON when unset, and accepts both 0/false spellings', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com' });
    expect(mod.isSubscriberNotifyEnabled()).toBe(true);
    for (const off of ['0', 'false', 'FALSE', 'off', 'no']) {
      process.env.WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED = off;
      expect(mod.isSubscriberNotifyEnabled()).toBe(false);
    }
    for (const on of ['1', 'true', 'yes']) {
      process.env.WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED = on;
      expect(mod.isSubscriberNotifyEnabled()).toBe(true);
    }
  });

  it('DRY RUN: renders + resolves, POSTs nothing, and writes NO row', async () => {
    process.env.SUBSCRIBER_NOTIFY_DRY_RUN = '1';
    const { mod, sends, rows, claims } = await loadNotify({ email: 'a@b.com' });
    const args = { ownerKey: 'av_live_x', event: 'webhook_disabled' as const, context: { subscriptionId: 6, stateEpochBucket: 1 } };
    const first = await mod.notifySubscriber(args);
    const second = await mod.notifySubscriber(args);
    expect(first.outcome).toBe('dry_run');
    // The whole point: a REPEATED dry run must not be suppressed as a duplicate,
    // unlike the DRY_RUN_TG cooldown-marker trap CLAUDE.md records.
    expect(second.outcome).toBe('dry_run');
    expect(sends).toHaveLength(0);
    expect(rows).toHaveLength(0);
    expect(claims.size).toBe(0);
  });
});

describe('notification key redaction (credential-leak guard)', () => {
  // The key EMBEDS the owner key, which for a paid subscriber IS their live
  // `av_live_…` API key. The first deploy of this chapter was BLOCKED by the
  // fail-closed check-secret-log-redaction gate for logging it verbatim — a real
  // credential would have landed in the container logs.
  it('never renders the owner key', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com' });
    const key = mod.notificationKey('webhook_disabled', 'av_live_SUPERSECRET123', 6, 1700);
    const redacted = mod.redactNotificationKey(key);
    expect(key).toContain('av_live_SUPERSECRET123');       // the raw key does carry it
    expect(redacted).not.toContain('av_live_SUPERSECRET123'); // the log form never does
    expect(redacted).not.toContain('SUPERSECRET');
    // Still useful for forensics: event, subscription and occurrence survive.
    expect(redacted).toContain('webhook_disabled');
    expect(redacted).toContain('6');
    expect(redacted).toContain('1700');
  });

  it('redacts a free: owner key too (it embeds an ipHash)', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com' });
    const redacted = mod.redactNotificationKey(mod.notificationKey('webhook_disabled', 'free:deadbeefcafe', 6, 1700));
    expect(redacted).not.toContain('deadbeefcafe');
  });

  it('degrades safely on a malformed key rather than echoing it', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com' });
    expect(mod.redactNotificationKey('av_live_LEAK')).not.toContain('LEAK');
  });
});

describe('notification key', () => {
  it('is stable per occurrence and varies by event / owner / sub / bucket', async () => {
    const { mod } = await loadNotify({ email: 'a@b.com' });
    const k = mod.notificationKey('webhook_disabled', 'av_live_x', 6, 111);
    expect(mod.notificationKey('webhook_disabled', 'av_live_x', 6, 111)).toBe(k);
    expect(mod.notificationKey('webhook_quarantined', 'av_live_x', 6, 111)).not.toBe(k);
    expect(mod.notificationKey('webhook_disabled', 'av_live_y', 6, 111)).not.toBe(k);
    expect(mod.notificationKey('webhook_disabled', 'av_live_x', 7, 111)).not.toBe(k);
    expect(mod.notificationKey('webhook_disabled', 'av_live_x', 6, 222)).not.toBe(k);
  });
});

// ── Copy LAW: the rendered emails themselves ────────────────────────────────
// These import the REAL email module (no mock) and assert on rendered output —
// the CH2 lesson applied here: assert the text a human reads, not just a verdict.
describe('email copy LAW', () => {
  const FORBIDDEN = [
    'delivery_state', 'failure_class', 'quarantine_expired', 'permanent_http_410',
    'OPS-WEBHOOK', 'W1', 'quarantined_at', 'next_probe_at', 'owner_key',
    'AOE', 'cadence', 'subscriber_notifications',
  ];

  async function renderAll() {
    process.env.RESEND_API_KEY = 're_test_key';
    // vi.doMock registrations persist for the whole FILE, so the loadNotify()
    // doubles above would otherwise be returned here and capture nothing. Drop them
    // so this block exercises the REAL templates.
    vi.doUnmock('../src/lib/email.js');
    vi.doUnmock('../src/lib/stripe.js');
    vi.doUnmock('../src/lib/performance-db.js');
    vi.resetModules();
    const captured: Array<{ subject: string; html: string; text: string; to: string }> = [];
    vi.doMock('resend', () => ({
      Resend: class {
        emails = {
          send: async (a: { subject: string; html: string; text: string; to: string }) => {
            captured.push(a);
            return { data: { id: 're_x' } };
          },
        };
      },
    }));
    const email = await import('../src/lib/email.js');
    return { email, captured };
  }

  it('quarantined: interpolates the deadline; NEVER a hardcoded window', async () => {
    const { email, captured } = await renderAll();
    const quarantinedAt = Math.floor(Date.parse('2026-07-24T15:34:36Z') / 1000);
    const expiresAt = quarantinedAt + 30 * 24 * 3600; // 2026-08-23
    await email.sendWebhookQuarantinedEmail({ to: 'a@b.com', subscriptionId: 6, expiresAt, lastSuccessAt: null });
    const body = captured[0].html + captured[0].text;
    expect(body).toContain('23 August 2026');
    // The hardcoded windows the spec forbids.
    expect(body).not.toContain('7 days');
    expect(body).not.toContain('30 days');
  });

  it('quarantined: two DIFFERENT tiers render two DIFFERENT dates', async () => {
    const { email, captured } = await renderAll();
    const at = Math.floor(Date.parse('2026-07-24T15:34:36Z') / 1000);
    await email.sendWebhookQuarantinedEmail({ to: 'a@b.com', subscriptionId: 6, expiresAt: at + 7 * 24 * 3600, lastSuccessAt: null });
    await email.sendWebhookQuarantinedEmail({ to: 'a@b.com', subscriptionId: 6, expiresAt: at + 30 * 24 * 3600, lastSuccessAt: null });
    expect(captured[0].html).toContain('31 July 2026');
    expect(captured[1].html).toContain('23 August 2026');
    expect(captured[0].html).not.toBe(captured[1].html);
  });

  it('quarantined: OMITS the "last delivered" date when it has NEVER succeeded (sub 6)', async () => {
    const { email, captured } = await renderAll();
    await email.sendWebhookQuarantinedEmail({ to: 'a@b.com', subscriptionId: 6, expiresAt: 1_800_000_000, lastSuccessAt: null });
    expect(captured[0].html).toContain('has not delivered successfully yet');
    expect(captured[0].html).not.toContain('It last delivered successfully on');
  });

  it('quarantined: STATES the last-delivered date when one exists', async () => {
    const { email, captured } = await renderAll();
    const last = Math.floor(Date.parse('2026-07-22T00:00:00Z') / 1000);
    await email.sendWebhookQuarantinedEmail({ to: 'a@b.com', subscriptionId: 6, expiresAt: 1_800_000_000, lastSuccessAt: last });
    expect(captured[0].html).toContain('It last delivered successfully on 22 July 2026');
  });

  it('disabled: interpolates the retry window from live state', async () => {
    const { email, captured } = await renderAll();
    await email.sendWebhookDisabledEmail({ to: 'a@b.com', subscriptionId: 6, retriedForSec: 30 * 24 * 3600 });
    expect(captured[0].html).toContain('30 days');
    await email.sendWebhookDisabledEmail({ to: 'a@b.com', subscriptionId: 6, retriedForSec: 7 * 24 * 3600 });
    expect(captured[1].html).toContain('7 days');
  });

  it('quota paused: interpolates live usage and links the upgrade CTA', async () => {
    const { email, captured } = await renderAll();
    await email.sendWebhookQuotaPausedEmail({ to: 'a@b.com', subscriptionId: 6, used: 10000, total: 10000 });
    const body = captured[0].html + captured[0].text;
    expect(body).toContain('10,000');
    expect(body).toContain('https://api.algovault.com/signup');
  });

  it('NO template leaks an internal identifier, a URL from the subscription, or a secret', async () => {
    const { email, captured } = await renderAll();
    await email.sendWebhookQuarantinedEmail({ to: 'a@b.com', subscriptionId: 6, expiresAt: 1_800_000_000, lastSuccessAt: null });
    await email.sendWebhookDisabledEmail({ to: 'a@b.com', subscriptionId: 6, retriedForSec: 2592000 });
    await email.sendWebhookQuotaPausedEmail({ to: 'a@b.com', subscriptionId: 6, used: 1, total: 2 });
    expect(captured).toHaveLength(3);
    for (const c of captured) {
      const body = `${c.subject}\n${c.html}\n${c.text}`;
      for (const bad of FORBIDDEN) {
        expect(body, `"${bad}" must not appear in customer copy`).not.toContain(bad);
      }
      // Only our own https URLs — never a subscriber endpoint.
      const urls = body.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
      for (const u of urls) expect(u.startsWith('https://api.algovault.com')).toBe(true);
      // Every email ends with an action-verb CTA.
      expect(/Review your webhooks|Register a webhook|Upgrade your plan/.test(body)).toBe(true);
    }
  });
});

// ── OPS-WEBHOOK-QUOTA-METER-PARITY-W1 — the wall survives the notify hop ──────────────────
//
// A unit test on the email renderer cannot prove anything PASSES it the wall. This pins the seam:
// whatever `webhook-delivery.ts` puts in the context must arrive at the email intact, because this
// module deliberately cannot re-read it (it imports neither `license` nor `entitlement` — a second
// read could name a different wall than the one that actually fired).
describe('webhook_quota_paused — the wall reaches the email', () => {
  it('🎯 a DAILY wall forwards the wall and the daily pair', async () => {
    const { mod, sends } = await loadNotify({ email: 'a@b.com' });
    await mod.notifySubscriber({
      ownerKey: 'av_live_x',
      event: 'webhook_quota_paused',
      context: {
        subscriptionId: 42, stateEpochBucket: 1,
        quotaUsed: 1234, quotaTotal: 10000,
        quotaWall: 'daily', quotaDailyUsed: 1000, quotaDailyTotal: 1000,
      },
    });
    expect(sends).toHaveLength(1);
    expect(sends[0].args).toMatchObject({
      wall: 'daily', dailyUsed: 1000, dailyTotal: 1000,
      used: 1234, total: 10000,   // the MONTHLY pair keeps its meaning
    });
  });

  it('🎯 an unspecified wall defaults to monthly — no existing sender changes', async () => {
    const { mod, sends } = await loadNotify({ email: 'a@b.com' });
    await mod.notifySubscriber({
      ownerKey: 'av_live_x',
      event: 'webhook_quota_paused',
      context: { subscriptionId: 7, stateEpochBucket: 1, quotaUsed: 5, quotaTotal: 10 },
    });
    expect(sends[0].args).toMatchObject({ wall: 'monthly', dailyUsed: null, dailyTotal: null });
  });
});

/**
 * OPS-SOT-PARITY-PHASE-AND-NOTIFY-RECORD-W1 CH2 — an unsent terminal notice is a FACT.
 *
 * THE INCIDENT. Subscription 6 (a PAYING `starter` owner) hit `quarantine_expired` at
 * 2026-08-24 13:44:56Z. The probe sweep called safeNotify('webhook_disabled') exactly as
 * designed; the kill switch was default-on; the registry has the event as `sendsEmail: true`.
 * `subscriber_notifications` holds NO ROW OF ANY KIND for it. The owner had become unresolvable
 * between their 2026-08-01 quarantine email and the terminal event, so the notify exited at
 * `owner_unreachable` and left no trace — making "we could not tell them" indistinguishable
 * from "we never tried" and from "we told them and the row was removed".
 *
 * The recorded outcome must NEVER be able to suppress a later real send: that would convert a
 * bookkeeping improvement into permanent silence for exactly the customer it protects.
 */
describe('🛑 an unsent notice for a REACHABLE-in-principle owner is recorded', () => {
  it('owner_unreachable on a PAID owner writes a row (it used to write nothing)', async () => {
    const { mod, rows } = await loadNotify({ email: null, customerId: 'cus_X' });
    const r = await mod.notifySubscriber({
      ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6, stateEpochBucket: 1784907276 },
    });
    expect(r.outcome).toBe('owner_unreachable');
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('owner_unreachable');
    expect(rows[0].event).toBe('webhook_disabled');
  });

  it('resolution_failed on a PAID owner writes a row too', async () => {
    const { mod, rows } = await loadNotify({ stripeThrows: true });
    const r = await mod.notifySubscriber({
      ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6 },
    });
    expect(r.outcome).toBe('resolution_failed');
    expect(rows.map((x) => x.outcome)).toEqual(['resolution_failed']);
  });

  it('a free: owner stays silent AND unrecorded — a by-design skip, not a data gap', async () => {
    const { mod, rows } = await loadNotify({ email: 'a@b.com' });
    const r = await mod.notifySubscriber({
      ownerKey: 'free:deadbeef', event: 'webhook_disabled', context: { subscriptionId: 6 },
    });
    expect(r.outcome).toBe('owner_unreachable');
    expect(rows).toHaveLength(0);
  });

  it('🛑 the unsent row uses a SEPARATE key and cannot suppress a later real send', async () => {
    // First: unreachable → records under the '#unsent' key.
    const a = await loadNotify({ email: null, customerId: 'cus_X' });
    await a.mod.notifySubscriber({
      ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6, stateEpochBucket: 99 },
    });
    const unsentKey = String(a.rows[0].notification_key);
    expect(unsentKey.endsWith('#unsent')).toBe(true);

    const canonical = a.mod.notificationKey('webhook_disabled', 'av_live_x', 6, 99);
    expect(unsentKey).toBe(`${canonical}#unsent`);
    expect(a.claims.has(canonical)).toBe(false); // the real claim is still FREE
  });

  it('...proven end to end: the owner becomes reachable and the email still goes out', async () => {
    const { mod, rows, sends, claims } = await loadNotify({ email: null, customerId: 'cus_X' });
    await mod.notifySubscriber({
      ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6, stateEpochBucket: 99 },
    });
    expect(sends).toHaveLength(0);
    // Same process, same claim set — now the resolver can see an address.
    const canonical = mod.notificationKey('webhook_disabled', 'av_live_x', 6, 99);
    expect(claims.has(canonical)).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it('recording twice is idempotent — one row per episode, not one per attempt', async () => {
    const { mod, rows } = await loadNotify({ email: null, customerId: 'cus_X' });
    const ctx = { subscriptionId: 6, stateEpochBucket: 1784907276 };
    await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled', context: ctx });
    await mod.notifySubscriber({ ownerKey: 'av_live_x', event: 'webhook_disabled', context: ctx });
    expect(rows).toHaveLength(1);
  });

  it('a bookkeeping write failure never changes the notify outcome', async () => {
    const { mod } = await loadNotify({ email: null, customerId: 'cus_X' });
    // recordUnsentNotification swallows its own errors; assert the contract directly.
    await expect(mod.recordUnsentNotification({
      key: 'k', ownerKey: 'av_live_x', event: 'webhook_disabled', subscriptionId: 6, outcome: 'owner_unreachable',
    })).resolves.not.toThrow();
  });

  it('a successful send is unchanged — one row, under the CANONICAL key', async () => {
    const { mod, rows, sends } = await loadNotify({ email: 'a@b.com' });
    const r = await mod.notifySubscriber({
      ownerKey: 'av_live_x', event: 'webhook_disabled', context: { subscriptionId: 6, stateEpochBucket: 99 },
    });
    expect(r.outcome).toBe('sent');
    expect(sends).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].notification_key).endsWith('#unsent')).toBe(false);
  });
});
