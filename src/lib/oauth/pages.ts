/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — the pages a person sees while connecting a client (§Copy B, C, H).
 *
 * People read these inside Claude's sign-in window, so every string is §Copy verbatim and nothing
 * else: no key, no token, no code is ever rendered. The palette is the generated THEME region
 * (Design.md §13) with token classes only — no colour literal — so `check-legacy-navy-literals.mjs`
 * and `check-token-resolution.mjs` read these exactly as they read `signinRefusal`. Forms POST to
 * our own origin (CSP `form-action 'self'`); every hand-off to the client goes through
 * `sendOffOriginRedirect`, never a 3xx after a form.
 */
import { renderThemeBlock } from '../site-theme.js';
import { freeCallsLabel } from '../plans.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

// §Copy H — verbatim.
export const COPY_H = {
  handoffTitle: 'Signed in',
  handoffBody: (label: string) => `Taking you back to ${label}…`,
  handoffCta: (label: string) => `Continue to ${label}`,
  codeHeading: 'Check your email',
  codeBody: (email: string) => `We sent a 6-digit code to ${email}.`,
  codeField: 'Code',
  codeButton: 'Continue',
  codeResend: 'Send a new code',
  codeWrong: "That code didn't work. Check it, or send a new one.",
  keyNotRecognised: "We couldn't use that key. Check it, or sign in with Google, GitHub or email.",
  keyEphemeral: "That key isn't linked to an account yet. Sign in with Google, GitHub or email to keep going.",
  busy: "We couldn't finish just now. Please try again in a minute.",
  expired: 'This sign-in link expired. Start again from the app you were using.',
} as const;

function layout(title: string, inner: string): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="robots" content="noindex">\n' +
    `<title>${esc(title)}</title>\n${renderThemeBlock()}\n</head>\n<body class="bg-navy-900 text-gray-200">\n` +
    '<main style="max-width:440px;margin:60px auto;padding:0 20px;font-family:system-ui,sans-serif;line-height:1.5">\n' +
    `${inner}\n</main>\n</body>\n</html>\n`
  );
}

const BTN = 'display:block;width:100%;padding:11px;margin:0 0 10px;border-radius:9px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;font-size:15px';
const INPUT = 'display:block;width:100%;box-sizing:border-box;padding:11px;margin:0 0 10px;border-radius:9px;font-size:15px';

function notice(message: string | undefined): string {
  return message ? `<p class="text-brass-400" role="alert">${esc(message)}</p>` : '';
}

/** §Copy B. Google / GitHub render only when sign-up is on and that provider is live (I-11). */
export function renderConnectPage(opts: {
  clientLabel: string;
  pendingId: string;
  providers: { google: boolean; github: boolean };
  message?: string;
}): string {
  const r = esc(opts.pendingId);
  const google = opts.providers.google
    ? `<a class="bg-gray-200 text-navy-900" style="${BTN}" href="/auth/google">Continue with Google</a>`
    : '';
  const github = opts.providers.github
    ? `<a class="bg-navy-700 text-gray-200 border border-line" style="${BTN}" href="/auth/github">Continue with GitHub</a>`
    : '';
  return layout(
    `Connect ${opts.clientLabel} to AlgoVault`,
    `<h1 style="font-size:24px;margin:0 0 8px">${esc(`Connect ${opts.clientLabel} to AlgoVault`)}</h1>\n` +
      `<p class="text-steel-400">${esc(`Sign in free to keep getting trade calls. ${freeCallsLabel()} calls a month, no card.`)}</p>\n` +
      notice(opts.message) +
      google +
      github +
      `<form method="post" action="/oauth/connect/email" style="margin:0">` +
      `<input type="hidden" name="r" value="${r}">` +
      `<input class="bg-well text-gray-200 border border-line" style="${INPUT}" type="email" name="email" autocomplete="email" required aria-label="Email" placeholder="you@example.com">` +
      `<button class="bg-mint-400 text-navy-900" style="${BTN};border:0" type="submit">Continue with email</button></form>\n` +
      `<details style="margin:6px 0 14px"><summary class="text-mint-400" style="cursor:pointer">I have an API key</summary>` +
      `<form method="post" action="/oauth/connect/key" style="margin:10px 0 0">` +
      `<input type="hidden" name="r" value="${r}">` +
      `<input class="bg-well text-gray-200 border border-line" style="${INPUT}" type="password" name="api_key" autocomplete="off" required aria-label="API key">` +
      `<button class="bg-navy-700 text-gray-200 border border-line" style="${BTN}" type="submit">Continue</button></form></details>\n` +
      `<p class="text-steel-500" style="font-size:13px">You'll approve access on the next screen.</p>`,
  );
}

