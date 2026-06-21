/**
 * Resend transactional email integration.
 *
 * Two outbound emails:
 *   - sendWelcomeEmail({to, apiKey, tier}) — fired from customer.subscription.created webhook
 *   - sendKeyRecoveryEmail({to, apiKey, tier}) — fired from /account/recover-key
 *
 * Graceful degradation: if RESEND_API_KEY is unset, getResendClient() returns null
 * and sends become no-ops with a console.warn (dev/staging without the key won't crash).
 */
import { Resend } from 'resend';
// REFERRAL-LIGHT-W1 (C4): welcome-email referral block + referred-free key variant.
// Program numbers interpolate from REFERRAL_TERMS renderers (never hardcoded —
// chapter gate). deriveUserCode is the pure code derivation (no DB).
import { deriveUserCode } from './referral-store.js';
import { commissionPct, commissionMonthsLabel, bonusCallsLabel, shareLink, formatUsdE2 } from './referral-constants.js';

const FROM_DEFAULT = 'noreply@algovault.com';
const ACCOUNT_URL = 'https://api.algovault.com/account';
const REFERRAL_TERMS_URL = 'https://api.algovault.com/referral-terms';

let resend: Resend | null = null;
let initWarned = false;

export function getResendClient(): Resend | null {
  if (resend) return resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (!initWarned) {
      console.warn('Resend: RESEND_API_KEY not set — email sends will be no-ops');
      initWarned = true;
    }
    return null;
  }
  resend = new Resend(key);
  return resend;
}

