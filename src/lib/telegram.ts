/**
 * Telegram Bot API wrapper — sends alerts and digests to a private chat.
 * Silent no-op if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 *
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH1 — the transport CLASSIFIES, WAITS, and SAYS WHY.
 *
 * Measured 2026-10-15 08:00Z: the daily monitor digest failed with `fetch failed` twice,
 * back to back, with zero delay between the attempts — and the escalation sent seconds
 * later, from the same process, over the same token and chat, was delivered. A delivery
 * failure that had already cleared cost the operator a whole day's digest, and the page
 * pointed at a `[telegram] HTTP` log line that does not exist for a network failure. The
 * same root cause — a send path with no Recover stage — had already lost the knowledge-page
 * digest for three weeks, the GEO digest for six Mondays and the rate-limit digest for eight
 * consecutive weeks. This chapter retires the transport half of it:
 *
 *   - every failure is classified ONCE (`classifyTelegramFailure`), reusing the shared
 *     webhook classifier for no-response errors rather than a second copy of it;
 *   - two retry profiles live in ONE table (`TELEGRAM_RETRY_POLICY`): `serving` keeps the
 *     pre-wave latency envelope for paths that answer a user (/contact, Stripe), `scheduled`
 *     backs off and honours a 429's `retry_after` within a 45 s budget;
 *   - the cause is logged on every attempt and carried into the page, through a STRUCTURAL
 *     token redaction (the API URL embeds the bot token);
 *   - a CONTENT rejection the plain-text fallback cannot cure gets ONE degraded resend.
 */

// Pure Markdown/length primitives live in their own leaf so a PURE renderer can
// reach mdValue() without importing this transport module. Re-exported here so
// every existing `from './telegram.js'` importer is untouched.
import {
  mdValue,
  hasUnbalancedMarkdown,
  chunkSections,
  scrubForPlainText,
  TELEGRAM_MAX_MESSAGE,
} from './markdown-safe.js';
import { classifyDeliveryFailure, extractErrorCode } from './webhook-failure-class.js';
export { mdValue, hasUnbalancedMarkdown, chunkSections, TELEGRAM_MAX_MESSAGE };

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const LEVEL_EMOJI: Record<string, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🟢',
};

function isConfigured(): boolean {
  return BOT_TOKEN.length > 0 && CHAT_ID.length > 0;
}

// ── Failure disposition — derived ONCE ──

/**
 * What a failed send MEANS for what happens next. Every consumer — the retry loop, the
 * log line, the page, and (CH2) the ledger — projects from this one value.
 *
 *   transient — the same bytes may succeed later: no response, 429, 5xx.
 *   entity    — legacy Markdown could not be parsed; the plain-text fallback owns it.
 *   content   — Telegram rejected the TEXT itself (too long, not UTF-8); resending the
 *               same bytes cannot succeed, a degraded resend might.
 *   config    — our credential or chat is wrong; nothing this process does will fix it.
 */
export type TelegramDisposition = 'transient' | 'entity' | 'content' | 'config';

export interface TelegramFailure {
  disposition: TelegramDisposition;
  /** The shared classifier's class (`webhook-failure-class.ts`) — projected, never re-derived. */
  klass: string;
  /** `HTTP <status>`, or the errno (`EAI_AGAIN`, `ETIMEDOUT`, …); `no-errno` when undici hid it. */
  code: string;
  /** Telegram's `description` or the error chain — token-redacted, at most 200 chars. */
  desc: string;
  /** A 429's `parameters.retry_after`, in seconds; null otherwise. */
  retryAfterS: number | null;
}

export interface TelegramFailureInput {
  /** HTTP status of the response; absent when no response arrived. */
  httpStatus?: number;
  /** The response body (Telegram answers JSON: ok / error_code / description / parameters). */
  body?: string;
  /** The thrown error, when no response arrived. */
  error?: unknown;
}

const ENTITY_400 = /can't parse entities/i;
const CONFIG_400 = /chat not found|bot was blocked|not enough rights|have no rights|user is deactivated/i;
const DESC_MAX = 200;

