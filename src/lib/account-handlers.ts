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
 */
import type { Request, Response } from 'express';
import { getCustomerByApiKey, getCustomerByEmail, createBillingPortalSession } from './stripe.js';
import { sendKeyRecoveryEmail } from './email.js';

const ACCOUNT_PAGE_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; }
  .container { max-width: 560px; width: 100%; }
  h1 { font-size: 28px; margin-bottom: 8px; text-align: center; }
  .subtitle { color: #8b949e; margin-bottom: 32px; font-size: 14px; text-align: center; }
  .tabs { display: flex; gap: 4px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 4px; margin-bottom: 20px; }
  .tab { flex: 1; background: transparent; color: #8b949e; border: none; padding: 10px 16px; border-radius: 7px; cursor: pointer; font-size: 14px; font-weight: 600; transition: background 0.15s, color 0.15s; }
  .tab.active { background: #21262d; color: #e1e4e8; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; }
  .panel.hidden { display: none; }
  .panel label { display: block; color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .panel input { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; color: #e1e4e8; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-bottom: 16px; }
  .panel input:focus { outline: none; border-color: #58a6ff; }
  .panel button { width: 100%; background: #238636; color: #fff; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; transition: background 0.15s; }
  .panel button:hover { background: #2ea043; }
  .panel .hint { color: #8b949e; font-size: 12px; margin-bottom: 16px; line-height: 1.5; }
  .footer { text-align: center; margin-top: 24px; color: #8b949e; font-size: 12px; }
  .footer a { color: #58a6ff; text-decoration: none; }
`;

export function getAccountPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlgoVault — Account</title>
<!-- BEGIN: AlgoVault canonical design loader (DESIGN-W2 / D2-C, cross-origin) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://algovault.com/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
<style>${ACCOUNT_PAGE_STYLES}</style>
</head>
<body>
<div class="container">
  <h1>Manage your AlgoVault account</h1>
  <div class="subtitle">Cancel, switch plans, update card, or recover a lost API key.</div>
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
  <div class="footer">Need help? <a href="mailto:support@algovault.com">support@algovault.com</a></div>
</div>
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
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlgoVault — Account error</title>
<style>${ACCOUNT_PAGE_STYLES}
  .error { background: #161b22; border: 1px solid #f85149; border-radius: 12px; padding: 24px; }
  .error h2 { color: #f85149; font-size: 18px; margin-bottom: 12px; }
  .error p { color: #c9d1d9; font-size: 14px; line-height: 1.5; }
</style>
</head>
<body>
<div class="container">
  <h1>Couldn't complete your request</h1>
  <div class="error">
    <h2>Error</h2>
    <p>${safe}</p>
  </div>
  <div class="footer"><a href="/account">&larr; Back to /account</a> · <a href="mailto:support@algovault.com">support@algovault.com</a></div>
</div>
</body>
</html>`;
}

export function getAccountRecoverySuccessHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlgoVault — Recovery email sent</title>
<style>${ACCOUNT_PAGE_STYLES}
  .success { background: #161b22; border: 1px solid #3fb950; border-radius: 12px; padding: 24px; }
  .success h2 { color: #3fb950; font-size: 18px; margin-bottom: 12px; }
  .success p { color: #c9d1d9; font-size: 14px; line-height: 1.5; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="container">
  <h1>Check your inbox</h1>
  <div class="success">
    <h2>Recovery email sent</h2>
    <p>If an active subscription exists for that email, we've sent the API key. Check spam if it doesn't arrive in 2 minutes (sender: <code>noreply@algovault.com</code>).</p>
    <p>For privacy, we return the same response whether or not the email is on file.</p>
  </div>
  <div class="footer"><a href="/account">&larr; Back to /account</a> · <a href="mailto:support@algovault.com">support@algovault.com</a></div>
</div>
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