function getFromAddress(): string {
  return process.env.RESEND_FROM_EMAIL || FROM_DEFAULT;
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

interface EmailArgs {
  to: string;
  apiKey: string;
  tier: string;
}

export async function sendWelcomeEmail({ to, apiKey, tier }: EmailArgs): Promise<void> {
  const client = getResendClient();
  if (!client) return;

  const tierTitle = tier.charAt(0).toUpperCase() + tier.slice(1);
  const subject = `Your AlgoVault ${tierTitle} API key`;
  // REFERRAL-LIGHT-W1 (C4): the new subscriber's OWN referral code + share link.
  const refCode = deriveUserCode(apiKey);
  const referral = { code: refCode, link: shareLink(refCode), termsUrl: REFERRAL_TERMS_URL };
  const html = renderEmailHtml({
    heading: `Welcome to AlgoVault ${tierTitle}`,
    intro: `Your subscription is active. Below is your API key — save it somewhere safe.`,
    apiKey,
    tier: tierTitle,
    referral,
  });
  const text = renderEmailText({
    heading: `Welcome to AlgoVault ${tierTitle}`,
    intro: `Your subscription is active. Below is your API key — save it somewhere safe.`,
    apiKey,
    tier: tierTitle,
    referral,
  });

  await client.emails.send({
    from: getFromAddress(),
    to,
    replyTo: 'support@algovault.com',
    subject,
    html,
    text,
  });
}

export async function sendKeyRecoveryEmail({ to, apiKey, tier }: EmailArgs): Promise<void> {
  const client = getResendClient();
  if (!client) return;

  const tierTitle = tier.charAt(0).toUpperCase() + tier.slice(1);
  const subject = `AlgoVault — your API key`;
  const html = renderEmailHtml({
    heading: `Your AlgoVault API key`,
    intro: `You requested key recovery for your ${tierTitle} subscription. Below is your active API key.`,
    apiKey,
    tier: tierTitle,
  });
  const text = renderEmailText({
    heading: `Your AlgoVault API key`,
    intro: `You requested key recovery for your ${tierTitle} subscription. Below is your active API key.`,
    apiKey,
    tier: tierTitle,
  });

  await client.emails.send({
    from: getFromAddress(),
    to,
    replyTo: 'support@algovault.com',
    subject,
    html,
    text,
  });
}

// POWER-USER-OUTREACH-W1-V2 (2026-05-28): opt-in confirmation email for free-tier
// signups via /welcome paywall CTA. Distinct from sendWelcomeEmail() (Stripe-
// paid customers only) — this is for free-tier email-opt-in capture.
// LIVE substitution at send-time: PFE_WR + TOTAL_SIGNALS pulled from
// /api/performance-public so the public-track-record stats in the email body
// reflect current state, not a build-time-frozen snapshot. Fail-open on stats
// fetch errors — substitute neutral fallback strings rather than crash.
interface OptinSubstitutionStats {
  pfeWr: string;
  totalSignals: string;
}

async function fetchPerformancePublicStats(): Promise<OptinSubstitutionStats> {
  const fallback = { pfeWr: '90+', totalSignals: '100K+' };
  const baseUrl = process.env.API_BASE_URL || 'https://api.algovault.com';
  try {
    const res = await fetch(`${baseUrl}/api/performance-public`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      overall?: { pfeWinRate?: number | null; totalCalls?: number | null };
      totalCalls?: number | null;
    };
    // PFE WR is NESTED at `.overall.pfeWinRate` (a FRACTION, e.g. 0.9157) — there
    // is no top-level `pfeWinRate` field. The prior `data.pfeWinRate.toFixed(1)`
    // read was doubly wrong (absent path → undefined → fallback; and even if
    // present, a fraction without ×100 would render "0.9"). Canonical read mirrors
    // `track-record-snapshot.ts`: ×100, 1 dp → "91.6". (ACTIVATION-NUDGE-W1 flag.)
    const wrFraction = data.overall?.pfeWinRate;
    const pfeWr = typeof wrFraction === 'number' && Number.isFinite(wrFraction)
      ? (wrFraction * 100).toFixed(1)
      : fallback.pfeWr;
    const calls = data.overall?.totalCalls ?? data.totalCalls;
    const totalSignals = typeof calls === 'number' && Number.isFinite(calls)
      ? Math.round(calls).toLocaleString('en-US')
      : fallback.totalSignals;
    return { pfeWr, totalSignals };
  } catch {
    return fallback;
  }
}

export async function sendOptinConfirmationEmail(to: string): Promise<{ id: string } | null> {
  const client = getResendClient();
  if (!client) return null;

  const stats = await fetchPerformancePublicStats();
  const subject = 'Welcome to AlgoVault product updates';

  const text = `Hi!

You've opted in to AlgoVault product updates. Roughly one email per month — new venue launches, signal-mcp features, track-record milestones.

For context: ${stats.pfeWr}% PFE win rate across ${stats.totalSignals}+ verified calls. Merkle-verified on Base L2. Don't trust — verify: https://algovault.com/verify

Free tier: 100 free calls/month. HOLDs never cost. Start in 30 seconds: https://algovault.com/signup

Reply to support@algovault.com to unsubscribe or with questions.

AlgoVault Labs
https://algovault.com
`;

  const html = renderOptinHtml({ pfeWr: stats.pfeWr, totalSignals: stats.totalSignals });

  const sent = await client.emails.send({
    from: getFromAddress(),
    to,
    replyTo: 'support@algovault.com',
    subject,
    html,
    text,
  });

  // Resend send() returns { data: { id }, error } in v6+; surface id (or null on error).
  const id = (sent as { data?: { id?: string } | null }).data?.id;
  return id ? { id } : null;
}

/**
 * REFERRAL-LIGHT-W1 (C4): referred-free confirmation — delivers the minted
 * `av_free_` key + the bonus note. Distinct from sendOptinConfirmationEmail (the
 * generic opt-in). Fail-open (null when Resend unconfigured). Bonus count interpolated.
 */
export async function sendReferredFreeKeyEmail(to: string, freeKey: string, refCode?: string | null): Promise<{ id: string } | null> {
  const client = getResendClient();
  if (!client) return null;
  const subject = 'Your AlgoVault free API key + bonus calls';
  const bonus = bonusCallsLabel();
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden">
<tr><td style="padding:24px 28px;border-bottom:1px solid #d0d7de"><div style="font-size:18px;font-weight:700">AlgoVault Labs</div><div style="font-size:12px;color:#656d76;margin-top:2px">Free tier${refCode ? ` · referred by ${refCode}` : ''}</div></td></tr>
<tr><td style="padding:28px">
  <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">Your free API key — with ${bonus} bonus calls</h1>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px">Welcome! Your AlgoVault free API key includes <strong>${bonus} bonus calls</strong> on top of the monthly free allowance.</p>
  <div style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin:0 0 20px">
    <div style="font-size:11px;color:#656d76;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Your free API key</div>
    <div style="font-family:ui-monospace,Menlo,monospace;font-size:14px;color:#0969da;word-break:break-all">${freeKey}</div>
  </div>
  <p style="font-size:13px;line-height:1.5;margin:0 0 12px">Add it as <code style="background:#f6f8fa;padding:1px 4px;border-radius:3px">Authorization: Bearer ${freeKey}</code> against <code style="background:#f6f8fa;padding:1px 4px;border-radius:3px">https://api.algovault.com/mcp</code>.</p>
  <p style="font-size:13px;line-height:1.5;margin:0 0 12px">Manage your key + see your own referral stats at <a href="${ACCOUNT_URL}" style="color:#0969da;text-decoration:none">api.algovault.com/account</a>.</p>
  <p style="font-size:13px;color:#656d76;margin:0">Questions? <a href="mailto:support@algovault.com" style="color:#0969da;text-decoration:none">support@algovault.com</a>.</p>
</td></tr>
<tr><td style="padding:18px 28px;background:#f6f8fa;border-top:1px solid #d0d7de;font-size:11px;color:#656d76">AlgoVault Labs — composable signal interpretation tools for AI agents.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Your AlgoVault free API key — with ${bonus} bonus calls

Welcome! Your AlgoVault free API key includes ${bonus} bonus calls on top of the monthly free allowance.

Your free API key:
${freeKey}

Add it as: Authorization: Bearer ${freeKey}
Against: https://api.algovault.com/mcp

Manage your key + referral stats: ${ACCOUNT_URL}
Questions? support@algovault.com

— AlgoVault Labs`;
  const sent = await client.emails.send({ from: getFromAddress(), to, replyTo: 'support@algovault.com', subject, html, text });
  const id = (sent as { data?: { id?: string } | null }).data?.id;
  return id ? { id } : null;
}

/**
 * REFERRAL-FREE-KEY-SIGNUP-W1 — transactional key email for a NON-referred free
 * registration. Framed as "your free account + referral link" — deliberately NOT
 * bonus/quota-bump framed (no +500; av_free_ is the same 100/mo keyed allowance),
 * so it reads coherently even for a welcome-paywall (at-limit) capture where the
 * primary CTA stays UPGRADE. The +500 bonus variant is sendReferredFreeKeyEmail.
 */
export async function sendFreeKeyEmail(to: string, freeKey: string, referralLink?: string | null): Promise<{ id: string } | null> {
  const client = getResendClient();
  if (!client) return null;
  const subject = 'Your AlgoVault free account + API key';
  const refBlockHtml = referralLink
    ? `<div style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin:0 0 20px">
    <div style="font-size:11px;color:#656d76;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Your referral link</div>
    <div style="font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#0969da;word-break:break-all">${referralLink}</div>
    <div style="font-size:12px;color:#656d76;margin-top:8px">Friends get ${bonusCallsLabel()} bonus calls; you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}.</div>
  </div>`
    : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden">
<tr><td style="padding:24px 28px;border-bottom:1px solid #d0d7de"><div style="font-size:18px;font-weight:700">AlgoVault Labs</div><div style="font-size:12px;color:#656d76;margin-top:2px">Free account</div></td></tr>
<tr><td style="padding:28px">
  <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">Your free AlgoVault account is ready</h1>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px">Use the API key below from any MCP client, and share your referral link. No card required — the free tier stays 100 calls/month.</p>
  <div style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin:0 0 20px">
    <div style="font-size:11px;color:#656d76;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Your free API key</div>
    <div style="font-family:ui-monospace,Menlo,monospace;font-size:14px;color:#0969da;word-break:break-all">${freeKey}</div>
  </div>
  ${refBlockHtml}
  <p style="font-size:13px;line-height:1.5;margin:0 0 12px">Add it as <code style="background:#f6f8fa;padding:1px 4px;border-radius:3px">Authorization: Bearer ${freeKey}</code> against <code style="background:#f6f8fa;padding:1px 4px;border-radius:3px">https://api.algovault.com/mcp</code>.</p>
  <p style="font-size:13px;line-height:1.5;margin:0 0 12px">Manage your key + referral stats at <a href="${ACCOUNT_URL}" style="color:#0969da;text-decoration:none">api.algovault.com/account</a>.</p>
  <p style="font-size:13px;color:#656d76;margin:0">Questions? <a href="mailto:support@algovault.com" style="color:#0969da;text-decoration:none">support@algovault.com</a>.</p>
</td></tr>
<tr><td style="padding:18px 28px;background:#f6f8fa;border-top:1px solid #d0d7de;font-size:11px;color:#656d76">AlgoVault Labs — composable signal interpretation tools for AI agents.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Your free AlgoVault account is ready

Use the API key below from any MCP client, and share your referral link. No card required — the free tier stays 100 calls/month.

Your free API key:
${freeKey}
${referralLink ? `\nYour referral link:\n${referralLink}\nFriends get ${bonusCallsLabel()} bonus calls; you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}.\n` : ''}
Add it as: Authorization: Bearer ${freeKey}
Against: https://api.algovault.com/mcp

Manage your key + referral stats: ${ACCOUNT_URL}
Questions? support@algovault.com

— AlgoVault Labs`;
  const sent = await client.emails.send({ from: getFromAddress(), to, replyTo: 'support@algovault.com', subject, html, text });
  const id = (sent as { data?: { id?: string } | null }).data?.id;
  return id ? { id } : null;
}

