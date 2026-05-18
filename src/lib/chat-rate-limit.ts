/**
 * ChatRateLimit — AV-CHAT-MCP-W1 (C3).
 *
 * Calendar-month per-API-key chat quota tracker. SEPARATE from the existing
 * `quota_usage` table (which serves the trading tools) because chat is a
 * different economic surface — each chat call costs ~$0.002 in Anthropic
 * tokens, so bundling with the trading-tool quotas would mis-price tier
 * economics.
 *
 * Persistence: Postgres table `chat_usage_monthly(api_key, month_iso,
 * request_count, prompt_tokens, completion_tokens)` with composite PK
 * (api_key, month_iso). DDL is fire-and-forget at module init via
 * `dbExec()` per the existing repo pattern (CREATE TABLE IF NOT EXISTS).
 *
 * Layering: ChatRateLimit fires INSIDE the chat_knowledge MCP tool handler
 * BEFORE engine.chat() — separate concern from `express-rate-limit` which
 * does burst protection on the HTTP path.
 */
import { dbExec, dbRun, dbQuery } from './performance-db.js';

export type ChatTier = 'free' | 'starter' | 'pro' | 'enterprise';

export interface ChatRateLimitOpts {
  freeQuotaPerMonth: number;
  starterQuotaPerMonth: number;
  proQuotaPerMonth: number;
  enterpriseQuotaPerMonth: number;
}

const DEFAULT_OPTS: ChatRateLimitOpts = {
  freeQuotaPerMonth: 10,
  starterQuotaPerMonth: 50,
  proQuotaPerMonth: 200,
  enterpriseQuotaPerMonth: 2000,
};

export interface ChatRateLimitCheck {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
}

function getMonthIso(now: Date = new Date()): string {
  // ISO 'YYYY-MM' month key (UTC). Resets at start of next UTC month.
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function nextMonthBoundary(now: Date = new Date()): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  // First day of next month at 00:00:00 UTC
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
}

/**
 * Idempotent DDL — call once at server boot. Uses dbExec (fire-and-forget)
 * per repo convention.
 */
export function ensureChatUsageTable(): void {
  dbExec(`
    CREATE TABLE IF NOT EXISTS chat_usage_monthly (
      api_key TEXT NOT NULL,
      month_iso TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (api_key, month_iso)
    )
  `);
}

export class ChatRateLimit {
  private readonly opts: ChatRateLimitOpts;

  constructor(opts: Partial<ChatRateLimitOpts> = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  /** Returns the per-month quota ceiling for the given tier. */
  private quotaForTier(tier: ChatTier): number {
    switch (tier) {
      case 'free':
        return this.opts.freeQuotaPerMonth;
      case 'starter':
        return this.opts.starterQuotaPerMonth;
      case 'pro':
        return this.opts.proQuotaPerMonth;
      case 'enterprise':
        return this.opts.enterpriseQuotaPerMonth;
    }
  }

  /**
   * Check if the given (apiKey, tier) has quota remaining for this month.
   * Returns the current usage state. Does NOT increment — call `record()`
   * AFTER a successful chat to bump counters.
   */
  async check(apiKey: string, tier: ChatTier): Promise<ChatRateLimitCheck> {
    const limit = this.quotaForTier(tier);
    const monthIso = getMonthIso();
    const rows = await dbQuery<{ request_count: number }>(
      'SELECT request_count FROM chat_usage_monthly WHERE api_key = ? AND month_iso = ?',
      [apiKey, monthIso],
    );
    const used = rows.length > 0 ? Number(rows[0].request_count) : 0;
    const remaining = Math.max(0, limit - used);
    return {
      allowed: remaining > 0,
      remaining,
      resetAt: nextMonthBoundary(),
      limit,
    };
  }

  /** Increment counters after a successful chat call. Fire-and-forget. */
  async record(
    apiKey: string,
    usage: { promptTokens: number; completionTokens: number },
  ): Promise<void> {
    const monthIso = getMonthIso();
    // UPSERT via ON CONFLICT (Postgres) — same shape works in SQLite 3.24+.
    // Use placeholder syntax (?) for dbRun's pg-translation layer.
    dbRun(
      `INSERT INTO chat_usage_monthly (api_key, month_iso, request_count, prompt_tokens, completion_tokens)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (api_key, month_iso) DO UPDATE SET
         request_count = chat_usage_monthly.request_count + 1,
         prompt_tokens = chat_usage_monthly.prompt_tokens + EXCLUDED.prompt_tokens,
         completion_tokens = chat_usage_monthly.completion_tokens + EXCLUDED.completion_tokens`,
      apiKey,
      monthIso,
      usage.promptTokens,
      usage.completionTokens,
    );
  }
}
