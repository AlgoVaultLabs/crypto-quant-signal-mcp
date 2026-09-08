/**
 * IDENTITY-LIFECYCLE-W3 CH1 — render a step to `{subject, html, text}`.
 *
 * Every string comes from `lifecycle-copy.ts`; this file owns only the shell. The §Footer is
 * appended here, once, so no step can ship without it — a lifecycle email with no unsubscribe
 * link is the one message this wave must be structurally unable to send.
 */
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