/**
 * Remove a bot token from any string BY STRUCTURE — never by vendor prefix (CLAUDE.md:
 * redact secrets in exception repr too). The API URL is `…/bot<id>:<secret>/sendMessage`,
 * so any error that echoes the URL carries the credential. The second pattern is the bare
 * `<id>:<secret>` shape, for an error that quotes the token without the `bot` path segment.
 */
export function redactBotToken(s: string): string {
  return s
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, '<redacted>');
}

function clip(s: string): string {
  const one = redactBotToken(s).replace(/\s+/g, ' ').trim();
  return one.length > DESC_MAX ? `${one.slice(0, DESC_MAX - 1)}…` : one;
}

/** `name: message (cause CODE: message)` — the part `err.message` alone discards. */
function describeError(err: unknown): string {
  if (err == null || typeof err !== 'object') return String(err);
  const e = err as { name?: string; message?: string; cause?: unknown };
  let s = `${e.name ?? 'Error'}: ${e.message ?? ''}`;
  if (e.cause && typeof e.cause === 'object') {
    const c = e.cause as { name?: string; code?: string; message?: string };
    s += ` (cause ${c.code ?? c.name ?? 'Error'}${c.message ? `: ${c.message}` : ''})`;
  }
  return s;
}

/**
 * undici reports a failed multi-address connect as an AggregateError `cause` whose own
 * `.code` is empty and whose `errors[]` carry the errnos (measured in the container: a
 * refused connect surfaced with no `cause.code`). `extractErrorCode` reads `cause.code`
 * only, so this is consulted when — and only when — it found nothing.
 */
function aggregateErrno(err: unknown): string | undefined {
  const c = (err as { cause?: { errors?: unknown[] } } | null)?.cause;
  const first = Array.isArray(c?.errors) ? (c!.errors[0] as { code?: unknown } | undefined) : undefined;
  return first && typeof first.code === 'string' ? first.code : undefined;
}

