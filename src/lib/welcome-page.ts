/**
 * /welcome page HTML renderer.
 *
 * Extracted from src/index.ts to be testable in isolation (importing
 * src/index.ts triggers `app.listen(port, ...)` which collides with the
 * production server when tests run against the same workspace).
 *
 * BOT-W2 / D1-C: includes the post-checkout deep-link button to
 * @algovaultofficialbot. Sends `/start auth_<api_key>` to the bot;
 * bot validates via the internal-bypass-gated /api/bot/validate-key endpoint.
 */

/**
 * Sanitize a UTM-ish param to safe URL-injection-free chars. Anything outside
 * [a-zA-Z0-9_:.-] is dropped; result is also length-capped. Empty when input
 * is null/undefined/empty.
 */
function sanitizeUtm(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9_:.\-]/g, '').slice(0, 64);
}

export interface WelcomePageOptions {
  utmSource?: string | null;
  utmCampaign?: string | null;
}

export function getWelcomePageHtml(
  apiKey: string | null,
  tier: string | null,
  email: string | null,
  opts: WelcomePageOptions = {},
): string {
  const utmSource = sanitizeUtm(opts.utmSource);
  const utmCampaign = sanitizeUtm(opts.utmCampaign);

  // ACTIVATION-PAYWALL-W1: organic-visit paywall CTA. When the visitor lands
  // on /welcome WITHOUT a session_id (no apiKey, no tier, no email — i.e.
  // NOT redirected back from Stripe Checkout), render an upgrade CTA above
  // the (empty) API-key area. The CTA preserves any incoming UTM tags so
  // post-Stripe-checkout attribution flows through.
  const isOrganicVisit = !apiKey && !tier && !email;
  const utmQuery = utmSource || utmCampaign
    ? `&${utmSource ? `utm_source=${encodeURIComponent(utmSource)}` : ''}${utmSource && utmCampaign ? '&' : ''}${utmCampaign ? `utm_campaign=${encodeURIComponent(utmCampaign)}` : ''}`
    : '';

  // POWER-USER-OUTREACH-W1-V2 (2026-05-28): paywall CTA adds an optional
  // email-capture form ABOVE the Stripe upgrade button. Free-tier visitors
  // who aren't ready to pay can opt in to ~1/mo product updates. Form POSTs
  // to /api/signup-email via fetch(); success swaps to ✓ message; failure
  // surfaces an inline error.
  const paywallCta = isOrganicVisit
    ? `<div class="paywall-cta">
         <div class="paywall-headline">Free-tier MCP access — 100 calls per month</div>
         <p class="paywall-body">Upgrade to Starter for 3,000 calls per month, full asset coverage, and unlimited Telegram bot alerts.</p>
         <div id="signup-email-block">
           <form id="signup-email-form" class="signup-email-form" novalidate>
             <label for="signup-email-input" class="signup-email-label">Get a free account — your API key + referral link, no card.</label>
             <div class="signup-email-row">
               <input type="email" id="signup-email-input" name="email" placeholder="you@example.com" autocomplete="email" required>
               <button type="submit" class="signup-email-btn">Get my free key</button>
             </div>
             <label class="signup-email-consent">
               <input type="checkbox" id="signup-email-consent" name="optin_consent">
               <span>Also email me product updates (~1/month, optional).</span>
             </label>
             <div id="signup-email-error" class="signup-email-error" aria-live="polite"></div>
           </form>
         </div>
         <a class="paywall-btn" href="/signup?plan=starter&utm_source=welcome_page${utmSource ? `_${utmSource}` : ''}${utmQuery}">Upgrade to Starter — $9.99/mo</a>
         <p class="paywall-fineprint">Or stay on the free tier — your API key is auto-provisioned on every <code>/signup</code> click. <a href="/signup?plan=pro${utmQuery}">Need higher volume? See Pro / Enterprise →</a></p>
       </div>`
    : '';

  const keyDisplay = apiKey
    ? `<div class="key-box"><div class="label">Your API Key</div><code id="api-key">${apiKey}</code><button onclick="navigator.clipboard.writeText(document.getElementById('api-key').textContent);this.textContent='Copied!'">Copy</button></div>`
    : isOrganicVisit
      ? ''
      : `<div class="pending"><p>Your API key is being provisioned. This usually takes a few seconds.</p><p>Refresh this page in a moment, or check your email at <strong>${email || 'your registered address'}</strong>.</p></div>`;

  // BOT-W2 / D1-C: post-checkout deep-link to @algovaultofficialbot.
  // The api_key is encoded defensively even though current av_live_* keys are
  // URL-safe — future key shape changes mustn't silently break the link.
  const tgConnect = apiKey
    ? `<div class="tg-connect"><div class="label">Connect to Telegram bot</div>` +
      `<p>Get regime alerts + trade calls pushed to your Telegram, with your paid quota honored automatically.</p>` +
      `<a href="https://t.me/algovaultofficialbot?start=auth_${encodeURIComponent(apiKey)}" ` +
      `target="_blank" rel="noopener" class="tg-btn">📱 Connect @algovaultofficialbot</a></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to AlgoVault ${tier ? `(${tier})` : ''}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; }
  .container { max-width: 560px; width: 100%; text-align: center; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: #8b949e; margin-bottom: 32px; font-size: 14px; }
  .key-box { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: left; }
  .key-box .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .key-box code { display: block; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 12px 16px; font-size: 16px; color: #3fb950; word-break: break-all; margin-bottom: 12px; }
  .key-box button { background: #238636; color: #fff; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .key-box button:hover { background: #2ea043; }
  .pending { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; margin: 24px 0; color: #d29922; }
  .tg-connect { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: left; }
  .tg-connect .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .tg-connect p { color: #c9d1d9; font-size: 13px; margin-bottom: 12px; }
  .tg-connect .tg-btn { display: inline-block; background: #229ed9; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 500; }
  .tg-connect .tg-btn:hover { background: #1c8ec0; }
  .usage { margin-top: 24px; text-align: left; }
  .usage h2 { font-size: 16px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .usage pre { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; font-size: 13px; overflow-x: auto; color: #c9d1d9; }
  .paywall-cta { background: #161b22; border: 1px solid #3fb950; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: left; }
  .paywall-headline { color: #3fb950; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; margin-bottom: 12px; }
  .paywall-body { color: #c9d1d9; font-size: 14px; line-height: 1.5; margin-bottom: 16px; }
  .paywall-btn { display: inline-block; background: #238636; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-size: 15px; font-weight: 600; margin-bottom: 12px; }
  .paywall-btn:hover { background: #2ea043; }
  .paywall-fineprint { color: #8b949e; font-size: 12px; margin-top: 12px; }
  .paywall-fineprint a { color: #58a6ff; text-decoration: none; }
  /* POWER-USER-OUTREACH-W1-V2 signup-email form */
  .signup-email-form { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 14px 16px; margin: 0 0 16px; }
  .signup-email-label { display: block; color: #8b949e; font-size: 12px; margin-bottom: 8px; }
  .signup-email-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .signup-email-row input[type="email"] { flex: 1; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 8px 12px; font-size: 14px; }
  .signup-email-row input[type="email"]:focus { outline: none; border-color: #3fb950; }
  .signup-email-btn { background: #1f6feb; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .signup-email-btn:hover { background: #388bfd; }
  .signup-email-btn:disabled { background: #21262d; color: #6e7681; cursor: not-allowed; }
  .signup-email-consent { display: flex; align-items: center; gap: 6px; color: #8b949e; font-size: 12px; cursor: pointer; }
  .signup-email-consent input { margin: 0; }
  .signup-email-error { color: #f85149; font-size: 12px; margin-top: 6px; min-height: 16px; }
  .signup-email-success { color: #3fb950; font-size: 13px; padding: 12px 0; }
</style>
</head>
<body>
<div class="container">
  <h1>Welcome to AlgoVault! &#x1f389;</h1>
  <div class="subtitle">${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) + ' plan activated' : isOrganicVisit ? 'AlgoVault MCP — the crypto signal layer for AI agents' : 'Setting up your account...'}</div>
  ${paywallCta}
  ${keyDisplay}
  ${tgConnect}
  <div class="usage">
    <h2>Use it in Claude Desktop / Cursor / Claude Code</h2>
    <pre>{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp",
      "headers": { "Authorization": "Bearer ${apiKey || 'YOUR_API_KEY'}", "X-AlgoVault-Track-Token": "chan-welcome" }
    }
  }
}</pre>
    <p style="color:#8b949e;font-size:12px;margin-top:8px">Paste into <code style="background:#0d1117;padding:1px 4px;border-radius:3px">claude_desktop_config.json</code> (or Cursor / Claude Code MCP config). Then ask: <em>"Get me a trade call for SOL on the 5-minute timeframe."</em></p>
    <p style="color:#8b949e;font-size:12px;margin-top:8px">Want to test with raw HTTP/curl? See the <a href="https://algovault.com/docs.html#testing-with-curl" style="color:#58a6ff">3-step handshake guide</a> in our docs. Supported exchanges: BINANCE (default), HL, BYBIT, OKX, BITGET. Need to find your key later? Visit <a href="/account" style="color:#58a6ff">/account</a>.</p>
  </div>
</div>
<script>
  // POWER-USER-OUTREACH-W1-V2 signup-email form handler. Inline so no extra
  // network request; small payload; no framework dependency.
  (function () {
    var form = document.getElementById('signup-email-form');
    if (!form) return;
    var block = document.getElementById('signup-email-block');
    var emailEl = document.getElementById('signup-email-input');
    var consentEl = document.getElementById('signup-email-consent');
    var errEl = document.getElementById('signup-email-error');
    var btn = form.querySelector('button[type="submit"]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errEl.textContent = '';
      var email = (emailEl.value || '').trim();
      if (!email || email.length > 254 || email.indexOf('@') < 1 || email.lastIndexOf('.') < email.indexOf('@')) {
        errEl.textContent = 'Please enter a valid email.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Creating…';
      fetch('/api/signup-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, source: 'welcome-paywall', optin_consent: consentEl.checked })
      })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'parse_error' }; }); })
        .then(function (data) {
          if (data && data.ok === true) {
            block.innerHTML = '<p class="signup-email-success">✓ Your free account is ready — we emailed your API key + referral link to ' + email.replace(/</g, '&lt;') + '.</p>';
          } else {
            var code = (data && data.error) || 'send_failed';
            var msg = code === 'invalid_email' ? 'Please enter a valid email.'
                    : code === 'disposable_email' ? 'Please use a non-disposable email address.'
                    : code === 'no_mx' ? 'That email domain cannot receive mail — please check it.'
                    : 'Could not create your account. Try again or email support@algovault.com.';
            errEl.textContent = msg;
            btn.disabled = false;
            btn.textContent = 'Get my free key';
          }
        })
        .catch(function () {
          errEl.textContent = 'Network error. Try again.';
          btn.disabled = false;
          btn.textContent = 'Get my free key';
        });
    });
  })();
</script>
</body>
</html>`;
}
