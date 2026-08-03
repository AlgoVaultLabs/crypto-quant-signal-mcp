/**
 * Telegram Bot API wrapper — sends alerts and digests to a private chat.
 * Silent no-op if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */

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

/**
 * Render a dynamic value so Markdown cannot mis-parse it (SEC-17).
 *
 * Telegram's LEGACY `Markdown` parse mode has no escape syntax — that is precisely why
 * MarkdownV2 exists — so a backslash does not help. A code span does: content inside
 * backticks is literal, so `_`, `*` and `[` in an interpolated value stop being entity
 * starters. Backticks in the value itself are stripped, since they would close the span.
 *
 * The concrete incident: the weekly knowledge-page digest interpolated the source name
 * `github_discussion`, whose single `_` opened an italic entity that never closed. Every
 * POST returned HTTP 400 `can't parse entities … at byte offset 168` (byte-exact) for
 * three consecutive weeks while the producer logged "digest sent".
 */
export function mdValue(value: unknown): string {
  return `\`${String(value).replace(/`/g, '')}\``;
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

async function post(text: string, retries = 1): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await sendOnce(text, 'Markdown');
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

export async function sendAlert(message: string, level: 'critical' | 'warning' | 'info'): Promise<boolean> {
  if (!isConfigured()) return false;
  const emoji = LEVEL_EMOJI[level] ?? '🟢';
  return post(`${emoji} *AlgoVault Alert*\n\n${message}`);
}

export async function sendDigest(sections: string[]): Promise<boolean> {
  if (!isConfigured()) return false;
  return post(sections.join('\n\n'));
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