function parseTelegramBody(body: string | undefined): { description?: string; retryAfter?: number } {
  if (!body) return {};
  try {
    const j = JSON.parse(body) as { description?: unknown; parameters?: { retry_after?: unknown } };
    const ra = j?.parameters?.retry_after;
    return {
      description: typeof j?.description === 'string' ? j.description : undefined,
      retryAfter: typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? ra : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Classify one failed send. PURE.
 *
 * No response → `extractErrorCode` + `classifyDeliveryFailure` (imported from the webhook
 * classifier, never copied); every class it can return is TRANSIENT here.
 *
 * HTTP response → the ONE table below. Note 401 and 403 are `config` here although
 * `probe-failure-class.ts` treats them as transient: that classifier judges a THIRD
 * PARTY's answer to our probe, where a 401/403 can be their edge throttling us; this one
 * judges our OWN bot credential against Telegram, where 401 means the token is wrong and
 * 403 means the bot was removed from (or blocked by) the chat. Retrying either cannot help.
 */
export function classifyTelegramFailure(input: TelegramFailureInput): TelegramFailure {
  const s = input.httpStatus;
  if (typeof s !== 'number' || !Number.isFinite(s)) {
    const errno = extractErrorCode(input.error) ?? aggregateErrno(input.error);
    return {
      disposition: 'transient',
      klass: classifyDeliveryFailure({ errorCode: errno }),
      code: errno ?? 'no-errno',
      desc: clip(describeError(input.error)),
      retryAfterS: null,
    };
  }
  const parsed = parseTelegramBody(input.body);
  const text = parsed.description ?? input.body ?? '';
  let disposition: TelegramDisposition;
  if (s === 429) disposition = 'transient';
  else if (s >= 500 && s <= 599) disposition = 'transient';
  else if (s === 400 && ENTITY_400.test(text)) disposition = 'entity';
  else if ((s === 400 && CONFIG_400.test(text)) || s === 401 || s === 403 || s === 404) disposition = 'config';
  else if (s >= 400 && s <= 499) disposition = 'content';
  else disposition = 'transient'; // an unexpected status outside 4xx/5xx: retry, never condemn
  return {
    disposition,
    klass: classifyDeliveryFailure({ httpStatus: s }),
    code: `HTTP ${s}`,
    desc: clip(text),
    retryAfterS: s === 429 ? (parsed.retryAfter ?? null) : null,
  };
}

// ── Retry profiles — ONE table ──

export type TelegramRetryPolicyName = 'serving' | 'scheduled';

export interface TelegramRetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Delay before attempt i (index 0 = the first attempt, always 0). */
  delaysMs: readonly number[];
  /** Wait a 429's `retry_after` (+ up to 1 s jitter) when that is longer than the delay. */
  honourRetryAfter: boolean;
  /** Wall-clock budget for one message; a wait that would cross it stops the loop. */
  budgetMs: number;
}

/**
 * `serving` — the DEFAULT for `sendAlert` / `sendVenueStatusChange`. The pre-wave envelope:
 * at most two attempts, no sleep. /contact and the Stripe portal await `sendAlert` before
 * they answer a user, so they must not inherit a backoff (a `config` failure now stops
 * after ONE attempt — strictly faster).
 *
 * `scheduled` — the default for `sendDigest`, opt-in elsewhere. Attempts at 0 s, +2 s,
 * +8 s; a 429 waits its `retry_after` when longer. The budget is 45 s: a `retry_after`
 * beyond what remains stops the loop and is RETURNED, so the caller can schedule from it
 * instead of spinning. A daily job's LAW budget (≥5% of its interval with backoff,
 * build-and-runtime.md) is far larger than any in-process wait should be — the remainder
 * is the durable ledger's job, not this loop's.
 */
export const TELEGRAM_RETRY_POLICY: Readonly<Record<TelegramRetryPolicyName, TelegramRetryPolicy>> = {
  serving: { maxAttempts: 2, delaysMs: [0, 0], honourRetryAfter: false, budgetMs: Number.POSITIVE_INFINITY },
  scheduled: { maxAttempts: 3, delaysMs: [0, 2_000, 8_000], honourRetryAfter: true, budgetMs: 45_000 },
};

/** A CONTENT rejection is re-chunked this far under the limit for its one degraded resend. */
const DEGRADED_CHUNK_LIMIT = 3_800;

// ── Time seam — the sleeper is injectable so suites run on a fake clock ──

interface TelegramTime {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}
const REAL_TIME: TelegramTime = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};
let time: TelegramTime = REAL_TIME;

/** Test seam: replace the clock / sleeper / jitter source. `null` restores the real one. */
export function _setTelegramTimeForTest(t: Partial<TelegramTime> | null): void {
  time = t ? { ...REAL_TIME, ...t } : REAL_TIME;
}

// ── The send path ──

/** Outcome of delivering ONE message (or one chunk of one). */
export interface DeliveryResult {
  ok: boolean;
  /** Delivered only after the degraded (scrubbed, plain, re-chunked) resend. */
  degraded: boolean;
  /** The LAST failure's disposition — set whenever `ok` is false. */
  failure: TelegramFailure | null;
  attempts: number;
  posts: number;
  elapsedMs: number;
  /** A `retry_after` the in-run budget could not honour — the caller schedules from it. */
  retryAfterS: number | null;
}

type Attempt =
  | { ok: true }
  | { ok: false; failure: TelegramFailure; status?: number; body?: string };

async function attemptOnce(text: string, parseMode: 'Markdown' | null): Promise<Attempt> {
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const body = await res.text();
    return { ok: false, status: res.status, body, failure: classifyTelegramFailure({ httpStatus: res.status, body }) };
  } catch (err) {
    return { ok: false, failure: classifyTelegramFailure({ error: err }) };
  }
}

function logAttempt(i: number, n: number, f: TelegramFailure, t0: number): void {
  console.error(
    `[telegram] attempt ${i}/${n} failed: disposition=${f.disposition} class=${f.klass} code=${f.code} desc="${f.desc}" elapsed_ms=${time.now() - t0}`,
  );
}

/**
 * The ONE degraded resend for a CONTENT rejection: no `parse_mode`, lone surrogates and
 * C0 controls scrubbed, re-chunked well under the limit. Loud on success, like the
 * plain-text fallback — a degrade firing means some producer still emits a body Telegram
 * rejects. Each piece is scrubbed again after chunking, because a hard split can land
 * between the two halves of a surrogate pair.
 */
