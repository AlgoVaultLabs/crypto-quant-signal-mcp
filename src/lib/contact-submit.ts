/**
 * Contact-form submission logic — CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1.
 *
 * Lives here, not inline in `index.ts`, per CLAUDE.md: "index.ts boots the server at import →
 * handler closures untestable ... a tool's business logic lives in an exported module with the
 * handler a thin shell". The acceptance criteria for this wave are persist-before-send, a
 * survivable Resend outage, four abuse controls and header-injection safety — none of which can
 * be honestly asserted against a closure nobody can import.
 *
 * ORDER IS THE CONTRACT:
 *   validate → PERSIST (durably) → notify → record the notify outcome → confirm.
 *
 * A lead is the scarcest thing this product captures and an email send is a network call that
 * fails. Sending first — or persisting non-durably — turns a Resend outage into a lost lead
 * behind a success page. Everything after the persist is explicitly unable to fail the request.
 */

export interface ContactSubmitRaw {
  readonly [key: string]: unknown;
}

export interface ContactSubmitContext {
  /** Resolved server-side from the request; the form's hidden field is a hint, never trusted. */
  readonly src: string | null;
  readonly ipHash: string | null;
}

export interface ContactSubmitDeps {
  readonly validateEmail: (email: string) => Promise<{ ok: boolean; reason?: string }>;
  readonly insertLead: (row: {
    name: string; email: string; company: string | null; monthlyVolume: string | null;
    message: string; intent: string; src: string | null; ipHash: string | null;
  }) => Promise<number | null>;
  readonly markNotified: (id: number, error: string | null) => void;
  readonly sendEmail: (args: {
    leadId: number; name: string; email: string; company: string | null;
    monthlyVolume: string | null; message: string; intent: string; src: string | null;
  }) => Promise<{ id: string } | null>;
  readonly sendAlert: (message: string, level: 'critical' | 'warning' | 'info') => Promise<boolean>;
  readonly log?: (line: string) => void;
}

export type ContactSubmitResult =
  /** Render the confirmation page (HTTP 200). */
  | { kind: 'ok'; leadId: number; emailed: boolean }
  /** A bot filled the honeypot. Renders the SAME confirmation — never tell it why. */
  | { kind: 'honeypot' }
  /** Re-render the form with a reason (HTTP 400). */
  | { kind: 'invalid'; error: 'missing_fields' | 'invalid_email' | 'disposable_email' | 'invalid_intent' }
  /** The lead did NOT become durable, so we must not claim it did (HTTP 500). */
  | { kind: 'server_error' };

/** The honeypot field name. Exported so the renderer and the handler cannot disagree. */
export const HONEYPOT_FIELD = 'website';

/** Per-field caps. A body cap alone is not a field cap — one 8kb field would still pass. */
export const FIELD_LIMITS = {
  name: 120, email: 200, company: 160, monthly_volume: 60, message: 4000,
} as const;

/**
 * The inquiry types — CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1, architect-set order (Mr.1 2026-08-06).
 *
 * ONE ordered constant with FOUR consumers: the `<select>` options, the server-side validator, the
 * notification email's subject, and the Telegram body. Independent re-derivations drift to
 * contradiction — a value present in the dropdown but missing from the validator is a form that
 * silently discards a whole category of enquiry — and the round-trip gate exists to make that
 * impossible rather than merely unlikely.
 *
 * `contact_leads.intent` is already `TEXT` from the prior wave, so this is a value-domain change
 * with no DDL. Rows written before this wave carry the legacy literal `enterprise`.
 */
export const INQUIRY_TYPES = [
  'Enterprise Pricing',
  'Collaboration/Co-Marketing',
  'Feature Request',
  'Billing Inquiry',
  'Other Inquiry',
] as const;

export type InquiryType = (typeof INQUIRY_TYPES)[number];

/** What an unspecified enquiry becomes, and what the `<select>` pre-selects. */
export const DEFAULT_INQUIRY_TYPE: InquiryType = 'Enterprise Pricing';

/**
 * Map a submitted value onto its CANONICAL member, or null. Default-deny.
 *
 * It returns the CONSTANT, never the caller's string, and that distinction is load-bearing: the
 * canonical value is what reaches the email SUBJECT. The prior wave made that subject a fixed
 * literal precisely because interpolating user input into a header is unsafe — interpolating a
 * validated closed-set member is a different thing, and it is only different because of this
 * function. A crafted submission can therefore produce exactly one of five known-safe literals.
 */
