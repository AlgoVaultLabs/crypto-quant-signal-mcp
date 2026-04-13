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

async function post(text: string, retries = 1): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          parse_mode: 'Markdown',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      const body = await res.text();
      console.error(`[telegram] HTTP ${res.status}: ${body}`);
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