async function degradedResend(
  text: string,
  cause: TelegramFailure,
): Promise<{ ok: boolean; posts: number; failure: TelegramFailure | null }> {
  const pieces = chunkSections([scrubForPlainText(text)], DEGRADED_CHUNK_LIMIT).map(scrubForPlainText);
  let posts = 0;
  for (const piece of pieces) {
    const r = await attemptOnce(piece, null);
    posts++;
    if (!r.ok) {
      if (r.status !== undefined) console.error(`[telegram] HTTP ${r.status}: ${redactBotToken(r.body ?? '')}`);
      console.error(`[telegram] degraded resend also failed: disposition=${r.failure.disposition} code=${r.failure.code} desc="${r.failure.desc}"`);
      return { ok: false, posts, failure: r.failure };
    }
  }
  console.error(`[telegram] DELIVERED DEGRADED (${cause.desc})`);
  return { ok: true, posts, failure: null };
}

async function postOne(text: string, policyName: TelegramRetryPolicyName): Promise<DeliveryResult> {
  const policy = TELEGRAM_RETRY_POLICY[policyName];
  const t0 = time.now();
  // PROACTIVE downgrade: an odd `*`/`_`/backtick cannot be escaped in legacy
  // Markdown, so attempting it is a guaranteed 400. Send plain text on the
  // FIRST attempt instead of burning the retry budget discovering that.
  const unbalanced = hasUnbalancedMarkdown(text);
  if (unbalanced) {
    console.error(
      '[telegram] UNBALANCED Markdown entity — sending as PLAIN TEXT; wrap the interpolated value in mdValue()',
    );
  }
  let mode: 'Markdown' | null = unbalanced ? null : 'Markdown';
  let last: TelegramFailure | null = null;
  let attempts = 0;
  let posts = 0;
  let deferredRetryAfterS: number | null = null;
  const result = (ok: boolean, degraded = false): DeliveryResult => ({
    ok,
    degraded,
    failure: ok ? null : last,
    attempts,
    posts,
    elapsedMs: time.now() - t0,
    retryAfterS: ok ? null : deferredRetryAfterS,
  });

  for (let i = 0; i < policy.maxAttempts; i++) {
    if (i > 0) {
      let wait = policy.delaysMs[i] ?? policy.delaysMs[policy.delaysMs.length - 1] ?? 0;
      if (policy.honourRetryAfter && last?.retryAfterS != null) {
        wait = Math.max(wait, last.retryAfterS * 1000 + Math.floor(time.random() * 1000));
      }
      if (time.now() - t0 + wait > policy.budgetMs) {
        // Do not spin past the budget: hand the wait back to the caller instead.
        deferredRetryAfterS = last?.retryAfterS ?? null;
        break;
      }
      if (wait > 0) await time.sleep(wait);
    }
    attempts++;
    const r = await attemptOnce(text, mode);
    posts++;
    if (r.ok) return result(true);
    if (r.status !== undefined) console.error(`[telegram] HTTP ${r.status}: ${redactBotToken(r.body ?? '')}`);
    let f = r.failure;
    logAttempt(attempts, policy.maxAttempts, f, t0);
    // A Markdown parse failure is a FORMATTING problem, not a delivery problem. Retry
    // once as PLAIN TEXT so an unescaped entity in some future producer's interpolated
    // value can never again cost the operator the message entirely. Loud on purpose:
    // the fallback firing means that producer still needs mdValue() applied.
    if (f.disposition === 'entity' && mode !== null) {
      const plain = await attemptOnce(text, null);
      posts++;
      if (plain.ok) {
        console.error('[telegram] DELIVERED AS PLAIN TEXT after a Markdown parse error — wrap interpolated values in mdValue()');
        return result(true);
      }
      console.error(
        `[telegram] plain-text fallback also failed: ${
          plain.status !== undefined ? `HTTP ${plain.status}: ${redactBotToken(plain.body ?? '')}` : `${plain.failure.code} ${plain.failure.desc}`
        }`,
      );
      f = plain.failure;
      mode = null; // the Markdown form is known-bad; any retry goes out plain
    }
    last = f;
    if (f.disposition === 'content') {
      const d = await degradedResend(text, f);
      posts += d.posts;
      if (d.ok) return result(true, true);
      last = d.failure ?? f;
      break;
    }
    // entity after its fallback, and config, are terminal: resending cannot succeed.
    if (f.disposition !== 'transient') break;
  }
  console.error(
    `[telegram] DELIVERY_FAILED disposition=${last?.disposition ?? 'unknown'} code=${last?.code ?? 'unknown'} attempts=${attempts} elapsed_ms=${time.now() - t0}${
      deferredRetryAfterS != null ? ` retry_after_s=${deferredRetryAfterS}` : ''
    }`,
  );
  return result(false);
}