// REFERRAL-PAYOUT-OPS-W1 / C2 — transactional "you've been paid" email, sent on each
// confirmed USDC-on-Base payout. amountUsdE2 = integer cents; txRef = the on-chain tx
// hash (links to Basescan) or a manual ref. Mirrors the free-key email's table layout.
export async function sendPayoutPaidEmail(to: string, amountUsdE2: number, txRef: string): Promise<{ id: string } | null> {
  const client = getResendClient();
  if (!client) return null;
  const amount = formatUsdE2(amountUsdE2);
  const subject = `Your AlgoVault referral payout — ${amount} USDC`;
  const isTxHash = /^0x[0-9a-fA-F]{64}$/.test(txRef);
  const basescan = isTxHash ? `https://basescan.org/tx/${txRef}` : null;
  const txHtml = basescan
    ? `<a href="${basescan}" style="color:#0969da;text-decoration:none;font-family:ui-monospace,Menlo,monospace;word-break:break-all">${txRef}</a> <span style="color:#656d76">(view on Basescan)</span>`
    : `<span style="font-family:ui-monospace,Menlo,monospace;word-break:break-all">${txRef}</span>`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden">
<tr><td style="padding:24px 28px;border-bottom:1px solid #d0d7de"><div style="font-size:18px;font-weight:700">AlgoVault Labs</div><div style="font-size:12px;color:#656d76;margin-top:2px">Referral payout</div></td></tr>
<tr><td style="padding:28px">
  <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">You've been paid ${amount} 🎉</h1>
  <p style="font-size:14px;line-height:1.5;margin:0 0 20px">We've sent your referral commission in <strong>USDC on Base</strong> to the payout address on your account.</p>
  <div style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin:0 0 20px">
    <div style="font-size:11px;color:#656d76;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Amount</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:12px">${amount} USDC</div>
    <div style="font-size:11px;color:#656d76;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Transaction</div>
    <div style="font-size:13px">${txHtml}</div>
  </div>
  <p style="font-size:13px;line-height:1.5;margin:0 0 12px">See your full referral history at <a href="${ACCOUNT_URL}" style="color:#0969da;text-decoration:none">api.algovault.com/account</a>.</p>
  <p style="font-size:13px;color:#656d76;margin:0">Questions? <a href="mailto:support@algovault.com" style="color:#0969da;text-decoration:none">support@algovault.com</a>.</p>
</td></tr>
<tr><td style="padding:18px 28px;background:#f6f8fa;border-top:1px solid #d0d7de;font-size:11px;color:#656d76">AlgoVault Labs — composable signal interpretation tools for AI agents.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `You've been paid ${amount}

We've sent your referral commission in USDC on Base to the payout address on your account.

Amount: ${amount} USDC
Transaction: ${txRef}${basescan ? `\nView on Basescan: ${basescan}` : ''}

See your full referral history: ${ACCOUNT_URL}
Questions? support@algovault.com

— AlgoVault Labs`;
  const sent = await client.emails.send({ from: getFromAddress(), to, replyTo: 'support@algovault.com', subject, html, text });
  const id = (sent as { data?: { id?: string } | null }).data?.id;
  return id ? { id } : null;
}

