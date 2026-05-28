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

const FROM_DEFAULT = 'noreply@algovault.com';

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
  const html = renderEmailHtml({
    heading: `Welcome to AlgoVault ${tierTitle}`,
    intro: `Your subscription is active. Below is your API key — save it somewhere safe.`,
    apiKey,
    tier: tierTitle,
  });
  const text = renderEmailText({
    heading: `Welcome to AlgoVault ${tierTitle}`,
    intro: `Your subscription is active. Below is your API key — save it somewhere safe.`,
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
    const data = (await res.json()) as { pfeWinRate?: number; totalCalls?: number };
    const pfeWr = typeof data.pfeWinRate === 'number'
      ? data.pfeWinRate.toFixed(1)
      : fallback.pfeWr;
    const totalSignals = typeof data.totalCalls === 'number'
      ? data.totalCalls.toLocaleString('en-US')
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
}

function renderEmailHtml({ heading, intro, apiKey, tier }: RenderArgs): string {
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
        <h2 style="font-size:14px;font-weight:600;margin:0 0 8px;color:#1f2328;text-transform:uppercase;letter-spacing:0.5px">Use it in Claude Desktop, Cursor, or Claude Code</h2>
        <p style="font-size:13px;line-height:1.5;color:#1f2328;margin:0 0 8px">Add this to your MCP-client config (e.g. <code style="background:#f6f8fa;padding:1px 4px;border-radius:3px;font-size:12px">claude_desktop_config.json</code>):</p>
        <pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:14px;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;font-size:12px;color:#1f2328;overflow-x:auto;margin:0 0 12px">{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp",
      "headers": { "Authorization": "Bearer ${apiKey}" }
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

function renderEmailText({ heading, intro, apiKey, tier }: RenderArgs): string {
  return `${heading}
${'='.repeat(heading.length)}

${intro}

Plan: ${tier}

Your API Key:
${apiKey}

Use it in Claude Desktop, Cursor, or Claude Code by adding this to your MCP-client config (e.g. claude_desktop_config.json):

{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp",
      "headers": { "Authorization": "Bearer ${apiKey}" }
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