const NOTHING_SENT: DeliveryResult = {
  ok: false, degraded: false, failure: null, attempts: 0, posts: 0, elapsedMs: 0, retryAfterS: null,
};

/**
 * The ONE way anything leaves this module. Splits `text` if it exceeds the Telegram
 * limit, so no entry point — `sendAlert`, `sendDigest`, `sendVenueStatusChange`, or
 * whatever a later wave adds — can reintroduce the size cliff by forgetting to chunk.
 *
 * Fixing this at the generator rather than per-sender is the point: `sendDigest` was
 * the lane that failed, but `sendAlert` and `sendVenueStatusChange` sat behind the same
 * un-chunked `post()` and would have failed identically on a long enough body.
 *
 * Returns the LAST failing chunk's result (or the last chunk's, when all delivered).
 */
async function post(text: string, policy: TelegramRetryPolicyName): Promise<DeliveryResult> {
  const chunks = chunkSections([text]);
  if (chunks.length === 0) return NOTHING_SENT;
  let lastOk: DeliveryResult | null = null;
  let lastFailed: DeliveryResult | null = null;
  for (const chunk of chunks) {
    const r = await postOne(chunk, policy);
    if (r.ok) lastOk = r;
    else lastFailed = r;
  }
  return lastFailed ?? lastOk ?? NOTHING_SENT;
}

/**
 * Deliver one message and return the FULL result — the disposition, the attempts, and a
 * `retry_after` the in-run budget could not honour. The boolean senders below project from
 * it; a caller that must schedule a retry (CH2's ledger) reads it directly.
 */
export async function deliverText(
  text: string,
  opts: { policy?: TelegramRetryPolicyName } = {},
): Promise<DeliveryResult> {
  if (!isConfigured()) return NOTHING_SENT;
  return post(text, opts.policy ?? 'serving');
}

/** Options for `sendAlert`. Optional — every existing call site is unchanged. */
export interface AlertOptions {
  /** Defaults to `serving`; a scheduled job may opt in to `scheduled`. */
  policy?: TelegramRetryPolicyName;
}

export async function sendAlert(
  message: string,
  level: 'critical' | 'warning' | 'info',
  opts: AlertOptions = {},
): Promise<boolean> {
  if (!isConfigured()) return false;
  const emoji = LEVEL_EMOJI[level] ?? '🟢';
  return (await deliverText(`${emoji} *AlgoVault Alert*\n\n${message}`, { policy: opts.policy ?? 'serving' })).ok;
}

/** Options for `sendDigest`. All optional — every existing call site is unchanged. */
export interface DigestOptions {
  /**
   * Producer name (e.g. `geo-weekly-cron`). Present ⇒ a failed delivery fires ONE
   * short warning alert naming this producer.
   *
   * Detect → Alert, not Detect → console.error. A `DIGEST SEND FAILED` line in a
   * log nobody tails is indistinguishable from a healthy week, which is exactly
   * how six consecutive GEO digests went missing before an operator noticed. The
   * alert is bounded by construction: at most one per digest run.
   *
   * Explicit `null` = a deliberate non-escalating send (an operator-initiated
   * preview that reports its own outcome). Opting out is expressed in DATA, not in
   * a comment, so `check-delivery-assertion.mjs` R3 can tell a considered decision
   * from an omission — the same reason `announce_resolution` lives on a registry
   * row rather than in prose.
   */
  label?: string | null;
  /** Defaults to `scheduled` — a digest is never on a serving path. */
  policy?: TelegramRetryPolicyName;
}

/**
 * The escalation text, projected from the failure's ONE disposition. PURE.
 *
 * The pre-wave text told the operator to "see the [telegram] HTTP line in that producer's
 * log" — a host log the operator cannot read without SSH, and a line that does not exist
 * for a network-class failure (the 2026-10-15 page pointed at nothing). The cause now
 * travels in the page itself. Every interpolated value is a code span (mdValue), because
 * a Telegram description or an errno can carry `_` and legacy Markdown has no escape.
 */
