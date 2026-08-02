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
import { randomUUID } from 'node:crypto';
import { dbExec, dbRun, dbQuery } from './performance-db.js';
// OPS-QUOTA-EXHAUSTION-NOTICE-W1: the one notice contract (pure leaf — no cycle).
import { buildQuotaNoticeMessage, buildQuotaSuggestedAction, quotaNoticeFacts } from './quota-notice.js';
import { nudgeSignupUrl } from './nudge-copy.js';

export type ChatTier = 'free' | 'starter' | 'pro' | 'enterprise';

/**
 * Resolve the per-caller quota bucket for the chat surface.
 *
 * OPS-AUDIT-REMEDIATION-HIGH-W1 (SEC-03). This previously lived in `src/index.ts` and ended
 * `` `ip:${ipHash ?? 'unknown'}` ``, so a null ipHash collapsed EVERY anonymous caller into one
 * literal `ip:unknown` bucket — a single global 10/month counter that any one visitor could
 * exhaust for the entire internet. The original comment said the bucketing existed "so anonymous
 * traffic doesn't share a single global counter", which is exactly what that fallback defeated.
 *
 * GENERATOR RULE: **a quota key may never be a constant.** With neither a license key nor an
 * ipHash we cannot identify the caller, so we fail closed onto a per-request random key: the
 * request is metered against itself (never pooled, never shared) instead of silently joining a
 * global bucket. Callers that legitimately have no identity degrade to "unmetered for this one
 * request" rather than "one shared counter for everybody".
 *
 * It lives here, not in index.ts, because index.ts boots the server at import — a resolver
 * defined there cannot be unit-tested.
 */
export function chatQuotaApiKey(licenseKey: string | null, ipHash: string | null): string {
  if (licenseKey) return licenseKey;
  if (ipHash) return `ip:${ipHash}`;
  return `unidentified:${randomUUID()}`;
}

/**
 * The chat wall's notice — the SAME contract every other free-tier surface renders
 * (OPS-QUOTA-EXHAUSTION-NOTICE-W1, 2026-08-02), rendered here once for both consumers
 * (`POST /api/chat` and the `chat_knowledge` MCP tool) so they cannot drift apart.
 *
 * What it replaces, and why each was a real gap:
 *   - no usage figure — the caller could not see `N/10`;
 *   - no reset DATE, only "Resets in 30 day(s)" — and chat's reset is a UTC CALENDAR-month
 *     boundary, not the rolling 30-day window the call meter uses, so a day count was the
 *     only thing being said and it said it ambiguously;
 *   - no `suggested_action` (the structured-error law requires one);
 *   - `upgrade_url: https://algovault.com/#pricing` — a DIFFERENT destination from every
 *     other surface, carrying no `upgrade_from`, so every chat-wall click was invisible to
 *     the funnel (`/signup` records `upgrade_cta_clicked` on ANY `upgrade_from` value).
 *
 * `code` is deliberately UNCHANGED (`CHAT_QUOTA_EXHAUSTED`): it is one of the six error codes
 * pinned by `audits/chat-knowledge-shape-snapshot-2026-05-18.json`, and the call meter's
 * `TIER_LIMIT_REACHED` is a genuinely different event — the two quotas are independent, and
 * exhausting chat leaves the trading tools working. Every prior field is retained; the new
 * ones are additive.
 */
export function buildChatQuotaNotice(
  tier: ChatTier,
  check: Pick<ChatRateLimitCheck, 'limit' | 'used' | 'resetAt'>,
): {
  code: 'CHAT_QUOTA_EXHAUSTED';
  message: string;
  retry_after_days: number;
  resets_at: string;
  usage_display: string;
  limit: number;
  tier: ChatTier;
  upgrade_url: string;
  suggested_action: string;
} {
  const ctx = {
    meter: 'chat' as const,
    used: check.used,
    limit: check.limit,
    resetAtMs: check.resetAt.getTime(),
  };
  const facts = quotaNoticeFacts(ctx);
  return {
    code: 'CHAT_QUOTA_EXHAUSTED',
    message: buildQuotaNoticeMessage(ctx),
    retry_after_days: facts.retry_after_days,
    resets_at: facts.resets_at,
    usage_display: facts.usage_display,
    limit: check.limit,
    tier,
    upgrade_url: nudgeSignupUrl('limit_chat'),
    suggested_action: buildQuotaSuggestedAction(ctx),
  };
}

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
  /**
   * Calls consumed this month. Added by OPS-QUOTA-EXHAUSTION-NOTICE-W1 so the exhaustion notice
   * can state `N/limit` — `limit - remaining` is NOT a safe substitute, because `remaining`
   * clamps at 0 and would silently under-report a caller who went past the cap.
   */
  used: number;
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
      used,
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
