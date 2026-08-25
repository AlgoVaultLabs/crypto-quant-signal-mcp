/**
 * Cloudflare Turnstile siteverify — CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH2.
 *
 * CH1 quarantines a bot AFTER it has already written a row. This stops the write, and stops the
 * next bot that does not share the current campaign's fingerprint. The two compose: Turnstile is
 * the door, the quarantine lane is the generator.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE-STATE POLICY. This table IS the chapter's design, so it lives in code rather than
 * in a spec nobody re-reads. {@link verifyTurnstile} returns exactly one of these.
 *
 *   condition                              verdict      rationale
 *   ─────────────────────────────────────  ───────────  ──────────────────────────────────────
 *   secret unset                           skip         CH1-only deploys, dev and CI must all
 *                                          (untagged)   work. Logged ONCE at startup, never
 *                                                       per request.
 *   token absent / empty / whitespace      unverified   The widget never rendered — JS off, a
 *                                          (TAGGED)     content blocker, a CSP miss. A 400 here
 *                                                       points the visitor at nothing they can
 *                                                       act on, and /contact's own docblock
 *                                                       promises a no-JS visitor can still
 *                                                       reach us. Never calls siteverify: there
 *                                                       is nothing to verify.
 *   siteverify success: true               pass         —
 *   siteverify success: false              reject       The visitor is PRESENT and can retry.
 *                                          (HTTP 400)   A retryable 400 is materially different
 *                                                       from a dropped row.
 *   token > 2048 chars                     reject       Documented maximum. Rejected BEFORE the
 *                                          (HTTP 400)   call — an oversized token is a client
 *                                                       that is not our widget.
 *   unreachable / timeout / 5xx / throw    unverified   A Cloudflare outage must never close the
 *                                          (TAGGED)     contact form. Detect → Recover → Alert →
 *                                                       Escalate: this branch RECOVERS silently
 *                                                       with forensics in the log. No new alert,
 *                                                       no new cooldown, no new monitoring
 *                                                       surface.
 *
 * WHY `absent` AND `false` ARE DIFFERENT — the boundary is deliberate and was decided, not
 * defaulted (architect ruling, 2026-08-25). A FAILED challenge leaves a widget on screen the
 * human can retry; a MISSING token means the widget was never there, so a 400 blames the visitor
 * for our rendering problem. And splitting them costs no security: a bot that omits the token to
 * reach the fail-open lane lands in CH1's scorer, which is exactly where the 2026-08 campaign
 * already scores 50 and quarantines. The unverified lane is TAGGED, so those leads are still
 * captured, still notified, and still visible as unverified.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { SpamReasonId } from './contact-spam.js';

/** The documented endpoint. A literal, and asserted as one by the unit suite. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The client-side field name Turnstile's widget injects into the form. Documented, not guessed. */
export const TURNSTILE_RESPONSE_FIELD = 'cf-turnstile-response';

/** Documented maximum token length. */
export const TURNSTILE_MAX_TOKEN_CHARS = 2048;

/** Bounded — never wait indefinitely on a third party sitting in front of a form submit. */
export const TURNSTILE_TIMEOUT_MS = 8000;

/** The reason id an unverified challenge contributes. Imported from CH1's frozen vocabulary. */
export const TURNSTILE_UNVERIFIED_REASON: SpamReasonId = 'turnstile-unverified';

export type TurnstileVerdict =
  /** No secret configured. Proceed, contribute nothing. */
  | { kind: 'skip' }
  /** Challenge passed. */
  | { kind: 'pass' }
  /**
   * We could not evaluate the challenge. Proceed, but TAG the lead.
   * `why` is for the log only — never rendered to the visitor.
   */
  | { kind: 'unverified'; why: string }
  /** The challenge was evaluated and FAILED. The route answers 400 and writes no row. */
  | { kind: 'reject'; errorCodes: readonly string[] };

