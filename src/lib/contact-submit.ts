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
 *   validate → PERSIST (durably) → SCORE → (quarantined ? mark & stay silent : notify)
 *            → record the notify outcome → confirm.
 *
 * A lead is the scarcest thing this product captures and an email send is a network call that
 * fails. Sending first — or persisting non-durably — turns a Resend outage into a lost lead
 * behind a success page. Everything after the persist is explicitly unable to fail the request.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY SCORING RUNS *AFTER* THE INSERT, AND MUST NOT BE "OPTIMISED" FORWARD
 * (CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1)
 *
 * Moving the score ahead of the persist looks cheaper — you would skip a write for spam. It is
 * wrong three times over:
 *   1. The lead would no longer be durable before we pass judgement on it, so a scorer bug could
 *      destroy a real enterprise lead. Quarantine's entire safety property is that it acts on
 *      something already saved.
 *   2. The lookback rules count PRIOR ROWS over a 24h window. Scoring before the insert makes the
 *      current submission invisible to its own window, silently shifting every threshold by one.
 *   3. A scoring or DB failure could then fail the request. After the insert it provably cannot.
 *
 * The quarantine branch suppresses the NOTIFICATION, never the CAPTURE. No path in this file
 * deletes or rejects a stored lead — a false positive costs one email in the operator's inbox; a
 * false negative would cost the lead itself.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import {
  scoreLead, serializeReasons, QUARANTINE_THRESHOLD, LOOKBACK_HOURS,
  EMPTY_LOOKBACK, type LeadLookback, type SpamReasonId,
} from './contact-spam.js';

export interface ContactSubmitRaw {
  readonly [key: string]: unknown;
}

export interface ContactSubmitContext {
  /** Resolved server-side from the request; the form's hidden field is a hint, never trusted. */
  readonly src: string | null;
  readonly ipHash: string | null;
  /**
   * Reason ids decided OUTSIDE this handler — CONTACT-ANTISPAM-AND-REPLY-TO-W1.
   *
   * Today only `turnstile-unverified`, contributed by CH2 when the challenge could not be
   * evaluated. It arrives here rather than being derived because the challenge outcome is a
   * property of the REQUEST, not of the submitted fields, and `contact-spam.ts` is pure.
   * Optional and trailing: absent → no external tag, which is the pre-CH2 behaviour exactly.
   */
  readonly spamTags?: readonly SpamReasonId[];
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

  // ── Quarantine lane (CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1) ──
  // ALL OPTIONAL, so every existing caller and every existing test compiles unchanged (CLAUDE.md's
  // interface-preserved side-fix rule).
  //
  // WHAT IS AND IS NOT DEP-GATED, because the difference matters: SCORING ALWAYS RUNS. The
  // field-only rules — `same-name-volume` above all, which alone identified all 65 rows of the
  // 2026-08 campaign — need no database, so a caller wired without these deps still refuses to
  // page the operator for a known spam shape. What absent deps cost is the DURABLE RECORD
  // (`markScored`) and the campaign NOTICE (`countRecentQuarantines`), plus the two
  // lookback-derived rules, which genuinely cannot fire without a window to measure. The
  // protection is not optional; its bookkeeping is.

  /** Measure the lookback window. Absent → {@link EMPTY_LOOKBACK}, i.e. no lookback rule fires. */
  readonly readLookback?: (args: {
    name: string; company: string | null; ipHash: string | null;
  }) => Promise<LeadLookback>;

  /** Persist the verdict. Absent → the score is computed and logged but not stored. */
  readonly markScored?: (
    id: number, score: number, reasons: string | null, quarantined: boolean,
  ) => Promise<boolean>;

  /**
   * Quarantines in the last {@link LOOKBACK_HOURS}, EXCLUDING this lead. Drives the campaign
   * alert's one-per-window bound. `null` means "could not count" and suppresses the alert — a
   * missing count must never manufacture a page.
   */
  readonly countRecentQuarantines?: (excludeId: number) => Promise<number | null>;
}