export function renderDigestFailurePage(args: {
  label: string;
  parts: number;
  sections: number;
  result: DeliveryResult | null;
}): string {
  const f = args.result?.failure ?? null;
  const cause = f ? `cause ${f.disposition}: ${mdValue(f.code)} ${mdValue(f.desc)}` : 'cause unknown';
  const attempts = args.result?.attempts ?? 0;
  const secs = Math.round((args.result?.elapsedMs ?? 0) / 1000);
  return `Digest ${mdValue(args.label)} FAILED to deliver — ${args.parts} part(s), ${args.sections} section(s) · ${cause} · ${attempts} attempt(s) over ${secs} s`;
}

export async function sendDigest(sections: string[], opts: DigestOptions = {}): Promise<boolean> {
  if (!isConfigured()) return false;
  const chunks = chunkSections(sections);
  if (chunks.length === 0) return false;
  const policy = opts.policy ?? 'scheduled';
  // Attempt EVERY chunk even after one fails — a partial digest beats none, and
  // the return value still reports the truth.
  let ok = true;
  let lastFailed: DeliveryResult | null = null;
  for (const chunk of chunks) {
    const r = await post(chunk, policy);
    if (!r.ok) {
      ok = false;
      lastFailed = r;
    }
  }
  if (!ok && opts.label) {
    // Short by design: whatever broke the digest (length, entities) must not
    // also break the message that reports it.
    const escalated = await sendAlert(
      renderDigestFailurePage({ label: opts.label, parts: chunks.length, sections: sections.length, result: lastFailed }),
      'warning',
    );
    // Best-effort by nature (the transport that lost the digest may also lose this), but
    // never SILENT about its own failure — that is the defect one layer up.
    if (!escalated) console.error(`[telegram] ESCALATION ALSO FAILED for digest '${opts.label}' — operator is unaware`);
  }
  return ok;
}

// ── Venue lifecycle alerts (EXCHANGE-SHADOW-PROMOTE-W1 / C3) ──

export interface VenueStatusChangeAlert {
  venue: string;
  action: 'promoted' | 'extended' | 'manual_required';
  pfe_wr: number | null;
  buy_sell_count: number;
  min_buy_sell_sample: number;
  days_since: number;
  extension_count: number;
  // OPS-VENUE-DAY30-DECISION-W1 / CH2 — additive and ALL OPTIONAL, so the
  // existing interface and every existing caller are unchanged (CLAUDE.md
  // "side-fix with interface-preserved exception"). Populated only on the
  // `manual_required` path, by the cron's auto-deferral throttle. CH3 renders
  // them; this chapter only declares them, because the producing call site
  // lives in evaluate-venues.ts and cannot reach a field that does not exist.
  /** ISO 8601 — when the self-throttled alert will next re-ask. */
  next_review_at?: string;
  /** 1-based count of auto-deferrals since the last operator action. */
  deferral_count?: number;
  /**
   * Whether that count has crossed the escalation threshold. DERIVED ONCE in
   * evaluate-venues.ts and rendered verbatim here — this module deliberately
   * owns no threshold of its own, so the two can never disagree.
   */
  escalated?: boolean;
}

const ACTION_EMOJI: Record<VenueStatusChangeAlert['action'], string> = {
  promoted: '🟢',
  extended: '🟡',
  manual_required: '🔴',
};

const ACTION_TITLE: Record<VenueStatusChangeAlert['action'], string> = {
  promoted: 'Venue PROMOTED',
  extended: 'Venue auto-EXTENDED (day-15 miss)',
  manual_required: 'Venue MANUAL DECISION REQUIRED (day-30, 2nd miss)',
};

// OPS-VENUE-DAY30-DECISION-W1: the alert prints RUNNABLE commands, so it has
// to name the real container. Env-overridable, defaulting to the live name
// probed on 204.168.185.24 at wave time — never a bare placeholder, and never
// a literal with no way to correct it if the container is renamed.
const APP_CONTAINER = process.env.ALGOVAULT_APP_CONTAINER || 'crypto-quant-signal-mcp-mcp-server-1';
const DEPLOY_HOST = process.env.ALGOVAULT_DEPLOY_HOST || '204.168.185.24';

