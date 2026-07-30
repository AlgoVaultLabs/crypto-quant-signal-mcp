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

/**
 * Fire a structured Telegram alert for a venue lifecycle transition. Reuses
 * the existing TELEGRAM_CHAT_ID env var (single chat — alert routing
 * distinguished by emoji + action title in the message body, not by separate
 * chat). Silently no-ops in dev/test where the bot token isn't configured.
 */
export async function sendVenueStatusChange(payload: VenueStatusChangeAlert): Promise<boolean> {
  if (!isConfigured()) return false;

  const emoji = ACTION_EMOJI[payload.action];
  const title = ACTION_TITLE[payload.action];
  const wr = payload.pfe_wr === null ? 'n/a (no Phase-E outcomes yet)' : `${(payload.pfe_wr * 100).toFixed(1)}%`;
  const sample = `${payload.buy_sell_count} / ${payload.min_buy_sell_sample}`;

  const lines = [
    `${emoji} *${title}: ${payload.venue}*`,
    ``,
    `PFE Win Rate: ${wr}`,
    `BUY+SELL sample: ${sample}`,
    `Days since integration: ${payload.days_since}`,
    `Extensions used: ${payload.extension_count} / 2`,
  ];

  if (payload.action === 'manual_required') {
    lines.push(``);
    lines.push(`Action required: reply PROMOTE | RETIRE | EXTEND_AGAIN`);
  }

  return post(lines.join('\n'));
}