export type ContactSubmitResult =
  /**
   * Render the confirmation page (HTTP 200).
   *
   * `quarantined` is the third verdict this pipeline gained in CH1 — "stored, but not trustworthy".
   * It rides on `ok` rather than becoming its own `kind` DELIBERATELY: the caller's response must
   * be byte-identical either way. A bot that can tell quarantine from success has been handed the
   * oracle it needs to tune around the scorer, which is the same reasoning the `honeypot` branch
   * already applies one screen below.
   */
  | { kind: 'ok'; leadId: number; emailed: boolean; quarantined?: boolean; spamScore?: number }
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

  // 4. SCORE. The lead is durable from here on, so NOTHING below may fail the request — every
  //    step is individually wrapped and every failure degrades toward NOTIFYING, never toward
  //    silence. "We could not judge it" must resolve to "the operator sees it".
  let lookback: LeadLookback = EMPTY_LOOKBACK;
  if (deps.readLookback) {
    try {
      lookback = await deps.readLookback({ name, company, ipHash: ctx.ipHash });
    } catch (err) {
      // The store already fails open internally; this is the belt to that braces, because a
      // throw here would otherwise reach the request path the persist step just made safe.
      console.error(
        `[contact] lead ${leadId} lookback threw — scoring with an empty window:`,
        err instanceof Error ? err.message : err,
      );
      lookback = EMPTY_LOOKBACK;
    }
  }

  const verdict = scoreLead(
    { name, company, monthlyVolume, message, src: ctx.src },
    lookback,
    ctx.spamTags ?? [],
  );
  const reasons = serializeReasons(verdict.reasons);
  log(
    `[contact] lead ${leadId} SCORED ${verdict.score}/${QUARANTINE_THRESHOLD}`
    + ` reasons=${reasons ?? 'none'} verdict=${verdict.quarantined ? 'QUARANTINE' : 'notify'}`,
  );

  if (deps.markScored) {
    try {
      const wrote = await deps.markScored(leadId, verdict.score, reasons, verdict.quarantined);
      // Success-path log: a score write that silently vanished would leave a quarantined lead
      // looking un-scored forever, which is indistinguishable from the scorer never running.
      if (!wrote) console.error(`[contact] lead ${leadId} score write did not land (lead IS stored)`);
    } catch (err) {
      console.error(
        `[contact] lead ${leadId} score write FAILED (lead IS stored):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 5. QUARANTINE BRANCH — stored, marked, and SILENT.
  //
  //    No email and no per-lead Telegram alert. `email_sent_at` and `email_error` both stay NULL,
  //    which is what makes "not sent because quarantined" distinguishable from "send failed":
  //    `quarantined_at` is the discriminator, not the absence of a timestamp.
  //
  //    The user gets the SAME confirmation a human gets. Telling a bot it was detected only
  //    teaches it to tune around the rule — the honeypot branch above already establishes this,
  //    and here the stakes are higher because the rule table is public in the repo.
  if (verdict.quarantined) {
    await maybeAlertCampaign(leadId, verdict.score, reasons, ctx, deps, log);
    return { kind: 'ok', leadId, emailed: false, quarantined: true, spamScore: verdict.score };
  }

  // 6. Notify.
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

  // 7. Operator alert. In-container `sendAlert`, because the host wrapper
  //    /opt/algovault-monitoring/send_telegram.sh does NOT exist inside the container (verified
  //    by `docker exec … ls`). It is fail-open by construction and no gate is re-implemented.
  //
  //    UNREACHABLE FOR A QUARANTINED LEAD — the branch above returns before this line. That is
  //    the whole point of the wave: 65 of these fired across 15 days for one campaign.
  try {
    await deps.sendAlert(
      `New ${intent} enquiry — lead ${leadId}\nFrom: ${name} <${email}>\nCompany: ${company ?? '—'}\n`
      + `Volume: ${monthlyVolume ?? '—'}\nChannel: ${ctx.src ?? 'direct'}`,
      'info',
    );
  } catch (err) {
    console.error(`[contact] lead ${leadId} TG alert failed (non-fatal):`, err instanceof Error ? err.message : err);
  }

  return { kind: 'ok', leadId, emailed, quarantined: false, spamScore: verdict.score };
}

/**
 * ONE bounded campaign alert per {@link LOOKBACK_HOURS} window — not one page per spam lead.
 *
 * CLAUDE.md draws the line at the number of messages an EPISODE can produce: per-item chatter is
 * noise, one bounded notice is signal. So this fires on the FIRST quarantine in a window and then
 * stays silent for the rest of it, however long the campaign runs.
 *
 * THE COOLDOWN IS DERIVED FROM `quarantined_at` ITSELF, not from a marker file or a module-level
 * timestamp. In-memory state resets on every deploy, so a redeploy mid-campaign would re-page;
 * and a separate "when did we last alert" store is a second thing that drifts from the thing it
 * describes. The data already answers the question.
 *
 * `count === null` means we could not count, and that SUPPRESSES the alert. Deliberate direction:
 * the quarantine lane is already working silently at this point, so a failed count must not
 * manufacture a page. The counter's failure is logged by the store.
 */
async function maybeAlertCampaign(
  leadId: number,
  score: number,
  reasons: string | null,
  ctx: ContactSubmitContext,
  deps: ContactSubmitDeps,
  log: (line: string) => void,
): Promise<void> {
  if (!deps.countRecentQuarantines) return;
  try {
    const priorInWindow = await deps.countRecentQuarantines(leadId);
    if (priorInWindow === null) {
      log(`[contact] lead ${leadId} quarantined; campaign-alert SUPPRESSED (count unavailable)`);
      return;
    }
    if (priorInWindow > 0) {
      // The expected steady state during a campaign. Positive per-lead log line so a silent
      // window is distinguishable from a dead scorer — CLAUDE.md: assert positive output, never
      // absence-of-alert.
      log(
        `[contact] lead ${leadId} quarantined; campaign-alert suppressed`
        + ` (${priorInWindow} prior in the last ${LOOKBACK_HOURS}h)`,
      );
      return;
    }
    await deps.sendAlert(
      `Contact-form spam campaign detected — quarantine active\n`
      + `First quarantined lead in ${LOOKBACK_HOURS}h: ${leadId} (score ${score}/${QUARANTINE_THRESHOLD}, ${reasons ?? 'none'})\n`
      + `Channel: ${ctx.src ?? 'direct'}\n`
      + `These leads are STORED and marked, never deleted. Per-lead alerts are suppressed for the\n`
      + `next ${LOOKBACK_HOURS}h; this is the only message you will get for this campaign.\n`
      + `Review: SELECT id, created_at, name, email, spam_score, spam_reasons FROM contact_leads\n`
      + `        WHERE quarantined_at IS NOT NULL ORDER BY id DESC;`,
      'info',
    );
    log(`[contact] lead ${leadId} quarantined; campaign-alert SENT (first in ${LOOKBACK_HOURS}h)`);
  } catch (err) {
    console.error(
      `[contact] lead ${leadId} campaign alert failed (non-fatal, lead IS stored and marked):`,
      err instanceof Error ? err.message : err,
    );
  }
}