/**
 * Render the venue-lifecycle alert body. EXPORTED and pure so the rendered
 * BODY can be asserted directly — `sendVenueStatusChange` short-circuits on
 * `isConfigured()` in dev/test, so a test that called it would assert nothing,
 * and grepping this source would only prove a string exists somewhere, not
 * that it reaches the message (CLAUDE.md, OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH2:
 * a canary rendering entity IDs must assert the body).
 *
 * Every interpolated value goes through `mdValue()`. Telegram's LEGACY
 * `Markdown` parse mode has NO escape syntax, and this body carries
 * `~/.ssh/algovault_deploy` plus container and venue identifiers — an odd
 * underscore count 400s the whole message. Bold and code spans are kept on
 * separate entities (never nested), because the legacy parser does not support
 * nesting.
 */
export function renderVenueStatusChange(payload: VenueStatusChangeAlert): string {
  const emoji = ACTION_EMOJI[payload.action];
  const title = ACTION_TITLE[payload.action];
  const wr = payload.pfe_wr === null ? 'n/a (no Phase-E outcomes yet)' : `${(payload.pfe_wr * 100).toFixed(1)}%`;
  const sample = `${payload.buy_sell_count} / ${payload.min_buy_sell_sample}`;

  const lines = [
    `${emoji} *${title}*: ${mdValue(payload.venue)}`,
    ``,
    `PFE Win Rate: ${wr}`,
    `BUY+SELL sample: ${sample}`,
    `Days since integration: ${payload.days_since}`,
    `Extensions used: ${payload.extension_count} / 2`,
  ];

  if (payload.action === 'manual_required') {
    // Escalation LEADS when it applies: a decision deferred this many times
    // with no operator action is itself the operator-action-required event.
    // `escalated` is derived once in evaluate-venues.ts; nothing is decided
    // here, so the two surfaces cannot disagree.
    if (payload.escalated) {
      lines.unshift(
        `⚠️ *ESCALATION — deferred ${payload.deferral_count} times with no decision.*`,
        ``,
      );
    }

    // Say when the self-throttle next re-asks. Silence about the throttle would
    // make a self-limiting alert look like a broken one.
    if (payload.next_review_at) {
      lines.push(`Next auto re-ask: ${mdValue(payload.next_review_at)}`);
    }

    const exec = `docker exec ${APP_CONTAINER} node dist/scripts`;
    lines.push(
      ``,
      `Decide — run on ${mdValue(DEPLOY_HOST)}:`,
      `  ssh: ${mdValue(`ssh -i ~/.ssh/algovault_deploy root@${DEPLOY_HOST}`)}`,
      ``,
      `  PROMOTE venue ${mdValue(payload.venue)}:`,
      `    ${mdValue(`${exec}/promote-venue.js ${payload.venue}`)}`,
      `  RETIRE venue ${mdValue(payload.venue)}:`,
      `    ${mdValue(`${exec}/retire-venue.js ${payload.venue}`)}`,
      `  EXTEND venue ${mdValue(payload.venue)} (sized to measured accrual):`,
      `    ${mdValue(`${exec}/extend-venue.js ${payload.venue} --days <N>`)}`,
      ``,
      // The pre-wave body said "reply PROMOTE | RETIRE | EXTEND_AGAIN". This
      // module has one outbound post() helper and NO inbound handler, webhook
      // or getUpdates poller — replying had never done anything, and
      // EXTEND_AGAIN had no implementation at all until this wave.
      `No reply to this message is read — this bot has no inbound handler.`,
    );
  }

  return lines.join('\n');
}

/**
 * Fire a structured Telegram alert for a venue lifecycle transition. Reuses
 * the existing TELEGRAM_CHAT_ID env var (single chat — alert routing
 * distinguished by emoji + action title in the message body, not by separate
 * chat). Silently no-ops in dev/test where the bot token isn't configured.
 */
export async function sendVenueStatusChange(payload: VenueStatusChangeAlert): Promise<boolean> {
  if (!isConfigured()) return false;
  return (await deliverText(renderVenueStatusChange(payload), { policy: 'serving' })).ok;
}