/** §Copy H code entry. */
export function renderEmailCodePage(opts: { email: string; pendingId: string; message?: string }): string {
  const r = esc(opts.pendingId);
  return layout(
    COPY_H.codeHeading,
    `<h1 style="font-size:24px;margin:0 0 8px">${esc(COPY_H.codeHeading)}</h1>\n` +
      `<p class="text-steel-400">${esc(COPY_H.codeBody(opts.email))}</p>\n` +
      notice(opts.message) +
      `<form method="post" action="/oauth/connect/email/verify" style="margin:0">` +
      `<input type="hidden" name="r" value="${r}">` +
      `<label for="code">${esc(COPY_H.codeField)}</label>` +
      `<input id="code" class="bg-well text-gray-200 border border-line" style="${INPUT}" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>` +
      `<button class="bg-mint-400 text-navy-900" style="${BTN};border:0" type="submit">${esc(COPY_H.codeButton)}</button></form>\n` +
      `<form method="post" action="/oauth/connect/email" style="margin:0">` +
      `<input type="hidden" name="r" value="${r}"><input type="hidden" name="email" value="${esc(opts.email)}">` +
      `<button class="text-mint-400" style="background:none;border:0;padding:0;cursor:pointer;font-size:14px" type="submit">${esc(COPY_H.codeResend)}</button></form>`,
  );
}

/** §Copy C. No remembered consent: this page renders on every authorization. */
export function renderConsentPage(opts: {
  clientLabel: string;
  accountLabel: string;
  planLabel: string;
  redirectHost: string;
  loopback: boolean;
  pendingId: string;
  csrf: string;
}): string {
  const hidden = `<input type="hidden" name="r" value="${esc(opts.pendingId)}"><input type="hidden" name="csrf" value="${esc(opts.csrf)}">`;
  return layout(
    `Allow ${opts.clientLabel} to use AlgoVault?`,
    `<h1 style="font-size:24px;margin:0 0 8px">${esc(`Allow ${opts.clientLabel} to use AlgoVault?`)}</h1>\n` +
      `<p>${esc(`${opts.clientLabel} will get trade calls from AlgoVault as ${opts.accountLabel}, on your ${opts.planLabel} plan.`)}</p>\n` +
      `<p class="text-steel-400">${esc(`After you allow, you'll go back to ${opts.redirectHost}.`)}</p>\n` +
      `<p class="text-steel-400">${esc(`Only allow this if you started it from ${opts.clientLabel}.`)}</p>\n` +
      (opts.loopback ? `<p class="text-brass-400">This app runs on your own computer. Allow only if you just started sign-in there.</p>\n` : '') +
      `<form method="post" action="/oauth/consent" style="margin:16px 0 0">${hidden}` +
      `<button class="bg-mint-400 text-navy-900" style="${BTN};border:0" type="submit" name="decision" value="allow">Allow</button>` +
      `<button class="bg-navy-700 text-gray-200 border border-line" style="${BTN}" type="submit" name="decision" value="cancel">Cancel</button></form>`,
  );
}

/** A one-line page (§Copy H expired / busy) — no form, nothing about any account. */
export function renderMessagePage(message: string): string {
  return layout('AlgoVault', `<p>${esc(message)}</p>`);
}
