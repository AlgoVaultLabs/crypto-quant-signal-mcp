/**
 * /account self-service portal — route handlers + page renderers.
 *
 * Wired in src/index.ts as:
 *   app.get('/account', accountPageHandler);
 *   app.post('/account/portal', express.urlencoded(...), accountPortalHandler);
 *   app.post('/account/recover-key', recoverKeyLimiter, express.urlencoded(...), accountRecoverKeyHandler);
 *
 * Handlers are pure (req, res) => Promise<void> functions with no closure state,
 * so they're directly unit-testable with mock req/res objects.
 *
 * DESIGN-W10 / C2 (2026-05-11): canonical Landing chrome injected — Tailwind CDN +
 * canonical Nav (8-item with Account active-link) + artboard scaffolding (3 bg
 * layers) + VEyebrow placeholder-cap + canonical H1 + tier-stat-card VCard wrap
 * around existing tabs+forms + canonical Footer. Q-W10-10: body-flex-centering
 * REPLACED with var(--bg) + canonical artboard layout (matches /verify +
 * /track-record architecture). Stripe portal POST + key recovery POST + tab-
 * switch JS PRESERVED byte-identical inside new chrome wrappers. Error + success
 * sister pages get same chrome treatment for consistent UX.
 */
import type { Request, Response } from 'express';
import { getCustomerByApiKey, getCustomerByEmail, createBillingPortalSession } from './stripe.js';
import { sendKeyRecoveryEmail } from './email.js';