export interface TurnstileDeps {
  /**
   * Read the secret AT CALL TIME. An import-time `process.env` read is untestable and is already
   * a named defect class in this codebase — a module that captures env at load cannot be
   * exercised for both the configured and unconfigured branches in one suite.
   */
  readonly getSecret: () => string | undefined;
  /** Injected so the unit suite never touches the network. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

let unconfiguredWarned = false;

/**
 * Remove the secret from any string before it reaches a log line.
 *
 * WHY THIS EXISTS, and it is not defensive theatre: this module's first draft interpolated
 * `err.message` directly into the outage log, carrying a comment asserting that "err.message
 * cannot carry the secret: it is only ever in the body". That claim was FALSE and the unit suite
 * falsified it on the first run — an error thrown by a fetch layer, an SDK, or a proxy is free to
 * quote the request it was trying to make. CLAUDE.md names this as the SECOND leak path, distinct
 * from request logging: `{exc!r}` / `str(exc)` / a traceback over a secret-bearing body.
 *
 * REDACTS BY STRUCTURE — it masks the ACTUAL VALUE we hold, not a guessed vendor prefix. Matching
 * on `0x4AAAAAA…` or `1x0000…` would be redaction by known format, and key formats drift.
 */
function redact(text: string, secret: string): string {
  const capped = text.slice(0, 400);
  return secret.length > 0 ? capped.split(secret).join('<redacted>') : capped;
}

/** Test seam: the "log once at startup, not per request" latch is module state. */
export function _resetTurnstileWarnLatchForTest(): void {
  unconfiguredWarned = false;
}

/**
 * Verify a Turnstile token.
 *
 * NEVER LOGS, RETURNS OR ECHOES THE SECRET — not in a verdict, not in an error, not in a
 * timeout message. The unit suite asserts that over every captured log line, because "we were
 * careful" is not a control.
 */
export async function verifyTurnstile(
  token: unknown,
  remoteIp: string | null,
  deps: TurnstileDeps,
): Promise<TurnstileVerdict> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const secret = deps.getSecret();

  if (!secret) {
    if (!unconfiguredWarned) {
      // ONCE. A per-request line here would be the loudest thing in the log on any deploy that
      // has not been given a key yet, which is every CH1-only deploy, every dev box and CI.
      log('[turnstile] TURNSTILE_SECRET_KEY unset — challenge skipped, contact form open');
      unconfiguredWarned = true;
    }
    return { kind: 'skip' };
  }

  // ABSENT / EMPTY / WHITESPACE-ONLY — the widget never rendered. Do not call siteverify: there
  // is nothing to verify, and calling it would burn a round-trip to be told `missing-input-
  // response`, which we already know.
  const raw = typeof token === 'string' ? token : '';
  if (raw.trim().length === 0) {
    log('[turnstile] no token submitted — widget did not render; lead captured and TAGGED');
    return { kind: 'unverified', why: 'token-absent' };
  }

  // Rejected BEFORE the call. An oversized token is not our widget.
  if (raw.length > TURNSTILE_MAX_TOKEN_CHARS) {
    log(`[turnstile] token too long (${raw.length} > ${TURNSTILE_MAX_TOKEN_CHARS}) — rejected pre-call`);
    return { kind: 'reject', errorCodes: ['invalid-input-response'] };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const body: Record<string, string> = { secret, response: raw };
    if (remoteIp) body.remoteip = remoteIp;

    const res = await doFetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });

    if (!res.ok) {
      // 5xx or any non-2xx: Cloudflare's problem, not the visitor's. Recover silently.
      log(`[turnstile] siteverify HTTP ${res.status} — failing OPEN, lead captured and TAGGED`);
      return { kind: 'unverified', why: `http-${res.status}` };
    }

    const json = await res.json() as { success?: boolean; 'error-codes'?: string[] };
    if (json.success === true) return { kind: 'pass' };

    const errorCodes = Array.isArray(json['error-codes']) ? json['error-codes'] : [];
    // A PRESENT token that siteverify rejected. The visitor is here and can retry.
    log(`[turnstile] challenge failed (${errorCodes.join(',') || 'no-codes'}) — 400, no row written`);
    return { kind: 'reject', errorCodes };
  } catch (err) {
    // Timeout, DNS, TLS, malformed JSON — every one of them is "we could not verify", never
    // "the visitor failed". The message goes through `redact` because an error raised by a fetch
    // layer, an SDK or a proxy is free to quote the request body it was trying to send, and that
    // body carries the secret. See the redact() docblock: this exact leak was live in the first
    // draft of this file.
    const why = redact(err instanceof Error ? err.message : String(err), secret);
    log(`[turnstile] siteverify unreachable (${why}) — failing OPEN, lead captured and TAGGED`);
    return { kind: 'unverified', why: 'unreachable' };
  }
}

/** The spam tags a verdict contributes. Only `unverified` contributes anything. */
export function turnstileTags(verdict: TurnstileVerdict): readonly SpamReasonId[] {
  return verdict.kind === 'unverified' ? [TURNSTILE_UNVERIFIED_REASON] : [];
}

/**
 * The visitor-facing message for a rejected challenge.
 *
 * Deliberately actionable and deliberately uninformative about WHY — it names the retry, not the
 * detection. Same reasoning as the honeypot branch in contact-submit.ts.
 */
export const TURNSTILE_REJECT_MESSAGE = 'Please complete the verification and try again.';