export function canonicalInquiryType(raw: unknown): InquiryType | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return INQUIRY_TYPES.find((t) => t === v) ?? null;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export async function handleContactSubmission(
  raw: ContactSubmitRaw,
  ctx: ContactSubmitContext,
  deps: ContactSubmitDeps,
): Promise<ContactSubmitResult> {
  const log = deps.log ?? ((line: string) => console.log(line));

  // 1. Honeypot — a field no human sees. A filled value gets the SAME success page a human
  //    gets: telling a bot it was detected only teaches it to try again.
  if (str(raw[HONEYPOT_FIELD], 200).length > 0) {
    log('[contact] honeypot tripped — discarding submission');
    return { kind: 'honeypot' };
  }

  const name = str(raw.name, FIELD_LIMITS.name);
  const email = str(raw.email, FIELD_LIMITS.email).toLowerCase();
  const company = str(raw.company, FIELD_LIMITS.company) || null;
  const monthlyVolume = str(raw.monthly_volume, FIELD_LIMITS.monthly_volume) || null;
  const message = str(raw.message, FIELD_LIMITS.message);

  if (!name || !email || !message) return { kind: 'invalid', error: 'missing_fields' };

  // Default-deny on the closed set. An ABSENT field falls back to the default (a legacy client or
  // a curl without the field still works); a PRESENT but unrecognised one is rejected outright,
  // because that is either a stale form or someone probing the value domain.
  const rawIntent = raw.intent;
  const intent = rawIntent === undefined || rawIntent === null || rawIntent === ''
    ? DEFAULT_INQUIRY_TYPE
    : canonicalInquiryType(rawIntent);
  if (intent === null) return { kind: 'invalid', error: 'invalid_intent' };

  // 2. Reuses the SAME validator as the free-tier signup path (syntax + mailchecker disposable
  //    list + MX, fail-open on transient DNS). Not re-implemented.
  const v = await deps.validateEmail(email);
  if (!v.ok) {
    return { kind: 'invalid', error: v.reason === 'disposable_email' ? 'disposable_email' : 'invalid_email' };
  }

  // 3. PERSIST. `insertLead` returns null only when the row did not become durable.
  let leadId: number | null = null;
  try {
    leadId = await deps.insertLead({
      name, email, company, monthlyVolume, message,
      intent, src: ctx.src, ipHash: ctx.ipHash,
    });
  } catch (err) {
    console.error('[contact] lead persist FAILED:', err instanceof Error ? err.message : err);
  }
  if (leadId === null) return { kind: 'server_error' };
  log(`[contact] lead ${leadId} STORED (intent=${intent} src=${ctx.src ?? 'direct'})`);

  // 4. Notify. The lead is durable from here on, so NOTHING below may fail the request.
  let sendError: string | null = null;
  let emailed = false;
  try {
    const sent = await deps.sendEmail({
      leadId, name, email, company, monthlyVolume, message, intent, src: ctx.src,
    });
    emailed = sent !== null;
    // Success-path log — CLAUDE.md: a load-bearing side-effect inside a try needs one, or a
    // silent no-op (Resend unconfigured → null) is indistinguishable from a real delivery.
    log(`[contact] lead ${leadId} email ${sent ? `sent id=${sent.id}` : 'SKIPPED (Resend unconfigured)'}`);
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error(`[contact] lead ${leadId} email FAILED (lead IS stored): ${sendError}`);
  }

  try {
    deps.markNotified(leadId, sendError);
  } catch { /* bookkeeping only — the lead is already durable */ }

  // 5. Operator alert. In-container `sendAlert`, because the host wrapper
  //    /opt/algovault-monitoring/send_telegram.sh does NOT exist inside the container (verified
  //    by `docker exec … ls`). It is fail-open by construction and no gate is re-implemented.
  try {
    await deps.sendAlert(
      `New ${intent} enquiry — lead ${leadId}\nFrom: ${name} <${email}>\nCompany: ${company ?? '—'}\n`
      + `Volume: ${monthlyVolume ?? '—'}\nChannel: ${ctx.src ?? 'direct'}`,
      'info',
    );
  } catch (err) {
    console.error(`[contact] lead ${leadId} TG alert failed (non-fatal):`, err instanceof Error ? err.message : err);
  }

  return { kind: 'ok', leadId, emailed };
}