// DESIGN-W10 / C2 / Q-W10-10: REPLACED body-flex-centering with var(--bg) layout.
// Existing .tabs/.tab/.panel/.subtitle/.footer/.error/.success class blocks PRESERVED
// (used inside the canonical tier-stat-card VCard wrapper).
const ACCOUNT_PAGE_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); background: var(--bg); color: var(--fg); margin: 0; padding: 0; }
  .subtitle { color: var(--fg-3); margin-bottom: 32px; font-size: 14px; }
  .tabs { display: flex; gap: 4px; background: oklch(0.16 0.012 265); border: 1px solid var(--line); border-radius: 10px; padding: 4px; margin-bottom: 20px; }
  .tab { flex: 1; background: transparent; color: var(--fg-3); border: none; padding: 10px 16px; border-radius: 7px; cursor: pointer; font-size: 14px; font-weight: 600; transition: background 0.15s, color 0.15s; }
  .tab.active { background: oklch(0.22 0.014 265); color: var(--fg); }
  .panel { padding: 0; }
  .panel.hidden { display: none; }
  .panel label { display: block; color: var(--fg-3); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .panel input { width: 100%; background: oklch(0.13 0.012 265); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; color: var(--fg); font-size: 14px; font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); margin-bottom: 16px; }
  .panel input:focus { outline: none; border-color: var(--mint); }
  .panel button { width: 100%; background: var(--mint); color: oklch(0.13 0.012 265); border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; transition: filter 0.15s; }
  .panel button:hover { filter: brightness(1.1); }
  .panel .hint { color: var(--fg-3); font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
  .help-line { text-align: center; margin-top: 24px; color: var(--fg-3); font-size: 12px; }
  .help-line a { color: var(--mint); text-decoration: none; }
  .error-box { background: oklch(0.16 0.012 265); border: 1px solid oklch(0.55 0.18 25); border-radius: 12px; padding: 24px; }
  .error-box h2 { color: oklch(0.7 0.18 25); font-size: 18px; margin-bottom: 12px; }
  .error-box p { color: var(--fg-2); font-size: 14px; line-height: 1.5; }
  .success-box { background: oklch(0.16 0.012 265); border: 1px solid var(--mint); border-radius: 12px; padding: 24px; }
  .success-box h2 { color: var(--mint); font-size: 18px; margin-bottom: 12px; }
  .success-box p { color: var(--fg-2); font-size: 14px; line-height: 1.5; margin-bottom: 8px; }
`;

// DESIGN-W10 / C2 / Q-W10-8: Tailwind CDN + Tailwind config — mirror render-integrations.mjs:113-145 VERBATIM
// per architect note. Required because canonical Nav uses Tailwind utility classes
// (hidden sm:flex, text-gray-400, hover:text-white, text-mint-400, bg-mint-500/15, etc.).
const ACCOUNT_HEAD_CHROME = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/logo.png">
<!-- BEGIN: AlgoVault canonical design loader (DESIGN-W2 / D2-C, cross-origin) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://algovault.com/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
<!-- DESIGN-W10 / C2 / Q-W10-8: Tailwind CDN for canonical Nav utility classes -->
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        navy: { 900: '#060a14', 800: '#0a0e1a', 700: '#0f1526', 600: '#161d30' },
        mint: { 50: 'oklch(0.97 0.03 165)', 100: 'oklch(0.94 0.06 165)', 200: 'oklch(0.91 0.09 165)', 300: 'oklch(0.89 0.13 165)', 400: 'oklch(0.86 0.16 165)', 500: 'oklch(0.78 0.18 165)', 600: 'oklch(0.66 0.18 165)', 700: 'oklch(0.54 0.16 165)', 800: 'oklch(0.42 0.12 165)', 900: 'oklch(0.32 0.08 165)' },
        steel: { 400: '#8b9bb5', 500: '#7b8ca0', 600: '#5e6d82' }
      }
    }
  }
}
</script>
<style>${ACCOUNT_PAGE_STYLES}</style>`;

// DESIGN-W10 / C2 / Q-W10-1 + Q-W10-2: canonical Nav VERBATIM from live algovault.com
// (lines 178-201 per audits/DESIGN-W10-canonical-chrome-extract.md §1) with Account
// link Q-W10-2 active-link substitution: hover:text-white transition → text-mint-400 font-medium.
const ACCOUNT_NAV_HTML = `<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">
  <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
    <a href="https://algovault.com/" class="flex items-center gap-2.5" aria-label="AlgoVault home">
      <img src="/logo.png" alt="AlgoVault Logo" class="w-7 h-7 rounded-md">
      <span class="text-white font-semibold text-sm">AlgoVault Labs</span>
    </a>
    <div class="hidden sm:flex items-center gap-6 text-sm text-gray-400">
      <a href="/track-record" class="hover:text-white transition">Track Record</a>
      <a href="/#pricing" class="hover:text-white transition">Pricing</a>
      <a href="/integrations" class="hover:text-white transition">Integrations</a>
      <a href="/skills" class="hover:text-white transition">Skills</a>
      <a href="/docs.html" class="hover:text-white transition">Docs</a>
      <a href="/verify" class="hover:text-white transition">Verify</a>
      <a href="https://api.algovault.com/account" class="text-mint-400 font-medium">Account</a>
      <a href="https://api.algovault.com/signup" class="px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition">Signup</a>
    </div>
  </div>
</nav>`;

// DESIGN-W10 / C2: canonical Footer VERBATIM (desktop variant, /tmp/live-landing.html line 493).
const ACCOUNT_FOOTER_HTML = `<footer style="padding:44px 80px 56px;border-top:1px solid var(--line);background:oklch(0.13 0.012 265);display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:24px;font-size:13px;color:var(--fg-3)">
  <div style="display:flex;align-items:center;gap:10px">
    <img src="/logo.png" alt="AlgoVault" style="width:22px;height:22px;border-radius:6px;object-fit:contain;flex-shrink:0">
    <span style="color:var(--fg-2)">Built by AlgoVault Labs</span>
  </div>
  <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap">
    <a href="https://github.com/AlgoVaultLabs" target="_blank" rel="noopener" style="color:var(--fg-3);text-decoration:none">GitHub</a>
    <a href="https://x.com/AlgoVaultLabs" target="_blank" rel="noopener" style="color:var(--fg-3);text-decoration:none">X / Twitter</a>
    <a href="/signup" style="color:var(--fg-3);text-decoration:none">Signup</a>
    <a href="/privacy" style="color:var(--fg-3);text-decoration:none">Privacy</a>
  </div>
</footer>`;

// DESIGN-W10 / C2: canonical artboard scaffolding wrapper.
// Foreground content goes inside `<div style="position:relative;z-index:1">` so it
// stacks above the 3 absolute-positioned bg-* layers per chrome contract §3.
function accountArtboardOpen(): string {
  return `<main class="lp-account-desktop">
  <div class="artboard" style="padding:100px 24px 64px;max-width:720px;margin:0 auto;width:100%">
    <div class="bg-grid"></div>
    <div class="bg-radial-accent"></div>
    <div class="bg-noise"></div>
    <div style="position:relative;z-index:1">`;
}
function accountArtboardClose(): string {
  return `    </div>
  </div>
</main>`;
}

// DESIGN-W10 / C2 / Q-W10-3: canonical H1 with mint-accent on the Account word.
// Pattern matches verify/track-record H1 conventions (font-display, 42px, font-weight 500).
function accountH1(prefix: string, accent: string): string {
  return `<h1 style="font-family:var(--font-display, 'Inter Tight', sans-serif);font-size:42px;line-height:1.1;letter-spacing:-0.025em;font-weight:500;margin:0 0 14px;color:var(--fg)">${prefix} <span style="color: var(--accent, var(--mint))">${accent}</span></h1>`;
}

export function getAccountPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${ACCOUNT_HEAD_CHROME}
<title>AlgoVault — Account</title>
</head>
<body>
${ACCOUNT_NAV_HTML}
${accountArtboardOpen()}
      <div class="placeholder-cap" style="margin-bottom:14px">· account</div>
      ${accountH1('Your', 'Account')}
      <div class="subtitle">Cancel, switch plans, update card, or recover a lost API key.</div>
      <div class="tier-stat-card" style="padding:24px;gap:0">
        <div class="tabs" role="tablist">
          <button class="tab active" id="tab-key" type="button" onclick="switchTab('key')">I have my API key</button>
          <button class="tab" id="tab-email" type="button" onclick="switchTab('email')">Recover lost key</button>
        </div>
        <form class="panel" id="panel-key" action="/account/portal" method="post">
          <div class="hint">Paste your API key to open the Stripe Billing Portal — cancel, change plan, or update payment method.</div>
          <label for="api_key">API Key</label>
          <input type="password" id="api_key" name="api_key" placeholder="av_live_..." autocomplete="off" required>
          <button type="submit">Open Billing Portal &rarr;</button>
        </form>
        <form class="panel hidden" id="panel-email" action="/account/recover-key" method="post">
          <div class="hint">Enter your billing email and we'll send your active API key to that address. (No enumeration leak — same response whether or not the email is on file.)</div>
          <label for="email">Billing email</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" required>
          <button type="submit">Email me my key</button>
        </form>
        <div class="help-line">Need help? <a href="mailto:support@algovault.com">support@algovault.com</a></div>
      </div>
${accountArtboardClose()}
${ACCOUNT_FOOTER_HTML}
<script>
function switchTab(which){
  document.getElementById('tab-key').classList.toggle('active', which==='key');
  document.getElementById('tab-email').classList.toggle('active', which==='email');
  document.getElementById('panel-key').classList.toggle('hidden', which!=='key');
  document.getElementById('panel-email').classList.toggle('hidden', which!=='email');
}
</script>
</body>
</html>`;
}

export function getAccountErrorPageHtml(message: string): string {
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
  return `<!DOCTYPE html>
<html lang="en">
<head>
${ACCOUNT_HEAD_CHROME}
<title>AlgoVault — Account error</title>
</head>
<body>
${ACCOUNT_NAV_HTML}
${accountArtboardOpen()}
      <div class="placeholder-cap" style="margin-bottom:14px">· account error</div>
      ${accountH1("Couldn't complete your", 'request')}
      <div class="tier-stat-card" style="padding:24px;gap:0">
        <div class="error-box">
          <h2>Error</h2>
          <p>${safe}</p>
        </div>
        <div class="help-line"><a href="/account">&larr; Back to /account</a> · <a href="mailto:support@algovault.com">support@algovault.com</a></div>
      </div>
${accountArtboardClose()}
${ACCOUNT_FOOTER_HTML}
</body>
</html>`;
}

export function getAccountRecoverySuccessHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${ACCOUNT_HEAD_CHROME}
<title>AlgoVault — Recovery email sent</title>
</head>
<body>
${ACCOUNT_NAV_HTML}
${accountArtboardOpen()}
      <div class="placeholder-cap" style="margin-bottom:14px">· recovery email sent</div>
      ${accountH1('Check your', 'inbox')}
      <div class="tier-stat-card" style="padding:24px;gap:0">
        <div class="success-box">
          <h2>Recovery email sent</h2>
          <p>If an active subscription exists for that email, we've sent the API key. Check spam if it doesn't arrive in 2 minutes (sender: <code>noreply@algovault.com</code>).</p>
          <p>For privacy, we return the same response whether or not the email is on file.</p>
        </div>
        <div class="help-line"><a href="/account">&larr; Back to /account</a> · <a href="mailto:support@algovault.com">support@algovault.com</a></div>
      </div>
${accountArtboardClose()}
${ACCOUNT_FOOTER_HTML}
</body>
</html>`;
}

