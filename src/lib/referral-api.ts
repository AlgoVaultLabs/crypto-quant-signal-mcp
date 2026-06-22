/**
 * TG-REFERRAL-W1 / C1 — Referral machine API + Telegram identity lane.
 *
 * A thin internal JSON API the public Telegram bot (algovault-bot) calls over
 * loopback (internal-bypass key) to (a) resolve/mint a referral code for a TG
 * user and (b) record a TG referral attribution. It reuses the REFERRAL-LIGHT-W1
 * engine (referral-store) as the SINGLE source of truth — no new tables, no
 * Stripe/accrual change, no outcome_* exposure.
 *
 * Identity bridge: TG users have no apiKey/email, so they get a deterministic,
 * opaque `tg:<hash>` identity lane. Codes derive from it (`deriveUserCode`);
 * attributions dedupe on it through the existing `referee_email UNIQUE`
 * (one grant per TG referee). The +500 referee bonus applies to the BOT's own
 * quota (TG users meter bot-side) — this API returns the SoT amount so the bot
 * never hardcodes it; the referrer's commission still flows via the web
 * `invoice.paid` path (unchanged).
 *
 * Business logic only (no Express/req/res) → unit-testable; index.ts mounts the
 * routes and enforces the internal-bypass auth (the bot is the only caller).
 */
import { createHmac } from 'node:crypto';
import { ensureUserCode, resolveCode, recordAttribution, referrerStats } from './referral-store.js';
import { REFERRAL_TERMS, isValidCodeFormat, shareLink } from './referral-constants.js';
import { notifyFriendJoined } from './referral-notify.js';

/** Canonical bot handle for the deep link (getMe-verified 2026-06-20). */
const BOT_USERNAME = 'algovaultofficialbot';

// Fixed, non-secret salt. It does not protect a secret — it keeps RAW Telegram
// chat_ids out of the referral tables (we persist an opaque `tg:<hash>` identity
// instead) and makes the mapping deterministic (same chat_id → same identity →
// same code forever). Bump the version suffix only with a planned re-key.
const TG_IDENTITY_SALT = 'algovault-tg-identity-v1';

/** Deterministic, opaque identity-lane key for a Telegram chat_id. */
export function tgIdentity(chatId: number | string): string {
  const id = String(chatId).trim();
  const h = createHmac('sha256', TG_IDENTITY_SALT).update(id).digest('base64url');
  return `tg:${h.slice(0, 22)}`; // 22 base64url chars ≈ 132 bits — collision-free across all TG users
}

/** The Telegram deep link that attributes a new joiner to `code` on /start. */
export function tgDeepLink(code: string): string {
  return `https://t.me/${BOT_USERNAME}?start=ref_${encodeURIComponent(code)}`;
}

/** Program terms projected from the SoT (REFERRAL_TERMS) — never hardcoded downstream. */
export function referralTerms(): { bonus_calls: number; commission_pct: number; commission_months: number; usdc_min_payout_usd: number } {
  return {
    bonus_calls: REFERRAL_TERMS.BONUS_CALLS,
    commission_pct: Math.round(REFERRAL_TERMS.COMMISSION_RATE * 100),
    commission_months: REFERRAL_TERMS.COMMISSION_MONTHS,
    usdc_min_payout_usd: REFERRAL_TERMS.USDC_MIN_PAYOUT_USD,
  };
}

export interface TgCodeResult {
  code: string;
  share_url: string; // web /signup?ref=<code>
  deep_link: string; // t.me/<bot>?start=ref_<code>
  terms: { bonus_calls: number; commission_pct: number; commission_months: number; usdc_min_payout_usd: number };
  stats: {
    signups: number;
    conversions: number;
    accrued_usd_e2: number;
    credited_usd_e2: number;
    usdc_pending_usd_e2: number;
    usdc_paid_usd_e2: number;
  };
}

/** Resolve-or-mint the caller's (TG) referral code, with shareable links + their stats. */
export async function resolveTgReferralCode(chatId: number | string): Promise<TgCodeResult> {
  const identity = tgIdentity(chatId);
  const code = await ensureUserCode(identity);
  const s = await referrerStats(code);
  return {
    code,
    share_url: shareLink(code),
    deep_link: tgDeepLink(code),
    terms: referralTerms(),
    stats: {
      signups: s.signups,
      conversions: s.conversions,
      accrued_usd_e2: s.accrued_usd_e2,
      credited_usd_e2: s.credited_usd_e2,
      usdc_pending_usd_e2: s.usdc_pending_usd_e2,
      usdc_paid_usd_e2: s.usdc_paid_usd_e2,
    },
  };
}

export type AttributeReason = 'invalid_code' | 'unknown_code' | 'self_referral' | 'already_attributed';

export interface TgAttributeResult {
  recorded: boolean;
  /** Bonus calls the bot should grant to the referee's BOT quota when recorded. */
  bonus_calls: number;
  reason?: AttributeReason;
}

/**
 * Record a TG referee→referrer attribution (channel='tg'); idempotent + abuse-guarded.
 * - one grant per TG referee (referee_email = the referee's tg identity, UNIQUE);
 * - self-referral refused (the code's owner == the referee's identity);
 * - unknown/invalid code refused.
 * Returns the SoT bonus amount the bot grants to the referee's BOT quota.
 */
export async function attributeTgReferral(
  refCodeRaw: string,
  refereeChatId: number | string,
): Promise<TgAttributeResult> {
  const refCode = String(refCodeRaw || '').toUpperCase();
  if (!isValidCodeFormat(refCode)) return { recorded: false, bonus_calls: 0, reason: 'invalid_code' };

  const codeRow = await resolveCode(refCode);
  if (!codeRow) return { recorded: false, bonus_calls: 0, reason: 'unknown_code' };

  const refereeIdentity = tgIdentity(refereeChatId);
  // Self-referral: the referrer's own (tg) identity is the referee's identity.
  if (codeRow.owner_key && codeRow.owner_key === refereeIdentity) {
    return { recorded: false, bonus_calls: 0, reason: 'self_referral' };
  }

  const res = await recordAttribution({
    code: refCode,
    referee_email: refereeIdentity, // occupies the UNIQUE one-grant-per-human slot (never an @-email)
    referee_key: refereeIdentity,
    channel: 'tg',
  });
  if (!res.recorded) return { recorded: false, bonus_calls: 0, reason: 'already_attributed' };
  if (res.id != null) await notifyFriendJoined(refCode, res.id); // fail-soft inside
  return { recorded: true, bonus_calls: REFERRAL_TERMS.BONUS_CALLS };
}
