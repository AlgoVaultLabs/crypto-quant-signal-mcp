/**
 * IDENTITY-LIFECYCLE-W3 CH1 — render a step to `{subject, html, text}`.
 *
 * Every string comes from `lifecycle-copy.ts`; this file owns only the shell. The §Footer is
 * appended here, once, so no step can ship without it — a lifecycle email with no unsubscribe
 * link is the one message this wave must be structurally unable to send.
 */
import { FREE_KEY_PREFIX } from '../free-keys-store.js';
import { copyForStep, footerText, API_BASE, FOOTER_BRAND, FOOTER_UNSUBSCRIBE_LABEL, FOOTER_MANAGE_LABEL, DIGEST_CONSENT_LINE, referralSentence, type LifecycleStep, type StepCopyContext } from '../lifecycle-copy.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A code-ish paragraph (the MCP config snippet) renders as a <pre>, everything else as <p>. */
function looksLikeSnippet(p: string): boolean {
  return p.includes('\n') && (p.includes('{') || p.includes('npx') || p.includes('"mcpServers"'));
}

export function renderLifecycleEmail(
  step: LifecycleStep,
  ctx: StepCopyContext,
  unsubscribeUrl: string,
): RenderedEmail {
  const copy = copyForStep(step, ctx);

  const bodyHtml: string[] = [];
  const bodyText: string[] = [];

  for (const p of copy.paragraphs) {
    if (looksLikeSnippet(p)) {
      bodyHtml.push(`<pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:12px;font-size:12px;line-height:1.45;overflow-x:auto;white-space:pre-wrap;word-break:break-word">${esc(p)}</pre>`);
    } else {
      bodyHtml.push(`<p style="font-size:15px;line-height:1.55;color:#1f2328;margin:0 0 14px">${esc(p)}</p>`);
    }
    bodyText.push(p);
  }

  if (copy.rawHtml) bodyHtml.push(copy.rawHtml);
  if (copy.rawText) bodyText.push(copy.rawText);

  // The referral sentence is E2's only extra line and is the existing referral SoT string. It
  // sits immediately before its own CTA, which is why it is placed here rather than in the
  // paragraph list — the two must not be separable.
  if (step === 'quota_80') {
    const s = referralSentence();
    bodyHtml.push(`<p style="font-size:15px;line-height:1.55;color:#1f2328;margin:18px 0 8px">${esc(s)}</p>`);
    bodyText.push(s);
  }

  if (step === 'product_updates') {
    bodyHtml.push(`<p style="font-size:13px;line-height:1.5;color:#656d76;margin:18px 0 0">${esc(DIGEST_CONSENT_LINE)}</p>`);
    bodyText.push(DIGEST_CONSENT_LINE);
  }

  for (const cta of copy.ctas) {
    bodyHtml.push(`<p style="margin:8px 0"><a href="${esc(cta.url)}" style="color:#0969da;text-decoration:none;font-weight:600">${esc(cta.label)} &rarr;</a></p>`);
    bodyText.push(`${cta.label}: ${cta.url}`);
  }

  const footerHtml =
    `<hr style="border:0;border-top:1px solid #d0d7de;margin:28px 0 14px">` +
    `<p style="font-size:12px;line-height:1.5;color:#656d76;margin:0">` +
    `${esc(FOOTER_BRAND)} · ` +
    `<a href="${esc(unsubscribeUrl)}" style="color:#656d76">${esc(FOOTER_UNSUBSCRIBE_LABEL)}</a> · ` +
    `<a href="${esc(API_BASE)}/account" style="color:#656d76">${esc(FOOTER_MANAGE_LABEL)}</a>` +
    `</p>`;

  const html =
    `<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
    `<div style="max-width:560px;margin:0 auto">${bodyHtml.join('\n')}${footerHtml}</div></body>`;

  const text = `${bodyText.join('\n\n')}\n\n—\n${footerText(unsubscribeUrl)}\n`;

  return { subject: copy.subject, html, text };
}

// ── OUTBOUND CREDENTIAL GUARD (architect ruling Q7, 2026-09-09) ────────────────────────────
//
// Build Rule 9 as AMENDED: "Never a PAID secret in any email. A free-tier key may appear in the
// activation snippet only." A free `av_free_` key is safe to mail because the free tier is
// KEYLESS at the same ladder — 200/mo, 100/day — so a leaked one grants nothing an anonymous
// caller lacks except that bucket's referral bonus, and the welcome/creation senders already put
// the identical key in the identical mailbox. A PAID key is a different object entirely.
//
// ENFORCED IN CODE, NOT PROSE, because that is this estate's standing rule for anything that has
// ever failed as a written instruction — and a rule that says "don't put paid keys in emails"
// is exactly the shape that gets violated by the next wave that adds a template.
//
// 🛑 ALLOW-LIST, NOT DENY-LIST. There is NO `av_live_` constant in this codebase: paid keys are
// STRIPE-VALIDATED, not prefix-recognised (the prefix shortcut survives only as the dev-only
// ALLOW_DEV_KEY_PREFIX opt-in). So enumerating paid formats would be guessing at a set nobody
// maintains. Instead every credential-shaped token in the body must start with FREE_KEY_PREFIX;
// anything else refuses. That catches `av_live_`, `sk_live_`, a Stripe secret and any format
// invented later, without this guard needing to know they exist.
//
// The unsubscribe and preference handles are deliberately NOT credential-shaped (`<base64url>.
// <64 hex>`), so the footer cannot trip this — asserted in the test file rather than assumed.

/** Tokens shaped like an API credential. Narrow on purpose: signed handles must not match. */
const CREDENTIAL_SHAPED = /\b(?:av|sk|pk|rk|whsec)_[A-Za-z0-9_]{6,}/g;

export interface CredentialScan { ok: boolean; offending: string[] }

/**
 * Scan a rendered body for credentials that are not free-tier keys.
 *
 * Returns a verdict rather than throwing: a guard on a send path REFUSES, it does not throw, and
 * the caller records the refusal where an operator can see it.
 */
export function scanOutboundCredentials(...parts: string[]): CredentialScan {
  const offending: string[] = [];
  for (const part of parts) {
    for (const m of (part || '').matchAll(CREDENTIAL_SHAPED)) {
      if (!m[0].startsWith(FREE_KEY_PREFIX)) {
        // Record the PREFIX only. A guard that logs the whole offending secret in order to
        // complain about a secret has reproduced the defect it exists to prevent.
        offending.push(`${m[0].slice(0, 8)}…`);
      }
    }
  }
  return { ok: offending.length === 0, offending: [...new Set(offending)] };
}
