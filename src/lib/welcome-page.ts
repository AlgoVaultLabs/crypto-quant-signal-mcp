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

export function getWelcomePageHtml(
  apiKey: string | null,
  tier: string | null,
  email: string | null,
): string {
  const keyDisplay = apiKey
    ? `<div class="key-box"><div class="label">Your API Key</div><code id="api-key">${apiKey}</code><button onclick="navigator.clipboard.writeText(document.getElementById('api-key').textContent);this.textContent='Copied!'">Copy</button></div>`
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
</style>
</head>
<body>
<div class="container">
  <h1>Welcome to AlgoVault! &#x1f389;</h1>
  <div class="subtitle">${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) + ' plan activated' : 'Setting up your account...'}</div>
  ${keyDisplay}
  ${tgConnect}
  <div class="usage">
    <h2>Use it in Claude Desktop / Cursor / Claude Code</h2>
    <pre>{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp",
      "headers": { "Authorization": "Bearer ${apiKey || 'YOUR_API_KEY'}" }
    }
  }
}</pre>
    <p style="color:#8b949e;font-size:12px;margin-top:8px">Paste into <code style="background:#0d1117;padding:1px 4px;border-radius:3px">claude_desktop_config.json</code> (or Cursor / Claude Code MCP config). Then ask: <em>"Get me a trade call for SOL on the 5-minute timeframe."</em></p>
    <p style="color:#8b949e;font-size:12px;margin-top:8px">Want to test with raw HTTP/curl? See the <a href="https://algovault.com/docs.html#testing-with-curl" style="color:#58a6ff">3-step handshake guide</a> in our docs. Supported exchanges: BINANCE (default), HL, BYBIT, OKX, BITGET. Need to find your key later? Visit <a href="/account" style="color:#58a6ff">/account</a>.</p>
  </div>
</div>
</body>
</html>`;
}