export function accountPageHandler(_req: Request, res: Response): void {
  res.send(getAccountPageHtml());
}

export async function accountPortalHandler(req: Request, res: Response): Promise<void> {
  const apiKey = (typeof req.body?.api_key === 'string' ? req.body.api_key : '').trim();
  if (!apiKey) {
    res.status(400).send(getAccountErrorPageHtml('Please paste your API key.'));
    return;
  }
  try {
    const customer = await getCustomerByApiKey(apiKey);
    if (!customer) {
      res.status(401).send(getAccountErrorPageHtml('Invalid API key. Try again or use the email recovery option.'));
      return;
    }
    const portalUrl = await createBillingPortalSession({
      customerId: customer.customerId,
      returnUrl: `${req.protocol}://${req.get('host')}/account`,
    });
    if (!portalUrl) {
      res.status(503).send(getAccountErrorPageHtml('Billing portal is temporarily unavailable. Please try again in a few minutes or contact support@algovault.com.'));
      return;
    }
    res.redirect(303, portalUrl);
  } catch (err) {
    console.error('/account/portal error:', err instanceof Error ? err.message : err);
    res.status(500).send(getAccountErrorPageHtml('Something went wrong. Please contact support@algovault.com.'));
  }
}

export async function accountRecoverKeyHandler(req: Request, res: Response): Promise<void> {
  const email = (typeof req.body?.email === 'string' ? req.body.email : '').trim().toLowerCase();
  if (email) {
    // Fire-and-forget: don't block the response on the lookup+send.
    // Companion success-path log per CLAUDE.md so silent-success vs silent-catch are distinguishable.
    void (async () => {
      try {
        const match = await getCustomerByEmail(email);
        const masked = email.replace(/(.).*@/, '$1***@');
        if (!match) {
          console.log(`/account/recover-key: no active subscriber for ${masked}`);
          return;
        }
        await sendKeyRecoveryEmail({ to: email, apiKey: match.apiKey, tier: match.tier });
        console.log(`/account/recover-key: recovery email sent to ${masked}`);
      } catch (err) {
        console.error('/account/recover-key send failed:', err instanceof Error ? err.message : err);
      }
    })();
  }
  // Always render the same success page (no enumeration leak).
  res.send(getAccountRecoverySuccessHtml());
}
