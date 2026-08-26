/**
 * Telegram Bot API wrapper — sends alerts and digests to a private chat.
 * Silent no-op if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */

// Pure Markdown/length primitives live in their own leaf so a PURE renderer can
// reach mdValue() without importing this transport module. Re-exported here so
// every existing `from './telegram.js'` importer is untouched.
import { mdValue, hasUnbalancedMarkdown, chunkSections, TELEGRAM_MAX_MESSAGE } from './markdown-safe.js';
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

async function sendOnce(
  text: string,
  parseMode: 'Markdown' | null,
): Promise<{ ok: boolean; status?: number; body?: string }> {
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
  return { ok: false, status: res.status, body: await res.text() };
}

async function postOne(text: string, retries = 1): Promise<boolean> {
  // PROACTIVE downgrade: an odd `*`/`_`/backtick cannot be escaped in legacy
  // Markdown, so attempting it is a guaranteed 400. Send plain text on the
  // FIRST attempt instead of burning the retry budget discovering that.
  const unbalanced = hasUnbalancedMarkdown(text);
  if (unbalanced) {
    console.error(
      '[telegram] UNBALANCED Markdown entity — sending as PLAIN TEXT; wrap the interpolated value in mdValue()',
    );
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await sendOnce(text, unbalanced ? null : 'Markdown');
      if (r.ok) return true;
      console.error(`[telegram] HTTP ${r.status}: ${r.body}`);
      // A Markdown parse failure is a FORMATTING problem, not a delivery problem. Retry
      // once as PLAIN TEXT so an unescaped entity in some future producer's interpolated
      // value can never again cost the operator the message entirely. Loud on purpose:
      // the fallback firing means that producer still needs mdValue() applied.
      if (r.status === 400 && /can't parse entities/i.test(r.body ?? '')) {
        const plain = await sendOnce(text, null);
        if (plain.ok) {
          console.error('[telegram] DELIVERED AS PLAIN TEXT after a Markdown parse error — wrap interpolated values in mdValue()');
          return true;
        }
        console.error(`[telegram] plain-text fallback also failed: HTTP ${plain.status}: ${plain.body}`);
      }
    } catch (err) {
      console.error(`[telegram] attempt ${attempt + 1} failed:`, (err as Error).message);
    }
  }
  return false;
}

/**
 * The ONE way anything leaves this module. Splits `text` if it exceeds the Telegram
 * limit, so no entry point — `sendAlert`, `sendDigest`, `sendVenueStatusChange`, or
 * whatever a later wave adds — can reintroduce the size cliff by forgetting to chunk.
 *
 * Fixing this at the generator rather than per-sender is the point: `sendDigest` was
 * the lane that failed, but `sendAlert` and `sendVenueStatusChange` sat behind the same
 * un-chunked `post()` and would have failed identically on a long enough body.
 */
async function post(text: string, retries = 1): Promise<boolean> {
  const chunks = chunkSections([text]);
  if (chunks.length === 0) return false;
  let ok = true;
  for (const chunk of chunks) {
    if (!(await postOne(chunk, retries))) ok = false;
  }
  return ok;
}

export async function sendAlert(message: string, level: 'critical' | 'warning' | 'info'): Promise<boolean> {
  if (!isConfigured()) return false;
  const emoji = LEVEL_EMOJI[level] ?? '🟢';
  return post(`${emoji} *AlgoVault Alert*\n\n${message}`);
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
}

export async function sendDigest(sections: string[], opts: DigestOptions = {}): Promise<boolean> {
  if (!isConfigured()) return false;
  const chunks = chunkSections(sections);
  if (chunks.length === 0) return false;
  // Attempt EVERY chunk even after one fails — a partial digest beats none, and
  // the return value still reports the truth.
  let ok = true;
  for (const chunk of chunks) {
    if (!(await post(chunk))) ok = false;
  }
  if (!ok && opts.label) {
    // Short by design: whatever broke the digest (length, entities) must not
    // also break the message that reports it.
    const escalated = await sendAlert(
      `Digest ${mdValue(opts.label)} FAILED to deliver — ${chunks.length} part(s), ${sections.length} section(s). See the [telegram] HTTP line in that producer's log.`,
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
  return post(renderVenueStatusChange(payload));
}