function renderOptinHtml({ pfeWr, totalSignals }: { pfeWr: string; totalSignals: string }): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Welcome to AlgoVault product updates</title></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #d0d7de">
        <div style="font-size:18px;font-weight:700;color:#1f2328">AlgoVault Labs</div>
        <div style="font-size:12px;color:#656d76;margin-top:2px">Product updates</div>
      </td></tr>
      <tr><td style="padding:28px">
        <h1 style="font-size:22px;font-weight:700;margin:0 0 12px;color:#1f2328">Welcome aboard.</h1>
        <p style="font-size:14px;line-height:1.5;color:#1f2328;margin:0 0 16px">You've opted in to AlgoVault product updates. Roughly one email per month — new venue launches, signal-mcp features, track-record milestones.</p>
        <p style="font-size:14px;line-height:1.5;color:#1f2328;margin:0 0 16px">For context: <strong>${pfeWr}% PFE win rate</strong> across <strong>${totalSignals}+ verified calls</strong>. Merkle-verified on Base L2. Don't trust &mdash; <a href="https://algovault.com/verify" style="color:#0969da;text-decoration:none">verify</a>.</p>
        <p style="font-size:14px;line-height:1.5;color:#1f2328;margin:0 0 16px">Free tier: 100 free calls/month. HOLDs never cost. <a href="https://algovault.com/signup" style="color:#0969da;text-decoration:none">Start in 30 seconds</a>.</p>
        <p style="font-size:13px;line-height:1.5;color:#656d76;margin:24px 0 0">Reply to <a href="mailto:support@algovault.com" style="color:#0969da;text-decoration:none">support@algovault.com</a> to unsubscribe or with questions.</p>
      </td></tr>
      <tr><td style="padding:18px 28px;background:#f6f8fa;border-top:1px solid #d0d7de;font-size:11px;color:#656d76">
        AlgoVault Labs &mdash; composable signal interpretation tools for AI agents.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

