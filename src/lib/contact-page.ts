/**
 * /contact — the Enterprise lead-capture surface (CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1).
 *
 * WHY A FORM AND NOT THE `mailto:` IT REPLACES. Measured live 2026-08-05: ZERO plain `mailto:`
 * links survive to any browser on any page. Cloudflare rewrites all 14 of them into
 * `/cdn-cgi/l/email-protection#<hex>` and ships `email-decode.min.js` to restore them at runtime,
 * so a content blocker, a strict CSP, a bot or a link-preview fetcher sees a dead Cloudflare
 * internal path. And even fully decoded, `mailto:` needs a registered OS mail handler — Chrome on
 * desktop with webmail and no handler does nothing at all. The highest-value CTA on the pricing
 * surface depended on the visitor's desktop configuration. A form removes both failure modes.
 *
 * The plain address stays visible as a secondary fallback: the form is the primary path, not the
 * only one, and someone whose JS is off must still be able to reach us.
 */

/** Where a lead lands. Mirrors `email.ts:REPLY_TO_ADDRESS`; the operator holds this mailbox. */
export const CONTACT_FALLBACK_EMAIL = 'admin@algovault.com';

/**
 * The honeypot field name — re-exported from the handler so the rendered input and the check
 * that reads it can never disagree. Deliberately plausible: `website` is a field a naive bot
 * fills and a human never sees. It is `aria-hidden` and off-screen rather than `display:none`,
 * because some bots skip display-none inputs specifically to evade this check.
 */
export { HONEYPOT_FIELD } from './contact-submit.js';
import { HONEYPOT_FIELD, INQUIRY_TYPES, DEFAULT_INQUIRY_TYPE } from './contact-submit.js';
// FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1: brand footer from the one SoT.
import { renderBrandFooter } from './footer-content.js';

const SHELL_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  /* Sticky-footer shape (DESIGN-WELCOME-LAYOUT-AND-FOOTER-FLOW-W1). A centering flex ROW here
     makes the brand footer a flex ITEM beside the card. Fix the container, never the footer.
     Enforced by scripts/check-footer-body-flow.mjs, whose docblock carries the full rationale. */
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0f1117; color:#e1e4e8; display:flex; flex-direction:column; min-height:100vh; }
  .page-main { flex:1; display:flex; justify-content:center; width:100%; padding:48px 24px; }
  .wrap { max-width:640px; width:100%; }
  h1 { font-size:28px; margin-bottom:8px; }
  .sub { color:#8b949e; font-size:14px; margin-bottom:28px; line-height:1.5; }
  form { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:28px; }
  label { display:block; font-size:13px; color:#c9d1d9; margin:0 0 6px; }
  .row { margin-bottom:18px; }
  input, textarea, select { width:100%; background:#0d1117; border:1px solid #30363d; border-radius:8px; color:#e1e4e8; padding:10px 12px; font-size:14px; font-family:inherit; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:#58a6ff; }
  textarea { min-height:132px; resize:vertical; }
  .opt { color:#6e7681; font-weight:400; }
  .hp { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
  button { background:#238636; color:#fff; border:0; border-radius:8px; padding:12px 28px; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#2ea043; }
  .fallback { color:#8b949e; font-size:13px; margin-top:20px; text-align:center; }
  .fallback a { color:#58a6ff; text-decoration:none; }
  .err { background:rgba(248,81,73,0.1); border:1px solid rgba(248,81,73,0.4); color:#ff7b72; border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:18px; }
  .ok { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:32px; text-align:center; }
  .ok h1 { color:#3fb950; }`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${SHELL_CSS}</style>
</head>
<body><main class="page-main"><div class="wrap">${body}</div></main>${renderBrandFooter('desktop')}</body>
</html>`;
}

/** Human-readable reasons. Never echoes the submitted value back into the page. */
export const CONTACT_ERRORS: Readonly<Record<string, string>> = {
  missing_fields: 'Please fill in your name, email and message.',
  invalid_email: 'That email address does not look valid. Please check it.',
  invalid_intent: 'Please choose an inquiry type from the list.',
  disposable_email: 'Please use your work email address.',
  too_long: 'That message is longer than we can accept. Please shorten it.',
  server_error: 'Something went wrong on our side. Please email us directly instead.',
};

export function renderContactPage(opts: { error?: string | null; src?: string | null } = {}): string {
  const errKey = opts.error && Object.prototype.hasOwnProperty.call(CONTACT_ERRORS, opts.error) ? opts.error : null;
  const err = errKey ? `<div class="err">${CONTACT_ERRORS[errKey]}</div>` : '';
  // `src` round-trips through a hidden field so the channel survives the POST. It is
  // re-classified server-side on submit — never trusted as sent.
  const src = typeof opts.src === 'string' ? opts.src.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64) : '';
  return shell('Contact AlgoVault', `
  <h1>Talk to us</h1>
  <div class="sub">Enterprise volume, custom venues, or anything the self-serve plans do not cover. We read every message.</div>
  <form method="POST" action="/contact">
    ${err}
    <div class="row"><label for="inquiry_type">What is this about?</label><select id="inquiry_type" name="intent" required>
      ${INQUIRY_TYPES.map((t) => `<option value="${t}"${t === DEFAULT_INQUIRY_TYPE ? ' selected' : ''}>${t}</option>`).join('\n      ')}
    </select></div>
    <div class="row"><label for="name">Name</label><input id="name" name="name" required maxlength="120" autocomplete="name"></div>
    <div class="row"><label for="email">Work email</label><input id="email" name="email" type="email" required maxlength="200" autocomplete="email"></div>
    <div class="row"><label for="company">Company <span class="opt">(optional)</span></label><input id="company" name="company" maxlength="160" autocomplete="organization"></div>
    <div class="row"><label for="monthly_volume">Expected calls per month <span class="opt">(optional)</span></label><input id="monthly_volume" name="monthly_volume" maxlength="60" placeholder="e.g. 250,000"></div>
    <div class="row"><label for="message">Message</label><textarea id="message" name="message" required maxlength="4000"></textarea></div>
    <div class="hp" aria-hidden="true"><label for="${HONEYPOT_FIELD}">Website</label><input id="${HONEYPOT_FIELD}" name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off"></div>
    <input type="hidden" name="src" value="${src}">
    <button type="submit">Send</button>
  </form>
  <div class="fallback">Prefer email? <a href="mailto:${CONTACT_FALLBACK_EMAIL}">${CONTACT_FALLBACK_EMAIL}</a></div>`);
}

export function renderContactConfirmation(): string {
  return shell('Message sent — AlgoVault', `
  <div class="ok">
    <h1>Thanks — we have it</h1>
    <div class="sub" style="margin:12px 0 0">We will reply to the address you gave us, usually within one business day.</div>
  </div>
  <div class="fallback"><a href="/signup">&larr; Back to plans</a></div>`);
}
