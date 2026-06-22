/**
 * REFERRAL-PARITY-NOTIFS-W1 / C1 — the referrer-notification primitive. Verifies:
 * channel resolution (email vs tg), default-ON + opt-out suppression, source_id
 * idempotency (replay-safe), the SoT-embedded payloads, inline email drain, and the
 * signed unsubscribe link. Allow-list: no outcome_* in payloads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ref-notify-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY; // email sends no-op → drain marks delivered
});

import {
  notifyReferrer,
  notifyFriendJoined,
  notifyCommissionEarned,
  drainEmailNotifications,
  notifyUnsubSig,
  notifyUnsubLink,
} from '../../src/lib/referral-notify.js';
import {
  ensureReferralSchema,
  mintPartnerCode,
  ensureUserCode,
  queueNotification,
  listPendingNotifications,
  getNotifyOptOut,
  setNotifyOptOut,
} from '../../src/lib/referral-store.js';
import { tgIdentity } from '../../src/lib/referral-api.js';
import { REFERRAL_TERMS } from '../../src/lib/referral-constants.js';
import { dbQuery, dbRun } from '../../src/lib/performance-db.js';

async function emailReferrer(code: string): Promise<string> {
  await mintPartnerCode({ code, owner_label: code, owner_email: `${code.toLowerCase()}@x.com` });
  return code;
}
async function tgReferrer(chatId: number): Promise<string> {
  return ensureUserCode(tgIdentity(chatId)); // owner_key = tg:<hash>, no email
}
async function notifRows(channel?: 'email' | 'tg') {
  const where = channel ? `WHERE channel = '${channel}'` : '';
  return dbQuery<Record<string, unknown>>(`SELECT id, referrer_code, event, channel, status, source_id, payload_json FROM referral_notifications ${where} ORDER BY id`, []);
}

beforeEach(async () => {
  ensureReferralSchema();
  for (const t of ['referral_codes', 'referral_attributions', 'referral_ledger', 'referral_bonus', 'referral_notifications']) dbRun(`DELETE FROM ${t}`);
});

describe('queueNotification — idempotent on (channel, source_id)', () => {
  it('dedups a replay', async () => {
    await emailReferrer('EMAILER1');
    const a = await queueNotification({ referrer_code: 'EMAILER1', event: 'friend_joined', channel: 'email', payload_json: null, source_id: 'attr:1' });
    const b = await queueNotification({ referrer_code: 'EMAILER1', event: 'friend_joined', channel: 'email', payload_json: null, source_id: 'attr:1' });
    expect(a.queued).toBe(true);
    expect(b.queued).toBe(false);
    expect(b.id).toBe(a.id);
    expect(await notifRows('email')).toHaveLength(1);
  });
});

describe('notify opt-out pref', () => {
  it('round-trips (default-ON = false)', async () => {
    const code = await emailReferrer('PREFER01');
    expect(await getNotifyOptOut(code)).toBe(false);
    await setNotifyOptOut(code, true);
    expect(await getNotifyOptOut(code)).toBe(true);
    await setNotifyOptOut(code, false);
    expect(await getNotifyOptOut(code)).toBe(false);
  });
});

describe('notifyReferrer — channel resolution', () => {
  it('email referrer → email row (drained inline → delivered); no tg row', async () => {
    await emailReferrer('EMAILER2');
    await notifyReferrer({ code: 'EMAILER2', event: 'friend_joined', sourceId: 'attr:2', payload: {} });
    expect(await notifRows('tg')).toHaveLength(0);
    const email = await notifRows('email');
    expect(email).toHaveLength(1);
    expect(String(email[0].status)).toBe('delivered'); // inline drain (Resend no-op) marks delivered
  });
  it('tg referrer → pending tg row (bot drains it); no email row', async () => {
    const code = await tgReferrer(55501);
    await notifyReferrer({ code, event: 'friend_joined', sourceId: 'attr:3', payload: {} });
    expect(await notifRows('email')).toHaveLength(0);
    const tg = await listPendingNotifications('tg');
    expect(tg).toHaveLength(1);
    expect(tg[0].referrer_code).toBe(code);
  });
  it('opt-out suppresses ALL channels', async () => {
    const code = await tgReferrer(55502);
    await setNotifyOptOut(code, true);
    await notifyReferrer({ code, event: 'commission_earned', sourceId: 'led:1', payload: { amount_usd_e2: 300, pending_usd_e2: 300 } });
    expect(await notifRows()).toHaveLength(0);
  });
  it('is idempotent across calls (same source_id)', async () => {
    const code = await tgReferrer(55503);
    await notifyReferrer({ code, event: 'friend_joined', sourceId: 'attr:9' });
    await notifyReferrer({ code, event: 'friend_joined', sourceId: 'attr:9' });
    expect(await notifRows('tg')).toHaveLength(1);
  });
  it('unknown code → no rows, no throw', async () => {
    await notifyReferrer({ code: 'NOSUCH9', event: 'friend_joined', sourceId: 'attr:99' });
    expect(await notifRows()).toHaveLength(0);
  });
});

describe('trigger helpers embed SoT numbers (zero literals downstream)', () => {
  it('friend_joined payload carries commission_pct + months from SoT', async () => {
    const code = await tgReferrer(55610);
    await notifyFriendJoined(code, 21);
    const [row] = await listPendingNotifications('tg');
    const p = JSON.parse(String(row.payload_json));
    expect(p.commission_pct).toBe(Math.round(REFERRAL_TERMS.COMMISSION_RATE * 100));
    expect(p.commission_months).toBe(REFERRAL_TERMS.COMMISSION_MONTHS);
  });
  it('commission_earned payload carries amount/pending + min from SoT', async () => {
    const code = await tgReferrer(55611);
    await notifyCommissionEarned(code, 42, { amount_usd_e2: 600, pending_usd_e2: 900 });
    const [row] = await listPendingNotifications('tg');
    const p = JSON.parse(String(row.payload_json));
    expect(p.amount_usd_e2).toBe(600);
    expect(p.pending_usd_e2).toBe(900);
    expect(p.usdc_min_payout_usd).toBe(REFERRAL_TERMS.USDC_MIN_PAYOUT_USD);
    expect(JSON.stringify(p)).not.toMatch(/outcome_/);
  });
});

describe('drainEmailNotifications', () => {
  it('marks pending email rows delivered (Resend no-op in test)', async () => {
    await emailReferrer('DRAIN001');
    await queueNotification({ referrer_code: 'DRAIN001', event: 'friend_joined', channel: 'email', payload_json: null, source_id: 'attr:7' });
    const res = await drainEmailNotifications();
    expect(res.sent).toBe(1);
    expect((await notifRows('email'))[0].status).toBe('delivered');
  });
});

describe('notifyUnsubSig / notifyUnsubLink', () => {
  it('sig is deterministic + the link carries c + t', () => {
    expect(notifyUnsubSig('ABC123')).toBe(notifyUnsubSig('ABC123'));
    expect(notifyUnsubSig('ABC123')).not.toBe(notifyUnsubSig('XYZ789'));
    const link = notifyUnsubLink('ABC123');
    expect(link).toContain('/referral/notify/unsubscribe?c=ABC123&t=');
    expect(link).toContain(notifyUnsubSig('ABC123'));
  });
});