interface RenderArgs {
  heading: string;
  intro: string;
  apiKey: string;
  tier: string;
  /** REFERRAL-LIGHT-W1 (C4): optional referral block (welcome email only). */
  referral?: { code: string; link: string; termsUrl: string };
}

function renderEmailHtml({ heading, intro, apiKey, tier, referral }: RenderArgs): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d0d7de;border-radius:12px;overflow:hidden">
      <tr><td style="padding:24px 28px;border-bottom:1px solid #d0d7de">
        <div style="font-size:18px;font-weight:700;color:#1f2328">AlgoVault Labs</div>
        <div style="font-size:12px;color:#656d76;margin-top:2px">${tier} plan</div>
      </td></tr>
      <tr><td style="padding:28px">
        <h1 style="font-size:22px;font-weight:700;margin:0 0 12px;color:#1f2328">${heading}</h1>
        <p style="font-size:14px;line-height:1.5;color:#1f2328;margin:0 0 20px">${intro}</p>
        <div style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin:0 0 24px">
          <div style="font-size:11px;color:#656d76;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Your API Key</div>
          <div style="font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;font-size:14px;color:#0969da;word-break:break-all">${apiKey}</div>
        </div>
        ${referral ? `<div style="background:#eafaf0;border:1px solid #2da44e;border-radius:8px;padding:16px;margin:0 0 24px">
          <div style="font-size:14px;font-weight:700;color:#1a7f37;margin:0 0 6px">Refer, earn ${commissionPct()}.</div>
          <p style="font-size:13px;line-height:1.5;color:#1f2328;margin:0 0 8px">Share your link — friends get ${bonusCallsLabel()} bonus calls, you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}.</p>
          <div style="font-size:12px;color:#656d76">Your code: <strong style="font-family:ui-monospace,Menlo,monospace">${referral.code}</strong></div>
          <a href="${referral.link}" style="color:#0969da;text-decoration:none;font-size:13px;word-break:break-all">${referral.link}</a>
          <div style="font-size:11px;color:#656d76;margin-top:8px">Terms: <a href="${referral.termsUrl}" style="color:#0969da;text-decoration:none">${referral.termsUrl}</a></div>
        </div>` : ''}
        <h2 style="font-size:14px;font-weight:600;margin:0 0 8px;color:#1f2328;text-transform:uppercase;letter-spacing:0.5px">Use it in Claude Desktop, Cursor, or Claude Code</h2>
        <p style="font-size:13px;line-height:1.5;color:#1f2328;margin:0 0 8px">Add this to your MCP-client config (e.g. <code style="background:#f6f8fa;padding:1px 4px;border-radius:3px;font-size:12px">claude_desktop_config.json</code>):</p>
        <pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:14px;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;font-size:12px;color:#1f2328;overflow-x:auto;margin:0 0 12px">{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp",
      "headers": { "Authorization": "Bearer ${apiKey}", "X-AlgoVault-Track-Token": "chan-email" }
    }
  }
}</pre>
        <p style="font-size:13px;line-height:1.5;color:#1f2328;margin:0 0 12px">Then ask Claude: <em>"Get me a trade call for SOL on the 5-minute timeframe."</em></p>
        <p style="font-size:13px;line-height:1.5;color:#1f2328;margin:0 0 12px">Want to test with raw HTTP/curl instead? See the <a href="https://algovault.com/docs.html#testing-with-curl" style="color:#0969da;text-decoration:none">3-step handshake guide</a> in our docs.</p>
        <p style="font-size:13px;line-height:1.5;color:#1f2328;margin:0 0 12px">Need to find your key later, switch plans, update your card, or cancel? Visit <a href="https://api.algovault.com/account" style="color:#0969da;text-decoration:none">api.algovault.com/account</a>.</p>
        <p style="font-size:13px;line-height:1.5;color:#656d76;margin:0">Questions? Reply to this email or write to <a href="mailto:support@algovault.com" style="color:#0969da;text-decoration:none">support@algovault.com</a>.</p>
      </td></tr>
      <tr><td style="padding:18px 28px;background:#f6f8fa;border-top:1px solid #d0d7de;font-size:11px;color:#656d76">
        AlgoVault Labs — composable signal interpretation tools for AI agents.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function renderEmailText({ heading, intro, apiKey, tier, referral }: RenderArgs): string {
  return `${heading}
${'='.repeat(heading.length)}

${intro}

Plan: ${tier}

Your API Key:
${apiKey}

${referral ? `Refer, earn ${commissionPct()}. Share your link — friends get ${bonusCallsLabel()} bonus calls, you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}.
Your code: ${referral.code}
${referral.link}
Terms: ${referral.termsUrl}

` : ''}Use it in Claude Desktop, Cursor, or Claude Code by adding this to your MCP-client config (e.g. claude_desktop_config.json):

{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp",
      "headers": { "Authorization": "Bearer ${apiKey}", "X-AlgoVault-Track-Token": "chan-email" }
    }
  }
}

Then ask Claude: "Get me a trade call for SOL on the 5-minute timeframe."

Want to test with raw HTTP/curl? See the 3-step handshake guide:
https://algovault.com/docs.html#testing-with-curl

Need to find your key later, switch plans, update your card, or cancel?
Visit https://api.algovault.com/account

Questions? Reply to this email or write to support@algovault.com

— AlgoVault Labs
`;
}
